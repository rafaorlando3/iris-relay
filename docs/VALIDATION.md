# Validation record

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
