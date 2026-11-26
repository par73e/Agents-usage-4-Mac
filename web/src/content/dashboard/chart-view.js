// Limit drawn categories, not evidence or query precision. The existing zoom
// slider keeps original bucket indices and restores exact buckets when close.
import { clockParts } from "./format.js";

export const MAX_PLOT_BUCKETS = 120;
const STRIDES = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168, 336, 720];
const DAY_MINUTES = 1440;
const VALUES = ["tokens", "responses", "cached", "uncached", "cache_unknown", "output"];

// A merged bar has a width that cuts a day into equal parts or spans whole
// days, so that its label can sit at the start of a day.
const cutsDaysEvenly = minutes => DAY_MINUTES % minutes === 0 || minutes % DAY_MINUTES === 0;

// The width of one bucket in minutes: the width most full buckets have. The
// first and the last are cut to the selected range and do not count.
function bucketMinutes(bins) {
  const widths = new Map();
  for (let i = 1; i < bins.length - 1; i++) {
    const width = (bins[i].end_ms - bins[i].start_ms) / 60000;
    widths.set(width, (widths.get(width) || 0) + 1);
  }
  const common = [...widths.entries()].sort((a, b) => b[1] - a[1])[0];
  return common ? common[0] : (bins.at(-1).end_ms - bins[0].start_ms) / 60000 / Math.max(1, bins.length - 1);
}

// Where merged bars start, as a number of buckets after the first one shown:
// the offset that makes the most of them begin at the start of a day and, among
// equals, the smallest. A bar before that offset, when there is one, is short.
function dayPhase(bins, from, to, stride, timezone) {
  const intoDay = ms => { const p = clockParts(ms, timezone); return Number(p.hour) * 60 + Number(p.minute); };
  let phase = 0, best = -Infinity;
  for (let offset = 0; offset < stride && from + offset <= to; offset++) {
    let atDayStart = 0;
    for (let index = from + offset; index <= to; index += stride) if (intoDay(bins[index].start_ms) === 0) atDayStart++;
    const score = atDayStart - offset / (stride + 1);
    if (score > best) { best = score; phase = offset; }
  }
  return phase;
}

export function buildChartView(result, zoom, limit = MAX_PLOT_BUCKETS) {
  if (!result) return null;
  const start = Math.max(0, Math.min(result.bins.length - 1, zoom[0]));
  const end = Math.max(start, Math.min(result.bins.length - 1, zoom[1]));
  const count = end - start + 1;
  const needed = Math.max(1, Math.ceil(count / Math.max(1, limit)));
  const width = bucketMinutes(result.bins);
  const stride = STRIDES.find(value => value >= needed && cutsDaysEvenly(value * width)) || needed;
  const phase = stride > 1 ? dayPhase(result.bins, start, end, stride, result.timezone) : 0;
  const groups = [];
  for (let from = start; from <= end;) {
    const to = from === start && phase > 0 ? start + phase : Math.min(end + 1, from + stride);
    groups.push([from, to]);
    from = to;
  }
  // A bar of one bucket is that bucket itself, not a copy of it.
  const bins = groups.map(([from, to]) => {
    const first = result.bins[from], last = result.bins[to - 1];
    return to - from === 1 ? first : { ...first, id: `${first.id}/${last.id}`, end: last.end, end_ms: last.end_ms,
      partial: first.partial || last.partial, bucket_count: to - from };
  });
  const models = result.models.map(model => ({ ...model, buckets: groups.map(([from, to], index) => {
    if (to - from === 1) return model.buckets[from];
    const bucket = { id: bins[index].id, efforts: {}, ...Object.fromEntries(VALUES.map(field => [field, 0])) };
    for (let i = from; i < to; i++) {
      const source = model.buckets[i];
      for (const field of VALUES) bucket[field] += source[field] || 0;
      for (const [effort, tokens] of Object.entries(source.efforts)) bucket.efforts[effort] = (bucket.efforts[effort] || 0) + tokens;
    }
    return bucket;
  }) }));
  const total_buckets = result.total_buckets?.length ? groups.map(([from, to], index) => {
    const bucket = { id: bins[index].id, tokens: 0, recorded: 0, estimated: 0, responses: 0 };
    for (let i = from; i < to; i++) for (const field of ["tokens", "recorded", "estimated", "responses"]) bucket[field] += result.total_buckets[i][field] || 0;
    return bucket;
  }) : [];
  return { ...result, bins, models, total_buckets, overviewStride: stride, overviewWidth: stride * width, visibleBucketCount: count };
}
