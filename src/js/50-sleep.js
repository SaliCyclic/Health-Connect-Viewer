// ============================================================================
// Sleep: stages per night, bedtime and wake time.
// ============================================================================
const SLEEP_T = "sleep_session_record_table", STAGE_T = "sleep_stages_table";

async function sleepNights(fromDay, toDay) {
  const T = SLEEP_T;
  const list = await sourcesFor(T);
  sourceSelect("sleep", list, "sessions", CATEGORY.SLEEP);            // settles the default source
  const [lo, hi] = msBounds(fromDay, toDay);
  const dayExpr = dayExprFor(T, "end_time", "end_zone_offset");
  const so = offExpr(T, "start_zone_offset"), eo = offExpr(T, "end_zone_offset");
  let sessions = await q(`SELECT row_id, start_time, end_time, ${dayExpr} d, app_info_id, start_time + ${so}, end_time + ${eo} FROM ${T}
     WHERE end_time BETWEEN ${lo} AND ${hi} ${srcClause("sleep")} AND ${dayExpr} BETWEEN ${fromDay} AND ${toDay} ORDER BY start_time`);
  if (srcMode("sleep") === COMBINED && list.length > 1) sessions = dedupeSessions(sessions, rankFn(CATEGORY.SLEEP, list), 1, 2, 4);
  const stages = new Map();
  if (has(STAGE_T) && sessions.length) {
    const ids = sessions.map(s => s[0]);
    for (let i = 0; i < ids.length; i += 500)
      for (const [pk, type, ms] of await q(`SELECT parent_key, stage_type, sum(stage_end_time - stage_start_time) FROM ${STAGE_T} WHERE parent_key IN (${ids.slice(i, i + 500).join(",")}) GROUP BY 1, 2`)) {
        if (!stages.has(pk)) stages.set(pk, {}); stages.get(pk)[type] = ms;
      }
  }
  // one row per night (sessions ending on the same local day are combined, naps included)
  const nights = new Map();
  for (const [id, st, en, day, , stL, enL] of sessions) {
    let n = nights.get(day); if (!n) { n = { day, start: st, end: en, startL: stL, endL: enL, n: 0 }; for (const g of SLEEP_GROUPS) n[g.key] = 0; nights.set(day, n); }
    n.n++; if (st < n.start) { n.start = st; n.startL = stL; } if (en > n.end) { n.end = en; n.endL = enL; }
    const sg = stages.get(id);
    if (sg) { for (const g of SLEEP_GROUPS) for (const t of g.types) n[g.key] += (sg[t] || 0) / 3600000;
      const staged = Object.values(sg).reduce((a, b) => a + b, 0); n.other += Math.max(0, (en - st - staged) / 3600000); }
    else n.other += (en - st) / 3600000;
  }
  const rowsD = [...nights.values()].sort((a, b) => a.day - b.day);
  for (const r of rowsD) r.asleep = r.deep + r.light + r.rem + r.other;
  return { rowsD, list };
}
const sleepData = () => memo("sleep", () => sleepNights(S.fromDay, S.toDay));
async function sleepSel() { const list = await sourcesFor(SLEEP_T); return sourceSelect("sleep", list, "sessions", CATEGORY.SLEEP); }

