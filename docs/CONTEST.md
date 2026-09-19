# Contest readiness, 2026-09-19

Target: Build Your Own Management Portal, deadline September 27, 2026 at 23:59 EST as published by the organizer.

Official bonus announcement:
https://community.intersystems.com/post/technology-bonuses-intersystems-programming-contest-build-your-own-management-portal

| Bonus | Published points | Evidence here | Status |
| --- | ---: | --- | --- |
| Docker | 2 | Pinned IRIS Community 2026.2 container, loopback binding, lab setup | Implemented locally; organizer award pending |
| Embedded Python | 3 | Relay.LogReader reads and parses the bounded runtime log inside IRIS | Implemented and exercised; organizer award pending |
| First contribution | 3 | No eligibility claim made | Personal eligibility not independently confirmed; do not claim awarded |
| Demonstration video | 3 per video, max 3 videos | No recording or public video | One concise useful demo is preferable to padding |
| Online demo | 2 | Local app only | Not earned; do not expose an administrator account to obtain it |
| ZPM deployment | 2 | No published package | Not earned |
| Community Opportunity idea | 4 | No qualifying idea selected | Not earned |
| Vector search | 2 in list, 5 in paragraph | No vector search | Conflicting wording; not selected because it adds no clear value here |
| Embedded Python bug | 2 for first reproducible bug, max 3 | No confirmed Embedded Python bug | Task list behavior is NOT an Embedded Python bug; do not claim this bonus |
| Articles | 2 then 1 | No article | No automatic publication; editorial rules differ from coding rules |

The implemented Docker and Python components align with five published bonus points, not five granted points. There is no approval, prize or income yet.

## Publication and review status

The public repository is https://github.com/rafaorlando3/iris-relay. Version 0.1.0 was sent for Open Exchange approval on September 19, 2026, with Submit to Contest selected. This records submission, not organizer acceptance. Version 0.2.0 adds the capabilities documented in RELEASE-0.2.md; publication of that update is recorded separately in the delivery notes.

Remaining useful work: organizer scope review, a public demonstration video and optional package publication. A fictional static walkthrough is included for quick evaluation; it must not be described as a public live administrative service or an awarded online-demo bonus.

## Implemented scope and boundaries

| Area | Working local capability | Boundary |
| --- | --- | --- |
| Operations | System/process/device/resource views; suspend/resume user tasks | No process termination or system-task edits |
| Logs | Embedded Python runtime/System Monitor/console/alert text paging, journal inventory, asynchronous audit summaries | No journal content parser or every subsystem log |
| Applications and permissions | Custom app availability; inspect roles; assign existing direct user roles | Custom role resource policies added; no role creation or general application/authentication configuration |
| Wallet | Collection access policy; names/types of secret inventory | No secret value reads or edits |
| Certificates and OAuth | Certificate metadata and owner-list changes; OAuth resource server issuer/audience/scope/status configuration; TLS policy edits | No key import/rotation or live provider authentication |
| REST exploration | 25 allowlisted parameterized GET operations with export | No arbitrary destination or write-method console |

The exact categorization and sufficiency are subject to organizer review. Docker and Embedded Python evidence is technical implementation evidence, not awarded points.
