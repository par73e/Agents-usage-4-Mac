// The local sources this dashboard can show, and the copy that differs between
// them. Pure data and functions: no React and no assets, so tests can import it.
import { localMinute, presetRange, rangeError, RANGE_PRESETS } from "./date-range.js";

export const PROVIDERS = Object.freeze([
  Object.freeze({
    key: "codex", label: "Codex", noun: "会话", unit: "次响应", countLabel: "响应次数",
    usageQuery: "usage", legacyQuery: "legacy_usage", quotaQuery: "quota",
    sourceLabel: "本机日志", origin: "~/.codex 下的响应日志",
    chartNote: "整次响应按日志时间归属；模型与推理强度为日志配置。",
  }),
  Object.freeze({
    key: "claude", label: "Claude Code", noun: "会话", unit: "次响应", countLabel: "响应次数",
    usageQuery: "claude_usage", sourceLabel: "本机会话记录", origin: "~/.claude/projects 下的会话记录",
    fileWord: "个会话记录文件", recordWord: "条唯一响应", detailWord: "逐响应明细", searchPlaceholder: "搜索会话的名称、项目或 ID",
    chartNote: "整次响应按记录时间归属；模型与推理强度取自会话记录。",
  }),
  Object.freeze({
    key: "antigravity", label: "Anti Gravity", noun: "任务", unit: "条记录", countLabel: "记录条数",
    usageQuery: "antigravity_usage", sourceLabel: "本机用量台账", origin: "Antigravity Pulse 的本地用量台账",
    fileWord: "个台账文件", recordWord: "条记录", detailWord: "逐条记录", searchPlaceholder: "搜索任务的 ID 或时间",
    chartNote: "每条记录按台账时间戳归属；模型与强度拆自台账的模型标签。",
  }),
]);

export const providerByKey = Object.freeze(Object.fromEntries(PROVIDERS.map(provider => [provider.key, provider])));
export const isProvider = key => Boolean(providerByKey[key]);

const GRANULARITIES = ["1h", "6h", "12h", "day"], MODES = ["effort", "composition"], AXES = ["unified", "independent"];
const oneOf = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const validZone = zone => { if (typeof zone !== "string" || !zone) return false; try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } };

export function parseStored(text) {
  try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
}

export function validSelection(value) {
  return value?.mode === "all" || value?.mode === "explicit" && Array.isArray(value.ids) && value.ids.every(id => typeof id === "string");
}

// A source that states an effort for none of its records opens in the composition view.
export function recordsEffort(index) {
  return !index?.record_count || (index.unknown_effort || 0) < index.record_count;
}

export function initialView(saved, defaults = {}, index = null) {
  const remembered = !rangeError(saved?.applied);
  const zone = remembered ? saved.applied.timezone : validZone(defaults.timezone) ? defaults.timezone : "Asia/Shanghai";
  const followNow = remembered ? saved.followNow !== false : true;
  const relativeKey = !remembered ? "last7d" : RANGE_PRESETS.some(preset => preset.key === saved.relativeKey) ? saved.relativeKey : null;
  // A saved range that follows "now" is as old as the last visit. Bring it up to
  // date here so the first query is already the one the page will keep showing.
  const applied = !remembered ? presetRange("last7d", zone)
    : followNow ? relativeKey ? presetRange(relativeKey, zone) : { ...saved.applied, end: localMinute(new Date(Date.now() + 60000), zone) }
    : saved.applied;
  return {
    applied, followNow, relativeKey,
    granularity: oneOf(saved?.granularity, GRANULARITIES, oneOf(defaults.granularity, GRANULARITIES, "6h")),
    mode: saved?.mode ? oneOf(saved.mode, MODES, "effort") : recordsEffort(index) ? oneOf(defaults.mode, MODES, "effort") : "composition",
    axis: oneOf(saved?.axis, AXES, oneOf(defaults.axis, AXES, "unified")),
    includeCompaction: saved?.includeCompaction ?? true,
    selection: validSelection(saved?.selection) ? { mode: saved.selection.mode, ids: [...(saved.selection.ids || [])] } : { mode: "all", ids: [] },
  };
}

