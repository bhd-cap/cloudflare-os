# Deploying BlackHawk OS to your own Cloudflare account

`pnpm deploy:instance` (`scripts/deploy/deploy.ts`) deploys this fork to a Cloudflare account you
control with plain `wrangler deploy`. Use it instead of the hosted `os.cloudflare.app/deploy`
flow, which installs upstream release bundles and so cannot ship this fork's branding or code.

## What gets deployed

| Worker | Role |
| --- | --- |
| `<prefix>router` | The public origin. Serves the UI and routes `/api` and `/gatekeeper/*`. It is the only worker with a hostname. |
| `<prefix>workshop-backend` | The kernel: users, workspaces, agents, and the Gadget sandbox (Durable Objects + Dynamic Workers). |
| `<prefix>gatekeeper-context` | Context Library: company knowledge that agents read. Always deployed. |
| `<prefix>gatekeeper-scheduler` | Scheduled Tasks. Always deployed. |
| `<prefix>gatekeeper-websearch` | Web Search through the account's own AI Gateway. Always deployed. |
| `<prefix>gatekeeper-<name>` | Each connector named in `DEPLOY_GATEKEEPERS`, e.g. `mcp-portal`, `github`, `google`. |

The script also finds or creates the KV namespaces and R2 bucket these workers bind. It names each
one `<worker>-<binding>`, so a re-run reuses the instance's data instead of orphaning it. Re-running
the script is how you update the instance after a code change.

## Prerequisites

* A Cloudflare account on the **Workers Paid** plan. Durable Objects, Dynamic Workers (the Gadget
  sandbox) and Browser Rendering (PDF export) all need it.
* A workers.dev subdomain claimed on the account (open *Workers & Pages* once), or a zone on the
  account for a custom domain.
* An API token with these permissions:
  * **Account:** Workers Scripts Edit, Workers KV Storage Edit, Workers R2 Storage Edit,
    Account Settings Read.
  * **Zone** (custom domain only): Workers Routes Edit and DNS Edit on that zone.
* Node 24 and pnpm, then `pnpm install` once.

## Configuration

Everything is read from environment variables. None of them are written to a committed file, and
the secrets go to Cloudflare over stdin.

| Variable | Required | Meaning |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | yes | The account to deploy to. |
| `CLOUDFLARE_API_TOKEN` | yes | The token described above. |
| `DEPLOY_ADMINS` | recommended | Comma-separated admins who can reach `/admin`. Use usernames in password mode and emails in Access mode. |
| `DEPLOY_PREFIX` | no | Worker name prefix. The default is `blackhawk-`. Use a different prefix for each instance on one account, e.g. `acme-demo-`. |
| `DEPLOY_CUSTOM_DOMAIN` | no | Serve the router from a hostname such as `os.demo.blackhawk11.com` instead of `https://<prefix>router.<subdomain>.workers.dev`. The zone must be on the account. |
| `DEPLOY_GATEKEEPERS` | no | Extra connectors to deploy, by short name: `mcp-portal,github,google,slack,...`. |
| `CF_ACCESS_AUD`, `CF_ACCESS_ISS` | no | Sign users in through **Cloudflare Access**. Without them the instance uses built-in username/password accounts. |
| `CF_AI_GATEWAY`, `CF_AI_GATEWAY_ACCOUNT_ID` | no | Route every model through this account's AI Gateway, billed to its credits. Without them, each user enters their own provider API key. |
| `CF_AI_GATEWAY_PROVIDERS` | no | Providers offered through the gateway, e.g. `anthropic,openai`. |
| `CF_AI_GATEWAY_API_TOKEN` | no | AI Gateway Run + Read token. It is only needed for the `google` provider or a gateway in another account. |
| `<SHORT>_CLIENT_ID`, `<SHORT>_CLIENT_SECRET` | per connector | OAuth app credentials for each OAuth connector, e.g. `GITHUB_CLIENT_ID`. Register the redirect URI `<origin>/gatekeeper/<short>/oauth`. Each package's README has the steps. |
| `MCP_PORTAL_URL`, `MCP_PORTAL_NAME`, `MCP_PORTAL_AUTH`, `MCP_PORTAL_TOKEN` | for `mcp-portal` | The Cloudflare MCP server portal to expose. See `packages/gatekeeper-mcp-portal/README.md`. |
| `GITLAB_URL`, `GITLAB_API_URL` | for self-hosted `gitlab` | The GitLab instance. |

