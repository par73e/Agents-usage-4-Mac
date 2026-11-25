import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, providerByKey, isProvider, parseStored, validSelection, recordsEffort, initialView, providerIndexes, quotaAvailable, compactionAvailable,
  coverageNotes, spanLabel, sessionMeta, searchableText, removedNotice, emptySource, emptyResult, rangeForOthers, sharedRangeNotice, syncFailureText } from '../web/src/content/dashboard/providers.js';
import { rangeError } from '../web/src/content/dashboard/date-range.js';

const codex = providerByKey.codex, claude = providerByKey.claude, antigravity = providerByKey.antigravity;
const saved = { start:'2026-10-23T01:37', end:'2026-10-26T12:04', timezone:'Asia/Shanghai' };
const plain = value => String(value ?? 0);

test('each platform names its own queries, noun and copy', () => {
  assert.deepEqual(PROVIDERS.map(provider => provider.key), ['codex', 'claude', 'antigravity']);
  assert.deepEqual(new Set(PROVIDERS.map(provider => provider.usageQuery)), new Set(['usage', 'claude_usage', 'antigravity_usage']));
  for (const provider of PROVIDERS) {
    assert.ok(isProvider(provider.key));
    for (const field of ['label', 'noun', 'unit', 'countLabel', 'sourceLabel', 'origin', 'chartNote']) assert.equal(typeof provider[field], 'string', field);
    if (provider.key !== 'codex') for (const field of ['fileWord', 'recordWord', 'detailWord', 'searchPlaceholder']) assert.equal(typeof provider[field], 'string', field);
  }
  assert.equal(isProvider('cursor'), false);
  // Only Codex has pre-response history and quota snapshots behind it.
  assert.deepEqual(PROVIDERS.filter(provider => provider.legacyQuery).map(provider => provider.key), ['codex']);
  assert.deepEqual(PROVIDERS.filter(provider => provider.quotaQuery).map(provider => provider.key), ['codex']);
});

test('a new view starts on the last seven days with the last used settings', () => {
  const view = initialView(null, { timezone:'UTC', granularity:'day', mode:'composition', axis:'independent' }, null);
  assert.equal(rangeError(view.applied), '');
  assert.equal(view.applied.timezone, 'UTC');
  assert.equal(view.relativeKey, 'last7d');
  assert.deepEqual([view.granularity, view.mode, view.axis, view.includeCompaction, view.followNow], ['day', 'composition', 'independent', true, true]);
  assert.deepEqual(view.selection, { mode:'all', ids:[] });
  // Unknown or damaged settings fall back instead of reaching the query.
  const fallback = initialView(null, { timezone:'wrong/zone', granularity:'2h', mode:'neon', axis:'sideways' }, null);
  assert.deepEqual([fallback.applied.timezone, fallback.granularity, fallback.mode, fallback.axis], ['Asia/Shanghai', '6h', 'effort', 'unified']);
});

test('a saved view is restored as it was left', () => {
  const stored = { applied:saved, followNow:false, relativeKey:null, granularity:'1h', mode:'composition', axis:'independent', includeCompaction:false,
    selection:{ mode:'explicit', ids:['a', 'b'] } };
  const view = initialView(stored, { granularity:'day' }, null);
  assert.deepEqual(view.applied, saved);
  assert.deepEqual([view.followNow, view.relativeKey, view.granularity, view.mode, view.axis, view.includeCompaction], [false, null, '1h', 'composition', 'independent', false]);
  assert.deepEqual(view.selection, { mode:'explicit', ids:['a', 'b'] });
  assert.notEqual(view.selection.ids, stored.selection.ids);
  // Damaged parts are replaced one by one; the rest of the view survives.
  const partly = initialView({ ...stored, applied:{ ...saved, start:'2026-02-30T00:00' }, granularity:'5h', axis:'diagonal', selection:{ mode:'explicit', ids:'a' } }, { timezone:'UTC' }, null);
  assert.deepEqual([partly.applied.timezone, partly.relativeKey, partly.followNow, partly.granularity, partly.axis], ['UTC', 'last7d', true, '6h', 'unified']);
  assert.deepEqual(partly.selection, { mode:'all', ids:[] });
  assert.deepEqual(initialView({ ...stored, selection:{ mode:'all' } }, {}, null).selection, { mode:'all', ids:[] });
  for (const value of [null, 'x', { mode:'nope', ids:[] }, { mode:'explicit' }, { mode:'explicit', ids:[1] }]) assert.equal(validSelection(value), false);
  assert.equal(validSelection({ mode:'explicit', ids:[] }), true);
});

