// ============================================================================
// Range handling and the standard metric cards (bar/line charts per day).
// ============================================================================

function setRange(days, custom) {
  S.range = days; S.custom = custom || null;
  const endDataDay = Math.floor((S.dataMax + TZ_SEC * 1000) / DAY);    // anchor to the latest data, not today
  if (custom) { S.fromDay = custom[0]; S.toDay = custom[1]; }
  else { S.toDay = endDataDay; S.fromDay = days ? endDataDay - days + 1 : Math.floor((S.dataMin + TZ_SEC * 1000) / DAY); }
  [S.from, S.to] = msBounds(S.fromDay, S.toDay);
  buildChrome(); render();
}
// generous ms bounds for a day range; exact filtering is by local day
const msBounds = (fromDay, toDay) => [fromDay * DAY - 2 * DAY, (toDay + 2) * DAY];
const rangeText = () => `${fmtDay(S.fromDay)} – ${fmtDay(S.toDay)}`;
const rangeLen = () => S.toDay - S.fromDay + 1;
// previous period to compare with: same length just before, or the same dates a year earlier
function compareRange() {
  if (S.compare === "prev") return { shift: rangeLen(), name: `Previous ${rangeLen()} days` };
  if (S.compare === "year") { const dt = dayToDate(S.fromDay); const prev = Math.floor(Date.UTC(dt.getUTCFullYear() - 1, dt.getUTCMonth(), dt.getUTCDate()) / DAY); return { shift: S.fromDay - prev, name: "Same period last year" }; }
  return null;
}
function bucketing() {
  const n = rangeLen();
  if (n <= 120) return { size: 1, name: "day" };
  if (n <= 800) return { size: 7, name: "week" };
  return { size: 30, name: "month" };
}
function bucketStart(d, b) {
  if (b.size === 1) return d;
  const dt = dayToDate(d);
  if (b.size === 7) return d - weekdayOf(d);
  return Math.floor(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1) / DAY);
}
// daily rows [{day, ...keys}] → bucket rows; values become averages over days with data
function bucketize(rows, keys, b = bucketing()) {
  if (b.size === 1) return { rows, b };
  const map = new Map();
  for (const r of rows) {
    const k = bucketStart(r.day, b); let o = map.get(k);
    if (!o) { o = { day: k }; for (const key of keys) { o[key] = 0; o["_c" + key] = 0; } map.set(k, o); }
    for (const key of keys) if (r[key] != null) { o[key] += r[key]; o["_c" + key]++; }
  }
  const out = [...map.values()].sort((a, b2) => a.day - b2.day);
  for (const o of out) for (const key of keys) o[key] = o["_c" + key] ? o[key] / o["_c" + key] : null;
  return { rows: out, b };
}
// rolling mean over a calendar window, from daily rows {day, v}
function rolling(daily, w) {
  const out = []; let i0 = 0, sum = 0, cnt = 0;
  for (let i = 0; i < daily.length; i++) {
    sum += daily[i].v ?? 0; cnt += daily[i].v != null ? 1 : 0;
    while (daily[i0].day <= daily[i].day - w) { sum -= daily[i0].v ?? 0; cnt -= daily[i0].v != null ? 1 : 0; i0++; }
    out.push({ day: daily[i].day, v: cnt >= Math.ceil(w / 3) ? sum / cnt : null });
  }
  return out;
}
const goalFor = id => { const g = S.goals[id]; if (g === null || g === "") return null; if (g != null) return +g; return METRICS.find(m => m.id === id)?.goal ?? (id === "sleep" ? 8 : null); };

