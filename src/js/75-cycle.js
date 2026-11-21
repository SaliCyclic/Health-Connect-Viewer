// ============================================================================
// Cycle: periods and flow from Health Connect, plus symptoms, ratings and notes
// from an OpenVitals cycle-journal backup if you add one.
// ============================================================================
const PERIOD_T = "menstruation_period_record_table", FLOW_T = "menstruation_flow_record_table";
const FLOW_NAMES = ["Unknown", "Light", "Medium", "Heavy"];
const cycleAvailable = () => has(PERIOD_T) || has(FLOW_T) || !!S.cycleJournal;

// all period days (whole history, so cycles that started before the range are measured correctly)
async function periodDays() {
  return memo("periods", async () => {
    const days = new Map();   // day -> flow (0 unknown .. 3 heavy)
    if (has(PERIOD_T) && hasCol(PERIOD_T, "start_time")) {
      for (const [st, en, so, eo] of await q(`SELECT start_time, end_time, ${hasCol(PERIOD_T, "start_zone_offset") ? "start_zone_offset" : "NULL"}, ${hasCol(PERIOD_T, "end_zone_offset") ? "end_zone_offset" : "NULL"} FROM ${PERIOD_T}`)) {
        const a = localDayOf(st, so), b = localDayOf(Math.max(st, en - 1), eo);
        for (let d = a; d <= b && d - a < 20; d++) if (!days.has(d)) days.set(d, 0);
      }
    }
    if (has(FLOW_T) && hasCol(FLOW_T, "time")) {
      const fcol = hasCol(FLOW_T, "flow") ? "flow" : valueCol({ table: FLOW_T, cols: ["flow"] })?.name;
      if (fcol) for (const [t, off, f] of await q(`SELECT time, ${hasCol(FLOW_T, "zone_offset") ? "zone_offset" : "NULL"}, ${fcol} FROM ${FLOW_T}`)) {
        const d = localDayOf(t, off); days.set(d, Math.max(days.get(d) || 0, f || 0));
      }
    }
    return days;
  });
}
// group period days into periods (gaps of up to 2 days join), then cycles = start to next start
function cyclesFrom(days) {
  const sorted = [...days.keys()].sort((a, b) => a - b);
  const periods = [];
  for (const d of sorted) { const p = periods[periods.length - 1]; if (p && d - p.end <= 3) p.end = d; else periods.push({ start: d, end: d }); }
  const excluded = new Set(S.cycleJournal?.exclusions || []);
  return periods.map((p, i) => ({ ...p, len: p.end - p.start + 1, cycle: periods[i + 1] ? periods[i + 1].start - p.start : null, excluded: excluded.has(p.start) }));
}

