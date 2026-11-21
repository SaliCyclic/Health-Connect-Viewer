"""End-to-end checks of dist/health-connect-viewer.html with a synthetic export.

    pip install playwright && playwright install chromium
    python tests/make_fake_export.py
    python tests/test_viewer.py            # set CHROME=/path/to/chrome to use an installed browser

Screenshots go to tests/screenshots/. Exits non-zero if any check fails.
"""
import functools, http.server, os, sqlite3, struct, sys, threading, zlib
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DIST = os.path.join(ROOT, "dist")
PAGE = "file://" + os.path.join(DIST, "health-connect-viewer.html")
OUT = os.path.join(HERE, "out")
ZIP = os.path.join(OUT, "Health Connect.zip")
EXTRA = [os.path.join(OUT, f) for f in ("morning-run.gpx", "bike.tcx", "watch-run.fit", "openvitals-cycle-journal.json")]
SHOTS = os.path.join(HERE, "screenshots")
os.makedirs(SHOTS, exist_ok=True)
TABS = ["Activity", "Heart", "Sleep", "Body", "Vitals", "Nutrition & mind", "Workouts", "Cycle", "Patterns", "All tables & SQL", "My page"]

failures = []
def check(ok, msg):
    print(("PASS " if ok else "FAIL ") + msg, flush=True)
    if not ok: failures.append(msg)

def tile_png():
    raw = b"".join(b"\x00" + bytes((222, 230, 214)) * 256 for _ in range(256))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", 256, 256, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")

def launch(p):
    kw = {"executable_path": os.environ["CHROME"], "args": ["--no-sandbox"]} if os.environ.get("CHROME") else {}
    return p.chromium.launch(**kw)

def settle(page):
    page.wait_for_timeout(60)
    page.wait_for_function("() => !document.querySelector('[data-pending]')", timeout=90000)
    page.wait_for_timeout(120)

def tab(page, name):
    page.click(f"#tabs button:has-text('{name}')"); settle(page)

def open_export(page, extra=True):
    page.set_input_files("#file", [ZIP] + (EXTRA if extra else []))
    page.wait_for_selector("#app:not(.hidden)", timeout=120000)
    page.evaluate("() => document.querySelectorAll('.toast').forEach(t => t.remove())")
    settle(page)

def expected_steps_by_day():
    """Combined steps = the watch's (app 3, top priority) totals, since both apps cover the same hours."""
    c = sqlite3.connect(os.path.join(OUT, "health_connect_export.db"))
    rows = c.execute("SELECT (start_time + start_zone_offset * 1000) / 86400000, sum(count) FROM steps_record_table WHERE app_info_id = 3 GROUP BY 1").fetchall()
    return {d: v for d, v in rows}

