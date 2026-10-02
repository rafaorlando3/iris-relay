# Validation record

## Version 0.5.0: the full UI served by IRIS from the IPM package, October 2, 2026

Run in a disposable container in Claude's cloud workspace; nothing ran on the Mac or on the demo VPS, and the live demo was not touched.

* IRIS Community 2026.2 Build 221U (x86-64), the image pinned by digest in `compose.yaml`. IPM 0.10.9 from the official installer, SHA-256 checked. `zpm "load"` of the 0.5.0 tree: all six phases SUCCESS, `zpm list` shows 0.5.0. IRIS stored `/relay` with CSPZENEnabled 0, AutoCompile 0, ServeFiles 1, AutheEnabled 64 and no dispatch class, and `/api/relay` with password authentication and `Relay.Api`. The 18 files in `csp/relay` were byte-identical to `web/relay`, each answered 200 with a JavaScript, CSS or HTML type, and `/relay/`, `/relay/%CSP.Login.cls` and `/relay/Relay.Api.cls` answered 404.
* Accounts: the browser signed in as `RelayOperator` (`%Manager` and `%DB_USER`, plus `GRANT SELECT, INSERT, DELETE ON Relay.LogLine`), the roles the README asks for. `RelayObserver` (`%Operator`, `%DB_USER`) was the restricted account. `RelayLab` (`%All`) only created the disposable fixtures with `scripts/bootstrap.py` and read results from outside the browser.
* Chromium on `http://localhost:52773/relay/index.html`, with no Node.js server running: 112 of 112 checks. Sign-in; all 19 views without an error; logs with backward paging, page search, an archived `messages.old_*` rotation and the similarity search finding the labelled incident in current and archived files; seven reviewed changes (web application, user roles, role description, TLS minimum version, wallet policy, X.509 owners, OAuth resource server), each reported as "Applied and verified in IRIS", read back from IRIS outside the browser and restored; a task suspended and resumed with review, baseline comparison, and Markdown and JSON handover exports with 15 verified changes and no password; an audit query; all 28 REST explorer operations with HTTP 200. Through the same browser backend against the real IRIS: a replayed confirmation and a change made by someone else after the review were refused with 409 and nothing was written; `/api/admin`, `/relay`, a `%All` holder, the signed-in account, `%All` grants and a system task were refused; an explorer URL, a write method and a log path were refused. Sign-out cancelled an index refresh in flight (`net::ERR_ABORTED`) and no request left the page afterwards; localStorage, sessionStorage, cookies and IndexedDB stayed empty. Every request went to `http://localhost:52773` (`/relay`, `/api/admin`, `/api/relay` only); static files carried no credentials. Zero console errors and zero page errors in the walkthrough.
* Negative checks in a separate browser context: a wrong password was refused; the restricted account saw its views marked Restricted, the reason for the Roles 403 and the "not privileged" answer to the index refresh; a missing record answered 404 in the explorer; on plain HTTP through the container's address the sign-in was disabled and no API request was sent, even when the button was forced on; inside a frame the page refused to sign in. Over HTTPS on a non-loopback name (`relay.test` with a test certificate, through a local TLS front) the sign-in, overview and tasks worked. Relay Lite at `/relay/lite.html` still worked.
* Node.js path after the shared-route refactor, against the same IRIS: `verify-management.py` and `verify-enhancements.py` passed, and the Node-served UI in Chromium signed in, suspended and resumed the task with verification, read the logs and ran an explorer request. Its only console entry is the existing 401 of the `/api/session` probe before sign-in.
* `zpm "uninstall iris-relay"`: Unconfigure and Clean SUCCESS; both web applications and the three classes removed; `csp/relay` gone; `/relay/index.html` and `/relay/app.js` answered 404.
* 64 JavaScript tests (18 new: 14 for the browser backend with a test double of IRIS, 4 for the IRIS UI build) and 29 Python tests passed.

Findings fixed before this run: IRIS labels static `.html` and `.css` files `charset=ISO-8859-1`, which wins over `<meta charset>`, so the build writes `index.html` as ASCII with character references (module scripts are always read as UTF-8); IRIS lets browsers cache static files for an hour, so every module import carries `?v=<package version>`. Limits: `zpm "load"` of a directory, not the public registry; the HTTPS check used a self-signed certificate accepted only by the test browser.

## Public guided tour deployment, September 28, 2026

