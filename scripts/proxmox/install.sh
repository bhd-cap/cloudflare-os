#!/usr/bin/env bash
# Installs (or upgrades) BlackHawk OS on a Debian 12 machine — meant for a Proxmox LXC, which
# create-lxc.sh sets up and then runs this inside, but any Debian 12 container or VM works.
#
# It runs the whole stack (router, workshop backend, every gatekeeper) on workerd, as
# `pnpm run-local` does, under a systemd service. Re-run it to upgrade: data in $DATA_DIR and
# settings in $ENV_FILE are kept. See docs/proxmox.md.
#
# Settings, all optional, from the environment:
#   BHOS_SOURCE           a source tarball to install (e.g. from `git archive`), instead of git
#   BHOS_REPO             git repository to install from (default: the BlackHawk fork on GitHub)
#   BHOS_REF              branch, tag or commit to install (default: main)
#   BHOS_GIT_TOKEN        token for a private repository; used for the fetch only, never stored
#   BHOS_PORT             port to serve on (default: 8787; only used on first install)
#   BHOS_PUBLIC_BASE_URL  the URL people browse to (default: http://<this machine's IP>:<port>;
#                         only used on first install — edit $ENV_FILE afterwards)

set -euo pipefail

NODE_VERSION="24.19.0"
APP_DIR="/opt/blackhawk-os"
DATA_DIR="/var/lib/blackhawk-os"
ENV_DIR="/etc/blackhawk-os"
ENV_FILE="$ENV_DIR/blackhawk-os.env"
SERVICE="blackhawk-os"
SERVICE_USER="blackhawk"

BHOS_REPO="${BHOS_REPO:-https://github.com/bhd-cap/cloudflare-os.git}"
BHOS_REF="${BHOS_REF:-main}"
BHOS_PORT="${BHOS_PORT:-8787}"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
# shellcheck source=/dev/null
[[ -r /etc/os-release ]] && . /etc/os-release
[[ "${ID:-}" == "debian" && "${VERSION_ID:-}" == "12" ]] ||
  echo "warning: tested on Debian 12; this is ${PRETTY_NAME:-an unknown system}" >&2

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git xz-utils >/dev/null

install_node() {
  if [[ "$(/usr/local/bin/node --version 2>/dev/null)" == "v$NODE_VERSION" ]]; then
    return
  fi
  local arch
  case "$(uname -m)" in
    x86_64) arch="x64" ;;
    aarch64) arch="arm64" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
  local name="node-v$NODE_VERSION-linux-$arch.tar.xz"
  local base="https://nodejs.org/dist/v$NODE_VERSION"
  local tmp
  tmp="$(mktemp -d)"
  log "Installing Node.js $NODE_VERSION"
  curl -fsSL "$base/$name" -o "$tmp/$name"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $name\$" SHASUMS256.txt | sha256sum -c --quiet -) ||
    die "Node.js download failed its checksum"
  tar -xJf "$tmp/$name" -C /usr/local --strip-components=1 \
    --exclude CHANGELOG.md --exclude LICENSE --exclude README.md
  rm -rf "$tmp"
}
install_node
# pnpm at the version package.json pins.
corepack enable

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/state"

as_service_user() {
  runuser -u "$SERVICE_USER" -- env HOME="$DATA_DIR" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    ${https_proxy:+https_proxy="$https_proxy"} ${HTTPS_PROXY:+HTTPS_PROXY="$HTTPS_PROXY"} \
    ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS"} "$@"
}

# The source tree. Upgrades keep node_modules where they can, which makes them much faster.
if [[ -n "${BHOS_SOURCE:-}" ]]; then
  [[ -f "$BHOS_SOURCE" ]] || die "BHOS_SOURCE is not a file: $BHOS_SOURCE"
  log "Installing from $BHOS_SOURCE"
  rm -rf "$APP_DIR"
  install -d "$APP_DIR"
  tar -xf "$BHOS_SOURCE" -C "$APP_DIR"
else
  log "Fetching $BHOS_REPO ($BHOS_REF)"
  install -d "$APP_DIR"
  [[ -d "$APP_DIR/.git" ]] || git -C "$APP_DIR" init -q
  chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
  git_env=()
  if [[ -n "${BHOS_GIT_TOKEN:-}" ]]; then
    # Passed as config through the environment, so the token never reaches argv or .git/config.
    git_env=(GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader
      "GIT_CONFIG_VALUE_0=Authorization: Basic $(printf 'x-access-token:%s' "$BHOS_GIT_TOKEN" | base64 -w0)")
  fi
  as_service_user env "${git_env[@]}" git -C "$APP_DIR" fetch -q --depth 1 "$BHOS_REPO" "$BHOS_REF"
  as_service_user git -C "$APP_DIR" checkout -q -f FETCH_HEAD
