// ============================================================================
// Workouts: Health Connect exercise sessions plus GPX/TCX/FIT files you add.
// ============================================================================
const WK_T = "exercise_session_record_table";

// Normalised workout: { key, id, start, end, type, title, hasRoute, app, day, file? }
async function workoutRows() {
  return memo("wk", async () => {
    let out = [];
    if (has(WK_T)) {
      const list = await sourcesFor(WK_T);
      sourceSelect("wk", list, "sessions", CATEGORY.ACTIVITY);
      const T = WK_T;
      const tcol = hasCol(T, "exercise_type") ? "exercise_type" : "NULL", title = hasCol(T, "title") ? "title" : "NULL", route = hasCol(T, "has_route") ? "has_route" : "0";
      const dayExpr = dayExprFor(T, "start_time", "start_zone_offset");
      let rows = await q(`SELECT row_id, start_time, end_time, ${tcol}, ${title}, ${route}, app_info_id, ${dayExpr} d FROM ${T}
        WHERE start_time BETWEEN ${S.from} AND ${S.to} ${srcClause("wk")} AND ${dayExpr} BETWEEN ${S.fromDay} AND ${S.toDay}`);
      if (srcMode("wk") === COMBINED && list.length > 1) rows = dedupeSessions(rows, rankFn(CATEGORY.ACTIVITY, list), 1, 2, 6);
      out = rows.map(r => ({ key: "hc" + r[0], id: r[0], start: r[1], end: r[2], type: r[3] ?? 0, title: r[4] || "", hasRoute: !!r[5], app: r[6], day: r[7] }));
    }
    for (const f of S.imported) {
      const day = localDayOf(f.start, null);
      if (day >= S.fromDay && day <= S.toDay) out.push({ key: f.key, id: null, start: f.start, end: f.end, type: f.type, title: f.title, hasRoute: f.points.length > 1, app: "File: " + f.fileName, day, file: f });
    }
    return out.sort((a, b) => b.start - a.start);
  });
}
const wkSel = async () => has(WK_T) ? sourceSelect("wk", await sourcesFor(WK_T), "sessions", CATEGORY.ACTIVITY) : null;

// distance per workout: Health Connect distance records inside the session window (same app), or the file's own
async function workoutDistances(wks) {
  const out = new Map();
  const hc = wks.filter(w => w.id != null);
  if (hc.length && has("distance_record_table") && hasCol("distance_record_table", "distance")) {
    const lo = Math.min(...hc.map(w => w.start)), hi = Math.max(...hc.map(w => w.end));
    const recs = await q(`SELECT start_time, end_time, distance, app_info_id FROM distance_record_table WHERE start_time >= ${lo} AND end_time <= ${hi} ORDER BY start_time`);
    const starts = recs.map(r => r[0]);
    for (const w of hc) {
      let i = lowerBound(starts, w.start), sum = 0, n = 0;
      for (; i < recs.length && recs[i][0] < w.end; i++) if (recs[i][1] <= w.end && recs[i][3] === w.app) { sum += recs[i][2]; n++; }
      if (n) out.set(w.key, sum);
    }
  }
  // otherwise the length of the recorded route (summed in SQLite; needs its math functions)
  const missing = hc.filter(w => w.hasRoute && !out.has(w.key));
  if (missing.length && has("exercise_route_table") && S.mathOk !== false) {
    try {
      for (let i = 0; i < missing.length; i += 400) {
        const ids = missing.slice(i, i + 400).map(w => w.id).join(",");
        for (const [pk, d] of await q(`SELECT parent_key, sum(seg) FROM (SELECT parent_key,
            6371000 * 2 * asin(sqrt(power(sin(radians(latitude - lag(latitude) OVER w) / 2), 2) +
              cos(radians(latitude)) * cos(radians(lag(latitude) OVER w)) * power(sin(radians(longitude - lag(longitude) OVER w) / 2), 2))) seg
            FROM exercise_route_table WHERE parent_key IN (${ids}) WINDOW w AS (PARTITION BY parent_key ORDER BY timestamp_millis)) GROUP BY parent_key`)) {
          const w = missing.find(x => x.id === pk); if (w && d > 0) out.set(w.key, d);
        }
      }
      S.mathOk = true;
    } catch { S.mathOk = false; }
  }
  for (const w of wks) if (w.file?.distance) out.set(w.key, w.file.distance);
  return out;
}
function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }

