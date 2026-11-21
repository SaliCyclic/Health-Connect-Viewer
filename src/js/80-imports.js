// ============================================================================
// Extra files read in the browser: workout files (GPX, TCX, FIT) and the
// OpenVitals cycle-journal backup. Nothing is uploaded or stored.
// ============================================================================

async function importFiles(files) {
  const done = [], failed = [];
  for (const f of files) {
    try {
      const name = f.name.toLowerCase();
      if (name.endsWith(".gpx")) done.push(addWorkout(parseGpx(await f.text()), f.name));
      else if (name.endsWith(".tcx")) done.push(addWorkout(parseTcx(await f.text()), f.name));
      else if (name.endsWith(".fit")) done.push(addWorkout(parseFit(new Uint8Array(await f.arrayBuffer())), f.name));
      else if (name.endsWith(".json")) { S.cycleJournal = parseCycleJournal(await f.text()); done.push(`${f.name} (cycle journal, ${S.cycleJournal.entries.length} days)`); }
      else failed.push(`${f.name}: not a GPX, TCX, FIT or cycle-journal file`);
    } catch (e) { failed.push(`${f.name}: ${e.message}`); }
  }
  S.memo = {};
  return { done, failed };
}
function addWorkout(w, fileName) {
  if (!w.points.length && !w.hr.length) throw new Error("no track points or heart rate found");
  const times = [...w.points.map(p => p[0]), ...w.hr.map(x => x[0])].filter(Boolean);
  w.start = w.start || Math.min(...times); w.end = w.end || Math.max(...times);
  if (!w.distance && w.points.length > 1) { let d = 0; for (let i = 1; i < w.points.length; i++) d += haversine(w.points[i - 1][1], w.points[i - 1][2], w.points[i][1], w.points[i][2]); w.distance = d; }
  w.key = "file" + Math.random().toString(36).slice(2, 9); w.fileName = fileName; w.title = w.title || fileName.replace(/\.\w+$/, "");
  S.imported = S.imported.filter(x => !(x.fileName === fileName && x.start === w.start)).concat(w);
  return `${fileName} (${exerciseName(w.type)}, ${fmtDT(w.start)})`;
}

// ---------------------------------------------------------------- GPX
function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("not valid XML");
  const all = (el, name) => [...el.getElementsByTagNameNS("*", name)];
  const kid = (el, name) => all(el, name)[0]?.textContent;
  const pts = [], hr = [];
  for (const p of [...all(doc, "trkpt"), ...all(doc, "rtept")]) {
    const t = Date.parse(kid(p, "time") || ""), lat = +p.getAttribute("lat"), lon = +p.getAttribute("lon");
    const ele = kid(p, "ele"); const b = kid(p, "hr");
    if (isFinite(lat) && isFinite(lon)) pts.push([t || 0, lat, lon, ele != null ? +ele : null]);
    if (b && t) hr.push([t, +b]);
  }
  const type = (kid(doc, "type") || "").toLowerCase();
  return { points: pts, hr, title: kid(all(doc, "trk")[0] || doc, "name") || "", type: sportName(type) };
}
// ---------------------------------------------------------------- TCX
function parseTcx(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("not valid XML");
  const all = (el, name) => [...el.getElementsByTagNameNS("*", name)];
  const kid = (el, name) => all(el, name)[0]?.textContent;
  const pts = [], hr = []; let dist = 0;
  for (const tp of all(doc, "Trackpoint")) {
    const t = Date.parse(kid(tp, "Time") || "");
    const lat = kid(tp, "LatitudeDegrees"), lon = kid(tp, "LongitudeDegrees"), alt = kid(tp, "AltitudeMeters");
    const b = all(tp, "HeartRateBpm")[0]; const d = kid(tp, "DistanceMeters");
    if (lat != null && lon != null) pts.push([t, +lat, +lon, alt != null ? +alt : null]);
    if (b && t) hr.push([t, +kid(b, "Value")]);
    if (d != null) dist = Math.max(dist, +d);
  }
  const act = all(doc, "Activity")[0];
  return { points: pts, hr, distance: dist || null, type: sportName((act?.getAttribute("Sport") || "").toLowerCase()), title: "" };
}
const sportName = s =>
  /run/.test(s) ? "Running" : /bik|cycl|ride/.test(s) ? "Biking" : /walk/.test(s) ? "Walking" : /hik/.test(s) ? "Hiking" :
  /swim/.test(s) ? "Swimming (open water)" : /row/.test(s) ? "Rowing" : /ski/.test(s) ? "Skiing" : "Other workout";

