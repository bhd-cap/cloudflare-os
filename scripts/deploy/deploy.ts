#!/usr/bin/env node

// Deploys a complete, production-shaped instance of this fork to *your own* Cloudflare account with
// plain `wrangler deploy` — no hosted deploy service, no Worker Previews, no draft Wrangler.
//
//   pnpm deploy:instance              build, provision, deploy
//   pnpm deploy:instance --dry-run    print the plan; touches nothing (still needs the account env)
//
// The hosted flow (os.cloudflare.app/deploy) installs upstream release bundles, so it cannot ship a
// fork's own changes; this script is the fork's equivalent. It mirrors what that flow and
// scripts/preview do, resolved to concrete values:
//
//   1. KV namespaces and R2 buckets are found or created by name (`<worker>-<binding>`), so a
//      re-run reuses the same storage instead of orphaning the instance's data.
//   2. Each worker's config is written to a gitignored `wrangler.prod.jsonc` beside its committed
//      `wrangler.jsonc`, so every relative path in it (main, build, assets) still resolves.
//   3. Workers deploy in the three tiers their service bindings require: gatekeepers, then
//      workshop-backend (binds every gatekeeper), then router (binds all of them, and is the only
//      worker with a hostname).
//   4. Secrets — ADMINS, the Cloudflare Access pair, AI Gateway settings, gatekeeper OAuth apps —
//      go over stdin with `wrangler secret bulk`, never into a config, since Wrangler prints config
//      values in its deploy summary.
//
// Configuration is environment variables only; see docs/deploy.md for the full list.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CRED_INPUTS, NO_DEFAULT_CRED_INPUTS, PREINSTALL, gatekeeperShortName,
  isGatekeeperPackage, readDeployInputs, readDeployablePackages,
  type DeployInput, type DeployablePackage, type WranglerConfig,
} from "../release/manifest-lib.ts";
import {
  PACKAGES_DIR, ROOT, gatekeeperBindingName, resolveAiGateway,
} from "../preview/staging-config.ts";

