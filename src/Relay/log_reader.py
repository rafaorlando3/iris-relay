"""Bounded, allowlisted IRIS text logs. Called by Embedded Python in Relay.LogReader."""
import base64
import json
import os
import re
import stat
from datetime import datetime, timezone

BYTE_LIMIT = 65536
LINE_LIMIT = 150
SOURCES = {'runtime': 'messages.log', 'console': 'cconsole.log', 'system-monitor': 'SystemMonitor.log', 'alerts': 'alerts.log'}

def error(message):
    return {'error': message}

def path_for(directory, source):
    # IDs, not browser supplied paths. Rotations are deliberately bounded.
    m = re.fullmatch(r'(runtime|console|system-monitor|alerts)(?:\.([1-3]))?', source)
    if not m:
        raise ValueError('Choose a listed log source.')
    name = SOURCES[m[1]] + ('.' + m[2] if m[2] else '')
    return os.path.join(directory, name), name

def catalog(directory):
    rows = []
    for source in SOURCES:
        for suffix in ['', '.1', '.2', '.3']:
            key = source + suffix
            path, name = path_for(directory, key)
            try:
                info = os.lstat(path)
                available = stat.S_ISREG(info.st_mode)
                if suffix and not available:
                    continue
                rows.append({'id': key, 'name': name, 'available': available, 'bytes': info.st_size if available else None, 'status': 'Available' if available else 'Not a regular file'})
            except FileNotFoundError:
                if not suffix:
                    rows.append({'id': key, 'name': name, 'available': False, 'bytes': None, 'status': 'Not present in this instance'})
            except OSError:
                rows.append({'id': key, 'name': name, 'available': False, 'bytes': None, 'status': 'Unavailable'})
    return {'sources': rows, 'byteLimit': BYTE_LIMIT, 'lineLimit': LINE_LIMIT}

def page(directory, source='runtime', cursor=''):
    try:
        path, name = path_for(directory, source)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                return error('Log source is not a regular file.')
            identity = [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]
            end = info.st_size
            if cursor:
                if len(cursor) > 1024:
                    return error('Invalid log cursor.')
                try:
                    c = json.loads(base64.urlsafe_b64decode(cursor.encode()))
                    if c['source'] != source or c['identity'] != identity:
                        return error('Log changed or rotated. Load latest before reading older records.')
                    end = c['offset']
                    if type(end) is not int or not 0 <= end <= info.st_size:
                        raise ValueError()
                except (ValueError, KeyError, TypeError):
                    return error('Invalid log cursor.')
            start = max(0, end - BYTE_LIMIT)
            stream.seek(start)
            raw = stream.read(end-start)
            truncated_line = False
            if start:
                cut = raw.find(b'\n')
                if cut < 0:
                    # Never render fragments as complete lines. Always progress.
                    raw = b''
                    truncated_line = True
                else:
                    raw = raw[cut+1:]
                    start += cut+1
            lines = raw.splitlines(keepends=True)
            # A live writer may not have terminated the last line yet.
            if lines and not lines[-1].endswith(b'\n'):
                end -= len(lines.pop())
            selected = lines[-LINE_LIMIT:]
            offset = end - sum(map(len, selected)) if selected else start
            if truncated_line:
                offset = start
            rows = []
            for line in selected:
                text = line.decode('utf-8', errors='replace').rstrip('\r\n')
                match = re.match(r'^(\d+/\d+/\d+-[\d:]+)\s+\((\d+)\)\s+(\d+)\s+(.*)$', text)
                row = {'Source': name, 'Time':'', 'Pid':None, 'Level':None, 'Message':text[:2000], 'MessageTruncated':len(text)>2000}
                if match:
                    stamp, pid, level, message = match.groups()
                    row.update(Time=stamp, Pid=int(pid), Level=int(level), Message=message[:2000], MessageTruncated=len(message)>2000)
                rows.append(row)
            # Do not present a changed file as a consistent page.
            final = os.fstat(stream.fileno())
            if [final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns] != identity:
                return error('Log changed while reading. Load latest again.')
        next_cursor = base64.urlsafe_b64encode(json.dumps({'source':source, 'identity':identity, 'offset':offset}).encode()).decode() if offset > 0 else None
        return {'source':name, 'observedAt':datetime.now(timezone.utc).isoformat(), 'byteLimit':BYTE_LIMIT, 'lineLimit':LINE_LIMIT, 'truncated':offset>0, 'longLineSkipped':truncated_line, 'nextCursor':next_cursor, 'rows':rows}
    except FileNotFoundError:
        return error('Log source is not present in this instance.')
    except (OSError, ValueError):
        return error('Log source unavailable or invalid.')
