"""Similarity search across all IRIS text logs with IRIS Vector Search.

Called by Embedded Python in Relay.LogReader. Every complete line from the current
logs, the numbered rotations and the archived messages.old_* files (newest first,
bounded) is embedded and stored in Relay.LogLine with a VECTOR(DOUBLE, 256) column.
Queries rank lines with VECTOR_COSINE in IRIS SQL.

The embedding is lexical, not a language model: words and character trigrams are
hashed into 256 dimensions and L2-normalized. It finds lines with similar wording
("licence limit exceeded" also finds "License limit was exceeded") with no model
download and no data leaving IRIS. Digits are folded so timestamps and process
IDs do not dominate the similarity.
"""
import hashlib
import json
import math
import os
import re
import stat
from datetime import datetime, timezone

DIMS = 256
MAX_BYTES_PER_FILE = 1048576
MAX_LINES_PER_FILE = 3000
MAX_LINES_TOTAL = 20000
MAX_QUERY = 200
MAX_RESULTS = 50
CANDIDATES = 200  # closest lines ranked by IRIS before grouping repeats
LINE = re.compile(r'^(\d+/\d+/\d+-[\d:]+)\s+\((\d+)\)\s+(\d+)\s+(.*)$')
WORD = re.compile(r'[a-z0-9_%$]+(?:\.[a-z0-9_%$]+)*')  # dotted names such as Utility.Event stay one word


def _bucket(feature):
    digest = hashlib.blake2b(feature.encode(), digest_size=8).digest()
    value = int.from_bytes(digest, 'big')
    return value % DIMS, (1.0 if (value >> 63) & 1 else -1.0)


def embed(text):
    """Deterministic lexical embedding, L2-normalized. Empty input gives a zero vector."""
    text = re.sub(r'\d+', '0', text.lower())
    vector = [0.0] * DIMS
    for word in WORD.findall(text):
        index, sign = _bucket('w:' + word)
        vector[index] += 2.0 * sign
        padded = '^' + word + '$'
        for i in range(len(padded) - 2):
            index, sign = _bucket('t:' + padded[i:i + 3])
            vector[index] += sign
    norm = math.sqrt(sum(v * v for v in vector))
    return [v / norm for v in vector] if norm else vector


def vector_text(vector):
    return ','.join('%.6f' % v for v in vector)


