import React, { useMemo, useState } from "react";
import { barChartSpec, Button, DataComponent, DataTable, EvidenceChart } from "../../data-app-public.jsx";
import { totalBreakdown, cacheHitRate, cacheHitTooltipFields, orderedTooltipSeries, visibleShare } from "./token-series.js";
import { exact, short, percent, roundCeiling, dayTime, wallText } from "./format.js";
import { changePercent } from "./range-compare.js";
import { downloadCsv } from "./csv.js";
import { formatTime, rangeLabel } from "./time-format.js";
import { UsageTable } from "./UsageTable.jsx";
import { axisName } from "./time-ticks.js";

function LegacyTable({ result, queryId }) {
  const rows = useMemo(() => result.legacy_intervals.map(row => ({
    interval_id: row.interval_id, session: row.title,
    period: `${row.start_unknown ? "起点未知" : formatTime(row.start, result.timezone, true)} ～ ${formatTime(row.end, result.timezone, true)}`,
    observed_tokens: row.total_tokens, selected_tokens: row.selected_tokens,
    note: [row.counter_reset ? "累计重置后的区间估算" : row.start_unknown ? "起点未知，按观测时段归入" : "区间估算，非精确时间点", ...(row.coarse_timestamp ? ["同一时间多读数，取最大值"] : [])].join(" · "),
  })), [result.legacy_intervals, result.timezone]);
  return <DataComponent id="legacy-interval-table" queryId={queryId} title="旧日志观测区间" kind="table" displayRows={rows} sourceRows={result.legacyEvidenceRows}
    description="覆盖顶部所选时间与会话，不随图表缩放裁剪；区间总量来自累计快照差值，所选范围部分按时长分摊。">
    <DataTable rows={rows} columns={[{ field: "session", label: "会话" }, { field: "period", label: "原始观测区间" }, { field: "observed_tokens", label: "原区间 Token" }, { field: "selected_tokens", label: "所选范围估算 Token" }, { field: "note", label: "精度说明" }]}
      caption="旧日志用量观测区间，覆盖所选日期及会话" rowKey="interval_id" />
  </DataComponent>;
}

