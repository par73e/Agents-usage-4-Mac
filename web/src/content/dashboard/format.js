// How counts are written on the page. Two ways only: an exact count with
// thousands separators, kept for hover text and export, and a short form in 万
// and 亿 for headlines, legends, axes and tables.
const exactFormat = new Intl.NumberFormat("zh-CN");
const shortFormat = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 });

export const exact = value => exactFormat.format(Math.round(Number(value) || 0));

// Counts under one 万 are written in full; from there up, 万 and 亿 take over.
export function short(value) {
  const count = Number(value) || 0;
  return Math.abs(count) < 1e4 ? exactFormat.format(Math.round(count)) : shortFormat.format(count);
}

// A share in percent as text, or null when there is nothing to take a share of.
export function percent(part, whole, digits = 1) {
  if (!(whole > 0) || !(part > 0)) return null;
  return (part / whole * 100).toFixed(digits);
}

// The upper end of a value axis: the smallest round number, 1, 2, 2.5 or 5 times
// a power of ten, that is not below the tallest bar. Ticks inside such an end
// are round numbers too.
export function roundCeiling(value) {
  if (!(value > 0)) return 1;
  const unit = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * unit >= value * (1 - 1e-9)) return step * unit;
}

// Wall-clock fields of a moment in a zone, zero-padded.
const zoneFormats = new Map();
export function clockParts(value, timezone) {
  let format = zoneFormats.get(timezone);
  if (!format) {
    if (zoneFormats.size >= 12) zoneFormats.delete(zoneFormats.keys().next().value);
    format = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    zoneFormats.set(timezone, format);
  }
  const parts = {};
  for (const part of format.formatToParts(new Date(value))) if (part.type !== "literal") parts[part.type] = part.value;
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

// "11/25 18:09" in the zone.
export function dayTime(value, timezone) {
  const p = clockParts(value, timezone);
  return `${Number(p.month)}/${Number(p.day)} ${p.hour}:${p.minute}`;
}

// "2026/11/25 18:09:12" in the zone.
export function fullTime(value, timezone) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

// How many whole days a moment lies in the past, rounded down; negative for the future.
export const daysAgo = (then, now = Date.now()) => Math.floor((now - then) / 86400000);

// "11/19 16:59" for a wall-clock string such as "2026-11-19T16:59". It names
// clock times in the statistics zone, so it is never read as a Date.
export const wallText = value => {
  const [date, time] = String(value ?? "").split("T");
  if (!date) return "";
  const [, month, day] = date.split("-");
  return time ? `${Number(month)}/${Number(day)} ${time}` : `${Number(month)}/${Number(day)}`;
};
