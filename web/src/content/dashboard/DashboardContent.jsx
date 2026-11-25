import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, RangeSlider, SegmentedControl, SortableItem, SortableRegion, Switch, useDataApp } from "../../data-app-public.jsx";
import { TimeRangePicker } from "./TimeRangePicker.jsx";
import { QuotaCharts, QuotaUnavailable } from "./QuotaCharts.jsx";
import { TotalUsageChart } from "./TotalUsageChart.jsx";
import { ModelChart } from "./ModelChart.jsx";
import { SessionPicker } from "./SessionPicker.jsx";
import { buildChartView } from "./chart-view.js";
import { localMinute, presetRange } from "./date-range.js";
import { PROVIDERS, providerByKey, isProvider, initialView, parseStored, providerIndexes, quotaAvailable, compactionAvailable, coverageNotes, removedNotice, emptySource, emptyResult, rangeForOthers, sharedRangeNotice, syncFailureText } from "./providers.js";
import codexIcon from "../assets/agents/codex.svg";
import claudeIcon from "../assets/agents/claude-code.svg";
import antigravityIcon from "../assets/agents/antigravity.svg";
import "./dashboard.css";

// Official marks; sources and licences are listed in assets/agents/SOURCES.md.
const ICONS = { codex: codexIcon, claude: claudeIcon, antigravity: antigravityIcon };
const EMPTY = [];
const number = value => new Intl.NumberFormat("zh-CN").format(value ?? 0);
function read(key) { try { return localStorage.getItem("codex-usage:" + key); } catch { return null; } }
function write(key, value) { try { localStorage.setItem("codex-usage:" + key, value); } catch {} }
async function post(path, body) {
  let response;
  // The browser reports a refused or dropped connection as a TypeError.
  try { response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  catch (error) { throw error.name === "TypeError" ? new Error("无法连接本机服务") : error; }
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "查询失败，请重试。");
  return value;
}

function ProviderSwitch({ value, onChange }) {
  return <div className="usage-provider-switch" role="group" aria-label="智能体平台" data-provider-switch>
    <span className="usage-provider-label">平台</span>
    {PROVIDERS.map(provider => <button key={provider.key} type="button" className="usage-provider-button" aria-pressed={value === provider.key} onClick={() => onChange(provider.key)}>
      <img className="usage-provider-icon" src={ICONS[provider.key]} alt="" width="22" height="22" draggable={false} />
      <span>{provider.label}</span>
    </button>)}
  </div>;
}

