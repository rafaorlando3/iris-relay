# IRIS Relay

An operations workspace for InterSystems IRIS 2026.2. Inspect live management data, compare snapshots, review task and access changes, and leave a useful handover for the next operator.

This is an experimental operations tool with a disposable demonstration lab. It does not replace the entire Management Portal; see the scope and validation notes below.

## New in 0.2

TLS policy editing, custom role resource permissions, OAuth issuer/audience/scope configuration, backward text-log paging and session change evidence in handovers. See [release details](docs/RELEASE-0.2.md) and [log coverage](docs/LOGS.md).

An interactive fictional walkthrough is included under `docs/demo`. Run `python3 -m http.server 8790 --bind 127.0.0.1 --directory docs/demo` and open http://127.0.0.1:8790. It makes no IRIS requests and asks for no credentials. Use the laboratory below to evaluate the real integration.

## What works

* Sixteen live data views, an asynchronous audit log query, and a REST explorer with 28 curated GET operations: system overview, system resources, processes, devices, scheduled tasks, task history, runtime log, journal files, web applications, roles, users, wallet collections, X.509 credentials, OAuth server definitions, and OAuth resource servers.
* Baseline comparison by record identity. A missing row is reported as absent from the response, never assumed deleted.
* Task suspension and resumption with an expiring review step, a fresh state check, a single-use confirmation token, and verification against IRIS after the change. Only user-defined tasks can be changed.
* Enable or disable a custom web application, inspect role definitions, edit custom role resource policies, and replace direct role assignments on an ordinary user. Every edit has a before/after preview, fresh configuration check and verified readback.
* Wallet collection access policy editing with resource validation, public-resource rejection, a before/after preview and verified readback. Secret inventory exposes names and types only.
* X.509 credential owner-list editing and OAuth resource server availability changes, each with preview, concurrency checks and verified readback. Certificate keys are not changed. The resource-server editor additionally supports existing HTTPS issuer, accepted audiences and required scope; this does not prove a working provider login.
* Bounded asynchronous audit queries with explicit queued/running/finished states, session isolation and summary-only results.
* Markdown and JSON handover exports with timestamps, limits, before/after evidence, and optional operator notes.
* Runtime log reading implemented in Embedded Python inside IRIS. It reads fixed runtime, console, System Monitor and alert text sources with bounded backward paging, not arbitrary browser-supplied files. See [coverage](docs/LOGS.md).
* Permission hints from IRIS, explicit forbidden/unavailable states, and backend enforcement by the real IRIS account.

## Requirements

Node.js 22 or newer, Python 3, Docker Desktop/Engine, and an IRIS Community 2026.2 image. No npm runtime packages or paid service are required.

The initially tested `intersystemsdc/iris-community:latest` resolved to 2026.1 and did not expose the required `/api/admin/v2` endpoints. The laboratory pins the official 2026.2 multi-platform image index instead. The index advertises Linux AMD64 and ARM64 images; live validation was performed on ARM64 only. Docker selects the matching image for its host.

## Start an isolated laboratory

Start Docker, then from this directory run:

```sh
python3 scripts/lab.py
npm start
```

Open http://127.0.0.1:8787. The setup script prints the local path to `artifacts/lab-credentials.json`. Use the generated `RelayLab` username and `password` to connect. The `RelayObserver` user uses `observerPassword` and the built-in `%Operator` role for a limited-access demonstration. Do not publish this file.

The script also creates a disposable `Relay demonstration task` scheduled for the following day, so reviewers can test suspension and resumption without touching system tasks. It also creates a disabled `/relay-demo` application and a disabled `RelayDemoUser` account with no roles for application and permission demonstrations. The demo account has a generated password that is not retained and cannot be used to sign in. Its login remains disabled during role tests. A `RelayDemo` wallet collection is created with both edit/use access protected by `%Admin_Wallet:USE`; it contains no real secrets. The script also creates a public, self-signed `RelayDemoCertificate` owned by `RelayLab`, with no imported private key, and a disabled `RelayDemoOAuth` resource server using `https://relay-demo.invalid`. No application is attached and no external identity provider is contacted. The unused generated certificate key is discarded.

The lab binds IRIS to `127.0.0.1:52785`, with a two CPU and 2 GiB memory limit. Relay binds only to `127.0.0.1:8787`. The script refuses to repurpose an existing container without its expected image and local setup record. It does not remove containers or data.

