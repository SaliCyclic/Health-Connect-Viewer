"""End-to-end check of dist/health-connect-viewer.html using a synthetic export.

    pip install playwright && playwright install chromium
    python tests/make_fake_export.py
    python tests/test_viewer.py            # set CHROME=/path/to/chrome to use an installed browser

Screenshots go to tests/screenshots/. The test fails on any page error, on any
network request while maps are off, or if a tab renders nothing.
"""
import os, struct, sys, zlib
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAGE = "file://" + os.path.join(ROOT, "dist", "health-connect-viewer.html")
ZIP = os.path.join(HERE, "out", "Health Connect.zip")
SHOTS = os.path.join(HERE, "screenshots")
os.makedirs(SHOTS, exist_ok=True)

def tile_png():  # plain 256x256 PNG standing in for a map tile
    raw = b"".join(b"\x00" + bytes((222, 230, 214)) * 256 for _ in range(256))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", 256, 256, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")

def settle(page):
    """Wait until every widget has finished drawing (they draw progressively)."""
    page.wait_for_timeout(50)
    page.wait_for_function("() => !document.querySelector('[data-pending]')", timeout=60000)

def main():
    if not os.path.exists(ZIP):
        sys.exit("Run tests/make_fake_export.py first.")
    failures = []
    def check(ok, msg):
        print(("PASS " if ok else "FAIL ") + msg)
        if not ok: failures.append(msg)

    with sync_playwright() as p:
        kw = {"executable_path": os.environ["CHROME"], "args": ["--no-sandbox"]} if os.environ.get("CHROME") else {}
        browser = p.chromium.launch(**kw)
        for scheme in ("light", "dark"):
            page = browser.new_context(viewport={"width": 1280, "height": 900}, color_scheme=scheme).new_page()
            errors, requests, tiles = [], [], []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("request", lambda r: requests.append(r.url) if r.url.startswith("http") else None)
            page.route("https://tile.opentopomap.org/**", lambda r: (tiles.append(r.request.url), r.fulfill(status=200, content_type="image/png", body=tile_png())))
            page.goto(PAGE)
            page.set_input_files("#file", ZIP)
            page.wait_for_selector("#app:not(.hidden)", timeout=60000)

            for tab in ["Activity", "Heart", "Sleep", "Body", "Vitals", "Nutrition & mind", "Workouts", "All tables & SQL", "My page"]:
                page.click(f"#tabs button:has-text('{tab}')")
                settle(page)
                n = page.locator("#views .card").count()
                check(n > 0, f"[{scheme}] {tab}: {n} cards")
                page.screenshot(path=os.path.join(SHOTS, f"{scheme}_{tab.split()[0].lower()}.png"), full_page=True)

            # scatter plots carry an average line
            page.click("#tabs button:text-is('Sleep')"); settle(page)
            check(page.locator(".chart svg line[stroke-dasharray='7 4']").count() == 2, f"[{scheme}] bedtime + wake average lines")

            # My page: add a table and a custom SQL widget, survive a reload
            page.click("#tabs button:has-text('My page')"); page.click("text=Edit page")
            page.select_option(".picker select", "weight_record_table"); page.click("text=+ Add table")
            page.click("text=+ Custom SQL chart or table"); page.wait_for_timeout(300)
            marker = page.evaluate("() => { const c = document.querySelectorAll('#views .slot > .card'); c[c.length - 1].dataset.marker = '1'; return c.length; }")
            page.locator(".wctl button[title='Move later']").first.click()
            page.locator(".wctl select[title=Width]").first.select_option("wide")
            check(page.locator("[data-marker='1']").count() == 1, f"[{scheme}] editing one widget leaves the others untouched")
            page.click("text=Done"); settle(page)
            before = page.locator("#views .grid > .slot > .card").count()
            page.reload(); page.set_input_files("#file", ZIP); page.wait_for_selector("#app:not(.hidden)")
            page.click("#tabs button:has-text('My page')"); settle(page)
            after = page.locator("#views .grid > .slot > .card").count()
            check(before == after and before >= 7, f"[{scheme}] My page kept {after} widgets after reload")

            check(not requests, f"[{scheme}] no network requests with maps off ({len(requests)})")

            # maps on: only tile images are requested
            page.click("#tabs button:text-is('Workouts')"); settle(page); page.click("tbody tr.click >> nth=0"); page.wait_for_timeout(200)
            page.click("text=show on a map…"); page.check("#mapsOn"); page.click("#mapsSave"); page.wait_for_timeout(200)
            settle(page); page.click("tbody tr.click >> nth=0"); page.wait_for_timeout(1200)
            check(page.locator(".map img").count() > 0, f"[{scheme}] map tiles drawn")
            check(all("tile.opentopomap.org" in u for u in requests), f"[{scheme}] only tile requests with maps on")
            page.locator(".map").scroll_into_view_if_needed()
            page.screenshot(path=os.path.join(SHOTS, f"{scheme}_map.png"))
            check(not errors, f"[{scheme}] no page errors {errors[:3]}")
            page.context.close()
        browser.close()
    print(f"\n{len(failures)} failure(s)")
    sys.exit(1 if failures else 0)

if __name__ == "__main__":
    main()
