"""Read-only Antigravity Pulse usage ledger parser."""
from __future__ import annotations
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import re
import sqlite3
from .local import LocalProvider, ParsedFiles, count

EFFORTS={'none','minimal','low','medium','high','xhigh','max','ultra'}
LABEL=re.compile(r'^(.*) \(([^()]*)\)$')
UTC=timezone.utc
DEFAULT_TITLES=Path('~/.gemini/antigravity/conversation_summaries.db')


class Titles:
    """The names of Anti Gravity's conversations, by the name of their ledger.

    Anti Gravity names a conversation's ledger after the SHA-256 of the
    conversation's id, and keeps the names in a store of its own. Only three
    columns are read there: the id, the name given to the conversation, and the
    id of the conversation it was started from. Previews and summaries that the
    store also holds are not read.

    The store is read again when it changes. One that cannot be read, because
    it is absent or busy, leaves the names last read in place.
    """
    def __init__(self,path=None):
        self.path=Path(path or DEFAULT_TITLES).expanduser()
        self.signature=None;self.names={};self.readable=False

    def read(self):
        """``{ledger name: (name, name of the parent's ledger or None)}``."""
        try:
            signature=tuple((p.stat().st_size,p.stat().st_mtime_ns) if p.exists() else None
                            for p in (self.path,self.path.with_name(self.path.name+'-wal')))
        except OSError:return self.names
        if signature==self.signature:return self.names
        rows=None
        # A store in write-ahead mode needs its shared-memory file to be read-only. Without it the store is
        # read as a file that does not change, which leaves out what is still waiting to be written in.
        for mode in ('ro','ro&immutable=1'):
            try:
                with closing(sqlite3.connect(f'{self.path.as_uri()}?mode={mode}',uri=True,timeout=2)) as store:
                    rows=store.execute('SELECT conversation_id,title,parent_conversation_id FROM conversation_summaries').fetchall()
                break
            except sqlite3.Error:continue
        if rows is None:return self.names
        by_id={conversation:(title.strip()[:100] if isinstance(title,str) else '',parent if isinstance(parent,str) else '')
               for conversation,title,parent in rows if isinstance(conversation,str)}
        digest=lambda text:hashlib.sha256(text.encode()).hexdigest()
        self.names={digest(conversation):(title,digest(parent) if parent else None) for conversation,(title,parent) in by_id.items()}
        self.signature=signature;self.readable=True
        return self.names


def split_label(label):
    """``"Gemini 4 Hydrogen (High)"`` becomes ``("Gemini 4 Hydrogen", "high")``.

    Only a known effort name is split. ``"Orchestrator (Argon)"`` stays whole with
    an unknown effort instead of being given one it does not state.
    """
    if not isinstance(label,str):return 'unknown','unknown'
    match=LABEL.match(label.strip())
    if match and match[2].lower() in EFFORTS:return match[1].strip(),match[2].lower()
    return label.strip() or 'unknown','unknown'


class Provider(LocalProvider):
    key='antigravity'
    session_kind='任务'

    def __init__(self, root=None, titles=None):
        super().__init__()
        self.root=(root or Path.home()/'.gemini/antigravity/sidecar_data/antigravity-pulse/panel/data/usage-v1').expanduser()
        self.files=ParsedFiles()
        self.titles=Titles(titles)

    def _name(self,ledger,names):
        """The name of one task: the name given to its conversation, or its parent's
        when it is a sub-agent's. ``None`` when the store has neither."""
        title,parent=names.get(ledger,('',None))
        if title:return title,self.session_kind
        parent_name=names.get(parent,('',None))[0] if parent else ''
        if parent_name:return parent_name+' · 子代理','子代理'
        return None

    def scan(self):
        rows=[];stats=Counter()
        paths=sorted(self.root.glob('*/*.json')) if self.root.is_dir() else []
        names=self.titles.read()
        for path in paths:
            result,fresh=self.files.parse(path,self._read)
            if not fresh:stats['unreadable_files']+=1
            if not result:continue
            # One record file is one task. Its name comes from Anti Gravity's own
            # list of conversations; a task missing there is told apart by its
            # identifier and time span.
            named=self._name(path.stem,names)
            if named:title,kind=named
            else:title,kind=f'任务 {path.stem[-8:]}',self.session_kind;stats['untitled_tasks']+=1
            for row in result['rows']:
                row['title']=title;row['kind']=kind
            rows.extend(result['rows'])
            stats['partial_records']+=result['partial']
        if paths and not self.titles.readable:stats['titles_unavailable']=1
        return rows,len(paths),stats

    def _read(self,path):
        data=json.loads(path.read_text())
        records=data.get('records') if isinstance(data,dict) else None
        if not isinstance(records,list):return None  # e.g. backfill-v1.json is sync state, not a ledger
        account=data.get('account')
        # Record ids are unique within an account; scope them so accounts never merge.
        thread=f'{account[:8]}-{path.stem}' if isinstance(account,str) and account else path.stem
        rows={};partial=0
        for item in records:
            if not isinstance(item,dict):continue
            at=item.get('at')
            if isinstance(at,bool) or not isinstance(at,(int,float)):continue
            plain=count(item.get('uncached'));read=count(item.get('cacheRead'))
            created=count(item.get('cacheWrite'));output=count(item.get('output'))
            total=plain+read+created+output
            if total<=0:continue
            model,effort=split_label(item.get('model'))
            instant=datetime.fromtimestamp(at/1000,UTC)
            identifier=str(item['id']) if item.get('id') is not None else f'{thread}:{at}'
            # A cache write is not a cache hit: only tokens read from cache count as cached.
            rows[identifier]={'response_id':identifier,'timestamp':instant.isoformat(),'timestamp_ms':int(instant.timestamp()*1000),
                              'thread_id':thread,'turn_id':None,'model':model,'effort':effort,
                              'input_tokens':plain+read+created,'cached_input_tokens':read,'output_tokens':output,
                              'reasoning_output_tokens':0,'total_tokens':total,'compaction':False,'cache_known':True}
            partial+=bool(item.get('partial'))
        return {'rows':list(rows.values()),'partial':partial}