// ---------------------------------------------------------------- card pieces
function cardShell(title, sub, selectEl) {
  const card = h("div", { class: "card" });
  card.append(h("div", { class: "card-head" }, h("div", {}, h("h3", {}, title), sub ? h("div", { class: "sub" }, sub) : null), h("span", { class: "spacer" }), selectEl));
  return card;
}
function stat(v, l, cls) { return h("div", { class: cls || "" }, h("div", { class: "v" }, v), h("div", { class: "l" }, l)); }
function simpleTable(header, rows) {
  return h("table", { class: "data" }, h("thead", {}, h("tr", {}, header.map(x => h("th", { scope: "col" }, x)))),
    h("tbody", {}, rows.map(r => h("tr", {}, r.map(c => h("td", {}, c == null ? "" : c))))));
}
// footer: source note + Table / CSV / PNG. rowsOrFn may be a function, built only when needed.
function footer(card, csvName, header, rowsOrFn, note, opts = {}) {
  let rows = null; const getRows = () => rows || (rows = typeof rowsOrFn === "function" ? rowsOrFn() : rowsOrFn);
  const f = h("div", { class: "card-foot" });
  f.append(h("span", { class: "src", title: note || "" }, note || ""));
  const tableBox = h("div", { class: "hidden scroll", style: "margin-top:8px;max-height:260px" });
  const tbtn = h("button", { "aria-expanded": "false", onclick: () => { tableBox.classList.toggle("hidden"); const open = !tableBox.classList.contains("hidden");
      tbtn.textContent = open ? "Hide table" : "Table"; tbtn.setAttribute("aria-expanded", String(open));
      if (!tableBox.firstChild) tableBox.append(simpleTable(header, getRows().slice().reverse())); } }, "Table");
  card._showTable = () => { if (tableBox.classList.contains("hidden")) tbtn.click(); };
  f.append(tbtn, h("button", { onclick: () => download(csvName, csvText(header, getRows())) }, "CSV"));
  if (!opts.noPng) f.append(h("button", { title: "Save this chart as an image", onclick: () => chartToPng(card, csvName.replace(/\.csv$/, "")) }, "PNG"));
  card.append(f, tableBox);
}
function emptyCard(card, msg) { card.append(h("div", { class: "empty" }, msg)); return card; }

// ---------------------------------------------------------------- queries per metric
// Daily values for a metric over [fromDay, toDay] using the source chosen for it.
async function dailyMetric(m, fromDay, toDay, list) {
  const tc = timeCols(m.table); if (!tc) return null;
  const [lo, hi] = msBounds(fromDay, toDay);
  let vc = null, val;
  if (m.kind === "duration") { if (!tc.end) return null; val = `(${tc.end} - ${tc.t}) / 60000.0`; }
  else { vc = valueCol(m); if (!vc) return null; val = vc.name; }
  const mode = srcMode(m.id), scale = m.scale || 1;
  const inRange = r => r.day >= fromDay && r.day <= toDay;
  const dayExpr = dayExprFor(m.table, tc.t, tc.off);
  if (mode === COMBINED && list.length > 1) {
    const rank = rankFn(m.cat, list);
    if (m.kind === "avg") {
      const rows = await q(`SELECT ${dayExpr} d, avg(${val}), count(*), app_info_id FROM ${m.table} WHERE ${tc.t} BETWEEN ${lo} AND ${hi} GROUP BY d, app_info_id`);
      return { vc, rows: [...combinePerDay(rows, rank).values()].map(([day, v, n, app]) => ({ day, v: v == null ? null : v * scale, n, app })).filter(inRange).sort((a, b) => a.day - b.day) };
    }
    if (tc.end) {
      const offCol = hasCol(m.table, tc.off) ? tc.off : "NULL";
      const recs = await q(`SELECT ${tc.t}, ${tc.end}, ${val}, app_info_id, ${offCol} FROM ${m.table} WHERE ${tc.end} >= ${lo} AND ${tc.t} <= ${hi} AND ${val} IS NOT NULL`);
      if (offCol !== "NULL" && (offUnit[m.table + "." + tc.off] === 1)) for (const r of recs) if (r[4] != null) r[4] = r[4] / 1000;
      const counts = new Map(); for (const r of recs) { const d = localDayOf(r[0], r[4]); counts.set(d, (counts.get(d) || 0) + 1); }
      return { vc, rows: [...combineIntervals(recs, rank)].map(([day, v]) => ({ day, v: v * scale, n: counts.get(day) || 0 })).filter(inRange).sort((a, b) => a.day - b.day) };
    }
  }
  const agg = m.kind === "avg" ? "avg" : "sum";
  const rows = (await q(`SELECT ${dayExpr} d, ${agg}(${val}), count(*) FROM ${m.table}
    WHERE ${tc.t} BETWEEN ${lo} AND ${hi} ${srcClause(m.id)} GROUP BY d HAVING d BETWEEN ${fromDay} AND ${toDay} ORDER BY d`))
    .map(([day, v, n]) => ({ day, v: v == null ? null : v * scale, n }));
  return { vc, rows };
}

