// ============================================================================
// App shell: opening files, navigation, settings, printing, offline install.
// ============================================================================

function render() {
  S.gen++;
  const v = $("#views"); v.innerHTML = "";
  $("#printHead").textContent = `${SECTIONS.find(s => s.id === S.tab)?.name.replace("★ ", "") || ""} · ${rangeText()} · ${S.fileName} · printed ${fmtDT(Date.now())}`;
  if (S.tab === "tables") return renderTables(v);
  if (S.tab === "mypage") return renderMyPage(v);
  const grid = h("div", { class: "grid" }); v.append(grid);
  const slots = [];
  for (const id of WIDGET_ORDER) {
    const w = WIDGETS[id]; if (w.sec !== S.tab || !w.avail()) continue;
    slots.push(slot(grid, w.name, () => makeWidget(id), w.wide));
  }
  if (!slots.length) grid.append(h("div", { class: "empty" }, "No data of this kind in the export."));
  mount(slots);
}

function buildChrome() {
  const tabs = $("#tabs"); tabs.innerHTML = "";
  for (const s of SECTIONS) {
    const avail = s.id === "tables" || s.id === "mypage" || WIDGET_ORDER.some(id => WIDGETS[id].sec === s.id && WIDGETS[id].avail());
    if (!avail && S.tab === s.id) S.tab = "activity";
    tabs.append(h("button", { role: "tab", "aria-selected": String(s.id === S.tab), class: avail ? "" : "hidden",
      onclick: () => { S.tab = s.id; buildChrome(); render(); } }, s.name));
  }
  const seg = $("#rangeSeg"); seg.innerHTML = "";
  for (const [label, days] of RANGES) seg.append(h("button", { "aria-pressed": String(!S.custom && S.range === days), onclick: () => setRange(days) }, label));
  seg.append(h("button", { "aria-pressed": String(!!S.custom), onclick: () => $("#customRange").classList.toggle("hidden") }, "Custom…"));
  const cr = $("#customRange");
  cr.querySelector("[name=from]").value = isoDay(S.fromDay); cr.querySelector("[name=to]").value = isoDay(S.toDay);
  $("#rangeLabel").textContent = rangeText();
  const segOf = (id, opts, cur, set) => { const el = $(id); el.innerHTML = ""; for (const [lab, val] of opts) el.append(h("button", { "aria-pressed": String(cur === val), onclick: () => { set(val); buildChrome(); render(); } }, lab)); };
  segOf("#unitSeg", [["Metric", false], ["Imperial", true]], S.imperial, v => { S.imperial = v; store.set("units", v); });
  segOf("#trendSeg", [["Off", 0], ["7-day", 7], ["30-day", 30]], S.trend, v => { S.trend = v; store.set("trend", v); });
  $("#compareSel").value = S.compare;
  $("#toolbar").classList.toggle("hidden", S.tab === "tables");
}

