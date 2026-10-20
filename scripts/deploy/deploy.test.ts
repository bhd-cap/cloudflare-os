import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import type { DeployablePackage, WranglerConfig } from "../release/manifest-lib.ts";
import {
  backendSecrets, buildProdConfigs, resolveGatekeeperSecrets, resolveGatekeeperSettings,
  resolveGatekeepers, resourceName,
  type DeployPlan,
} from "./deploy.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function pkg(name: string, config: WranglerConfig = {}): DeployablePackage {
  return { name, dir: join(ROOT, "packages", name), config: { name, ...config } };
}

const PACKAGES = [
  pkg("router", { assets: { binding: "ASSETS" }, services: [{ binding: "WORKSHOP_BACKEND", service: "workshop-backend" }] }),
  pkg("workshop-backend", {
    kv_namespaces: [{ binding: "BLUEPRINTS", preview_id: "local" }],
    r2_buckets: [{ binding: "BLUEPRINT_CONTENT" }],
  }),
  pkg("gatekeeper-context", { kv_namespaces: [{ binding: "CONTEXT_COLLECTIONS" }], artifacts: { binding: "ARTIFACTS" } }),
  pkg("gatekeeper-websearch"),
  pkg("gatekeeper-github"),
];

const PLAN: DeployPlan = {
  accountId: "acct",
  prefix: "bh-",
  baseUrl: "https://bh-router.demo.workers.dev",
  gatekeepers: ["gatekeeper-context", "gatekeeper-websearch"],
  aiGateway: "bh-gateway",
};

const RESOURCES = {
  kv: new Map([
    ["bh-workshop-backend-blueprints", "kv-blueprints"],
    ["bh-gatekeeper-context-context-collections", "kv-context"],
  ]),
  r2: new Set(["bh-workshop-backend-blueprint-content"]),
};

describe("buildProdConfigs", () => {
  const configs = buildProdConfigs(PLAN, PACKAGES, RESOURCES);

  it("deploys only the selected gatekeepers alongside the core workers", () => {
    assert.deepEqual([...configs.keys()].toSorted(),
        ["gatekeeper-context", "gatekeeper-websearch", "router", "workshop-backend"]);
  });

  it("gives only the router a hostname", () => {
    for (const [name, config] of configs) {
      assert.equal(config.workers_dev, name === "router", name);
      assert.equal(config.preview_urls, false, name);
    }
  });

  it("serves the router from a custom domain instead of workers.dev when one is set", () => {
    const router = buildProdConfigs({ ...PLAN, customDomain: "os.example.com" }, PACKAGES, RESOURCES)
        .get("router")!;
    assert.equal(router.workers_dev, false);
    assert.deepEqual(router.routes, [{ pattern: "os.example.com", custom_domain: true }]);
  });

  it("binds provisioned storage by concrete id and name", () => {
    const backend = configs.get("workshop-backend")!;
    assert.deepEqual(backend.kv_namespaces, [{ binding: "BLUEPRINTS", id: "kv-blueprints" }]);
    assert.deepEqual(backend.r2_buckets,
        [{ binding: "BLUEPRINT_CONTENT", bucket_name: "bh-workshop-backend-blueprint-content" }]);
    assert.equal(configs.get("gatekeeper-context")!.artifacts, undefined);
  });

  it("wires every gatekeeper into the backend and router under the prefixed worker names", () => {
    const backend = configs.get("workshop-backend")!;
    assert.equal(backend.vars?.PUBLIC_BASE_URL, PLAN.baseUrl);
    assert.deepEqual(backend.ai, { binding: "WORKERS_AI" });
    assert.deepEqual(backend.services, [
      { binding: "GATEKEEPER_CONTEXT", service: "bh-gatekeeper-context", entrypoint: "GatekeeperVendor",
        props: { sharingDomain: PLAN.baseUrl } },
      { binding: "GATEKEEPER_WEBSEARCH", service: "bh-gatekeeper-websearch", entrypoint: "GatekeeperVendor" },
    ]);
    assert.deepEqual(configs.get("router")!.services, [
      { binding: "WORKSHOP_BACKEND", service: "bh-workshop-backend" },
      { binding: "GATEKEEPER_CONTEXT", service: "bh-gatekeeper-context" },
      { binding: "GATEKEEPER_WEBSEARCH", service: "bh-gatekeeper-websearch" },
    ]);
  });

  it("mounts each gatekeeper under the instance origin", () => {
    assert.deepEqual(configs.get("gatekeeper-websearch")!.vars, {
      BASE_URL: `${PLAN.baseUrl}/gatekeeper/websearch`, CF_AI_GATEWAY: "bh-gateway",
    });
    assert.deepEqual(configs.get("gatekeeper-context")!.vars,
        { BASE_URL: `${PLAN.baseUrl}/gatekeeper/context` });
  });

  it("fails rather than deploying a binding with no namespace", () => {
    assert.throws(() => buildProdConfigs(PLAN, PACKAGES, { kv: new Map(), r2: new Set() }),
        /no KV namespace/);
  });
});