// ---------------------------------------------------------------- generic metric card
async function metricCard(m) {
  const list = await sourcesFor(m.table);
  const sel = sourceSelect(m.id, list, m.kind === "avg" ? "avg" : "sum", m.cat);
  const res = await dailyMetric(m, S.fromDay, S.toDay, list);
  if (!res) return null;
  const { rows: daily, vc } = res;
  const { unit, conv, dp } = unitFor(m);
  const cv = v => v == null ? null : conv(v);
  const isSum = m.kind !== "avg";
  const b = bucketing();
  const { rows } = bucketize(daily.map(r => ({ day: r.day, v: cv(r.v) })), ["v"], b);
  const sub = `${unit}${isSum ? (b.size > 1 ? ` · daily average per ${b.name}` : " per day") : (b.size > 1 ? ` · ${b.name}ly average` : "")}`;
  const card = cardShell(m.label, sub, sel);
  if (!daily.length) {
    let msg = "No records in this range.";
    const tc = timeCols(m.table);
    if (m.kind === "avg" && vc && tc) {
      const last = (await q(`SELECT ${vc.name}, ${tc.t} FROM ${m.table} WHERE ${vc.name} IS NOT NULL ${srcClause(m.id)} ORDER BY ${tc.t} DESC LIMIT 1`))[0];
      if (last) msg = `No records in this range. Most recent: ${nf(conv(last[0] * (m.scale || 1)), dp)} ${unit} on ${fmtDT(last[1])}.`;
    }
    return emptyCard(card, msg);
  }
  const vals = daily.map(r => cv(r.v)).filter(x => x != null);
  const avg = mean(vals);
  const series = [{ name: m.label, values: rows.map(r => r.v), color: "--s1" }];
  // comparison with an earlier period, drawn as a dashed grey line under this one
  const cmp = compareRange(); let cmpAvg = null;
  if (cmp) {
    const prev = await dailyMetric(m, S.fromDay - cmp.shift, S.toDay - cmp.shift, list);
    const shifted = prev.rows.map(r => ({ day: r.day + cmp.shift, v: cv(r.v) }));
    if (shifted.length) {
      cmpAvg = mean(shifted.map(r => r.v).filter(v => v != null));
      const pb = bucketize(shifted, ["v"], b).rows; const pm = new Map(pb.map(r => [r.day, r.v]));
      series.push({ name: cmp.name, values: rows.map(r => pm.get(r.day) ?? null), style: "ghost" });
    }
  }
  if (S.trend) {
    const roll = rolling(daily.map(r => ({ day: r.day, v: cv(r.v) })), S.trend);
    const rb = new Map(bucketize(roll, ["v"], b).rows.map(r => [r.day, r.v]));
    series.push({ name: `${S.trend}-day average`, values: rows.map(r => rb.get(r.day) ?? null), style: "trend" });
  }
  const goal = goalFor(m.id); const goalV = goal != null ? conv(goal) : null;
  const hero = h("div", { class: "hero" });
  if (isSum) hero.append(stat(nf(avg, dp), `avg / day (${daily.length} days)`), stat(nf(vals.reduce((a, x) => a + x, 0), dp), "total"), stat(nf(Math.max(...vals), dp), "best day"));
  else hero.append(stat(nf(vals[vals.length - 1], dp), `latest · ${fmtDay(daily[daily.length - 1].day)}`), stat(nf(avg, dp), "average"),
    stat(`${nf(Math.min(...vals), dp)}–${nf(Math.max(...vals), dp)}`, "range"));
  if (cmpAvg != null) hero.append(stat(pct((avg - cmpAvg) / Math.abs(cmpAvg || 1)), `vs ${cmp.name.toLowerCase()} (${nf(cmpAvg, dp)})`, "delta"));
  if (goalV != null && isSum) hero.append(stat(`${vals.filter(v => v >= goalV).length}/${vals.length}`, `days at goal (${nf(goalV, dp)})`));
  card.append(hero);
  const chart = h("div", { class: "chart" }); card.append(chart);
  drawChart(chart, { type: isSum ? "bar" : "line", days: rows.map(r => r.day), bucket: b, series, unit, dp,
    goal: goalV != null ? { value: goalV, label: `Goal ${nf(goalV, dp)}` } : null });
  const srcNote = srcMode(m.id) === COMBINED && list.length > 1 ? ` · combined from ${list.length} apps${usesHcPriority(m.cat) ? " by your Health Connect priority" : ""}` : "";
  footer(card, `${m.id}_daily.csv`, ["date", `${m.label} (${unit})`, "records"], () => daily.map(r => [isoDay(r.day), r.v == null ? "" : +cv(r.v).toFixed(dp + 2), r.n]),
    (vc ? `${m.table}.${vc.name}${vc.guessed ? " (guessed column)" : ""}` : m.table) + srcNote);
  return card;
}