async function workoutSummaryCard() {
  const rows = await workoutRows();
  const sum = cardShell("Workouts", `${rows.length} sessions in range`, await wkSel()); sum.classList.add("wide");
  if (!rows.length) return emptyCard(sum, "No workouts in this range.");
  const byType = new Map();
  for (const r of rows) { const k = exerciseName(r.type); const o = byType.get(k) || { n: 0, ms: 0 }; o.n++; o.ms += r.end - r.start; byType.set(k, o); }
  const kv = h("div", { class: "kv" });
  for (const [k, o] of [...byType].sort((a, b) => b[1].ms - a[1].ms)) kv.append(h("div", {}, h("b", {}, o.n), `${k} · ${fmtDur(o.ms)}`));
  sum.append(kv);
  const wkMap = new Map(); const bw = { size: 7, name: "week" };
  for (const r of rows) { const k = bucketStart(r.day, bw); wkMap.set(k, (wkMap.get(k) || 0) + (r.end - r.start) / 60000); }
  const weeks = []; for (let d = bucketStart(S.fromDay, bw); d <= S.toDay; d += 7) weeks.push(d);
  const goal = goalFor("wkmin");
  const ch = h("div", { class: "chart" }); sum.append(ch);
  drawChart(ch, { type: "bar", days: weeks, bucket: bw, unit: "min", dp: 0, height: 160, series: [{ name: "Minutes per week", values: weeks.map(w => wkMap.get(w) || 0), color: "--s1" }],
    goal: goal != null ? { value: goal, label: `Goal ${goal} min / week` } : null });
  footer(sum, "workout_minutes_weekly.csv", ["week_starting", "minutes"], () => weeks.map(w => [isoDay(w), +(wkMap.get(w) || 0).toFixed(1)]), WK_T);
  return sum;
}

async function workoutListCards() {
  const rows = await workoutRows();
  const listCard = cardShell("Workout sessions", "select one for details", await wkSel()); listCard.classList.add("wide");
  if (!rows.length) return [emptyCard(listCard, "No workouts in this range.")];
  const dist = await workoutDistances(rows);
  const du = distUnit();
  const detail = h("div", { class: "card wide hidden", "aria-live": "polite" });
  const tb = h("tbody");
  for (const r of rows) {
    const d = dist.get(r.key);
    const open = () => { [...tb.children].forEach(x => x.classList.remove("sel")); tr.classList.add("sel"); workoutDetail(detail, r, d); };
    const tr = h("tr", { class: "click", tabindex: "0", onclick: open, onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } },
      h("td", {}, fmtDT(r.start)), h("td", {}, exerciseName(r.type)), h("td", {}, r.title), h("td", {}, fmtDur(r.end - r.start)),
      h("td", {}, d ? nf(d / du.div, 2) + " " + du.name : ""), h("td", {}, r.hasRoute ? "✓" : ""), h("td", {}, appName(r.app)));
    tb.append(tr);
  }
  listCard.append(h("div", { class: "scroll" }, h("table", { class: "data" }, h("thead", {}, h("tr", {}, ["Start", "Type", "Title", "Duration", "Distance", "Route", "Source"].map(x => h("th", { scope: "col" }, x)))), tb)));
  footer(listCard, "workouts.csv", ["start", "end", "type", "title", "duration_min", `distance_${du.name}`, "has_route", "source"],
    () => rows.map(r => [new Date(r.start).toISOString(), new Date(r.end).toISOString(), exerciseName(r.type), r.title, +((r.end - r.start) / 60000).toFixed(1),
      dist.get(r.key) ? +(dist.get(r.key) / du.div).toFixed(3) : "", r.hasRoute ? 1 : 0, appName(r.app)]), WK_T, { noPng: true });
  return [listCard, detail];
}

