# Hosting the public demo

The public demo is a disposable IRIS 2026.2 lab behind Relay, on a dedicated small server. Visitors sign in with a shared account and can try every workflow on the Relay demonstration objects. Nothing else on the server matters, and the lab is recreated every hour.

## Safety model

* **Dedicated server only.** The installer refuses a server that already uses ports 80/443. Never host the demo next to anything else.
* **IRIS is never published.** Compose keeps IRIS without published ports; Relay listens on the host's 127.0.0.1:8787; Caddy (80/443) is the only public service. The firewall allows SSH, HTTP and HTTPS only.
* **One account, limited targets.** With `RELAY_DEMO=1` Relay accepts only the shared account (`RelayDemoOperator`, roles `%Manager`, no `%All`) and refuses, before contacting IRIS, any change that is not one of the Relay demonstration objects: the `Relay demonstration task`, `/relay-demo`, `RelayDemoUser`, `RelayDemoRole`, the `RelayDemo` wallet collection, `RelayDemoCertificate`, `RelayDemoOAuth` and `RelayDemoTLS`. The explorer stays read-only and allowlisted.
* **Bounded state.** At most 500 sessions (oldest dropped first); sign-in throttling is per client address as seen by Caddy (the proxy-appended `X-Forwarded-For` entry, never a client-supplied one).
* **Hourly reset.** A systemd timer recreates the IRIS and Relay containers every hour: a clean lab, the same public demo password, new random passwords for the lab's `%All` account (never shown).
* **HTTPS.** Caddy obtains a certificate automatically for `<ip>.sslip.io` (or `DEMO_HOST` if you point your own DNS name at the server).

## Install

On a fresh Ubuntu 24.04 server with 2 GB of RAM or more (4 GB recommended), as root:

```sh
curl -fsSL https://raw.githubusercontent.com/rafaorlando3/iris-relay/main/scripts/demo-install.sh | bash -s -- main
```

It installs `docker.io`, `docker-compose-v2`, `git` and `ufw` from Ubuntu's packages, checks out the repository in `/opt/iris-relay`, writes `/opt/iris-relay/.env` (0600) with the host name and a generated demo password, starts the stack and the reset timer, and prints the demo address. Re-running it updates the checkout and keeps the password.

## Check

```sh
python3 /opt/iris-relay/scripts/verify-demo.py https://<demo host>
```

57 checks as a visitor: demo mode advertised, other accounts refused, refusals for non-demo objects (including `_SYSTEM`, the demo account itself, `/csp/sys`, `/api/admin`, `%SuperServer`, `%Developer` and system tasks), every demo change applied, verified and restored, logs, similarity index and search, audit query and explorer.

## Stop

`cd /opt/iris-relay && docker compose -f compose.yaml -f compose.demo.yaml down && systemctl disable --now iris-relay-demo-reset.timer`, then delete the server.
