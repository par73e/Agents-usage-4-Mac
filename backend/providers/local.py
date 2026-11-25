"""Base for local sources whose rows follow the Codex usage schema."""
from __future__ import annotations
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import threading
import time
from ..engine import query_usage

UTC=timezone.utc


def generation_of(key,rows):
    """Content identity of a row set; an unchanged source keeps its value."""
    return f'{key}-'+hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest()[:16]


def count(value):
    """Token fields are integers; anything missing or malformed counts as zero."""
    return value if isinstance(value,int) and not isinstance(value,bool) and value>0 else 0


class ParsedFiles:
    """Remembers each file's parse result while its size and modification time hold.

    A file that cannot be read keeps its last readable result instead of
    vanishing from the index, and is retried on every scan until it reads again.
    """
    def __init__(self):
        self.entries={}

    def parse(self,path,reader):
        """Return ``(result, fresh)`` for ``path``.

        ``result`` is the reader's output. ``fresh`` is ``False`` when the file
        could not be read now: ``result`` is then the last readable one, or
        ``None`` if there never was one.
        """
        key=str(path)
        try:
            stat=path.stat();signature=(stat.st_ino,stat.st_size,stat.st_mtime_ns)
        except OSError:return self._previous(key)
        cached=self.entries.get(key)
        if cached and cached[0]==signature:return cached[1],True
        try:result=reader(path)
        except (OSError,ValueError):return self._previous(key)
        self.entries[key]=(signature,result);return result,True

    def _previous(self,key):
        cached=self.entries.get(key)
        return (cached[1],False) if cached else (None,False)


class LocalProvider:
    """One local source, read into Codex-shaped rows and queried exactly like Codex.

    ``scan`` returns ``(rows, file_count, scan_stats)`` and never writes to the
    source. The shared query path reads ``lock``, ``generation``, ``rows``,
    ``legacy_rows``, ``quota_rows``, ``status``, ``key`` and ``session_kind``.
    """
    key='local';session_kind='会话';capabilities=()

    def __init__(self):
        self.lock=threading.RLock()
        self.rows=[];self.quota_rows=[];self.legacy_rows=[];self.status={};self.generation=''

    def scan(self):
        raise NotImplementedError

    def refresh(self):
        with self.lock:
            began=time.monotonic()
            rows,files,stats=self.scan()
            self.rows=sorted(rows,key=lambda row:(row['timestamp_ms'],row['response_id']))
            self.generation=generation_of(self.key,self.rows)
            self.status={'generation':self.generation,'provider':self.key,'updated_at':datetime.now(UTC).isoformat(),
                         'record_count':len(self.rows),'file_count':files,
                         'first':self.rows[0]['timestamp'] if self.rows else None,'latest':self.rows[-1]['timestamp'] if self.rows else None,
                         'unknown_model':sum(r['model']=='unknown' for r in self.rows),'unknown_effort':sum(r['effort']=='unknown' for r in self.rows),
                         'session_kind':self.session_kind,'capabilities':list(self.capabilities),
                         # No local source for these exists; the page says so rather than estimating.
                         'quota_record_count':0,'quota_first':None,'quota_latest':None,
                         'index_coverage':{'available':False,'missing_log_files':0},'scan':dict(stats),'scan_seconds':round(time.monotonic()-began,3)}
            return self.status.copy()

    def snapshot(self):
        with self.lock:return {'status':self.status.copy(),'rows':list(self.rows),'quota_rows':list(self.quota_rows),'legacy_rows':list(self.legacy_rows)}

    def query(self,body):
        return query_usage(self,body)
