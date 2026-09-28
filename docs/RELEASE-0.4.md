# IRIS Relay 0.4.0

Released during the contest voting week, September 28, 2026.

## One-command lab

`docker compose up -d` starts the pinned IRIS Community 2026.2 image and Relay (node:22-alpine) with nothing else installed on the host. Provisioning lives in one place, `scripts/bootstrap.py`, which runs inside the IRIS container for both the compose lab (`iris-main --after`, credentials generated and kept inside the container, 0600) and `scripts/lab.py` (credentials passed on stdin). Relay shares the IRIS network namespace, so its target stays loopback; Docker publishes only 8787, on the host's 127.0.0.1. IRIS itself is not published.

## Similarity search across all logs (IRIS Vector Search)

Log investigation has a new "Search all logs by similarity" panel. Lines from the current logs, numbered rotations and archived `messages.old_*` files are embedded inside IRIS and stored in `Relay.LogLine` (`VECTOR(DOUBLE, 256)`); queries are ranked with `VECTOR_COSINE` and repeats are grouped with occurrence counts and files. Bounded (3,000 lines per file, 20,000 total), incremental, lexical embeddings with no model download. Searching and refreshing follow IRIS SQL privileges on the table. See [LOGS.md](LOGS.md).

## IPM package for the IRIS side

`module.xml` at the repository root packages the IRIS part of Relay: `Relay.Api`, `Relay.LogReader`, `Relay.LogLine`, the two Embedded Python modules (copied to `<manager directory>/relay/`) and the `/api/relay` web application with password authentication. No users or demo data are created. The web UI keeps running with compose or Node and connects to the instance with `IRIS_URL`.

## Public demo mode

`RELAY_DEMO=1` enables the isolated public demo mode: only the shared demo account signs in, only the Relay demonstration objects can be changed (refused before any IRIS call otherwise), the sign-in page shows the shared account, and sessions and sign-in throttling are bounded per client. `compose.demo.yaml` adds Caddy for HTTPS and keeps IRIS unpublished; `scripts/demo-install.sh` installs everything on a fresh, dedicated Ubuntu server with an hourly reset; `scripts/verify-demo.py` checks it as a visitor. See [DEMO-HOSTING.md](DEMO-HOSTING.md).

## Verification

Final review: 46 JavaScript tests, 26 Python tests and seven real IRIS transaction/concurrency checks passed. All 57 visitor checks passed on the deployed HTTPS demo. Review fixes add bounded content digests for log rewrites, atomic index replacement with shared/exclusive locks, repair of partial indexes, and a full-SHA installer that recreates containers on upgrade.

Live demo: https://78-17-93-244.sslip.io (shared login on the page, disposable data, hourly reset).

Earlier implementation benchmarks on the x86-64 lab: 18,202 lines from 9 files indexed in about 7 seconds, a second refresh skipped all 9 unchanged files in 0.13 seconds, searches answered in 0.1 to 0.25 seconds, the `%Operator` observer received "not privileged" for refresh and search. `verify-management.py` and `verify-enhancements.py` (now including the similarity index and search) passed on a new compose lab (388 lines from 2 files indexed) and on the lab created by `lab.py`. The IPM package was loaded with IPM into a plain IRIS 2026.2 container (USER namespace), uninstalled and loaded again; its endpoints answered for a password account (401 for wrong credentials), indexed 398 lines and searched them, and the Relay UI server signed in to that instance and used logs, index, search and the tasks view.