test('a range that follows now is brought up to date before the first query', () => {
  const minute = 60000, now = Date.now();
  const view = initialView({ applied:{ start:'2026-01-01T00:00', end:'2026-01-02T00:00', timezone:'UTC' }, followNow:true, relativeKey:null }, {}, null);
  assert.equal(view.applied.start, '2026-01-01T00:00');
  // Either side of a minute boundary between the two clock reads is acceptable.
  const minuteEnd = at => new Date(Math.floor((at + minute) / minute) * minute).toISOString().slice(0, 16);
  assert.ok([minuteEnd(now), minuteEnd(now + 60000)].includes(view.applied.end), view.applied.end);
  const preset = initialView({ applied:saved, followNow:true, relativeKey:'today' }, {}, null);
  assert.equal(rangeError(preset.applied), '');
  assert.ok(Date.parse(preset.applied.end.replace(' ', 'T') + ':00Z') >= now - minute);
  // A fixed range is the user's choice and stays exactly as saved.
  assert.deepEqual(initialView({ applied:saved, followNow:false, relativeKey:'last7d' }, {}, null).applied, saved);
  // A relative key is only kept when it names a real preset.
  assert.equal(initialView({ applied:saved, relativeKey:'sometime' }, {}, null).relativeKey, null);
});

test('a source that records no effort opens on the composition colours', () => {
  const none = { record_count:10, unknown_effort:10 }, some = { record_count:10, unknown_effort:4 };
  assert.deepEqual([recordsEffort(none), recordsEffort(some), recordsEffort({ record_count:0 }), recordsEffort(undefined)], [false, true, true, true]);
  assert.equal(initialView(null, { mode:'effort' }, none).mode, 'composition');
  assert.equal(initialView(null, { mode:'effort' }, some).mode, 'effort');
  // The user's own saved choice always wins.
  assert.equal(initialView({ mode:'effort' }, { mode:'composition' }, none).mode, 'effort');
});

test('every source status is read from the snapshot', () => {
  const status = generation => JSON.stringify({ generation, record_count:1 });
  const queries = { providers:{ rows:[{ provider:'codex', status_json:status('c1') }, { provider:'claude', status_json:'{broken' }, { provider:'antigravity', status_json:status('a1') }, { status_json:status('orphan') }] },
    index_state:{ rows:[{ status_json:status('old') }] } };
  assert.deepEqual(Object.keys(providerIndexes(queries)), ['codex', 'antigravity']);
  assert.equal(providerIndexes(queries).antigravity.generation, 'a1');
  // Older snapshots carried only the Codex status.
  assert.equal(providerIndexes({ index_state:{ rows:[{ status_json:status('old') }] } }).codex.generation, 'old');
  assert.deepEqual(providerIndexes({}), {});
  for (const value of [null, 'x', '[1]', '"text"']) assert.equal(parseStored(value), null);
  assert.deepEqual(parseStored('{"a":1}'), { a:1 });
});

test('quota and compaction controls follow what the source declares', () => {
  const codexStatus = { capabilities:['legacy_history', 'quota_snapshots', 'compaction_filter'] };
  assert.deepEqual([quotaAvailable(codexStatus), compactionAvailable(codexStatus)], [true, true]);
  for (const index of [{ capabilities:[] }, {}, undefined]) assert.deepEqual([quotaAvailable(index), compactionAvailable(index)], [false, false]);
});

