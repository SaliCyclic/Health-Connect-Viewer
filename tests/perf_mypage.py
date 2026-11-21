"""Times My page rendering and editing against tests/out/Health Connect.zip.

    python tests/make_fake_export.py --days 1100 --hr-minutes 1
    python tests/perf_mypage.py
"""
import json, os
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = "file://" + os.path.join(os.path.dirname(HERE), "dist", "health-connect-viewer.html")
ZIP = os.path.join(HERE, "out", "Health Connect.zip")
LAYOUT = [{"id": i} for i in ["m:steps", "m:hr", "sleep:stages", "sleep:bed", "sleep:wake", "m:rhr", "m:weight", "m:bp",
                              "m:total", "wk:summary", "m:hydration", "m:spo2"]] + [{"id": "tbl:steps_record_table"}]

def timed(page, js):
    """Run a synchronous action in the page and return ms until the browser has painted."""
    return page.evaluate("""async (js) => {
        const t = performance.now(); (new Function(js))();
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
        // wait for any widgets still being drawn progressively
        for (let i = 0; i < 400 && document.querySelector('[data-pending]'); i++) await new Promise(r => setTimeout(r, 10));
        return Math.round(performance.now() - t);
    }""", js)

with sync_playwright() as p:
    kw = {"executable_path": os.environ["CHROME"], "args": ["--no-sandbox"]} if os.environ.get("CHROME") else {}
    br = p.chromium.launch(**kw)
    page = br.new_page(viewport={"width": 1280, "height": 900})
    page.goto(PAGE)
    page.evaluate(f"localStorage.setItem('hcv-page', {json.dumps(json.dumps(LAYOUT))})")
    page.reload()
    page.set_input_files("#file", ZIP); page.wait_for_selector("#app:not(.hidden)", timeout=120000)
    res = {}
    res["open My page"] = timed(page, "[...document.querySelectorAll('#tabs button')].find(b => b.textContent.includes('My page')).click()")
    res["open My page again"] = timed(page, "[...document.querySelectorAll('#tabs button')].find(b => b.textContent.includes('Activity')).click(); [...document.querySelectorAll('#tabs button')].find(b => b.textContent.includes('My page')).click()")
    res["enter edit mode"] = timed(page, "[...document.querySelectorAll('.mp-bar button')].find(b => /Edit page/.test(b.textContent)).click()")
    res["move a widget"] = timed(page, "document.querySelectorAll(\".wctl button[title='Move later']\")[1].click()")
    res["resize a widget"] = timed(page, "const s = document.querySelectorAll('.wctl select[title=Width]')[0]; s.value = 'wide'; s.dispatchEvent(new Event('change'))")
    res["switch to table view"] = timed(page, "const s = document.querySelectorAll('.wctl select[title=Show]')[2]; s.value = 'both'; s.dispatchEvent(new Event('change'))")
    res["add a widget"] = timed(page, "[...document.querySelectorAll('.picker button')].find(b => b.textContent.includes('Distance')).click()")
    res["remove a widget"] = timed(page, "document.querySelectorAll(\".wctl button[title='Remove']\")[0].click()")
    res["leave edit mode"] = timed(page, "[...document.querySelectorAll('.mp-bar button')].find(b => /Done/.test(b.textContent)).click()")
    res["change range to All"] = timed(page, "[...document.querySelectorAll('#rangeSeg button')].find(b => b.textContent === 'All').click()")
    res["change units"] = timed(page, "[...document.querySelectorAll('#unitSeg button')].find(b => b.textContent === 'Imperial').click()")
    for k, v in res.items(): print(f"{k:24s} {v:6d} ms")
    br.close()
