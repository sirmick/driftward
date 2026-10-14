"""Drive the built game page (play.html) in headless Chromium and check the session machinery end to end.

Checks: the page starts on the sim core, landed at the system's start port, with no console errors; the market
buys and sells through the core (panel and commands), within credits and hold space; assist flight in open space
matches the lab's numbers; launch, landing and a day passing (with its docking fee) work; save then load restores
the exact state; a replay exported from the browser (snapshot + input log, trades included) reruns natively to the
same state hash; the live clock ticks at 60 Hz.
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
    start = ev('__play.probe()')
    check(start['mode'] == 2 and start['day'] == 1 and pg.is_visible('#port'), f"starts landed on day 1 at {pg.inner_text('#port-name')}")
    SPACE = '{ space: [0, -8000] }'  # open space: outside every well

    # the market at the start port: the panel lists what it trades; buying and selling go through the core
    econ = ev('__play.ECON')
    check(start['credits'] == econ['start']['credits'] and start['debt'] == econ['start']['debt'] and start['holdCap'] > 0,
          f"starts with {start['credits']} cr, owing {start['debt']}, hold {start['holdCap']} t")
    pg.click('#svc-trade')
    rows = pg.locator('#trade-rows tr').count()
    check(pg.is_visible('#trade') and rows > 0, f'the market panel lists {rows} commodities')
    goods = ev("__play.price('goods')")
    pg.locator('#trade-rows button[data-act="buy"][data-g="%d"]' % ev("__play.good('goods')")).click()
    m = ev('__play.probe()')
    check(m['credits'] == start['credits'] - goods and m['hold'].get('goods') == 1, f"buying a ton of goods at {goods} cr from the panel")
    pg.locator('#trade-rows button[data-act="buy"][data-g="%d"]' % ev("__play.good('goods')")).click(modifiers=['Shift'])
    m = ev('__play.probe()')
    check(m['hold'].get('goods') == min(m['holdCap'], start['credits'] // goods), f"shift-click buys all that fits ({m['hold'].get('goods')} t, {m['credits']} cr left)")
    t = ev("(() => { const P = __play, C = P.CMD, g = P.good('goods'); return { full: P.command(C.buy, g, 1), notHere: P.command(C.buy, P.good('ore'), 1), tooMany: P.command(C.sell, g, 99), sell: P.trade('sell', g), after: P.probe() }; })()")
    check(t['full'] == 6 and t['notHere'] == 7 and t['tooMany'] == 8, f"the core refuses a full hold, an untraded good, cargo not aboard ({t['full']}, {t['notHere']}, {t['tooMany']})")
    check(t['sell'] == 0 and t['after']['credits'] == start['credits'] and not t['after']['hold'], 'selling it all back restores the credits (fixed prices)')
    pg.keyboard.press('Escape')
    check(not pg.is_visible('#trade'), 'Escape closes the market')

    # flight: the same numbers as the lab's Fly tab (Halcyon fighter, from rest, clear space)
    a = ev("(() => { const P = __play; P.newGame(4242, " + SPACE + "); P.advance(4, ['KeyW']); const a = P.probe(); P.advance(3, ['KeyW', 'ShiftLeft']); return [a, P.probe()]; })()")
    print('after 4 s W   ', json.dumps({k: a[0][k] for k in ('tick', 'v', 'set')}))
    print('after 3 s burn', json.dumps({k: a[1][k] for k in ('tick', 'v', 'set')}))
    check(355 < a[0]['v'] < 365, f"cruise speed {a[0]['v']:.1f} m/s (the lab gives 359.7)")
    check(a[1]['v'] > a[0]['v'] + 50, f"burner adds speed ({a[1]['v']:.1f} m/s)")

    # save, fly on, load: back to exactly the saved state
    r = ev("(() => { const P = __play; P.advance(2, ['KeyA']); P.save(); const saved = P.probe(); P.advance(5, ['KeyW', 'KeyD']); const moved = P.probe(); P.load(); return [saved, moved, P.probe()]; })()")
    check(r[1]['hash'] != r[0]['hash'], 'flying on changes the state')
    check(r[2]['hash'] == r[0]['hash'] and r[2]['tick'] == r[0]['tick'], f"load restores tick {r[0]['tick']} hash {r[0]['hash']}")

    # replay: a session recorded in the browser reruns natively to the same state
    # a port visit: start landed, launch, land again at once (launch leaves you over the port, slow), wait a day
    v = ev("""(() => { const P = __play, C = P.CMD, out = {}; P.newGame(77);
      out.buy = P.command(C.buy, P.good('goods'), 3); out.credits0 = P.probe().credits;
      out.launch = P.command(C.launch); P.advance(2.2, []); out.flying = P.probe().mode;
      P.advance(1, ['KeyW']); P.advance(3, ['KeyS']); P.advance(2, []);
      out.land = P.command(C.land); P.advance(3, []); const a = P.probe(); out.landed = a.mode; out.day = a.day;
      out.sell = P.command(C.sell, P.good('goods'), 2); out.repay = P.command(C.repay, 500);
      const b = P.probe(); out.wait = P.command(C.wait); const c = P.probe(); out.day2 = c.day; out.fee = b.credits - c.credits; out.hold = c.hold;
      out.launch2 = P.command(C.launch); P.advance(0.3, []); out.skip = P.command(C.skip); P.advance(0.1, []); out.flying2 = P.probe().mode;
      return out; })()""")
    print('port visit', json.dumps(v))
    check(v['launch'] == 0 and v['flying'] == 0, 'launch hands back control')
    check(v['land'] == 0 and v['landed'] == 2 and v['day'] == 2, 'landing takes a day')
    check(v['wait'] == 0 and v['day2'] == 3 and v['fee'] == ev("__play.sim.param('dock_fee')"), f"waiting in port takes a day and a {v['fee']} cr docking fee")
    check(v['buy'] == 0 and v['sell'] == 0 and v['repay'] == 0 and v['hold'] == {'goods': 1}, 'trades and a repayment in the recorded session')
    check(v['skip'] == 0 and v['flying2'] == 0, 'the launch sequence can be skipped')
    rep = ev("""(() => { const P = __play, r = P.exportReplay(); return { save: P.b64(r.save), log: r.log, ticks: r.ticks, hash: r.hash, tick: r.tick }; })()""")
    out = native_replay(base64.b64decode(rep['save']), rep['log'], rep['ticks'])
    print('browser', f"tick {rep['tick']} hash {rep['hash']}", '| native', out)
    check(out == f"tick {rep['tick']} hash {rep['hash']}", f"browser session ({rep['ticks']} ticks, {rep['log'].count(' cmd ')} commands, {rep['log'].count(chr(10)) - 3} log lines) replays natively")

    # the live clock, after a warm-up: the software renderer used headless compiles each shader on its first
    # draw, which stalls a frame for up to a second (a real GPU compiles at link time)
    # (in open space: under the software renderer a planet filling the view drops below 7.5 fps, where the clock's
    # 8-ticks-a-frame cap deliberately slows the sim rather than spiral)
    ev('__play.newGame(5, ' + SPACE + ')')
    pg.wait_for_timeout(2000)
    t0, w0 = ev('__play.probe().tick'), time.time()
    pg.wait_for_timeout(3000)
    rate = (ev('__play.probe().tick') - t0) / (time.time() - w0)
    check(50 < rate < 64, f'live clock {rate:.1f} ticks/s')
    if shot:
        ev("__play.newGame(5, { space: [0, -8000] })"); pg.keyboard.down('KeyW'); pg.wait_for_timeout(2500); pg.screenshot(path=shot); pg.keyboard.up('KeyW')
    check(not errs, 'no console errors' + (': ' + '; '.join(errs) if errs else ''))
    b.close()

print(f'{len(fails)} failed' if fails else 'play smoke test passed')
sys.exit(1 if fails else 0)