// Everything below the filter card that depends on the chosen source. It is
// remounted for each source (``key``), so its range, granularity, sessions,
// colour mode and axis are created from that source's own saved view and can
// never carry over to another.
function ProviderPane({ provider, index, queries, setDashboardBusy, localRefresh, onProviderChange }) {
  const noun = provider.noun;
  const [view] = useState(() => initialView(parseStored(read("view:" + provider.key)), {
    timezone: read("timezone"), granularity: read("granularity"), mode: read("mode"), axis: read("axis") }, index));
  const [applied, setApplied] = useState(view.applied), [granularity, setGranularity] = useState(view.granularity);
  const [mode, setMode] = useState(view.mode), [axis, setAxis] = useState(view.axis);
  const [includeCompaction, setIncludeCompaction] = useState(view.includeCompaction);
  const [selection, setSelection] = useState(view.selection);
  const [followNow, setFollowNow] = useState(view.followNow), [relativeKey, setRelativeKey] = useState(view.relativeKey);
  const [result, setResult] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [notice, setNotice] = useState(""), [zoom, setZoom] = useState([0, 0]);
  // Rows and provenance come from this source's own queries in the snapshot.
  const usageRows = queries[provider.usageQuery]?.rows || EMPTY;
  const legacyRows = provider.legacyQuery ? queries[provider.legacyQuery]?.rows || EMPTY : EMPTY;
  const quotaRows = provider.quotaQuery ? queries[provider.quotaQuery]?.rows || EMPTY : EMPTY;
  const caveats = queries[provider.usageQuery]?.source?.caveats || EMPTY;
  const plotResult = useMemo(() => buildChartView(result, zoom), [result, zoom]);
  const plotZoom = useMemo(() => [0, Math.max(0, (plotResult?.bins.length || 1) - 1)], [plotResult]);
  const request = useRef(0), previousQuery = useRef(null), previousBins = useRef(0);
  const reconcile = localRefresh?.reconcile;
  const noRecords = index?.record_count === 0;
  const queryKey = JSON.stringify({ provider: provider.key, applied: { ...applied, start: followNow && relativeKey ? relativeKey : applied.start, end: followNow ? "now" : applied.end }, granularity, includeCompaction, selection });
  useEffect(() => { write("view:" + provider.key, JSON.stringify({ applied, selection, includeCompaction, followNow, relativeKey, granularity, mode, axis })); }, [provider, applied, selection, includeCompaction, followNow, relativeKey, granularity, mode, axis]);
  useEffect(() => {
    if (!followNow) return;
    const next = relativeKey ? presetRange(relativeKey, applied.timezone) : { ...applied, end: localMinute(new Date(Date.now() + 60000), applied.timezone) };
    if (applied.start === next.start && applied.end === next.end) return;
    setApplied(next);
  }, [followNow, relativeKey, localRefresh?.checkedAt, applied.timezone, applied.start, applied.end]);
  // The last used settings are the starting point for a source opened for the first time.
  useEffect(() => { for (const [key, value] of Object.entries({ timezone: applied.timezone, granularity, mode, axis })) write(key, value); }, [applied.timezone, granularity, mode, axis]);
  useEffect(() => {
    if (noRecords) { setLoading(false); setError(""); return; }
    const current = ++request.current; setLoading(true); setError(""); setDashboardBusy(true);
    post("/api/v1/query", { provider: provider.key, generation: index?.generation, start: applied.start, end: applied.end, timezone: applied.timezone, granularity, include_compaction: includeCompaction, sessions: selection }).then(data => {
      if (request.current !== current) return;
      const last = Math.max(0, data.bins.length - 1);
      const changedQuery = previousQuery.current !== queryKey, oldCount = previousBins.current;
      setZoom(current => changedQuery || current[0] === 0 && current[1] === oldCount - 1
        ? [0, last] : [Math.min(current[0], last), Math.min(current[1], last)]);
      previousQuery.current = queryKey; previousBins.current = data.bins.length;
      setResult({ ...data, queryKey, evidenceRows: usageRows, quotaEvidenceRows: quotaRows, legacyEvidenceRows: legacyRows });
      if (data.removed_ids.length) { setNotice(removedNotice(data.removed_ids.length, noun)); setSelection(s => ({ ...s, ids: data.selected_ids })); }
    }).catch(async e => {
      if (request.current !== current) return;
      // A changed index is read again once. When that brings a newer index for
      // this source, the view asks again by itself; when it does not, the page
      // says so instead of leaving the charts empty.
      if (e.message.includes("重新载入") && reconcile) {
        const next = await reconcile();
        if (request.current !== current) return;
        if (next && providerIndexes(next.queries)[provider.key]?.generation !== index?.generation) return;
      }
      setError(e.message);
    }).finally(() => { if (request.current === current) { setLoading(false); setDashboardBusy(false); } });
    return () => { request.current++; setDashboardBusy(false); };
  }, [provider, noRecords, index?.generation, applied, granularity, includeCompaction, selection, reconcile, followNow, relativeKey, queryKey]);
  const total = result?.totals?.total_tokens || 0;
  const zone = applied.timezone;
  const checkTime = localRefresh?.checkedAt ? new Date(localRefresh.checkedAt).toLocaleTimeString("zh-CN", { timeZone: zone, hour12: false }) : "正在检查";
  const stamp = value => value ? new Date(value).toLocaleString("zh-CN", { timeZone: zone, hour12: false }) : "暂无记录";
  const coverageDate = value => value ? new Date(value).toLocaleDateString("zh-CN", { timeZone: zone }) : "暂无记录";
  const includesLegacyHistory = index?.legacy_only_files > 0 && result
    && (!index.first || Date.parse(result.start) < Date.parse(index.first))
    && Date.parse(result.end) > Date.parse(index.legacy_first) && Date.parse(result.start) <= Date.parse(index.legacy_latest);
  const notes = coverageNotes({ provider, index, result, caveats, format: { number, date: coverageDate, dateTime: stamp } });
  const empty = result && emptyResult({ provider, selection, legacyOnly: includesLegacyHistory });
  // Why the last sync did not finish, and which sources still show what they last returned.
  const syncIssue = localRefresh?.error ? syncFailureText(localRefresh.error, localRefresh.failures) : "";
  const applyTimeRange = (value, nextFollow, nextRelative, scope) => {
    setApplied({ start: value.start, end: value.end, timezone: value.timezone });
    // A fixed preset such as "昨天" keeps its key; only a hand-typed range has none.
    setFollowNow(nextFollow); setRelativeKey(nextRelative);
    // "All platforms" hands this range to every other source for its next visit.
    // Each keeps its own granularity, sessions, colour mode and axis.
    const others = scope === "all" ? rangeForOthers(provider.key, value, nextFollow, nextRelative, key => read("view:" + key)) : EMPTY;
    for (const other of others) write("view:" + other.key, JSON.stringify(other.view));
    setNotice(others.length ? sharedRangeNotice(PROVIDERS.length) : "");
  };
  const toggleFollow = value => {
    setFollowNow(value); setRelativeKey(null);
    if (value) setApplied(a => ({ ...a, end: localMinute(new Date(Date.now() + 60000), a.timezone) }));
  };
  return <>
    <section className="usage-topline"><div><h1>Token 用量</h1><p>按时间、{noun}和模型查看 {provider.label} 的本地使用记录</p></div><div className="usage-sync"><span role="status" className={localRefresh?.error ? "usage-sync-error" : ""}>{localRefresh?.error ? "同步中断，请手动重试" : localRefresh?.connected ? `手动同步 · 刷新会同时读取全部 ${PROVIDERS.length} 个平台的日志` : "正在连接本机服务…"}</span><Button onClick={() => void localRefresh?.refresh()} disabled={!localRefresh || localRefresh.busy}>{localRefresh?.busy ? "正在同步…" : "立即同步"}</Button></div></section>
    {syncIssue && <p className="usage-error" role="status">{syncIssue}</p>}
    <section className="usage-filter-surface" aria-label="平台、时间与用量筛选">
      <ProviderSwitch value={provider.key} onChange={onProviderChange} />
      <TimeRangePicker value={applied} followNow={followNow} relativeKey={relativeKey} onApply={applyTimeRange} storageKey={"codex-usage:recent-ranges:" + provider.key} providerLabel={provider.label} providerCount={PROVIDERS.length} />
      <div className="usage-view-controls">
        <div className="usage-control-group"><span>粒度</span><SegmentedControl ariaLabel="时间粒度" value={granularity} onChange={setGranularity} options={[{value:"1h",label:"1 小时"},{value:"6h",label:"6 小时"},{value:"12h",label:"12 小时"},{value:"day",label:"天"}]} /></div>
        <SessionPicker options={result?.options || EMPTY} selection={selection} disabled={loading} onChange={setSelection} noun={noun} placeholder={provider.searchPlaceholder} timezone={zone} />
        <div className="usage-control-group usage-color-mode"><span>颜色</span><SegmentedControl ariaLabel="颜色模式" value={mode} onChange={setMode} options={[{value:"effort",label:"推理强度"},{value:"composition",label:"用量构成"}]} /></div>
      </div>
      <div className="usage-secondary-controls"><div className="usage-live-options">
        {compactionAvailable(index) && <Switch label="包含上下文压缩" checked={includeCompaction} onChange={setIncludeCompaction} size="compact" />}
        <Switch label="结束时间跟随现在" checked={followNow} onChange={toggleFollow} size="compact" /></div>
        <div><span>纵轴</span><SegmentedControl ariaLabel="纵轴比例" size="compact" value={axis} onChange={setAxis} options={[{value:"unified",label:"统一"},{value:"independent",label:"独立"}]} /></div></div>
    </section>
    {notice && <div className="usage-notice" role="status">{notice}</div>}
    {includesLegacyHistory && <div className="usage-notice" role="status">早期累计用量已按观测区间估算，计入合计图；明细与估算分别着色。分模型图仅含可归属的逐响应明细，不强行分配旧日志的模型或推理强度。</div>}
    {error && <div className="usage-error" role="alert">{error}<Button onClick={() => setApplied(a => ({ ...a }))}>重试</Button>{error.includes("重新载入") && <Button onClick={() => window.location.reload()}>重新载入</Button>}</div>}
    {!result && loading ? <div className="usage-loading" role="status"><span />正在汇总所选区间…</div>
      : noRecords ? <section className="usage-empty usage-source-empty" role="status"><img src={ICONS[provider.key]} alt="" width="44" height="44" /><h2>{emptySource(provider).title}</h2><p>{emptySource(provider).body}</p></section>
      : result && <div className="usage-results" aria-busy={loading || result.generation !== index?.generation} inert={result.queryKey !== queryKey ? true : undefined}>
      <div className="usage-summary" data-reviewed-rows><div><span>所选范围总量</span><strong title={number(total)}>{number(total)}</strong><span>tokens</span></div><p>{result.selected_ids.length} / {result.options.length} 个{noun}<span>·</span>{result.models.length} 个模型<span>·</span>{number(result.response_count)} {provider.unit}</p></div>
      {result.bins.length > 24 && <div className="usage-zoom"><RangeSlider label="图表显示范围（不改变区间合计）" min={0} max={result.bins.length - 1} step={1} value={zoom} onChange={setZoom} formatValue={i => result.bins[Math.round(i)]?.label || ""} /><button onClick={() => setZoom([0,result.bins.length - 1])}>重置视图</button></div>}
      {plotResult.overviewStride > 1 && <p className="usage-overview-note" role="status">长区间概览：每柱合并最多 {plotResult.overviewStride} 个所选时段，悬浮可看完整起止时间。缩小上方显示范围后恢复所选粒度；区间总量不变。</p>}
      <TotalUsageChart result={plotResult} mode={mode} provider={provider} />
      {quotaAvailable(index) ? <QuotaCharts result={plotResult} zoom={plotZoom} sourceRows={result.quotaEvidenceRows} /> : <QuotaUnavailable provider={provider} />}
      {result.models.length ? <SortableRegion id="usage-models" variant="freeform" className="usage-models" authoredRevision={2}>
        {plotResult.models.map(model => <ModelChart id={"model-" + model.name.replace(/[^a-zA-Z0-9_-]/g, "-")} key={model.name + mode} model={model} result={plotResult} provider={provider} mode={mode} axis={axis} usageRows={result.evidenceRows} />)}
      </SortableRegion> : empty && <div className="usage-empty"><h2>{empty.title}</h2><p>{empty.body}</p>{selection.mode === "explicit" && <Button onClick={() => setSelection({ mode: "all", ids: [] })}>全选当前时间候选</Button>}</div>}
    </div>}
    <footer className="usage-footer"><div><span className="usage-source-dot" />{provider.sourceLabel}<span>最近检查 {checkTime} · 数据截止 {stamp(index?.latest)}</span></div>
      <details><summary>数据范围与统计说明</summary><div className="usage-coverage">{notes.map(line => <p key={line}>{line}</p>)}</div></details></footer>
  </>;
}

export function DashboardContent() {
  const { queries, setDashboardBusy, localRefresh } = useDataApp();
  const [provider, setProvider] = useState(() => { const saved = read("provider"); return isProvider(saved) ? saved : "codex"; });
  const workspace = useRef(null), refocus = useRef(false);
  const indexes = useMemo(() => providerIndexes(queries), [queries]);
  const current = providerByKey[provider];
  // Switching replaces the pane below, button included. Put keyboard focus back
  // on the newly selected platform so Tab order continues from where it was.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    workspace.current?.querySelector('[data-provider-switch] [aria-pressed="true"]')?.focus();
  }, [provider]);
  return <article className="usage-workspace" ref={workspace}>
    <ProviderPane key={current.key} provider={current} index={indexes[current.key]} queries={queries} setDashboardBusy={setDashboardBusy} localRefresh={localRefresh}
      onProviderChange={key => { if (key !== provider) { write("provider", key); refocus.current = true; setProvider(key); } }} />
  </article>;
}