// ---------------------------------------------------------------- personal records
async function recordsCard() {
  const rows = await workoutRows();
  const card = cardShell("Personal records", "best in the selected range, per workout type", null); card.classList.add("wide");
  if (!rows.length) return emptyCard(card, "No workouts in this range.");
  const dist = await workoutDistances(rows), du = distUnit();
  const byType = new Map();
  for (const r of rows) { const k = exerciseName(r.type); if (!byType.has(k)) byType.set(k, []); byType.get(k).push(r); }
  const trs = [];
  for (const [type, ws] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
    const longest = ws.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    const withD = ws.filter(w => dist.get(w.key) > 500);
    const farthest = withD.length ? withD.reduce((a, b) => (dist.get(b.key) > dist.get(a.key) ? b : a)) : null;
    const fast = withD.filter(w => dist.get(w.key) >= 1000);
    const fastest = fast.length ? fast.reduce((a, b) => ((b.end - b.start) / dist.get(b.key) < (a.end - a.start) / dist.get(a.key) ? b : a)) : null;
    const speedy = /Biking|Skating|Skiing|Rowing|Paddling|Sailing/.test(type);   // speed reads better than pace for these
    const fmtFast = w => { const d = dist.get(w.key) / du.div, t = w.end - w.start;
      return speedy ? `${nf(d / (t / 3600000), 1)} ${du.name}/h` : `${pace(t / d)} /${du.name}`; };
    trs.push([type, ws.length, `${fmtDur(longest.end - longest.start)} · ${fmtDay(longest.day)}`,
      farthest ? `${nf(dist.get(farthest.key) / du.div, 2)} ${du.name} · ${fmtDay(farthest.day)}` : "–",
      fastest ? `${fmtFast(fastest)} · ${fmtDay(fastest.day)}` : "–"]);
  }
  card.append(h("div", { class: "scroll", style: "max-height:none" }, simpleTable(["Type", "Sessions", "Longest", "Farthest", "Fastest (average pace or speed)"], trs)));
  card.append(h("div", { class: "note", style: "margin-top:6px" }, "Pace and speed are averages over the whole session, for sessions of at least 1 " + du.name.replace("mi", "mile") + ". Distance comes from distance records, or the GPS route."));
  return card;
}

