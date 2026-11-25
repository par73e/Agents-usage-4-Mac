import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from backend.app import LogSync, export_snapshot
from backend.engine import Engine, QueryError
from backend.providers import antigravity, claude
from backend.providers.local import LocalProvider, count
from backend.registry import PROVIDER_LABELS, ProviderRegistry, RefreshFailed
from test_engine import context, usage

RANGE={'start':'2026-11-18T18:33','end':'2026-11-25T18:33','timezone':'Asia/Shanghai','granularity':'6h'}


def response(identifier,minute,**fields):
    """A Codex-schema row recorded at ``minute`` (UTC), with overrides."""
    instant=datetime.fromisoformat(minute.replace('Z','+00:00')).astimezone(timezone.utc)
    row={'response_id':identifier,'timestamp':instant.isoformat(),'timestamp_ms':int(instant.timestamp()*1000),
         'thread_id':'s1','turn_id':None,'model':'m1','effort':'high','compaction':False,'cache_known':True,
         'input_tokens':80,'cached_input_tokens':50,'output_tokens':20,'reasoning_output_tokens':5,'total_tokens':100,'title':'会话 s1','kind':'会话'}
    row.update(fields)
    return row


class FixedSource(LocalProvider):
    """A local source holding ready-made rows, as if they had just been read."""
    key='fixed'

    def __init__(self,rows):
        super().__init__();self.rows_given=rows

    def scan(self):
        return list(self.rows_given),1,{'unreadable_files':0}


def queried(rows,**changes):
    source=FixedSource(rows);source.refresh()
    return source.query({**RANGE,**changes})


class SharedQueryTest(unittest.TestCase):
    """Every platform resolves through one query path; these rules hold for all of them."""

    def test_each_row_is_counted_in_its_own_time_bin(self):
        # The range starts mid-bin, so bins differ in width and an even stride would misplace rows.
        local=['00:30','05:59','06:00','11:59','12:00','13:59','14:00','17:59','18:00','23:59']
        zone=ZoneInfo('Asia/Shanghai')
        rows=[response(f'r{i}',datetime(2026,11,23,int(h[:2]),int(h[3:]),tzinfo=zone).isoformat(),total_tokens=10*(i+1)) for i,h in enumerate(local)]
        result=queried(rows)
        # Bins carry the labels; the totals sit beside them in the same order.
        counted={bin_['label']:bucket['tokens'] for bin_,bucket in zip(result['bins'],result['total_buckets']) if bucket['tokens']}
        self.assertEqual(counted,{'11/23 00:00':30,'11/23 06:00':70,'11/23 12:00':260,'11/23 18:00':190})
        self.assertEqual(result['response_count'],len(rows))
        self.assertEqual((result['totals']['recorded_tokens'],result['totals']['estimated_tokens']),(550,0))

    def test_totals_name_the_recorded_and_estimated_parts(self):
        rows=[response('r1','2026-11-20T04:00:00Z'),response('r2','2026-11-20T05:00:00Z',cached_input_tokens=0,cache_known=False)]
        totals=queried(rows)['totals']
        self.assertEqual((totals['recorded_tokens'],totals['estimated_tokens'],totals['total_tokens']),(200,0,200))
        self.assertEqual((totals['input_tokens'],totals['cached_input_tokens'],totals['output_tokens'],totals['reasoning_output_tokens']),(160,50,40,10))
        for bucket in queried(rows)['models'][0]['buckets']:
            self.assertEqual(bucket['tokens'],bucket['cached']+bucket['uncached']+bucket['cache_unknown']+bucket['output'])

    def test_session_options_keep_recorded_titles_kinds_and_time_spans(self):
        rows=[response('r1','2026-11-20T04:00:00Z',thread_id='a',title='Fix login',kind='会话',project='app'),
              response('r2','2026-11-21T04:00:00Z',thread_id='a',title='Fix login',kind='会话',project='app',total_tokens=150),
              response('r3','2026-11-20T04:00:00Z',thread_id='b',title='任务 1c9e2f7a',kind='任务'),
              response('none','2026-11-20T04:00:00Z',thread_id='z',total_tokens=0)]
        options={o['id']:o for o in queried(rows)['options']}
        self.assertEqual(set(options),{'a','b'})
        self.assertEqual((options['a']['title'],options['a']['kind'],options['a']['project']),('Fix login','会话','app'))
        self.assertEqual((options['a']['tokens'],options['a']['responses']),(250,2))
        self.assertEqual((options['a']['first'],options['a']['latest']),('2026-11-20T04:00:00+00:00','2026-11-21T04:00:00+00:00'))
        self.assertEqual(options['b']['kind'],'任务')

    def test_compaction_switch_removes_identified_calls(self):
        rows=[response('plain','2026-11-20T04:00:00Z',thread_id='a'),response('pack','2026-11-20T04:10:00Z',thread_id='a',compaction=True),
              response('only','2026-11-20T04:20:00Z',thread_id='b',compaction=True)]
        self.assertEqual((queried(rows)['response_count'],len(queried(rows)['options'])),(3,2))
        without=queried(rows,include_compaction=False)
        self.assertEqual((without['response_count'],[o['id'] for o in without['options']]),(1,['a']))

    def test_stale_index_and_invalid_requests_are_rejected(self):
        source=FixedSource([response('r1','2026-11-20T04:00:00Z')]);source.refresh()
        for changes,message in [({'generation':'old'},'重新载入'),({'granularity':'2h'},'分组粒度'),({'end':RANGE['start']},'结束时间'),({'sessions':{'mode':'nope'}},'会话选择')]:
            with self.subTest(changes=changes),self.assertRaisesRegex(QueryError,message):source.query({**RANGE,**changes})

    def test_future_range_is_reported(self):
        result=queried([response('r1','2026-11-20T04:00:00Z')],end='2027-01-01T00:00',granularity='day')
        self.assertIn('区间包含未来时间，只统计已写入的记录。',result['warnings'])
        self.assertEqual(result['quota']['windows'],[])