// Usage of all models together over the visible buckets. Its evidence is the
// selected source's own rows; only Codex adds the pre-response history.
export const TotalUsageChart = React.memo(function TotalUsageChart({ result, quiet, mode, provider, comparison, onTrimRange }) {
  const [tableOpen, setTableOpen] = useState(false), [legacyOpen, setLegacyOpen] = useState(false);
  const { efforts, buckets, series } = useMemo(() => totalBreakdown(result, mode), [result, mode]);
  const rows = useMemo(() => buckets.map((bucket, index) => {
    const bin = result.bins[index];
    const row = { period: axisName(bin, result.timezone), range: rangeLabel(bin, result.timezone),
      total: bucket.tokens || null, recorded: bucket.tokens ? bucket.recorded : null, estimated: bucket.tokens ? bucket.estimated : null };
    for (const s of series) row[s.key] = bucket.tokens ? s.key === "estimated" ? bucket.estimated : mode === "effort" ? bucket.efforts[s.key] || 0 : bucket[s.key] || 0 : null;
    if (mode === "composition") row.cache_hit_rate = cacheHitRate(bucket.cached, bucket.tokens);
    return row;
  }), [buckets, series, mode, result.bins, result.timezone]);
  const hasLegacy = Boolean(provider.legacyQuery);
  const sourceRowsByQuery = useMemo(() => {
    const ids = new Set(result.models.flatMap(model => model.response_ids));
    const intervals = new Set(result.legacy_intervals.map(row => row.interval_id));
    return { [provider.usageQuery]: result.evidenceRows.filter(row => ids.has(row.response_id)),
      ...(hasLegacy ? { [provider.legacyQuery]: result.legacyEvidenceRows.filter(row => intervals.has(row.interval_id)) } : {}) };
  }, [provider, hasLegacy, result.models, result.evidenceRows, result.legacy_intervals, result.legacyEvidenceRows]);
  const noun = provider.noun;
  const total = result.totals.total_tokens, responses = result.response_count, estimated = result.totals.estimated_tokens || 0;
  // Cache hit over the whole range: cached input over all tokens, where the
  // source says which input was cached.
  const cached = buckets.reduce((sum, bucket) => sum + bucket.cached, 0);
  const cacheKnown = buckets.some(bucket => bucket.cached + bucket.uncached > 0);
  const change = changePercent(total, comparison?.tokens);
  const before = comparison?.status === "ready" ? `${wallText(comparison.start)} ～ ${wallText(comparison.end)}` : "";
  // A level under 0.05% of the whole reads as "0.0%" and is too thin to see.
  const legend = series.filter(s => s.key === "estimated" || mode !== "effort" || visibleShare(efforts[s.key], total));
  const spec = barChartSpec({ presentation: "plot", category: "period", categoryTickLayout: result.bins.some(bin => bin.label.includes(":")) ? "time-date" : "default",
    tooltipLabelField: "range", value: "total", valueWidth: 72, domain: [0, roundCeiling(Math.max(1, ...result.total_buckets.map(bucket => bucket.tokens)))], grid: true,
    barCategoryGap: "25%", style: { thickness: 25, radius: 3 }, series: series.map(s => ({ ...s, stackId: "total" })), labels: { value: false }, format: { maximumFractionDigits: 0 },
    tooltipFields: [{ key: "total", label: "总用量 Token" }, ...cacheHitTooltipFields(mode), ...orderedTooltipSeries(mode, series)] });
  // The table lists every bucket on one page, and only parts that hold something.
  const tableSeries = series.filter(s => rows.some(row => row[s.key] > 0));
  const tableRows = rows.map(row => ({ key: row.range, period: row.range, ...Object.fromEntries(tableSeries.map(s => [s.key, row[s.key] || 0])), total: row.total || 0 }));
  const sum = key => tableRows.reduce((acc, row) => acc + (row[key] || 0), 0);
  const tableColumns = [{ key: "period", label: "统计时段" }, ...tableSeries.map(s => ({ key: s.key, label: `${s.label} Token`, count: true, align: "right" })),
    { key: "total", label: "合计 Token", count: true, align: "right" }];
  const tableFooter = { period: "合计", ...Object.fromEntries([...tableSeries.map(s => s.key), "total"].map(key => [key, sum(key)])) };
  return <section className="usage-total-section" aria-label="所有模型合计用量">
    <EvidenceChart id="all-models-usage" queryId={provider.usageQuery} {...(hasLegacy ? { queryIds: [provider.usageQuery, provider.legacyQuery], sourceRowsByQuery } : { sourceRows: sourceRowsByQuery[provider.usageQuery] })}
      title="所有模型合计用量" rows={rows} spec={spec} variant="card" height={285}
      description={hasLegacy ? "跟随顶部时间、会话和图表缩放。逐响应明细按记录时间统计；旧日志的累计差值保留观测区间，按时长分摊到时间桶，表示估算而非精确时间点。"
        : `跟随顶部时间、${noun}和图表缩放。${provider.chartNote}`}
      scopeFilters={[{ label: "时间范围", value: `${result.start} 至 ${result.end}` }, { label: "时区", value: result.timezone }, { label: "范围", value: `所有模型 · 当前所选${noun}` }]}
      headerControls={<div className="usage-model-total"><strong title={exact(total)}>{short(total)}</strong><span>tokens</span></div>}
      renderPlot={plot => <><div className="usage-total-head"><div className="usage-model-legend">{legend.map(s => <span key={s.key}><i style={{ background: s.color }} /><span>{s.label}</span>{mode === "effort" && <strong title={`${exact(s.key === "estimated" ? estimated : efforts[s.key])} tokens`}>{percent(s.key === "estimated" ? estimated : efforts[s.key], total) ?? "0.0"}%</strong>}</span>)}</div>
        <div className="usage-total-stats" data-reviewed-rows>
          <span><strong>{exact(responses)}</strong> {provider.unit}</span>
          <span>每次 <strong title={exact(total / Math.max(1, responses))}>{short(total / Math.max(1, responses))}</strong> tokens</span>
          {cacheKnown && <span>缓存命中 <strong>{percent(cached, total) ?? "0.0"}%</strong></span>}
          {comparison?.status === "loading" ? <span className="usage-stat-quiet">正在对比上一时段…</span>
            : comparison?.status === "ready" && (change == null ? <span className="usage-stat-quiet" title={`上一时段 ${before} 没有记录`}>上一时段没有记录</span>
              : <span className={Math.abs(change) < 0.5 ? "is-flat" : change > 0 ? "is-up" : "is-down"} title={`上一时段 ${before}：${short(comparison.tokens)} tokens`}>
                较上一时段 {Math.abs(change) < 0.5 ? "基本持平" : <>{change > 0 ? "↑" : "↓"} {Math.abs(change).toFixed(1)}%</>}
              </span>)}
        </div></div><div className="usage-chart-plot">{plot}</div></>}>
      {estimated > 0 && <div className="usage-model-caption" data-reviewed-rows><span>逐响应明细 {short(result.totals.recorded_tokens)} · 旧日志区间估算 {short(estimated)}</span><span>旧累计不计入响应次数</span></div>}
      {quiet && <p className="usage-quiet-note" role="status">{quiet.side === "tail" ? `${dayTime(quiet.since, result.timezone)} 之后` : `${dayTime(quiet.since, result.timezone)} 之前`}没有用量记录，占所选范围的 {Math.round(quiet.empty / quiet.count * 100)}%。
        {onTrimRange && <Button onClick={() => onTrimRange({ start: quiet.start, end: quiet.end })}>只看有记录的时间</Button>}</p>}
      {result.legacy_intervals.length > 0 && <p className="usage-estimate-note">旧日志用量表示两个观测之间的累计增量，按时长分摊到各柱；不表示实际均匀消耗。模型、推理强度与压缩类型未可靠记录的部分不作推断。</p>}
      <details className="usage-total-detail" onToggle={event => setTableOpen(event.currentTarget.open)}><summary>查看合计用量表</summary>
        {tableOpen && <><UsageTable caption="所有模型合计用量，与当前图表显示范围一致" columns={tableColumns} rows={tableRows} footer={tableFooter} />
          <Button className="usage-export" onClick={() => downloadCsv("合计用量表", tableColumns.map(column => column.label), tableRows.map(row => [row.period, ...tableSeries.map(s => row[s.key]), row.total]))}>导出 CSV</Button></>}
      </details>
    </EvidenceChart>
    {result.legacy_intervals.length > 0 && <details className="usage-total-detail usage-legacy-detail" onToggle={event => setLegacyOpen(event.currentTarget.open)}><summary>查看旧日志观测区间 · {exact(result.legacy_intervals.length)} 条</summary>
      {legacyOpen && <LegacyTable result={result} queryId={provider.legacyQuery} />}</details>}
  </section>;
});