/** A worker config as `wrangler deploy` takes it for a real deployment. */
export interface ProdConfig extends WranglerConfig {
  account_id: string;
  workers_dev: boolean;
  preview_urls: boolean;
  routes?: { pattern: string; custom_domain: true }[];
  kv_namespaces?: { binding: string; id: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
}

/** Everything about the target instance that is decided before any worker is deployed. */
export interface DeployPlan {
  accountId: string;
  /** Prepended to every worker name, so an instance cannot collide with other workers. */
  prefix: string;
  /** The instance's public origin: the router's custom domain or workers.dev URL. */
  baseUrl: string;
  /** Set when the router is served from a custom domain rather than workers.dev. */
  customDomain?: string;
  /** Gatekeeper package names to deploy, sorted. */
  gatekeepers: string[];
  /** The AI Gateway the backend routes models through, which Web Search then shares. */
  aiGateway?: string;
  /** Plain-text settings per gatekeeper package, from {@link resolveGatekeeperSettings}. */
  gatekeeperVars?: Record<string, Record<string, string>>;
}

/** KV namespace ids and R2 bucket names, keyed by `<worker name>-<binding>` resource name. */
export interface ProvisionedResources {
  kv: Map<string, string>;
  r2: Set<string>;
}

const CONFIG_NAME = "wrangler.prod.jsonc";
const DEFAULT_PREFIX = "blackhawk-";
const USAGE = "Usage: deploy.ts [--dry-run]";
const API = "https://api.cloudflare.com/client/v4";

// Deployment settings a gatekeeper reads beyond its deploy inputs, taken from the environment under
// the same names the worker reads them by. Listed rather than matched by prefix, so an unrelated
// variable that happens to share one (GITHUB_TOKEN in CI) never lands in a worker.
const GATEKEEPER_SETTINGS: Record<string, { vars: string[]; secrets: string[] }> = {
  "gatekeeper-mcp-portal": {
    vars: ["MCP_PORTAL_URL", "MCP_PORTAL_NAME", "MCP_PORTAL_AUTH", "MCP_PORTAL_TRUST_ANNOTATIONS",
      "MCP_PORTAL_HIDDEN_SERVER_IDS"],
    secrets: ["MCP_PORTAL_TOKEN"],
  },
  "gatekeeper-gitlab": { vars: ["GITLAB_URL", "GITLAB_API_URL"], secrets: [] },
};

/** The deployed name of a package's worker. */
export function workerName(prefix: string, pkgName: string): string {
  return `${prefix}${pkgName}`;
}

/**
 * The name of the KV namespace or R2 bucket behind one binding. Lowercase and hyphenated because R2
 * accepts nothing else, and derived from the worker name so two instances never share storage.
 */
export function resourceName(worker: string, binding: string): string {
  return `${worker}-${binding}`.toLowerCase().replaceAll("_", "-");
}

/**
 * The extra gatekeepers named by DEPLOY_GATEKEEPERS (short names, e.g. `github,google`), on top of
 * the preinstalled three every instance needs for its ambient Context Library, Scheduled Tasks and
 * Web Search.
 */
export function resolveGatekeepers(
  available: readonly string[],
  { list = process.env.DEPLOY_GATEKEEPERS }: { list?: string } = {},
): string[] {
  const selected = new Set(PREINSTALL);
  for (const short of (list ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const pkgName = `gatekeeper-${short}`;
    if (!available.includes(pkgName)) {
      throw new Error(`DEPLOY_GATEKEEPERS names "${short}", but there is no deployable ` +
          `packages/${pkgName}. Available: ` +
          available.filter(isGatekeeperPackage).map(gatekeeperShortName).join(", "));
    }
    selected.add(pkgName);
  }
  return [...selected].toSorted();
}

/**
 * Build every selected worker's production config. Pure: resource ids come from `resources`, which
 * {@link provision} fills in (or a dry run fakes).
 */
export function buildProdConfigs(
  plan: DeployPlan,
  packages: readonly DeployablePackage[],
  resources: ProvisionedResources,
): Map<string, ProdConfig> {
  const { accountId, prefix, baseUrl, customDomain, gatekeepers, aiGateway, gatekeeperVars } = plan;
  const configs = new Map<string, ProdConfig>();
  const selected = packages.filter((pkg) =>
      pkg.name === "router" || pkg.name === "workshop-backend" || gatekeepers.includes(pkg.name));

  for (const pkg of selected) {
    const name = workerName(prefix, pkg.name);
    const { kv_namespaces, r2_buckets, artifacts: _artifacts, ...rest } = structuredClone(pkg.config);
    const config: ProdConfig = {
      ...rest,
      name,
      account_id: accountId,
      // Only the router is reachable from the internet; everything else is reached over service
      // bindings, so a URL on any other worker would be a way around the router.
      workers_dev: false,
      preview_urls: false,
    };
    if (kv_namespaces) {
      config.kv_namespaces = kv_namespaces.map(({ binding }) => {
        const id = resources.kv.get(resourceName(name, binding));
        if (!id) throw new Error(`no KV namespace was provisioned for ${name}'s ${binding}`);
        return { binding, id };
      });
    }
    if (r2_buckets) {
      config.r2_buckets = r2_buckets.map(({ binding }) => ({
        binding, bucket_name: resourceName(name, binding),
      }));
    }

    if (isGatekeeperPackage(pkg.name)) {
      config.vars = {
        ...config.vars,
        ...gatekeeperVars?.[pkg.name],
        BASE_URL: `${baseUrl}/gatekeeper/${gatekeeperShortName(pkg.name)}`,
      };
      // Searches go through the instance's own gateway, as the hosted deploy flow sets it.
      if (pkg.name === "gatekeeper-websearch" && aiGateway) config.vars.CF_AI_GATEWAY = aiGateway;
    } else if (pkg.name === "workshop-backend") {
      // As manifest-lib.ts hardcodes for every deployed backend: webFetch's Markdown conversion
      // runs on it, and it is the default AI Gateway transport.
      config.ai = { binding: "WORKERS_AI" };
      config.vars = { ...config.vars, PUBLIC_BASE_URL: baseUrl };
      config.services = gatekeepers.map((gk) => ({
        binding: gatekeeperBindingName(gk),
        service: workerName(prefix, gk),
        entrypoint: "GatekeeperVendor",
        // Context namespaces shared data by the instance's origin (gatekeeper-context/src/domain.ts).
        ...(gk === "gatekeeper-context" ? { props: { sharingDomain: baseUrl } } : {}),
      }));
    } else if (pkg.name === "router") {
      config.services = [
        { binding: "WORKSHOP_BACKEND", service: workerName(prefix, "workshop-backend") },
        ...gatekeepers.map((gk) => ({ binding: gatekeeperBindingName(gk), service: workerName(prefix, gk) })),
      ];
      if (customDomain) config.routes = [{ pattern: customDomain, custom_domain: true }];
      else config.workers_dev = true;
    }
    configs.set(pkg.name, config);
  }
  return configs;
}

/**
 * The secret inputs a gatekeeper reads (its deploy-inputs.json, or the default OAuth pair), read
 * from `<SHORT>_<INPUT>` in the environment: `GITHUB_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. A gatekeeper with
 * none of its secrets set still deploys, but its connector fails when a user tries to connect.
 */
export function resolveGatekeeperSecrets(
  pkg: DeployablePackage,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const inputs: DeployInput[] = readDeployInputs(pkg.dir) ??
      (NO_DEFAULT_CRED_INPUTS.has(pkg.name) ? [] : DEFAULT_CRED_INPUTS);
  const envPrefix = gatekeeperShortName(pkg.name).toUpperCase().replaceAll("-", "_");
  const secrets: Record<string, string> = {};
  const missing: string[] = [];
  for (const input of inputs.filter((i) => i.kind === "secret")) {
    const value = env[`${envPrefix}_${input.name}`];
    if (value) secrets[input.name] = value;
    else missing.push(`${envPrefix}_${input.name}`);
  }
  if (missing.length > 0 && Object.keys(secrets).length > 0) {
    throw new Error(`${missing.join(", ")} must be set too: ${pkg.name}'s secrets are one ` +
        "credential, and it refuses to start a flow with part of one");
  }
  if (missing.length > 0) {
    console.warn(`${missing.join(", ")} unset: ${pkg.name} deploys unconfigured, and connecting ` +
        "it will fail until they are set and this script is re-run.");
  }
  return secrets;
}

/** A gatekeeper's {@link GATEKEEPER_SETTINGS} that are set in the environment, split by kind. */
export function resolveGatekeeperSettings(
  pkgName: string,
  env: NodeJS.ProcessEnv = process.env,
): { vars: Record<string, string>; secrets: Record<string, string> } {
  const { vars = [], secrets = [] } = GATEKEEPER_SETTINGS[pkgName] ?? {};
  const pick = (names: string[]) =>
      Object.fromEntries(names.flatMap((name) => env[name] ? [[name, env[name]]] : []));
  return { vars: pick(vars), secrets: pick(secrets) };
}

/**
 * The backend's secrets. With CF_ACCESS_AUD/CF_ACCESS_ISS set the instance signs users in through
 * Cloudflare Access (and the backend refuses passwords); without them it uses built-in
 * username/password accounts. ADMINS lists the usernames — Access emails in Access mode — that get
 * the /admin panel.
 */
export function backendSecrets({
  admins = process.env.DEPLOY_ADMINS,
  accessAud = process.env.CF_ACCESS_AUD,
  accessIss = process.env.CF_ACCESS_ISS,
  aiGateway = resolveAiGateway(),
}: {
  admins?: string;
  accessAud?: string;
  accessIss?: string;
  aiGateway?: Record<string, string>;
} = {}): Record<string, string> {
  if (Boolean(accessAud) !== Boolean(accessIss)) {
    throw new Error("CF_ACCESS_AUD and CF_ACCESS_ISS must be set together: verifying an Access " +
        "assertion needs both, and either one alone verifies nothing");
  }
  const adminList = (admins ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (adminList.length === 0) {
    console.warn("DEPLOY_ADMINS is unset: the instance will have no admins, so the /admin panel " +
        "(branding, models, connectors) will be unreachable.");
  }
  return {
    ADMINS: JSON.stringify(adminList),
    ...(accessAud && accessIss ? { CF_ACCESS_AUD: accessAud, CF_ACCESS_ISS: accessIss } : {}),
    ...aiGateway,
  };
}

async function cloudflareApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN must be set");
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  const body = await response.json() as { success: boolean; result: T; errors?: unknown[] };
  if (!response.ok || !body.success) {
    throw new Error(`Cloudflare API ${init.method ?? "GET"} ${path} failed (${response.status}): ` +
        JSON.stringify(body.errors));
  }
  return body.result;
}

async function workersDevSubdomain(accountId: string): Promise<string> {
  const { subdomain } = await cloudflareApi<{ subdomain: string }>(
      `/accounts/${accountId}/workers/subdomain`);
  if (!subdomain) {
    throw new Error("this account has no workers.dev subdomain yet: open Workers & Pages in the " +
        "dashboard once to claim one, or set DEPLOY_CUSTOM_DOMAIN");
  }
  return subdomain;
}

/** Find or create every KV namespace and R2 bucket the selected workers bind. */
async function provision(
  accountId: string,
  prefix: string,
  packages: readonly DeployablePackage[],
): Promise<ProvisionedResources> {
  const existingKv = new Map<string, string>();
  for (let page = 1; ; page++) {
    const batch = await cloudflareApi<{ id: string; title: string }[]>(
        `/accounts/${accountId}/storage/kv/namespaces?per_page=100&page=${page}`);
    for (const ns of batch) existingKv.set(ns.title, ns.id);
    if (batch.length < 100) break;
  }

  const resources: ProvisionedResources = { kv: new Map(), r2: new Set() };
  for (const pkg of packages) {
    const name = workerName(prefix, pkg.name);
    for (const { binding } of pkg.config.kv_namespaces ?? []) {
      const title = resourceName(name, binding);
      let id = existingKv.get(title);
      if (!id) {
        console.log(`creating KV namespace ${title}`);
        ({ id } = await cloudflareApi<{ id: string }>(`/accounts/${accountId}/storage/kv/namespaces`,
            { method: "POST", body: JSON.stringify({ title }) }));
      }
      resources.kv.set(title, id);
    }
    for (const { binding } of pkg.config.r2_buckets ?? []) {
      const bucket = resourceName(name, binding);
      try {
        await cloudflareApi(`/accounts/${accountId}/r2/buckets/${bucket}`);
      } catch {
        console.log(`creating R2 bucket ${bucket}`);
        await cloudflareApi(`/accounts/${accountId}/r2/buckets`,
            { method: "POST", body: JSON.stringify({ name: bucket }) });
      }
      resources.r2.add(bucket);
    }
  }
  return resources;
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv;
    input?: string } = {}): Promise<void> {
  console.log(`running: ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      // Secrets travel over stdin: argv is visible in `ps` and echoed by the line above.
      stdio: [options.input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`)));
  });
}