async function cycleOverviewCard() {
  const days = await periodDays();
  const card = cardShell("Cycles", "periods from Health Connect (period and flow records)", null); card.classList.add("wide");
  if (!days.size) return emptyCard(card, S.cycleJournal ? "The journal is loaded, but this export has no period or flow records." : "No period or flow records in this export.");
  const cyc = cyclesFrom(days);
  const inRange = cyc.filter(c => c.start >= S.fromDay && c.start <= S.toDay);
  const lens = inRange.filter(c => c.cycle && !c.excluded && c.cycle < 90).map(c => c.cycle);
  const plens = inRange.map(c => c.len);
  const last = cyc[cyc.length - 1];
  const avgLen = mean(lens);
  card.append(h("div", { class: "hero" }, stat(avgLen ? `${nf(avgLen, 1)} days` : "–", `average cycle (${lens.length} cycles)`),
    stat(lens.length ? `${Math.min(...lens)}–${Math.max(...lens)} days` : "–", "shortest – longest"),
    stat(plens.length ? `${nf(mean(plens), 1)} days` : "–", "average period"),
    stat(last ? fmtDay(last.start) : "–", "last period started"),
    avgLen && last ? stat(fmtDay(last.start + Math.round(avgLen)), "next period expected around") : null));
  if (lens.length >= 2) {
    const withLen = inRange.filter(c => c.cycle && !c.excluded && c.cycle < 90);
    const c = h("div", { class: "chart" }); card.append(c);
    drawChart(c, { type: "dots", days: withLen.map(x => x.start), bucket: { size: 1, name: "day" }, unit: "days", dp: 0, avgLine: true,
      series: [{ name: "Cycle length", values: withLen.map(x => x.cycle), color: "--s5" }] });
  }
  card.append(calendar(days, S.cycleJournal));
  footer(card, "cycles.csv", ["period_start", "period_end", "period_days", "cycle_days", "excluded"],
    () => cyc.map(c => [isoDay(c.start), isoDay(c.end), c.len, c.cycle ?? "", c.excluded ? 1 : 0]), `${PERIOD_T} + ${FLOW_T}`, { noPng: lens.length < 2 });
  return card;
}
// month grid; period days shaded by flow, journal days marked with a dot
function calendar(days, journal) {
  const jdays = new Set((journal?.entries || []).map(e => e.day));
  const start = dayToDate(Math.max(S.fromDay, S.toDay - 400)), end = dayToDate(S.toDay);
  const wrap = h("div", { class: "cal" });
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); y < end.getUTCFullYear() || (y === end.getUTCFullYear() && m <= end.getUTCMonth()); m === 11 ? (y++, m = 0) : m++) {
    const first = Math.floor(Date.UTC(y, m, 1) / DAY), n = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const grid = h("div", { class: "cal-grid" });
    for (let i = 0; i < weekdayOf(first); i++) grid.append(h("span"));
    for (let d = 0; d < n; d++) {
      const day = first + d, f = days.get(day);
      grid.append(h("span", { class: "cal-d" + (f != null ? " p" + f : "") + (jdays.has(day) ? " j" : ""), title: `${fmtDay(day)}${f != null ? " · period" + (f ? ` (${FLOW_NAMES[f].toLowerCase()} flow)` : "") : ""}${jdays.has(day) ? " · journal entry" : ""}` }, d + 1));
    }
    wrap.append(h("div", { class: "cal-m" }, h("div", { class: "cal-t" }, dateFmt({ timeZone: "UTC", month: "short", year: "numeric" }).format(new Date(first * DAY))), grid));
  }
  return h("div", {}, h("div", { class: "legend", style: "margin-top:12px" },
    h("span", {}, h("i", { class: "cal-key p1" }), "Light"), h("span", {}, h("i", { class: "cal-key p2" }), "Medium"), h("span", {}, h("i", { class: "cal-key p3" }), "Heavy"),
    h("span", {}, h("i", { class: "cal-key p0" }), "Period (flow not recorded)"), journal ? h("span", {}, h("i", { class: "cal-key j" }), "Journal entry") : null), wrap);
}
async function cycleJournalCards() {
  const J = S.cycleJournal; if (!J) return [];
  const ents = J.entries.filter(e => e.day >= S.fromDay && e.day <= S.toDay);
  const out = [];
  const sym = cardShell("Symptoms", `from your OpenVitals cycle journal · ${ents.length} days with entries`, null);
  const counts = new Map(); for (const e of ents) for (const s of e.symptoms) counts.set(s, (counts.get(s) || 0) + 1);
  if (!counts.size) emptyCard(sym, "No symptoms logged in this range.");
  else { const mx = Math.max(...counts.values());
    sym.append(h("div", { class: "wbars" }, [...counts].sort((a, b) => b[1] - a[1]).map(([s, n]) => h("div", { class: "wbar" }, h("span", {}, CYCLE_SYMPTOMS[s] || s),
      h("span", { class: "zbar" }, h("i", { style: `width:${(n / mx * 100).toFixed(1)}%;background:var(--s5)` })), h("span", { class: "zv" }, `${n} day${n > 1 ? "s" : ""}`))))); }
  out.push(sym);
  const rated = ents.filter(e => e.pain || e.mood || e.energy);
  const rc = cardShell("Pain, mood and energy", "your 1–5 ratings", null); rc.classList.add("wide");
  if (!rated.length) emptyCard(rc, "No ratings in this range.");
  else {
    const c = h("div", { class: "chart" }); rc.append(c);
    drawChart(c, { type: "line", days: rated.map(e => e.day), bucket: { size: 1, name: "day" }, unit: "", dp: 0,
      series: [{ name: "Pain", values: rated.map(e => e.pain), color: "--s2" }, { name: "Mood", values: rated.map(e => e.mood), color: "--s1" }, { name: "Energy", values: rated.map(e => e.energy), color: "--s3" }] });
    footer(rc, "cycle_ratings.csv", ["date", "pain", "mood", "energy", "desire"], () => rated.map(e => [isoDay(e.day), e.pain ?? "", e.mood ?? "", e.energy ?? "", e.desire ?? ""]), "OpenVitals cycle journal");
  }
  out.push(rc);
  const notes = ents.filter(e => e.notes.trim());
  if (notes.length) {
    const nc = cardShell("Journal notes", `${notes.length} notes`, null); nc.classList.add("wide");
    nc.append(h("div", { class: "scroll" }, simpleTable(["Date", "Symptoms", "Note"], notes.slice().reverse().map(e => [fmtDay(e.day), e.symptoms.map(s => CYCLE_SYMPTOMS[s] || s).join(", "), e.notes]))));
    out.push(nc);
  }
  return out;
}
