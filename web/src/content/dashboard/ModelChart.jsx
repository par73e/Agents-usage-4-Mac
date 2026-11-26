import React from "react";
import { barChartSpec, EvidenceChart, InfoTooltip, SortableItem } from "../../data-app-public.jsx";
import { tokenSeries, cacheHitRate, cacheHitTooltipFields, orderedTooltipSeries, visibleShare } from "./token-series.js";
import { isUnknownModel, splitModelName, modelId } from "./models.js";
import { exact, short, percent, roundCeiling } from "./format.js";
import { rangeLabel } from "./time-format.js";
import { axisName } from "./time-ticks.js";

// A model far below the common scale would be a flat line on it. From this
// share of the tallest bar downwards a model gets a scale of its own.
const OWN_SCALE_BELOW = 0.08;

// What a heading leaves unsaid: the model had several ways of being written, or
// its name carries a route in front of it, or the log did not name it at all.
function NameNote({ group, merge }) {
  const unknown = isUnknownModel(group.names[0]);
  const tag = !merge && !unknown ? splitModelName(group.names[0]).tag : "";
  const merged = merge && group.names.length > 1;
  if (!unknown && !tag && !merged) return null;
  return <InfoTooltip label={`关于 ${group.title}`}>
    {unknown && <p>日志里没有记下这些记录用的模型，所以单独列在这里。</p>}
    {merged && <p>合并了 {group.names.length} 种写法：{group.names.join("、")}。</p>}
    {(merged || tag) && <p>斜杠前是日志记下的来源或路由标记，不是模型本身；这里按模型统计。</p>}
  </InfoTooltip>;
}

// One model's usage over the visible buckets, coloured by effort or by
// composition. The evidence behind it is the selected source's own rows for
// this model, or for every way of writing its name when those are merged.
export const ModelChart = React.memo(function ModelChart({ group, result, provider, mode, axis, compact, merge, usageRows, ...sortableProps }) {
  const series = tokenSeries(mode, group.efforts, group.buckets);
  const labelCounts = new Map();
  for (const bin of result.bins) labelCounts.set(bin.label, (labelCounts.get(bin.label) || 0) + 1);
  const rows = group.buckets.map((bucket, index) => {
    const bin = result.bins[index];
    const repeated = labelCounts.get(bin.label) > 1;
    const data = { period: axisName(bin, result.timezone) + (repeated ? ` ${bin.offset}` : ""), range: rangeLabel(bin, result.timezone), start: bin.start, end: bin.end, total: bucket.responses ? bucket.tokens : null, responses: bucket.responses || null };
    for (const s of series) data[s.key] = bucket.responses ? mode === "effort" ? bucket.efforts[s.key] || 0 : bucket[s.key] || 0 : null;
    if (mode === "composition") data.cache_hit_rate = cacheHitRate(bucket.cached, bucket.tokens);
    return data;
  });
  const tallest = Math.max(0, ...group.buckets.map(bucket => bucket.tokens));
  const shared = axis === "unified" && tallest >= result.scale * OWN_SCALE_BELOW;
  const scaleNote = axis === "independent" ? "独立纵轴" : shared ? "统一纵轴" : "自动独立纵轴";
  // A level under 0.05% of the whole reads as "0.0%" and is too thin to see.
  const legend = series.filter(s => mode !== "effort" || visibleShare(group.efforts[s.key], group.tokens));
  const spec = barChartSpec({ presentation: "plot", category: "period", categoryTickLayout: result.bins.some(bin => bin.label.includes(":")) ? "time-date" : "default", tooltipLabelField: "range", value: "total", valueWidth: 72,
    domain: [0, roundCeiling(axis === "independent" || !shared ? Math.max(1, tallest) : result.scale)], grid: true, barCategoryGap: "25%", style: { thickness: 25, radius: 3 },
    series: series.map(s => ({ ...s, stackId: "tokens" })), labels: { value: false }, format: { maximumFractionDigits: 0 },
    tooltipFields: [{ key: "total", label: "总用量 Token", color: "var(--secondary)" }, ...cacheHitTooltipFields(mode), ...orderedTooltipSeries(mode, series), { key: "responses", label: provider.countLabel, color: "var(--secondary)" }] });
  const ids = new Set(group.response_ids), sourceRows = usageRows.filter(row => ids.has(row.response_id));
  const id = modelId(group.key);
  return <SortableItem {...sortableProps} id={id} label={group.title} kind="chart" className="usage-model-item">
    <EvidenceChart id={id} queryId={provider.usageQuery} title={group.title} rows={rows} sourceRows={sourceRows} spec={spec} variant="card" height={compact ? 168 : 261} className="usage-model-card"
      description={`${provider.chartNote}上方占比和合计覆盖整个查询区间。空缺表示所选时段内未发现记录。`}
      scopeFilters={[{ label: "时间范围", value: `${result.start} 至 ${result.end}` }, { label: "时区", value: result.timezone }, { label: "模型", value: group.names.join("、") }]}
      headerControls={<div className="usage-model-total" data-reviewed-rows><strong title={exact(group.tokens)}>{short(group.tokens)}</strong><span>tokens</span><NameNote group={group} merge={merge} /></div>}
      renderPlot={plot => <>
        <div className="usage-model-legend">{legend.map(s => <span key={s.key}><i style={{ background: s.color }} /><span>{s.label}</span>{mode === "effort" && <strong title={`${exact(group.efforts[s.key])} tokens`}>{percent(group.efforts[s.key], group.tokens) ?? "0.0"}%</strong>}</span>)}</div>
        <div className="usage-chart-plot">{plot}</div>
      </>}
    >
      <div className="usage-model-caption" data-reviewed-rows>
        <span>{exact(group.responses)} {provider.unit} · <span title={axis === "unified" && !shared ? `用量不到用量最高模型的 ${Math.round(OWN_SCALE_BELOW * 100)}%，已自动改用独立纵轴` : undefined}>{scaleNote}</span></span>
        {merge && group.names.length > 1 && <span>含 {group.names.length} 种写法</span>}
      </div>
    </EvidenceChart>
  </SortableItem>;
});
