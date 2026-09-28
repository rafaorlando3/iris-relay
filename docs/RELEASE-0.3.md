# IRIS Relay 0.3.0

Released during the contest voting week, September 28, 2026.

## Archived messages.log files (Community idea DPI-I-966)

Log investigation now lists archived runtime log rotations from the manager directory, as requested in [DPI-I-966](https://ideas.intersystems.com/ideas/DPI-I-966) ("Option to show older message.log in IRIS SMP"):

* `messages.old_<date>` and `messages.old_<date>_<n>` (the names IRIS 2026.2 produced in our lab), plus legacy `cconsole.old_*`.
* Newest first, with size and last-write time; the newest 24 are listed and the catalog reports how many older files were omitted.
* Read with the same bounded paging (64 KiB / 150 lines), backward cursor, page search and change detection as the current log.
* IDs such as `runtime.old_20260928_1` are validated by both the Node server and the Embedded Python reader. Path separators, dots, symbolic links and special files are refused. Compressed rotations are not listed.

`scripts/lab-rotate-log.py` creates a real rotation in the disposable lab (lowers `MaxConsoleLogSize` to 1 MB, writes labelled lines, waits for IRIS to rotate, restores the original value even if a step fails). It acts only on the container recorded by `scripts/lab.py` in the new non-secret `artifacts/lab-setup.json` (name, container ID, pinned image, loopback port); any other container, including one with the same image, is refused before any change.

## Other changes

* Wide tables no longer let long text overlap the next column; the table scrolls horizontally instead.
* README reorganized: quick start, contest area mapping, how a change works, architecture and screenshots.
* Demo video recorded against the real lab.

## Verification

43 JavaScript tests and 15 Python tests pass. On a fresh x86-64 IRIS Community 2026.2 (Build 221U) lab container: three real rotations were produced and listed newest first, an archived file was read and paged backwards through Relay's HTTP API, traversal IDs returned HTTP 400, and the existing management, explorer, audit and log checks (`verify-management.py`, `verify-enhancements.py`) passed with every fixture restored.
