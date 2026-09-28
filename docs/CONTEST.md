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
| Docker | `docker compose up -d` (IRIS + Relay, one command) and `scripts/lab.py`, both on the pinned official IRIS Community 2026.2 image |
| Embedded Python | `Relay.LogReader` runs `src/Relay/log_reader.py` and `log_vectors.py` inside IRIS |
| IPM package | `module.xml`: `zpm "install iris-relay"` installs the IRIS side (`/api/relay`, log reader, similarity search table); the UI runs with compose or Node |
| Vector search | `Relay.LogLine` stores `VECTOR(DOUBLE, 256)` embeddings of log lines; similarity search ranks them with `VECTOR_COSINE` ([details](LOGS.md)) |
| Community Opportunity idea | [DPI-I-966](https://ideas.intersystems.com/ideas/DPI-I-966), archived `messages.old_*` logs, in 0.3.0 ([details](LOGS.md)) |
| YouTube video | Demo recorded on the real lab (link in README once published) |
| Article | Developer Community article (link in README once published) |
| First contribution | First Open Exchange contest for the author |

Online demo: ready to host with `scripts/demo-install.sh` ([DEMO-HOSTING.md](DEMO-HOSTING.md)); the address is added to the README once it is running. The GitHub Pages walkthrough is static and fictional. Not provided: Embedded Python bug report.
