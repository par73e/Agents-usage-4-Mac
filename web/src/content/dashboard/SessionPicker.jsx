import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { searchableText, sessionMeta } from "./providers.js";

const compact = value => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value || 0);

// Multi-select over the sessions, or tasks, that have usage in the applied range.
export function SessionPicker({ options, selection, onChange, disabled, noun = "会话", placeholder = "搜索会话的名称或 ID", timezone = "Asia/Shanghai" }) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const root = useRef(null), trigger = useRef(null), panel = useRef(null), searchBox = useRef(null);
  // How far the page was moved to show the list, and where it then was.
  const reveal = useRef({ by: 0, at: 0 });
  // A list closed from inside (Done, Escape, its own button) puts the page back.
  const close = () => {
    setOpen(false);
    const { by, at } = reveal.current;
    reveal.current = { by: 0, at: 0 };
    // A page scrolled by hand in the meantime is left where it is.
    if (by && Math.abs(window.scrollY - at) < 1) window.scrollTo({ top: at - by, behavior: "instant" });
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    // A press outside closes the list and is left to what it landed on, so the page stays.
    const click = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    const key = event => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", click); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", click); document.removeEventListener("keydown", key); };
  }, [open]);
  // A long list opens below the fold on a short window. As soon as the list is
  // in the page, the page moves by the least amount that shows it whole, and
  // closing puts it back; on a phone the list is a sheet that fits the window,
  // so nothing moves.
  useLayoutEffect(() => {
    if (!open) return;
    const list = panel.current, anchor = root.current;
    if (!list || !anchor) return;
    // Focusing the search must not move the page. A focus that scrolls would
    // move it first and by another amount, and closing could not undo that.
    searchBox.current?.focus({ preventScroll: true });
    const style = getComputedStyle(list);
    if (style.position === "fixed") return;
    // A narrow window may have no room to the right of the trigger. The list
    // slides left to the window's edge, and no further than its left edge.
    // Its place is read from the layout: the entrance animation moves it.
    const left = anchor.getBoundingClientRect().left + list.offsetLeft;
    const room = document.documentElement.clientWidth - 12 - left - list.offsetWidth;
    if (room < 0) list.style.left = `${Math.max(room, 12 - left)}px`;
    // The entrance animation moves the list a few pixels while it runs, so its
    // resting place is read from the layout, which the animation does not touch.
    const height = list.offsetHeight;
    const bottom = anchor.getBoundingClientRect().top + parseFloat(style.top) + height;
    const beyond = bottom + 8 - window.innerHeight;
    if (beyond > 0 && height + 60 <= window.innerHeight) {
      window.scrollBy({ top: beyond, behavior: "instant" });
      reveal.current = { by: beyond, at: window.scrollY };
    }
  }, [open]);
  const ids = selection.mode === "all" ? new Set(options.map(option => option.id)) : new Set(selection.ids);
  const toggle = id => { const next = new Set(ids); next.has(id) ? next.delete(id) : next.add(id); onChange({ mode: "explicit", ids: [...next] }); };
  const term = search.trim().toLowerCase();
  // Search reads the title and the line under it, dates included; it never changes the selection.
  const lines = useMemo(() => new Map(options.map(option => [option.id, searchableText(option, timezone)])), [options, timezone]);
  const shown = options.filter(option => !term || lines.get(option.id)?.includes(term));
  const label = selection.mode === "all" ? `全部${noun}` : ids.size ? `已选 ${ids.size} 个${noun}` : `请选择${noun}`;
  return <div className="usage-session-picker" ref={root}>
    <button className="usage-session-trigger" ref={trigger} type="button" disabled={disabled} aria-expanded={open} aria-controls="usage-session-options" aria-haspopup="dialog" onClick={() => open ? close() : setOpen(true)}>
      <span>{noun}</span><strong>{label}</strong><span className="usage-chevron" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" /></svg></span>
    </button>
    {open && <div className="usage-session-popover" id="usage-session-options" role="dialog" aria-label={`选择当前时间内的${noun}`} ref={panel}>
      <div className="usage-session-search"><input ref={searchBox} placeholder={placeholder} aria-label={`搜索${noun}`} value={search} onChange={event => setSearch(event.target.value)} /></div>
      <div className="usage-session-actions"><button type="button" disabled={disabled} onClick={() => onChange({ mode: "all", ids: [] })}>全选当前时间候选</button><button type="button" disabled={disabled} onClick={() => onChange({ mode: "explicit", ids: [] })}>清空</button><span>{ids.size} / {options.length}</span></div>
      <div className="usage-session-list">
        {shown.length ? shown.map(option => <label className="usage-session-row" key={option.id}>
          <input type="checkbox" disabled={disabled} checked={ids.has(option.id)} onChange={() => toggle(option.id)} />
          <span className="usage-session-name"><strong title={option.title}>{option.title}</strong><small>{sessionMeta(option, timezone).join(" · ")}</small></span>
          <span className="usage-session-tokens">{compact(option.tokens)}<small>tokens{option.estimated_tokens ? " · 含区间估算" : ""}</small></span>
        </label>) : <p className="usage-picker-empty">{options.length ? `没有符合搜索的${noun}` : "当前时间内没有用量记录"}</p>}
      </div>
      <div className="usage-picker-footer"><span>只列出所选时间内有 Token 消耗的{noun}</span><button type="button" className="usage-picker-done" onClick={close}>完成</button></div>
    </div>}
  </div>;
}