// ---------------------------------------------------------------- FIT (Garmin and most watches)
// Minimal decoder: reads 'record' (GPS, altitude, heart rate, distance) and 'session' (sport, start, distance) messages.
function parseFit(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hlen = u8[0];
  if (u8.length < 12 || String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) !== ".FIT") throw new Error("not a FIT file");
  const end = Math.min(u8.length, hlen + dv.getUint32(4, true));
  const FIT_EPOCH = 631065600;    // seconds between 1970-01-01 and 1989-12-31
  const SIZES = { 0: 1, 1: 1, 2: 1, 0x83: 2, 0x84: 2, 0x85: 4, 0x86: 4, 0x07: 1, 0x88: 4, 0x89: 8, 0x0a: 1, 0x8b: 2, 0x8c: 4, 0x0d: 1, 0x8e: 8, 0x8f: 8, 0x90: 8 };
  const defs = {}; let pos = hlen, lastTs = 0;
  const pts = [], hr = []; let session = null, maxDist = 0;
  const read = (at, base, size, le) => {
    switch (base) {
      case 0x00: case 0x02: case 0x0a: case 0x0d: { const v = dv.getUint8(at); return v === 0xff || (base === 0x0a && v === 0) ? null : v; }
      case 0x01: { const v = dv.getInt8(at); return v === 0x7f ? null : v; }
      case 0x83: { const v = dv.getInt16(at, le); return v === 0x7fff ? null : v; }
      case 0x84: case 0x8b: { const v = dv.getUint16(at, le); return v === 0xffff || (base === 0x8b && v === 0) ? null : v; }
      case 0x85: { const v = dv.getInt32(at, le); return v === 0x7fffffff ? null : v; }
      case 0x86: case 0x8c: { const v = dv.getUint32(at, le); return v === 0xffffffff || (base === 0x8c && v === 0) ? null : v; }
      case 0x88: return dv.getFloat32(at, le);
      case 0x89: return dv.getFloat64(at, le);
      default: return null;
    }
  };
  while (pos < end) {
    const hdr = u8[pos++];
    if (hdr & 0x80) {                                   // compressed timestamp header
      const local = (hdr >> 5) & 3, off = hdr & 0x1f;
      let ts = (lastTs & ~0x1f) + off; if (off < (lastTs & 0x1f)) ts += 0x20; lastTs = ts;
      pos = dataMsg(defs[local], pos, ts);
      continue;
    }
    const local = hdr & 0x0f;
    if (hdr & 0x40) {                                   // definition message
      const le = u8[pos + 1] === 0; const global = le ? dv.getUint16(pos + 2, true) : dv.getUint16(pos + 2, false);
      const n = u8[pos + 4]; pos += 5;
      const fields = []; for (let i = 0; i < n; i++) { fields.push({ num: u8[pos], size: u8[pos + 1], base: u8[pos + 2] }); pos += 3; }
      let devSize = 0;
      if (hdr & 0x20) { const nd = u8[pos++]; for (let i = 0; i < nd; i++) { devSize += u8[pos + 1]; pos += 3; } }
      defs[local] = { le, global, fields, devSize };
    } else pos = dataMsg(defs[local], pos, null);
  }
  function dataMsg(def, at, tsOverride) {
    if (!def) throw new Error("damaged FIT file");
    const v = {};
    for (const f of def.fields) {
      if (SIZES[f.base] && f.size === SIZES[f.base]) v[f.num] = read(at, f.base, f.size, def.le);
      else if (SIZES[f.base] && f.size > SIZES[f.base] && f.base !== 0x07) v[f.num] = read(at, f.base, SIZES[f.base], def.le);
      at += f.size;
    }
    at += def.devSize;
    if (v[253] != null) lastTs = v[253];
    const ts = tsOverride ?? v[253];
    const ms = ts != null ? (ts + FIT_EPOCH) * 1000 : null;
    if (def.global === 20 && ms) {                      // record
      const semi = 180 / 2 ** 31;
      const alt = v[78] != null ? v[78] / 5 - 500 : v[2] != null ? v[2] / 5 - 500 : null;
      if (v[0] != null && v[1] != null) pts.push([ms, v[0] * semi, v[1] * semi, alt]);
      if (v[3] != null) hr.push([ms, v[3]]);
      if (v[5] != null) maxDist = Math.max(maxDist, v[5] / 100);
    } else if (def.global === 18) {                     // session
      session = { start: v[2] != null ? (v[2] + FIT_EPOCH) * 1000 : null, elapsed: v[7] != null ? v[7] / 1000 : null, distance: v[9] != null ? v[9] / 100 : null, sport: v[5] };
    }
    return at;
  }
  const SPORT = { 0: "Other workout", 1: "Running", 2: "Biking", 4: "Other workout", 5: "Swimming (pool)", 10: "Strength training", 11: "Walking", 13: "Skiing", 15: "Rowing", 17: "Hiking", 19: "Paddling" };
  const start = session?.start || null;
  return { points: pts, hr, distance: session?.distance || maxDist || null, type: SPORT[session?.sport] || "Other workout",
    start, end: start && session?.elapsed ? start + session.elapsed * 1000 : null, title: "" };
}

// ---------------------------------------------------------------- OpenVitals cycle journal (format 1)
const CYCLE_SYMPTOMS = { cramps: "Cramps", headache: "Headache", abdominal_pain: "Abdominal pain", backache: "Backache", muscle_aches: "Muscle aches",
  pelvic_pain_outside_period: "Pelvic pain outside period", bloating: "Bloating", nausea: "Nausea", digestive_changes: "Digestive changes",
  breast_tenderness: "Breast tenderness", acne: "Acne", fatigue: "Fatigue", sleep_issue: "Sleep issue", mood_changes: "Mood changes", anxiety: "Anxiety" };
function parseCycleJournal(text) {
  let root; try { root = JSON.parse(text); } catch { throw new Error("not valid JSON"); }
  if (typeof root?.format !== "number" || !Array.isArray(root.entries)) throw new Error("not an OpenVitals cycle-journal backup");
  if (root.format > 1) throw new Error(`made by a newer OpenVitals (format ${root.format})`);
  const lvl = v => Number.isInteger(v) && v >= 1 && v <= 5 ? v : null;
  const entries = root.entries.map(e => ({ day: parseIsoDay(e.date), pain: lvl(e.pain), mood: lvl(e.mood), energy: lvl(e.energy), desire: lvl(e.desire),
    symptoms: Array.isArray(e.symptoms) ? e.symptoms.filter(s => typeof s === "string") : [], notes: typeof e.notes === "string" ? e.notes : "", bleedingNone: !!e.bleedingNone }))
    .filter(e => e.day != null).sort((a, b) => a.day - b.day);
  return { entries, exclusions: (root.exclusions || []).map(x => parseIsoDay(x.start)).filter(d => d != null) };
}