const wrangler = join(ROOT, "node_modules", ".bin", "wrangler");

async function deployWorker(pkg: DeployablePackage, secrets: Record<string, string>): Promise<void> {
  await run(wrangler, ["deploy", "--config", CONFIG_NAME], { cwd: pkg.dir });
  if (Object.keys(secrets).length > 0) {
    await run(wrangler, ["secret", "bulk", "--config", CONFIG_NAME],
        { cwd: pkg.dir, input: JSON.stringify(secrets) });
  }
}

async function main(argv: string[]): Promise<void> {
  const unknown = argv.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}\n${USAGE}`);
  const dryRun = argv.includes("--dry-run");

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID must be set");
  const prefix = process.env.DEPLOY_PREFIX ?? DEFAULT_PREFIX;
  const customDomain = process.env.DEPLOY_CUSTOM_DOMAIN || undefined;

  const allPackages = readDeployablePackages(PACKAGES_DIR);
  const gatekeepers = resolveGatekeepers(allPackages.map((pkg) => pkg.name));
  const packages = allPackages.filter((pkg) =>
      pkg.name === "router" || pkg.name === "workshop-backend" || gatekeepers.includes(pkg.name));

  // Every input is validated before anything is created, so a typo fails here rather than after
  // half the instance is live.
  const secrets = backendSecrets();
  const accessMode = "CF_ACCESS_AUD" in secrets;
  const gatekeeperVars: Record<string, Record<string, string>> = {};
  const gatekeeperSecrets = new Map<string, Record<string, string>>();
  for (const pkg of packages.filter((p) => isGatekeeperPackage(p.name))) {
    const settings = resolveGatekeeperSettings(pkg.name);
    gatekeeperVars[pkg.name] = settings.vars;
    gatekeeperSecrets.set(pkg.name, { ...resolveGatekeeperSecrets(pkg), ...settings.secrets });
  }

  const baseUrl = customDomain ? `https://${customDomain}`
      : `https://${workerName(prefix, "router")}.${await workersDevSubdomain(accountId)}.workers.dev`;
  const plan: DeployPlan = {
    accountId, prefix, baseUrl, customDomain, gatekeepers, aiGateway: secrets.CF_AI_GATEWAY,
    gatekeeperVars,
  };

  console.log(`\nInstance: ${baseUrl}`);
  console.log(`  sign-in:     ${accessMode ? "Cloudflare Access" : "username/password"}`);
  console.log(`  models:      ${secrets.CF_AI_GATEWAY ? `AI Gateway "${secrets.CF_AI_GATEWAY}"` : "each user's own API keys"}`);
  console.log(`  gatekeepers: ${gatekeepers.map(gatekeeperShortName).join(", ")}`);
  console.log(`  workers:     ${packages.map((pkg) => workerName(prefix, pkg.name)).join(", ")}\n`);
  if (dryRun) return;

  const resources = await provision(accountId, prefix, packages);
  const configs = buildProdConfigs(plan, packages, resources);
  for (const pkg of packages) {
    writeFileSync(join(pkg.dir, CONFIG_NAME), JSON.stringify(configs.get(pkg.name), null, 2) + "\n");
  }

  // Codegen, the frontend the router serves, and the gatekeeper apps. The sign-in UI is chosen at
  // build time (workshop-frontend/src/useAuth.ts), so it must match the backend's auth mode.
  const { VITE_CF_ACCESS_MODE: _ambient, ...buildEnv } = process.env;
  await run("pnpm", ["run", "build"],
      { env: accessMode ? { ...buildEnv, VITE_CF_ACCESS_MODE: "true" } : buildEnv });

  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  for (const gk of gatekeepers) await deployWorker(byName.get(gk)!, gatekeeperSecrets.get(gk) ?? {});
  await deployWorker(byName.get("workshop-backend")!, secrets);
  await deployWorker(byName.get("router")!, {});

  console.log(`\nDeployed. Open ${baseUrl}` +
      (accessMode ? "" : " and sign up with one of the DEPLOY_ADMINS usernames to reach /admin."));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