describe("resolveGatekeepers", () => {
  const available = ["router", "gatekeeper-context", "gatekeeper-scheduler", "gatekeeper-websearch",
    "gatekeeper-github"];

  it("always includes the preinstalled gatekeepers", () => {
    assert.deepEqual(resolveGatekeepers(available, { list: "" }),
        ["gatekeeper-context", "gatekeeper-scheduler", "gatekeeper-websearch"]);
  });

  it("adds the named ones and rejects unknown names", () => {
    assert.ok(resolveGatekeepers(available, { list: " github " }).includes("gatekeeper-github"));
    assert.throws(() => resolveGatekeepers(available, { list: "nope" }), /no deployable/);
  });
});

describe("resolveGatekeeperSecrets", () => {
  const github = pkg("gatekeeper-github");

  it("reads a gatekeeper's secret inputs under its short-name prefix", () => {
    assert.deepEqual(
        resolveGatekeeperSecrets(github, { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" }),
        { CLIENT_ID: "id", CLIENT_SECRET: "secret" });
  });

  it("refuses half a credential", () => {
    assert.throws(() => resolveGatekeeperSecrets(github, { GITHUB_CLIENT_ID: "id" }),
        /GITHUB_CLIENT_SECRET/);
  });

  it("needs nothing for gatekeepers without inputs", () => {
    assert.deepEqual(resolveGatekeeperSecrets(pkg("gatekeeper-scheduler"), {}), {});
  });
});

describe("resolveGatekeeperSettings", () => {
  it("passes only the listed settings, splitting vars from secrets", () => {
    assert.deepEqual(resolveGatekeeperSettings("gatekeeper-mcp-portal", {
      MCP_PORTAL_URL: "https://portal.example.com/mcp", MCP_PORTAL_TOKEN: "t", MCP_PORTAL_OTHER: "x",
    }), { vars: { MCP_PORTAL_URL: "https://portal.example.com/mcp" }, secrets: { MCP_PORTAL_TOKEN: "t" } });
    assert.deepEqual(resolveGatekeeperSettings("gatekeeper-github", { GITHUB_TOKEN: "ci" }),
        { vars: {}, secrets: {} });
  });

  it("lands vars on the gatekeeper's config without overriding its BASE_URL", () => {
    const configs = buildProdConfigs({
      ...PLAN, gatekeeperVars: { "gatekeeper-context": { BASE_URL: "https://evil", X: "1" } },
    }, PACKAGES, RESOURCES);
    assert.deepEqual(configs.get("gatekeeper-context")!.vars,
        { X: "1", BASE_URL: `${PLAN.baseUrl}/gatekeeper/context` });
  });
});

describe("backendSecrets", () => {
  it("sends admins as a JSON array and adds the Access pair only when both halves are set", () => {
    assert.deepEqual(backendSecrets({ admins: "a@x.com, b@x.com", aiGateway: {} }),
        { ADMINS: '["a@x.com","b@x.com"]' });
    assert.deepEqual(
        backendSecrets({ admins: "a@x.com", accessAud: "aud", accessIss: "https://t.cloudflareaccess.com",
          aiGateway: {} }),
        { ADMINS: '["a@x.com"]', CF_ACCESS_AUD: "aud", CF_ACCESS_ISS: "https://t.cloudflareaccess.com" });
    assert.throws(() => backendSecrets({ accessAud: "aud", aiGateway: {} }), /set together/);
  });
});

describe("resourceName", () => {
  it("is a valid R2 bucket name", () => {
    assert.equal(resourceName("bh-workshop-backend", "BLUEPRINT_CONTENT"), "bh-workshop-backend-blueprint-content");
  });
});
