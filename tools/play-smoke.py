"""Drive the built game page (play.html) in headless Chromium and check the session machinery end to end.

Checks: the page starts on the sim core at the title, and a new game from a seed starts landed at the system's start
port, with no console errors; pause stops the clock; Continue on the title restores the last landing; the market
buys and sells through the core (panel and commands), within credits and hold space; the mission board offers
deliveries, and one accepted, flown there by the autopilot and landed pays; the flight HUD's keys (locations,
targets, the map) work; ambient traffic starts mid-flow and turns
over (ships land and new ones launch); assist flight in open space
matches the lab's numbers; asteroid belts are listed in orbital order and the autopilot flies into one; launch, landing and a day passing (with its docking fee) work; save then load restores
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
    t = ev('__play.probe()')
    check(t['shell'] == 'title' and pg.is_visible('#title') and pg.is_disabled('#t-continue'), 'starts on the title (nothing to continue yet)')
    pg.fill('#t-seed', '1'); pg.click('#t-new')
    # the port screen fills in on the next frame, however long the first frames take (the start bakes)
    pg.wait_for_function("__play.probe().mode === 2 && !document.getElementById('port').hidden && document.getElementById('port-name').textContent", timeout=60000)
    start = ev('__play.probe()')
    traffic0 = ev('__play.traffic()')
    econ0 = ev('__play.ECON')  # traffic as the game starts (checked below; the clock runs meanwhile)
    check(start['shell'] is None and start['seed'] == 1, 'New game with seed 1')
    check(start['mode'] == 2 and start['day'] == 1 and pg.is_visible('#port'), f"starts landed on day 1 at {pg.inner_text('#port-name')}")
    SPACE = '{ space: [0, -8000] }'  # open space: outside every well

    # the port's lore and art (src/lore, art/ beside the page): the description, the bar's people with their
    # portraits and rumors, the about page's places, and the painted vista over the procedural one
    lore_file = pathlib.Path(__file__).resolve().parent.parent / 'src' / 'lore' / 'brannock.json'
    if lore_file.exists():
        lore = json.loads(lore_file.read_text()); L = next(p for p in lore['ports'] if p['body'] == 'halde')
        check(pg.inner_text('#port-desc') == L['description'][0], 'the port card shows the lore\'s description')
        pg.keyboard.press('KeyB'); pg.wait_for_timeout(300)
        loaded = ev("[...document.querySelectorAll('#bar-people img')].filter(i => i.complete && i.naturalWidth > 0).length")
        check(pg.is_visible('#bar') and pg.locator('#bar .person').count() == len(L['people']) and pg.locator('#bar-rumors li').count() == len(L['rumors']),
              f"B opens the bar: {', '.join(q['name'] for q in L['people'])}, {len(L['rumors'])} rumors, {loaded} portraits loaded")
        pg.keyboard.press('KeyI'); pg.wait_for_timeout(100)
        check(pg.is_visible('#about') and not pg.is_visible('#bar') and pg.locator('#about-places li').count() == len(L['places']), f"I opens the about page with {len(L['places'])} places")
        pg.keyboard.press('Escape')
        check(not pg.is_visible('#about'), 'Escape closes it')
        # the debug screen: backquote opens it over the game with the clock stopped; its Content tab has every
        # section, the lore prompt and a card per image; Esc closes it
        t0 = ev('__play.probe().tick')
        pg.keyboard.press('Backquote'); pg.wait_for_timeout(600)
        d = ev("({ open: !document.getElementById('debug').hidden, sections: [...document.querySelectorAll('.dbg-body section')].map(s => s.id), ports: document.querySelectorAll('.dbg-port').length, images: document.querySelectorAll('.dbg-port img').length, prompt: document.querySelectorAll('#dbg-pipeline details[open] .dbg-text').length, tick: __play.probe().tick })")
        check(d['open'] and d['sections'] == ['dbg-pipeline', 'dbg-ports', 'dbg-raw'] and d['prompt'] == 2 and d['ports'] == len(lore['ports'])
              and d['images'] == len(list((lore_file.parent.parent.parent / 'art' / 'brannock').glob('*.webp'))) and d['tick'] == t0,
              f"` opens the debug screen with the clock stopped: the pipeline with the lore prompt, {d['ports']} port cards with {d['images']} images, the raw files")
        pg.click('.dbg-tabs button[data-tab="player"]'); pg.wait_for_timeout(200)
        pl = ev("({ sections: document.querySelectorAll('.dbg-body section').length, ship: document.querySelector('#dbg-ship').innerText, rows: document.querySelectorAll('#dbg-hold tbody tr').length })")
        check(pl['sections'] == 6 and 'Copperhaul' in pl['ship'] and pl['rows'] == len(econ0['commodities']), f"its Player tab shows the ship, flight, money, the hold priced at every port, missions and the session")
        pg.keyboard.press('Escape'); pg.wait_for_timeout(100)
        check(not pg.is_visible('#debug'), 'Escape closes it')
        if (lore_file.parent.parent.parent / 'art' / 'brannock' / 'vista-halde.webp').exists():
            pg.wait_for_function("document.getElementById('vista').classList.contains('on')", timeout=5000)
            check(True, 'the painted vista shows')

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
    # sell the goods back, fill the hold with water (cheap enough to fill any hold), then the core refuses more
    t = ev("(() => { const P = __play, C = P.CMD, g = P.good('goods'), w = P.good('water'); const back = P.trade('sell', g), fill = P.trade('buy', w); return { back, fill, full: P.command(C.buy, w, 1), notHere: P.command(C.buy, P.good('ore'), 1), tooMany: P.command(C.sell, g, 99), sell: P.trade('sell', w), after: P.probe() }; })()")
    check(t['full'] == 6 and t['notHere'] == 7 and t['tooMany'] == 8, f"the core refuses a full hold, an untraded good, cargo not aboard ({t['full']}, {t['notHere']}, {t['tooMany']})")
    check(t['sell'] == 0 and t['after']['credits'] == start['credits'] and not t['after']['hold'], 'selling it all back restores the credits (fixed prices)')
    pg.keyboard.press('Escape')
    check(not pg.is_visible('#trade'), 'Escape closes the market')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
    t0 = ev('__play.probe().tick'); pg.wait_for_timeout(1000)
    check(pg.is_visible('#pause') and ev('__play.probe().tick') == t0, 'Escape again pauses, and the clock stops')
    pg.keyboard.press('KeyP'); pg.wait_for_timeout(500)
    check(not pg.is_visible('#pause') and ev('__play.probe().tick') > t0, 'P resumes')

    # ambient traffic: mid-flow from the start, Rustline hulls, and turning over (two minutes of sim time)
    t0 = ev('__play.traffic()')
    cap = ev("__play.sim.param('traffic_cap')")
    check(3 <= len(traffic0) <= cap and all(t['phase'] == 2 for t in traffic0), f'{len(traffic0)} ships in flight at the start, all cruising')
    tr = ev("""(() => { const P = __play, ids = new Set(P.traffic().map(t => P.sim.handle(t.i))), roles = new Set(), seen = [];
      for (let k = 0; k < 24; k++) { P.advance(5, []); const t = P.traffic(); seen.push(t.length); t.forEach(x => roles.add(x.role)); }
      const left = [...ids].filter(h => P.sim.resolve(h) >= 0).length;
      return { seen, roles: [...roles], left, phases: P.traffic().map(t => t.phase) }; })()""")
    print('traffic counts every 5 s', tr['seen'], 'roles', tr['roles'])
    check(min(tr['seen']) >= 10 and max(tr['seen']) <= cap and sorted(tr['roles']) == ['arrive', 'depart', 'environ', 'local', 'loiter'], f"traffic stays between {min(tr['seen'])} and {max(tr['seen'])} ships: local, arriving, departing, loitering and environmental")
    check(tr['left'] < len(t0), f"ships land and are forgotten ({len(t0) - tr['left']} of the first {len(t0)} landed in two minutes)")

    # the mission board at the start port
    pg.click('#svc-board')
    offers = ev('__play.offers()')
    check(pg.is_visible('#board') and 3 <= len(offers) <= 8 and pg.locator('#board-rows button[data-act="accept"]').count() == len(offers),
          f'the board shows {len(offers)} offers')
    small = min(offers, key=lambda o: o['tons'])
    pg.locator(f'#board-rows button[data-k="{small["k"]}"]').click()
    m = ev('__play.missions()')[0]
    check(m['state'] == 1 and m['dest'] == small['dest'] and m['due'] == 1 + small['days'] and ev('__play.probe()')['holdCap'] > 0
          and pg.locator('#mission-rows button[data-act="abandon"]').count() == 1, f"accepting from the board: {small['tons']} t to body {small['dest']} for {small['pay']} cr")
    pg.locator('#mission-rows button[data-act="abandon"]').click()
    check(ev('__play.missions()')[0]['state'] == 0, 'abandoning it')
    pg.keyboard.press('Escape')

    # the flight HUD: launch, then the location list, number keys, T for ships, G for the autopilot, M for the map
    ev("(() => { const P = __play; P.newGame(31); P.command(P.CMD.launch); P.command(P.CMD.skip); P.advance(0.3, []); })()")
    pg.wait_for_timeout(600)  # the list refreshes with the frames
    h = ev('__play.locations()')
    rows = pg.locator('#loc button').count()
    check(rows == len(h) and rows >= 5 and pg.is_visible('#loc'), f'the location list shows {rows} rows: ' + ', '.join(r['name'] for r in h))
    pg.keyboard.press('Digit2'); pg.wait_for_timeout(100)
    check(ev('__play.target()') == {'body': h[1]['j']}, f"2 targets {h[1]['name']}")
    pg.keyboard.press('KeyT'); pg.wait_for_timeout(100)
    tgt = ev('__play.target()')
    check(tgt is not None and tgt.get('ship', -1) > 0, 'T targets the nearest ship')
    pg.keyboard.press('Digit2'); pg.keyboard.press('KeyG'); pg.wait_for_timeout(100)
    check(ev('__play.probe().auto') == h[1]['j'], 'G engages the autopilot to the target body')
    pg.keyboard.press('KeyM')
    try: pg.wait_for_function("!document.getElementById('map').hidden && document.getElementById('loc').hidden", timeout=5000) # the HUD hides the list next frame
    except Exception: pass
    check(pg.is_visible('#map') and not pg.is_visible('#loc'), 'M opens the system map')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(100)
    check(not pg.is_visible('#map'), 'Escape closes it')

    # asteroid belts and fields: in the location list in orbital order, and the autopilot flies into a belt (to the
    # nearest point of its ring, straight through anything rocky in the way) and stops there
    if ev("__play.BODIES.some(b => b.id === 'scree')"):
        bt = ev("""(() => { const P = __play, C = P.CMD; P.newGame(12, { space: [-17000, -1000] }); P.advance(0.2, []);
          const j = P.BODIES.findIndex(b => b.id === 'scree'), B = P.BODIES[j], q0 = P.probe();
          const auto = P.command(C.autopilot, j); let t = 0; while (P.probe().auto >= 0 && t < 300) { P.advance(1, []); t++; }
          const q = P.probe(), d = Math.hypot(q.x - B.x, q.y - B.y);
          return { names: P.locations().map(r => r.name), auto, t, off: Math.abs(d - B.r), half: B.belt.width / 2, v: q.v, rocks: P.rocks() }; })()""")
        n = bt['names']
        check('The Scree' in n and n.index('Halde') < n.index('The Scree') < n.index('Vast'), f"the belt is in the location list in orbital order: {', '.join(n)}")
        check(bt['auto'] == 0 and bt['t'] < 300 and bt['off'] < bt['half'] and bt['v'] < 30, f"the autopilot flies into the belt in {bt['t']} s and stops {bt['off']:.0f} m from its middle")
        check(bt['rocks'] > 1000, f"the belts and fields hold {bt['rocks']} rocks")

    # the debug jump: the debug screen's box completes place@system and jumps there (a logged core command); a session
    # that jumps between systems replays natively, and a save made after a jump loads back into that system
    if len(ev('__play.systems()')) > 1:
        ev("(() => { const P = __play, C = P.CMD; P.newGame(21); P.command(C.launch); P.command(C.skip); P.advance(0.5, []); })()")
        pg.keyboard.press('Backquote'); pg.wait_for_timeout(300)
        pg.keyboard.type('rime@ost'); pg.wait_for_timeout(150)
        first = ev("(document.querySelector('.dbg-jump-list button') || {}).innerText || ''").replace('\n', ' ')
        pg.keyboard.press('Enter'); pg.wait_for_timeout(300)
        j = ev("(() => { const P = __play; return { sys: P.systems()[P.system()], at: P.BODIES[P.probe().at].name, mode: P.probe().mode, debug: !document.getElementById('debug').hidden }; })()")
        check(first.startswith('Rime') and j == {'sys': 'ostry', 'at': 'Rime', 'mode': 0, 'debug': False}, f"the jump box completes rime@ost to {first!r} and jumps there: {j}")
        js = ev("""(() => { const P = __play, C = P.CMD, s = P.systems(), cal = s.indexOf('calder'), B = P.places().find(p => p.k === cal && p.id === 'station');
          P.advance(2, ['KeyW']); const r = P.jump(cal, B.j); P.advance(3, ['KeyW', 'KeyA']); P.save(); const saved = P.probe(); P.jump(0, 1); P.load();
          const back = P.probe(); P.advance(2, []); const rep = P.exportReplay();
          return { r, saved: saved.hash, back: back.hash, sys: s[P.system()], replay: { save: P.b64(rep.save), log: rep.log, ticks: rep.ticks, tick: rep.tick, hash: rep.hash } }; })()""")
        check(js['r'] == 0 and js['back'] == js['saved'] and js['sys'] == 'calder', f"a save after a jump loads back into {js['sys']} with the same hash")
        jr = ev("""(() => { const P = __play, s = P.systems(); P.newGame(22); P.command(P.CMD.launch); P.command(P.CMD.skip); P.advance(1, ['KeyW']);
          P.jump(s.indexOf('merrow'), 1); P.advance(4, ['KeyW', 'KeyD']); P.jump(s.indexOf('quire'), 2); P.advance(3, ['KeyW']);
          const r = P.exportReplay(); return { save: P.b64(r.save), log: r.log, ticks: r.ticks, tick: r.tick, hash: r.hash }; })()""")
        out = native_replay(base64.b64decode(jr['save']), jr['log'], jr['ticks'])
        check(out == f"tick {jr['tick']} hash {jr['hash']}", f"a session through three systems (two jumps) replays natively: {out}")
        pg.keyboard.press('Escape')

    # flight: the same numbers as the lab's Fly tab (the Prism military class I, the M0 Halcyon fighter, from rest, clear space,
    # far from every well: a well raises the top speed heading into it)
    a = ev("(() => { const P = __play; P.newGame(4242, { space: [0, -30000], ship: 'prism.military:c1' }); P.advance(4, ['KeyW']); const a = P.probe(); P.advance(3, ['KeyW', 'ShiftLeft']); return [a, P.probe(), P.sim.type.vmax[P.sim.ship.kind[0]]]; })()")
    print('after 4 s W   ', json.dumps({k: a[0][k] for k in ('tick', 'v', 'set')}))
    print('after 3 s burn', json.dumps({k: a[1][k] for k in ('tick', 'v', 'set')}))
    check(486 < a[0]['v'] < 496, f"cruise speed {a[0]['v']:.1f} m/s (the lab gives 491.1)")
    check(a[1]['v'] > a[0]['v'] + 50 and a[1]['set'] <= a[2] + 1e-6 and a[1]['v'] <= a[2] + 1, f"the burner adds thrust, not top speed ({a[1]['v']:.1f} m/s, set {a[1]['set']:.0f}, top speed {a[2]:.0f})")

    # save, fly on, load: back to exactly the saved state
    r = ev("(() => { const P = __play; P.advance(2, ['KeyA']); P.save(); const saved = P.probe(); P.advance(5, ['KeyW', 'KeyD']); const moved = P.probe(); P.load(); return [saved, moved, P.probe()]; })()")
    check(r[1]['hash'] != r[0]['hash'], 'flying on changes the state')
    check(r[2]['hash'] == r[0]['hash'] and r[2]['tick'] == r[0]['tick'], f"load restores tick {r[0]['tick']} hash {r[0]['hash']}")

    # replay: a session recorded in the browser reruns natively to the same state
    # a port visit: start landed, launch (it hands back control moving fast round the planet), brake, back to the port
    # on the autopilot and land again, wait a day
    v = ev("""(() => { const P = __play, C = P.CMD, out = {}; P.newGame(77);
      out.buy = P.command(C.buy, P.good('goods'), 3); out.credits0 = P.probe().credits; out.vmax = P.sim.type.vmax[P.sim.ship.kind[0]];
      out.launch = P.command(C.launch); P.advance(3.4, []); const f = P.probe(); out.flying = f.mode; out.launchV = Math.round(f.v);
      P.advance(3, ['KeyS']);
      P.command(C.autopilot, f.at); let t = 0; while (P.probe().auto >= 0 && t < 120) { P.advance(1, []); t++; }
      out.land = P.command(C.land); P.advance(3.4, []); const a = P.probe(); out.landed = a.mode; out.day = a.day;
      out.sell = P.command(C.sell, P.good('goods'), 2); out.repay = P.command(C.repay, 500);
      const b = P.probe(); out.wait = P.command(C.wait); const c = P.probe(); out.day2 = c.day; out.fee = b.credits - c.credits; out.hold = c.hold;
      out.launch2 = P.command(C.launch); P.advance(0.3, []); out.skip = P.command(C.skip); P.advance(0.1, []); out.flying2 = P.probe().mode;
      return out; })()""")
    # a delivery: back at the start port (teleport, a logged dev command) take the smallest offer, launch, and let the
    # autopilot fly there (round the star if it is in the way) until it stops over the port; land: delivered, paid
    d = ev("""(() => { const P = __play, C = P.CMD, out = {};
      out.teleHome = P.teleport(P.probe().at); P.advance(0.5, []); out.landHome = P.command(C.land); P.advance(3.4, []);
      const o = P.offers().sort((a, b) => a.tons - b.tons)[0]; out.offer = o;
      out.accept = P.accept(o.k); out.before = P.probe(); out.launch = P.command(C.launch); P.advance(3.4, []);
      out.auto = P.command(C.autopilot, o.dest); let t = 0;
      while (P.probe().auto >= 0 && t < 600) { P.advance(1, []); t++; }
      out.flight = t; out.below = P.sim.portBelow(); out.land = P.command(C.land); P.advance(3.4, []);
      out.after = P.probe(); out.mission = P.missions()[0]; return out; })()""")
    print('delivery', json.dumps({k: d[k] for k in ('offer', 'accept', 'auto', 'flight', 'below', 'land')}))
    check(d['auto'] == 0 and d['flight'] < 600 and d['below'] == {'body': d['offer']['dest'], 'slow': True}, f"the autopilot flies there in {d['flight']} s and stops clear to land")
    check(d['accept'] == 0 and d['land'] == 0 and d['after']['at'] == d['offer']['dest'] and d['mission']['state'] == 2,
          f"a delivery to body {d['offer']['dest']} completes on landing")
    check(d['after']['credits'] == d['before']['credits'] + d['offer']['pay'] and d['after']['hold'] == d['before']['hold'],
          f"and pays {d['offer']['pay']} cr, freeing the hold")
    print('port visit', json.dumps(v))
    check(v['launch'] == 0 and v['flying'] == 0 and 1.2 * v['vmax'] < v['launchV'] < 1.6 * v['vmax'], f"launch hands back control at the speed it arrived at ({v['launchV']} m/s, 1.4 times the ship's {v['vmax']:.0f} m/s top speed)")
    check(v['land'] == 0 and v['landed'] == 2 and v['day'] == 2, 'landing takes a day')
    check(v['wait'] == 0 and v['day2'] == 3 and v['fee'] == ev("__play.sim.param('dock_fee')"), f"waiting in port takes a day and a {v['fee']} cr docking fee")
    check(v['buy'] == 0 and v['sell'] == 0 and v['repay'] == 0 and v['hold'] == {'goods': 1}, 'trades and a repayment in the recorded session')
    check(v['skip'] == 0 and v['flying2'] == 0, 'the launch sequence can be skipped')
    rep = ev("""(() => { const P = __play, r = P.exportReplay(); return { save: P.b64(r.save), log: r.log, ticks: r.ticks, hash: r.hash, tick: r.tick }; })()""")
    out = native_replay(base64.b64decode(rep['save']), rep['log'], rep['ticks'])
    print('browser', f"tick {rep['tick']} hash {rep['hash']}", '| native', out)
    check(out == f"tick {rep['tick']} hash {rep['hash']}", f"browser session ({rep['ticks']} ticks, {rep['log'].count(' cmd ')} commands, {rep['log'].count(chr(10)) - 3} log lines) replays natively")

    # the live clock, after a warm-up: the software renderer used headless compiles each shader on its first
    # draw, which stalls a frame for up to a second (a real GPU compiles at link time), and uploads the traffic hulls'
    # baked textures slowly
    # (in open space: under the software renderer a planet filling the view drops below 7.5 fps, where the clock's
    # 8-ticks-a-frame cap deliberately slows the sim rather than spiral)
    ev('__play.newGame(5, ' + SPACE + ')')
    pg.wait_for_timeout(5000)
    t0, w0 = ev('__play.probe().tick'), time.time()
    pg.wait_for_timeout(3000)
    rate = (ev('__play.probe().tick') - t0) / (time.time() - w0)
    check(50 < rate < 64, f'live clock {rate:.1f} ticks/s')
    if shot:
        ev("__play.newGame(5, { space: [0, -8000] })"); pg.keyboard.down('KeyW'); pg.wait_for_timeout(2500); pg.screenshot(path=shot); pg.keyboard.up('KeyW')
    # the title's Continue: the last landing's autosave, as its note says. A landing the page's frames see (the
    # scripted steps above start and end landed, so no frame saw them fly): launch, a frame or two, land
    ev("""(() => { const P = __play, C = P.CMD; P.newGame(9); P.command(C.buy, P.good('goods'), 2); P.command(C.launch); P.command(C.skip); P.advance(0.2, []);
      P.command(C.autopilot, P.probe().at); let t = 0; while (P.probe().auto >= 0 && t < 120) { P.advance(1, []); t++; } })()""")
    ev("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")  # a frame has seen it flying, however slow frames are
    ev("(() => { const P = __play, C = P.CMD; P.command(C.land); P.command(C.skip); P.advance(0.1, []); })()")
    # and landed: the autosave (a new game saves too, on day 1 at its start port, so wait for this landing's, day 2)
    pg.wait_for_function("(JSON.parse(localStorage.getItem('driftward.autosave.meta') || 'null') || {}).day === 2", timeout=60000)
    meta = json.loads(ev("localStorage.getItem('driftward.autosave.meta')") or 'null')
    check(meta is not None and meta['day'] == 2 and meta['port'] == 'Halde Landing', f'landing autosaves: {meta}')
    ev('__play.showTitle()'); pg.wait_for_timeout(200)
    check(pg.is_enabled('#t-continue') and f"day {meta['day']}" in pg.inner_text('#t-continue'), f"the title offers to continue: {pg.inner_text('#t-continue-sub')}")
    pg.click('#t-continue'); pg.wait_for_timeout(300)
    c = ev('__play.probe()')
    check(c['shell'] is None and c['mode'] == 2 and c['day'] == meta['day'] and c['credits'] == meta['credits'], f"Continue lands you back on day {c['day']} with {c['credits']} cr")
    check(not errs, 'no console errors' + (': ' + '; '.join(errs) if errs else ''))
    b.close()

print(f'{len(fails)} failed' if fails else 'play smoke test passed')
sys.exit(1 if fails else 0)
