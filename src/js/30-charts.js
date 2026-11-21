// ============================================================================
// Charts: plain SVG, no library. Every chart supports hover, touch and keyboard
// (focus a chart, then use ←/→, Home/End, Esc), and can be saved as a PNG.
// ============================================================================

function niceTicks(lo, hi, n = 4) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n) || 10 * mag;
  const t0 = Math.floor(lo / step) * step, out = [];
  for (let t = t0; t <= hi + step * 0.5; t += step) out.push(+t.toFixed(10));
  return out;
}
function dateTicks(days, maxTicks) {
  if (!days.length) return [];
  const first = days[0], last = days[days.length - 1], span = last - first;
  const out = [];
  if (span > 500) {
    const y0 = dayToDate(first).getUTCFullYear(), y1 = dayToDate(last).getUTCFullYear();
    const months = span > 1400 ? [0] : [0, 6];
    for (let y = y0; y <= y1; y++) for (const m of months) { const d = Date.UTC(y, m, 1) / DAY; if (d >= first && d <= last) out.push(d); }
  } else if (span > 60) {
    let dt = dayToDate(first); dt = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1));
    const step = span > 250 ? 2 : 1;
    while (dt.getTime() / DAY <= last) { const d = dt.getTime() / DAY; if (d >= first) out.push(d); dt.setUTCMonth(dt.getUTCMonth() + step); }
  } else {
    const step = Math.max(1, Math.ceil(span / Math.max(1, maxTicks) / 7) * 7) || 7;
    let d = first + ((8 - dayToDate(first).getUTCDay()) % 7);
    for (; d <= last; d += step) out.push(d);
  }
  return out;
}
function tickLabel(d, span) {
  const dt = dayToDate(d);
  if (span > 500) return dt.getUTCMonth() ? dateFmt({ timeZone: "UTC", year: "numeric", month: "short" }).format(dt) : dateFmt({ timeZone: "UTC", year: "numeric" }).format(dt);
  if (span > 60) return dateFmt(dt.getUTCMonth() === 0 ? { timeZone: "UTC", month: "short", year: "numeric" } : { timeZone: "UTC", month: "short" }).format(dt);
  return dateFmt({ timeZone: "UTC", month: "short", day: "numeric" }).format(dt);
}
function bucketLabel(d, b) {
  if (b.size === 1) return fmtDay(d);
  if (b.size === 7) return "Week of " + fmtDay(d);
  return dateFmt({ timeZone: "UTC", month: "long", year: "numeric" }).format(dayToDate(d));
}
const compact = v => Math.abs(v) >= 10000 ? numFmt(0, 0).format(v / 1000) + "k" : Math.abs(v) >= 1000 ? numFmt(0, 1).format(v / 1000) + "k" : numFmt(0, 2).format(v);
function barPath(x, y, w, hgt, r, fill) {
  if (hgt <= 0) return "";
  r = Math.min(r, w / 2, hgt);
  return `<path d="M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z" fill="${fill}"/>`;
}
function runs(days, ok, maxGap) {
  const out = []; let cur = [];
  for (let i = 0; i < days.length; i++) {
    if (!ok(i)) { if (cur.length) out.push(cur); cur = []; continue; }
    if (cur.length && days[i] - days[cur[cur.length - 1]] > maxGap * 1.5 + 0.5) { out.push(cur); cur = []; }
    cur.push(i);
  }
  if (cur.length) out.push(cur); return out;
}
const SVGNS = "http://www.w3.org/2000/svg";
const chartObserver = new ResizeObserver(entries => { for (const e of entries) if (e.target._paint && e.target._w !== Math.round(e.contentRect.width)) e.target._paint(); });
function mountChart(el, paintFn) { el._paint = () => { el._w = Math.round(el.clientWidth); paintFn(); }; chartObserver.observe(el); el._paint(); }
const haloText = (x, y, txt, anchor = "end") =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" style="fill:var(--text-primary);font-weight:600;font-size:12px;paint-order:stroke;stroke:var(--surface-1);stroke-width:4px;stroke-linejoin:round">${esc(txt)}</text>`;

