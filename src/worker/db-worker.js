// Database worker. Runs SQLite (WebAssembly) off the page's main thread so the page
// never freezes while a large export opens or a big query runs.
//
// This file is appended after the SQLite and fflate libraries in a single module
// worker (see scripts/build.mjs). It talks to the page with simple {id, op, ...}
// messages and answers {id, ok, result | error}.
//
// Two ways to hold the database:
//  - memory: the whole file is copied into WebAssembly memory (fast, needs RAM)
//  - disk:   the file is streamed into the browser's private Origin Private File
//            System (OPFS) and SQLite reads pages from there on demand, so even a
//            multi-GB export needs little RAM. The copy is wiped when another file
//            is opened, when the page closes it, and whenever the viewer starts.

/* global sqlite3InitModule, fflate */
let sqlite3 = null, db = null, pool = null, mode = null;
// each tab gets its own folder, so two open tabs never wait on each other's locks
const TAB_ID = Math.random().toString(36).slice(2, 10);
const POOL_NAME = "hcv-" + TAB_ID;
const POOL_ROOT = ".hcv-temp";
const DB_NAME = "/export.db";
const send = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (id, phase, done, total) => send({ id, progress: { phase, done, total } });

async function init(wasm) {
  sqlite3 = await sqlite3InitModule({ wasmBinary: wasm, print: () => {}, printErr: () => {} });
  return { version: sqlite3.version.libVersion, opfs: await opfsAvailable() };
}

async function opfsAvailable() {
  try {
    if (!self.navigator?.storage?.getDirectory || !self.FileSystemFileHandle?.prototype?.createSyncAccessHandle) return false;
    await navigator.storage.getDirectory();
    return true;
  } catch { return false; }
}
async function getPool() {
  if (pool) return pool;
  await removeLeftovers();
  const install = sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME, directory: `/${POOL_ROOT}/${TAB_ID}`, clearOnInit: true, initialCapacity: 2 });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("storage busy")), 10000));
  pool = await Promise.race([install, timeout]);
  return pool;
}
// Copies left by tabs that were closed (or crashed) are deleted; folders still in use are locked and skipped.
async function removeLeftovers() {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(POOL_ROOT, { create: true });
    for await (const [name] of dir.entries()) {
      if (name === TAB_ID) continue;
      try { await dir.removeEntry(name, { recursive: true }); } catch {}
    }
  } catch {}
}
async function wipe() {
  try { db?.close(); } catch {}
  db = null;
  if (pool) { try { await pool.wipeFiles(); } catch {} }
}

// ---- reading the input as a stream of chunks -------------------------------------
const isSqliteHeader = b => {
  const sig = "SQLite format 3";
  if (!b || b.length < 16) return false;
  for (let i = 0; i < sig.length; i++) if (b[i] !== sig.charCodeAt(i)) return false;
  return true;
};
const isZip = b => b && b[0] === 0x50 && b[1] === 0x4b;

// Async queue so a push-based decompressor can feed a pull-based consumer.
function chunkQueue() {
  const items = []; let wake = null, ended = false, failed = null;
  return {
    push(c) { items.push(c); wake?.(); wake = null; },
    end() { ended = true; wake?.(); wake = null; },
    fail(e) { failed = e; wake?.(); wake = null; },
    async next() {
      for (;;) {
        if (failed) throw failed;
        if (items.length) return items.shift();
        if (ended) return undefined;
        await new Promise(r => (wake = r));
      }
    },
  };
}

// Returns an async function giving successive Uint8Array chunks of the SQLite file
// (unzipping on the fly if needed), or undefined at the end.
async function dbChunks(file, id) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const reader = file.stream().getReader();
  let read = 0;
  const pump = async () => {
    const r = await reader.read();
    if (r.done) return null;
    read += r.value.length;
    progress(id, "read", read, file.size);
    return r.value;
  };
  if (isSqliteHeader(head)) return async () => (await pump()) ?? undefined;
  if (!isZip(head)) throw new Error("This file isn't a Health Connect export (.zip) or a SQLite database (.db).");

  const out = chunkQueue();
  let chosen = null, names = [];
  const unzip = new fflate.Unzip(f => {
    names.push(f.name);
    if (chosen || f.name.endsWith("/")) return;
    if (!/\.(db|sqlite|sqlite3)$/i.test(f.name) && names.length > 1) return;
    chosen = f;
    f.ondata = (err, data, final) => {
      if (err) return out.fail(err);
      if (data?.length) out.push(data);
      if (final) out.end();
    };
    f.start();
  });
  unzip.register(fflate.UnzipInflate);
  // feed the zip in the background; the consumer pulls decompressed chunks
  (async () => {
    try {
      for (;;) {
        const c = await pump();
        if (!c) { unzip.push(new Uint8Array(0), true); break; }
        unzip.push(c);
        await new Promise(r => setTimeout(r, 0));   // let the consumer drain
      }
      if (!chosen) out.fail(new Error("The zip doesn't contain a database. Files inside: " + (names.join(", ") || "none")));
    } catch (e) { out.fail(e); }
  })();
  let first = true;
  return async () => {
    const c = await out.next();
    if (c && first) { first = false; if (!isSqliteHeader(c)) throw new Error("The file inside the zip isn't a SQLite database."); }
    return c;
  };
}

