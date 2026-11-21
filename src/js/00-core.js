"use strict";
// ============================================================================
// Core: constants, shared state, DOM and formatting helpers.
// Files in src/js/ are concatenated in name order into one script by the build.
// ============================================================================

const DAY = 86400000;
const TZ_SEC = -new Date().getTimezoneOffset() * 60;   // fallback when a record has no zone offset
const VERSION = "__VERSION__";

// Health Connect platform (android.health.connect) ExerciseSessionType values.
const EXERCISE = ["Other / unknown","Badminton","Baseball","Basketball","Biking","Biking (stationary)","Boot camp","Boxing",
  "Calisthenics","Cricket","Dancing","Exercise class","Fencing","American football","Australian football","Frisbee","Golf",
  "Guided breathing","Gymnastics","Handball","HIIT","Hiking","Ice hockey","Ice skating","Martial arts","Paddling","Paragliding",
  "Pilates","Racquetball","Rock climbing","Roller hockey","Rowing","Rugby","Running","Running (treadmill)","Sailing",
  "Scuba diving","Skating","Skiing","Snowboarding","Snowshoeing","Soccer","Softball","Squash","Stair climbing",
  "Strength training","Stretching","Surfing","Swimming (open water)","Swimming (pool)","Table tennis","Tennis","Volleyball",
  "Walking","Water polo","Weightlifting","Wheelchair","Yoga","Other workout","Stair climbing machine","Elliptical","Rowing machine"];
const exerciseName = t => typeof t === "string" ? t : (EXERCISE[t] || `Type ${t}`);
// SleepSessionRecord.StageType: 0 unknown,1 awake,2 sleeping,3 out of bed,4 light,5 deep,6 REM,7 awake in bed
const SLEEP_GROUPS = [
  { key: "deep",  name: "Deep",  types: [5], color: "--s1" },
  { key: "light", name: "Light", types: [4], color: "--s2" },
  { key: "rem",   name: "REM",   types: [6], color: "--s3" },
  { key: "awake", name: "Awake", types: [1, 3, 7], color: "--s4" },
  { key: "other", name: "Asleep (no stage)", types: [0, 2], color: "--s5" },
];
// HealthDataCategory (android.health.connect) — used to read the user's app priority order.
const CATEGORY = { ACTIVITY: 1, BODY: 2, CYCLE: 3, NUTRITION: 4, SLEEP: 5, VITALS: 6, WELLNESS: 7 };

