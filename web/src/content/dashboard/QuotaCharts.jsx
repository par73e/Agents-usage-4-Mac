import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, ChartMark, ChartTooltip, DataComponent, InfoTooltip, Switch } from "../../data-app-public.jsx";
import { timeTicks } from "./time-ticks.js";
import { QUOTA_LEFT, QUOTA_RIGHT, quotaEventBand, quotaMarks, quotaPosition, quotaView, retainQuotaRows, windowLabel } from "./quota-view.js";
import { daysAgo } from "./format.js";
import { zoneMinute } from "./range-compare.js";
import "./quota.css";

const TOP = 18, PLOT = 190, HEIGHT = 242, DAY = 86400000;
const number = new Intl.NumberFormat("zh-CN");
function dateLabel(value, timezone, seconds = false) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hourCycle: "h23" }).format(new Date(value));
}
function SnapshotTooltip({ point, timezone }) {
  return <ChartTooltip active label={dateLabel(point.timestamp, timezone, true)} details={[
    { label: "剩余额度", value: `${point.remaining_percent}%`, color: "var(--quota-line)" },
    { label: "已用额度", value: `${point.used_percent}%` },
    { label: "额度周期", value: windowLabel(point.window_minutes).replace("窗口", "") },
    { label: "预计重置", value: point.resets_at ? dateLabel(point.resets_at, timezone) : "未记录" },
  ]} />;
}
function RecoveryTooltip({ event, timezone, narrow }) {
  return <ChartTooltip active label={event.kind === "full_recovery" ? "观察到恢复满额" : "观察到额度回升"} details={[
    { label: "剩余额度", value: `${event.remaining_before}% → ${event.remaining_after}%` },
    { label: "区间起点", value: dateLabel(event.lower_timestamp, timezone, true) },
    { label: "首次观察到", value: dateLabel(event.upper_timestamp, timezone, true) },
  ]}><p className="usage-quota-tooltip-note">{narrow ? "短区间的浅紫标记已加宽便于识别，宽度不代表持续时间。" : "阴影表示两次观测之间的可能发生区间。"}重置原因未知。</p></ChartTooltip>;
}
function useStableQuotaRows(rows, key) {
  const previous = useRef([]);
  return useMemo(() => {
    previous.current = retainQuotaRows(previous.current, rows, key);
    return previous.current;
  }, [rows, key]);
}

