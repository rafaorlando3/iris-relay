# Log coverage and consistency

Relay 0.2 added a text-log investigation workspace, alongside the existing asynchronous audit query, task history and journal file inventory. Relay 0.3 adds archived `messages.old_*` rotations, implementing Community Opportunity idea [DPI-I-966](https://ideas.intersystems.com/ideas/DPI-I-966) ("Option to show older message.log in IRIS SMP").

| Source | Read boundary | Absence handling |
| --- | --- | --- |
| `messages.log` | Fixed file in the IRIS manager directory | Explicit unavailable error |
| `cconsole.log` | Fixed legacy console file | May not exist on current instances |
| `SystemMonitor.log` | Fixed System Monitor text file | Explicit unavailable error |
| `alerts.log` | Fixed alerts text file | May not exist until generated |
| Numbered rotations | `.1`, `.2`, `.3` of these four sources | Listed only when present |
| Archived rotations | `messages.old_<suffix>` and legacy `cconsole.old_<suffix>` in the manager directory, newest 24 by modification time | Listed only when present; the number of older files not listed is reported |
| Audit | Management API background query; up to 100 summaries | Queued/running/finished/error states |
| Task history | Management API; up to 100 returned rows | Permissions and errors remain visible |
| Journal | File inventory only | Binary journal contents are not parsed |

The text reader is Embedded Python executed inside IRIS. Each page extracts at most 64 KiB and returns at most 150 complete lines in chronological order. Older records use a cursor tied to source, device, inode, size, modification time and a digest of the requested window. Detected append, rotation or content changes require loading the latest page again. The bounded content checks and their limits are described below.

## Archived rotations (0.3)

When `messages.log` grows beyond `MaxConsoleLogSize`, IRIS renames it and starts a new file. On IRIS 2026.2 we observed `messages.old_20260928`, then `messages.old_20260928_1` for a second rotation on the same day. The Management Portal shows only the current file; Relay lists these archived files by name, size and last-write time, and reads them with the same paging, search and consistency rules as the current log.

Archived IDs look like `runtime.old_20260928_1`. The suffix may contain only letters, digits, `_` and `-` (at most 48 characters), so an ID cannot contain a path separator or a dot. Symbolic links and special files are neither listed nor read. Compressed files such as `messages.old_20260926.gz` are not listed. Only the newest 24 archived files are offered in the selector; the catalog reports how many older ones were omitted.

To see a real rotation in the disposable lab, run `python3 scripts/lab-rotate-log.py`. It lowers `MaxConsoleLogSize` (a `[Startup]` setting, in MB) to 1, restarts the lab container, writes labelled lines until IRIS creates a new `messages.old_*` file (about one minute), then restores the original value and restarts again. It acts only on the container that `scripts/lab.py` recorded in `artifacts/lab-setup.json` (same name and container ID, pinned image, IRIS published only on 127.0.0.1 at the recorded port), refuses anything else before changing a setting or restarting, and sends every later command to that container ID rather than the name. The original value is restored even if a later step fails. `scripts/lab.py` itself reuses a container only when the same record matches; a lab created before 0.3 is refused until you confirm its full ID with `docker inspect -f '{{.Id}}' <name>` and run `python3 scripts/lab.py --adopt-container <full ID>` once.

## Similarity search across all files (0.4)

`src/Relay/log_vectors.py` (Embedded Python, loaded by `Relay.LogReader`) reads the newest complete lines of every available source (at most 1 MiB and 3,000 lines per file, 20,000 lines in total, current and numbered files first, then archived newest first) and stores them in `Relay.LogLine` with an embedding column `VECTOR(DOUBLE, 256)`. A query is embedded the same way and ranked in IRIS SQL with `VECTOR_COSINE`; the 200 closest lines are grouped by message pattern (digits folded) and returned with the number of occurrences and the files where they appear.

* Embedding: words and character trigrams hashed into 256 dimensions and L2-normalized, digits folded so timestamps and PIDs do not dominate. Lexical similarity, not a language model; no download and no external call.
* Refresh is incremental: unchanged identity, bounded content digest and stored row count allow a file to be skipped. Changed files are replaced and missing files are removed. A file that cannot be read consistently is reported as not indexed and its stale rows are removed.
* A refresh holds an exclusive IRIS process lock and replaces the index in one transaction. SQL failure rolls back the entire replacement. Searches hold a shared lock (waiting up to five seconds); a competing refresh fails with a retry message. Partial or duplicated indexes from older versions are repaired on refresh. These operations require no existing caller transaction.
* Same symbolic-link and special-file refusal as the reader. Queries are 1 to 200 characters and at most 50 groups.
* Privileges are IRIS SQL privileges on `Relay.LogLine`: SELECT to search, INSERT and DELETE to refresh. Failures return the IRIS reason (for example "not privileged") instead of an empty result.
* The index is a disposable cache in `%SYS`, not an audit; deleting it loses nothing that is not in the files.

The browser supplies a source ID, never a file path. Symbolic links and nonregular files are refused. Messages are capped at 2,000 characters and flagged when shortened. Oversized fragments are skipped with a visible flag. An unfinished final line appears only after its newline is written. Searching applies to the current page, not the entire file.

This is not universal coverage of every subsystem. Custom application paths, compressed rotations, Windows Event Log, journal record decoding and interoperability message bodies are not included. Manager-directory Linux instances are supported; IRIS 2026.2 was exercised on ARM64 and x86-64 containers. Free-text logs may contain sensitive information: review any export before sharing it.

Run `npm run test:logs` for paging, consistency, traversal, symlink, absence and size-bound checks.
## Content consistency

Cursor metadata is supplemented with a SHA-256 digest of the next page's bounded
read window. A same-size rewrite with an unchanged filesystem timestamp therefore
requires a refresh when that window changes. Each response reads at most three
64 KiB windows (the page, its next-page guard, and a consistency reread); the
returned page remains limited to 64 KiB and 150 complete lines. Older cursors
without a content digest also require a refresh. This guards the requested window,
not a durable snapshot of an entire file. Changes outside the guarded window are
detected by normal inode/size/timestamp checks when the filesystem reports them.

The similarity index fingerprints the full bounded tail it reads (at most 1 MiB
per file) and verifies it with a reread. Its incremental cache cannot mistake a
same-size, same-timestamp rewrite of that tail for unchanged content.
