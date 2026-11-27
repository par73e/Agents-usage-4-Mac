"""Loopback-only API and static dashboard host; no third-party packages."""
from __future__ import annotations
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import argparse
import functools
import json
import os
import re
import subprocess
import threading
from datetime import datetime, timezone
from urllib.parse import urlparse
from .engine import QueryError
from .registry import PROVIDER_LABELS, ProviderRegistry

PROJECT=Path(__file__).resolve().parents[1]
PLUGIN_CACHE=Path.home()/'.codex/plugins/cache/openai-curated-remote/data-analytics'
NODE=Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
APP_ID='local-codex-usage-20261026'

def find_dashboard_builder(cache=PLUGIN_CACHE):
    """Plugin updates replace version directories; resolve a usable installed builder."""
    candidates=[]
    for path in cache.glob('*/scripts/data-app.mjs'):
        version=re.match(r'^(\d+)\.(\d+)\.(\d+)',path.parent.parent.name)
        if version and path.is_file():candidates.append((tuple(map(int,version.groups())),path.stat().st_mtime_ns,path))
    for path in cache.glob('*/output_formats/html/scripts/data-app.mjs'):
        version=re.match(r'^(\d+)\.(\d+)\.(\d+)',path.parent.parent.parent.parent.name)
        if version and path.is_file():
            candidates.append((tuple(map(int,version.groups())),path.stat().st_mtime_ns,path))
    if not candidates:
        raise RuntimeError('未找到已安装的 Data 前端构建工具。已有页面时可用 --skip-build 启动。')
    return max(candidates,key=lambda item:item[:2])[2]

BUCKETING='将所选时区的起止分钟转为 UTC，按 [start,end) 筛选，并按所选时区的自然小时、6小时、12小时或日历日分桶。'


def local_source(key,status):
    """Provenance of a non-Codex local source, shown by the page's source inspector."""
    stamp=status['updated_at']
    if key=='claude':
        return {'label':'本机 Claude Code 会话记录','files':[{'label':'~/.claude/projects/**/*.jsonl'}],'executedAt':stamp,
                'metricDefinitions':[
                    {'label':'总 Token','definition':'每个唯一 message.id 的输入 + 输出。输入 = 未缓存输入 + 缓存读取 + 缓存写入；输出已包含思考 Token。'},
                    {'label':'推理强度占比','definition':'当前模型、当前时间范围和所选会话中，各强度总 Token 除以本模型总 Token；强度取自该条助手消息的请求配置，包含未知强度。'}],
                'caveats':['仅覆盖本机保留的会话记录；已删除或未落盘的会话不在其中，历史缺失不补零。',
                           '同一消息的每条内容块记录用量相同，按 message.id 去重，时间取该消息首次出现的时刻。',
                           '缓存命中只计缓存读取；缓存写入按未命中缓存的输入计。',
                           '模型和推理强度取自会话记录（响应的模型字段与请求的 effort 配置），不能独立证明服务端实际路由。',
                           '记录不含账户额度快照，不从 Token 用量换算额度。'],
                'evidenceFlow':[{'kind':'source','title':'读取来源','detail':'只读扫描 ~/.claude/projects 下的会话与子代理记录。标题来自会话的 custom-title / ai-title 标题记录，对话正文和凭据不进入本页面。'},
                                {'kind':'method','title':'时间与分组','detail':BUCKETING}]}
    return {'label':'本机 Antigravity Pulse 用量台账','files':[{'label':'~/.gemini/antigravity/sidecar_data/antigravity-pulse/panel/data/usage-v1/**/*.json'}],'executedAt':stamp,
            'metricDefinitions':[
                {'label':'总 Token','definition':'每条台账记录的 uncached + cacheRead + cacheWrite + output，按记录 id 去重。'},
                {'label':'推理强度占比','definition':'各强度总 Token 除以本模型总 Token，包含未知强度。模型与强度拆自台账的模型标签，如 "Gemini 4 Hydrogen (High)"；括号内不是已知强度名称时保留原标签并记为未知强度。'}],
            'caveats':['仅覆盖本机 Pulse 台账留存的记录，历史缺失不补零。',
                       '缓存命中只计缓存读取；缓存写入按未命中缓存的输入计。',
                       '模型和推理强度来自台账的模型标签，不能独立证明服务端实际路由。',
                       '时间取台账记录自带的时间戳（timeBasis=planner-created）；台账不记录响应完成的时刻，也不提供推理 Token 明细。',
                       '每个记录文件是一个任务；任务名取自 Anti Gravity 的对话列表，列表里没有的以任务编号显示。',
                       '台账标记为不完整（partial）的记录照常计入，缺失的分项按 0 计，这些记录的用量可能偏低。',
                       '台账不含账户额度快照，不从 Token 用量换算额度。'],
            'evidenceFlow':[{'kind':'source','title':'读取来源','detail':'只读扫描 Antigravity Pulse 的 usage-v1 台账，每个记录文件视为一个任务，不含同步状态文件；任务名取自 Anti Gravity 的对话列表，只读对话 ID、名字和父对话 ID。'},
                            {'kind':'method','title':'时间与分组','detail':BUCKETING}]}

