import React from "react";
import { barChartSpec, EvidenceChart, SortableItem } from "../../data-app-public.jsx";
import { orderedTooltipSeries, cacheHitRate, cacheHitTooltipFields, tokenSeries } from "./token-series.js";
import { rangeLabel } from "./time-format.js";

const number = value => new Intl.NumberFormat("zh-CN").format(value ?? 0);
const compact = value => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value ?? 0);

// One model's usage over the visible buckets, coloured by effort or by composition.
// The evidence behind it is the selected source's own rows for this model.
export const ModelChart = React.memo(function ModelChart({ model, result, provider, mode, axis, usageRows, ...sortableProps }) {
  const series = tokenSeries(mode, model.efforts, model.buckets);
  const labelCounts = new Map();
  for (const bin of result.bins) labelCounts.set(bin.label, (labelCounts.get(bin.label) || 0) + 1);
  const rows = model.buckets.map((bucket, index) => {
    const bin = result.bins[index];
    const repeated = labelCounts.get(bin.label) > 1;
    const data = { period: bin.label + (repeated ? ` ${bin.offset}` : ""), range: rangeLabel(bin, result.timezone), start: bin.start, end: bin.end, total: bucket.responses ? bucket.tokens : null, responses: bucket.responses || null };
    for (const s of series) data[s.key] = bucket.responses ? mode === "effort" ? bucket.efforts[s.key] || 0 : bucket[s.key] || 0 : null;
    if (mode === "composition") data.cache_hit_rate = cacheHitRate(bucket.cached, bucket.tokens);
    return data;
  });
  const maximum = axis === "unified" ? Math.max(1, ...result.models.flatMap(item => item.buckets.map(bucket => bucket.tokens))) : Math.max(1, ...model.buckets.map(bucket => bucket.tokens));
  const spec = barChartSpec({ presentation: "plot", category: "period", categoryTickLayout: result.bins.some(bin => bin.label.includes(":")) ? "time-date" : "default", tooltipLabelField: "range", value: "total", valueWidth: 72, domain: [0, maximum * 1.08], grid: true, barCategoryGap: "25%", style: { thickness: 25, radius: 3 }, series: series.map(s => ({ ...s, stackId: "tokens" })), labels: { value: false }, format: { maximumFractionDigits: 0 },
    tooltipFields: [{ key: "total", label: "总用量 Token", color: "var(--secondary)" }, ...cacheHitTooltipFields(mode), ...orderedTooltipSeries(mode, series), { key: "responses", label: provider.countLabel, color: "var(--secondary)" }] });
  const ids = new Set(model.response_ids), sourceRows = usageRows.filter(row => ids.has(row.response_id));
  const id = "model-" + model.name.replace(/[^a-zA-Z0-9_-]/g, "-");
  return <SortableItem {...sortableProps} id={id} label={model.name} kind="chart" className="usage-model-item">
    <EvidenceChart id={id} queryId={provider.usageQuery} title={model.name === "unknown" ? "未知模型" : model.name} rows={rows} sourceRows={sourceRows} spec={spec} variant="card" height={285} className="usage-model-card"
      description={`${provider.chartNote}上方占比和合计覆盖整个查询区间。空缺表示所选时段内未发现记录。`}
      scopeFilters={[{ label: "时间范围", value: `${result.start} 至 ${result.end}` }, { label: "时区", value: result.timezone }, { label: "模型", value: model.name }]}
      headerControls={<div className="usage-model-total"><strong title={number(model.tokens)}>{compact(model.tokens)}</strong><span>tokens</span></div>}
      renderPlot={plot => <>
        <div className="usage-model-legend">{series.map(s => <span key={s.key}><i style={{ background: s.color }} /><span>{s.label}</span>{mode === "effort" && model.tokens > 0 && <strong title={`${number(model.efforts[s.key])} tokens`}>{(model.efforts[s.key] / model.tokens * 100).toFixed(1)}%</strong>}</span>)}</div>
        <div className="usage-chart-plot">{plot}</div>
      </>}
    >
      <div className="usage-model-caption"><span>{number(model.responses)} {provider.unit} · {axis === "unified" ? "统一纵轴" : "独立纵轴"}</span><span>{mode === "effort" ? "占比按整个区间的 Token 计算" : "缓存输入和推理输出均不重复计数"}</span></div>
    </EvidenceChart>
  </SortableItem>;
});
