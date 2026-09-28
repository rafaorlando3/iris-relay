#!/usr/bin/env bash
# Install the IRIS Relay public demo on a fresh, DEDICATED Ubuntu 24.04 server (2 GB RAM or more).
#
# Run this script from the reviewed checkout, passing its full 40-character commit SHA.
#
# What it does: installs Docker from Ubuntu's own packages, checks out this repository in
# /opt/iris-relay, generates the shared demo password (kept in /opt/iris-relay/.env, 0600),
# opens only SSH/HTTP/HTTPS, starts IRIS + Relay + Caddy (automatic HTTPS on
# <ip>.sslip.io unless DEMO_HOST is set) and resets the lab every hour.
# Never run it on a server that hosts anything else: the demo is a public admin tool.
set -euo pipefail

REF="${1:-}"
REPO="${IRIS_RELAY_REPO:-https://github.com/rafaorlando3/iris-relay.git}"  # override only for rehearsals
DIR="/opt/iris-relay"
COMPOSE=(docker compose -f compose.yaml -f compose.demo.yaml)

fail() { echo "IRIS Relay demo install failed: $*" >&2; exit 1; }
step() { echo "==> $*"; }

[[ "$REF" =~ ^[a-fA-F0-9]{40}$ ]] || fail "pass the full reviewed 40-character commit SHA."

[ "$(id -u)" = 0 ] || fail "run it as root (sudo)."
. /etc/os-release
[ "${ID:-}" = ubuntu ] || fail "Ubuntu is required (found ${ID:-unknown})."
mem=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
[ "$mem" -ge 1800 ] || fail "at least 2 GB of RAM is needed (found ${mem} MB)."
if ss -ltnH '( sport = :80 or sport = :443 )' | grep -q . && [ ! -d "$DIR" ]; then
  fail "ports 80/443 are already in use. Use a dedicated server for the public demo."
fi

step "Installing Docker, Compose, git and the firewall from Ubuntu packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 git ufw curl >/dev/null
systemctl enable --now docker >/dev/null

ip=$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}')
[ -n "$ip" ] || fail "could not detect this server's IPv4 address."
host="${DEMO_HOST:-${ip//./-}.sslip.io}"

step "Fetching IRIS Relay ($REF)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$REF"
  git -C "$DIR" checkout -q --detach FETCH_HEAD
else
  git clone -q "$REPO" "$DIR"
  git -C "$DIR" checkout -q --detach "$REF"
fi
cd "$DIR"
echo "    commit $(git rev-parse --short HEAD)"

if [ ! -f .env ]; then
  step "Generating the shared demo password"
  password=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16 || true)
  [ "${#password}" -eq 16 ] || fail "could not generate the demo password."
  (umask 077 && printf 'DEMO_HOST=%s\nRELAY_DEMO_PASSWORD=%s\n' "$host" "$password" > .env)
fi

step "Firewall: only SSH, HTTP and HTTPS (IRIS and Relay stay on the loopback)"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

step "Starting IRIS, Relay and Caddy"
"${COMPOSE[@]}" up -d --force-recreate

step "Hourly reset to a clean lab"
cat > /etc/systemd/system/iris-relay-demo-reset.service <<UNIT
[Unit]
Description=Reset the IRIS Relay public demo to a clean lab
[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=/usr/bin/docker compose -f compose.yaml -f compose.demo.yaml up -d --force-recreate iris relay
UNIT
cat > /etc/systemd/system/iris-relay-demo-reset.timer <<UNIT
[Unit]
Description=Hourly reset of the IRIS Relay public demo
[Timer]
OnCalendar=hourly
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now iris-relay-demo-reset.timer >/dev/null

. ./.env
step "Waiting for Relay"
# Relay only answers for its public host name (DNS-rebinding protection), so send it.
probe() { curl -fsS --noproxy '*' -o /dev/null -H "Host: $DEMO_HOST" http://127.0.0.1:8787/api/config; }
for _ in $(seq 1 60); do
  probe 2>/dev/null && break
  sleep 3
done
probe || fail "Relay did not start. See: cd $DIR && ${COMPOSE[*]} logs --tail 50"

echo
echo "IRIS Relay public demo: https://$DEMO_HOST"
echo "Shared account (also shown on the sign-in page): RelayDemoOperator / $RELAY_DEMO_PASSWORD"
echo "HTTPS certificates are requested on the first visit; allow a minute."
echo "Check it end to end: python3 $DIR/scripts/verify-demo.py https://$DEMO_HOST"