def run_file_mode(p, scheme):
    browser = launch(p)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, color_scheme=scheme, accept_downloads=True)
    page = ctx.new_page()
    errors, requests = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("request", lambda r: requests.append(r.url) if r.url.startswith("http") else None)
    page.route("https://tile.opentopomap.org/**", lambda r: r.fulfill(status=200, content_type="image/png", body=tile_png()))
    page.goto(PAGE)
    open_export(page)
    tag = f"[{scheme}]"

    for name in TABS:
        tab(page, name)
        n = page.locator("#views .card").count(); errs = page.locator("#views .status.err").count()
        check(n > 0 and errs == 0, f"{tag} {name}: {n} cards, {errs} errors")
        page.screenshot(path=os.path.join(SHOTS, f"{scheme}_{name.split()[0].lower()}.png"), full_page=True)

    # numbers: combined sources must not double count
    exp = expected_steps_by_day()
    got = page.evaluate("""async () => { const m = METRICS.find(x => x.id === 'steps'); S.sources.steps = 'combined';
        const r = await dailyMetric(m, S.fromDay, S.toDay, await sourcesFor(m.table)); return r.rows.map(x => [x.day, x.v]); }""")
    bad = [(d, v, exp.get(d)) for d, v in got if abs(v - exp.get(d, -1)) > 0.5]
    check(len(got) > 50 and not bad, f"{tag} combined steps match the top-priority app ({len(got)} days, {len(bad)} mismatches)")
    added = page.evaluate("""async () => { const m = METRICS.find(x => x.id === 'steps'); S.sources.steps = 'all';
        const r = await dailyMetric(m, S.fromDay, S.toDay, await sourcesFor(m.table)); S.sources.steps = 'combined'; return r.rows.reduce((a, x) => a + x.v, 0); }""")
    check(added > sum(v for _, v in got) * 1.5, f"{tag} 'all sources added up' really adds both apps")
    nights = page.evaluate("async () => { S.memo = {}; const d = await sleepData(); return [d.rowsD.length, Math.max(...d.rowsD.map(r => r.n))]; }")
    check(nights[1] == 1, f"{tag} overlapping sleep from a second app is removed ({nights[0]} nights, max {nights[1]} session/night)")

    tab(page, "Sleep")
    check(page.locator(".chart svg line[stroke-dasharray='7 4']").count() >= 2, f"{tag} bedtime + wake average lines")

    # trend, comparison, goal
    page.click("#trendSeg button:text-is('7-day')"); page.select_option("#compareSel", "prev"); tab(page, "Activity")
    legend = page.locator("#views .card").first.locator(".legend").inner_text()
    check("7-day average" in legend and "Previous" in legend and "Goal" in legend, f"{tag} trend, previous period and goal shown")
    page.click("#trendSeg button:text-is('Off')"); page.select_option("#compareSel", "off"); settle(page)

    # custom range
    page.click("#rangeSeg button:text-is('Custom…')")
    page.fill("#customRange [name=from]", "2026-10-01"); page.fill("#customRange [name=to]", "2026-10-31")
    page.click("#customRange button"); settle(page)
    lab = page.inner_text("#rangeLabel")
    check("Oct 1, 2026" in lab and "Oct 31, 2026" in lab, f"{tag} custom range applied ({lab})")
    page.click("#rangeSeg button:text-is('90d')"); settle(page)

    # PNG export
    with page.expect_download() as d: page.locator("#views .card-foot button:text-is('PNG')").first.click()
    path = d.value.path()
    check(open(path, "rb").read(4) == b"\x89PNG" and os.path.getsize(path) > 5000, f"{tag} chart saved as PNG ({os.path.getsize(path)} bytes)")

    # keyboard: focus a chart and step through values
    page.locator("#views .chart svg").first.focus(); page.keyboard.press("ArrowLeft")
    tip = page.locator("#views .chart .tip").first
    check(tip.is_visible() and len(tip.inner_text()) > 5, f"{tag} keyboard opens the chart tooltip")
    page.keyboard.press("Escape")

    # schema report: names only
    tab(page, "All tables & SQL")
    with page.expect_download() as d: page.click("text=Save as file")
    rep = open(d.value.path()).read()
    check("steps_record_table" in rep and "count INTEGER" in rep and "rows)" not in rep, f"{tag} schema report lists names and columns only")

    # My page: add items, edit one, survive reload
    tab(page, "My page")
    page.click("text=Edit page")
    page.select_option(".picker select", "weight_record_table"); page.click("text=+ Add table")
    page.click("text=+ Custom SQL chart or table"); settle(page)
    page.evaluate("() => { const c = document.querySelectorAll('#views .slot > .card'); c[c.length - 1].dataset.marker = '1'; }")
    page.locator(".wctl button[title='Move later']").first.click()
    page.locator(".wctl select[title=Width]").first.select_option("wide")
    check(page.locator("[data-marker='1']").count() == 1, f"{tag} editing one widget leaves the others untouched")
    page.click("text=Done"); settle(page)
    before = page.locator("#views .grid > .slot > .card").count()
    page.reload(); open_export(page, extra=False); tab(page, "My page")
    after = page.locator("#views .grid > .slot > .card").count()
    check(before == after and before >= 7, f"{tag} My page kept {after} widgets after reload")

    check(not requests, f"{tag} no network requests with maps off ({requests[:3]})")

    # imported files appear; maps on requests only tiles
    page.set_input_files("#addInput", EXTRA); page.wait_for_selector(".toast")
    page.evaluate("() => document.querySelectorAll('.toast').forEach(t => t.remove())")
    tab(page, "Workouts")
    check(page.locator("tbody tr.click:has-text('File: watch-run.fit')").count() == 1, f"{tag} FIT workout imported")
    check(page.locator("tbody tr.click:has-text('File: bike.tcx')").count() == 1 and page.locator("tbody tr.click:has-text('File: morning-run.gpx')").count() == 1, f"{tag} TCX and GPX workouts imported")
    page.click("tbody tr.click:has-text('watch-run.fit')"); page.wait_for_timeout(800)
    check(page.locator(".zones .zrow").count() == 5 and page.locator("text=Splits per km").count() == 1, f"{tag} workout detail has zones and splits")
    page.click("text=show on a map…"); page.check("#mapsOn"); page.click("#mapsSave"); settle(page)
    page.click("tbody tr.click:has-text('watch-run.fit')"); page.wait_for_timeout(1500)
    check(page.locator(".map img").count() > 0, f"{tag} map tiles drawn")
    check(bool(requests) and all("tile.opentopomap.org" in u for u in requests), f"{tag} only map images requested with maps on")
    page.locator(".map").scroll_into_view_if_needed(); page.screenshot(path=os.path.join(SHOTS, f"{scheme}_map.png"))
    tab(page, "Cycle")
    check(page.locator("text=Symptoms").count() >= 1 and page.locator(".cal-d.p3").count() > 0, f"{tag} cycle tab shows periods and journal")

    # print layout
    page.emulate_media(media="print")
    check(not page.locator("header.top").is_visible() and page.locator("#printHead").is_visible(), f"{tag} print layout hides controls and adds a report header")
    page.screenshot(path=os.path.join(SHOTS, f"{scheme}_print.png"), full_page=True)
    page.emulate_media(media="screen")
    check(not errors, f"{tag} no page errors {errors[:3]}")
    ctx.close()

    # phone layout
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, color_scheme=scheme, is_mobile=True, has_touch=True)
    page = ctx.new_page(); page.goto(PAGE); open_export(page, extra=False)
    for name in ("Activity", "Sleep"):
        tab(page, name)
        ow = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
        check(ow <= 1, f"{tag} phone: {name} fits the screen (overflow {ow}px)")
    page.screenshot(path=os.path.join(SHOTS, f"{scheme}_phone.png"))
    page.locator("#views .chart svg").first.tap()
    check(page.locator("#views .chart .tip").first.is_visible(), f"{tag} phone: tapping a chart shows its values")
    ctx.close(); browser.close()