// Curated metrics. `cols` are the column names used by Android's Health Connect storage;
// if a column is missing the first numeric non-metadata column is used and flagged.
// Storage units (from AOSP): mass in grams, energy in calories (÷1000 = kcal), volume in litres,
// length/distance in metres.
const METRICS = [
  { sec: "activity", id: "steps", label: "Steps", table: "steps_record_table", kind: "sum", cols: ["count"], unit: "steps", dp: 0, cat: CATEGORY.ACTIVITY, goal: 10000 },
  { sec: "activity", id: "distance", label: "Distance", table: "distance_record_table", kind: "sum", cols: ["distance"], scale: 1/1000, unit: "km", dp: 2, cat: CATEGORY.ACTIVITY },
  { sec: "activity", id: "active", label: "Active calories", table: "active_calories_burned_record_table", kind: "sum", cols: ["energy"], scale: 1/1000, unit: "kcal", dp: 0, cat: CATEGORY.ACTIVITY },
  { sec: "activity", id: "total", label: "Total calories burned", table: "total_calories_burned_record_table", kind: "sum", cols: ["energy"], scale: 1/1000, unit: "kcal", dp: 0, cat: CATEGORY.ACTIVITY },
  { sec: "activity", id: "floors", label: "Floors climbed", table: "floors_climbed_record_table", kind: "sum", cols: ["floors"], unit: "floors", dp: 0, cat: CATEGORY.ACTIVITY },
  { sec: "activity", id: "elev", label: "Elevation gained", table: "elevation_gained_record_table", kind: "sum", cols: ["elevation"], unit: "m", dp: 0, cat: CATEGORY.ACTIVITY },
  { sec: "activity", id: "wheel", label: "Wheelchair pushes", table: "wheelchair_pushes_record_table", kind: "sum", cols: ["count"], unit: "pushes", dp: 0, cat: CATEGORY.ACTIVITY },
  { sec: "heart", id: "hr", label: "Heart rate", special: "hr", table: "heart_rate_record_series_table", unit: "bpm", dp: 0, cat: CATEGORY.VITALS },
  { sec: "heart", id: "rhr", label: "Resting heart rate", table: "resting_heart_rate_record_table", kind: "avg", cols: ["beats_per_minute"], unit: "bpm", dp: 0, cat: CATEGORY.VITALS },
  { sec: "heart", id: "hrv", label: "HRV (RMSSD)", table: "heart_rate_variability_rmssd_record_table", kind: "avg", cols: ["heart_rate_variability_millis"], unit: "ms", dp: 0, cat: CATEGORY.VITALS },
  { sec: "body", id: "weight", label: "Weight", table: "weight_record_table", kind: "avg", cols: ["weight"], scale: 1/1000, unit: "kg", dp: 1, cat: CATEGORY.BODY },
  { sec: "body", id: "fat", label: "Body fat", table: "body_fat_record_table", kind: "avg", cols: ["percentage"], unit: "%", dp: 1, cat: CATEGORY.BODY },
  { sec: "body", id: "lean", label: "Lean body mass", table: "lean_body_mass_record_table", kind: "avg", cols: ["mass"], scale: 1/1000, unit: "kg", dp: 1, cat: CATEGORY.BODY },
  { sec: "body", id: "bone", label: "Bone mass", table: "bone_mass_record_table", kind: "avg", cols: ["mass"], scale: 1/1000, unit: "kg", dp: 2, cat: CATEGORY.BODY },
  { sec: "body", id: "water", label: "Body water mass", table: "body_water_mass_record_table", kind: "avg", cols: ["body_water_mass", "mass"], scale: 1/1000, unit: "kg", dp: 1, cat: CATEGORY.BODY },
  { sec: "body", id: "height", label: "Height", table: "height_record_table", kind: "avg", cols: ["height"], scale: 100, unit: "cm", dp: 1, cat: CATEGORY.BODY },
  { sec: "vitals", id: "bp", label: "Blood pressure", special: "bp", table: "blood_pressure_record_table", unit: "mmHg", dp: 0, cat: CATEGORY.VITALS },
  { sec: "vitals", id: "spo2", label: "Blood oxygen (SpO₂)", table: "oxygen_saturation_record_table", kind: "avg", cols: ["percentage"], unit: "%", dp: 1, cat: CATEGORY.VITALS },
  { sec: "vitals", id: "resp", label: "Respiratory rate", table: "respiratory_rate_record_table", kind: "avg", cols: ["rate"], unit: "/min", dp: 1, cat: CATEGORY.VITALS },
  { sec: "vitals", id: "temp", label: "Body temperature", table: "body_temperature_record_table", kind: "avg", cols: ["temperature"], unit: "°C", dp: 1, cat: CATEGORY.VITALS },
  { sec: "vitals", id: "bbt", label: "Basal body temperature", table: "basal_body_temperature_record_table", kind: "avg", cols: ["temperature"], unit: "°C", dp: 2, cat: CATEGORY.VITALS },
  { sec: "vitals", id: "glucose", label: "Blood glucose", table: "blood_glucose_record_table", kind: "avg", cols: ["level"], unit: "mmol/L", dp: 1, cat: CATEGORY.VITALS },
  { sec: "vitals", id: "vo2", label: "VO₂ max", table: "vo2_max_record_table", kind: "avg", cols: ["vo2_milliliters_per_minute_kilogram"], unit: "ml/kg/min", dp: 1, cat: CATEGORY.ACTIVITY },
  { sec: "nutrition", id: "hydration", label: "Hydration", table: "hydration_record_table", kind: "sum", cols: ["volume"], unit: "L", dp: 2, cat: CATEGORY.NUTRITION, goal: 2 },
  { sec: "nutrition", id: "kcalin", label: "Calories eaten", table: "nutrition_record_table", kind: "sum", cols: ["energy"], scale: 1/1000, unit: "kcal", dp: 0, cat: CATEGORY.NUTRITION },
  { sec: "nutrition", id: "protein", label: "Protein", table: "nutrition_record_table", kind: "sum", cols: ["protein"], unit: "g", dp: 0, noGuess: true, cat: CATEGORY.NUTRITION },
  { sec: "nutrition", id: "carbs", label: "Carbohydrates", table: "nutrition_record_table", kind: "sum", cols: ["total_carbohydrate"], unit: "g", dp: 0, noGuess: true, cat: CATEGORY.NUTRITION },
  { sec: "nutrition", id: "fatin", label: "Fat", table: "nutrition_record_table", kind: "sum", cols: ["total_fat"], unit: "g", dp: 0, noGuess: true, cat: CATEGORY.NUTRITION },
  { sec: "nutrition", id: "mind", label: "Mindfulness", table: "mindfulness_session_record_table", kind: "duration", unit: "min", dp: 0, cat: CATEGORY.WELLNESS, goal: 10 },
];
const SECTIONS = [
  { id: "mypage", name: "★ My page" },
  { id: "activity", name: "Activity" }, { id: "heart", name: "Heart" }, { id: "sleep", name: "Sleep" },
  { id: "body", name: "Body" }, { id: "vitals", name: "Vitals" }, { id: "nutrition", name: "Nutrition & mind" },
  { id: "workouts", name: "Workouts" }, { id: "cycle", name: "Cycle" }, { id: "patterns", name: "Patterns" },
  { id: "tables", name: "All tables & SQL" },
];
const RANGES = [ ["30d", 30], ["90d", 90], ["1y", 365], ["All", 0] ];
const META_COLS = new Set(["row_id","uuid","client_record_id","app_info_id","last_modified_time","client_record_version",
  "device_info_id","recording_method","dedupe_hash","time","zone_offset","local_date","local_date_time","start_time","end_time",
  "start_zone_offset","end_zone_offset","local_date_time_start_time","local_date_time_end_time","parent_key"]);