def assistant(identifier,timestamp,**fields):
    """A transcript line as Claude Code writes it; the body must never reach the index."""
    message={'id':identifier,'model':'claude-test','role':'assistant','content':[{'type':'text','text':'SECRET BODY'}],
             'usage':{'input_tokens':10,'cache_read_input_tokens':200,'cache_creation_input_tokens':30,'output_tokens':40,'output_tokens_details':{'thinking_tokens':12}}}
    line={'type':'assistant','timestamp':timestamp,'sessionId':'session-a','cwd':'/Users/tester/work/app','isSidechain':False,'effort':'high','message':message}
    for key,value in fields.items():
        if key in ('model','usage') and value is not None:message[key]=value
        else:line[key]=value
    return line


class ClaudeCodeTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.project=self.root/'-Users-tester-work-app'

    def write(self,relative,events):
        path=self.project/relative;path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(''.join(json.dumps(event)+'\n' for event in events));return path

    def build(self):
        self.write('session-a.jsonl',[
            {'type':'ai-title','sessionId':'session-a','aiTitle':'Old auto title'},
            {'type':'last-prompt','sessionId':'session-a','lastPrompt':'SECRET PROMPT'},
            {'type':'ai-title','sessionId':'session-a','aiTitle':'Newer auto title'},
            {'type':'custom-title','sessionId':'session-a','customTitle':'  Renamed by user  '},
            {'type':'user','sessionId':'session-a','message':{'role':'user','content':'SECRET BODY'}},
            assistant('msg_1','2026-11-20T01:00:00Z'),assistant('msg_1','2026-11-20T01:00:05Z'),assistant('msg_1','2026-11-20T01:00:09Z'),
            assistant('msg_2','2026-11-20T02:00:00Z',effort='xhigh',usage={'input_tokens':5,'cache_creation_input_tokens':100,'output_tokens':7}),
            assistant('msg_notice','2026-11-20T02:30:00Z',model='<synthetic>',effort=None,usage={'input_tokens':0,'output_tokens':0})])
        self.write('session-a/subagents/agent-1.jsonl',[assistant('sub_1','2026-11-20T03:00:00Z',isSidechain=True,agentId='agent-1')])
        self.write('session-b.jsonl',[assistant('msg_b1','2026-11-21T03:00:00Z',effort='',sessionId='session-b')])
        self.provider=claude.Provider(self.root);self.provider.refresh()

    def rows(self):
        return {row['response_id']:row for row in self.provider.rows}

    def test_one_row_per_message_with_cache_read_as_the_cached_part(self):
        self.build();rows=self.rows()
        self.assertEqual(set(rows),{'msg_1','msg_2','sub_1','msg_b1'})
        first=rows['msg_1']
        # Three content blocks share one message: one row, kept at the moment the response began.
        self.assertEqual((first['timestamp'],first['thread_id'],first['model'],first['effort']),('2026-11-20T01:00:00+00:00','session-a','claude-test','high'))
        self.assertEqual((first['input_tokens'],first['cached_input_tokens'],first['output_tokens'],first['reasoning_output_tokens'],first['total_tokens']),(240,200,40,12,280))
        # Writing to the cache is not a cache hit.
        self.assertEqual((rows['msg_2']['input_tokens'],rows['msg_2']['cached_input_tokens'],rows['msg_2']['effort']),(105,0,'xhigh'))

    def test_titles_come_from_title_records_and_subagents_follow_their_session(self):
        self.build();rows=self.rows()
        self.assertEqual((rows['msg_1']['title'],rows['msg_1']['kind'],rows['msg_1']['project']),('Renamed by user','会话','app'))
        self.assertEqual((rows['sub_1']['thread_id'],rows['sub_1']['kind'],rows['sub_1']['title']),('agent-1','子代理','Renamed by user · 子代理'))
        # Without a title record a session is named by its id, and never by its prompt.
        self.assertEqual((rows['msg_b1']['title'],rows['msg_b1']['effort']),('会话 ession-b','unknown'))

    def test_conversation_text_never_enters_the_index_or_status(self):
        self.build()
        self.assertNotIn('SECRET',json.dumps(self.provider.snapshot(),ensure_ascii=False))
        self.assertNotIn('SECRET',json.dumps(export_snapshot(self.provider),ensure_ascii=False))

    def test_status_describes_the_source(self):
        self.build();status=self.provider.status
        self.assertEqual((status['provider'],status['record_count'],status['file_count'],status['session_kind'],status['capabilities']),('claude',4,3,'会话',[]))
        self.assertEqual((status['unknown_effort'],status['quota_record_count'],status['quota_latest'],status['scan']['untitled_sessions']),(1,0,None,1))
        self.assertEqual(status['generation'],self.provider.generation)

    def test_refresh_is_stable_until_a_transcript_changes(self):
        self.build();before=self.provider.generation
        self.provider.refresh();self.assertEqual(self.provider.generation,before)
        # A sub-agent's title follows its session when the session is renamed.
        with (self.project/'session-a.jsonl').open('a') as stream:
            stream.write(json.dumps({'type':'custom-title','sessionId':'session-a','customTitle':'Renamed again'})+'\n')
            stream.write(json.dumps(assistant('msg_3','2026-11-20T04:00:00Z'))+'\n')
        self.provider.refresh()
        self.assertNotEqual(self.provider.generation,before)
        rows=self.rows()
        self.assertEqual((len(rows),rows['sub_1']['title'],rows['msg_1']['title']),(5,'Renamed again · 子代理','Renamed again'))

    def test_unreadable_file_keeps_its_last_rows(self):
        self.build();before=list(self.provider.rows)
        (self.project/'session-b.jsonl').unlink();(self.project/'session-b.jsonl').mkdir()
        self.provider.refresh()
        self.assertEqual(self.provider.rows,before)
        self.assertEqual(self.provider.status['scan']['unreadable_files'],1)


