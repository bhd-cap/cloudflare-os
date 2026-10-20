# Running BlackHawk OS in a Proxmox LXC container

`scripts/proxmox/` installs the whole stack in a Debian 12 LXC container on Proxmox VE: the router,
the workshop backend, and every gatekeeper, running on `workerd` as `pnpm run-local` runs them.
It runs under systemd as the unprivileged `blackhawk` user.

Use it for demos, evaluation, and pilots on your own or a client's hardware. For a production
deployment, deploy to Cloudflare instead (see [deploy.md](deploy.md)). The service is
`wrangler dev`, which is not built for production traffic.

| Script | Runs on | Does |
| --- | --- | --- |
| `create-lxc.sh` | the Proxmox host | Downloads the Debian 12 template, creates an unprivileged container (with nesting), and runs `install.sh` in it. |
| `install.sh` | inside the container, or any Debian 12 VM | Installs a checksummed Node.js 24, fetches and builds the app, and installs and starts the `blackhawk-os` service. Re-run it to upgrade. |

## Create the container

On the Proxmox host, as root, run `create-lxc.sh` with `install.sh` beside it. Clone the
repository, or copy just the two files from `scripts/proxmox/`:

```sh
git clone https://github.com/bhd-cap/cloudflare-os.git && cd cloudflare-os/scripts/proxmox
./create-lxc.sh                                         # DHCP on vmbr0, next free CT ID
./create-lxc.sh --ip 10.0.0.50/24 --gateway 10.0.0.1    # static address
```

Defaults are 4 cores, 8 GiB RAM, 2 GiB swap, and a 32 GiB root disk on `local-lvm`. Run
`./create-lxc.sh --help` for the storage, bridge, VLAN, CT ID and sizing flags. The build needs at
least 4 GiB of RAM, and the running service uses 1–2 GiB.

When it finishes it prints the URL, e.g. `http://10.0.0.50:8787`. The first start takes 1–2
minutes, because it builds the connector apps. Then:

1. Open the URL, choose **Create one**, and sign up with the username **`admin`**. That username is
   the deployment admin.
2. Finish onboarding. Then open `/admin` to set the site name, logo, accent color, agent
   instructions, models and connectors.

### Choosing what to install

By default the container fetches `main` of `bhd-cap/cloudflare-os`. To install from a private
repository, pass a token with read access (`BHOS_GIT_TOKEN`). It is used for the fetch only and is
never written to disk. To pick another branch or tag, set `BHOS_REF`:

```sh
BHOS_REF=main BHOS_GIT_TOKEN=github_pat_... ./create-lxc.sh
```

For a site with no outbound GitHub access, build a source tarball on a workstation and pass it with
`--source`:

```sh
git archive --format=tar.gz -o blackhawk-os.tar.gz main    # on a workstation with the repo
./create-lxc.sh --source blackhawk-os.tar.gz                # on the Proxmox host
```

The container still needs outbound HTTPS to `nodejs.org`, the npm registry and the Debian mirrors
while it installs.

### Installing into an existing container or VM

On any Debian 12 machine, as root:

```sh
BHOS_REF=main ./install.sh                       # or BHOS_SOURCE=/path/to/blackhawk-os.tar.gz
```

## Configuration

Settings live in `/etc/blackhawk-os/blackhawk-os.env`, which only root and the service can read.
Apply changes with `systemctl restart blackhawk-os`. The file is written on first install with every
option commented, and upgrades leave it alone.

| Variable | Meaning |
| --- | --- |
| `PUBLIC_BASE_URL` | The URL people browse to. It defaults to the container's IP at install time. Change it if you use a DNS name, a reverse proxy or a new IP; account connect flows fail when it doesn't match. |
| `BHOS_PORT` | The port to serve on (default `8787`). |
| `CF_AI_GATEWAY`, `CF_AI_GATEWAY_ACCOUNT_ID`, `CF_AI_GATEWAY_API_TOKEN`, `CF_AI_GATEWAY_PROVIDERS` | Serve models through a Cloudflare AI Gateway, so users need no API keys of their own. The token needs AI Gateway Run + Read. Without these, each user adds a provider API key in their settings. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, ... | Connector OAuth apps. Register `<PUBLIC_BASE_URL>/gatekeeper/<name>/oauth` as the redirect URI. `SHARED_GATEKEEPER_CREDS` in `scripts/run-dev-server.ts` lists every name. |
| `MCP_PORTAL_URL`, `MCP_PORTAL_NAME`, `MCP_PORTAL_AUTH`, `MCP_PORTAL_TOKEN` | A Cloudflare MCP server portal, offered as the MCP Server Portals connector. See `packages/gatekeeper-mcp-portal/README.md`. |

## Operating it

| Task | Command (inside the container: `pct enter <CTID>`) |
| --- | --- |
| Status / logs | `systemctl status blackhawk-os`, `journalctl -u blackhawk-os -f` |
| Restart | `systemctl restart blackhawk-os` |
| Upgrade | `BHOS_REF=main /root/blackhawk-os-install.sh`, or with `BHOS_SOURCE=` for a tarball. Data and settings are kept. |
| Back up | `vzdump <CTID> --mode snapshot --compress zstd` on the host. This captures the data and settings too. |

| Path | Holds |
| --- | --- |
| `/opt/blackhawk-os` | The application. Replaced on upgrade. |
| `/var/lib/blackhawk-os/state` | All data: users, workspaces, Gadgets, blueprints and connections. The app's `.wrangler/state` is a symlink to it. |
| `/etc/blackhawk-os/blackhawk-os.env` | Settings. |

To ship a ready-made instance to a client, take a `vzdump` backup of a configured container and
restore it on their host with `pct restore`. Then update `PUBLIC_BASE_URL` for its new address.

## Limits

* **Password sign-in only.** There is no Cloudflare Access in front of it, and anyone who can reach
  the port can create an account. Keep the container on a trusted network or VLAN, or turn off
  sign-ups in `/admin` once your users exist. For TLS, put it behind a reverse proxy, or a
  Cloudflare Tunnel with Access, and set `PUBLIC_BASE_URL` to that URL.
* **One process, local storage.** Durable Objects, KV and R2 are emulated on the container's disk.
  Back up with `vzdump`.
* **No Workers AI binding.** Web Search and webFetch's document conversion need the Workers AI
  binding, which reaches Cloudflare and needs a login. They are unavailable here.
