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

The text reader is Embedded Python executed inside IRIS. Each page reads at most 64 KiB and returns at most 150 complete lines in chronological order. Older records uses a cursor tied to source, device, inode, size and modification time. If the file changes, including append or rotation, reload the latest page rather than mixing snapshots. A concurrent modification during the read also fails visibly.

## Archived rotations (0.3)

When `messages.log` grows beyond `MaxConsoleLogSize`, IRIS renames it and starts a new file. On IRIS 2026.2 we observed `messages.old_20260928`, then `messages.old_20260928_1` for a second rotation on the same day. The Management Portal shows only the current file; Relay lists these archived files by name, size and last-write time, and reads them with the same paging, search and consistency rules as the current log.

Archived IDs look like `runtime.old_20260928_1`. The suffix may contain only letters, digits, `_` and `-` (at most 48 characters), so an ID cannot contain a path separator or a dot. Symbolic links and special files are neither listed nor read. Compressed files such as `messages.old_20260926.gz` are not listed. Only the newest 24 archived files are offered in the selector; the catalog reports how many older ones were omitted.

To see a real rotation in the disposable lab, run `python3 scripts/lab-rotate-log.py`. It lowers `MaxConsoleLogSize` (a `[Startup]` setting, in MB) to 1, restarts the lab container, writes labelled lines until IRIS creates a new `messages.old_*` file (about one minute), then restores the original value and restarts again. It acts only on the container that `scripts/lab.py` recorded in `artifacts/lab-setup.json` (same name and container ID, pinned image, IRIS published only on 127.0.0.1 at the recorded port) and refuses anything else before changing a setting or restarting. The original value is restored even if a later step fails. Labs created before 0.3 have no record: run `python3 scripts/lab.py` once, which records the container it already manages.

The browser supplies a source ID, never a file path. Symbolic links and nonregular files are refused. Messages are capped at 2,000 characters and flagged when shortened. Oversized fragments are skipped with a visible flag. An unfinished final line appears only after its newline is written. Searching applies to the current page, not the entire file.

This is not universal coverage of every subsystem. Custom application paths, compressed rotations, Windows Event Log, journal record decoding and interoperability message bodies are not included. Manager-directory Linux instances are supported; IRIS 2026.2 was exercised on ARM64 and x86-64 containers. Free-text logs may contain sensitive information: review any export before sharing it.

Run `npm run test:logs` for paging, consistency, traversal, symlink, absence and size-bound checks.
