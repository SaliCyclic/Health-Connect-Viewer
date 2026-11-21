// ============================================================================
// All tables & SQL: browse every table, run read-only SQL, export CSV,
// and copy a schema report (names only, never values) for bug reports.
// ============================================================================
async function renderTables(v) {
  const wrap = h("div", { class: "cols2" }); v.append(wrap);
  const list = h("div", { class: "card tlist", role: "list" }); wrap.append(list);
  const right = h("div", {}); wrap.append(right);
  list.append(h("div", { class: "note", style: "margin-bottom:6px" }, `${S.tables.size} tables · counting rows…`));
  const sqlCard = h("div", { class: "card" }); right.append(sqlCard);
  sqlCard.append(h("div", { class: "card-head" }, h("div", {}, h("h3", {}, "Query"), h("div", { class: "sub" }, "Read-only view of your export. Times are milliseconds since 1970 (UTC); zone offsets are seconds. :from and :to are the selected range."))));
  const sql = h("textarea", { spellcheck: "false", "aria-label": "SQL query" }, "SELECT name FROM sqlite_master WHERE type = 'table'");
  const human = h("input", { type: "checkbox", checked: true });
  const out = h("div", { style: "margin-top:10px", "aria-live": "polite" });
  sqlCard.append(sql, h("div", { class: "card-foot" }, h("button", { class: "primary", onclick: () => run() }, "Run"),
    h("label", {}, human, " Show times as dates"), h("span", { class: "spacer" }),
    h("button", { onclick: () => { const m = sql.value.match(/from\s+"?(\w+)"?/i); exportQueryCsv(sql.value, `${m ? m[1] : "query"}.csv`, true, human.checked); } }, "Download result as CSV"),
    h("button", { title: "Add this query to My page", onclick: () => { S.tab = "mypage"; buildChrome(); render(); addItem({ id: "sql:" + newKey(), title: "Custom query", sql: sql.value, chart: "table" }); } }, "Add to My page")), out);
  // schema report for bug reports
  const rep = h("div", { class: "card" }); right.append(rep);
  const counts = h("input", { type: "checkbox" });
  rep.append(h("div", { class: "card-head" }, h("div", {}, h("h3", {}, "Schema report"),
    h("div", { class: "sub" }, "Table and column names only, never your values. Paste it into a bug report if a chart looks wrong."))),
    h("div", { class: "card-foot" }, h("label", {}, counts, " Include row counts"), h("span", { class: "spacer" }),
      h("button", { onclick: async e => { const txt = await schemaReport(counts.checked);
        try { await navigator.clipboard.writeText(txt); e.target.textContent = "Copied ✓"; } catch { download("schema-report.txt", txt, "text/plain"); e.target.textContent = "Saved as file"; }
        setTimeout(() => (e.target.textContent = "Copy schema report"), 2500); } }, "Copy schema report"),
      h("button", { onclick: async () => download("schema-report.txt", await schemaReport(counts.checked), "text/plain") }, "Save as file")));
  sql.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run(); });
  human.addEventListener("change", () => run());
  async function run(tableName) {
    out.innerHTML = ""; out.append(h("div", { class: "note" }, "Running…"));
    try {
      const res = await runQuery(sql.value, true, 1000);
      out.innerHTML = "";
      if (tableName) { const t = S.tables.get(tableName); out.append(h("div", { class: "note", style: "margin-bottom:6px" }, `Columns: ${t.cols.map(c => `${c.name} ${c.type}`.trim()).join(" · ")}`)); }
      out.append(h("div", { class: "note", style: "margin-bottom:6px" }, `${res.rows.length}${res.more ? "+ (showing first 1,000; CSV download includes all)" : ""} rows`));
      out.append(h("div", { class: "scroll" }, simpleTable(res.cols, res.rows.map(r => r.map((v, i) => fmtCell(res.cols[i], v, human.checked))))));
    } catch (e) { out.innerHTML = ""; out.append(h("div", { class: "status err" }, e.message)); }
  }
  run();
  const names = [...S.tables.keys()];
  await Promise.all(names.map(async n => { const t = S.tables.get(n); if (t.count == null) { try { t.count = (await q(`SELECT count(*) FROM "${n}"`))[0][0]; } catch { t.count = 0; } } }));
  if (!list.isConnected) return;
  names.sort((a, b) => (S.tables.get(b).count > 0) - (S.tables.get(a).count > 0) || a.localeCompare(b));
  list.firstChild.textContent = `${S.tables.size} tables`;
  for (const n of names) {
    const btn = h("button", { "aria-pressed": "false", role: "listitem", onclick: () => { [...list.querySelectorAll("button")].forEach(b => b.setAttribute("aria-pressed", "false")); btn.setAttribute("aria-pressed", "true");
      sql.value = `SELECT * FROM "${n}" LIMIT 200`; run(n); } }, h("span", { class: "nm", title: n }, n.replace(/_table$/, "")), h("span", {}, S.tables.get(n).count.toLocaleString()));
    list.append(btn);
  }
}