def export_snapshot(registry, write=False):
    if hasattr(registry,'engines'):
        provider_snapshots={name:engine.snapshot() for name,engine in registry.engines.items()}
        codex=provider_snapshots['codex']
    else:
        provider_snapshots={'codex':registry.snapshot()}
        codex=provider_snapshots['codex']
    status=codex['status']
    source={'label':'本机 Codex 响应日志','files':[{'label':'sessions/**/*.jsonl / *.jsonl.zst'},{'label':'archived_sessions/**/*.jsonl / *.jsonl.zst'}],
            'executedAt':status['updated_at'],'metricDefinitions':[
                {'label':'总 Token','definition':'每个唯一 response_id 的 input_tokens + output_tokens。缓存输入已包含在输入中，推理输出已包含在输出中。'},
                {'label':'推理强度占比','definition':'当前模型、当前时间范围和所选会话中，各强度总 Token 除以本模型总 Token；包含未知强度。'}],
            'caveats':['仅覆盖本机现存日志（含 Zstandard 压缩存档），历史缺失不补零。','逐响应明细与旧累计区间估算分开保存；旧区间不猜测模型、强度或响应次数。','模型和推理强度来自该轮次的日志配置，不能独立证明服务端实际路由。','每次响应整体按记录时间归属，不能拆分跨边界响应。'],
            'evidenceFlow':[{'kind':'source','title':'读取来源','detail':'只读扫描 sessions 与 archived_sessions；以 response_id 去重。标题来自只读聊天索引，正文和凭据不进入本页面。'},
                            {'kind':'method','title':'时间与分组','detail':'将所选时区的起止分钟转为 UTC，按 [start,end) 筛选。按所选时区的自然小时、6小时、12小时或日历日分桶。'}]}
    existing=PROJECT/'web/src/data.json'
    stable_id=json.loads(existing.read_text()).get('id',APP_ID) if existing.exists() else APP_ID
    data={'id':stable_id,'surface':'dashboard','title':'Agent Usage','status':'observed','buildStatus':'complete','generatedAt':status['updated_at'],'localUsage':True,'filters':[],
          'queries':{'usage':{'rows':codex['rows'],'source':source},
                     'legacy_usage':{'rows':codex['legacy_rows'],'source':{
                         'label':'旧日志累计用量区间','files':source['files'],'executedAt':status['updated_at'],
                         'metricDefinitions':[{'label':'区间估算','definition':'相邻累计读数之差；首条读数从会话创建时间开始。按时长作整数累计分摊，跨桶或部分查询时保留总量。'}],
                         'caveats':['只有逐响应明细出现之前的累计快照可补入；重复快照去重。同一时间多条累计值取最大观测读数，标记为粗时间记录，不能还原内部时序。',
                                    '区间内不代表均匀实际消耗，分桶数值是时间分配估算；无创建时间时起点标为未知，按观测区间展示。',
                                    '旧累计无法可靠识别上下文压缩，开关仅影响已识别的逐响应压缩调用。',
                                    '未把未知模型或推理强度补成当前配置，不推算响应次数。'],
                         'evidenceFlow':[{'kind':'method','title':'累计快照差分','detail':'以会话与观测时间去重累计读数，保留起止观测、累计重置标记和区间总量。与查询区间交集按时长分摊，原始区间可检查。'}]}},
                     'quota':{'rows':codex['quota_rows'],'source':{'label':'本机 Codex 账户额度快照','files':source['files'],'executedAt':status['updated_at'],
                         'metricDefinitions':[{'label':'剩余额度','definition':'100 − 日志 rate_limits.used_percent；按额度桶、primary/secondary 和窗口长度分别展示。不是 Token 的换算结果。'},
                                              {'label':'额度恢复','definition':'相邻观测已用比例下降至少 10 个百分点，或下降至少 5 个百分点并报告已用 0%；标记观测区间，不声称重置原因。'}],
                         'caveats':['账户额度不按模型或会话分摊。日志未必覆盖同一账户的所有设备；日志不含可靠账户身份，切换账户可能造成变化。',
                                    '只保存额度和时间字段，不保存 credits 余额、认证信息或日志正文。',
                                    '超过 15 分钟无快照时不推算中间的百分比；缺失背景可开关。恢复标记不是服务端重置事件。'],
                         'evidenceFlow':[{'kind':'source','title':'只读额度记录','detail':'读取 event_msg/token_count 的 rate_limits，按快照内容去重。同一窗口同一时刻的冲突百分比排除。'}]}},
                     'providers':{'rows':[{'provider':name,'label':PROVIDER_LABELS.get(name,name),'status_json':json.dumps(snapshot['status'],ensure_ascii=False)} for name,snapshot in provider_snapshots.items()],'payloadColumns':['provider','label','status_json'],'source':{'label':'多智能体本地索引','files':[{'label':'Codex / Claude / Antigravity 本地日志'}],'executedAt':status['updated_at']}}}}
    # Each source carries its own rows and provenance so the page can inspect any of them.
    for key in ('claude','antigravity'):
        if key in provider_snapshots:
            snapshot=provider_snapshots[key]
            data['queries'][key+'_usage']={'rows':snapshot['rows'],'source':local_source(key,snapshot['status'])}
    # One identity for every source: the page re-reads all rows when any of them changes.
    identity=getattr(registry,'generation',status['generation'])
    index_status=getattr(registry,'status',status)
    data['queries']['index_state']={'rows':[{'generation':identity,'status_json':json.dumps(index_status,ensure_ascii=False)}],'payloadColumns':['status_json'],'source':{'label':'本地索引状态','files':[{'label':'本地派生索引'}],'executedAt':status['updated_at']}}
    path=PROJECT/'web/src/data.json'
    if write and path.parent.exists():path.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
    return data

