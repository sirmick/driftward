"""Drive the built page in headless Chromium and check flight mode end to end.

Checks: flight mode starts on the sim core with no console errors; assist flight reaches the expected speeds;
a seeded sector with the same held keys replays to the same core state hash; the live clock ticks at 60 Hz.
Needs Playwright for Python (on the dev box: ~/.venvs/web/bin/python tools/fly-smoke.py).
Usage: fly-smoke.py [index.html] [screenshot.png]
"""
import json, pathlib, sys, time
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
page_path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root / 'index.html').resolve()
shot = sys.argv[2] if len(sys.argv) > 2 else None
fails = []

def check(ok, what):
    print(('ok    ' if ok else 'FAIL  ') + what)
    if not ok: fails.append(what)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': 1280, 'height': 800})
    errs = []
    pg.on('console', lambda m: m.type == 'error' and errs.append(m.text))
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(page_path.as_uri())
    pg.click('[data-view=fly]')
    pg.wait_for_function('window.__fly && window.__fly.probe().t > 0', timeout=120000)
    ev = pg.evaluate

    # assist on, from rest: 4 s holding W, then 3 s on the burner (seeded sector, so the gas is the same each run)
    a = ev("(() => { const F = __fly; F.reset(4242); F.advance(4, ['KeyW']); const a = F.probe(); F.advance(3, ['KeyW', 'ShiftLeft']); return [a, F.probe()]; })()")
    print('after 4 s W   ', json.dumps({k: a[0][k] for k in ('tick', 'v', 'set', 'y')}))
    print('after 3 s burn', json.dumps({k: a[1][k] for k in ('tick', 'v', 'set', 'y', 'fuel', 'gas')}))
    check(355 < a[0]['v'] < 365, f"cruise speed {a[0]['v']:.1f} m/s (the JS sim gave 359.7 from rest in clear space)")
    check(a[1]['v'] > a[0]['v'] + 50, f"burner adds speed ({a[1]['v']:.1f} m/s)")
    check(a[1]['fuel'] < 1, 'burner drinks fuel')

    # replay: same seed, same inputs -> same state, twice over
    replay = "(() => { const F = __fly; F.reset(%d); F.advance(10, ['KeyW', 'KeyA', 'Space']); F.advance(10, ['KeyW', 'ShiftLeft']); return F.probe().hash; })()"
    h1, h2, h3 = ev(replay % 77), ev(replay % 77), ev(replay % 78)
    print('replay hashes', h1, h2, h3)
    check(h1 == h2, 'seeded sector replays to the same core state')
    check(h1 != h3, 'a different seed gives a different state')

    # the live clock: real time drives fixed 60 Hz ticks whatever the frame rate. Warm up first: the software
    # renderer used headless compiles each shader on its first draw, stalling a frame (a real GPU does not)
    pg.wait_for_timeout(2000)
    t0, w0 = ev('__fly.probe().tick'), time.time()
    pg.wait_for_timeout(3000)
    rate = (ev('__fly.probe().tick') - t0) / (time.time() - w0)
    check(50 < rate < 64, f'live clock {rate:.1f} ticks/s at {ev("__fly.probe().fps"):.0f} fps')

    if shot: pg.screenshot(path=shot)
    check(not errs, 'no console errors' + (': ' + '; '.join(errs) if errs else ''))
    b.close()

print(f'{len(fails)} failed' if fails else 'flight smoke test passed')
sys.exit(1 if fails else 0)