// ---------------------------------------------------------------- opening files
async function openFile(file) {
  const st = $("#status"), prog = $("#progress");
  st.className = "status"; st.textContent = `Reading ${file.name}…`; prog.classList.remove("hidden"); prog.removeAttribute("value");
  try {
    await DB.start();
    const res = await DB.open(file, store.get("dbmode", "auto"), p => {
      if (p.phase === "read" && p.total) { prog.max = p.total; prog.value = p.done; st.textContent = `Reading ${file.name}… ${Math.round(p.done / p.total * 100)}%`; }
      else if (p.phase === "copy") st.textContent = `Unpacking… ${(p.done / 1048576).toFixed(0)} MB`;
    });
    st.textContent = "Reading the database layout…"; prog.removeAttribute("value");
    S.fileName = file.name; S.dbMode = res.mode; S.sources = {}; S.memo = {}; S.maxHrEstimate = null;
    await scanSchema(); buildWidgets();
    estimateMaxHr();   // runs in the background
    S.open = true;
    $("#fileinfo").textContent = file.name + (res.mode === "disk" ? " · low-memory mode" : "");
    $("#fileinfo").title = res.mode === "disk" ? "The export is read from a temporary copy in this browser's private storage. It is deleted when you open another file, and whenever the viewer starts." : "The export is held in memory in this tab.";
    for (const id of ["#fileinfo", "#openOther", "#addFiles", "#printBtn"]) $(id).classList.remove("hidden");
    $("#start").classList.add("hidden"); $("#app").classList.remove("hidden");
    prog.classList.add("hidden"); st.textContent = "";
    if (S.custom) S.custom = null;
    setRange(S.range);
  } catch (e) {
    console.warn(e); prog.classList.add("hidden");
    st.className = "status err"; st.textContent = "Couldn't open the file: " + (e.message || e);
  }
}
async function estimateMaxHr() {
  // the 98th percentile of daily highest heart rate is a robust stand-in for max heart rate
  try {
    if (!has("heart_rate_record_series_table")) return;
    const d = await hrDaily(); if (!d.length) return;
    const maxes = d.map(r => r[4]).filter(v => v > 80 && v < 230).sort((a, b) => a - b);
    if (maxes.length >= 5) S.maxHrEstimate = Math.round(maxes[Math.floor(maxes.length * 0.98)]);
  } catch {}
}
function closeFile() {
  DB.close(); S.open = false; S.sources = {}; S.imported = []; S.cycleJournal = null;
  for (const id of ["#fileinfo", "#openOther", "#addFiles", "#printBtn"]) $(id).classList.add("hidden");
  $("#app").classList.add("hidden"); $("#start").classList.remove("hidden"); $("#status").textContent = "";
}
async function handleFiles(files) {
  files = [...files]; if (!files.length) return;
  const main = files.find(f => /\.(zip|db|sqlite3?)$/i.test(f.name));
  const extra = files.filter(f => f !== main);
  if (main) { if (S.open) closeFile(); await openFile(main); }
  if (extra.length) {
    const { done, failed } = await importFiles(extra);
    const msg = [done.length ? `Added: ${done.join("; ")}` : "", failed.length ? `Couldn't read: ${failed.join("; ")}` : ""].filter(Boolean).join(" · ");
    if (S.open) { buildWidgets(); buildChrome(); render(); toast(msg, !!failed.length); }
    else { $("#status").className = "status" + (failed.length ? " err" : ""); $("#status").textContent = msg + (done.length ? " · Now open your Health Connect export, or " : ""); if (done.length) $("#status").append(h("button", { class: "linkbtn", onclick: openWithoutExport }, "view these files on their own")); }
  }
}
// view imported files (workouts / cycle journal) without a Health Connect export
async function openWithoutExport() {
  S.tables.clear(); S.apps.clear(); S.priority.clear();
  const days = [...S.imported.map(w => localDayOf(w.start, null)), ...(S.cycleJournal?.entries.map(e => e.day) || [])];
  S.dataMin = Math.min(...days) * DAY; S.dataMax = Math.max(...days) * DAY + DAY / 2;
  buildWidgets(); S.open = true; S.fileName = "added files";
  S.tab = S.imported.length ? "workouts" : "cycle";
  for (const id of ["#openOther", "#addFiles", "#printBtn"]) $(id).classList.remove("hidden");
  $("#start").classList.add("hidden"); $("#app").classList.remove("hidden"); setRange(0);
}
function toast(msg, err) {
  const t = h("div", { class: "toast" + (err ? " err" : ""), role: "status" }, msg, h("button", { class: "linkbtn", onclick: () => t.remove() }, "Close"));
  document.body.append(t); setTimeout(() => t.remove(), 9000);
}