Check the plan first. This makes no changes, but it does read the account's workers.dev subdomain
unless you set `DEPLOY_CUSTOM_DOMAIN`:

```sh
pnpm deploy:instance --dry-run
```

Then deploy:

```sh
pnpm deploy:instance
```

## Recommended client-demo setup

This setup shows the full story: one secured front door, and governed access to the customer's own
systems.

1. **Custom domain behind Cloudflare Access.**
   1. Pick a hostname, e.g. `os.demo.blackhawk11.com`.
   2. In Zero Trust, go to *Access → Applications* and add a *Self-hosted* application for that
      hostname, with a policy that admits the demo audience (your team plus the client's email
      domain).
   3. Copy the application's *Audience (AUD) tag* into `CF_ACCESS_AUD`, and
      `https://<team>.cloudflareaccess.com` into `CF_ACCESS_ISS`.
   4. Set `DEPLOY_ADMINS` to the presenters' emails.
2. **Models through AI Gateway.**
   1. Create a gateway under *AI → AI Gateway* and add credits.
   2. Set `CF_AI_GATEWAY=<gateway name>`, `CF_AI_GATEWAY_ACCOUNT_ID`, and
      `CF_AI_GATEWAY_PROVIDERS=anthropic,openai`.

   Nobody has to paste an API key during the demo.
3. **Connect the customer's systems through an MCP server portal.**
   1. In Zero Trust, put the approved MCP servers behind one
      [MCP server portal](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/).
   2. Add `mcp-portal` to `DEPLOY_GATEKEEPERS`, and set `MCP_PORTAL_URL` and
      `MCP_PORTAL_NAME="<Client> Resources"`.

   Access decides who connects, Gateway logs what crosses, and gatekeepers scope each agent or app to
   the one server it was granted. Every write waits for human approval.
4. Add `github`, `google`, `slack` and other connectors as the demo needs. Each needs an OAuth app.

Example:

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
export DEPLOY_PREFIX=bh-demo- DEPLOY_CUSTOM_DOMAIN=os.demo.blackhawk11.com
export DEPLOY_ADMINS=presenter@blackhawk11.com
export CF_ACCESS_AUD=... CF_ACCESS_ISS=https://blackhawk.cloudflareaccess.com
export CF_AI_GATEWAY=bh-demo CF_AI_GATEWAY_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID CF_AI_GATEWAY_PROVIDERS=anthropic,openai
export DEPLOY_GATEKEEPERS=mcp-portal MCP_PORTAL_URL=https://mcp.demo.blackhawk11.com/mcp MCP_PORTAL_NAME="Client Resources"
pnpm deploy:instance
```

## After deploying: finish the branding in `/admin`

The fork already defaults to the **BlackHawk OS** name and the BlackHawk blue (`#0047AB`) accent.
An admin can tailor each client demo at runtime, with no redeploy:

* **Site name.** For example "Acme OS, powered by BlackHawk".
* **Logo.** Upload a square mark. The horizontal BlackHawk Data wordmark is too wide for the 20px
  slot.
* **Accent color, banner, and announcement.**
* **Agent instructions.** Preload how the client's company operates, so the agent behaves like part
  of their team.
* **Connectors and models** offered to users.

## Tearing an instance down

Delete the `<prefix>*` workers and the matching `<prefix>*` KV namespaces and R2 bucket in the
dashboard, or remove them with `wrangler delete` and `wrangler kv namespace delete`. Deleting
`<prefix>workshop-backend` deletes every user's data, because its Durable Objects hold it.
