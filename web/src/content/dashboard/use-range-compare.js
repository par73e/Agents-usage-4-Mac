// Readings that stand beside the selected range: the same length of time just
// before it, and every agent's models over the range.
import { useEffect, useRef, useState } from "react";
import { post } from "./api.js";
import { PROVIDERS, providerIndexes } from "./providers.js";
import { previousRange } from "./range-compare.js";

// The count of the range just before the selected one, on the same sessions.
export function usePreviousPeriod({ provider, generation, applied, includeCompaction, selection, reconcile, refreshKey }) {
  const [state, setState] = useState({ status: "idle" });
  const request = useRef(0);
  const before = previousRange(applied);
  const key = JSON.stringify([provider.key, generation, before.start, before.end, applied.timezone, includeCompaction, selection, refreshKey]);
  useEffect(() => {
    const current = ++request.current;
    setState({ status: "loading", ...before });
    post("/api/v1/query", { provider: provider.key, generation, start: before.start, end: before.end, timezone: applied.timezone,
      granularity: "day", include_compaction: includeCompaction, sessions: selection })
      .then(data => { if (request.current === current) setState({ status: "ready", ...before, tokens: data.totals.total_tokens }); })
      .catch(async error => {
        // A changed index is read again once; a newer one asks again by itself.
        if (String(error.message).includes("重新载入") && reconcile) {
          const next = await reconcile();
          if (request.current !== current) return;
          if (next && providerIndexes(next.queries)[provider.key]?.generation !== generation) return;
        }
        if (request.current === current) setState({ status: "error", ...before });
      });
    return () => { request.current++; };
  }, [key]);
  return state;
}

// The models every agent used over the range, all sessions. Sessions differ
// between agents and are each agent's own choice, so the ranking stays with
// time. The result is small: a name, a count of tokens and a count of
// responses for each model.
export function useAgentModels({ applied, indexes, reconcile, refreshKey, codexCompaction }) {
  const [state, setState] = useState({ status: "loading", by: {} });
  const request = useRef(0);
  const key = JSON.stringify([applied.start, applied.end, applied.timezone, refreshKey, ...PROVIDERS.map(provider => indexes[provider.key]?.generation ?? null)]);
  const compaction = useRef(codexCompaction); compaction.current = codexCompaction;
  const ask = useRef(reconcile); ask.current = reconcile;
  useEffect(() => {
    const current = ++request.current;
    setState(previous => ({ status: "loading", by: previous.by }));
    (async () => {
      const entries = await Promise.all(PROVIDERS.map(async provider => {
        const index = indexes[provider.key];
        if (!index?.generation || index.record_count === 0) return [provider.key, { status: "empty" }];
        try {
          const data = await post("/api/v1/query", { provider: provider.key, generation: index.generation, start: applied.start, end: applied.end,
            timezone: applied.timezone, granularity: "day", include_compaction: provider.key === "codex" ? compaction.current : true, sessions: { mode: "all" } });
          return [provider.key, { status: "ready", models: data.models.map(({ name, tokens, responses }) => ({ name, tokens, responses })) }];
        } catch (error) {
          if (String(error.message).includes("重新载入") && ask.current) {
            const next = await ask.current();
            if (next && providerIndexes(next.queries)[provider.key]?.generation !== index.generation) return [provider.key, { status: "loading" }];
          }
          return [provider.key, { status: "error", message: error.message }];
        }
      }));
      if (request.current === current) setState({ status: "ready", by: Object.fromEntries(entries) });
    })();
    return () => { request.current++; };
  }, [key]);
  return state;
}