def entry(identifier,at,model='Gemini 4 Hydrogen (High)',**fields):
    return {'id':identifier,'at':at,'model':model,'uncached':10,'cacheRead':100,'cacheWrite':20,'output':5,'partial':False,'timeBasis':'planner-created',**fields}


class AntigravityTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)

    def write(self,relative,data):
        path=self.root/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(data));return path

    def test_label_splits_only_into_a_known_effort(self):
        self.assertEqual(antigravity.split_label('Gemini 4 Hydrogen (XHigh)'),('Gemini 4 Hydrogen','xhigh'))
        self.assertEqual(antigravity.split_label('Orchestrator (Argon)'),('Orchestrator (Argon)','unknown'))
        self.assertEqual(antigravity.split_label('Gemini 4 Pro'),('Gemini 4 Pro','unknown'))
        self.assertEqual(antigravity.split_label(None),('unknown','unknown'))

    def test_each_record_file_is_one_task_and_cache_read_is_the_cached_part(self):
        self.write('acct-1/aaaa1111.json',{'schema':1,'account':'acct-1','records':[
            entry('r1',1795000000000),entry('r2',1795000600000,'Gemini 4 Hydrogen (XHigh)',uncached=None,partial=True),
            entry('r3',1795000700000,'Orchestrator (Argon)'),entry('r1',1795000800000)]})
        self.write('acct-1/backfill-v1.json',{'schema':1,'account':'acct-1','entries':{}})
        self.write('acct-2/aaaa1111.json',{'schema':1,'account':'acct-2','records':[entry('other',1795000000000)]})
        self.provider=antigravity.Provider(self.root);self.provider.refresh()
        rows={row['response_id']:row for row in self.provider.rows}
        self.assertEqual(set(rows),{'r1','r2','r3','other'})
        self.assertEqual((rows['r1']['model'],rows['r1']['effort'],rows['r1']['timestamp_ms']),('Gemini 4 Hydrogen','high',1795000800000))
        self.assertEqual((rows['r1']['input_tokens'],rows['r1']['cached_input_tokens'],rows['r1']['total_tokens']),(130,100,135))
        self.assertEqual((rows['r2']['input_tokens'],rows['r2']['effort']),(120,'xhigh'))
        self.assertEqual((rows['r3']['model'],rows['r3']['effort']),('Orchestrator (Argon)','unknown'))
        # The same file name under another account is another task.
        self.assertEqual((rows['other']['thread_id'],rows['r1']['thread_id']),('acct-2-aaaa1111','acct-1-aaaa1111'))
        self.assertEqual({(row['kind'],row['title']) for row in self.provider.rows},{('任务','任务 aaaa1111')})
        self.assertEqual((self.provider.status['session_kind'],self.provider.status['unknown_effort'],self.provider.status['scan']['partial_records']),('任务',1,1))

    def test_half_written_ledger_is_retried_not_dropped(self):
        self.write('acct-1/aaaa1111.json',{'schema':1,'account':'acct-1','records':[entry('r1',1795000000000)]})
        broken=self.root/'acct-1/bbbb2222.json';broken.write_text('{"schema":1,"account":"acct-1","records":[')
        self.provider=antigravity.Provider(self.root);self.provider.refresh()
        self.assertEqual(len(self.provider.rows),1);self.assertEqual(self.provider.status['scan']['unreadable_files'],1)
        self.write('acct-1/bbbb2222.json',{'schema':1,'account':'acct-1','records':[entry('r2',1795000000000)]})
        self.provider.refresh()
        self.assertEqual(len(self.provider.rows),2);self.assertNotIn('unreadable_files',self.provider.status['scan'])

    def test_missing_ledger_is_an_empty_source(self):
        self.provider=antigravity.Provider(self.root/'never-created');self.provider.refresh()
        self.assertEqual((self.provider.rows,self.provider.status['record_count'],self.provider.status['file_count']),([],0,0))
        self.assertEqual(self.provider.query(RANGE)['models'],[])


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        (self.root/'codex/sessions').mkdir(parents=True)
        (self.root/'codex/sessions/one.jsonl').write_text(json.dumps(context())+'\n'+json.dumps(usage())+'\n')
        (self.root/'claude').mkdir();(self.root/'pulse/acct').mkdir(parents=True)
        self.registry=ProviderRegistry(self.root/'codex',self.root/'index.sqlite',self.root/'claude',self.root/'pulse')
        self.registry.refresh()

    def test_identity_follows_any_single_source(self):
        before=self.registry.generation
        self.registry.refresh();self.assertEqual(self.registry.generation,before)
        self.assertEqual(self.registry.status['generation'],before)
        self.assertEqual(self.registry.status['record_count'],1)  # Codex, as existing readers expect
        codex=self.registry.engine('codex').generation
        (self.root/'claude/session-a.jsonl').write_text(json.dumps(assistant('msg_1','2026-11-20T01:00:00Z'))+'\n')
        self.registry.refresh()
        self.assertNotEqual(self.registry.generation,before)
        # An untouched source keeps its own identity, so its charts need no reload.
        self.assertEqual(self.registry.engine('codex').generation,codex)
        self.assertEqual(len(self.registry.engine('claude').rows),1)

    def test_query_resolves_through_the_selected_source(self):
        for name in ('codex','claude','antigravity'):
            self.assertEqual(self.registry.engine(name).query(RANGE)['provider'],name)
        with self.assertRaises(QueryError):self.registry.engine('cursor')

    def test_one_failing_source_does_not_stop_the_others(self):
        # Claude Code holds a row it read earlier; Anti Gravity gains one in the scan that fails.
        (self.root/'claude/session-a.jsonl').write_text(json.dumps(assistant('msg_1','2026-11-20T01:00:00Z'))+'\n')
        self.registry.refresh()
        claude=self.registry.engine('claude');before=claude.generation
        (self.root/'pulse/acct/task-1.json').write_text(json.dumps({'account':'acct','records':[entry('r1',1795000000000)]}))
        target=self.registry.engine('antigravity')
        with patch.object(claude,'refresh',side_effect=OSError('source locked')),patch.object(target,'refresh',wraps=target.refresh) as scanned:
            with self.assertRaises(RefreshFailed) as raised:self.registry.refresh()
        scanned.assert_called_once()
        # The error names the unreadable source and carries its reason.
        self.assertEqual(raised.exception.failures,{'claude':'source locked'})
        self.assertEqual(str(raised.exception),'Claude Code 的日志读取失败（source locked）')
        # A source that could not be read keeps the rows it last returned; the other keeps its new ones.
        self.assertEqual((claude.generation,len(claude.rows)),(before,1))
        self.assertEqual(len(target.rows),1)

    def test_status_names_every_source_a_scan_could_not_read(self):
        sync=LogSync(self.registry)
        self.assertEqual(sync.status()['refresh_failures'],{})
        with patch.object(self.registry.engine('codex'),'refresh',side_effect=OSError('disk busy')),patch.object(self.registry.engine('antigravity'),'refresh',side_effect=PermissionError('denied')):
            status=sync.scan()
        self.assertEqual(status['refresh_failures'],{'codex':'disk busy','antigravity':'denied'})
        self.assertEqual(status['refresh_error'],'Codex 的日志读取失败（disk busy）；Anti Gravity 的日志读取失败（denied）')
        # Both stay until a scan reads every source again.
        self.assertEqual(sync.status()['refresh_failures'],{'codex':'disk busy','antigravity':'denied'})
        self.assertIsNone(sync.scan()['refresh_error']);self.assertEqual(sync.status()['refresh_failures'],{})

    def test_labels_come_from_one_place(self):
        # The snapshot's platform names and the error text must not drift apart.
        from backend import app
        self.assertIs(app.PROVIDER_LABELS,PROVIDER_LABELS)

    def test_snapshot_carries_one_query_and_provenance_per_source(self):
        data=export_snapshot(self.registry)
        self.assertEqual({name:len(data['queries'][name]['rows']) for name in ('usage','claude_usage','antigravity_usage')},{'usage':1,'claude_usage':0,'antigravity_usage':0})
        required={'label','files','executedAt','metricDefinitions','caveats','evidenceFlow'}
        for name in ('claude_usage','antigravity_usage'):
            self.assertLessEqual(required,set(data['queries'][name]['source']))
            self.assertIn('不从 Token 用量换算额度',''.join(data['queries'][name]['source']['caveats']))
        self.assertEqual([(row['provider'],row['label']) for row in data['queries']['providers']['rows']],[('codex','Codex'),('claude','Claude Code'),('antigravity','Anti Gravity')])
        for row in data['queries']['providers']['rows']:
            self.assertEqual(json.loads(row['status_json'])['generation'],self.registry.engine(row['provider']).generation)
        self.assertEqual(data['queries']['index_state']['rows'][0]['generation'],self.registry.generation)

    def test_a_lone_codex_engine_keeps_its_snapshot_shape(self):
        engine=Engine(self.root/'codex',self.root/'lone.sqlite');engine.refresh()
        data=export_snapshot(engine)
        self.assertEqual(set(data['queries']),{'usage','legacy_usage','quota','providers','index_state'})
        self.assertEqual(data['queries']['index_state']['rows'][0]['generation'],engine.generation)
        self.assertEqual(engine.status['capabilities'],['legacy_history','quota_snapshots','compaction_filter'])

    def test_malformed_token_fields_count_as_zero(self):
        self.assertEqual([count(value) for value in (7,None,True,-5,2.5,'9')],[7,0,0,0,0,0])


if __name__=='__main__':
    unittest.main()