function QuotaWindow({ window, result, zoom, sourceRows, threshold, showGapBackground, onGapBackgroundChange, fullRange, onShowRecorded, onResetZoom }) {
  const ref = useRef(null), [width, setWidth] = useState(600);
  const points = useStableQuotaRows(window.points, "snapshot_id");
  const recoveries = useStableQuotaRows(window.events, "id");
  const view = useMemo(() => quotaView({ ...window, points, events: recoveries }, result.bins, zoom), [window, points, recoveries, result.bins, zoom]);
  // The plot is on the page only while the view holds a record.
  const plotted = view.points.length > 0;
  useEffect(() => {
    const element = ref.current; if (!element) return;
    // The plot is not on the page while the range holds no record, so its width is measured each time it appears.
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element); return () => observer.disconnect();
  }, [plotted]);
  const plotWidth = Math.max(1, width - QUOTA_LEFT - QUOTA_RIGHT);
  const x = time => QUOTA_LEFT + quotaPosition(time, view.bins) * plotWidth;
  const y = percent => TOP + PLOT * (1 - percent / 100);
  const events = view.events.map(event => ({ ...event, sourceRow: event, band: quotaEventBand(event, view.bins, plotWidth) }));
  const marks = useMemo(() => quotaMarks(view.points, view.bins, plotWidth, view.events), [view, plotWidth]);
  const labels = useMemo(() => timeTicks(view.bins, result.timezone, plotWidth), [view.bins, result.timezone, plotWidth]);
  const gaps = [], timeline = [view.context, ...view.points].filter(Boolean);
  for (let i = 1; i < timeline.length; i++) {
    const previous = timeline[i - 1], current = timeline[i];
    if (current.timestamp_ms - previous.timestamp_ms > threshold) gaps.push([previous.timestamp_ms, current.timestamp_ms]);
  }
  if (timeline.length) {
    const last = timeline.at(-1), until = Math.min(view.end, Date.now());
    if (until > last.timestamp_ms) gaps.push([Math.max(view.start, last.timestamp_ms), until]);
  }
  const latest = view.points.at(-1);
  const ids = new Set([...view.points, view.context].filter(Boolean).map(p => p.snapshot_id));
  const evidence = sourceRows.filter(p => ids.has(p.snapshot_id));
  const id = `quota-${window.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const clipId = `${id}-clip`;
  // A latest record a day old or more, on a chart that reaches into the present,
  // is said out loud: its percentage is not the balance of today.
  const staleDays = points.length && view.end > Date.now() - DAY ? daysAgo(points.at(-1).timestamp_ms) : 0;
  // Whether the selected range holds a record at all: then an empty chart is only a narrowed one.
  const inRange = fullRange && points.some(point => point.timestamp_ms >= fullRange.start_ms && point.timestamp_ms < fullRange.end_ms);
  const heading = <div className="usage-quota-latest" data-reviewed-rows><strong>{latest ? `${latest.remaining_percent}%` : "—"}</strong><span>{latest ? "最近一次观测" : "所选范围内没有记录"}</span>
    {staleDays >= 1 && <span className="usage-stale-chip">已 {staleDays} 天没有新记录</span>}</div>;
  const scopeFilters = [{ label: "时间范围", value: `${dateLabel(view.start, result.timezone)} 至 ${dateLabel(view.end, result.timezone)}` }, { label: "时区", value: result.timezone }, { label: "范围", value: "按账户统计 · 不按会话筛选" }];
  const description = "每个点是日志报告的账户额度，点之间不连线。可开启缺失记录背景，标出超过 15 分钟没有快照的时段。回升阴影标记两次观测之间的可能发生区间，不代表服务端实际重置时间或原因。";
  if (!view.points.length) return <DataComponent id={id} queryId="quota" kind="custom" title="账户剩余额度" description={description}
    variant="card" className="usage-quota-card usage-quota-card-quiet" displayRows={[]} sourceRows={evidence} scopeFilters={scopeFilters} headerControls={heading}>
    <div className="usage-quota-quiet">
      {inRange ? <p>图表现在显示的这段时间里没有额度记录。{onResetZoom && <Button onClick={onResetZoom}>显示整个时间范围</Button>}</p>
        : view.context ? <>
        <p>所选时间范围内没有额度记录。最近一次观测是 {dateLabel(view.context.timestamp, result.timezone)}，剩余 {view.context.remaining_percent}%。</p>
        {onShowRecorded && <Button onClick={() => onShowRecorded({ start: zoneMinute(view.context.timestamp_ms - 6 * DAY, result.timezone), end: zoneMinute(view.context.timestamp_ms + DAY / 2, result.timezone) })}>查看那前后的 7 天</Button>}
      </> : <p>所选时间范围内没有额度记录，日志里也还没有更早的观测。出现记录后会自动显示；不会从 Token 用量换算百分比。</p>}
    </div>
  </DataComponent>;
  return <DataComponent id={id} queryId="quota" kind="custom" title="账户剩余额度" description={description}
    variant="card" className="usage-quota-card" displayRows={view.points} sourceRows={evidence} scopeFilters={scopeFilters} headerControls={heading}>
    <div className="usage-quota-meta" data-reviewed-rows><span>{windowLabel(window.window_minutes)}</span><span>按账户统计 · 不随会话筛选</span>
      <InfoTooltip label="这些数字的来源"><p>日志里把这一项记作 {window.limit_id} / {window.slot}。额度按账户统计，日志不含可靠的账户身份，切换账户也可能造成变化。</p></InfoTooltip></div>
    <div className="usage-quota-meta" data-reviewed-rows><span>当前展示：{dateLabel(view.start, result.timezone)} ～ {dateLabel(view.end, result.timezone)} · {result.timezone}</span></div>
    <div className="usage-quota-toolbar">
      <div className="usage-quota-legend"><span><i />额度快照</span>{showGapBackground && <span><i className="usage-quota-gap-key" />缺少记录</span>}<span><i className="usage-quota-event-key" />额度回升的区间</span></div>
      <div className="usage-quota-tools"><Switch label="显示缺失记录背景" checked={showGapBackground} onChange={onGapBackgroundChange} size="compact" />
        <InfoTooltip label="怎么读这张图"><p>每个点代表一次额度快照，{showGapBackground ? "灰色空档没有记录" : "缺少记录的时段未着色"}；不推算中间百分比。回升区间的标记已加宽，宽度不代表实际时长；日志不含可靠账户身份，切换账户也可能造成变化。</p></InfoTooltip></div>
    </div>
    <div className="usage-chart-plot"><div className="usage-quota-plot" ref={ref} style={{ height: HEIGHT }} data-chart-interaction-root data-reviewed-rows>
      <svg width="100%" height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={`${windowLabel(window.window_minutes)}账户剩余额度，0 至 100%，${view.points.length} 条观测`}>
        <defs><clipPath id={clipId}><rect x={QUOTA_LEFT} y={TOP - 7} width={plotWidth} height={PLOT + 14} /></clipPath></defs>
        {[0, 25, 50, 75, 100].map(percent => <g key={percent}><line x1={QUOTA_LEFT} x2={width - QUOTA_RIGHT} y1={y(percent)} y2={y(percent)} stroke="var(--border)" strokeOpacity=".6" /><text x={QUOTA_LEFT - 9} y={y(percent) + 4} textAnchor="end" fill="var(--secondary)" fontSize="12">{percent}%</text></g>)}
        <g clipPath={`url(#${clipId})`}>
          {showGapBackground && gaps.map(([a, b], i) => <rect key={i} data-quota-gap-background x={x(Math.max(view.start, a))} y={TOP} width={Math.max(0, x(Math.min(view.end, b)) - x(Math.max(view.start, a)))} height={PLOT} fill="var(--control-hover)" opacity=".5" />)}
          {/* Apply transparency once to the composed layer. Overlapping
              recovery observations must not imply a stronger recovery. */}
          <g data-quota-recovery-layer opacity=".10">
            {events.map(event => <g key={event.id} data-quota-recovery data-narrow-interval={event.band.narrow || undefined}>
              <rect x={QUOTA_LEFT + (event.band.narrow ? event.band.cueStart : event.band.start)} y={TOP} width={event.band.narrow ? event.band.cueWidth : event.band.actualWidth} height={PLOT} fill="var(--quota-line)" data-recovery-visibility-cue={event.band.narrow || undefined} />
            </g>)}
          </g>
        </g>
        {labels.map(({ index, text }) => { const at = QUOTA_LEFT + (index + .5) / view.bins.length * plotWidth;
          return <text key={view.bins[index].id} x={at} y={TOP + PLOT + 22} textAnchor={at + 20 > width - QUOTA_RIGHT ? "end" : "middle"} fill="var(--secondary)" fontSize="12">{text}</text>; })}
      </svg>
      {events.map(event => <ChartMark key={event.id} className="usage-quota-recovery-mark" style={{ left: x(event.upper_ms), top: TOP, height: PLOT }}
        aria-label={`额度回升区间 ${dateLabel(event.lower_timestamp, result.timezone, true)} 至 ${dateLabel(event.upper_timestamp, result.timezone, true)}，${event.remaining_before}% 到 ${event.remaining_after}%`}
        tooltip={<RecoveryTooltip event={event} timezone={result.timezone} narrow={event.band.narrow} />}
        context={{ kind: "chart", chartType: "quota", label: "观察到额度回升", value: event.remaining_after, row: event.sourceRow }} />)}
      {marks.map(point => <ChartMark key={point.snapshot_id} className={`usage-quota-point${events.some(event => event.upper_ms === point.timestamp_ms) ? " is-recovery" : ""}`} style={{ left: x(point.timestamp_ms), top: y(point.remaining_percent) }}
        aria-label={`${dateLabel(point.timestamp, result.timezone, true)}，剩余额度 ${point.remaining_percent}%`}
        tooltip={<SnapshotTooltip point={point} timezone={result.timezone} />}
        context={{ kind: "chart", chartType: "quota", label: dateLabel(point.timestamp, result.timezone, true), value: point.remaining_percent, row: point }}><span /></ChartMark>)}
    </div></div>
    <div className="usage-model-caption" data-reviewed-rows><span>{number.format(view.points.length)} 条观测 · 与上方图表共用时间范围和缩放</span><span>最近观测 {dateLabel(latest.timestamp, result.timezone)}</span></div>
    {view.events.length > 0 && <details className="usage-quota-events" data-reviewed-rows><summary>观察到 {view.events.length} 次额度回升</summary><div className="usage-quota-event-table"><table><thead><tr><th>首次观察到</th><th>剩余额度变化</th><th>可能发生区间</th></tr></thead><tbody>{[...view.events].reverse().map(event => <tr key={event.id}><td><strong>{event.kind === "full_recovery" ? "恢复满额" : "额度回升"}</strong><span>{dateLabel(event.upper_timestamp, result.timezone, true)}</span></td><td>{event.remaining_before}% → {event.remaining_after}%</td><td>{dateLabel(event.lower_timestamp, result.timezone, true)} ～ {dateLabel(event.upper_timestamp, result.timezone, true)}<small>观测推断 · 原因未知{event.scheduled_reset_changed ? " · 预计重置时间也发生变化" : ""}</small></td></tr>)}</tbody></table></div></details>}
  </DataComponent>;
}