async function sleepStagesCard() {
  const { rowsD, list } = await sleepData();
  const keys = SLEEP_GROUPS.map(g => g.key).concat("asleep");
  const { rows, b } = bucketize(rowsD, keys);
  const card = cardShell("Sleep", `hours per night${b.size > 1 ? `, ${b.name}ly average` : ""} · night is dated by the morning it ends`, await sleepSel());
  card.classList.add("wide");
  if (!rowsD.length) return emptyCard(card, "No sleep sessions in this range.");
  const avg = k => mean(rowsD.map(r => r[k]));
  const hasStages = rowsD.some(r => r.deep + r.light + r.rem > 0);
  const goal = goalFor("sleep");
  const hero = h("div", { class: "hero" }, stat(fmtDur(avg("asleep") * 3600000), `average asleep (${rowsD.length} nights)`),
    hasStages ? stat(fmtDur(avg("deep") * 3600000), "average deep") : null, hasStages ? stat(fmtDur(avg("rem") * 3600000), "average REM") : null,
    stat(fmtDur(avg("awake") * 3600000), "average awake"));
  if (goal != null) hero.append(stat(`${rowsD.filter(r => r.asleep >= goal).length}/${rowsD.length}`, `nights at goal (${nf(goal, 1)} h)`));
  const cmp = compareRange();
  if (cmp) {
    const prev = await sleepNights(S.fromDay - cmp.shift, S.toDay - cmp.shift);
    if (prev.rowsD.length) { const pa = mean(prev.rowsD.map(r => r.asleep)); hero.append(stat(pct((avg("asleep") - pa) / pa), `vs ${cmp.name.toLowerCase()} (${fmtDur(pa * 3600000)})`, "delta")); }
  }
  card.append(hero);
  const groups = SLEEP_GROUPS.filter(g => rowsD.some(r => r[g.key] > 0.01));
  const series = groups.map(g => ({ name: g.name, values: rows.map(r => r[g.key]), color: g.color }));
  if (S.trend) { const rb = new Map(bucketize(rolling(rowsD.map(r => ({ day: r.day, v: r.asleep })), S.trend), ["v"], b).rows.map(r => [r.day, r.v]));
    series.push({ name: `${S.trend}-day average`, values: rows.map(r => rb.get(r.day) ?? null), style: "trend" }); }
  const chart = h("div", { class: "chart" }); card.append(chart);
  drawChart(chart, { type: "stack", days: rows.map(r => r.day), bucket: b, unit: "h", dp: 1, height: 240, series,
    goal: goal != null ? { value: goal, label: `Goal ${nf(goal, 1)} h` } : null });
  footer(card, "sleep_nights.csv", ["night_ending", "bed", "wake", "asleep_h", ...SLEEP_GROUPS.map(g => g.name.toLowerCase().replace(/\W+/g, "_") + "_h"), "sessions"],
    () => rowsD.map(r => [isoDay(r.day), fmtDT(r.start), fmtDT(r.end), +r.asleep.toFixed(2), ...SLEEP_GROUPS.map(g => +r[g.key].toFixed(2)), r.n]),
    `${SLEEP_T}${has(STAGE_T) ? " + " + STAGE_T : ""}${srcMode("sleep") === COMBINED && list.length > 1 ? " · overlapping nights from other apps removed" : ""}`);
  return card;
}
const clockOf = msLocal => { const t = new Date(msLocal); return t.getUTCHours() + t.getUTCMinutes() / 60; };   // already shifted to local
const bedClock = r => { const x = clockOf(r.startL); return x < 12 ? x + 24 : x; };   // after-midnight bedtimes plot past 24
async function clockCard(which) {
  const { rowsD } = await sleepData();
  const isBed = which === "bed";
  const card = cardShell(isBed ? "Bedtime" : "Wake time", "clock time in the time zone where you slept · dashed line = average", await sleepSel());
  if (!rowsD.length) return emptyCard(card, "No sleep sessions in this range.");
  const vals = rowsD.map(r => isBed ? bedClock(r) : clockOf(r.endL));
  const m = mean(vals);
  const sd = Math.sqrt(mean(vals.map(x => (x - m) ** 2)));
  card.append(h("div", { class: "hero" }, stat(fmtClock(m), isBed ? "average bedtime" : "average wake time"),
    stat(`± ${Math.round(sd * 60)} min`, "typical variation"),
    stat(`${fmtClock(Math.min(...vals))}–${fmtClock(Math.max(...vals))}`, "earliest – latest")));
  const c = h("div", { class: "chart" }); card.append(c);
  drawChart(c, { type: "dots", days: rowsD.map(r => r.day), bucket: { size: 1, name: "day" }, unit: "", dp: 1, yFmt: fmtClock, avgLine: true,
    series: [{ name: isBed ? "Bedtime" : "Wake time", values: vals, color: isBed ? "--s1" : "--s2" }] });
  footer(card, isBed ? "bedtimes.csv" : "wake_times.csv", ["night_ending", isBed ? "bedtime" : "wake_time"],
    () => rowsD.map((r, i) => [isoDay(r.day), fmtClock(vals[i])]), SLEEP_T);
  return card;
}