test('coverage notes report what each source actually read', () => {
  const format = { number:plain, date:value => value ? 'D' + value : 'none', dateTime:value => 'T ' + value };
  const codexNotes = coverageNotes({ provider:codex, format, index:{ file_count:953, compressed_file_count:12, record_count:31012, quota_record_count:800, first:'a', quota_first:'b',
    legacy_only_files:2, legacy_first:'c', legacy_latest:'d', zstd_available:true, index_coverage:{ available:true, missing_log_files:3 },
    scan:{ invalid_records:4, unreadable_files:1 }, conflicting_responses:5, updated_at:'u' }, result:{ warnings:['future'] }, caveats:['caveat'] });
  const text = codexNotes.join('\n');
  for (const part of ['953 个文件', '12 个压缩日志', '31012 条唯一响应、800 条额度快照', '起于 Da', '额度快照起于 Db', '2 个日志只有旧版累计用量（Dc ～ Dd）', '3 个源日志路径缺失', '跳过异常 4 · 冲突响应 5', 'T u', '1 个文件无法读取', 'future', 'caveat']) assert.ok(text.includes(part), part);
  assert.ok(!text.includes('zstd 工具'));
  const compact = coverageNotes({ provider:codex, format, index:{ file_count:1, compressed_file_count:0, record_count:1, updated_at:'u', scan:{ invalid_records:0 } } });
  assert.equal(compact.join('\n').includes('zstd 工具'), false);
  assert.ok(compact.join('\n').includes('逐响应明细起于 none；额度快照起于 none'));
  assert.ok(compact.join('\n').includes('聊天标题索引不可用时'));
  assert.ok(coverageNotes({ provider:codex, format, index:{ compressed_file_count:2 } }).join('\n').includes('zstd 工具'));

  const claudeNotes = coverageNotes({ provider:claude, format, index:{ file_count:21, record_count:735, first:'x', scan:{ untitled_sessions:2, unreadable_files:3 }, updated_at:'u' },
    result:{ warnings:[] }, caveats:['记录不含账户额度快照'] }).join('\n');
  for (const part of ['读取 21 个会话记录文件，索引 735 条唯一响应。', '逐响应明细起于 Dx', '2 个会话没有标题记录', '3 个文件无法读取', 'T u', '记录不含账户额度快照']) assert.ok(claudeNotes.includes(part), part);
  for (const absent of ['额度快照起于', '跳过异常', '旧日志', '聊天索引']) assert.ok(!claudeNotes.includes(absent), absent);

  const ledgerNotes = coverageNotes({ provider:antigravity, format, index:{ file_count:39, record_count:2221, scan:{ partial_records:1 }, updated_at:'u' }, caveats:[] }).join('\n');
  for (const part of ['39 个台账文件，索引 2221 条记录。', '逐条记录起于 none', '1 条被台账标记为不完整（partial）的记录。']) assert.ok(ledgerNotes.includes(part), part);
  // What a partial record means is the source's own caveat, not repeated here.
  assert.equal(ledgerNotes.includes('按 0 计'), false);
  assert.ok(!ledgerNotes.includes('无法读取'));
  // Warnings travel with the notes and empty caveats change nothing.
  assert.deepEqual(coverageNotes({ provider:antigravity, format, index:{}, result:{ warnings:['w'] }, caveats:[null, ''] }), ['读取 0 个台账文件，索引 0 条记录。', '逐条记录起于 none。', '最后刷新 T undefined', 'w']);
});

test('time spans name the day once when both ends share it', () => {
  assert.equal(spanLabel('2026-11-25T10:09:38Z', '2026-11-25T10:59:44Z', 'Asia/Shanghai'), '11/25 18:09 – 18:59');
  assert.equal(spanLabel('2026-11-23T13:39:27Z', '2026-11-25T10:20:44Z', 'Asia/Shanghai'), '11/23 21:39 – 11/25 18:20');
  assert.equal(spanLabel('2026-11-25T23:30:00Z', '2026-11-26T00:15:00Z', 'UTC'), '11/25 23:30 – 11/26 00:15');
  // The month and day are zero-padded, as on the chart's axis labels.
  assert.equal(spanLabel('2026-12-31T16:05:00Z', '2026-12-31T17:05:00Z', 'Asia/Shanghai'), '01/01 00:05 – 01:05');
  assert.equal(spanLabel(null, '2026-11-25T10:59:44Z'), '');
  assert.equal(spanLabel('bad', '2026-11-25T10:59:44Z'), '');
  // An unusable zone falls back rather than throwing.
  assert.equal(spanLabel('2026-11-25T10:00:00Z', '2026-11-25T11:00:00Z', 'wrong/zone'), '11/25 10:00 – 11:00');
});