// Shown for sources whose local records carry no quota snapshots. It is plain
// copy: there are no rows behind it to inspect.
export function QuotaUnavailable({ provider }) {
  return <p className="usage-unavailable-line" role="note" aria-label="账户剩余额度"><strong>账户剩余额度</strong><span className="usage-unavailable-badge">未提供</span>
    {provider.label} 的本地记录不含账户额度，不做展示，也不从 Token 用量换算百分比。</p>;
}

export function QuotaCharts({ result, zoom, sourceRows, fullRange, onShowRecorded, onResetZoom }) {
  const quota = result.quota;
  const windows = (quota?.windows || []).filter(window => window.window_minutes !== 30 * 1440);
  const [showGapBackground, setShowGapBackground] = useState(() => {
    try { return localStorage.getItem("codex-usage:quota-gap-background") === "true"; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem("codex-usage:quota-gap-background", String(showGapBackground)); } catch {} }, [showGapBackground]);
  if (quota?.windows?.length && !windows.length) return null;
  return <section className="usage-quota-section" aria-label="账户额度变化">
    {windows.length ? windows.map(window => <QuotaWindow key={window.key} window={window} result={result} zoom={zoom} sourceRows={sourceRows} threshold={quota.gap_threshold_ms}
      showGapBackground={showGapBackground} onGapBackgroundChange={setShowGapBackground} fullRange={fullRange} onShowRecorded={onShowRecorded} onResetZoom={onResetZoom} />)
      : <section className="usage-rank-card" aria-label="账户剩余额度"><div className="usage-rank-head"><h2>账户剩余额度</h2></div><p className="usage-rank-empty">这个时间范围内没有可用的额度快照。日志中出现额度记录后会自动显示；不会从 Token 用量换算百分比。</p></section>}
  </section>;
}