const IMPERIAL = { kg: ["lb", x => x * 2.20462, 1], km: ["mi", x => x * 0.621371, 2], cm: ["in", x => x / 2.54, 1],
  "°C": ["°F", x => x * 9 / 5 + 32, 1], L: ["fl oz", x => x * 33.814, 0] };
const MAP_PROVIDERS = {
  otm: { name: "OpenTopoMap", url: "https://tile.opentopomap.org/{z}/{x}/{y}.png", max: 17,
    attr: "Map data © OpenStreetMap contributors, SRTM · Style © OpenTopoMap (CC-BY-SA)",
    note: "Free and needs no key. Topographic style." },
  carto: { name: "CARTO Voyager (free API key)", url: "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key={key}", max: 19, key: true,
    attr: "© OpenStreetMap contributors © CARTO",
    note: "Clean street map. Needs a free key from carto.com/basemaps/apikey." },
  osm: { name: "OpenStreetMap", url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", max: 19,
    attr: "© OpenStreetMap contributors",
    note: "OpenStreetMap's servers refuse pages opened straight from a file. It works in the online copy, or through any web server." },
  custom: { name: "Custom tile URL", url: "", max: 19, custom: true, attr: "Map tiles: your chosen provider",
    note: "Any https tile URL with {z}, {x} and {y}. Follow that provider's usage terms." },
};

