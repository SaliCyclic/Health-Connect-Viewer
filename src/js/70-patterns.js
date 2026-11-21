// ============================================================================
// Patterns: when you are active, how sleep varies by weekday, and how measures
// relate to each other (with a fitted line and correlation r).
// ============================================================================

async function stepsHeatmapCard() {
  const m = METRICS.find(x => x.id === "steps");
  if (!has(m.table) || !timeCols(m.table)?.end) return null;
  const list = await sourcesFor(m.table);
  const sel = sourceSelect("steps", list, "sum", m.cat);
  const tc = timeCols(m.table), off = offExpr(m.table, tc.off);
  // local hour and weekday of each record's start; combined mode keeps the top-ranked app per hour slot
  const rows = await q(`SELECT CAST((${tc.t} + ${off}) / 3600000 AS INTEGER) hr, app_info_id, sum(count) FROM ${m.table}
    WHERE ${tc.t} BETWEEN ${S.from} AND ${S.to} ${srcClause("steps")} GROUP BY hr, app_info_id`);
  const perHour = new Map();
  const mode = srcMode("steps"), rank = rankFn(m.cat, list);
  for (const [hr, app, v] of rows) {
    const day = Math.floor(hr / 24); if (day < S.fromDay || day > S.toDay) continue;
    const o = perHour.get(hr);
    if (!o) perHour.set(hr, { app, v });
    else if (mode === COMBINED) { if (rank(app) < rank(o.app)) perHour.set(hr, { app, v }); }
    else o.v += v;
  }
  const sums = Array.from({ length: 7 }, () => Array(24).fill(0));
  const weeks = Array.from({ length: 7 }, () => new Set());
  for (const [hr, o] of perHour) { const day = Math.floor(hr / 24), wd = weekdayOf(day); sums[wd][hr % 24] += o.v; weeks[wd].add(day); }
  const values = sums.map((r, wd) => r.map(v => weeks[wd].size ? v / weeks[wd].size : null));
  const card = cardShell("When you're active", "average steps per hour, by weekday", sel); card.classList.add("wide");
  if (!perHour.size) return emptyCard(card, "No step data in this range.");
  let best = [0, 0]; values.forEach((r, i) => r.forEach((v, j) => { if (v > values[best[0]][best[1]]) best = [i, j]; }));
  const hourTotals = Array.from({ length: 24 }, (_, j) => mean(values.map(r => r[j] || 0)));
  const peak = hourTotals.indexOf(Math.max(...hourTotals));
  card.append(h("div", { class: "hero" }, stat(`${WEEKDAYS[best[0]]} ${String(best[1]).padStart(2, "0")}:00`, "busiest hour of the week"),
    stat(`${String(peak).padStart(2, "0")}:00`, "most active hour on average")));
  const c = h("div", { class: "chart" }); card.append(c);
  drawHeatmap(c, { rows: WEEKDAYS, cols: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")), values, unit: "steps", dp: 0, valueName: "Average steps", label: "Average steps per hour by weekday" });
  footer(card, "steps_by_hour.csv", ["weekday", ...Array.from({ length: 24 }, (_, i) => `h${i}`)], () => values.map((r, i) => [WEEKDAYS[i], ...r.map(v => v == null ? "" : Math.round(v))]), m.table);
  return card;
}

async function weekdayCard() {
  const nights = has(SLEEP_T) ? (await sleepData()).rowsD : [];
  const m = METRICS.find(x => x.id === "steps");
  const steps = has(m.table) ? (await dailyMetric(m, S.fromDay, S.toDay, await sourcesFor(m.table)))?.rows || [] : [];
  if (!nights.length && !steps.length) return null;
  const card = cardShell("Your week", "average by weekday", null);
  const byWd = (rows, f) => WEEKDAYS.map((_, wd) => mean(rows.filter(r => weekdayOf(r.day) === wd).map(f).filter(v => v != null)));
  const grid = h("div", { class: "grid tight" }); card.append(grid);
  const bars = (title, vals, unit, dp, fmtV) => {
    const box = h("div", {}, h("div", { class: "note" }, title), h("div", { class: "chart" }));
    grid.append(box);
    // weekdays on a fake day axis: use day numbers 0..6 with labels via bucket of 1 — rendered as a small bar list
    const mx = Math.max(...vals.map(v => v || 0)) || 1;
    box.querySelector(".chart").append(h("div", { class: "wbars" }, WEEKDAYS.map((d, i) => h("div", { class: "wbar" }, h("span", {}, d),
      h("span", { class: "zbar" }, h("i", { style: `width:${((vals[i] || 0) / mx * 100).toFixed(1)}%;background:var(--s1)` })), h("span", { class: "zv" }, vals[i] == null ? "–" : fmtV(vals[i]))))));
  };
  if (nights.length) bars("Sleep (night ending on)", byWd(nights, r => r.asleep), "h", 1, v => fmtDur(v * 3600000));
  if (steps.length) bars("Steps", byWd(steps, r => r.v), "steps", 0, v => nf(v));
  return card;
}

// correlation pairs: [x metric, y metric, lag in days (y measured lag days after x), description]
async function correlationsCard() {
  const series = {};
  const add = (key, label, rows, fmtV) => { if (rows?.length >= 10) series[key] = { label, map: new Map(rows.map(r => [r.day, r.v])), fmtV }; };
  if (has(SLEEP_T)) add("sleep", "Sleep (h)", (await sleepData()).rowsD.map(r => ({ day: r.day, v: r.asleep })), v => nf(v, 1) + " h");
  for (const id of ["steps", "rhr", "hrv", "active", "weight"]) {
    const m = METRICS.find(x => x.id === id); if (!has(m.table)) continue;
    const res = await dailyMetric(m, S.fromDay, S.toDay, await sourcesFor(m.table));
    if (res) { const { unit, conv, dp } = unitFor(m); add(id, `${m.label} (${unit})`, res.rows.map(r => ({ day: r.day, v: r.v == null ? null : conv(r.v) })), v => nf(v, dp)); }
  }
  const pairs = [
    ["sleep", "rhr", 0, "Sleep vs resting heart rate the next morning"],
    ["sleep", "hrv", 0, "Sleep vs HRV the next morning"],
    ["steps", "sleep", 1, "Steps vs sleep that night"],
    ["active", "sleep", 1, "Active calories vs sleep that night"],
    ["steps", "rhr", 1, "Steps vs resting heart rate the next day"],
  ].filter(([a, b]) => series[a] && series[b]);
  if (!pairs.length) return null;
  const card = cardShell("How your measures relate", "each dot is one day · dashed line = best fit · r near 0 means little connection", null); card.classList.add("wide");
  const grid = h("div", { class: "grid" }); card.append(grid);
  for (const [a, b, lag, title] of pairs) {
    const A = series[a], B = series[b], pts = [], labels = [];
    for (const [day, x] of A.map) { const y = B.map.get(day + lag); if (x != null && y != null) { pts.push([x, y]); labels.push(fmtDay(day)); } }
    if (pts.length < 10) continue;
    const box = h("div", { class: "card flat" }, h("div", { class: "note" }, title), h("div", { class: "chart" }));
    grid.append(box);
    drawXY($(".chart", box), { type: "scatter", points: pts, labels, xLabel: A.label, yLabel: B.label, xFmt: A.fmtV, yFmt: B.fmtV, regression: true, height: 220 });
    const reg = $(".chart", box)._reg;
    if (reg) box.append(h("div", { class: "note" }, describeR(reg.r, pts.length)));
  }
  if (!grid.children.length) return null;
  card.append(h("div", { class: "note", style: "margin-top:8px" }, "Correlation shows things that tend to move together, not what causes what."));
  return card;
}
function describeR(r, n) {
  const a = Math.abs(r), s = a < 0.1 ? "no clear" : a < 0.3 ? "a weak" : a < 0.5 ? "a moderate" : "a strong";
  return `${s[0].toUpperCase() + s.slice(1)} ${a < 0.1 ? "link" : (r > 0 ? "positive" : "negative") + " link"} (r = ${nf(r, 2)}, ${n} days).`;
}
