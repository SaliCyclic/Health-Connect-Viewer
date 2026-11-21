// ============================================================================
// Widgets: every chart/table is a widget, so section tabs and "My page" share
// one registry. Widgets draw in stages behind light placeholders so the page
// appears at once and stays responsive.
// ============================================================================
let WIDGETS = {}, WIDGET_ORDER = [];
function buildWidgets() {
  WIDGETS = {}; WIDGET_ORDER = [];
  const add = (id, sec, name, avail, make, wide = false) => { WIDGETS[id] = { id, sec, name, avail, make, wide }; WIDGET_ORDER.push(id); };
  for (const m of METRICS)
    add("m:" + m.id, m.sec, m.label, () => has(m.table) && (!m.noGuess || !!valueCol(m)),
      async () => [m.special === "hr" ? await hrCard() : m.special === "bp" ? await bpCard(m) : await metricCard(m)], m.special === "hr");
  add("sleep:stages", "sleep", "Sleep stages per night", () => has(SLEEP_T), async () => [await sleepStagesCard()], true);
  add("sleep:bed", "sleep", "Bedtime", () => has(SLEEP_T), async () => [await clockCard("bed")]);
  add("sleep:wake", "sleep", "Wake time", () => has(SLEEP_T), async () => [await clockCard("wake")]);
  const wkAvail = () => has(WK_T) || S.imported.length > 0;
  add("wk:summary", "workouts", "Workout summary", wkAvail, async () => [await workoutSummaryCard()], true);
  add("wk:records", "workouts", "Personal records", wkAvail, async () => [await recordsCard()], true);
  add("wk:list", "workouts", "Workout sessions + details", wkAvail, () => workoutListCards(), true);
  add("cycle:overview", "cycle", "Cycles and periods", cycleAvailable, async () => [await cycleOverviewCard()], true);
  add("cycle:journal", "cycle", "Cycle journal (symptoms, ratings, notes)", () => !!S.cycleJournal, () => cycleJournalCards(), true);
  add("pat:hours", "patterns", "When you're active (heatmap)", () => has("steps_record_table"), async () => [await stepsHeatmapCard()], true);
  add("pat:week", "patterns", "Your week (by weekday)", () => has(SLEEP_T) || has("steps_record_table"), async () => [await weekdayCard()]);
  add("pat:corr", "patterns", "How your measures relate", () => true, async () => [await correlationsCard()], true);
}
async function makeWidget(id, item) {
  if (id.startsWith("tbl:")) return [await tableCard(id.slice(4))];
  if (id.startsWith("sql:")) return [await sqlCard(item)];
  const w = WIDGETS[id];
  if (!w || !w.avail()) return [];
  return (await w.make()).filter(Boolean);
}

// A slot holds one widget: a placeholder first, filled in when its data is ready.
function slot(parent, title, build, wide, before = null) {
  const wrap = h("div", { class: "slot" });
  wrap.append(h("div", { class: "card ph" + (wide ? " wide" : ""), "data-pending": "", "aria-busy": "true" },
    h("div", { class: "card-head" }, h("h3", {}, title)), h("div", { class: "empty" }, "Loading…")));
  parent.insertBefore(wrap, before);
  return { wrap, build, done: false };
}
async function fill(s) {
  if (s.done || !s.wrap.isConnected) return;
  s.done = true;
  let els;
  try { els = (await s.build()).filter(Boolean); }
  catch (e) { console.warn(e); els = [h("div", { class: "card" }, h("div", { class: "status err" }, "Couldn't draw this: " + e.message))]; }
  if (s.wrap.isConnected) s.wrap.replaceChildren(...els);
}
let mountTok = 0, pendingSlots = [];
async function mount(slots) {
  const tok = ++mountTok; pendingSlots = slots;
  await nextFrame();
  // queries run in the worker; start a few at a time so the first cards appear quickly
  const queue = slots.slice(), running = new Set();
  const next = async () => {
    while (queue.length && tok === mountTok) { const s = queue.shift(); await fill(s); await nextFrame(); }
  };
  for (let i = 0; i < 3; i++) running.add(next());
  await Promise.all(running);
}
async function flushSlots() { await Promise.all(pendingSlots.map(fill)); }
window.addEventListener("beforeprint", () => { flushSlots(); });