def _identity(info):
    return '%d:%d:%d:%d' % (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def tail_lines(path):
    """Newest complete lines of one file (bounded), oldest first, with their line numbers from the end."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('not a regular file')
        start = max(0, info.st_size - MAX_BYTES_PER_FILE)
        stream.seek(start)
        raw = stream.read(info.st_size - start)
        content_digest = hashlib.sha256(raw).hexdigest()
        if start:
            cut = raw.find(b'\n')
            raw = raw[cut + 1:] if cut >= 0 else b''
        lines = raw.splitlines(keepends=True)
        if lines and not lines[-1].endswith(b'\n'):
            lines.pop()  # a live writer may still be writing the last line
        final = os.fstat(stream.fileno())
        if _identity(final) != _identity(info):
            raise ValueError('changed while reading')
        stream.seek(start)
        if hashlib.sha256(stream.read(info.st_size - start)).hexdigest() != content_digest:
            raise ValueError('changed while reading')
    rows = []
    for line in lines[-MAX_LINES_PER_FILE:]:
        text = line.decode('utf-8', errors='replace').rstrip('\r\n')
        if not text.strip():
            continue
        match = LINE.match(text)
        row = {'Time': '', 'Pid': None, 'Level': None, 'Message': text[:2000]}
        if match:
            stamp, pid, level, message = match.groups()
            row.update(Time=stamp, Pid=int(pid), Level=int(level), Message=message[:2000])
        rows.append(row)
    return _identity(info) + ':' + content_digest, rows


def _sql(execute, query, *params):
    """Run one statement. None becomes SQL NULL (''), and 'no rows' (SQLCODE 100) is not an error."""
    try:
        return execute(query, *['' if value is None else value for value in params])
    except Exception as error:
        if getattr(error, 'sqlcode', None) == 100:
            return []
        raise


def sources(directory, log_reader):
    """Available files in reader order: current and numbered first, then archived newest first."""
    listed = log_reader.catalog(directory)['sources']
    return [s for s in listed if s['available']]


def refresh(directory, log_reader, execute):
    """Bring Relay.LogLine up to date. Unchanged files are skipped; changed files are replaced."""
    def sql(query, *params):
        return _sql(execute, query, *params)
    stored = {}
    for source, key in sql('SELECT DISTINCT %EXACT(Source), %EXACT(FileKey) FROM Relay.LogLine'):
        stored[source] = key
    budget, indexed, skipped, problems, seen = MAX_LINES_TOTAL, 0, 0, [], set()
    for source in sources(directory, log_reader):
        if budget <= 0:
            problems.append({'source': source['name'], 'status': 'Not indexed: total line limit reached'})
            continue
        path, name = log_reader.path_for(directory, source['id'])
        seen.add(name)
        try:
            key, rows = tail_lines(path)
        except (OSError, ValueError) as error:
            problems.append({'source': name, 'status': 'Not indexed: ' + str(error)})
            continue
        rows = rows[-budget:]
        if stored.get(name) == key + ':%d' % len(rows):
            budget -= len(rows)
            skipped += 1
            continue
        sql('DELETE FROM Relay.LogLine WHERE Source = ?', name)
        file_key = key + ':%d' % len(rows)
        for number, row in enumerate(rows):
            sql('INSERT INTO Relay.LogLine (Source, FileKey, LineNo, LineTime, LineLevel, Message, Embedding) '
                'VALUES (?, ?, ?, ?, ?, ?, TO_VECTOR(?, DOUBLE))',
                name, file_key, number, row['Time'], row['Level'], row['Message'], vector_text(embed(row['Message'])))
        indexed += len(rows)
        budget -= len(rows)
    for name in stored:
        if name not in seen:
            sql('DELETE FROM Relay.LogLine WHERE Source = ?', name)  # file rotated away or removed
    total = next(iter(sql('SELECT COUNT(*) FROM Relay.LogLine')))[0]
    files = next(iter(sql('SELECT COUNT(DISTINCT Source) FROM Relay.LogLine')))[0]
    return {'indexedLines': indexed, 'unchangedFiles': skipped, 'totalLines': total, 'files': files,
            'limits': {'bytesPerFile': MAX_BYTES_PER_FILE, 'linesPerFile': MAX_LINES_PER_FILE, 'linesTotal': MAX_LINES_TOTAL},
            'problems': problems, 'observedAt': datetime.now(timezone.utc).isoformat()}


def search(query, limit, execute):
    def sql(query_text, *params):
        return _sql(execute, query_text, *params)
    query = (query or '').strip()
    if not query or len(query) > MAX_QUERY:
        return {'error': 'Enter a search text of 1 to %d characters.' % MAX_QUERY}
    vector = embed(query)
    if not any(vector):
        return {'error': 'The search text has no words to compare.'}
    limit = max(1, min(int(limit), MAX_RESULTS))
    total = next(iter(sql('SELECT COUNT(*) FROM Relay.LogLine')))[0]
    if not total:
        return {'error': 'The log index is empty. Refresh the index first.'}
    # Rank the closest lines in IRIS, then group repeats of the same message pattern
    # (digits folded) so one result shows how often and where it occurred.
    groups = {}
    for source, number, when, level, message, score in sql(
            'SELECT TOP %d Source, LineNo, LineTime, LineLevel, Message, '
            'VECTOR_COSINE(Embedding, TO_VECTOR(?, DOUBLE)) AS Score '
            'FROM Relay.LogLine ORDER BY Score DESC' % CANDIDATES, vector_text(vector)):
        if float(score) <= 0:
            continue  # nothing in common with the query
        message = message or ''
        pattern = re.sub(r'\d+', '0', message.lower())
        group = groups.get(pattern)
        if group is None:
            if len(groups) >= limit:
                continue
            group = groups[pattern] = {'Score': round(float(score), 3), 'Message': message, 'Level': level,
                                       'Time': when or '', 'Source': source, 'Occurrences': 0, 'Files': [],
                                       'Contains': query.lower() in message.lower()}
        group['Occurrences'] += 1
        if source not in group['Files']:
            group['Files'].append(source)
    return {'query': query, 'indexedLines': total, 'candidates': CANDIDATES, 'rows': list(groups.values()),
            'observedAt': datetime.now(timezone.utc).isoformat(),
            'method': 'IRIS VECTOR_COSINE over lexical embeddings (hashed words and character trigrams, 256 dimensions)'}


def dumps(value):
    return json.dumps(value)