The reviewed tour a7dd7f3 was integrated with b206455, which keeps the suggested handover note neutral when the visitor skips or cancels the task change, checks that the review dialog opened, and refuses comparison after a failed task reload. On the dedicated demo VPS, 29 Python and 46 JavaScript tests passed. The public HTTPS visitor check passed **60/60** with `allPassed: true` after deploying full SHA `b206455c1d5d9f9cbd56d22efb939c65eefaf6c1`. No project or tests were run on the Mac.

The new [0.4 video](https://youtu.be/A5OkIV2Q3xA) is a recording of the earlier a7dd7f3 rehearsal; the deployed suggested note includes the review correction above. The original 0.3 walkthrough remains linked. IPM source and version are unchanged.

## Guided tour for the public demo, September 28, 2026

Change: the public demo shows a 5-step guided tour after sign-in, over a labelled,
simulated incident planted by the demo bootstrap (a synthetic archived rotation
`messages.old_<yesterday>` and three lines written to the live `messages.log`
through IRIS). No IRIS class, API route or permission changed.

* Local rehearsal of the public demo stack (`compose.yaml` + `compose.demo.yaml`,
  Caddy with HTTPS on `localhost`, IRIS Community 2026.2 container):
  `scripts/verify-demo.py` passed 60 checks as a visitor, 57 before plus 3 new ones
  for the tour incident. Checked after a fresh container and again after a container
  restart; the restart did not duplicate the incident lines (3 in `messages.log`).
* The similarity search for "license limit exceeded" ranked the simulated incident
  lines first, from both the current and the archived log, followed by real IRIS
  license messages.
* A browser run of all five steps in Chromium passed: search, archived rotation
  opened, baseline captured, the demo task suspended with review and verified in IRIS,
  comparison, prefilled note and Markdown export; the task was resumed and verified
  afterwards. No page errors.
* The static walkthrough (`docs/demo`, rebuilt) still loads without errors and does
  not show the tour.
* 46 JavaScript tests and 29 Python tests passed (3 new for the incident: the
  archive is labelled, listed and readable by the log reader, lines go through IRIS
  once per container, and an existing rotation is never replaced).

## Deployment review, September 28, 2026

The later records below retain their original scope and dates. On the dedicated
Ubuntu 24.04 x86-64 demo VPS, review of 0.4 found and corrected three issues before
publication: same-size log rewrites missed by filesystem timestamps, partial or
concurrent index replacement, and upgrades that did not recreate IRIS.

* 26 Python unit tests passed on the VPS, including deterministic same-size,
  same-timestamp rewrites, old partial/duplicate index repair, and removal of stale
  rows when a source cannot be read consistently. No project tests ran on the Mac.
* A separate fresh IRIS 2026.2 container, with no network and only synthetic data,
  passed seven checks in `scripts/verify-log-index.py`: initial index, rollback,
  retry, partial-index repair, concurrent-writer refusal, a reader waiting for a
  complete committed generation without duplicates, and preservation of a caller
  transaction. SQL statements are explicitly prepared before data transactions.
* The installer now requires a full reviewed commit SHA and recreates containers
  on upgrade. Shell syntax and rejection of missing/moving refs passed on the VPS.
* The original staging deployment passed 46 JavaScript tests and all 57 public
  demo checks through real HTTPS. Only SSH, HTTP and HTTPS were exposed; IRIS had
  no published port and Relay was bound to loopback. The hourly reset timer was
  active.
* Reviewed application commit `6763412560e4237755458a9c6c6031688e35d0e7` was
  published to GitHub and installed with the GitHub origin and that fixed SHA.
  All 57 HTTPS visitor checks passed again; 46 JavaScript tests passed. External
  HTTPS returned 200 with a valid certificate in 0.73 seconds in one observation.
  After verification, observed memory was IRIS 496 MiB, Relay 16 MiB and Caddy
  12 MiB. These are point observations, not a load or availability guarantee.
* The dedicated server accepts SSH keys only. Its firewall exposes only 22, 80
  and 443; external access to 8787 timed out and IRIS has no published port.
  The separate synthetic-data review container was removed after its checks.

For the isolated IRIS regression, enable `%Service_CallIn` only in the disposable
test container, then run its `irispython` with `RELAY_DISPOSABLE_REVIEW=1`, first
with `scripts/verify-log-index.py --prepare` and then without `--prepare`. It refuses
an existing nonempty index. Do not run this synthetic-data test on a live instance.

Observed locally on 2026-09-19. No production system, client data or paid infrastructure was involved.

* IRIS Community 2026.2 Build 221U, ARM64, API version 2. Official container digest is pinned in scripts/lab.py.
* Fourteen views successfully queried through the Relay server, including the Embedded Python runtime log.
* Disposable user task 1000 suspended and resumed. API state verified through task/info. Replay of the same confirmation token returned 409; change attempt on system task 1 returned 403.
* IRIS `%Operator` test account signed in and read tasks; roles and wallet collections returned 403.
* Twenty-one automated tests passed. Test doubles are identified in the test sources and are separate from the live integration check.
* Browser confirmed login, scheduled tasks, filtering, review dialog, "Applied and verified in IRIS", and a detected before/after change for task 1000.
* Fresh-container setup passed on a second container and separate loopback port using scripts/lab.py. API version 2 and the runtime log returned HTTP 200 for the lab administrator and operator. A separate task-only account on the main lab received HTTP 403 on the log route. The additional container was stopped after validation.
* Runtime log extension compiled inside IRIS and returned 150 tail lines using an Embedded Python method, with a 64 KiB read bound.

Known compatibility observations:

1. The community Docker Hub `latest` image resolved to 2026.1. Its wrapper failed during startup, and running its base entrypoint showed API version 1 with no v2 paths. The official 2026.2 image solved the runtime requirement.
2. In 2026.2, task list `Suspended` did not reflect the changed state, while task/info and the underlying task object did. Relay verifies via task/info and does not infer success from HTTP 200.

Not yet established: contest acceptance, production readiness, public demo, full Management Portal coverage, fresh-machine installation on a different OS/architecture, prize eligibility or revenue.

## Application and permission increment

* The local Relay HTTP API enabled and disabled `/relay-demo`, then added and removed `%Operator` on the disabled `RelayDemoUser`. Four changes were independently read back as verified. Complete configuration before/after matched after restoration.
* Four reused tokens returned 409. Attempts to disable `/api/admin`, change `RelayLab`, or grant `%All` returned 403. A `%Operator` session was also denied the new management operation by IRIS.
* Browser walkthrough confirmed application preview, apply, successful verification and restoration. The user role selector and its before/after preview were inspected visually; this browser preview was cancelled. Role writes were validated by the separate live HTTP check above.
* The updated bootstrap ran on the separate laboratory container and created the new disposable application and disabled user. This was an upgrade rehearsal on the earlier clean-check container, not a new blank-container installation.
* Test evidence is saved under ignored `artifacts/management-live.json`; no credentials or generated lab output belong in the public repository.
* IRIS application detail omits the `Type` property advertised by the specification. Relay also checks application list classification, namespace and protected paths. The list `IsSystemApp` alone is not sufficient: some built-ins reported false while their `Type` included System.

## REST explorer and wallet policy increment

* Twenty-seven automated tests passed. The new explorer validates allowed operations, method, parameter names/types, integer bounds and query encoding. Wallet tests check protected collections, policy validation, resource drift and public-access rejection.
* All 24 catalog operations were exercised against the local IRIS: 21 returned HTTP 200 with real observations; X.509 detail/certificate and OAuth definition queries used intentionally nonexistent identifiers and returned HTTP 404. Successful reads of populated X.509/OAuth detail records have not been established.
* `RelayDemo` collection UseResource changed to `%Admin_Operate:USE` and back to `%Admin_Wallet:USE`, with both fields read back and verified. The original collection policy was restored. No secret value was created, read or transferred.
* Replayed wallet tokens returned 409. Explorer rejected arbitrary URLs, write-method parameters and row counts over 100. An operator without security privileges received 403 on Roles through the explorer.
* Browser verified the explorer's parameter form and HTTP 200 response for RelayDemo. Wallet policy form and before/after review were inspected; that browser preview was cancelled. Actual writes were verified through the separate local HTTP integration check.
* Updated bootstrap was run on the second isolated lab. It created the wallet fixture and both access resources were read back as `%Admin_Wallet:USE`.

## Certificate, OAuth and asynchronous audit increment

* Thirty-five automated tests passed. New checks cover owner eligibility and drift, OAuth selective updates, audit filter bounds, asynchronous destination validation, result projection, concurrency and permission denial. Boolean HasPrivateKey metadata remains visible; credential values remain redacted.
* Live integration applied and independently verified ten changes across five disposable targets: application status, direct user roles, wallet policy, certificate owners and OAuth resource server status. All five complete configurations matched their original state after restoration. Every replay returned 409.
* All 25 explorer operations were checked: 22 returned 200 and three intentional missing-record queries returned 404. The corresponding three populated certificate/OAuth detail queries also returned 200.
* An audit query returned 202, then Finished with ten summaries. Detailed EventData and SessionID were absent. A different session could not access the query (404); the limited operator could not start one (403).
* Browser review confirmed the disabled OAuth configuration form and a completed audit query displayed in a table. No external identity provider was contacted. The lab certificate is public-only; no private key was imported.
* A genuinely new third container, iris-relay-final-check on loopback port 52787, was installed by the final bootstrap. Certificate owner RelayLab, disabled OAuth fixture, wallet collection and runtime log returned successful live reads. The extra container was stopped after validation; the main preview container remains running. This is a fresh-container check on the same ARM64 host, not a different machine or architecture.

Earlier sections record earlier increments; the results above supersede their test counts and inspection-only limitations. No contest acceptance or monetary result has been observed.

## Version 0.2.0, September 19, 2026

* 42 JavaScript tests and 6 Python tests passed. The JavaScript command now targets only `test/*.test.mjs`, so ignored verification clones do not duplicate the reported count.
* TLS version bounds and description, custom role resource permissions, and OAuth audience/scope/description changes were applied and read back on three named lab fixtures. Six writes including restoration were verified. Each complete configuration matched its starting state. Tokens could not be replayed; the observer account received 403 for each new edit.
* These new checks plus the existing ten management writes and 28 explorer operations also passed against a fresh fourth container (`iris-relay-v02-check`, loopback 52788), bootstrapped with the updated installer. This is the same ARM64 host, not independent AMD64 validation.
* The Embedded Python reader returned runtime and System Monitor lines. The absent legacy console and alerts sources returned explicit unavailability. Unit tests verify complete-line paging, append/rotation invalidation, traversal rejection, symbolic-link rejection, long-line and message bounds.
* Browser validation on the real lab covered TLS description preview, apply, matching readback, restoration and a two-entry session history. Runtime log backward paging was also exercised.
* The separate static walkthrough completed sample task review, simulated application and baseline comparison. It labels all data fictional and cannot issue IRIS requests. A simulation is never marked as an IRIS-verified write.
* A local upgrade initially retained an old class definition with LoadDir. The installer now loads each extension class explicitly; clean installation and upgrade were rechecked successfully.

No acceptance, prize, awarded bonus points or income is inferred from these checks.

## Version 0.3.0, September 28, 2026

* First run on x86-64: a new lab container from the pinned official image (IRIS for UNIX, Ubuntu Server LTS for x86-64 Containers, 2026.2 Build 221U) was created by `scripts/lab.py` on a Linux x86-64 host. `npm test` (42 tests at the start of the day) and `npm run test:logs` passed; `verify-management.py` and `verify-enhancements.py` passed with all fixtures restored.
* Archived rotations: with `MaxConsoleLogSize` lowered to 1 MB, IRIS renamed the log to `messages.old_20260928` about a minute after the limit was exceeded, then `messages.old_20260928_1`, `_2` and `_3` for later rotations the same day. Relay listed them newest first with sizes, read `messages.old_20260928` (150 lines, older data available), paged backwards, and rejected `runtime.old_../iris.cpf` with HTTP 400 without contacting IRIS. The `%Operator` observer could list the same sources, consistent with the existing `%Admin_Operate:U` check. `scripts/lab-rotate-log.py` produced a rotation and restored the original value (5 MB), verified in `iris.cpf`.
* After the change: 43 JavaScript tests and 15 Python tests pass. `verify-enhancements.py` reads every source, including archived rotations, and checks the new invalid IDs.
* Lab helper identification (review feedback): `scripts/lab.py` now writes `artifacts/lab-setup.json` with the container name, ID, image and loopback port. Live checks: with no record the helper refused and the lab was not restarted; a second container from the same image (`decoy-same-image`) was refused both by name and with a forged record pointing at the real lab's ID, without restart or setting change (`MaxConsoleLogSize=5`, no rotation); the recorded lab was accepted, rotated to `messages.old_20260928_4` and restored with readback. Injected failures after the change (while writing lines, and right after lowering the limit) still restored 5 MB and exited with status 1. Unit tests cover the same refusals and restorations without Docker.
* Second review round: `scripts/lab.py` no longer reuses a container on image and credentials alone. With the lab stopped and its record removed, `lab.py` refused before starting it or writing anything (container stayed stopped, no record created, credentials unchanged); a 12-character ID in `--adopt-container` and a record with a different ID were refused the same way; the confirmed full ID was recorded and the lab provisioned normally; a registered lab and a brand-new lab (separate name, port and files) were accepted, including a second run on the new one. The helper now sends every command to the verified container ID: after identification the lab was renamed and a different container was started under the old name; the rotation (`messages.old_20260928_5`) and restoration happened in the identified lab, while the other container was not restarted, kept 5 MB and had no rotation. 43 JavaScript and 16 Python tests pass.
* The demo video was recorded against this lab. The task, user role and every other fixture changed on camera were restored and read back afterwards (task 1000 not suspended; RelayDemoUser disabled with no roles).

No acceptance, prize, awarded bonus points or income is inferred from these checks.

## Version 0.4 implementation evidence, September 28, 2026 (before final review)

* One-command lab: `docker compose up -d` started the pinned IRIS image and Relay (node:22-alpine) in about 11 seconds on x86-64. `scripts/bootstrap.py` ran inside the IRIS container through `iris-main --after`, created the lab accounts with generated passwords (credentials file 0600 inside the container), the Relay extension and every fixture. Relay started only after the health check. `verify-management.py` and `verify-enhancements.py` passed against the compose lab, using the credentials read with `docker compose exec`.
* `docker compose restart iris` re-ran the idempotent bootstrap with the same credentials and restarted Relay with it (Relay shares the IRIS network namespace, so it follows IRIS restarts); login worked afterwards.
* `scripts/lab.py` now uses the same bootstrap. A registered lab from 0.3 was re-provisioned (the root-owned `log_reader.py` left by the old `docker cp` is replaced by rename), and a brand-new lab on another name and port passed both live verification scripts.
* Similarity search (IRIS Vector Search): the first refresh indexed 18,202 lines from 9 files (current, SystemMonitor, alerts and six archived rotations) in about 7 seconds; the second skipped all 9 unchanged files in 0.13 seconds. "log file grew too large" returned the rotation message grouped as 6 occurrences in 6 files; "journal switch" returned the journaling lines from current and archived files; queries took 0.1 to 0.25 seconds. The `%Operator` observer received "User RelayObserver is not privileged for the operation" for both refresh and search, shown as the reason. `verify-enhancements.py` now covers index, incremental refresh, search, input bounds and the observer denial; it passed on the `lab.py` lab and on a new compose lab (388 lines from 2 files), together with `verify-management.py`. 44 JavaScript and 21 Python tests pass.
* IPM package: on a plain IRIS 2026.2 container with the current IPM installer (from pm.community.intersystems.com) and no Relay bootstrap, `zpm "load"` of the repository installed the three classes in USER, copied both Python modules to `/usr/irissys/mgr/relay/` and created `/api/relay`. Two findings fixed before release: loading the whole `Relay` package made IPM reject the `.py` files (the module now lists the three classes), and IPM ignored `PasswordAuthEnabled`, leaving the application unauthenticated (every call then got 403 from the `%Admin_Operate` check); `AutheEnabled="32"` gives password authentication, confirmed in `Security.Applications`. After uninstall and reload: log sources, a 150-line page, index (398 lines, 0.4 s) and search answered for a password account, wrong credentials got 401, and the Relay UI server signed in to this instance and used the same endpoints plus the tasks view. `iris-relay` was not yet taken in the public registry.
* Public demo mode (hosting rehearsal): with `compose.demo.yaml` behind Caddy (HTTPS on `localhost` with Caddy's local CA), `scripts/verify-demo.py` passed 57 checks as a visitor with the shared `RelayDemoOperator` account (`%Manager`, no `%All`): the `RelayLab` account was refused before any IRIS call; changes to `_SYSTEM`, the demo account itself, `/csp/sys`, `/api/admin`, `%SuperServer`, `%Developer` and a non-demo task were refused; every Relay demonstration object was changed, verified and restored; logs, similarity index and search, audit and explorer worked. The hourly reset (`up -d --force-recreate iris relay`) took 26 seconds and returned an application left enabled by a visitor to disabled. `scripts/demo-install.sh` was rehearsed in an Ubuntu 24.04 container with systemd and ufw stubbed: the first run exposed that its readiness probe was refused by Relay's host check (403 "Unexpected host."); the probe now sends the public host name and the rehearsal completed. 46 JavaScript tests (2 new for demo mode and session/throttle bounds).
