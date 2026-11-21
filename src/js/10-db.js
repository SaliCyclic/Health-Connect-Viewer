// ============================================================================
// Database access. SQLite runs in a background worker (src/worker/db-worker.js);
// the page sends SQL and gets rows back, so it never freezes on big queries.
// ============================================================================

const DB = (() => {
  let worker = null, seq = 0, ready = null, info = null;
  const pending = new Map();
  function start() {
    if (ready) return ready;
    const src = document.getElementById("worker-src").textContent;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    worker.onmessage = e => {
      const m = e.data, p = pending.get(m.id);
      if (!p) return;
      if (m.progress) { p.onProgress?.(m.progress); return; }
      pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
    };
    worker.onerror = e => { for (const p of pending.values()) p.reject(new Error(e.message || "The database worker stopped.")); pending.clear(); };
    const wasm = b64ToBytes(document.getElementById("wasm-b64").textContent.trim());
    ready = call("init", { wasm: wasm.buffer }, [wasm.buffer]).then(r => (info = r));
    return ready;
  }
  function call(op, data = {}, transfer = [], onProgress) {
    return new Promise((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, op, ...data }, transfer);
    });
  }
  function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  return {
    start, info: () => info,
    open: (file, mode, onProgress) => start().then(() => call("open", { file, mode }, [], onProgress)),
    query: (sql, bind, limit) => call("query", { sql, bind, limit }),
    csv: (sql, bind, humanTimes) => call("csv", { sql, bind, humanTimes }),
    close: () => worker ? call("close") : Promise.resolve(),
    cleanup: () => call("cleanup"),
  };
})();

// The export is opened read-only, so a query's answer never changes while it is open.
// Answers (and in-flight requests) are remembered, which makes redraws nearly free.
const QCACHE = new Map(), QCACHE_MAX = 800, QCACHE_ROWS = 60000;
function cacheGet(key) { if (!QCACHE.has(key)) return undefined; const v = QCACHE.get(key); QCACHE.delete(key); QCACHE.set(key, v); return v; }
function cachePut(key, v) { QCACHE.set(key, v); if (QCACHE.size > QCACHE_MAX) QCACHE.delete(QCACHE.keys().next().value); }
async function qx(sql, bind, limit) {
  const key = sql + "\u0001" + (bind ? JSON.stringify(bind) : "") + "\u0001" + (limit || "");
  const hit = cacheGet(key); if (hit) return hit;
  const p = DB.query(sql, bind || null, limit || 0);
  cachePut(key, p);
  try { const r = await p; if (r.rows.length > QCACHE_ROWS) QCACHE.delete(key); return r; }
  catch (e) { QCACHE.delete(key); throw e; }
}
const q = async (sql, bind) => (await qx(sql, bind)).rows;

// ---------------------------------------------------------------- schema
function cols(table) { return S.tables.get(table)?.cols || []; }
function has(table) { return S.tables.has(table); }
function hasCol(table, c) { return cols(table).some(x => x.name === c); }
function timeCols(table) {
  if (hasCol(table, "start_time")) return { t: "start_time", end: "end_time", off: "start_zone_offset", offEnd: "end_zone_offset" };
  if (hasCol(table, "time")) return { t: "time", off: "zone_offset" };
  return null;
}
function valueCol(m) {
  const c = cols(m.table);
  for (const n of m.cols || []) if (c.some(x => x.name === n)) return { name: n, guessed: false };
  if (m.noGuess) return null;
  const f = c.find(x => !META_COLS.has(x.name) && /INT|REAL|NUM/i.test(x.type) && !/_type$|method|location|position/.test(x.name));
  return f ? { name: f.name, guessed: true } : null;
}
function appName(id) { if (typeof id === "string") return id; const a = S.apps.get(id); return a ? (a.name || a.pkg) : `App #${id}`; }

// Zone offsets are stored in seconds; detected per column (some writers might use ms).
const offUnit = {};
function offExpr(table, col, alias = "") {
  const a = alias ? alias + "." : "";
  if (!hasCol(table, col)) return `${TZ_SEC * 1000}`;
  const u = offUnit[table + "." + col] || 1000;
  return `(COALESCE(${a}${col}, ${u === 1 ? TZ_SEC * 1000 : TZ_SEC}) * ${u})`;
}
const dayExprFor = (table, tcol, offcol, alias = "") => `CAST((${alias ? alias + "." : ""}${tcol} + ${offExpr(table, offcol, alias)}) / ${DAY} AS INTEGER)`;

