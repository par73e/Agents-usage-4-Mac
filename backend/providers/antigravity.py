"""Read-only Antigravity Pulse usage ledger parser."""
from __future__ import annotations
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import json
import re
from .local import LocalProvider, ParsedFiles, count

EFFORTS={'none','minimal','low','medium','high','xhigh','max','ultra'}
LABEL=re.compile(r'^(.*) \(([^()]*)\)$')
UTC=timezone.utc


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

    def __init__(self, root=None):
        super().__init__()
        self.root=(root or Path.home()/'.gemini/antigravity/sidecar_data/antigravity-pulse/panel/data/usage-v1').expanduser()
        self.files=ParsedFiles()

    def scan(self):
        rows=[];stats=Counter()
        paths=sorted(self.root.glob('*/*.json')) if self.root.is_dir() else []
        for path in paths:
            result,fresh=self.files.parse(path,self._read)
            if not fresh:stats['unreadable_files']+=1
            if not result:continue
            # The ledger has no task titles; one record file is one task, told
            # apart by its identifier and time span.
            title=f'任务 {path.stem[-8:]}'
            for row in result['rows']:
                row['title']=title;row['kind']=self.session_kind
            rows.extend(result['rows'])
            stats['partial_records']+=result['partial']
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
