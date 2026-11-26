// The selected range beside the one just before it, and a range that is mostly
// empty. Pure functions; the reading itself is in use-range-compare.js.
import { clockParts } from "./format.js";

// "2026-11-19T16:59" as a moment on a plain clock, with no zone to it.
function clock(value) {
  const [[year, month, day], [hour, minute]] = value.split("T").map(part => part.split("-").join(":").split(":").map(Number));
  return Date.UTC(year, month - 1, day, hour, minute);
}
const pad = number => String(number).padStart(2, "0");
const text = moment => { const date = new Date(moment); return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`; };

// The range of the same length that ends where the selected one starts. Both
// are counted on the wall clock of the statistics zone, so the same clock
// times are compared whatever the zone.
export function previousRange(applied) {
  const start = clock(applied.start), length = clock(applied.end) - start;
  return { start: text(start - length), end: applied.start, length };
}

// "2026-11-19T16:59" in the zone for a moment given in milliseconds.
export function zoneMinute(milliseconds, timezone) {
  const p = clockParts(milliseconds, timezone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// By how many percent one count stands above or below another.
export function changePercent(current, previous) {
  if (!(previous > 0) || current == null || !(Number(current) >= 0)) return null;
  return (current / previous - 1) * 100;
}

// The empty stretch at one end of a range that is too empty to be worth its
// blank part: at least ``minimum`` buckets and ``fraction`` of the range. It
// comes with the span that holds the records.
export function quietRange(result, timezone, minimum = 6, fraction = 0.35) {
  const bins = result?.bins, buckets = result?.total_buckets;
  if (!bins?.length || bins.length !== buckets?.length) return null;
  const used = buckets.map(bucket => bucket.tokens > 0);
  const first = used.indexOf(true), last = used.lastIndexOf(true), count = bins.length;
  if (first < 0) return null;
  const head = first, tail = count - 1 - last;
  const side = tail >= head ? "tail" : "head";
  const empty = side === "tail" ? tail : head;
  if (empty < minimum || empty / count < fraction) return null;
  const from = bins[Math.max(0, first - 1)], to = bins[Math.min(count - 1, last + 1)];
  return { side, empty, count, since: side === "tail" ? bins[last].end_ms : bins[first].start_ms,
    start: zoneMinute(from.start_ms, timezone), end: zoneMinute(to.end_ms, timezone) };
}
