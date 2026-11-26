import React, { useEffect, useState } from "react";
import { Button, SegmentedControl, Switch } from "../../data-app-public.jsx";
import { PROVIDERS } from "./providers.js";
import { rankModels } from "./models.js";
import { short, exact, percent, wallText } from "./format.js";
import { zoneLabel } from "./date-range.js";
import { downloadCsv } from "./csv.js";

const SHOWN = 12;

// Models from largest to smallest: those of the agent on screen, or of every
// agent together. A row of the list is one model. When agents are combined, its
// bar is split by agent, each in its own colour.
export function ModelRanking({ state, provider, applied, merge, onMergeChange }) {
  const [scope, setScope] = useState(() => { try { return localStorage.getItem("codex-usage:rank-scope:" + provider.key) === "all" ? "all" : "current"; } catch { return "current"; } });
  const [all, setAll] = useState(false);
  useEffect(() => { try { localStorage.setItem("codex-usage:rank-scope:" + provider.key, scope); } catch {} }, [provider.key, scope]);
  const agents = scope === "all" ? PROVIDERS : [provider];
  const entryOf = agent => state.by[agent.key];
  // Every agent was asked for the same range, so their counts add up.
  const rows = rankModels(agents.filter(agent => entryOf(agent)?.status === "ready").map(agent => ({ agent: agent.key, models: entryOf(agent).models })), merge);
  const whole = rows.reduce((sum, row) => sum + row.tokens, 0);
  const largest = rows[0]?.tokens || 1;
  const waiting = agents.some(agent => !entryOf(agent) || entryOf(agent).status === "loading");
  const failed = agents.filter(agent => entryOf(agent)?.status === "error");
  const countWord = scope === "all" ? "条记录" : provider.unit;
  const shown = all ? rows : rows.slice(0, SHOWN);
  const totals = Object.fromEntries(agents.map(agent => [agent.key, (entryOf(agent)?.models || []).reduce((sum, model) => sum + model.tokens, 0)]));
  const agentWhole = Object.values(totals).reduce((sum, value) => sum + value, 0);
  const exportCsv = () => downloadCsv("模型用量排名", ["排名", "模型", ...agents.map(agent => `${agent.label} Token`), "合计 Token", "占比 %"],
    rows.map((row, index) => [index + 1, row.title, ...agents.map(agent => row.by[agent.key] || 0), row.tokens, percent(row.tokens, whole) ?? "0.0"]));
  return <section className="usage-rank-card" aria-label="模型用量排名" data-reviewed-rows>
    <div className="usage-rank-head">
      <h2>模型用量排名</h2>
      <SegmentedControl ariaLabel="排名范围" value={scope} onChange={setScope} options={[{ value: "current", label: provider.label }, { value: "all", label: "全部智能体" }]} />
      <Switch label="合并同一模型的不同写法" checked={merge} onChange={onMergeChange} size="compact" />
      <Button className="usage-export" onClick={exportCsv} disabled={!rows.length}>导出 CSV</Button>
    </div>
    <p className="usage-rank-note">按当前时间范围（{wallText(applied.start)} ～ {wallText(applied.end)}，{zoneLabel(applied.timezone)}）统计全部{provider.noun}，不随上方的{provider.noun}筛选变化。</p>
    {scope === "all" && <div className="usage-rank-legend">{agents.map(agent => <span key={agent.key}><i className={`usage-agent-${agent.key}`} aria-hidden="true" />{agent.label}
      {entryOf(agent)?.status === "ready" ? <><strong title={exact(totals[agent.key])}>{short(totals[agent.key])}</strong><span>{percent(totals[agent.key], agentWhole) ?? "0.0"}%</span></>
        : <span>{entryOf(agent)?.status === "empty" ? "没有记录" : "未读到"}</span>}</span>)}</div>}
    {!rows.length ? <p className="usage-rank-empty">{waiting ? "正在读取各智能体的用量…" : "这个时间范围内没有模型用量记录。"}</p> : <>
      <ol className="usage-rank-list">{shown.map((row, index) => <li className="usage-rank-row" key={row.key}>
        <span className="usage-rank-order">{index + 1}</span>
        <span className="usage-rank-name" title={row.writings.join("、")}>{row.title}{merge && row.writings.length > 1 && <small>{row.writings.length} 种写法</small>}</span>
        <span className="usage-rank-track" role="img" aria-label={agents.filter(agent => row.by[agent.key] > 0).map(agent => `${agent.label} ${short(row.by[agent.key])}`).join("，")}>
          <span className="usage-rank-fill" style={{ width: `${row.tokens / largest * 100}%` }}>{agents.map(agent => row.by[agent.key] > 0
            && <i key={agent.key} className={`usage-agent-${agent.key}`} style={{ width: `${row.by[agent.key] / row.tokens * 100}%` }} />)}</span></span>
        <strong className="usage-rank-value" title={exact(row.tokens)}>{short(row.tokens)}</strong>
        <span className="usage-rank-share">{percent(row.tokens, whole) ?? "0.0"}%</span>
        <span className="usage-rank-count">{exact(row.count)} {countWord}</span>
      </li>)}</ol>
      {rows.length > SHOWN && <Button className="usage-rank-more" onClick={() => setAll(value => !value)}>{all ? `只看前 ${SHOWN} 个` : `显示全部 ${rows.length} 个模型`}</Button>}
      {failed.length > 0 && <p className="usage-rank-note">未能读到 {failed.map(agent => agent.label).join("、")} 的用量，排名暂不含它们。点“立即同步”后再试。</p>}
    </>}
  </section>;
}