// ---------------------------------------------------------------- heart rate
async function hrDaily() {
  if (S.hrDaily) return S.hrDaily;
  const P = "heart_rate_record_table", Sx = "heart_rate_record_series_table";
  const tCol = hasCol(Sx, "epoch_millis") ? "epoch_millis" : "time";
  const bCol = hasCol(Sx, "beats_per_minute") ? "beats_per_minute" : "bpm";
  if (!hasCol(Sx, tCol) || !hasCol(Sx, bCol)) return (S.hrDaily = []);
  // Heart-rate samples are by far the biggest table, so they are summarised per day and source
  // once (one pass, in the background worker); range and source changes then just slice it.
  S.hrDaily = q(`SELECT ${dayExprFor(P, tCol, "start_zone_offset", "p").replace(`p.${tCol}`, `s.${tCol}`)} d, p.app_info_id, min(s.${bCol}), sum(s.${bCol}), max(s.${bCol}), count(*)
     FROM ${Sx} s JOIN ${P} p ON s.parent_key = p.row_id WHERE s.${bCol} > 0 GROUP BY d, p.app_info_id ORDER BY d`);
  return S.hrDaily;
}
async function hrCard() {
  const P = "heart_rate_record_table";
  if (!has(P) || !has("heart_rate_record_series_table")) return null;
  const list = await sourcesFor(P);
  const sel = sourceSelect("hr", list, "avg", CATEGORY.VITALS);
  const all = await hrDaily();
  const mode = srcMode("hr"), rank = rankFn(CATEGORY.VITALS, list);
  const byDay = new Map();
  for (const [day, app, lo, sum, hi, n] of all) {
    if (day < S.fromDay || day > S.toDay) continue;
    if (mode !== ALL && mode !== COMBINED && app !== Number(mode)) continue;
    const o = byDay.get(day);
    if (mode === COMBINED) { if (!o || rank(app) < rank(o.app)) byDay.set(day, { day, lo, hi, sum, n, app }); continue; }
    if (!o) byDay.set(day, { day, lo, hi, sum, n });
    else { o.lo = Math.min(o.lo, lo); o.hi = Math.max(o.hi, hi); o.sum += sum; o.n += n; }
  }
  const daily = [...byDay.values()].sort((a, b) => a.day - b.day).map(o => ({ day: o.day, lo: o.lo, v: o.sum / o.n, hi: o.hi, n: o.n }));
  const { rows, b } = bucketize(daily, ["lo", "v", "hi"]);
  const card = cardShell("Heart rate", `bpm · ${b.size > 1 ? b.name + "ly " : "daily "}average with low–high band`, sel);
  card.classList.add("wide");
  if (!daily.length) return emptyCard(card, "No heart-rate samples in this range.");
  const total = daily.reduce((a, r) => a + r.n, 0);
  card.append(h("div", { class: "hero" }, stat(nf(daily.reduce((a, r) => a + r.v * r.n, 0) / total), "average"), stat(nf(Math.min(...daily.map(r => r.lo))), "lowest sample"),
    stat(nf(Math.max(...daily.map(r => r.hi))), "highest sample"), stat(total.toLocaleString(), "samples")));
  const series = [{ name: "Average", values: rows.map(r => r.v), color: "--s1" }];
  if (S.trend) { const rb = new Map(bucketize(rolling(daily, S.trend), ["v"], b).rows.map(r => [r.day, r.v])); series.push({ name: `${S.trend}-day average`, values: rows.map(r => rb.get(r.day) ?? null), style: "trend" }); }
  const chart = h("div", { class: "chart" }); card.append(chart);
  drawChart(chart, { type: "line", days: rows.map(r => r.day), bucket: b, unit: "bpm", dp: 0, height: 220,
    band: { lo: rows.map(r => r.lo), hi: rows.map(r => r.hi), name: "Low–high" }, series });
  footer(card, "heart_rate_daily.csv", ["date", "min_bpm", "avg_bpm", "max_bpm", "samples"],
    () => daily.map(r => [isoDay(r.day), r.lo, +r.v.toFixed(1), r.hi, r.n]), "heart_rate_record_series_table joined to heart_rate_record_table");
  return card;
}