// Shared hover/touch/keyboard behaviour. xs: x position of each point; tipHtml(i) builds the tooltip.
function interactive(el, svg, W, xs, tipHtml, opts = {}) {
  const n = xs.length; if (!n) return;
  const tip = h("div", { class: "tip", role: "status" }); el.append(tip);
  const live = h("div", { class: "sr-only", "aria-live": "polite" }); el.append(live);
  const xh = svg.querySelector(".xh");
  let cur = -1;
  const show = (i, announce) => {
    cur = i;
    const x = xs[i]; if (xh) { xh.setAttribute("x1", x); xh.setAttribute("x2", x); xh.setAttribute("visibility", "visible"); }
    tip.innerHTML = tipHtml(i); tip.style.display = "block";
    const rect = svg.getBoundingClientRect(); const px = x / W * rect.width; const tw = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(0, px + 12), Math.max(0, rect.width - tw)) + "px";
    tip.style.top = (svg.offsetTop + 4) + "px";
    if (announce) live.textContent = tip.textContent;
  };
  const hide = () => { cur = -1; tip.style.display = "none"; xh?.setAttribute("visibility", "hidden"); };
  const nearest = clientX => {
    const rect = svg.getBoundingClientRect(); const mx = (clientX - rect.left) * W / rect.width;
    let best = 0, bd = Infinity; for (let i = 0; i < n; i++) { const d = Math.abs(xs[i] - mx); if (d < bd) { bd = d; best = i; } }
    return bd > (opts.maxDist || 30) ? -1 : best;
  };
  svg.addEventListener("pointermove", ev => { const i = nearest(ev.clientX); i < 0 ? hide() : show(i); });
  svg.addEventListener("pointerdown", ev => { const i = nearest(ev.clientX); if (i >= 0) show(i); });
  svg.addEventListener("pointerleave", ev => { if (ev.pointerType === "mouse") hide(); });
  svg.setAttribute("tabindex", "0");
  svg.addEventListener("focus", () => show(cur >= 0 ? cur : n - 1, true));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", ev => {
    const k = ev.key; let i = cur < 0 ? n - 1 : cur;
    if (k === "ArrowLeft") i = Math.max(0, i - 1); else if (k === "ArrowRight") i = Math.min(n - 1, i + 1);
    else if (k === "Home") i = 0; else if (k === "End") i = n - 1; else if (k === "Escape") { hide(); return; } else return;
    ev.preventDefault(); show(i, true);
  });
}