def build_dashboard(engine):
    builder=find_dashboard_builder()
    export_snapshot(engine,write=True)
    result=subprocess.run([str(NODE),str(builder),'build','--project-dir',str(PROJECT/'web'),'--source'],cwd=PROJECT,capture_output=True,text=True)
    if result.returncode:raise RuntimeError('页面构建失败：'+result.stderr[-1500:]+result.stdout[-1000:])

class LogSync:
    """One background scanner per server; manual requests share the same lock.

    Only complete appended JSONL lines are indexed. A failed scan preserves the
    last readable rows of every source that could not be read; sources that were
    read keep their new rows. No frontend builds here.
    """
    def __init__(self,engine,interval=2):
        self.engine=engine;self.interval=interval;self.lock=threading.RLock()
        self.stop_event=threading.Event();self.thread=None;self.refreshing=False
        self.error=None;self.failures={};self.checked_at=None;self.cached_generation=None;self.cached_snapshot=None

    def scan(self):
        with self.lock:
            self.refreshing=True
            try:
                self.engine.refresh();self.error=None;self.failures={}
            except Exception as exc:
                self.error=str(exc);self.failures=dict(getattr(exc,'failures',None) or {})
            finally:
                self.checked_at=datetime.now(timezone.utc).isoformat();self.refreshing=False
            return self.status()

    def status(self):
        with self.engine.lock:
            # ``refresh_failures`` names the sources the last scan could not read.
            return {**self.engine.status,'refreshing':self.refreshing,'refresh_error':self.error,'refresh_failures':dict(self.failures),
                    'checked_at':self.checked_at,'auto_sync':bool(self.thread and self.thread.is_alive()),'poll_interval':self.interval}

    def snapshot(self):
        with self.lock:
            if self.cached_generation!=self.engine.generation or self.cached_snapshot is None:
                self.cached_snapshot=export_snapshot(self.engine)
                self.cached_generation=self.engine.generation
            return self.cached_snapshot

    def start(self):
        if self.thread and self.thread.is_alive():return
        self.stop_event.clear()
        def run():
            while not self.stop_event.wait(self.interval):self.scan()
        self.thread=threading.Thread(target=run,name='codex-log-sync',daemon=True);self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:self.thread.join(timeout=5)