Stop the application with Ctrl+C and stop the laboratory with:

```sh
docker stop iris-relay-2026-2
```

## Connect to an existing test instance

```sh
IRIS_URL=https://your-test-instance.example PORT=8787 npm start
```

The URL is an operator-configured origin, not an arbitrary browser-provided proxy destination. HTTP is accepted only for loopback targets; remote targets require HTTPS with valid certificates. Existing instances need Basic authentication on `/api/admin`. Enter an account with only the privileges needed for your work. Relay does not elevate privileges.

The optional runtime log extension consists of `src/Relay/Api.cls`, `src/Relay/LogReader.cls` and `src/Relay/log_reader.py`. Copy the Python file to `<IRIS manager directory>/relay/log_reader.py` and load both classes into `%SYS`. The local setup installs it in `%SYS` as `/api/relay`, with password authentication and a `%Admin_Operate:U` check. Without the extension the runtime log view reports unavailable; the standard management views still work.

## Review a task change

Choose Scheduled tasks, capture a baseline, and choose Suspend or Resume on a **user-defined** task. Review the task and connected instance, then confirm. Relay checks the state again and verifies the result through `/v2/task/info`. No system task can be changed through Relay. No process termination, data deletion or credential rotation is offered in this build.

The 2026.2 laboratory returned an outdated `Suspended` value from `/v2/tasks` immediately after a successful change. Relay reads user-task state from the detail endpoint before display, preview and confirmation. An accepted HTTP response alone is not treated as verified completion.

## Review applications and permissions

In Web applications, select Manage on `/relay-demo`, change the status and select Review change. Confirm only after checking the target instance and before/after values. Only `Enabled` is sent to IRIS. Restore the disabled status after the demonstration. System applications, applications in `%SYS` and Relay's own connection are protected.

In Users, open `RelayDemoUser`. Choose an existing role such as `%Operator`, review and confirm the assignment, then remove the role again. The account stays disabled throughout. Only `Roles` is sent; profile, password and escalation assignments are preserved. In Roles, select Manage to inspect resources, inherited roles and escalation settings. Custom non-escalation roles also support reviewed description and resource-permission edits, with an impact inventory of up to 100 holders.

The current signed-in account, recognized built-in accounts and direct `%All` holders are protected. Direct `%All` and `%Manager` grants and escalation-only grants are not supported. Other roles may still confer powerful or inherited access: this is a tool for authorized administrators, not a role sandbox. IRIS enforces `%Admin_Secure`. Changes to the target configuration or the selected role definitions invalidate the preview. These checks are optimistic, not an atomic IRIS transaction.

## Explore the API and wallet access

REST explorer provides 28 documented, allowlisted GET operations with validated parameters. It shows HTTP status, elapsed request time, observed timestamp and the IRIS response. List requests are capped at 100 rows. Export the result as Markdown or JSON for handover. It cannot send arbitrary URLs, headers or write methods. Responses are direct API observations; for example, the task-list endpoint may still have the version-specific state lag described above.

For the laboratory demonstration choose Wallet collection policy, enter `RelayDemo`, and run the request. Then open Wallet collections and Manage. Change UseResource to `%Admin_Operate:USE`, review and confirm, and restore `%Admin_Wallet:USE` after the demonstration. The collection is empty: no real secret changes hands. Both resource names are checked against IRIS and any public permission on either resource blocks the change. The administrator needs the IRIS permissions to inspect security resources as well as manage the wallet. Secret values are not read, stored or edited by Relay.

## Review certificate access and OAuth availability

Open X.509 credentials and Manage on `RelayDemoCertificate`. Add `RelayObserver` to the selected owners, review and confirm, then restore only `RelayLab`. Empty owner lists are refused because IRIS treats an empty list as access for all users. Anonymous accounts cannot be added. Relay changes only `OwnerList`; it does not import or rotate a certificate or its key.

In OAuth resource servers, Manage `RelayDemoOAuth`, enable the stored configuration, then restore Disabled. The form also supports description, existing issuer, audiences and required scope; leave those fields unchanged for this availability demonstration. This isolated example demonstrates configuration management, not successful token validation or a working connection to a provider.

## Read audit summaries

