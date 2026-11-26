import React from "react";
import { PROVIDERS } from "./providers.js";
import { short, exact, percent } from "./format.js";

const agentTotal = entry => (entry?.models || []).reduce((sum, model) => sum + model.tokens, 0);

// What share of the range each agent has, all sessions. It comes from the same
// reading as the model ranking, so the two never disagree.
export function AgentShare({ state }) {
  const totals = Object.fromEntries(PROVIDERS.map(provider => [provider.key, agentTotal(state.by[provider.key])]));
  const whole = Object.values(totals).reduce((sum, value) => sum + value, 0);
  return <section className="usage-agents" aria-label="各智能体用量" data-reviewed-rows>
    <div className="usage-agents-bar" aria-hidden="true">{whole > 0 && PROVIDERS.map(provider => totals[provider.key] > 0
      && <i key={provider.key} className={`usage-agent-${provider.key}`} style={{ width: `${totals[provider.key] / whole * 100}%` }} />)}</div>
    <ul className="usage-agents-list">
      {PROVIDERS.map(provider => {
        const entry = state.by[provider.key];
        return <li key={provider.key}><i className={`usage-agent-${provider.key}`} aria-hidden="true" /><span>{provider.label}</span>
          {entry?.status === "ready" ? <><strong title={exact(totals[provider.key])}>{short(totals[provider.key])}</strong><span>{percent(totals[provider.key], whole) ?? "0.0"}%</span></>
            : <span className={entry?.status === "error" ? "usage-stat-quiet is-error" : "usage-stat-quiet"}>{entry?.status === "empty" ? "没有记录" : entry?.status === "error" ? "未读到" : "读取中…"}</span>}
        </li>; })}
    </ul>
  </section>;
}