test('session rows say what, where, when, and which one', () => {
  const zone = 'Asia/Shanghai';
  assert.deepEqual(sessionMeta({ id:'5f152d45-8842-4d6b-9420-740053a8a18e', title:'交接文档', kind:'会话', project:'Codex-usage', first:'2026-11-25T10:09:38Z', latest:'2026-11-25T10:59:44Z' }, zone),
    ['会话', 'Codex-usage', '11/25 18:09 – 18:59', '53a8a18e']);
  // A title that already ends with the id suffix is not repeated after it.
  assert.deepEqual(sessionMeta({ id:'acct-01b09199', title:'任务 01b09199', kind:'任务', first:'2026-11-23T13:39:27Z', latest:'2026-11-25T10:20:44Z' }, zone),
    ['11/23 21:39 – 11/25 18:20']);
  // A sub-agent keeps its kind: the title it borrows from its session does not say it.
  assert.deepEqual(sessionMeta({ id:'agent-1', title:'Renamed by user · 子代理', kind:'子代理', project:'app', first:'2026-11-20T03:00:00Z', latest:'2026-11-20T03:30:00Z' }, 'UTC'),
    ['子代理', 'app', '11/20 03:00 – 03:30', 'agent-1']);
  assert.deepEqual(sessionMeta({ id:'session-b', title:'会话 ession-b', kind:'会话' }, 'UTC'), []);
  // Intervals known only from old cumulative history carry no response times.
  assert.deepEqual(sessionMeta({ id:'01a1f249-b84c-7cc0-b6f6-4d48a135ab56', title:'aero6', kind:'会话' }), ['会话', 'a135ab56']);
  assert.deepEqual(sessionMeta({}), []);
});

test('search reads the title, the project, the id and the time line the list shows', () => {
  const zone = 'Asia/Shanghai';
  const session = searchableText({ id:'5f152d45-8842-4d6b-9420-740053a8a18e', title:'交接文档', kind:'会话', project:'Codex-usage', first:'2026-11-25T10:09:38Z', latest:'2026-11-25T10:59:44Z' }, zone);
  // The title, the project, the whole id and any date or clock time on the line each find the row.
  for (const term of ['交接', 'codex-usage', '5F152D45', '18:09', '11/25']) assert.ok(session.includes(term.toLowerCase()), term);
  assert.equal(session.includes('11/26'), false);
  // A task has no title beyond its id, so the date is what tells tasks apart.
  const task = searchableText({ id:'acct-01b09199', title:'任务 01b09199', kind:'任务', first:'2026-11-23T13:39:27Z', latest:'2026-11-25T10:20:44Z' }, zone);
  for (const term of ['acct', '11/23', '11/25', '21:39']) assert.ok(task.includes(term.toLowerCase()), term);
  // Intervals known only from old cumulative history carry no time to be found by.
  assert.equal(searchableText({ id:'01a1f249-b84c-7cc0-b6f6-4d48a135ab56', title:'aero6', kind:'会话' }), 'aero6 01a1f249-b84c-7cc0-b6f6-4d48a135ab56 会话 a135ab56');
  assert.equal(searchableText({}), '');
});

test('notices and empty states speak in the source\'s own terms', () => {
  assert.equal(removedNotice(2, '任务'), '2 个任务在这个范围内无用量，已移出选择。');
  assert.ok(emptySource(claude).title.includes('Claude Code') && emptySource(claude).body.includes('~/.claude/projects'));
  assert.ok(emptySource(antigravity).body.includes('Antigravity Pulse'));
  assert.deepEqual(emptyResult({ provider:antigravity, selection:{ mode:'explicit', ids:[] }, legacyOnly:false }), { title:'尚未选择任务', body:'选择一个或多个任务，或恢复全选。' });
  assert.equal(emptyResult({ provider:codex, selection:{ mode:'all', ids:[] }, legacyOnly:true }).title, '这个区间没有可归属模型的逐响应明细');
  assert.deepEqual(emptyResult({ provider:codex, selection:{ mode:'explicit', ids:['a'] }, legacyOnly:false }), { title:'这个区间没有匹配记录', body:'尝试调整时间范围，再应用查询。' });
});