// ---------------------------------------------------------------- My page
const DEFAULT_PAGE = [{ id: "m:steps" }, { id: "sleep:stages" }, { id: "m:rhr" }, { id: "m:weight" }, { id: "sleep:bed" }];
const SQL_EXAMPLE = `-- :from and :to are the start and end of the selected range (ms)
SELECT date((time + zone_offset * 1000) / 1000, 'unixepoch') AS day,
       avg(weight) / 1000.0 AS weight_kg
FROM weight_record_table
WHERE time BETWEEN :from AND :to
GROUP BY day`;
const newKey = () => Math.random().toString(36).slice(2, 10);
function pageItems() {
  if (!S.page) S.page = store.get("page", DEFAULT_PAGE);
  for (const it of S.page) if (!it.key) it.key = newKey();
  return S.page;
}
function savePage(items) { S.page = items; store.set("page", items.map(({ isNew, ...it }) => it)); }
let MP = null;
function renderMyPage(v) {
  const items = pageItems();
  const root = h("div", { class: "mypage" + (S.editing ? " editing" : "") + (items.length ? "" : " empty-page") });
  const editBtn = h("button", { class: S.editing ? "primary" : "", "aria-pressed": String(S.editing), onclick: () => {
    S.editing = !S.editing; root.classList.toggle("editing", S.editing); editBtn.setAttribute("aria-pressed", String(S.editing));
    editBtn.textContent = S.editing ? "Done" : "Edit page"; editBtn.className = S.editing ? "primary" : ""; } }, S.editing ? "Done" : "Edit page");
  const bar = h("div", { class: "mp-bar" }, h("h2", {}, "My page"), editBtn, h("span", { class: "spacer" }),
    h("button", { title: "Save the page layout (no health data) as a file", onclick: () => download("my-page-layout.json", JSON.stringify(pageItems().map(({ key, isNew, ...it }) => it), null, 2), "application/json") }, "Export layout"),
    h("button", { onclick: importLayout }, "Import layout"));
  const pick = h("div", { class: "picker-host" });
  const grid = h("div", { class: "grid" });
  const emptyMsg = h("div", { class: "empty page-empty" }, "Your page is empty. Pick charts and tables above to add them.");
  root.append(bar, pick, grid, emptyMsg); v.append(root);
  MP = { root, grid, pick };
  refreshPicker();
  mount(items.map(it => itemSlot(it)));
}
function itemWide(it) { return it.size === "wide" || (it.size !== "normal" && !!WIDGETS[it.id]?.wide) || it.id.startsWith("tbl:"); }
function itemSlot(it, before = null) {
  const s = slot(MP.grid, widgetName(it), () => buildItem(it.key), itemWide(it), before);
  s.wrap.dataset.key = it.key;
  return s;
}
async function buildItem(key) {
  const it = pageItems().find(x => x.key === key); if (!it) return [];
  let cards = await makeWidget(it.id, it);
  if (!cards.length) { const c = cardShell(widgetName(it), "not in this export", null); c.classList.add("placeholder"); c.append(h("div", { class: "empty" }, "This export has no data for this item.")); cards = [c]; }
  if (it.size === "wide") cards.forEach(c => c.classList.add("wide")); else if (it.size === "normal") cards.forEach(c => c.classList.remove("wide"));
  applyView(cards[0], it.view || "chart");
  cards[0].prepend(widgetControls(it, cards[0]));
  return cards;
}
const wrapOf = key => MP.grid.querySelector(`:scope > .slot[data-key="${key}"]`);
function redrawItem(key) { const w = wrapOf(key); if (w) fill({ wrap: w, build: () => buildItem(key) }); }
function widgetName(it) {
  if (it.id.startsWith("tbl:")) return "Table: " + it.id.slice(4);
  if (it.id.startsWith("sql:")) return it.title || "Custom query";
  return WIDGETS[it.id]?.name || it.id;
}
function applyView(card, view) {
  if (view === "chart") return;
  if (view === "table" || view === "both") { card._showTable?.(); if (view === "table") card.querySelectorAll(":scope > .chart").forEach(c => c.classList.add("hidden")); }
}
function widgetControls(it, card) {
  const key = it.key;
  const idx = () => pageItems().findIndex(x => x.key === key);
  const patch = p => { const items = pageItems().slice(); const i = idx(); items[i] = { ...items[i], ...p }; savePage(items); return items[i]; };
  const move = d => {
    const items = pageItems().slice(), i = idx(), j = i + d; if (i < 0 || j < 0 || j >= items.length) return;
    const other = items[j].key; [items[i], items[j]] = [items[j], items[i]]; savePage(items);
    const a = wrapOf(key), b = wrapOf(other); if (!a || !b) return;
    if (d < 0) MP.grid.insertBefore(a, b); else MP.grid.insertBefore(b, a);
    a.scrollIntoView({ block: "nearest" });
  };
  const size = h("select", { title: "Width", "aria-label": "Width", onchange: e => {
      const it2 = patch({ size: e.target.value }); const w = wrapOf(key);
      if (w) for (const c of w.children) c.classList.toggle("wide", itemWide(it2));
    } }, h("option", { value: "auto" }, "Auto width"), h("option", { value: "normal" }, "Narrow"), h("option", { value: "wide" }, "Full width"));
  size.value = it.size || "auto";
  const ctl = h("div", { class: "wctl" }, h("span", { class: "nm" }, widgetName(it)));
  if (card._showTable && !it.id.startsWith("sql:")) {
    const view = h("select", { title: "Show", "aria-label": "Show", onchange: e => { patch({ view: e.target.value }); redrawItem(key); } },
      h("option", { value: "chart" }, "Chart"), h("option", { value: "table" }, "Table"), h("option", { value: "both" }, "Chart + table"));
    view.value = it.view || "chart"; ctl.append(view);
  }
  if (it.id.startsWith("sql:")) ctl.append(h("button", { onclick: () => card.querySelector(".sqlform")?.classList.toggle("hidden") }, "Edit query"));
  ctl.append(size, h("button", { title: "Move earlier", "aria-label": "Move earlier", onclick: () => move(-1) }, "↑"), h("button", { title: "Move later", "aria-label": "Move later", onclick: () => move(1) }, "↓"),
    h("button", { title: "Remove", "aria-label": "Remove", onclick: () => {
      const items = pageItems().filter(x => x.key !== key); savePage(items); wrapOf(key)?.remove();
      MP.root.classList.toggle("empty-page", !items.length); refreshPicker(); } }, "✕"));
  return ctl;
}
function addItem(item) {
  const it = { ...item, key: newKey(), isNew: item.id.startsWith("sql:") || undefined };
  savePage([...pageItems(), it]);
  if (!MP || !MP.root.isConnected) return;
  MP.root.classList.remove("empty-page");
  const s = itemSlot(it); fill(s).then(() => s.wrap.firstElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  refreshPicker();
}
function refreshPicker() {
  const items = pageItems(), have = new Set(items.map(x => x.id));
  const box = h("div", { class: "picker" });
  for (const sec of SECTIONS.filter(s => !["mypage", "tables"].includes(s.id))) {
    const ws = WIDGET_ORDER.filter(id => WIDGETS[id].sec === sec.id && WIDGETS[id].avail());
    if (!ws.length) continue;
    box.append(h("h4", {}, sec.name), h("div", { class: "chips" }, ws.map(id => h("button", { class: have.has(id) ? "on" : "", title: have.has(id) ? "Already on your page (click to add another copy)" : "Add to page",
      onclick: () => addItem({ id }) }, (have.has(id) ? "✓ " : "+ ") + WIDGETS[id].name))));
  }
  const tsel = h("select", { "aria-label": "Database table" }, h("option", { value: "" }, "Choose a database table…"),
    [...S.tables.keys()].sort().map(n => h("option", { value: n }, n)));
  box.append(h("h4", {}, "Raw data"), h("div", { class: "chips" }, tsel, h("button", { onclick: () => tsel.value && addItem({ id: "tbl:" + tsel.value }) }, "+ Add table"),
    h("button", { onclick: () => addItem({ id: "sql:" + newKey(), title: "Weight (custom query)", sql: SQL_EXAMPLE, chart: "line" }) }, "+ Custom SQL chart or table")));
  MP.pick.replaceChildren(box);
}
function importLayout() {
  const inp = h("input", { type: "file", accept: ".json,application/json" });
  inp.onchange = async () => {
    try { const arr = JSON.parse(await inp.files[0].text());
      if (!Array.isArray(arr) || !arr.every(x => x && typeof x.id === "string")) throw new Error("Not a layout file");
      savePage(arr.map(x => ({ id: x.id, view: x.view, size: x.size, title: x.title, sql: x.sql, chart: x.chart, key: newKey() }))); render();
    } catch (e) { alert("Couldn't import: " + e.message); }
  };
  inp.click();
}

// ---------------------------------------------------------------- table and SQL widgets
async function tableCard(name) {
  if (!has(name)) return null;
  const n = (await q(`SELECT count(*) FROM "${name}"`))[0][0];
  const card = cardShell(name, `${n.toLocaleString()} rows · newest first, up to 200 shown`, null);
  card.classList.add("wide");
  // rows are stored in the order they were written, so row order is effectively time order and needs no sort
  const order = hasCol(name, "row_id") ? "ORDER BY row_id DESC" : "ORDER BY rowid DESC";
  let res;
  try { res = await runQuery(`SELECT * FROM "${name}" ${order}`, false, 200); } catch (e) { card.append(h("div", { class: "status err" }, e.message)); return card; }
  card.append(h("div", { class: "scroll", style: "max-height:320px" }, simpleTable(res.cols, res.rows.map(r => r.map((v, i) => fmtCell(res.cols[i], v, true))))));
  card.append(h("div", { class: "card-foot" }, h("span", { class: "src" }, "Times shown as dates"),
    h("button", { onclick: () => exportQueryCsv(`SELECT * FROM "${name}" ${order}`, `${name}.csv`) }, "CSV (all rows)")));
  return card;
}
async function sqlCard(it) {
  const card = cardShell(it.title || "Custom query", "your SQL · uses the range above via :from / :to", null);
  const form = h("div", { class: "sqlform" + (it.isNew ? "" : " hidden") });
  const title = h("input", { type: "text", value: it.title || "", placeholder: "Title", "aria-label": "Title" });
  const ta = h("textarea", { spellcheck: "false", "aria-label": "SQL query" }, it.sql || "");
  const mode = h("select", { "aria-label": "Show as" }, ["table", "line", "bar", "dots"].map(x => h("option", { value: x }, { table: "Show as table", line: "Line chart", bar: "Bar chart", dots: "Scatter + average line" }[x])));
  mode.value = it.chart || "table";
  form.append(title, ta, h("div", { class: "card-foot" }, mode, h("span", { class: "note" }, "For charts: first column = date (YYYY-MM-DD) or time in ms; the next columns = numbers (up to 5)."),
    h("span", { class: "spacer" }), h("button", { class: "primary", onclick: () => {
      const items = pageItems().map(x => x.key === it.key ? { ...x, title: title.value.trim(), sql: ta.value, chart: mode.value, isNew: undefined } : x);
      savePage(items); redrawItem(it.key); } }, "Save")));
  card.append(form);
  const out = h("div"); card.append(out);
  let res;
  try { res = await runQuery(it.sql || "", true); }
  catch (e) { out.append(h("div", { class: "status err" }, e.message)); return card; }
  const chartMode = it.chart || "table";
  if (chartMode !== "table") { const err = drawSqlChart(out, res, chartMode); if (err) out.append(h("div", { class: "status err" }, err)); }
  else out.append(h("div", { class: "scroll", style: "max-height:320px" }, simpleTable(res.cols, res.rows.map(r => r.map((v, i) => fmtCell(res.cols[i], v, true))))));
  const f = h("div", { class: "card-foot" }, h("span", { class: "src" }, `${res.rows.length.toLocaleString()} rows${res.more ? "+" : ""}`),
    h("button", { onclick: () => exportQueryCsv(it.sql, `${(it.title || "query").replace(/\W+/g, "_")}.csv`, true) }, "CSV"));
  if (chartMode !== "table") f.append(h("button", { onclick: () => chartToPng(card) }, "PNG"));
  card.append(f);
  return card;
}
function drawSqlChart(out, res, mode) {
  if (res.cols.length < 2) return "A chart needs at least two columns: a date, then one or more numbers.";
  const toDay = x => typeof x === "number" ? (x > 1e11 ? Math.floor((x + TZ_SEC * 1000) / DAY) : null) : typeof x === "string" ? parseIsoDay(x) : null;
  const nSer = Math.min(5, res.cols.length - 1);
  const map = new Map(); let bad = 0;
  for (const r of res.rows) {
    const d = toDay(r[0]); if (d == null) { bad++; continue; }
    let o = map.get(d); if (!o) { o = { day: d, s: Array(nSer).fill(0), c: Array(nSer).fill(0) }; map.set(d, o); }
    for (let k = 0; k < nSer; k++) { const v = r[k + 1]; if (typeof v === "number") { o.s[k] += v; o.c[k]++; } }
  }
  if (!map.size) return `The first column (${res.cols[0]}) doesn't look like dates. Use YYYY-MM-DD text or a time in milliseconds.`;
  const rows = [...map.values()].sort((a, b) => a.day - b.day);
  const colors = ["--s1", "--s2", "--s3", "--s4", "--s5"];
  const series = Array.from({ length: nSer }, (_, k) => ({ name: res.cols[k + 1], color: colors[k], values: rows.map(r => r.c[k] ? r.s[k] / r.c[k] : null) }));
  const chart = h("div", { class: "chart" }); out.append(chart);
  drawChart(chart, { type: mode === "bar" ? (nSer > 1 ? "stack" : "bar") : mode, days: rows.map(r => r.day), bucket: { size: 1, name: "day" },
    unit: "", dp: 2, series: mode === "dots" ? series.slice(0, 1) : series, avgLine: mode === "dots", height: 220 });
  if (bad) out.append(h("div", { class: "note" }, `${bad} rows skipped (first column wasn't a date).`));
  if (mode === "dots" && nSer > 1) out.append(h("div", { class: "note" }, "Scatter shows the first number column only."));
  return null;
}