// ---------------------------------------------------------------- settings
function openSettings() {
  const dlg = $("#settingsDlg"), box = $("#goalFields"); box.innerHTML = "";
  const goalDefs = [["steps", "Steps per day", "steps"], ["sleep", "Sleep per night", "hours"], ["hydration", "Hydration per day", "L"],
    ["mind", "Mindfulness per day", "min"], ["active", "Active calories per day", "kcal"], ["wkmin", "Workout minutes per week", "min"]];
  for (const [id, label, unit] of goalDefs) {
    const g = goalFor(id);
    box.append(h("label", { class: "field row" }, h("span", {}, label), h("input", { type: "number", min: "0", step: "any", name: "goal-" + id, value: g ?? "", placeholder: "no goal", "aria-label": label }), h("span", { class: "u" }, unit)));
  }
  $("#maxHrIn").value = S.maxHr || ""; $("#maxHrIn").placeholder = S.maxHrEstimate ? `estimated ${S.maxHrEstimate}` : "e.g. 185";
  $("#dbModeSel").value = store.get("dbmode", "auto");
  dlg.onclose = () => {
    if (dlg.returnValue !== "ok") return;
    for (const [id] of goalDefs) { const v = dlg.querySelector(`[name=goal-${id}]`).value.trim(); S.goals[id] = v === "" ? null : +v; }
    store.set("goals", S.goals);
    const mh = +$("#maxHrIn").value; S.maxHr = mh >= 100 && mh <= 240 ? mh : null; store.set("maxhr", S.maxHr);
    store.set("dbmode", $("#dbModeSel").value);
    if (S.open) render();
  };
  dlg.returnValue = ""; dlg.showModal();
}
function openMaps() {
  const dlg = $("#mapsDlg"), sel = $("#mapsProvider");
  sel.innerHTML = ""; for (const [k, P] of Object.entries(MAP_PROVIDERS)) sel.append(h("option", { value: k }, P.name));
  $("#mapsOn").checked = S.maps.on; sel.value = S.maps.provider; $("#mapsKey").value = S.maps.key; $("#mapsCustom").value = S.maps.custom;
  const sync = () => { const P = MAP_PROVIDERS[sel.value]; $("#mapsProvNote").textContent = P.note;
    $("#mapsKeyRow").classList.toggle("hidden", !P.key); $("#mapsCustomRow").classList.toggle("hidden", !P.custom); };
  sel.onchange = sync; sync();
  dlg.onclose = () => {
    if (dlg.returnValue !== "ok") return;
    S.maps = { on: $("#mapsOn").checked, provider: sel.value, key: $("#mapsKey").value.trim(), custom: $("#mapsCustom").value.trim() };
    store.set("maps", S.maps); netBadge(); if (S.open) render();
  };
  dlg.returnValue = ""; dlg.showModal();
}
function netBadge() {
  const on = S.maps.on && !!tileUrl();
  $("#netBadge").textContent = on ? "Map images online · health data stays here" : "Offline · nothing leaves this computer";
  $("#netBadge").title = on ? "Only map images for workout routes are downloaded. Scripts can't send anything (connect-src 'none')." : "No network requests are made.";
  $("#mapsBtn").textContent = on ? "Maps: on" : S.maps.on ? "Maps: needs setup" : "Maps: off";
  $("#mapsBtn").dataset.on = String(on);
}

// ---------------------------------------------------------------- installable offline app (online copy only)
function registerOffline() {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if ((location.protocol !== "https:" && !local) || !("serviceWorker" in navigator)) return;
  document.head.append(h("link", { rel: "manifest", href: "manifest.webmanifest" }));
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ---------------------------------------------------------------- wiring
S.imperial = store.get("units", false) === true || (() => { try { return localStorage.getItem("hcv-units") === "imp"; } catch { return false; } })();
S.trend = store.get("trend", 0) || 0;
S.maps = { ...S.maps, ...store.get("maps", {}) };
S.goals = store.get("goals", {}) || {};
S.maxHr = store.get("maxhr", null);
netBadge();
$("#mapsBtn").addEventListener("click", openMaps);
$("#settingsBtn").addEventListener("click", openSettings);
$("#printBtn").addEventListener("click", async () => { await flushSlots(); setTimeout(() => window.print(), 100); });
const fileInput = $("#file"), addInput = $("#addInput");
$("#pick").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => handleFiles(fileInput.files));
$("#addFiles").addEventListener("click", () => addInput.click());
addInput.addEventListener("change", () => { handleFiles(addInput.files); addInput.value = ""; });
const drop = $("#start");
["dragenter", "dragover"].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === "drop" || e.target === drop) drop.classList.remove("over"); }));
document.addEventListener("drop", e => { if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files); });
$("#openOther").addEventListener("click", () => { closeFile(); fileInput.value = ""; fileInput.click(); });
$("#themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark";
  if (S.open) document.querySelectorAll(".chart").forEach(c => c._paint?.());
});
$("#compareSel").addEventListener("change", e => { S.compare = e.target.value; render(); });
$("#customRange").addEventListener("submit", e => {
  e.preventDefault();
  const a = parseIsoDay(e.target.from.value), b = parseIsoDay(e.target.to.value);
  if (a == null || b == null || b < a) return;
  e.target.classList.add("hidden"); setRange(0, [a, b]);
});
window.addEventListener("pagehide", () => { DB.close(); });
DB.start().then(() => DB.cleanup()).catch(() => {});   // removes temporary copies left by earlier visits
registerOffline();
