// How a model is named in the logs, and how names that mean the same model are
// brought together. Pure functions: no React, so tests can import them.

// A log often puts a route or an import tag in front of the model, as in
// "imported-2/gpt-6.2-sol" or "zhipu/glm-5.4". The part after the last slash is
// the model; what precedes it says where the call went.
export function splitModelName(name) {
  const text = String(name ?? "");
  const cut = text.lastIndexOf("/");
  return cut < 0 ? { model: text, tag: "" } : { model: text.slice(cut + 1), tag: text.slice(0, cut) };
}

export const isUnknownModel = name => !String(name ?? "") || String(name).toLowerCase() === "unknown";

// The model as a heading says it. ``merge`` off keeps the whole name as logged.
export const modelTitle = (name, merge = true) => isUnknownModel(name) ? "未知模型" : merge ? splitModelName(name).model : String(name);

// The same model, however it is written: case, spaces, hyphens and underscores
// are ignored. Dots stay, so "kimi-k3-1" and "kimi-k3.1-pro" remain two models.
export const modelKey = name => isUnknownModel(name) ? "unknown" : splitModelName(name).model.toLowerCase().replace(/[\s_-]+/g, "");

// A stable id for a model on the page, whatever characters its key holds.
export const modelId = key => "model-" + String(key).replace(/[^a-zA-Z0-9_-]/g, char => `-${char.charCodeAt(0).toString(16)}-`);

const addCounts = (a = {}, b = {}) => {
  const sum = { ...a };
  for (const [key, value] of Object.entries(b)) sum[key] = (sum[key] || 0) + value;
  return sum;
};
function addBuckets(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { ...a, tokens: a.tokens + b.tokens, responses: a.responses + b.responses, cached: a.cached + b.cached,
    uncached: a.uncached + b.uncached, cache_unknown: a.cache_unknown + b.cache_unknown, output: a.output + b.output,
    efforts: addCounts(a.efforts, b.efforts) };
}

// One chart's worth of rows is kept; the response lists of its parts are joined.
// Bins always come in the same order and count.
export function groupModels(models, merge = true) {
  const groups = new Map();
  for (const model of models) {
    const key = merge ? modelKey(model.name) : String(model.name);
    const group = groups.get(key);
    if (!group) { groups.set(key, { key, title: modelTitle(model.name, merge), names: [model.name], ...model }); continue; }
    group.names.push(model.name);
    for (const field of ["tokens", "responses", "cached", "uncached", "cache_unknown", "output"]) group[field] = (group[field] || 0) + (model[field] || 0);
    group.response_ids = [...group.response_ids, ...model.response_ids];
    group.efforts = addCounts(group.efforts, model.efforts);
    group.buckets = group.buckets.map((bucket, index) => addBuckets(bucket, model.buckets[index]));
  }
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens);
}

// Every model of every agent on one list, largest first. ``sources`` holds, for
// each agent, the models it used; ``by`` and ``responses`` split a row by agent.
export function rankModels(sources, merge = true) {
  const rows = new Map();
  for (const { agent, models = [] } of sources) {
    for (const model of models) {
      if (!(model.tokens > 0)) continue;
      const key = merge ? modelKey(model.name) : String(model.name);
      let row = rows.get(key);
      if (!row) rows.set(key, row = { key, title: modelTitle(model.name, merge), names: {}, by: {}, responses: {}, tokens: 0, count: 0, writings: new Set() });
      (row.names[agent] ||= []).push(model.name);
      row.by[agent] = (row.by[agent] || 0) + model.tokens;
      row.responses[agent] = (row.responses[agent] || 0) + (model.responses || 0);
      row.tokens += model.tokens;
      row.count += model.responses || 0;
      row.writings.add(model.name);
    }
  }
  return [...rows.values()].map(row => ({ ...row, writings: [...row.writings] })).sort((a, b) => b.tokens - a.tokens);
}