def run_server_mode(p):
    """The online copy: low-memory mode (OPFS) and the installable offline app (service worker)."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIST)
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/health-connect-viewer.html"
    browser = launch(p)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page(); errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    page.evaluate("() => localStorage.setItem('hcv-dbmode', JSON.stringify('disk'))")
    page.reload(); open_export(page, extra=False)
    check("low-memory" in page.inner_text("#fileinfo"), "[server] low-memory mode used")
    tab(page, "Heart")
    check(page.locator("#views .card").count() >= 3 and page.locator("#views .status.err").count() == 0, "[server] charts work in low-memory mode")
    ok = page.evaluate("() => Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise(r => setTimeout(() => r(false), 10000))])")
    check(ok, "[server] offline app service worker installed")
    page.wait_for_timeout(1000)
    ctx.set_offline(True)
    page.reload(); page.wait_for_selector("#pick", timeout=15000)
    check(page.locator("#pick").is_visible(), "[server] viewer opens while offline")
    ctx.set_offline(False)
    check(not errors, f"[server] no page errors {errors[:3]}")
    browser.close(); srv.shutdown()

def main():
    if not os.path.exists(ZIP): sys.exit("Run tests/make_fake_export.py first.")
    with sync_playwright() as p:
        for scheme in ("light", "dark"): run_file_mode(p, scheme)
        run_server_mode(p)
    print(f"\n{len(failures)} failure(s)")
    sys.exit(1 if failures else 0)

if __name__ == "__main__":
    main()
