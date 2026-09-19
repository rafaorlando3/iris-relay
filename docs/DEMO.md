# Reviewer walkthrough

Allow about seven minutes after the laboratory has started. Use only the disposable fixtures installed by `python3 scripts/lab.py`. Run `npm start`, open http://127.0.0.1:8787 and use the generated local credentials described in README.md. Never show the credentials file in a recording.

1. **Connect and orient.** Sign in as RelayLab. Show the connected loopback instance, reported IRIS version and live overview. Explain that unavailable values are not converted into zeros.
2. **Review a task change.** In Scheduled tasks, capture a baseline. Suspend the Relay demonstration task, review the target and before/after state, and confirm. Show the verified readback and baseline difference. Resume the task before moving on.
3. **Applications and permissions.** Manage the disabled /relay-demo application. Preview enabling it and show the impact. Apply and restore Disabled if demonstrating writes. In Users, inspect RelayDemoUser and preview assigning %Operator. Cancel, or remove the role again after a verified write. The demo user must stay disabled.
4. **Security examples.** Wallet collections allows reviewing EditResource/UseResource changes on RelayDemo. X.509 credentials allows reviewing addition of RelayObserver to RelayDemoCertificate owners. OAuth resource servers allows reviewing availability of RelayDemoOAuth. Each preview can be cancelled; any applied change must be restored. Certificate keys and provider settings are not changed.
5. **Audit and logs.** In Audit log, query up to 10 summaries. Show Queued or Running separately from Finished and the events from lab changes when returned. Detailed event payloads are excluded. Open Runtime log to demonstrate the bounded Embedded Python reader.
6. **API and handover.** In REST explorer, choose Wallet collection policy with name RelayDemo. Run the GET and show HTTP status and response. Add a short handover note and export Markdown or JSON. Explain the 100-record bounds and the need to review free text before sharing.
7. **Permissions and close.** Sign out, sign in as RelayObserver and open Roles to show the explicit forbidden result enforced by IRIS. Sign out. Restore every modified fixture and keep both ports loopback-only.

## Evidence and limits

The repeatable integration check is `python3 scripts/verify-management.py`; it verifies ten reversible fixture changes, restoration, replay protection, all 25 explorer operations, populated security details and an asynchronous audit query. Automated tests run with `npm test`. See VALIDATION.md for what was actually observed.

This walkthrough is not a production readiness claim. The OAuth example does not establish external authentication. No credential values, real customer data or public administrator account are needed for the demonstration.


## 0.2 additions for reviewers

1. **TLS configurations**: manage `RelayDemoTLS`. Change only its description, review the exact fields, apply and confirm matching readback. Restore the original description. Inspect the session history. Protocol controls allow only TLS 1.2/1.3 and do not weaken peer verification.
2. **Roles**: manage the unassigned `RelayDemoRole`. Inspect holders and add `%Admin_Operate:U` in the resource-permissions field. Review/apply, then restore the empty resource list. Do not assign this demonstration role to a real account.
3. **OAuth resource servers**: manage `RelayDemoOAuth`. Add `relay-reviewed` on a second audience line, review/apply and restore. It remains disabled and has no attached application. The issuer is a reserved `.invalid` domain: no provider call is made.
4. **Log investigation**: load `messages.log`, select Older records, filter that page and export. Inspect SystemMonitor.log. Missing sources appear unavailable. A changed file requests a fresh page rather than silently mixing observations.
5. Export a handover containing the current observation, optional baseline, notes and the last 100 accepted session changes. Verify the before/after/readback status, then sign out to clear browser state.

For a no-installation overview, serve `docs/demo` with a static HTTP server. The explicit fictional walkthrough supports task review, baseline comparison and export. It cannot connect to IRIS and never substitutes sample data for a failed live connection.
