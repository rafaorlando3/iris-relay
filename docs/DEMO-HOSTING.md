# Hosting the public demo

The public demo is a disposable IRIS 2026.2 lab behind Relay, on a dedicated small server. Visitors sign in with a shared account and can try every workflow on the Relay demonstration objects. Nothing else on the server matters, and the lab is recreated every hour.

## Safety model

* **Dedicated server only.** The installer refuses a server that already uses ports 80/443. Never host the demo next to anything else.
* **IRIS is never published.** The local lab (`compose.yaml`) publishes the IRIS web server on 127.0.0.1:52773; `compose.demo.yaml` replaces that port list (`ports: !override`, Docker Compose 2.24.4 or newer, which Ubuntu 24.04's `docker-compose-v2` provides), so on the demo server IRIS has no published port. Relay listens on the host's 127.0.0.1:8787; Caddy (80/443) is the only public service. The firewall allows SSH, HTTP and HTTPS only.
* **No lab shortcuts.** The demo command leaves out the lab-only bootstrap options: the predefined IRIS accounts keep their expired passwords, IRIS serves no Relay UI, and Relay refuses password changes in demo mode, so the shared account keeps the password shown on the sign-in page.
* **One account, limited targets.** With `RELAY_DEMO=1` Relay accepts only the shared account (`RelayDemoOperator`, roles `%Manager`, no `%All`) and refuses, before contacting IRIS, any change that is not one of the Relay demonstration objects: the `Relay demonstration task`, `/relay-demo`, `RelayDemoUser`, `RelayDemoRole`, the `RelayDemo` wallet collection, `RelayDemoCertificate`, `RelayDemoOAuth` and `RelayDemoTLS`. The explorer stays read-only and allowlisted.
* **Bounded state.** At most 500 sessions (oldest dropped first); sign-in throttling is per client address as seen by Caddy (the proxy-appended `X-Forwarded-For` entry, never a client-supplied one).
* **Hourly reset.** A systemd timer recreates the IRIS and Relay containers every hour: a clean lab, the same public demo password, new random passwords for the lab's `%All` account (never shown).
* **Guided tour.** The demo bootstrap (`--demo-account`) plants a simulated incident for a 5-step tour shown after sign-in: a synthetic archived rotation `messages.old_<yesterday>` and three lines in the live `messages.log`, written through IRIS. Every line is labelled `[Relay demo incident]` or `[Relay demo archive]` and says it is simulated; an existing rotation with the same name is never replaced. It runs once per container, so the hourly reset recreates it.
* **HTTPS.** Caddy obtains a certificate automatically for `<ip>.sslip.io` (or `DEMO_HOST` if you point your own DNS name at the server).

## Install

On a fresh Ubuntu 24.04 server with 2 GB of RAM or more (4 GB recommended), as root:

```sh
commit=PUT_THE_FULL_REVIEWED_COMMIT_SHA_HERE
curl -fsSL "https://raw.githubusercontent.com/rafaorlando3/iris-relay/$commit/scripts/demo-install.sh" | bash -s -- "$commit"
```

Use the full 40-character reviewed commit SHA in both places; the installer refuses an omitted ref, branch name or abbreviated SHA. It installs `docker.io`, `docker-compose-v2`, `git` and `ufw` from Ubuntu's packages, checks out the repository in `/opt/iris-relay`, writes `/opt/iris-relay/.env` (0600) with the host name and a generated demo password, starts the stack and the reset timer, and prints the demo address. Re-running it updates the checkout, recreates the containers to load the new classes and code, and keeps the shared password and certificate volume. The disposable lab and visitor sessions are reset during that update.

## Check

```sh
python3 /opt/iris-relay/scripts/verify-demo.py https://<demo host>
```

60 checks as a visitor: demo mode advertised, other accounts refused, refusals for non-demo objects (including `_SYSTEM`, the demo account itself, `/csp/sys`, `/api/admin`, `%SuperServer`, `%Developer` and system tasks), every demo change applied, verified and restored, logs, similarity index and search, the guided tour incident (archived rotation listed and readable, found by the similarity search in the current and archived logs), audit query and explorer.

## Stop

`cd /opt/iris-relay && docker compose -f compose.yaml -f compose.demo.yaml down && systemctl disable --now iris-relay-demo-reset.timer`, then delete the server.