// ---------------------------------------------------------------- time-series chart
// o: { type: bar|line|stack|dots, days, bucket, series:[{name, values, color, style?:"ghost"|"trend"}],
//      unit, dp, yFmt, band:{lo,hi,name}, avgLine, goal:{value,label}, height }
function drawChart(el, o) { el._opts = o; mountChart(el, () => paintChart(el)); }
function paintChart(el) {
  const o = el._opts; const W = Math.max(260, Math.round(el.clientWidth));
  const H = o.height || 190, padL = 44, padR = 10, padT = 10, padB = 24;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = o.days.length;
  const main = o.series.filter(s => !s.style), extra = o.series.filter(s => s.style);
  let lo = Infinity, hi = -Infinity;
  if (o.type === "stack") { for (let i = 0; i < n; i++) { const s = main.reduce((a, se) => a + (se.values[i] || 0), 0); hi = Math.max(hi, s); } lo = 0; }
  else for (const se of main) for (const v of se.values) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (const se of extra) for (const v of se.values) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (o.band) { for (const v of o.band.lo) if (v != null) lo = Math.min(lo, v); for (const v of o.band.hi) if (v != null) hi = Math.max(hi, v); }
  if (o.goal?.value != null) { lo = Math.min(lo, o.goal.value); hi = Math.max(hi, o.goal.value); }
  if (o.type === "bar" || o.type === "stack") lo = Math.min(0, lo); else if (isFinite(hi)) { const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad; }
  if (!isFinite(hi)) { el.innerHTML = '<div class="empty">No values.</div>'; return; }
  let avgVal = null;
  if (o.avgLine) avgVal = mean(main[0].values.filter(v => v != null));
  const ticks = niceTicks(lo, hi); const y0 = Math.min(lo, ticks[0]), y1 = Math.max(hi, ticks[ticks.length - 1]);
  const Y = v => padT + ih - (v - y0) / (y1 - y0) * ih;
  const firstDay = n ? o.days[0] : 0, lastDay = n ? o.days[n - 1] : 0;
  const unitW = o.bucket.size;
  const span = Math.max(1, lastDay - firstDay + unitW);
  const X = d => padL + (d - firstDay + unitW / 2) / span * iw;
  const slotW = iw / span * unitW;
  const parts = [];
  for (const t of ticks) { if (t < y0 || t > y1) continue; parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--grid)" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 6}" y="${Y(t) + 4}" text-anchor="end">${esc(o.yFmt ? o.yFmt(t) : compact(t))}</text>`); }
  for (const d of dateTicks(o.days, Math.floor(iw / 80))) parts.push(`<text x="${X(d)}" y="${H - 6}" text-anchor="middle">${esc(tickLabel(d, lastDay - firstDay))}</text>`);
  const line = (se, attrs) => { for (const seg of runs(o.days, i => se.values[i] != null, unitW * 9999)) if (seg.length > 1)
    parts.push(`<polyline points="${seg.map(i => `${X(o.days[i])},${Y(se.values[i])}`).join(" ")}" fill="none" ${attrs}/>`); };
  // previous-period ghost first so it sits behind
  for (const se of extra.filter(s => s.style === "ghost")) line(se, `stroke="var(--text-muted)" stroke-width="1.5" stroke-dasharray="4 3" opacity=".9"`);
  if (o.type === "bar" || o.type === "stack") {
    const bw = Math.max(1, Math.min(28, slotW - (slotW > 6 ? 2 : 0.5)));
    const r = bw >= 8 ? 4 : bw >= 4 ? 2 : 0;
    for (let i = 0; i < n; i++) {
      let base = 0;
      const segs = main.map(se => ({ v: se.values[i] || 0, c: se.color })).filter(s => s.v > 0);
      segs.forEach((s, j) => {
        const yTop = Y(base + s.v), yBot = Y(base); base += s.v;
        const gap = o.type === "stack" && j > 0 && bw >= 4 ? 2 : 0;
        parts.push(barPath(X(o.days[i]) - bw / 2, yTop, bw, Math.max(0, yBot - yTop - gap), j === segs.length - 1 ? r : 0, `var(${s.c})`));
      });
    }
  } else if (o.type === "dots") {
    const se = main[0];
    for (let i = 0; i < n; i++) if (se.values[i] != null) parts.push(`<circle cx="${X(o.days[i])}" cy="${Y(se.values[i])}" r="${n > 200 ? 2.5 : 4}" fill="var(${se.color})" stroke="var(--surface-1)" stroke-width="1.5"/>`);
  } else {
    if (o.band) for (const seg of runs(o.days, i => o.band.lo[i] != null && o.band.hi[i] != null, unitW)) {
      const top = seg.map(i => `${X(o.days[i])},${Y(o.band.hi[i])}`), bot = seg.slice().reverse().map(i => `${X(o.days[i])},${Y(o.band.lo[i])}`);
      parts.push(`<polygon points="${top.concat(bot).join(" ")}" fill="var(--band)"/>`);
    }
    for (const se of main) for (const seg of runs(o.days, i => se.values[i] != null, unitW * (o.band ? 1 : 9999))) {
      if (seg.length > 1) parts.push(`<polyline points="${seg.map(i => `${X(o.days[i])},${Y(se.values[i])}`).join(" ")}" fill="none" stroke="var(${se.color})" stroke-width="2" stroke-linejoin="round"/>`);
      if (seg.length < 60 || seg.length === 1) for (const i of seg) parts.push(`<circle cx="${X(o.days[i])}" cy="${Y(se.values[i])}" r="${seg.length === 1 ? 4 : 3}" fill="var(${se.color})" stroke="var(--surface-1)" stroke-width="1.5"/>`);
    }
  }
  for (const se of extra.filter(s => s.style === "trend")) line(se, `stroke="var(--text-primary)" stroke-width="2.5" stroke-linejoin="round" opacity=".75"`);
  if (o.goal?.value != null) {
    const yg = Y(o.goal.value);
    parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${yg}" y2="${yg}" stroke="var(--s3)" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/>`);
    parts.push(haloText(padL + 4, yg - 6, o.goal.label || `Goal ${nf(o.goal.value, o.dp)}`, "start"));
  }
  if (avgVal != null) {
    const ya = Y(avgVal);
    parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${ya}" y2="${ya}" stroke="var(--text-primary)" stroke-width="2" stroke-dasharray="7 4" opacity=".85"/>`);
    parts.push(haloText(W - padR - 4, ya - 6, `avg ${o.yFmt ? o.yFmt(avgVal) : nf(avgVal, o.dp)}`));
  }
  parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${Y(Math.max(y0, Math.min(0, y1)))}" y2="${Y(Math.max(y0, Math.min(0, y1)))}" stroke="var(--border)"/>`);
  parts.push(`<line class="xh" x1="0" x2="0" y1="${padT}" y2="${padT + ih}" stroke="var(--text-muted)" stroke-dasharray="3 3" visibility="hidden"/>`);
  el.innerHTML = "";
  if (main.length > 1 || o.band || avgVal != null || extra.length || o.goal) {
    const lg = h("div", { class: "legend" });
    if (main.length > 1 || extra.length || o.band) for (const se of main) lg.append(h("span", {}, h("i", { style: `background:var(${se.color})` }), se.name));
    for (const se of extra) lg.append(h("span", {}, h("i", { class: "ln", style: se.style === "ghost" ? "border-top:2px dashed var(--text-muted)" : "border-top:3px solid var(--text-primary);opacity:.75" }), se.name));
    if (o.band) lg.append(h("span", {}, h("i", { style: "background:var(--band)" }), o.band.name));
    if (avgVal != null) lg.append(h("span", {}, h("i", { class: "ln", style: "border-top:2px dashed var(--text-primary)" }), `Average (${o.yFmt ? o.yFmt(avgVal) : nf(avgVal, o.dp)})`));
    if (o.goal) lg.append(h("span", {}, h("i", { class: "ln", style: "border-top:2px dotted var(--s3)" }), o.goal.label || "Goal"));
    el.append(lg);
  }
  const svg = document.createElementNS(SVGNS, "svg"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("height", H);
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `${o.series.map(s => s.name).join(", ")} chart, ${n} points. Focus and use the arrow keys to read values, or use the Table button.`);
  svg.innerHTML = parts.join(""); el.append(svg);
  const f = v => v == null ? "–" : (o.yFmt ? o.yFmt(v) : nf(v, o.dp) + (o.unit ? " " + o.unit : ""));
  interactive(el, svg, W, o.days.map(X), i => {
    let html = `<b>${esc(bucketLabel(o.days[i], o.bucket))}</b>`;
    for (const se of main.slice().reverse()) html += `<div class="row"><span><i style="background:var(${se.color})"></i>${esc(se.name)}</span><span>${esc(f(se.values[i]))}</span></div>`;
    if (o.type === "stack") html += `<div class="row"><span>Total</span><span>${esc(f(main.reduce((a, se) => a + (se.values[i] || 0), 0)))}</span></div>`;
    for (const se of extra) html += `<div class="row"><span>${esc(se.name)}</span><span>${esc(f(se.values[i]))}</span></div>`;
    if (avgVal != null) { const v = main[0].values[i]; const diff = v == null ? null : v - avgVal;
      html += `<div class="row"><span>Average</span><span>${esc(f(avgVal))}</span></div>`;
      if (diff != null) html += `<div class="row"><span>vs average</span><span>${o.yFmt ? (diff >= 0 ? "+" : "−") + Math.round(Math.abs(diff) * 60) + " min" : (diff >= 0 ? "+" : "") + nf(diff, o.dp)}</span></div>`; }
    if (o.band) html += `<div class="row"><span>${esc(o.band.name)}</span><span>${esc(nf(o.band.lo[i]))}–${esc(nf(o.band.hi[i]))} ${o.unit}</span></div>`;
    return html;
  }, { maxDist: Math.max(slotW, 20) });
}

