"""Bounded, allowlisted IRIS text logs. Called by Embedded Python in Relay.LogReader."""
import base64
import hashlib
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

# Archived rotations use IRIS names such as messages.old_20260928. The suffix
# alphabet excludes separators and dots, so an ID can never leave the directory.
ARCHIVE_SOURCES = {'runtime': 'messages', 'console': 'cconsole'}
ARCHIVE_NAME = re.compile(r'(messages|cconsole)\.old_([0-9A-Za-z_-]{1,48})')
ARCHIVE_ID = re.compile(r'(runtime|console)\.old_([0-9A-Za-z_-]{1,48})')
ARCHIVE_LIMIT = 24

def path_for(directory, source):
    # IDs, not browser supplied paths. Rotations are deliberately bounded.
    archived = ARCHIVE_ID.fullmatch(source)
    if archived:
        name = ARCHIVE_SOURCES[archived[1]] + '.old_' + archived[2]
        return os.path.join(directory, name), name
    m = re.fullmatch(r'(runtime|console|system-monitor|alerts)(?:\.([1-3]))?', source)
    if not m:
        raise ValueError('Choose a listed log source.')
    name = SOURCES[m[1]] + ('.' + m[2] if m[2] else '')
    return os.path.join(directory, name), name

def archived(directory):
    """Regular messages.old_* / cconsole.old_* files, newest first, bounded."""
    found = []
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return [], 0, 'Unavailable'
    prefix = {v: k for k, v in ARCHIVE_SOURCES.items()}
    for entry in entries:
        m = ARCHIVE_NAME.fullmatch(entry.name)
        if not m:
            continue
        try:
            info = os.lstat(os.path.join(directory, entry.name))
        except OSError:
            continue
        if not stat.S_ISREG(info.st_mode):
            continue  # symbolic links and special files are never offered
        found.append({'id': prefix[m[1]] + '.old_' + m[2], 'name': entry.name, 'available': True,
                      'bytes': info.st_size, 'status': 'Archived rotation', 'archived': True,
                      'modified': datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(),
                      '_order': (info.st_mtime_ns, entry.name)})
    found.sort(key=lambda r: r['_order'], reverse=True)
    for row in found:
        del row['_order']
    return found[:ARCHIVE_LIMIT], max(0, len(found) - ARCHIVE_LIMIT), None

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
    old, omitted, problem = archived(directory)
    result = {'sources': rows + old, 'byteLimit': BYTE_LIMIT, 'lineLimit': LINE_LIMIT,
              'archiveLimit': ARCHIVE_LIMIT, 'archivedOmitted': omitted}
    if problem:
        result['archiveStatus'] = problem
    return result

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
            window_start, window_end = start, end
            stream.seek(start)
            raw = stream.read(end-start)
            page_digest = hashlib.sha256(raw).hexdigest()
            if cursor and c.get('fingerprint') != page_digest:
                return error('Log content changed. Load latest before reading older records.')
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
            # Filesystems can coalesce timestamps for fast same-size rewrites.
            # Guard the next bounded window, not only the inode/stat metadata.
            next_digest = None
            if offset > 0:
                next_start = max(0, offset - BYTE_LIMIT)
                stream.seek(next_start)
                next_digest = hashlib.sha256(stream.read(offset-next_start)).hexdigest()
            stream.seek(window_start)
            if hashlib.sha256(stream.read(window_end-window_start)).hexdigest() != page_digest:
                return error('Log changed while reading. Load latest again.')
            final = os.fstat(stream.fileno())
            if [final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns] != identity:
                return error('Log changed while reading. Load latest again.')
        next_cursor = base64.urlsafe_b64encode(json.dumps({'source':source, 'identity':identity, 'offset':offset, 'fingerprint':next_digest}).encode()).decode() if offset > 0 else None
        return {'source':name, 'observedAt':datetime.now(timezone.utc).isoformat(), 'byteLimit':BYTE_LIMIT, 'lineLimit':LINE_LIMIT, 'truncated':offset>0, 'longLineSkipped':truncated_line, 'nextCursor':next_cursor, 'rows':rows}
    except FileNotFoundError:
        return error('Log source is not present in this instance.')
    except (OSError, ValueError):
        return error('Log source unavailable or invalid.')
