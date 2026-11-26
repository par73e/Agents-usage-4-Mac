// Where the time labels of a chart that draws its own axis go. Pure functions.
import { clockParts } from "./format.js";

const MINUTE = 60000, DAY = 1440 * MINUTE;

// The moment of a wall-clock time in a zone. The zone's offset at that moment
// is found in two passes, which is enough for every zone there is.
export function zonedTime(zone, year, month, day, hour, minute) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let moment = target;
  for (let pass = 0; pass < 2; pass++) {
    const p = clockParts(moment, zone);
    moment += target - Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  }
  return moment;
}

// The first moment at or after ``moment`` whose wall clock in the zone is a
// whole multiple of ``step`` minutes into its day.
export function roundUp(moment, zone, step) {
  const p = clockParts(moment, zone), year = Number(p.year), month = Number(p.month), day = Number(p.day);
  const into = Number(p.hour) * 60 + Number(p.minute);
  const slot = Math.ceil(into / step) * step;
  if (slot < DAY / MINUTE) return zonedTime(zone, year, month, day, Math.floor(slot / 60), slot % 60);
  const next = clockParts(zonedTime(zone, year, month, day, 0, 0) + DAY, zone);
  return zonedTime(zone, Number(next.year), Number(next.month), Number(next.day), 0, 0);
}

// Cadences from coarse to fine: a day, half a day, six hours, three hours.
const CADENCES = [1440, 720, 360, 180];

// The buckets that carry a time label. A label is put where a round clock time
// falls, the start of a day wherever the buckets let it, and only as many as
// fit side by side. It names a day by its date and any other time by its clock.
// ``index`` is the bucket a label sits under, ``at`` the moment it names.
export function timeTicks(bins, timezone, width, spacing = 74) {
  if (!bins.length) return [];
  const fit = Math.max(1, Math.floor(width / spacing));
  const start = bins[0].start_ms, end = bins.at(-1).end_ms;
  const bucketOf = ms => {
    let low = 0, high = bins.length - 1;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (bins[middle].start_ms <= ms) low = middle; else high = middle - 1; }
    return low;
  };
  const label = ms => {
    const p = clockParts(ms, timezone);
    return p.hour === "00" && p.minute === "00" ? `${p.month}/${p.day}` : `${p.hour}:${p.minute}`;
  };
  for (const step of CADENCES) {
    const found = [];
    for (let ms = roundUp(start, timezone, step); ms < end && found.length < 400; ms = roundUp(ms + step * MINUTE, timezone, step)) found.push({ ms, index: bucketOf(ms) });
    // A bucket wider than the cadence keeps the first of the times it holds.
    const once = found.filter((tick, order) => !order || tick.index !== found[order - 1].index);
    const stride = Math.max(1, Math.ceil(once.length / fit));
    const ticks = once.filter((_tick, order) => order % stride === 0);
    if (ticks.length >= 3 || step === CADENCES.at(-1)) return ticks.map(tick => ({ index: tick.index, text: label(tick.ms), at: tick.ms }));
  }
  return [];
}

// How a bucket is named on an axis: by its date alone when it starts a day,
// and by its own name otherwise. The date is taken from the bucket's own name,
// so it is written the way every other name is.
export function axisName(bin, timezone) {
  const p = clockParts(bin.start_ms, timezone);
  return p.hour === "00" && p.minute === "00" ? bin.label.split(" ")[0] : bin.label;
}