fi

# wrangler dev persists everything (users, workspaces, Gadgets, blueprints) under
# .wrangler/state. Keep it outside the app directory, so a reinstall from a tarball can't touch it.
install -d "$APP_DIR/.wrangler"
if [[ -d "$APP_DIR/.wrangler/state" && ! -L "$APP_DIR/.wrangler/state" ]]; then
  cp -a "$APP_DIR/.wrangler/state/." "$DATA_DIR/state/"
  rm -rf "$APP_DIR/.wrangler/state"
fi
ln -sfn "$DATA_DIR/state" "$APP_DIR/.wrangler/state"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$DATA_DIR"

log "Building (this takes a few minutes)"
as_service_user bash -c "cd '$APP_DIR' && pnpm install --frozen-lockfile \
  && pnpm exec vp run --cache @gadgets/typed-storage#build \
  && pnpm exec vp run --cache @gadgets/workshop-frontend#build:assets"

if [[ ! -f "$ENV_FILE" ]]; then
  ip="$(hostname -I | awk '{print $1}')"
  install -d -m 0750 -g "$SERVICE_USER" "$ENV_DIR"
  install -m 0640 -g "$SERVICE_USER" /dev/null "$ENV_FILE"
  cat >"$ENV_FILE" <<EOF
# BlackHawk OS settings. Apply changes with: systemctl restart $SERVICE

# The port to serve on, and the URL people browse to. Account connect flows hand their result back
# to PUBLIC_BASE_URL, so it must match what users type, e.g. a DNS name or reverse-proxy URL.
BHOS_PORT=$BHOS_PORT
PUBLIC_BASE_URL=${BHOS_PUBLIC_BASE_URL:-http://${ip:-localhost}:$BHOS_PORT}

# Serve models through a Cloudflare AI Gateway, so users need no API keys of their own. The token
# needs AI Gateway Run + Read permissions.
#CF_AI_GATEWAY=
#CF_AI_GATEWAY_ACCOUNT_ID=
#CF_AI_GATEWAY_API_TOKEN=
#CF_AI_GATEWAY_PROVIDERS=anthropic,openai

# Connector OAuth apps (redirect URI: <PUBLIC_BASE_URL>/gatekeeper/<name>/oauth). See
# SHARED_GATEKEEPER_CREDS in scripts/run-dev-server.ts for every name.
#GITHUB_CLIENT_ID=
#GITHUB_CLIENT_SECRET=
#GOOGLE_CLIENT_ID=
#GOOGLE_CLIENT_SECRET=

# A Cloudflare MCP server portal, offered as the MCP Server Portals connector.
#MCP_PORTAL_URL=
#MCP_PORTAL_NAME=
EOF
fi

log "Installing the $SERVICE service"
cat >"/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=BlackHawk OS
Documentation=file://$APP_DIR/docs/proxmox.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=HOME=$DATA_DIR
Environment=COREPACK_ENABLE_DOWNLOAD_PROMPT=0
EnvironmentFile=$ENV_FILE
# run-local's server step; the builds it would run first were done by the installer.
ExecStart=/usr/local/bin/node scripts/run-dev-server.ts --serve-frontend-assets --no-watch --ip 0.0.0.0 --port \${BHOS_PORT}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q "$SERVICE"
systemctl restart "$SERVICE"

port="$(sed -n 's/^BHOS_PORT=//p' "$ENV_FILE")"
url="$(sed -n 's/^PUBLIC_BASE_URL=//p' "$ENV_FILE")"
log "Waiting for BlackHawk OS to start (first start builds the connector apps, ~1-2 minutes)"
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "http://127.0.0.1:${port:-8787}/"; then
    log "BlackHawk OS is running at $url"
    echo "Sign up as 'admin' to reach /admin. Logs: journalctl -u $SERVICE -f"
    exit 0
  fi
  systemctl is-active -q "$SERVICE" || break
  sleep 5
done
journalctl -u "$SERVICE" -n 50 --no-pager >&2 || true
die "the service did not come up; see the log above"
