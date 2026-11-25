"""Read-only Claude Code transcript parser. Conversation text is never retained."""
from __future__ import annotations
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import json
import re
from .local import LocalProvider, ParsedFiles, count

IDENTIFIER=re.compile(r'[a-z][a-z0-9_-]{0,15}')
TITLE_FIELDS={'custom-title':'customTitle','ai-title':'aiTitle'}
UTC=timezone.utc


def reasoning_effort(value):
    """The effort a request was sent with; an unparsable value stays unknown."""
    if isinstance(value,str) and IDENTIFIER.fullmatch(value.lower()):return value.lower()
    return 'unknown'


def project_name(cwd):
    """Sessions of different projects share auto-generated titles; name the project."""
    return Path(cwd).name if isinstance(cwd,str) and Path(cwd).name else None


class Provider(LocalProvider):
    key='claude'

    def __init__(self, root=None):
        super().__init__()
        self.root=(root or Path.home()/'.claude/projects').expanduser()
        self.files=ParsedFiles()

    def scan(self):
        rows=[];stats=Counter();parsed={}
        paths=sorted(self.root.rglob('*.jsonl')) if self.root.is_dir() else []
        for path in paths:
            result,fresh=self.files.parse(path,self._read)
            if not fresh:stats['unreadable_files']+=1
            if result is None:continue
            parsed[path]=result
        # A sub-agent transcript lives under its session and carries the session's
        # id, so the file name is the only stable handle for the sub-agent itself.
        titles={path.stem:result['title'] for path,result in parsed.items() if path.parent.name!='subagents' and result['title']}
        for path,result in parsed.items():
            subagent=path.parent.name=='subagents'
            session=path.parent.parent.name if subagent else path.stem
            title=titles.get(session)
            if not title and not subagent:stats['untitled_sessions']+=1
            title=title or f'会话 {session[-8:]}'
            for row in result['rows']:
                row['title']=title+' · 子代理' if subagent else title
                row['kind']='子代理' if subagent else '会话'
                row['project']=result['project']
            rows.extend(result['rows'])
        return rows,len(paths),stats

    def _read(self,path):
        """Usage rows of one transcript with its title and project; message text is dropped here."""
        rows={};titles={};project=None
        with path.open(errors='replace') as stream:
            for line in stream:
                try:event=json.loads(line)
                except ValueError:continue  # an appended line may still be incomplete
                if not isinstance(event,dict):continue
                if project is None:project=project_name(event.get('cwd'))
                kind=event.get('type')
                if kind in TITLE_FIELDS:
                    name=event.get(TITLE_FIELDS[kind])
                    # Titles are rewritten as a session evolves, so the last record wins.
                    if isinstance(name,str) and name.strip():titles[kind]=name.strip()[:100]
                    continue
                message=event.get('message') if kind=='assistant' else None
                row=self._usage(message,event,path.stem) if isinstance(message,dict) else None
                # One message is written once per content block with the same usage;
                # the first record carries when the response began.
                if row and row['response_id'] not in rows:rows[row['response_id']]=row
        return {'rows':list(rows.values()),'title':titles.get('custom-title') or titles.get('ai-title'),'project':project}

    def _usage(self,message,event,thread_id):
        usage=message.get('usage');identifier=message.get('id')
        if not isinstance(usage,dict) or not isinstance(identifier,str):return None
        try:instant=datetime.fromisoformat(event['timestamp'].replace('Z','+00:00'))
        except (ValueError,TypeError,KeyError,AttributeError):return None
        if instant.tzinfo is None:return None
        instant=instant.astimezone(UTC)
        details=usage.get('output_tokens_details') if isinstance(usage.get('output_tokens_details'),dict) else {}
        plain=count(usage.get('input_tokens'));read=count(usage.get('cache_read_input_tokens'))
        created=count(usage.get('cache_creation_input_tokens'));output=count(usage.get('output_tokens'))
        total=plain+read+created+output
        if total<=0:return None  # client-side notices carry no usage and are not responses
        return {'response_id':identifier,'timestamp':instant.isoformat(),'timestamp_ms':int(instant.timestamp()*1000),
                'thread_id':thread_id,'turn_id':None,'model':message.get('model') or 'unknown','effort':reasoning_effort(event.get('effort')),
                # A cache write is not a cache hit: only tokens read from cache count as cached.
                'input_tokens':plain+read+created,'cached_input_tokens':read,'output_tokens':output,
                'reasoning_output_tokens':count(details.get('thinking_tokens')),'total_tokens':total,'compaction':False,'cache_known':True}