// Per-source status. Older snapshots carried only the Codex one.
export function providerIndexes(queries = {}) {
  const indexes = {};
  for (const row of queries.providers?.rows || []) {
    const status = parseStored(row?.status_json);
    if (row?.provider && status) indexes[row.provider] = status;
  }
  const codex = parseStored(queries.index_state?.rows?.[0]?.status_json);
  if (!indexes.codex && codex) indexes.codex = codex;
  return indexes;
}

export const quotaAvailable = index => Boolean(index?.capabilities?.includes("quota_snapshots"));
export const compactionAvailable = index => Boolean(index?.capabilities?.includes("compaction_filter"));

const plain = value => String(value ?? 0);
const fallbackDate = value => value ? String(value).slice(0, 10) : "暂无记录";

// Sentences under "数据范围与统计说明". Numbers come from the source status;
// the source's own caveats are appended unchanged so they cannot drift from the
// inspector that shows the same text.
export function coverageNotes({ provider, index = {}, result, caveats = [], format = {} }) {
  const number = format.number || plain, date = format.date || fallbackDate, time = format.dateTime || date;
  const scan = index.scan || {};
  const codex = provider.key === "codex";
  const notes = [];
  if (codex) {
    notes.push(`读取 ${number(index.file_count)} 个文件，其中 ${number(index.compressed_file_count)} 个压缩日志；索引 ${number(index.record_count)} 条唯一响应、${number(index.quota_record_count)} 条额度快照。仅覆盖本机保留的日志。`);
    notes.push(`逐响应明细起于 ${date(index.first)}；额度快照起于 ${date(index.quota_first)}。`);
    if (index.legacy_only_files > 0) notes.push(`${number(index.legacy_only_files)} 个日志只有旧版累计用量（${date(index.legacy_first)} ～ ${date(index.legacy_latest)}），未冒充逐响应明细。这些记录已作为区间估算计入合计图，不猜测模型和推理强度。`);
    if (index.compressed_file_count > 0 && !index.zstd_available) notes.push("本机未找到 zstd 工具，压缩日志尚未纳入统计。");
  } else {
    notes.push(`读取 ${number(index.file_count)} ${provider.fileWord}，索引 ${number(index.record_count)} ${provider.recordWord}。`);
    notes.push(`${provider.detailWord}起于 ${date(index.first)}。`);
    if (scan.untitled_sessions > 0) notes.push(`${number(scan.untitled_sessions)} 个会话没有标题记录，以会话 ID 显示。`);
    if (scan.untitled_tasks > 0) notes.push(`${number(scan.untitled_tasks)} 个任务在 Anti Gravity 的对话列表里没有名字，以任务编号显示。`);
    if (scan.titles_unavailable) notes.push("Anti Gravity 的对话列表暂时读不到，任务以编号显示。");
    if (scan.partial_records > 0) notes.push(`含 ${number(scan.partial_records)} 条被台账标记为不完整（partial）的记录。`);
  }
  if (scan.unreadable_files > 0) notes.push(`本轮有 ${number(scan.unreadable_files)} 个文件无法读取，保留之前成功索引的记录，稍后重试。`);
  if (codex) {
    const coverage = index.index_coverage;
    notes.push(coverage?.available ? coverage.missing_log_files ? `聊天索引中 ${number(coverage.missing_log_files)} 个源日志路径缺失（已检查压缩存档）；缺失历史无法重建。` : "聊天索引关联的日志均已找到，压缩存档不计为缺失。" : "聊天标题索引不可用时，使用会话 ID 显示。");
    notes.push("总量＝输入＋输出。缓存输入已在输入内，推理输出已在输出内。推理强度占比按本模型全区间总 Token 计算，未知强度仍计入分母。");
    notes.push("合计图包含单独着色的旧日志区间估算；输入、输出等明细字段仅含逐响应记录，旧累计未知的压缩类型不随压缩开关排除。模型和强度为日志配置。空白时间段表示现存日志未找到记录；不能认定完整账户在该时段零消耗。整次响应按其记录时间归属。");
  }
  notes.push(`最后刷新 ${time(index.updated_at)}${codex ? ` · 跳过异常 ${number(scan.invalid_records)} · 冲突响应 ${number(index.conflicting_responses)}` : ""}`);
  return [...notes, ...caveats.filter(Boolean), ...(result?.warnings || [])];
}