// ---------------------------------------------------------------- state
const S = {
  open: false, fileName: "", dbMode: "", tables: new Map(), apps: new Map(), priority: new Map(),
  range: 90, fromDay: 0, toDay: 0, from: 0, to: 0, tab: "activity",
  sources: {}, imperial: false, dataMin: 0, dataMax: 0, gen: 0, memo: {}, editing: false,
  trend: 0, compare: "off", custom: null,
  maps: { on: false, provider: "otm", key: "", custom: "" },
  goals: {}, maxHr: null,
  imported: [],          // workouts from GPX/TCX/FIT files
  cycleJournal: null,    // OpenVitals cycle-journal backup
};
const store = {
  get(k, d) { try { const v = localStorage.getItem("hcv-" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("hcv-" + k, JSON.stringify(v)); } catch {} },
};
// per-redraw memo; values may be promises
function memo(k, f) { if (S.memo._gen !== S.gen) S.memo = { _gen: S.gen }; if (!(k in S.memo)) S.memo[k] = f(); return S.memo[k]; }

// ---------------------------------------------------------------- DOM
const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "html") e.innerHTML = v; else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const tick = () => new Promise(r => setTimeout(r, 0));
function download(name, data, type = "text/csv") {
  const blob = data instanceof Blob ? data : new Blob(Array.isArray(data) ? data : [data], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const csvCell = v => { if (v == null) return ""; if (v instanceof Uint8Array) v = hex(v); const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const hex = u => Array.from(u.slice(0, 32), b => b.toString(16).padStart(2, "0")).join("");
const csvText = (header, rows) => [header.join(",") + "\n", ...rows.map(r => r.map(csvCell).join(",") + "\n")];

// ---------------------------------------------------------------- formatting
// Formatters are created once and reused: building one per value is slow with thousands of values.
const FMT = new Map();
const fmt = (key, make) => FMT.get(key) || (FMT.set(key, make()), FMT.get(key));
const numFmt = (min, max) => fmt(`n${min}.${max}`, () => new Intl.NumberFormat(undefined, { minimumFractionDigits: min, maximumFractionDigits: max }));
const dateFmt = opts => fmt("d" + JSON.stringify(opts), () => new Intl.DateTimeFormat(undefined, opts));
const nf = (v, dp = 0) => v == null || !isFinite(v) ? "–" : numFmt(dp, dp).format(v);
const pct = v => v == null || !isFinite(v) ? "–" : (v >= 0 ? "+" : "−") + numFmt(0, 0).format(Math.abs(v * 100)) + "%";
const dayToDate = d => new Date(d * DAY);                       // local-day number → Date read with UTC getters
const dateToDay = dt => Math.floor(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) / DAY);
const isoDay = d => dayToDate(d).toISOString().slice(0, 10);
const parseIsoDay = s => /^\d{4}-\d{2}-\d{2}/.test(s || "") ? Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY) : null;
const localDayOf = (ms, offSec) => Math.floor((ms + (offSec == null ? TZ_SEC : offSec) * 1000) / DAY);
const fmtDay = d => dateFmt({ timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }).format(dayToDate(d));
const fmtDT = ms => dateFmt({ year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
const fmtTime = ms => dateFmt({ hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
const fmtDur = ms => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const fmtClock = x => { x = ((x % 24) + 24) % 24; let hh = Math.floor(x), mm = Math.round((x - hh) * 60); if (mm === 60) { hh = (hh + 1) % 24; mm = 0; } return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`; };
const pace = msPerKm => { if (!isFinite(msPerKm) || msPerKm <= 0) return "–"; const s = Math.round(msPerKm / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const weekdayOf = d => (dayToDate(d).getUTCDay() + 6) % 7;    // 0 = Monday
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = x => x * Math.PI / 180; const dLa = r(lat2 - lat1), dLo = r(lon2 - lon1);
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x));
}
// unit conversion for a metric under the current unit system
function unitFor(m) {
  if (S.imperial && IMPERIAL[m.unit]) { const [u, f, d] = IMPERIAL[m.unit]; return { unit: u, conv: f, dp: m.unit === "°C" ? m.dp : d }; }
  return { unit: m.unit, conv: x => x, dp: m.dp };
}
const distUnit = () => S.imperial ? { div: 1609.344, name: "mi" } : { div: 1000, name: "km" };