Open Audit log, optionally filter by user and server-local begin/end time, and choose a maximum of 100 records. IRIS creates a background query. Relay briefly polls, then offers Check query status if it is still unfinished. Pending results are never presented as an empty completed log. Completed rows show event, timestamp, user, description and namespace, and can be exported. Detailed event payloads, session identifiers and network fields are excluded. Free-text summaries still require review before sharing.

## Handover workflow

Capture baseline, refresh or make a reviewed change, then select Compare changes. Add context under Handover notes. Export handover produces a readable Markdown file; JSON preserves the structured response. Snapshots and notes stay in the browser tab and are cleared on sign-out. The session activity includes the last 100 accepted changes and their readback status. They are not persisted across a browser reload.

Results are capped at 100 records for list views. Each text-log page is capped at 64 KiB and 150 complete lines. Filters apply only to the loaded data. These are operational observations, not an exhaustive audit. Free text may contain sensitive information even though credential-like object fields are redacted. Review exports before sharing them.

## Validation

```sh
npm test
npm run test:logs
```

Forty-two JavaScript tests cover authentication, origin protection, path allowlisting, secret-field redaction, incompatible versions, IRIS application errors, upstream failures, sign-out, task replay prevention, concurrent state changes, snapshot comparison and Markdown output. Management tests additionally cover selective updates, protected targets, role validation, replay, configuration drift, role definition drift and failed verification. Explorer tests cover required parameters, query encoding, destination/method restrictions and row bounds. Wallet tests cover validated selective updates, public resource refusal and resource drift. Certificate and OAuth tests cover selective updates, owner validation and concurrent configuration changes. Audit tests cover filter bounds, asynchronous states, destination validation, session isolation, error handling and payload minimization.

The current build was additionally checked against a real ARM64 IRIS Community 2026.2 Build 221 container: the original live views returned successful responses; suspension and resumption were verified on a disposable task; a `%Operator` account could see tasks and was forbidden from roles and wallet collections. A second clean container was provisioned successfully with scripts/lab.py and validated for API v2 and runtime logs, then stopped. The latest bootstrap also passed on a new third container, including certificate/OAuth/wallet fixtures and runtime logs. Browser testing covered login, task review, confirmed state, filtering, baseline comparison, management forms and completed audit summaries. See [validation evidence](docs/VALIDATION.md) and the [reviewer walkthrough](docs/DEMO.md).

## Limitations and next work

This build does not replace the entire Management Portal. Wallet access policies are editable; secret values are not. X.509 editing is limited to credential owners, and OAuth editing covers resource server status, description, existing issuer, audiences and required scope. Certificate import/rotation, OAuth discovery and end-to-end provider authentication are not implemented. Application management is limited to availability, and permission management includes existing direct user roles and custom role resource policies. Role creation, inherited-role editing and escalation-setting editing are not implemented; existing custom role resource policies are editable. It does not provide every subsystem log, arbitrary API execution, public online demo, package-manager publication or production deployment. See [contest scope](docs/CONTEST.md) for implemented areas and boundaries. Organizer acceptance and bonus points are not implied by technical validation.

## Sources

[Contest announcement](https://community.intersystems.com/post/intersystems-programming-contest-build-your-own-management-portal)

[Official SysAdmin API specification](https://github.com/intersystems-community/sysadmin-api-specification)

[Technology bonus rules](https://community.intersystems.com/post/technology-bonuses-intersystems-programming-contest-build-your-own-management-portal)

## Repeat the local management integration check

With the isolated lab and Relay running on the default ports, run `python3 scripts/verify-management.py`. It temporarily changes the named demonstration application, account roles, wallet policy, certificate owners and OAuth availability, restores them, checks replay and permission denial, and exercises all 28 explorer operations plus an asynchronous audit query. It verifies that Relay targets the laboratory URL before making changes. Generated results stay under ignored `artifacts/`.

## Check the expanded configuration and log workflows

With the isolated laboratory and Relay running, execute `python3 scripts/verify-enhancements.py`. This exercises and restores `RelayDemoTLS`, the unassigned `RelayDemoRole` and `RelayDemoOAuth`, checks replay and observer denials, and checks available versus absent log sources.

## License

MIT. InterSystems IRIS is a separate dependency with its own terms. This project is not an InterSystems product.
