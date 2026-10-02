# Contest notes

Entry for the [InterSystems Programming Contest: Build Your Own Management Portal](https://community.intersystems.com/post/intersystems-programming-contest-build-your-own-management-portal). Voting runs from September 28 to October 4, 2026; the application may be improved during voting.

## Contest task areas

| Area | Implemented | Boundary |
| --- | --- | --- |
| Manage web apps and explore REST APIs | Custom web application availability with review and readback; REST explorer with 28 allowlisted GET operations and export | No arbitrary URLs or write methods in the explorer; application editing is limited to availability |
| Permission management | Role inspection with holders, custom role resource permissions, direct user role assignment | No role creation, inherited-role or escalation editing |
| Security and secrets | Wallet collection access policy and secret inventory (names and types), X.509 owner lists, OAuth resource servers, TLS configurations | No secret value reads or edits, no key import or rotation, no end-to-end OAuth provider test |
| Task management | Tasks, task history, suspend/resume of user tasks verified through task/info | System tasks are protected |
| Operating system | System overview, resources, processes, devices, journal files | No process termination |
| Log monitoring and reporting | Embedded Python reader for current and archived text logs, similarity search across them with IRIS Vector Search, audit summaries, Markdown/JSON handover | No journal content decoding or every subsystem log |

## Technology bonuses (self-assessment; the organizers decide)

| Bonus | What the repository provides |
| --- | --- |
| Embedded Python | `Relay.LogReader` runs `src/Relay/log_reader.py` and `log_vectors.py` inside IRIS |
| IRIS Vector Search | `Relay.LogLine` stores `VECTOR(DOUBLE, 256)` embeddings of log lines; similarity search ranks them with `VECTOR_COSINE` ([details](LOGS.md)) |
| Docker container usage | `docker compose up -d` (IRIS + Relay, one command) and `scripts/lab.py`, both on the pinned official IRIS Community 2026.2 image |
| ZPM Package deployment | `module.xml`: `zpm "install iris-relay"` installs the full IRIS Relay UI, which IRIS serves at `/relay/index.html` with no Node.js or Python server, plus the IRIS side (`/api/relay`, log reader, similarity search table). Evidence below |
| Online Demo | [Real disposable IRIS lab](https://78-17-93-244.sslip.io), shared login shown on the page, reset hourly ([DEMO-HOSTING.md](DEMO-HOSTING.md)) |
| Implement Community Opportunity Idea | [DPI-I-966](https://ideas.intersystems.com/ideas/DPI-I-966), archived `messages.old_*` logs, in 0.3.0 ([details](LOGS.md)) |
| Find a bug in Embedded Python | [python-bugreports #17](https://github.com/intersystems-community/python-bugreports/issues/17) (`None` stored as text instead of SQL NULL) and [#18](https://github.com/intersystems-community/python-bugreports/issues/18) (`SQLError` with an empty message when a DELETE or UPDATE affects no rows) |
| First Article on Developer Community | [Developer Community article](https://community.intersystems.com/post/iris-relay-consistency-and-safety-during-shift-handovers) |
| Second Article on DC | [Spanish translation](https://es.community.intersystems.com/post/iris-relay-consistencia-y-seguridad-en-los-cambios-de-turno); a Portuguese translation is linked from the article |
| First Time Contribution | First Open Exchange contest for the author |
| Video on YouTube | [Demo recorded on the real lab](https://youtu.be/i_EW6gS3EJg); newer [0.4 guided tour](https://youtu.be/A5OkIV2Q3xA) |

## Lab basics from the expert review (0.5.1)

Robert Cemper's review of October 2 asked for three basics, all part of 0.5.1:

* **Port 52773 is published** by `docker compose up -d`, on 127.0.0.1 (`IRIS_BIND=0.0.0.0` to open it to the network, `IRIS_PORT` for another port): Management Portal at http://127.0.0.1:52773/csp/sys/UtilHome.csp, the IRIS-served Relay at http://127.0.0.1:52773/relay/index.html. The public demo overlay keeps IRIS unpublished.
* **Pre-expired passwords are reset in the lab**: `SuperUser` / `SYS` signs in to the Management Portal without a change prompt (local lab only; the demo and the IPM package do not touch users).
* **Password change at the Relay sign-in**: an account whose IRIS password expired or must be changed gets the change offered right there, in the Node version and in the IRIS-served UI; IRIS checks the old password, applies its password rules and counts failures ([how it works](../README.md#how-the-password-change-works)).

## IPM package: the UI starts and works with IRIS alone (0.5.0)

The organizers' condition for this bonus: after installation through IPM, the application must start and work without additional tools such as a Node.js or Python server, and the package must include the UI. From 0.5.0:

1. `zpm "repo -r -n registry -url https://pm.community.intersystems.com/"` once on a fresh IPM (it ships with no registry), then `zpm "install iris-relay"`.
2. Open `http://localhost:52773/relay/index.html` on the IRIS machine, or `https://<host>/relay/index.html` from anywhere else, and sign in with an IRIS account (see [What the account needs](../README.md#install-with-ipm-the-full-ui-served-by-iris-no-nodejs)).

That page is the full UI, not a reduced one: every area of the Node version, including reviewed changes with read-back, tasks, logs and the similarity search, audit, the REST explorer and the handover export. IRIS serves it from a static-files-only web application (`/relay`, CSP/ZEN and auto-compile off). The Relay API runs in the browser with the same modules as the Node server and calls IRIS on the same origin (`/api/admin` and `/api/relay`). Embedded Python, which runs inside IRIS, reads the logs and computes the similarity index; nothing runs outside IRIS. Relay Lite stays at `/relay/lite.html`.

Checked end to end on October 2, 2026, on a fresh IRIS Community 2026.2 container (pinned image) with IPM 0.10.9 from the official installer and `zpm "load"` of the 0.5.0 tree, in Chromium, with no Node.js server running: sign-in, every view, log paging and archived rotations, the similarity search, seven kinds of reviewed changes and a task suspension, each read back from IRIS outside the browser and restored, baseline comparison, Markdown and JSON handover, audit, all 28 explorer operations, replay and drift refused, sign-out cancelling a request in flight, nothing stored in the browser, zero console errors, every request to the IRIS origin only, and sign-in over HTTPS on a non-loopback name; then `zpm "uninstall iris-relay"` removed the classes, both web applications and the files. The same run was repeated on October 2 with 0.5.0 installed from the public registry: the archive matched main file by file (106 files) and all 169 checks passed. Details in [VALIDATION.md](VALIDATION.md).

Online demo: [real disposable IRIS lab](https://78-17-93-244.sslip.io), shared login shown on the page, reset hourly. Deployed and verified on a dedicated Ubuntu VPS ([DEMO-HOSTING.md](DEMO-HOSTING.md)). The separate GitHub Pages walkthrough is static and fictional.