// Zero-padded like the chart's own axis labels.
function clock(value, zone) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const pick = type => parts.find(part => part.type === type)?.value;
  return { day: `${pick("month")}/${pick("day")}`, time: `${pick("hour")}:${pick("minute")}` };
}

// "11/25 18:09 – 18:47" within one day, "11/23 21:39 – 11/25 18:20" across days.
export function spanLabel(first, latest, timezone = "Asia/Shanghai") {
  if (!first || !latest) return "";
  const zone = validZone(timezone) ? timezone : "UTC";
  try {
    const a = clock(first, zone), b = clock(latest, zone);
    return a.day === b.day ? `${a.day} ${a.time} – ${b.time}` : `${a.day} ${a.time} – ${b.day} ${b.time}`;
  } catch { return ""; }
}

// One quiet line under a session title: what it is, where it ran, when, and its
// id. Kind and id are left out when the title already says them.
export function sessionMeta(option, timezone = "Asia/Shanghai") {
  const title = String(option.title || "");
  const parts = [option.kind && !title.startsWith(option.kind) ? option.kind : null, option.project, spanLabel(option.first, option.latest, timezone)].filter(Boolean);
  const suffix = String(option.id || "").slice(-8);
  if (suffix && !title.endsWith(suffix)) parts.push(suffix);
  return parts;
}

// Everything the list shows for one option, as one lower-cased line. Search
// matches this, so a date such as "11/24" finds what was active that day.
export function searchableText(option, timezone = "Asia/Shanghai") {
  return [option.title, option.id, ...sessionMeta(option, timezone)].filter(Boolean).join(" ").toLowerCase();
}

export const removedNotice = (count, noun) => `${count} 个${noun}在这个范围内无用量，已移出选择。`;

// The saved view each other source receives when a range is applied to every
// source: its own view with only the range replaced, as if the range had been
// chosen there. Granularity, sessions, colour mode and axis stay its own. A
// source never opened gets the range alone, so its first visit still starts
// from the last used settings.
export function rangeForOthers(current, range, followNow, relativeKey, load = () => null) {
  return PROVIDERS.filter(provider => provider.key !== current).map(provider => {
    const stored = parseStored(load(provider.key));
    return { key: provider.key, view: { ...(stored ? initialView(stored, {}, null) : {}),
      applied: { start: range.start, end: range.end, timezone: range.timezone }, followNow, relativeKey: relativeKey || null } };
  });
}

export const sharedRangeNotice = count => `时间范围已应用到全部 ${count} 个平台。`;

// The line under the title after a sync that did not finish. A source the scan
// could not be read keeps the rows it last returned, while every other source
// was refreshed; ``failures`` maps each such source to its reason.
export function syncFailureText(reason, failures = {}) {
  const failed = Object.keys(failures || {});
  if (!failed.length) return `同步中断：${reason}。仍显示最近一次成功读取的数据，请手动重试。`;
  const detail = failed.map(key => `${providerByKey[key]?.label || key}（${failures[key]}）`).join("、");
  const kept = failed.length >= PROVIDERS.length ? "各平台保留上次成功读取的数据"
    : `${failed.length === 1 ? "该平台" : "这些平台"}保留上次成功读取的数据，其他平台已照常刷新`;
  return `日志读取失败：${detail}。${kept}，请手动重试。`;
}

// Shown instead of the charts when the selected source has no local records at all.
export function emptySource(provider) {
  return { title: `本机没有 ${provider.label} 的使用记录`,
    body: `未读取到 ${provider.origin}。使用 ${provider.label} 后点击“立即同步”，新记录会出现在这里。` };
}

export function emptyResult({ provider, selection, legacyOnly }) {
  if (selection.mode === "explicit" && !selection.ids.length) return { title: `尚未选择${provider.noun}`, body: `选择一个或多个${provider.noun}，或恢复全选。` };
  if (legacyOnly) return { title: "这个区间没有可归属模型的逐响应明细", body: "旧日志的区间估算已显示在上方合计图；原始观测区间可展开查看。" };
  return { title: "这个区间没有匹配记录", body: "尝试调整时间范围，再应用查询。" };
}
