"""Measure motion jitter in the built game page (play.html), frame by frame, at several display refresh rates.

The page's requestAnimationFrame is replaced so this script hands it each frame's timestamp: exact refresh rates,
rates with timer noise, and dropped frames, independent of how fast headless Chromium can draw. For each, a new game
launches from the start port and flies: thrust up to cruise, then a long turn, then the burner; the page's jitter
probe (src/play/jitter.js) scores every frame. Jitter is a change of apparent speed between frames, in pixels of a
1080p view (whatever the window here; a 4K screen sees twice these):
steady motion scores 0 at any rate, so anything above about half a pixel is a pose landing early or late.
Needs Playwright for Python (on the dev box: ~/.venvs/web/bin/python tools/jitter.py).
Usage: jitter.py [play.html] [--seconds S] [--size WxH] [--live]
  --size  the window (default 640x400; the numbers are scaled to a 1080p view either way, and smaller draws faster)
  --live  real requestAnimationFrame instead (the browser's own pacing; headless Chromium is slow, so read the
          frame times with that in mind)
"""
import json, pathlib, random, sys
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
argv = sys.argv[1:]
args = [a for k, a in enumerate(argv) if not a.startswith('--') and (k == 0 or argv[k - 1] not in ('--seconds', '--size'))]
page_path = pathlib.Path(args[0] if args else root / 'play.html').resolve()
live = '--live' in sys.argv
seconds = float(sys.argv[sys.argv.index('--seconds') + 1]) if '--seconds' in sys.argv else 2.0
VW, VH = map(int, (sys.argv[sys.argv.index('--size') + 1] if '--size' in sys.argv else '640x400').split('x'))

# (label, refresh Hz, timestamp noise in ms, drop one frame in this many)
RATES = [('60 Hz', 60, 0, 0), ('60 Hz, 1 ms timer noise', 60, 1.0, 0), ('60 Hz, a dropped frame a second', 60, 0, 60),
         ('75 Hz', 75, 0, 0), ('120 Hz', 120, 0, 0), ('144 Hz', 144, 0, 0), ('165 Hz', 165, 0, 0), ('240 Hz', 240, 0, 0)]

MANUAL = """
window.__rafQ = [];
if (!window.__liveRAF) window.requestAnimationFrame = cb => { window.__rafQ.push(cb); return window.__rafQ.length; };
window.__pump = t => { const q = window.__rafQ.splice(0); for (const cb of q) cb(t); };
"""

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': VW, 'height': VH})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    if live: pg.add_init_script('window.__liveRAF = true;')
    pg.add_init_script(MANUAL)
    pg.goto(page_path.as_uri())
    clock = [1000.0]
    def pump(ms):
        if live: pg.wait_for_timeout(ms); return
        clock[0] += ms; pg.evaluate('t => window.__pump(t)', clock[0])
    for _ in range(4000):  # boot: the core loads and the player's hull bakes
        pump(16.667)
        if pg.evaluate('!!(window.__play && window.__play.probe().ready)'): break
    else: sys.exit('page did not start: ' + '; '.join(errs))

    def flight(hz, noise, drop):
        P = '__play'
        pg.evaluate(f'{P}.newGame(1)'); pump(16.667)
        pg.evaluate(f'{P}.command({P}.CMD.launch, 0, 0)'); pump(16.667)
        pg.evaluate(f'{P}.command({P}.CMD.skip, 0, 0)')
        for _ in range(120):
            pump(16.667)
            if pg.evaluate(f'{P}.probe().mode === {P}.MODE.flying'): break
        for _ in range(30): pump(16.667)  # settle the camera
        pg.evaluate(f'{P}.jitterClear()')
        rng, step, n = random.Random(hz), 1000.0 / hz, int(seconds * hz)
        phase = [(0.0, ['KeyW']), (0.35, ['KeyW', 'KeyA']), (0.7, ['KeyW', 'ShiftLeft'])]
        held = []
        for k in range(n):
            want = next(keys for at, keys in reversed(phase) if k >= at * n)
            if want != held:
                for key in held: pg.keyboard.up(key)
                for key in want: pg.keyboard.down(key)
                held = want
            gap = step * (2 if drop and k % drop == drop - 1 else 1)
            pump(gap + (rng.uniform(-noise, noise) if noise else 0))
        for key in held: pg.keyboard.up(key)
        return pg.evaluate(f'{P}.jitter()')

    print(f'{"display":34} {"frame ms":>9} {"ticks/frame":>16} {"jitter px at 1080p, p99 / max":>48}')
    print(f'{"":34} {"p50":>9} {"":>16} {"ship":>11} {"camera":>11} {"on screen":>11} {"others":>13}')
    out = []
    # the page's motion state for a ship (play.js jitState): 1 + traffic phase + 4 on rails; phase 0 not traffic
    state = lambda st: 'player-like' if st == 1 else f'traffic {["", "launching", "cruising", "landing"][(st - 1) % 4]}, {"on rails" if st > 4 else "flown"}'
    for label, hz, noise, drop in ([('live', 60, 0, 0)] if live else RATES):
        r = flight(hz, noise, drop); out.append({'display': label, **r})
        tk = ' '.join(f'{t}:{c}' for t, c in sorted(r['ticksPerFrame'].items()))
        f = lambda s: f'{s["p99"]:.2f}/{s["max"]:.2f}'
        print(f'{label:34} {r["frameMs"]["p50"]:9.2f} {tk:>16} {f(r["ship"]):>11} {f(r["camera"]):>11} {f(r["onScreen"]):>11} {f(r["others"]):>13}'
              + (f'  worst other: slot {r["worstOther"]["slot"]}, {state(r["worstOther"]["state"])}' if r['worstOther'] and r['others']['max'] > 1 else ''))
    if errs: print('page errors:', '; '.join(errs[:5]))
    (pathlib.Path('/tmp') / 'jitter-report.json').write_text(json.dumps(out, indent=1))
    print('full report: /tmp/jitter-report.json')
    b.close()