class Server(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,address,engine,interval=2):
        self.engine=engine;self.sync=LogSync(engine,interval)
        super().__init__(address,Handler)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(PROJECT/'web/dist'),**kwargs)
    def log_message(self,fmt,*args):
        if args and '404' in str(args):super().log_message(fmt,*args)
    def end_headers(self):
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','no-referrer')
        super().end_headers()
    def send_json(self,data,status=200):
        raw=json.dumps(data,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def local_host(self):
        host=self.headers.get('Host','').split(':')[0]
        if host not in ['127.0.0.1','localhost']:
            self.send_json({'error':'仅允许本机地址访问'},403);return False
        return True
    def do_GET(self):
        if not self.local_host():return
        path=urlparse(self.path).path
        if path=='/api/v1/status':
            self.send_json(self.server.sync.status());return
        if path=='/api/v1/snapshot':
            self.send_json(self.server.sync.snapshot());return
        if path.startswith('/api/'):
            self.send_json({'error':'接口不存在'},404);return
        if path=='/':self.path='/index.html'
        super().do_GET()
    def do_POST(self):
        if not self.local_host():return
        # Same-origin loopback only. No cross-origin requests or arbitrary filesystem routes.
        origin=self.headers.get('Origin')
        if origin:
            parsed=urlparse(origin)
            if parsed.netloc!=self.headers.get('Host'):
                self.send_json({'error':'不接受其他网页发起的请求'},403);return
        try:
            size=int(self.headers.get('Content-Length','0'))
            if size<0 or size>1024*1024:raise QueryError('请求过大')
            body=json.loads(self.rfile.read(size) or b'{}')
            if not isinstance(body,dict):raise QueryError('请求必须为 JSON 对象')
            path=urlparse(self.path).path
            if path in ['/api/v1/query','/api/v1/session-options']:
                registry=self.server.engine
                target=registry.engine(body.pop('provider','codex')) if hasattr(registry,'engine') else registry
                result=target.query(body)
                if path.endswith('session-options'):result={k:result[k] for k in ['generation','options','selected_ids','removed_ids']}
                self.send_json(result)
            elif path=='/api/v1/index/refresh':
                result=self.server.sync.scan()
                self.send_json(result,503 if result['refresh_error'] else 200)
            else:self.send_json({'error':'接口不存在'},404)
        except (ValueError,KeyError,TypeError) as exc:
            self.send_json({'error':str(exc)},409 if '重新载入' in str(exc) else 400)
        except Exception:
            self.send_json({'error':'本地查询失败，请检查服务终端。'},500)
            raise

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8765);parser.add_argument('--log-root',type=Path,default=Path.home()/'.codex');parser.add_argument('--prepare-only',action='store_true');parser.add_argument('--skip-build',action='store_true');args=parser.parse_args()
    engine=ProviderRegistry(args.log_root,PROJECT/'var/usage.sqlite')
    server=None
    if not args.prepare_only:
        try:server=Server(('127.0.0.1',args.port),engine)
        except OSError:
            print(f'端口 {args.port} 已被使用。如果本程序已经启动，请打开 http://127.0.0.1:{args.port}，或使用 --port 选择其他端口。',flush=True)
            return
    statuses=engine.refresh()
    print('已索引 '+'；'.join(f'{PROVIDER_LABELS[name]} {status["record_count"]} 条响应' for name,status in statuses.items())+'。',flush=True)
    if args.prepare_only:
        (PROJECT/'var/reviewed.json').write_text(json.dumps(export_snapshot(engine,write=True),ensure_ascii=False));return
    if not args.skip_build:build_dashboard(engine)
    print(f'打开 http://127.0.0.1:{args.port}',flush=True)
    server.sync.checked_at=statuses['codex']['updated_at']
    print('手动同步模式：点击页面刷新按钮读取新增日志。',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.sync.stop();server.server_close()

if __name__=='__main__':main()