async function scanSchema() {
  S.tables.clear(); S.apps.clear(); S.priority.clear(); QCACHE.clear(); S.hrDaily = null;
  for (const k in offUnit) delete offUnit[k];
  const names = (await q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map(r => r[0]);
  await Promise.all(names.map(async name => {
    const c = (await q(`PRAGMA table_info("${name.replace(/"/g, '""')}")`)).map(r => ({ name: r[1], type: r[2] || "" }));
    S.tables.set(name, { cols: c, count: null });
  }));
  if (has("application_info_table")) {
    const nameCol = hasCol("application_info_table", "app_name") ? "app_name" : "NULL";
    const pkgCol = hasCol("application_info_table", "package_name") ? "package_name" : "NULL";
    for (const [id, n, p] of await q(`SELECT row_id, ${nameCol}, ${pkgCol} FROM application_info_table`)) S.apps.set(id, { name: n, pkg: p });
  }
  // zone-offset units, one small query per column
  const offCols = [];
  for (const [t] of S.tables) for (const c of ["zone_offset", "start_zone_offset", "end_zone_offset"]) if (hasCol(t, c)) offCols.push([t, c]);
  await Promise.all(offCols.map(async ([t, c]) => {
    const r = (await q(`SELECT max(abs(${c})) FROM "${t}"`))[0][0];
    offUnit[t + "." + c] = r != null && r > 86400 ? 1 : 1000;
  }));
  // the user's app priority per data category (Health Connect settings), highest first
  if (has("health_data_category_priority_table") && hasCol("health_data_category_priority_table", "app_id_priority_order")) {
    for (const [cat, order] of await q("SELECT health_data_category, app_id_priority_order FROM health_data_category_priority_table"))
      S.priority.set(cat, String(order || "").split(/[^0-9]+/).filter(Boolean).map(Number));
  }
  // overall data span, from the busiest tables we know
  let mn = Infinity, mx = -Infinity;
  for (const t of ["steps_record_table", "heart_rate_record_table", "sleep_session_record_table", "weight_record_table", "exercise_session_record_table", "total_calories_burned_record_table"]) {
    if (!has(t)) continue; const tc = timeCols(t); if (!tc) continue;
    const [a, b] = (await q(`SELECT min(${tc.t}), max(${tc.t}) FROM ${t}`))[0];
    if (a != null) { mn = Math.min(mn, a); mx = Math.max(mx, b); }
  }
  S.dataMin = isFinite(mn) ? mn : Date.now() - 365 * DAY; S.dataMax = isFinite(mx) ? mx : Date.now();
}

// Table names and columns only (never values), for bug reports.
async function schemaReport(withCounts) {
  const lines = [`Health Connect Viewer ${VERSION} schema report`, `Tables: ${S.tables.size}`, ""];
  for (const [name, t] of [...S.tables].sort()) {
    let n = "";
    if (withCounts) { try { n = ` (${(await q(`SELECT count(*) FROM "${name}"`))[0][0]} rows)`; } catch {} }
    lines.push(`${name}${n}: ${t.cols.map(c => `${c.name} ${c.type}`.trim()).join(", ")}`);
  }
  if (S.priority.size) lines.push("", `App priority table present for categories: ${[...S.priority.keys()].join(", ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- read-only user SQL
const isTimeCol = c => /(^|_)(time|epoch_millis|timestamp_millis|stage_start_time|stage_end_time|last_modified_time)$/.test(c);
function fmtCell(c, v, human) { return v instanceof Uint8Array ? `‹${v.length} bytes›` : human && typeof v === "number" && isTimeCol(c) && v > 1e11 ? fmtDT(v) : v; }
function rangeParams(text) {
  const p = {}; const fromMs = S.fromDay * DAY - TZ_SEC * 1000, toMs = (S.toDay + 1) * DAY - TZ_SEC * 1000 - 1;
  if (/:from\b/.test(text)) p[":from"] = fromMs; if (/:to\b/.test(text)) p[":to"] = toMs;
  return Object.keys(p).length ? p : null;
}
function checkReadOnly(text) {
  const t = text.replace(/--[^\n]*/g, "").trim();
  if (!/^(select|with|pragma|explain)\b/i.test(t)) throw new Error("Only SELECT / WITH / PRAGMA queries are allowed here.");
  return t;
}
async function runQuery(text, withParams, limit = 1000) {
  const t = checkReadOnly(text);
  const r = await qx(t, withParams ? rangeParams(t) : null, limit + 1);
  return { cols: r.cols, rows: r.rows.slice(0, limit), more: r.rows.length > limit };
}
async function exportQueryCsv(text, name, withParams, humanTimes = true) {
  try { const t = checkReadOnly(text); download(name, await DB.csv(t, withParams ? rangeParams(t) : null, humanTimes)); }
  catch (e) { alert(e.message); }
}
