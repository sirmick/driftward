"""Drive the built game page (play.html) in headless Chromium and check the session machinery end to end.

Checks: the page starts on the sim core with no console errors; the player's assist flight matches the lab's
numbers; save then load restores the exact state; a replay exported from the browser (snapshot + input log)
reruns natively to the same state hash; the live clock ticks at 60 Hz.
Needs Playwright for Python (on the dev box: ~/.venvs/web/bin/python tools/play-smoke.py) and cargo.
Usage: play-smoke.py [play.html] [screenshot.png]
"""
import base64, json, os, pathlib, shutil, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
page_path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root / 'play.html').resolve()
shot = sys.argv[2] if len(sys.argv) > 2 else None
fails = []

def check(ok, what):
    print(('ok    ' if ok else 'FAIL  ') + what)
    if not ok: fails.append(what)

def native_replay(save_bytes, log_text, ticks):
    cargo = pathlib.Path.home() / '.cargo' / 'bin' / 'cargo'
    cargo = str(cargo) if cargo.exists() else 'cargo'
    env = dict(os.environ, PATH=os.pathsep.join([str(pathlib.Path(cargo).parent), os.environ.get('PATH', '')]))
    env.pop('RUSTUP_TOOLCHAIN', None)
    d = pathlib.Path(tempfile.mkdtemp(prefix='driftward-play-'))
    try:
        (d / 'save.bin').write_bytes(save_bytes)
        (d / 'inputs.txt').write_text(log_text)
        out = subprocess.run([cargo, 'run', '--release', '--quiet', '--bin', 'replay', '--', str(d / 'save.bin'), str(d / 'inputs.txt'), str(ticks)],
                             cwd=root / 'core', env=env, capture_output=True, text=True, check=True).stdout.strip()
        return out
    finally:
        shutil.rmtree(d)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': 1280, 'height': 800})
    errs = []
    pg.on('console', lambda m: m.type == 'error' and errs.append(m.text))
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(page_path.as_uri())
    pg.wait_for_function('window.__play && window.__play.probe().ready', timeout=120000)
    ev = pg.evaluate

    # flight: the same numbers as the lab's Fly tab (Halcyon fighter, from rest, clear space)
    a = ev("(() => { const P = __play; P.newGame(4242); P.advance(4, ['KeyW']); const a = P.probe(); P.advance(3, ['KeyW', 'ShiftLeft']); return [a, P.probe()]; })()")
    print('after 4 s W   ', json.dumps({k: a[0][k] for k in ('tick', 'v', 'set')}))
    print('after 3 s burn', json.dumps({k: a[1][k] for k in ('tick', 'v', 'set')}))
    check(355 < a[0]['v'] < 365, f"cruise speed {a[0]['v']:.1f} m/s (the lab gives 359.7)")
    check(a[1]['v'] > a[0]['v'] + 50, f"burner adds speed ({a[1]['v']:.1f} m/s)")

    # save, fly on, load: back to exactly the saved state
    r = ev("(() => { const P = __play; P.advance(2, ['KeyA']); P.save(); const saved = P.probe(); P.advance(5, ['KeyW', 'KeyD']); const moved = P.probe(); P.load(); return [saved, moved, P.probe()]; })()")
    check(r[1]['hash'] != r[0]['hash'], 'flying on changes the state')
    check(r[2]['hash'] == r[0]['hash'] and r[2]['tick'] == r[0]['tick'], f"load restores tick {r[0]['tick']} hash {r[0]['hash']}")

    # replay: a session recorded in the browser reruns natively to the same state
    rep = ev("""(() => { const P = __play; P.newGame(77);
      P.advance(3, ['KeyW']); P.advance(2, ['KeyW', 'ShiftLeft', 'KeyA']); P.advance(2, ['KeyF']); P.advance(3, ['KeyW', 'KeyQ']); P.advance(1, ['KeyX']);
      const r = P.exportReplay(); return { save: P.b64(r.save), log: r.log, ticks: r.ticks, hash: r.hash, tick: r.tick }; })()""")
    out = native_replay(base64.b64decode(rep['save']), rep['log'], rep['ticks'])
    print('browser', f"tick {rep['tick']} hash {rep['hash']}", '| native', out)
    check(out == f"tick {rep['tick']} hash {rep['hash']}", f"browser session ({rep['ticks']} ticks, {rep['log'].count(chr(10)) - 3} input changes) replays natively")

    # the live clock, after a warm-up: the software renderer used headless compiles each shader on its first
    # draw, which stalls a frame for up to a second (a real GPU compiles at link time)
    pg.wait_for_timeout(2000)
    t0, w0 = ev('__play.probe().tick'), time.time()
    pg.wait_for_timeout(3000)
    rate = (ev('__play.probe().tick') - t0) / (time.time() - w0)
    check(50 < rate < 64, f'live clock {rate:.1f} ticks/s')
    if shot:
        ev("__play.newGame(5)"); pg.keyboard.down('KeyW'); pg.wait_for_timeout(2500); pg.screenshot(path=shot); pg.keyboard.up('KeyW')
    check(not errs, 'no console errors' + (': ' + '; '.join(errs) if errs else ''))
    b.close()

print(f'{len(fails)} failed' if fails else 'play smoke test passed')
sys.exit(1 if fails else 0)
