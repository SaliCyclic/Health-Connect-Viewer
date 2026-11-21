// ============================================================================
// Data sources: several apps often record the same thing (a phone and a watch
// both counting steps). Adding them up double-counts, so by default the viewer
// combines them the way Health Connect does: where records from different apps
// overlap in time, only the highest-priority app's record counts for that time.
//
// Priority comes from the user's own Health Connect settings when the export
// includes them (health_data_category_priority_table); otherwise apps with more
// records rank higher.
// ============================================================================

const COMBINED = "combined", ALL = "all";

async function sourcesFor(table) {
  if (!hasCol(table, "app_info_id")) return [];
  const tc = timeCols(table);
  const where = tc ? `WHERE ${tc.t} BETWEEN ${S.from} AND ${S.to}` : "";
  return (await q(`SELECT app_info_id, count(*) FROM ${table} ${where} GROUP BY 1 ORDER BY 2 DESC`)).map(([id, n]) => ({ id, n }));
}
// Apps for a category in priority order: the user's Health Connect order first, then by record count.
function rankApps(cat, list) {
  const order = S.priority.get(cat) || [];
  const rank = new Map(order.map((id, i) => [id, i]));
  return list.slice().sort((a, b) => (rank.get(a.id) ?? 1e6 + (1e6 - a.n)) - (rank.get(b.id) ?? 1e6 + (1e6 - b.n)));
}
const usesHcPriority = cat => (S.priority.get(cat) || []).length > 0;

// kind: "sum" (interval totals: combined by default), "avg" (all by default), "pick" (one app by default)
function sourceSelect(key, list, kind, cat) {
  if (list.length < 2) { S.sources[key] = list[0] ? String(list[0].id) : ALL; return null; }
  const ranked = rankApps(cat, list);
  if (!(key in S.sources)) S.sources[key] = kind === "sum" || kind === "sessions" ? COMBINED : kind === "avg" ? ALL : String(ranked[0].id);
  const opts = [];
  if (kind === "sum" || kind === "sessions" || kind === "avg")
    opts.push(h("option", { value: COMBINED }, kind === "avg" ? "Top-priority app each day" : "Combined (no double counting)"));
  opts.push(h("option", { value: ALL }, kind === "sum" ? "All sources added up" : "All sources"));
  for (const s of ranked) opts.push(h("option", { value: s.id }, `${appName(s.id)} (${s.n.toLocaleString()})`));
  const sel = h("select", {
    title: `Data source. ${usesHcPriority(cat) ? "Apps are ordered by your Health Connect priority settings." : "Apps are ordered by how many records they have."} "Combined" counts each moment once, preferring the higher-priority app.`,
    onchange: e => { S.sources[key] = e.target.value; render(); } }, opts);
  sel.value = S.sources[key];
  if (sel.value !== S.sources[key]) { sel.value = opts[0].value; S.sources[key] = sel.value; }
  return sel;
}
const srcMode = key => S.sources[key] || ALL;
function srcClause(key, alias = "") { const v = srcMode(key); return v !== ALL && v !== COMBINED ? ` AND ${alias ? alias + "." : ""}app_info_id = ${Number(v)}` : ""; }
// a function giving each app's rank (lower = preferred)
function rankFn(cat, list) { const r = new Map(rankApps(cat, list).map((s, i) => [s.id, i])); return id => r.get(id) ?? 1e9; }

// Combine interval records ([start, end, value, app, offsetSec]) without double counting.
// The timeline is cut at every record boundary; in each piece the best-ranked app covering it
// contributes its value pro rata. Point records (start == end) count only if no better app covers them.
// Returns Map(localDay -> total).
function combineIntervals(recs, rank) {
  const out = new Map();
  const add = (day, v) => out.set(day, (out.get(day) || 0) + v);
  if (!recs.length) return out;
  const ev = [];
  recs.forEach((r, i) => { if (r[1] > r[0]) { ev.push([r[0], 1, i]); ev.push([r[1], -1, i]); } });
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const active = new Set();
  let best = -1, prevT = null;
  const pickBest = () => { let b = -1, br = Infinity; for (const i of active) { const rr = rank(recs[i][3]); if (rr < br || (rr === br && i < b)) { br = rr; b = i; } } return b; };
  for (let k = 0; k < ev.length; k++) {
    const [t, type, i] = ev[k];
    if (prevT != null && t > prevT && best >= 0) {
      const r = recs[best], len = r[1] - r[0];
      // split at local midnights so each day gets its share
      let a = prevT;
      while (a < t) {
        const day = localDayOf(a, r[4]); const dayEnd = (day + 1) * DAY - (r[4] == null ? TZ_SEC : r[4]) * 1000;
        const b = Math.min(t, dayEnd);
        add(day, r[2] * (b - a) / len);
        a = b;
      }
    }
    if (type === 1) active.add(i); else active.delete(i);
    prevT = t;
    // recompute the best record only once all events at this instant are applied
    if (k === ev.length - 1 || ev[k + 1][0] !== t) best = pickBest();
  }
  // point records
  const pts = recs.filter(r => r[1] <= r[0]);
  if (pts.length) {
    const ivs = recs.filter(r => r[1] > r[0]);
    for (const p of pts) {
      const covered = ivs.some(r => r[0] <= p[0] && p[0] < r[1] && rank(r[3]) < rank(p[3]));
      if (!covered) add(localDayOf(p[0], p[4]), p[2]);
    }
  }
  return out;
}
// For instant (average) metrics: per day keep only the best-ranked app that has data that day.
function combinePerDay(rowsByApp, rank) {   // rows: [day, value, n, app]
  const best = new Map();
  for (const r of rowsByApp) { const b = best.get(r[0]); if (!b || rank(r[3]) < rank(b[3])) best.set(r[0], r); }
  return best;
}
// Sessions (sleep, workouts): drop a session if a better-ranked app has one overlapping it by more than half.
function dedupeSessions(sessions, rank, startIdx, endIdx, appIdx) {
  const sorted = sessions.slice().sort((a, b) => rank(a[appIdx]) - rank(b[appIdx]));
  const kept = [];
  for (const s of sorted) {
    const len = Math.max(1, s[endIdx] - s[startIdx]);
    const dup = kept.some(k => k[appIdx] !== s[appIdx] && Math.min(k[endIdx], s[endIdx]) - Math.max(k[startIdx], s[startIdx]) > len / 2);
    if (!dup) kept.push(s);
  }
  return kept.sort((a, b) => a[startIdx] - b[startIdx]);
}