// ---------------------------------------------------------------- numeric x/y chart (scatter, profiles)
// o: { points:[[x,y]], type:"scatter"|"line", xFmt, yFmt, xLabel, yLabel, regression, color, height, labels?:[] }
function drawXY(el, o) { el._opts = o; mountChart(el, () => paintXY(el)); }
function paintXY(el) {
  const o = el._opts; const W = Math.max(260, Math.round(el.clientWidth));
  const H = o.height || 220, padL = 46, padR = 12, padT = 10, padB = o.xLabel ? 38 : 24;
  const iw = W - padL - padR, ih = H - padT - padB;
  const pts = o.points.filter(p => isFinite(p[0]) && isFinite(p[1]));
  if (!pts.length) { el.innerHTML = '<div class="empty">No values.</div>'; return; }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  let xlo = Math.min(...xs), xhi = Math.max(...xs), ylo = Math.min(...ys), yhi = Math.max(...ys);
  const yp = (yhi - ylo) * 0.08 || 1; ylo -= yp; yhi += yp;
  if (o.type === "scatter") { const xp = (xhi - xlo) * 0.05 || 1; xlo -= xp; xhi += xp; }
  const xt = niceTicks(xlo, xhi, Math.max(2, Math.floor(iw / 90))), yt = niceTicks(ylo, yhi);
  const x0 = Math.min(xlo, xt[0]), x1 = Math.max(xhi, xt[xt.length - 1]), y0 = Math.min(ylo, yt[0]), y1 = Math.max(yhi, yt[yt.length - 1]);
  const X = v => padL + (v - x0) / (x1 - x0 || 1) * iw, Y = v => padT + ih - (v - y0) / (y1 - y0 || 1) * ih;
  const parts = [];
  for (const t of yt) { if (t < y0 || t > y1) continue; parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--grid)"/><text x="${padL - 6}" y="${Y(t) + 4}" text-anchor="end">${esc(o.yFmt ? o.yFmt(t) : compact(t))}</text>`); }
  for (const t of xt) { if (t < x0 || t > x1) continue; parts.push(`<text x="${X(t)}" y="${padT + ih + 16}" text-anchor="middle">${esc(o.xFmt ? o.xFmt(t) : compact(t))}</text>`); }
  if (o.xLabel) parts.push(`<text x="${padL + iw / 2}" y="${H - 4}" text-anchor="middle">${esc(o.xLabel)}</text>`);
  parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${padT + ih}" y2="${padT + ih}" stroke="var(--border)"/>`);
  const color = `var(${o.color || "--s1"})`;
  if (o.type === "line") {
    const step = Math.max(1, Math.floor(pts.length / 1500));
    const pl = []; for (let i = 0; i < pts.length; i += step) pl.push(`${X(pts[i][0]).toFixed(1)},${Y(pts[i][1]).toFixed(1)}`);
    if (o.fill) parts.push(`<polygon points="${X(pts[0][0])},${padT + ih} ${pl.join(" ")} ${X(pts[pts.length - 1][0])},${padT + ih}" fill="var(--band)"/>`);
    parts.push(`<polyline points="${pl.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`);
  } else {
    for (const p of pts) parts.push(`<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="${pts.length > 200 ? 3 : 4.5}" fill="${color}" fill-opacity=".75" stroke="var(--surface-1)" stroke-width="1.5"/>`);
  }
  let reg = null;
  if (o.regression && pts.length >= 3) {
    reg = linreg(pts);
    if (reg) { parts.push(`<line x1="${X(xlo)}" x2="${X(xhi)}" y1="${Y(reg.a + reg.b * xlo)}" y2="${Y(reg.a + reg.b * xhi)}" stroke="var(--text-primary)" stroke-width="2" stroke-dasharray="7 4" opacity=".85"/>`);
      parts.push(haloText(W - padR - 4, padT + 14, `r = ${nf(reg.r, 2)}`)); }
  }
  parts.push(`<line class="xh" x1="0" x2="0" y1="${padT}" y2="${padT + ih}" stroke="var(--text-muted)" stroke-dasharray="3 3" visibility="hidden"/>`);
  el.innerHTML = "";
  const svg = document.createElementNS(SVGNS, "svg"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("height", H);
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `${o.yLabel || "values"} against ${o.xLabel || "x"}, ${pts.length} points`);
  svg.innerHTML = parts.join(""); el.append(svg);
  const order = pts.map((p, i) => i).sort((a, b) => pts[a][0] - pts[b][0]);
  interactive(el, svg, W, order.map(i => X(pts[i][0])), k => { const i = order[k]; const p = pts[i];
    return `${o.labels ? `<b>${esc(o.labels[i])}</b>` : ""}<div class="row"><span>${esc(o.xLabel || "x")}</span><span>${esc(o.xFmt ? o.xFmt(p[0]) : nf(p[0], 1))}</span></div>` +
      `<div class="row"><span>${esc(o.yLabel || "y")}</span><span>${esc(o.yFmt ? o.yFmt(p[1]) : nf(p[1], 1))}</span></div>`; }, { maxDist: 24 });
  el._reg = reg;
}
function linreg(pts) {
  const n = pts.length, mx = mean(pts.map(p => p[0])), my = mean(pts.map(p => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (!sxx || !syy) return null;
  const b = sxy / sxx; return { a: my - b * mx, b, r: sxy / Math.sqrt(sxx * syy), n };
}

// ---------------------------------------------------------------- heatmap (sequential: one hue, light → dark)
// o: { rows:[label], cols:[label], values:[[v]], fmt, unit, colLabelEvery }
function drawHeatmap(el, o) { el._opts = o; mountChart(el, () => paintHeatmap(el)); }
function paintHeatmap(el) {
  const o = el._opts; const W = Math.max(300, Math.round(el.clientWidth));
  const padL = 40, padT = 6, padB = 22, nr = o.rows.length, nc = o.cols.length;
  const cw = (W - padL - 4) / nc, ch = Math.max(16, Math.min(26, cw * 1.1)), H = padT + nr * ch + padB;
  let mx = 0; for (const r of o.values) for (const v of r) if (v != null) mx = Math.max(mx, v);
  const parts = [];
  for (let r = 0; r < nr; r++) {
    parts.push(`<text x="${padL - 6}" y="${padT + r * ch + ch / 2 + 4}" text-anchor="end">${esc(o.rows[r])}</text>`);
    for (let c = 0; c < nc; c++) {
      const v = o.values[r][c]; const t = v == null || !mx ? 0 : v / mx;
      const fill = v == null ? "var(--grid)" : `color-mix(in srgb, var(--s1) ${Math.round(8 + t * 92)}%, var(--surface-1))`;
      parts.push(`<rect x="${padL + c * cw + 1}" y="${padT + r * ch + 1}" width="${Math.max(1, cw - 2)}" height="${ch - 2}" rx="3" style="fill:${fill}"/>`);
    }
  }
  const every = o.colLabelEvery || Math.ceil(nc / Math.max(1, Math.floor((W - padL) / 36)));
  for (let c = 0; c < nc; c += every) parts.push(`<text x="${padL + c * cw + cw / 2}" y="${H - 6}" text-anchor="middle">${esc(o.cols[c])}</text>`);
  parts.push(`<line class="xh" x1="0" x2="0" y1="0" y2="0" visibility="hidden"/>`);
  el.innerHTML = "";
  const svg = document.createElementNS(SVGNS, "svg"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("height", H);
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", o.label || "Heatmap");
  svg.innerHTML = parts.join(""); el.append(svg);
  // hover a cell: pick by x and y
  const tip = h("div", { class: "tip" }); el.append(tip);
  svg.addEventListener("pointermove", ev => {
    const rect = svg.getBoundingClientRect(); const mx2 = (ev.clientX - rect.left) * W / rect.width, my = (ev.clientY - rect.top) * H / rect.height;
    const c = Math.floor((mx2 - padL) / cw), r = Math.floor((my - padT) / ch);
    if (c < 0 || c >= nc || r < 0 || r >= nr) { tip.style.display = "none"; return; }
    const v = o.values[r][c];
    tip.innerHTML = `<b>${esc(o.rows[r])} ${esc(o.cols[c])}</b><div class="row"><span>${esc(o.valueName || "Average")}</span><span>${v == null ? "no data" : esc(nf(v, o.dp || 0) + (o.unit ? " " + o.unit : ""))}</span></div>`;
    tip.style.display = "block";
    tip.style.left = Math.min((padL + c * cw + cw) / W * rect.width + 6, rect.width - tip.offsetWidth) + "px";
    tip.style.top = (svg.offsetTop + (padT + r * ch) / H * rect.height + ch) + "px";
  });
  svg.addEventListener("pointerleave", () => (tip.style.display = "none"));
  el.append(h("div", { class: "legend" }, h("span", {}, "Less"),
    ...[10, 35, 60, 85, 100].map(p => h("i", { style: `background:color-mix(in srgb, var(--s1) ${p}%, var(--surface-1));margin:0` })),
    h("span", {}, "More")));
}

// ---------------------------------------------------------------- PNG export
// Copies a chart's SVG with every colour resolved, draws it on a canvas with the card's title, saves a PNG.
async function chartToPng(card, fileBase) {
  const chartEl = card.querySelector(".chart:not(.hidden)") || card.querySelector(".chart");
  const svg = chartEl?.querySelector("svg"); if (!svg) return;
  const title = card.querySelector(".card-head h3")?.textContent || "Chart";
  const sub = card.querySelector(".card-head .sub")?.textContent || "";
  const clone = svg.cloneNode(true);
  const src = svg.querySelectorAll("*"), dst = clone.querySelectorAll("*");
  src.forEach((node, i) => {
    const cs = getComputedStyle(node), d = dst[i];
    for (const p of ["fill", "stroke", "opacity", "fill-opacity", "stroke-width", "stroke-dasharray", "font-size", "font-weight", "font-family", "paint-order", "visibility"])
      d.style.setProperty(p, cs.getPropertyValue(p));
  });
  const vb = svg.viewBox.baseVal, scale = 2;
  clone.setAttribute("width", vb.width); clone.setAttribute("height", vb.height); clone.setAttribute("xmlns", SVGNS);
  const legend = [...(chartEl.querySelector(".legend")?.children || [])].map(s => s.textContent).filter(Boolean);
  const headH = 54 + (legend.length ? 22 : 0), W = vb.width + 32, H = vb.height + headH + 16;
  const canvas = h("canvas", { width: W * scale, height: H * scale }); const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = css("--surface-1") || "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = css("--text-primary"); ctx.font = "600 15px system-ui, sans-serif"; ctx.fillText(title, 16, 24);
  ctx.fillStyle = css("--text-muted"); ctx.font = "12px system-ui, sans-serif"; ctx.fillText(sub, 16, 42);
  if (legend.length) { ctx.fillStyle = css("--text-secondary"); ctx.fillText(legend.join("  ·  "), 16, 62); }
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  ctx.drawImage(img, 16, headH, vb.width, vb.height);
  URL.revokeObjectURL(url);
  ctx.fillStyle = css("--text-muted"); ctx.font = "10px system-ui, sans-serif";
  ctx.fillText(`${rangeText()} · Health Connect Viewer`, 16, H - 6);
  canvas.toBlob(b => download(`${(fileBase || title).replace(/[^\w-]+/g, "_")}.png`, b, "image/png"), "image/png");
}
