// Wall-clock text in the statistics zone. One formatter is kept per zone.
const formats = new Map();
function formatter(timezone, precise) {
  const key = timezone + (precise ? ":precise" : "");
  if (!formats.has(key)) {
    if (formats.size >= 12) formats.delete(formats.keys().next().value);
    formats.set(key, new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", ...(precise ? { second: "2-digit", fractionalSecondDigits: 3 } : {}), hourCycle: "h23" }));
  }
  return formats.get(key);
}
export function formatTime(value, timezone, precise = false) {
  return formatter(timezone, precise).format(new Date(value));
}

// The heading of a bar's tooltip, the same in every chart: the whole span the
// bar stands for, e.g. "2026/11/25 11:00 ～ 2026/11/25 19:00". A bar cut short
// by the selected range says so, because its height is not comparable with a
// full one.
export const rangeLabel = (bin, timezone) => `${formatTime(bin.start, timezone)} ～ ${formatTime(bin.end, timezone)}${bin.partial ? " · 部分时段" : ""}`;
