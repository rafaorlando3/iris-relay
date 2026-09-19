# IRIS Relay 0.2.0

This release strengthens configuration management, log investigation and shift handover.

## Useful changes

* TLS policies: inspect configurations, edit description/status, select TLS 1.2/1.3 bounds and maintain peer verification. Existing keys, certificates and cipher settings are preserved. The editor does not permit disabled/weaker peer verification.
* Custom role policies: review affected accounts/roles, edit description and resource permissions. Resources are validated in IRIS before review and again before application. Built-in and escalation-only roles are protected. Inherited roles and escalation settings are preserved.
* OAuth resource-server configuration: edit description/status, select an existing HTTPS issuer, accepted audiences and a required scope. No provider discovery, secret update or login is performed. Stored configuration readback does not establish working OAuth authentication.
* Log investigation: choose a supported text source, search the current page and page backward. Missing sources are unavailable, not empty successful results; changes and rotations invalidate the cursor. See LOGS.md.
* Handover: the last 100 accepted session changes and their individual verification outcomes are included in JSON/Markdown exports. This history is in-memory and is not a replacement for IRIS auditing.
* Grouped navigation and an explicit fictional interactive walkthrough that needs no credentials or IRIS instance. The walkthrough never contacts management APIs or claims simulated writes were verified in IRIS.
* Bootstrap updates explicitly load both extension classes, preventing old definitions from surviving a local update.

## Verification

42 JavaScript tests and 6 Python tests passed during development. The real ARM64 IRIS Community 2026.2 lab accepted and returned matching values for the three new configuration types; each was restored to its original full configuration. Repeat application of review tokens returned HTTP 409. The limited observer account received HTTP 403 on every new configuration edit. Existing management checks and all 28 curated explorer operations also passed.

Browser checks covered the TLS description review/apply/readback/restore cycle, log paging, offline task simulation and baseline comparison. See VALIDATION.md for the dated evidence and installation check.

## Boundaries

No secret-value editor, certificate key import/rotation, OAuth end-to-end provider authentication, system-process termination or comprehensive binary log decoding. No production-readiness claim. Published code, organizer moderation, contest acceptance, awarded bonus points and payment remain separate states.
