# Log coverage and consistency

Relay 0.2 adds a text-log investigation workspace, alongside the existing asynchronous audit query, task history and journal file inventory.

| Source | Read boundary | Absence handling |
| --- | --- | --- |
| `messages.log` | Fixed file in the IRIS manager directory | Explicit unavailable error |
| `cconsole.log` | Fixed legacy console file | May not exist on current instances |
| `SystemMonitor.log` | Fixed System Monitor text file | Explicit unavailable error |
| `alerts.log` | Fixed alerts text file | May not exist until generated |
| Numbered rotations | `.1`, `.2`, `.3` of these four sources | Listed only when present |
| Audit | Management API background query; up to 100 summaries | Queued/running/finished/error states |
| Task history | Management API; up to 100 returned rows | Permissions and errors remain visible |
| Journal | File inventory only | Binary journal contents are not parsed |

The text reader is Embedded Python executed inside IRIS. Each page reads at most 64 KiB and returns at most 150 complete lines in chronological order. Older records uses a cursor tied to source, device, inode, size and modification time. If the file changes, including append or rotation, reload the latest page rather than mixing snapshots. A concurrent modification during the read also fails visibly.

The browser supplies a source ID, never a file path. Symbolic links and nonregular files are refused. Messages are capped at 2,000 characters and flagged when shortened. Oversized fragments are skipped with a visible flag. An unfinished final line appears only after its newline is written. Searching applies to the current page, not the entire file.

This is not universal coverage of every subsystem. Custom application paths, compressed rotations, Windows Event Log, journal record decoding and interoperability message bodies are not included. Manager-directory Linux instances are supported; ARM64 IRIS 2026.2 was exercised. Free-text logs may contain sensitive information: review any export before sharing it.

Run `npm run test:logs` for paging, consistency, traversal, symlink, absence and size-bound checks.