test('a range applied to every platform changes only the range of the others',()=>{
  const range={start:'2026-11-18T00:00',end:'2026-11-25T00:00',timezone:'UTC'};
  const own={ applied:saved, followNow:false, relativeKey:null, granularity:'1h', mode:'composition', axis:'independent', includeCompaction:false, selection:{ mode:'explicit', ids:['s1','s2'] } };
  const others=rangeForOthers('codex',range,false,null,key=>key==='claude'?JSON.stringify(own):null);
  // The source the change was made on is not among them; the order follows the platform list.
  assert.deepEqual(others.map(other=>other.key),['claude','antigravity']);
  // A source that was used before keeps everything except the range.
  assert.deepEqual(JSON.parse(JSON.stringify(others[0].view)),{...own,applied:range});
  // A source never opened receives the range alone, so its first visit still starts from the last used settings.
  assert.deepEqual(JSON.parse(JSON.stringify(others[1].view)),{applied:range,followNow:false,relativeKey:null});
  // A damaged saved view is not allowed to leak into the result.
  assert.deepEqual(JSON.parse(JSON.stringify(rangeForOthers('antigravity',range,false,null,()=>'{broken')[0].view)),{applied:range,followNow:false,relativeKey:null});
});

test('a preset applied to every platform keeps its name and follows now on each',()=>{
  const preset={start:'2026-11-18T19:00',end:'2026-11-25T19:42',timezone:'Asia/Shanghai'};
  const fixed={start:'2026-11-24T00:00',end:'2026-11-25T00:00',timezone:'Asia/Shanghai'};
  const load=()=>null;
  assert.deepEqual(JSON.parse(JSON.stringify(rangeForOthers('claude',preset,true,'last30d',load)[0].view)),{applied:preset,followNow:true,relativeKey:'last30d'});
  // "昨天" is a fixed day: named, but not following now.
  assert.deepEqual(JSON.parse(JSON.stringify(rangeForOthers('claude',fixed,false,'yesterday',load)[0].view)),{applied:fixed,followNow:false,relativeKey:'yesterday'});
  // Each platform has the other two behind it.
  for(const provider of PROVIDERS)assert.equal(rangeForOthers(provider.key,preset,true,'last30d',load).length,2);
  assert.equal(sharedRangeNotice(3),'时间范围已应用到全部 3 个平台。');
});

test('a sync that failed names the platform that could not be read and says what the others show',()=>{
  // One unreadable platform keeps its earlier rows; the others were refreshed.
  assert.equal(syncFailureText('Claude Code 的日志读取失败（source locked）',{claude:'source locked'}),
    '日志读取失败：Claude Code（source locked）。该平台保留上次成功读取的数据，其他平台已照常刷新，请手动重试。');
  // Two are named together, in the order the service lists them.
  assert.equal(syncFailureText('',{codex:'disk busy',antigravity:'denied'}),
    '日志读取失败：Codex（disk busy）、Anti Gravity（denied）。这些平台保留上次成功读取的数据，其他平台已照常刷新，请手动重试。');
  // When every platform failed there is no other platform to speak of.
  assert.equal(syncFailureText('',{codex:'a',claude:'b',antigravity:'c'}),'日志读取失败：Codex（a）、Claude Code（b）、Anti Gravity（c）。各平台保留上次成功读取的数据，请手动重试。');
});

test('a sync that could not reach the service keeps the earlier data for every platform',()=>{
  // No platform is named when the request itself failed or timed out.
  assert.equal(syncFailureText('本机服务响应超时'),'同步中断：本机服务响应超时。仍显示最近一次成功读取的数据，请手动重试。');
  assert.equal(syncFailureText('Failed to fetch',undefined),'同步中断：Failed to fetch。仍显示最近一次成功读取的数据，请手动重试。');
  // A missing list is treated as an empty one.
  assert.equal(syncFailureText('x',null),syncFailureText('x',{}));
});