async function open(id, file, want) {
  await wipe();
  const canDisk = await opfsAvailable();
  // "auto": use disk for anything over ~150 MB (zipped exports roughly double when unzipped)
  const big = file.size > 150 * 1024 * 1024 || (isZip(new Uint8Array(await file.slice(0, 2).arrayBuffer())) && file.size > 75 * 1024 * 1024);
  mode = want === "memory" ? "memory" : want === "disk" ? (canDisk ? "disk" : "memory") : (big && canDisk ? "disk" : "memory");
  const next = await dbChunks(file, id);
  let p = null;
  if (mode === "disk") { try { p = await getPool(); } catch { mode = "memory"; } }
  if (mode === "disk") {
    let n = 0;
    await p.importDb(DB_NAME, async () => { const c = await next(); if (c) { n += c.length; progress(id, "copy", n, 0); } return c; });
    db = new p.OpfsSAHPoolDb(DB_NAME);
  } else {
    const parts = []; let n = 0;
    for (let c; (c = await next()); ) { parts.push(c); n += c.length; progress(id, "copy", n, 0); }
    const bytes = new Uint8Array(n); let o = 0;
    for (const c of parts) { bytes.set(c, o); o += c.length; }
    parts.length = 0;
    db = new sqlite3.oo1.DB(":memory:");
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    const rc = sqlite3.capi.sqlite3_deserialize(db.pointer, "main", p, n, n,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    if (rc) throw new Error("SQLite couldn't open the database (code " + rc + ").");
  }
  db.exec("PRAGMA query_only = 1");   // the export is never changed
  progress(id, "done", 1, 1);
  return { mode, size: file.size };
}

function query(sql, bind, limit) {
  if (!db) throw new Error("No file open");
  const stmt = db.prepare(sql);
  try {
    if (bind) stmt.bind(bind);
    const cols = stmt.getColumnNames(), rows = [];
    while (stmt.step()) { rows.push(stmt.get([])); if (limit && rows.length >= limit) break; }
    return { cols, rows };
  } finally { stmt.finalize(); }
}

// Build a CSV in the worker so huge tables never cross to the page as objects.
function csv(sql, bind, humanTimes) {
  const isTimeCol = c => /(^|_)(time|epoch_millis|timestamp_millis|stage_start_time|stage_end_time|last_modified_time)$/.test(c);
  const cell = v => {
    if (v == null) return "";
    if (v instanceof Uint8Array) v = Array.from(v.slice(0, 32), b => b.toString(16).padStart(2, "0")).join("");
    const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const parts = []; let buf = "", cols = null, timeIdx = [];
  const stmt = db.prepare(sql);
  try {
    if (bind) stmt.bind(bind);
    cols = stmt.getColumnNames();
    timeIdx = cols.map(isTimeCol);
    parts.push(cols.join(",") + "\n");
    while (stmt.step()) {
      const r = stmt.get([]);
      buf += r.map((v, i) => cell(humanTimes && timeIdx[i] && typeof v === "number" && v > 1e11 ? new Date(v).toISOString() : v)).join(",") + "\n";
      if (buf.length > 1 << 20) { parts.push(buf); buf = ""; }
    }
  } finally { stmt.finalize(); }
  parts.push(buf);
  return new Blob(parts, { type: "text/csv" });
}

self.onmessage = async e => {
  const { id, op } = e.data;
  try {
    let result;
    if (op === "init") result = await init(e.data.wasm);
    else if (op === "open") result = await open(id, e.data.file, e.data.mode);
    else if (op === "query") result = query(e.data.sql, e.data.bind, e.data.limit);
    else if (op === "csv") result = csv(e.data.sql, e.data.bind, e.data.humanTimes);
    else if (op === "close") { await wipe(); result = true; }
    else if (op === "cleanup") { if (await opfsAvailable()) await removeLeftovers(); result = true; }
    else throw new Error("unknown op " + op);
    send({ id, ok: true, result });
  } catch (err) {
    send({ id, ok: false, error: String(err?.message || err) });
  }
};
