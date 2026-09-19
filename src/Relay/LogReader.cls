Class Relay.LogReader Extends %RegisteredObject
{
/// Reads only the final 64 KiB and returns at most 150 complete log lines.
ClassMethod Tail(directory As %String) As %String [ Language = python ]
{
    import os
    import json
    import re
    from datetime import datetime, timezone
    path = os.path.join(directory, "messages.log")
    rows = []
    with open(path, "rb") as stream:
        size = os.fstat(stream.fileno()).st_size
        offset = max(0, size - 65536)
        stream.seek(offset)
        raw = stream.read(65536)
    lines = raw.decode("utf-8", errors="replace").splitlines()
    if offset and lines:
        lines = lines[1:]
    for line in lines[-150:]:
        if not line.strip():
            continue
        match = re.match(r"^(\d+/\d+/\d+-[\d:]+)\s+\((\d+)\)\s+(\d+)\s+(.*)$", line)
        if match:
            stamp, pid, level, message = match.groups()
            rows.append({"Time": stamp, "Pid": int(pid), "Level": int(level), "Message": message[:2000]})
        else:
            rows.append({"Time": "", "Pid": None, "Level": None, "Message": line[:2000]})
    return json.dumps({"source": "messages.log", "observedAt": datetime.now(timezone.utc).isoformat(), "byteLimit": 65536, "lineLimit": 150, "truncated": offset > 0 or len(lines) > 150, "rows": rows})
}
}