// ---------------------------------------------------------------- one workout
const ZONES = [[0.5, 0.6, "Zone 1 · very light"], [0.6, 0.7, "Zone 2 · light"], [0.7, 0.8, "Zone 3 · moderate"], [0.8, 0.9, "Zone 4 · hard"], [0.9, 2, "Zone 5 · maximum"]];
async function workoutDetail(card, r, distKnown) {
  card.innerHTML = ""; card.classList.remove("hidden");
  card.append(h("div", { class: "card-head" }, h("div", {}, h("h3", {}, `${exerciseName(r.type)}${r.title ? " · " + r.title : ""}`),
    h("div", { class: "sub" }, `${fmtDT(r.start)} – ${fmtTime(r.end)} · ${appName(r.app)}`))));
  let hr = [], pts = [];
  if (r.file) { hr = r.file.hr; pts = r.file.points; }
  else {
    if (has("heart_rate_record_series_table") && hasCol("heart_rate_record_series_table", "epoch_millis"))
      hr = await q(`SELECT epoch_millis, beats_per_minute FROM heart_rate_record_series_table WHERE epoch_millis BETWEEN ? AND ? AND beats_per_minute > 0 ORDER BY epoch_millis`, [r.start, r.end]);
    if (has("exercise_route_table")) pts = await q(`SELECT timestamp_millis, latitude, longitude, altitude FROM exercise_route_table WHERE parent_key = ? ORDER BY timestamp_millis`, [r.id]);
  }
  // cumulative distance along the route
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1][1], pts[i - 1][2], pts[i][1], pts[i][2]));
  const routeDist = cum[cum.length - 1] || 0;
  const dist = distKnown || routeDist || null;
  const du = distUnit();
  const kv = h("div", { class: "kv" });
  kv.append(h("div", {}, h("b", {}, fmtDur(r.end - r.start)), "duration"));
  const speedy = /Biking|Skating|Skiing|Rowing|Paddling|Sailing/.test(exerciseName(r.type));
  if (dist) kv.append(h("div", {}, h("b", {}, nf(dist / du.div, 2) + " " + du.name), "distance"),
    speedy ? h("div", {}, h("b", {}, nf(dist / du.div / ((r.end - r.start) / 3600000), 1) + ` ${du.name}/h`), "average speed")
           : h("div", {}, h("b", {}, pace((r.end - r.start) / (dist / du.div))), `average pace / ${du.name}`));
  if (hr.length) { const b = hr.map(x => x[1]); kv.append(h("div", {}, h("b", {}, nf(mean(b))), "average bpm"), h("div", {}, h("b", {}, Math.max(...b)), "max bpm")); }
  const alts = pts.map(p => p[3]).filter(a => a != null && isFinite(a));
  if (alts.length > 1) { let gain = 0; for (let i = 1; i < alts.length; i++) if (alts[i] > alts[i - 1]) gain += alts[i] - alts[i - 1]; kv.append(h("div", {}, h("b", {}, nf(gain) + " m"), "climb (from GPS)")); }
  card.append(kv);
  const wrap = h("div", { class: "grid" }); card.append(wrap);
  if (hr.length) {
    const c = h("div", { class: "card flat" }, h("div", { class: "note" }, "Heart rate (bpm) during the session"), h("div", { class: "chart" })); wrap.append(c);
    drawXY($(".chart", c), { type: "line", points: hr.map(x => [(x[0] - r.start) / 60000, x[1]]), xFmt: v => `${Math.round(v)} min`, yFmt: v => nf(v), xLabel: "minutes", yLabel: "bpm", color: "--s2", height: 200 });
    c.append(zonesBlock(hr, r));
  }
  if (pts.length > 1) {
    const c = h("div", { class: "card flat" }); wrap.append(c);
    if (S.maps.on && tileUrl()) c.append(h("div", { class: "note" }, `Route on ${MAP_PROVIDERS[S.maps.provider].name} (drag to pan, +/− or scroll to zoom)`), mapView(pts));
    else c.append(h("div", { class: "note" }, "Route shape (offline) · ", h("button", { class: "linkbtn", onclick: openMaps }, "show on a map…")), routeSvg(pts));
    c.append(h("div", { class: "card-foot" }, h("span", { class: "spacer" }), h("button", { onclick: () => download(`route_${new Date(r.start).toISOString().slice(0, 10)}.gpx`, gpx(pts, hr, exerciseName(r.type)), "application/gpx+xml") }, "Download GPX")));
    if (alts.length > 1 && routeDist > 200) {
      const e = h("div", { class: "card flat" }, h("div", { class: "note" }, "Elevation profile (m)"), h("div", { class: "chart" })); wrap.append(e);
      const step = Math.max(1, Math.floor(pts.length / 800));
      const prof = []; for (let i = 0; i < pts.length; i += step) if (pts[i][3] != null) prof.push([cum[i] / du.div, pts[i][3]]);
      drawXY($(".chart", e), { type: "line", fill: true, points: prof, xFmt: v => `${nf(v, 1)} ${du.name}`, yFmt: v => nf(v), xLabel: du.name, yLabel: "elevation (m)", color: "--s3", height: 180 });
    }
    if (routeDist >= du.div) wrap.append(splitsBlock(pts, cum, du));
  }
  if (!hr.length && pts.length < 2) card.append(h("div", { class: "note" }, "No heart-rate samples or route points recorded for this session."));
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function zonesBlock(hr, r) {
  // a set max wins; an estimate is raised to this workout's own peak if that is higher
  const peak = Math.max(...hr.map(x => x[1]));
  const mx = S.maxHr || Math.max(S.maxHrEstimate || 0, peak, 120); const ms = ZONES.map(() => 0); let below = 0;
  for (let i = 0; i < hr.length; i++) {
    const dt = Math.min(120000, (hr[i + 1]?.[0] ?? r.end) - hr[i][0]); if (dt <= 0) continue;
    const f = hr[i][1] / mx; const z = ZONES.findIndex(([a, b]) => f >= a && f < b);
    if (z < 0) below += dt; else ms[z] += dt;
  }
  const total = ms.reduce((a, b) => a + b, 0) + below || 1;
  const box = h("div", { class: "zones" }, h("div", { class: "note" }, `Heart-rate zones (max ${mx} bpm${S.maxHr ? "" : ", estimated"} · `, h("button", { class: "linkbtn", onclick: openSettings }, "change"), ")"));
  ZONES.forEach(([a, , name], i) => {
    const p = ms[i] / total;
    box.append(h("div", { class: "zrow" }, h("span", { class: "zl" }, name, h("small", {}, ` ${Math.round(a * mx)}+`)),
      h("span", { class: "zbar" }, h("i", { style: `width:${(p * 100).toFixed(1)}%;background:color-mix(in srgb, var(--s2) ${30 + i * 17}%, var(--surface-1))` })),
      h("span", { class: "zv" }, `${fmtDur(ms[i])} · ${Math.round(p * 100)}%`)));
  });
  return box;
}
function splitsBlock(pts, cum, du) {
  const rows = []; let lastT = pts[0][0], lastIdx = 0;
  for (let k = 1; k * du.div <= cum[cum.length - 1]; k++) {
    const target = k * du.div; let i = lastIdx; while (i < cum.length - 1 && cum[i + 1] < target) i++;
    const f = (target - cum[i]) / ((cum[i + 1] - cum[i]) || 1); const t = pts[i][0] + f * (pts[i + 1][0] - pts[i][0]);
    const a0 = pts[lastIdx][3], a1 = pts[i + 1][3];
    rows.push([k, pace(t - lastT), a0 != null && a1 != null ? `${a1 - a0 >= 0 ? "+" : ""}${nf(a1 - a0)} m` : ""]);
    lastT = t; lastIdx = i;
  }
  return h("div", { class: "card flat" }, h("div", { class: "note" }, `Splits per ${du.name}`),
    h("div", { class: "scroll", style: "max-height:260px" }, simpleTable([du.name, `Pace (min/${du.name})`, "Elevation change"], rows)));
}
function routeSvg(pts) {
  const W = 420, H = 300, pad = 16;
  const lat0 = pts[0][1] * Math.PI / 180;
  const xy = pts.map(p => [p[2] * Math.cos(lat0), -p[1]]);
  const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const k = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
  const ox = (W - (x1 - x0) * k) / 2, oy = (H - (y1 - y0) * k) / 2;
  const P = xy.map(([x, y]) => [ox + (x - x0) * k, oy + (y - y0) * k]);
  const step = Math.max(1, Math.floor(P.length / 2000));
  const d = "M" + P.filter((_, i) => i % step === 0 || i === P.length - 1).map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L");
  const s = P[0], e = P[P.length - 1];
  return h("div", { class: "chart", html: `<svg class="route" viewBox="0 0 ${W} ${H}" role="img" aria-label="Route shape"><rect width="${W}" height="${H}" rx="8"/><path d="${d}"/>
    <circle class="s" cx="${s[0]}" cy="${s[1]}" r="6"><title>Start</title></circle><circle class="e" cx="${e[0]}" cy="${e[1]}" r="6"><title>Finish</title></circle></svg>` });
}
function gpx(pts, hr, name) {
  const hrAt = t => { if (!hr.length) return null; const i = Math.min(hr.length - 1, lowerBound(hr.map(x => x[0]), t)); return Math.abs(hr[i][0] - t) < 30000 ? hr[i][1] : null; };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Health Connect Viewer" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><name>${esc(name)}</name><trkseg>\n` +
    pts.map(p => { const b = hrAt(p[0]); return `<trkpt lat="${p[1]}" lon="${p[2]}">${p[3] != null ? `<ele>${p[3]}</ele>` : ""}<time>${new Date(p[0]).toISOString()}</time>${b ? `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${b}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>` : ""}</trkpt>`; }).join("\n") +
    `\n</trkseg></trk></gpx>\n`;
}

