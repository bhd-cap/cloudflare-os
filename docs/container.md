# Running BlackHawk OS in a local container

The repository's `Dockerfile` packages the whole stack into one image: the router, the workshop
backend, and every gatekeeper, running on `workerd` exactly as `pnpm run-local` runs them. Use it for
demos and evaluation on a laptop, on a demo VM, or on a server inside a client's network. For a real
deployment, deploy to Cloudflare instead (see [deploy.md](deploy.md)). The container runs
`wrangler dev`, which is not built for production traffic.

## Start it

You need Docker with Compose v2. From the repository root:

```sh
docker compose up --build -d
```

The first build takes a few minutes. Then open <http://localhost:8787>:

1. Choose **Create one** and sign up with the username **`admin`**. Local mode makes that username
   the deployment admin.
2. Finish onboarding. Then open `/admin` to set the site name, logo, accent color, agent
   instructions, models and connectors.
3. To use an agent, either add a model provider API key under your settings, or configure an AI
   Gateway (below).

Stop it with `docker compose down`. Users, workspaces, Gadgets and blueprints live in the
`blackhawk-os-data` volume, so they survive restarts and rebuilds. `docker compose down -v` deletes
them.

Without Compose:

```sh
docker build -t blackhawk-os:local .
docker run -d -p 8787:8787 -v blackhawk-os-data:/app/.wrangler/state blackhawk-os:local
```

## Configuration

Put settings in a `.env` file next to `docker-compose.yml`, one `KEY=value` per line. The file is
gitignored, and Compose passes all of it to the container. Rebuilding isn't needed; run
`docker compose up -d` again to apply changes.

| Variable | Meaning |
| --- | --- |
| `PUBLIC_BASE_URL` | The origin people browse to. The default is `http://localhost:8787`. If others reach the container by a hostname or IP, such as `http://demo-vm.local:8787`, set it to that, or account connect flows will fail. |
| `CF_AI_GATEWAY`, `CF_AI_GATEWAY_ACCOUNT_ID`, `CF_AI_GATEWAY_API_TOKEN` | Serve models through a Cloudflare AI Gateway, so users need no API keys. In a container the token is required, because the in-account Workers AI binding is unavailable. Give it AI Gateway Run + Read permissions. |
| `CF_AI_GATEWAY_PROVIDERS` | Providers offered through the gateway, e.g. `anthropic,openai`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, ... | OAuth apps for the connectors, under the names `scripts/run-dev-server.ts` lists in `SHARED_GATEKEEPER_CREDS`. Register `<PUBLIC_BASE_URL>/gatekeeper/<name>/oauth` as the redirect URI. |
| `MCP_PORTAL_URL`, `MCP_PORTAL_NAME`, `MCP_PORTAL_AUTH`, `MCP_PORTAL_TOKEN` | A Cloudflare MCP server portal to expose as the MCP Server Portals connector. See `packages/gatekeeper-mcp-portal/README.md`. |

To serve on another port, change the left side of the `ports` mapping, e.g. `"9000:8787"`, and set
`PUBLIC_BASE_URL` to match.

## Limits of the container

* **Password sign-in only.** There is no Cloudflare Access in front of it, and anyone who can reach
  the port can create an account. Keep the container on a trusted network, or turn off sign-ups in
  `/admin` once your users exist.
* **One process, local storage.** Durable Objects, KV and R2 are emulated on the volume. There is no
  replication and no backup beyond copying the volume.
* **OAuth connectors need a callback the browser can reach.** The provider redirects the browser to
  `<PUBLIC_BASE_URL>/gatekeeper/<name>/oauth`, so that URL must be registered with the provider.
  Connectors that take no OAuth app work without any setup: Context Library, Scheduled Tasks, and
  public MCP endpoints.
* **No Workers AI binding.** Web Search and webFetch's document conversion need the Workers AI
  binding, which reaches Cloudflare and therefore needs a login. They are unavailable in the
  container.