// ---------------------------------------------------------------- blood pressure
async function bpCard(m) {
  const T = m.table; if (!hasCol(T, "systolic") || !hasCol(T, "diastolic")) return null;
  const list = await sourcesFor(T);
  const sel = sourceSelect("bp", list, "avg", CATEGORY.VITALS);
  const dayExpr = dayExprFor(T, "time", "zone_offset");
  let daily;
  if (srcMode("bp") === COMBINED && list.length > 1) {
    const rows = await q(`SELECT ${dayExpr} d, avg(systolic), count(*), app_info_id, avg(diastolic) FROM ${T} WHERE time BETWEEN ${S.from} AND ${S.to} GROUP BY d, app_info_id`);
    daily = [...combinePerDay(rows, rankFn(CATEGORY.VITALS, list)).values()].filter(r => r[0] >= S.fromDay && r[0] <= S.toDay)
      .map(([day, sys, n, , dia]) => ({ day, sys, dia, n })).sort((a, b) => a.day - b.day);
  } else daily = (await q(`SELECT ${dayExpr} d, avg(systolic), avg(diastolic), count(*) FROM ${T} WHERE time BETWEEN ${S.from} AND ${S.to} ${srcClause("bp")}
     GROUP BY d HAVING d BETWEEN ${S.fromDay} AND ${S.toDay} ORDER BY d`)).map(([day, sys, dia, n]) => ({ day, sys, dia, n }));
  const { rows, b } = bucketize(daily, ["sys", "dia"]);
  const card = cardShell("Blood pressure", `mmHg${b.size > 1 ? ` · ${b.name}ly average` : ""}`, sel);
  if (!daily.length) return emptyCard(card, "No readings in this range.");
  const avg = k => daily.reduce((a, r) => a + r[k] * r.n, 0) / daily.reduce((a, r) => a + r.n, 0);
  const last = daily[daily.length - 1];
  card.append(h("div", { class: "hero" }, stat(`${nf(last.sys)}/${nf(last.dia)}`, `latest · ${fmtDay(last.day)}`), stat(`${nf(avg("sys"))}/${nf(avg("dia"))}`, "average"),
    stat(daily.reduce((a, r) => a + r.n, 0), "readings")));
  const chart = h("div", { class: "chart" }); card.append(chart);
  drawChart(chart, { type: "line", days: rows.map(r => r.day), bucket: b, unit: "mmHg", dp: 0,
    series: [{ name: "Systolic", values: rows.map(r => r.sys), color: "--s1" }, { name: "Diastolic", values: rows.map(r => r.dia), color: "--s2" }] });
  const rawSql = `SELECT time, systolic, diastolic, app_info_id FROM ${T} WHERE time BETWEEN ${S.from} AND ${S.to} ${srcClause("bp")} ORDER BY time`;
  const raw = await q(rawSql);
  footer(card, "blood_pressure_readings.csv", ["time", "systolic", "diastolic", "source"], () => raw.map(r => [fmtDT(r[0]), +(+r[1]).toFixed(0), +(+r[2]).toFixed(0), appName(r[3])]), T);
  return card;
}
