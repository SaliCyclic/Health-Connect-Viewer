// Bundles src/viewer.html + sql.js (with its WebAssembly) + fflate into one
// self-contained file: dist/health-connect-viewer.html
//
//   npm install
//   npm run build
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sqlDir = join(root, "node_modules/sql.js");
const fflateDir = join(root, "node_modules/fflate");

const read = p => readFileSync(p, "utf8");
const pkg = JSON.parse(read(join(root, "package.json")));
const sqljs = read(join(sqlDir, "dist/sql-wasm-browser.js"));
const fflate = read(join(fflateDir, "umd/index.js"));
const wasm = readFileSync(join(sqlDir, "dist/sql-wasm-browser.wasm")).toString("base64");
const notices = read(join(root, "THIRD_PARTY_NOTICES.txt"));

for (const [name, src] of [["sql.js", sqljs], ["fflate", fflate]])
  if (/<\/script/i.test(src)) throw new Error(`${name} contains "</script" and can't be inlined`);
if (notices.includes("-->")) throw new Error("notices can't contain -->");

let html = read(join(root, "src/viewer.html"));
const swap = (marker, value) => {
  if (!html.includes(marker)) throw new Error(`marker ${marker} missing from src/viewer.html`);
  html = html.replace(marker, () => value);   // function form: no $-pattern surprises
};
swap("/*__SQLJS__*/", sqljs);
swap("/*__FFLATE__*/", fflate);
swap("__WASM_B64__", wasm);
swap("__VERSION__", pkg.version);
html = html.replace("<!DOCTYPE html>", () =>
  `<!DOCTYPE html>\n<!--\n  Health Connect Viewer v${pkg.version} (MIT License)\n  ${pkg.homepage}\n  Built file: source is src/viewer.html in the repository.\n-->`);
html += `\n<!--\n${notices}\n-->\n`;

mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist/health-connect-viewer.html");
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
