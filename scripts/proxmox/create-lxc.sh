#!/usr/bin/env bash
# Creates a Debian 12 LXC container on a Proxmox VE host and installs BlackHawk OS in it.
# Run on the Proxmox host as root. See docs/proxmox.md.
#
#   ./create-lxc.sh                                  defaults: next free ID, DHCP on vmbr0
#   ./create-lxc.sh --ip 10.0.0.50/24 --gateway 10.0.0.1 --storage local-zfs
#   ./create-lxc.sh --source blackhawk-os.tar.gz     install a `git archive` tarball, no git access
#
# Anything set in the environment as BHOS_* (BHOS_REPO, BHOS_REF, BHOS_GIT_TOKEN, BHOS_PORT,
# BHOS_PUBLIC_BASE_URL) is passed through to install.sh inside the container.

set -euo pipefail

CTID=""
HOSTNAME_="blackhawk-os"
STORAGE="local-lvm"
TEMPLATE_STORAGE="local"
BRIDGE="vmbr0"
IP="dhcp"
GATEWAY=""
VLAN=""
CORES=4
MEMORY=8192
SWAP=2048
DISK=32
SOURCE=""

usage() {
  cat <<EOF
Usage: $0 [options]
  --ctid ID                 container ID (default: next free)
  --hostname NAME           (default: $HOSTNAME_)
  --storage NAME            storage for the root disk (default: $STORAGE)
  --template-storage NAME   storage holding CT templates (default: $TEMPLATE_STORAGE)
  --bridge NAME             network bridge (default: $BRIDGE)
  --vlan TAG                VLAN tag (default: none)
  --ip CIDR|dhcp            address (default: dhcp)
  --gateway IP              gateway, with a static --ip
  --cores N                 (default: $CORES)
  --memory MiB              (default: $MEMORY)
  --swap MiB                (default: $SWAP)
  --disk GiB                (default: $DISK)
  --source FILE             install this source tarball instead of fetching from git
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ctid) CTID="$2"; shift 2 ;;
    --hostname) HOSTNAME_="$2"; shift 2 ;;
    --storage) STORAGE="$2"; shift 2 ;;
    --template-storage) TEMPLATE_STORAGE="$2"; shift 2 ;;
    --bridge) BRIDGE="$2"; shift 2 ;;
    --vlan) VLAN="$2"; shift 2 ;;
    --ip) IP="$2"; shift 2 ;;
    --gateway) GATEWAY="$2"; shift 2 ;;
    --cores) CORES="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --swap) SWAP="$2"; shift 2 ;;
    --disk) DISK="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root on the Proxmox host"
command -v pct >/dev/null || die "pct not found: run this on a Proxmox VE host"
INSTALLER="$(dirname "$(readlink -f "$0")")/install.sh"
[[ -f "$INSTALLER" ]] || die "install.sh must sit next to this script"
[[ -z "$SOURCE" || -f "$SOURCE" ]] || die "--source is not a file: $SOURCE"
[[ "$IP" == "dhcp" || -n "$GATEWAY" ]] || die "--gateway is required with a static --ip"
[[ -n "$CTID" ]] || CTID="$(pvesh get /cluster/nextid)"

log "Finding the Debian 12 template"
pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '$2 ~ /^debian-12-standard_/ {print $2}' |
  sort -V | tail -n 1)"
[[ -n "$TEMPLATE" ]] || die "no debian-12-standard template is available from pveam"
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

NET="name=eth0,bridge=$BRIDGE,ip=$IP"
[[ -n "$GATEWAY" ]] && NET+=",gw=$GATEWAY"
[[ -n "$VLAN" ]] && NET+=",tag=$VLAN"

log "Creating container $CTID ($HOSTNAME_)"
# Unprivileged, with nesting, which Debian 12's systemd needs inside an unprivileged container.
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME_" \
  --ostype debian \
  --unprivileged 1 \
  --features nesting=1 \
  --cores "$CORES" \
  --memory "$MEMORY" \
  --swap "$SWAP" \
  --rootfs "$STORAGE:$DISK" \
  --net0 "$NET" \
  --onboot 1 \
  --tags blackhawk-os \
  --description "BlackHawk OS — see /opt/blackhawk-os/docs/proxmox.md"
pct start "$CTID"

log "Waiting for the network"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 ||
  die "container $CTID has no working DNS/network; check --bridge/--ip/--gateway"

pct push "$CTID" "$INSTALLER" /root/blackhawk-os-install.sh --perms 0755

# The installer's settings travel as a root-only file rather than as `pct exec` arguments, which
# any user on the host could read from `ps` — BHOS_GIT_TOKEN among them.
settings="$(mktemp)"
trap 'rm -f "$settings"' EXIT
if [[ -n "$SOURCE" ]]; then
  pct push "$CTID" "$SOURCE" /root/blackhawk-os-source.tar.gz
  echo "BHOS_SOURCE=/root/blackhawk-os-source.tar.gz" >>"$settings"
fi
for name in BHOS_REPO BHOS_REF BHOS_GIT_TOKEN BHOS_PORT BHOS_PUBLIC_BASE_URL; do
  if [[ -n "${!name:-}" ]]; then printf '%s=%q\n' "$name" "${!name}" >>"$settings"; fi
done
pct push "$CTID" "$settings" /root/blackhawk-os-install.env --perms 0600

log "Installing BlackHawk OS in container $CTID"
pct exec "$CTID" -- bash -c 'set -a; . /root/blackhawk-os-install.env; set +a
  rm -f /root/blackhawk-os-install.env; exec /root/blackhawk-os-install.sh'

log "Done. Container $CTID — manage it with: pct enter $CTID"
