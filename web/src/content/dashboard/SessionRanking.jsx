import React, { useMemo, useState } from "react";
import { Button } from "../../data-app-public.jsx";
import { sessionMeta } from "./providers.js";
import { short, exact, percent } from "./format.js";
import { downloadCsv } from "./csv.js";

const SHOWN = 10;

// Sessions of the range from largest to smallest. A row names one session;
// choosing it leaves only that session in the charts above, and choosing it
// again brings all of them back.
export function SessionRanking({ options, selection, provider, onSelect, timezone }) {
  const [all, setAll] = useState(false);
  const noun = provider.noun;
  const rows = useMemo(() => options.filter(option => option.tokens > 0).sort((a, b) => b.tokens - a.tokens), [options]);
  const whole = rows.reduce((sum, row) => sum + row.tokens, 0), largest = rows[0]?.tokens || 1;
  const shown = all ? rows : rows.slice(0, SHOWN);
  const name = row => row.title || row.id;
  const exportCsv = () => downloadCsv(`${noun}用量排名`, ["排名", noun, "Token", "占比 %", provider.unit],
    rows.map((row, index) => [index + 1, name(row), row.tokens, percent(row.tokens, whole) ?? "0.0", row.responses || 0]));
  return <section className="usage-rank-card" aria-label={`${noun}用量排名`} data-reviewed-rows>
    <div className="usage-rank-head"><h2>{noun}用量排名</h2><span className="usage-section-count">{rows.length} 个{noun}</span>
      <Button className="usage-export" onClick={exportCsv} disabled={!rows.length}>导出 CSV</Button></div>
    <p className="usage-rank-note">按当前时间范围统计每个{noun}的用量。点一个{noun}只看它，再点一次恢复全部。</p>
    {!rows.length ? <p className="usage-rank-empty">这个时间范围内没有{noun}用量记录。</p> : <>
      <ol className="usage-rank-list usage-rank-list-sessions">{shown.map((row, index) => {
        const only = selection.mode === "explicit" && selection.ids.length === 1 && selection.ids[0] === row.id;
        return <li className={`usage-rank-row${only ? " is-selected" : ""}`} key={row.id}>
          <span className="usage-rank-order">{index + 1}</span>
          <button type="button" className="usage-rank-name usage-rank-pick" onClick={() => onSelect(row.id)} aria-pressed={only}
            title={`${name(row)} · 点一下只看这个${noun}，再点恢复全部`}><span>{name(row)}</span><small>{sessionMeta(row, timezone).join(" · ")}</small></button>
          <span className="usage-rank-track" aria-hidden="true"><span className="usage-rank-fill" style={{ width: `${row.tokens / largest * 100}%` }}><i className={`usage-agent-${provider.key}`} style={{ width: "100%" }} /></span></span>
          <strong className="usage-rank-value" title={exact(row.tokens)}>{short(row.tokens)}</strong>
          <span className="usage-rank-share">{percent(row.tokens, whole) ?? "0.0"}%</span>
          <span className="usage-rank-count">{exact(row.responses || 0)} {provider.unit}{row.estimated_tokens ? " · 含估算" : ""}</span>
        </li>; })}</ol>
      {rows.length > SHOWN && <Button className="usage-rank-more" onClick={() => setAll(value => !value)}>{all ? `只看前 ${SHOWN} 个` : `显示全部 ${rows.length} 个${noun}`}</Button>}
    </>}
  </section>;
}