// ---------------------------------------------------------------- online maps (opt-in)
function tileUrl() {
  const P = MAP_PROVIDERS[S.maps.provider]; if (!P) return null;
  const u = P.custom ? S.maps.custom : P.url;
  if (!u || !/^https:\/\/[^\s]+\{z\}.*\{x\}.*\{y\}/.test(u)) return null;
  if (P.key && !S.maps.key) return null;
  return u.replace("{key}", encodeURIComponent(S.maps.key || ""));
}
function mapView(pts) {
  const P = MAP_PROVIDERS[S.maps.provider], tmpl = tileUrl(), maxZ = P.max || 18;
  const el = h("div", { class: "map", role: "img", "aria-label": "Route on a map", tabindex: "0" });
  const H = 320;
  const world = (lat, lon, z) => { const n = 256 * 2 ** z, sn = Math.sin(lat * Math.PI / 180);
    return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * n]; };
  const lats = pts.map(p => p[1]), lons = pts.map(p => p[2]);
  const bb = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
  let z = 1, cx = 0, cy = 0, failed = 0, W = 400;
  function fit() {
    W = el.clientWidth || 400;
    for (z = maxZ; z > 1; z--) { const a = world(bb[2], bb[1], z), b = world(bb[0], bb[3], z); if (b[0] - a[0] <= W - 60 && b[1] - a[1] <= H - 60) break; }
    const a = world(bb[2], bb[1], z), b = world(bb[0], bb[3], z); cx = (a[0] + b[0]) / 2; cy = (a[1] + b[1]) / 2;
  }
  function draw() {
    W = el.clientWidth || W; el.innerHTML = ""; failed = 0;
    const n = 2 ** z, x0 = cx - W / 2, y0 = cy - H / 2;
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + W) / 256); tx++)
      for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + H) / 256); ty++) {
        if (ty < 0 || ty >= n) continue;
        const img = new Image(); img.alt = ""; img.referrerPolicy = "strict-origin-when-cross-origin"; img.decoding = "async";
        img.style.left = (tx * 256 - x0) + "px"; img.style.top = (ty * 256 - y0) + "px";
        img.onerror = () => { failed++; img.remove(); if (failed === 1) el.append(h("div", { class: "merr" }, "Some map images didn't load. The provider may be blocking requests from a local file, or you're offline. Try another provider in Maps settings.")); };
        img.src = tmpl.replace("{z}", z).replace("{x}", ((tx % n) + n) % n).replace("{y}", ty).replace("{s}", "a");
        el.append(img);
      }
    const step = Math.max(1, Math.floor(pts.length / 3000));
    const P2 = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(p => { const w = world(p[1], p[2], z); return [w[0] - x0, w[1] - y0]; });
    const d = "M" + P2.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L");
    const s0 = P2[0], e0 = P2[P2.length - 1];
    el.insertAdjacentHTML("beforeend", `<svg width="${W}" height="${H}"><path d="${d}" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/>
      <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${s0[0]}" cy="${s0[1]}" r="6" fill="var(--s3)" stroke="#fff" stroke-width="2"/><circle cx="${e0[0]}" cy="${e0[1]}" r="6" fill="var(--s2)" stroke="#fff" stroke-width="2"/></svg>`);
    el.append(h("div", { class: "attr" }, P.attr),
      h("div", { class: "zoom" }, h("button", { title: "Zoom in", "aria-label": "Zoom in", onclick: e => { e.stopPropagation(); zoomBy(1); } }, "+"), h("button", { title: "Zoom out", "aria-label": "Zoom out", onclick: e => { e.stopPropagation(); zoomBy(-1); } }, "−")));
  }
  function zoomBy(dz) { const nz = Math.max(1, Math.min(maxZ, z + dz)); if (nz === z) return; const f = 2 ** (nz - z); cx *= f; cy *= f; z = nz; draw(); }
  let drag = null;
  el.addEventListener("pointerdown", e => { if (e.target.closest("button")) return; drag = { x: e.clientX, y: e.clientY, cx, cy }; el.setPointerCapture(e.pointerId); el.classList.add("drag"); });
  el.addEventListener("pointermove", e => { if (!drag) return; cx = drag.cx - (e.clientX - drag.x); cy = drag.cy - (e.clientY - drag.y);
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; for (const c of el.children) if (c.tagName === "IMG" || c.tagName === "svg") c.style.transform = `translate(${dx}px,${dy}px)`; });
  el.addEventListener("pointerup", () => { if (!drag) return; drag = null; el.classList.remove("drag"); draw(); });
  el.addEventListener("wheel", e => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  el.addEventListener("keydown", e => {
    const d = { ArrowLeft: [-60, 0], ArrowRight: [60, 0], ArrowUp: [0, -60], ArrowDown: [0, 60] }[e.key];
    if (d) { e.preventDefault(); cx += d[0]; cy += d[1]; draw(); } else if (e.key === "+" || e.key === "=") zoomBy(1); else if (e.key === "-") zoomBy(-1);
  });
  requestAnimationFrame(() => { fit(); draw(); });
  return el;
}
