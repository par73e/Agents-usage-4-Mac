import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function generation(snapshot) {
  return snapshot.queries?.index_state?.rows?.[0]?.generation;
}

// ``settle`` hands back the body of a failed request that still carries the
// index status, which is what a scan answers with when a source cannot be read.
async function jsonRequest(path, options = {}, settle = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // The browser reports a refused or dropped connection as a TypeError.
    let response;
    try { response = await fetch(path, { cache: "no-store", ...options, signal: controller.signal }); }
    catch (error) { throw error.name === "TypeError" ? new Error("无法连接本机服务") : error; }
    const value = await response.json();
    if (!response.ok && !(settle && typeof value?.generation === "string"))
      throw new Error(value.refresh_error || value.error || "本机服务暂时不可用");
    return value;
  } finally { clearTimeout(timer); }
}

// Poll only lightweight status. Download reviewed rows atomically when their
// generation changes; the chart and source inspector then see the same data.
export function useLiveUsage(initialSnapshot, enabled) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [state, setState] = useState({ connected: false, busy: false, error: "", failures: {}, checkedAt: null });
  // The newest snapshot this hook holds. It answers a caller that needs to know,
  // once a sync is over, whether the rows it asked with are still the current ones.
  const latest = useRef(initialSnapshot);
  const currentGeneration = useRef(null), pending = useRef(null), mounted = useRef(false);
  // Resolves with the newest snapshot once this sync, and any earlier one, is over.
  const synchronize = useCallback(async (force = false) => {
    if (!enabled) return;
    if (pending.current) {
      await pending.current;
      if (!force) return latest.current;
    }
    const request = (async () => {
      if (mounted.current && force) setState(s => ({ ...s, busy: true }));
      try {
        const status = await jsonRequest(force ? "/api/v1/index/refresh" : "/api/v1/status",
          force ? { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" } : {}, force);
        // Rows are read whenever they changed, after a scan that failed too. A
        // source that could not be read holds the rows it last returned and the
        // others hold their newest ones; keeping the old rows here would leave
        // a refreshed source asking with an outdated identity and no charts.
        if (status.generation !== currentGeneration.current) {
          const next = await jsonRequest("/api/v1/snapshot");
          if (next.id !== initialSnapshot.id || !generation(next) || !Array.isArray(next.queries?.usage?.rows))
            throw new Error("本机数据版本不完整，稍后自动重试");
          if (mounted.current) {
            currentGeneration.current = generation(next);
            latest.current = next;
            setSnapshot(next);
          }
        }
        if (status.refresh_error)
          throw Object.assign(new Error(status.refresh_error), { failures: status.refresh_failures || {} });
        if (mounted.current) setState({ connected: true, busy: false, error: "", failures: {}, checkedAt: status.checked_at, interval: status.poll_interval });
      } catch (error) {
        if (mounted.current) setState(s => ({ ...s, connected: false, busy: false, failures: error.failures || {},
          error: error.name === "AbortError" ? "本机服务响应超时" : error.message }));
      }
      return latest.current;
    })();
    pending.current = request;
    try { return await request; } finally { if (pending.current === request) pending.current = null; }
  }, [enabled, initialSnapshot.id]);

  useEffect(() => {
    if (!enabled) return;
    mounted.current = true;
    void synchronize();
    return () => { mounted.current = false; };
  }, [enabled, synchronize]);

  const refresh = useCallback(() => synchronize(true), [synchronize]);
  const reconcile = useCallback(() => synchronize(false), [synchronize]);
  const control = useMemo(() => enabled ? { ...state, refresh, reconcile } : undefined, [enabled, state, refresh, reconcile]);
  return { snapshot, control };
}
