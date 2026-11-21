// Builds dist/health-connect-viewer.html: one self-contained file.
//
//   src/index.html     page shell (placeholders below are filled in)
//   src/css/*.css      styles                      -> /*__CSS__*/
//   src/js/*.js        app code, in name order     -> /*__APP__*/
//   src/worker/*.js    database worker; bundled with fflate and the official
//                      SQLite WebAssembly build      -> /*__WORKER__*/
//   sqlite3.wasm       base64                       -> __WASM_B64__
//
// Also writes dist/sw.js and dist/manifest.webmanifest (+ icons) for the
// installable offline app in the online copy.
//
//   npm ci && npm run build
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = p => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json"));
const list = (dir, ext) => readdirSync(join(root, dir)).filter(f => f.endsWith(ext)).sort().map(f => read(join(dir, f)));

const sqliteDir = "node_modules/@sqlite.org/sqlite-wasm/dist";
// The SQLite bundle is an ES module. Workers started from a page opened as a local file
// must be classic scripts, so the two module-only constructs are rewritten:
//  - import.meta.url is only used to locate sqlite3.wasm, which we pass in directly
//  - the trailing export statement is dropped (the bundle also sets globalThis.sqlite3InitModule)
let sqlite = read(join(sqliteDir, "index.mjs"));
const metaCount = (sqlite.match(/import\.meta\.url/g) || []).length;
sqlite = sqlite.replace(/import\.meta\.url/g, '"https://hcv.invalid/sqlite3.mjs"');
sqlite = sqlite.replace(/^export \{[^}]*\};?\s*$/m, "");
if (/^(import|export)\s/m.test(sqlite) || /import\.meta/.test(sqlite)) throw new Error("SQLite bundle still has module syntax; the build needs updating");
if (metaCount === 0) throw new Error("SQLite bundle layout changed (no import.meta.url found)");

const fflate = read("node_modules/fflate/umd/index.js");
const worker = [fflate, sqlite, ...list("src/worker", ".js")].join("\n;\n");
const app = list("src/js", ".js").join("\n\n").replace(/__VERSION__/g, pkg.version);
const cssText = list("src/css", ".css").join("\n");
const wasm = readFileSync(join(root, sqliteDir, "sqlite3.wasm")).toString("base64");
const notices = read("THIRD_PARTY_NOTICES.txt");

for (const [name, src] of [["worker", worker], ["app", app], ["css", cssText]])
  if (/<\/script/i.test(src)) throw new Error(`${name} contains "</script" and can't be inlined`);
if (notices.includes("-->")) throw new Error("notices can't contain -->");

let html = read("src/index.html");
const swap = (marker, value) => {
  if (!html.includes(marker)) throw new Error(`marker ${marker} missing from src/index.html`);
  html = html.replace(marker, () => value);
};
swap("/*__CSS__*/", cssText);
swap("/*__APP__*/", app);
swap("/*__WORKER__*/", worker);
swap("__WASM_B64__", wasm);
html = html.replace(/__VERSION__/g, pkg.version);
html = html.replace("<!DOCTYPE html>", () =>
  `<!DOCTYPE html>\n<!--\n  Health Connect Viewer v${pkg.version} (MIT License)\n  ${pkg.homepage}\n  Built file: the source is in src/ in the repository.\n-->`);
html += `\n<!--\n${notices}\n-->\n`;

mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist/health-connect-viewer.html");
writeFileSync(out, html);

// offline app: the service worker caches the page and its icons (online copy only)
const hash = createHash("sha256").update(html).digest("hex").slice(0, 12);
writeFileSync(join(root, "dist/sw.js"), read("src/pwa/sw.js").replace("__CACHE__", `hcv-${pkg.version}-${hash}`));
writeFileSync(join(root, "dist/manifest.webmanifest"), read("src/pwa/manifest.webmanifest"));
for (const f of readdirSync(join(root, "src/pwa")).filter(f => f.endsWith(".png") || f.endsWith(".svg")))
  writeFileSync(join(root, "dist", f), readFileSync(join(root, "src/pwa", f)));

console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB), sw cache hcv-${pkg.version}-${hash}`);
