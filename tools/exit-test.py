"""M1's exit test (docs/m1-progress.md): a market trade and a delivery mission both complete end to end; save, reload
and replay of the same inputs give the same result, headless.

One session in the built game page (play.html: the real M1 system, prices and traffic), its clock paused so only the
script steps it. New game from a seed, landed at the start port: accept a delivery, fill the rest of the hold with
the commodity that sells best at its destination, launch, engage the autopilot (a core command, so it replays),
save mid-flight, fly on until it stops over the port, land: the mission delivers and pays; sell the cargo at a profit.
Then the session's result must come back four ways:
  - load the mid-flight save: the same tick and state hash as when it was saved;
  - from there, the logged inputs after the save, rerun in the page, reach the session's final hash;
  - a new game from the same seed with the whole log rerun reaches it too;
  - natively (cargo run --bin replay): the session from its start, and from the mid-flight save, reach it.
Needs Playwright for Python (on the dev box: ~/.venvs/web/bin/python tools/exit-test.py) and cargo.
Usage: exit-test.py [play.html] [seed]
"""
import base64, json, os, pathlib, shutil, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
page_path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root / 'play.html').resolve()
seed = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
fails = []

def check(ok, what):
    print(('ok    ' if ok else 'FAIL  ') + what)
    if not ok: fails.append(what)

def native_replay(save_bytes, log_text, ticks):
    cargo = pathlib.Path.home() / '.cargo' / 'bin' / 'cargo'
    cargo = str(cargo) if cargo.exists() else 'cargo'
    env = dict(os.environ, PATH=os.pathsep.join([str(pathlib.Path(cargo).parent), os.environ.get('PATH', '')]))
    env.pop('RUSTUP_TOOLCHAIN', None)
    d = pathlib.Path(tempfile.mkdtemp(prefix='driftward-exit-'))
    try:
        (d / 'save.bin').write_bytes(save_bytes)
        (d / 'inputs.txt').write_text(log_text)
        return subprocess.run([cargo, 'run', '--release', '--quiet', '--bin', 'replay', '--', str(d / 'save.bin'), str(d / 'inputs.txt'), str(ticks)],
                              cwd=root / 'core', env=env, capture_output=True, text=True, check=True).stdout.strip()
    finally:
        shutil.rmtree(d)

def log_lines(log):
    return [l for l in log.splitlines() if l.strip() and not l.startswith('#')]

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': 1280, 'height': 800})
    errs = []
    pg.on('console', lambda m: m.type == 'error' and errs.append(m.text))
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(page_path.as_uri())
    pg.wait_for_function('window.__play && window.__play.probe().ready', timeout=120000)
    ev = pg.evaluate

    # the session: everything between newGame and the pause runs in one evaluate, so no frame steps the clock
    s = ev("""seed => { const P = __play, C = P.CMD, S = P.sim, out = {};
      P.newGame(seed); P.pauseGame(true);
      const here = P.probe().at, G = P.ECON.commodities.map(c => c.id);
      out.start = P.probe(); out.home = P.BODIES[here].port.name;
      // the plan: the offer whose destination pays best for something this port sells, over the hold left after its cargo
      let plan = null;
      for (const o of P.offers()) {
        const room = out.start.holdCap - o.tons;
        for (const [g, id] of G.entries()) {
          const buy = S.price(here, g), sell = S.price(o.dest, g);
          if (!buy || !sell || sell <= buy) continue;
          const tons = Math.min(room, Math.floor(out.start.credits / buy)), gain = tons * (sell - buy);
          if (tons > 0 && (!plan || gain > plan.gain)) plan = { offer: o, g, id, buy, sell, tons, gain };
        }
      }
      out.plan = plan; if (!plan) return out;
      out.dest = P.BODIES[plan.offer.dest].port.name;
      out.accept = P.accept(plan.offer.k);
      out.buy = P.command(C.buy, plan.g, plan.tons);
      out.loaded = P.probe();
      out.launch = P.command(C.launch); P.advance(3.4, []);
      out.auto = P.command(C.autopilot, plan.offer.dest);
      P.advance(10, []);
      // save mid-flight, where nothing is logged at this tick yet: the log so far is what the save already holds
      out.saved = P.probe(); out.savedLog = P.exportReplay().log; P.save();
      out.saveBytes = localStorage.getItem('driftward.save');
      let t = 10; while (P.probe().auto >= 0 && t < 600) { P.advance(1, []); t++; }
      out.flight = t; out.below = S.portBelow();
      out.land = P.command(C.land); P.advance(3.4, []);
      out.landed = P.probe(); out.mission = P.missions()[0]; // a new game's first mission takes slot 0
      out.sell = P.command(C.sell, plan.g, plan.tons);
      P.advance(1, []); // a second in port after the sale, so the replay runs past the last command
      out.end = P.probe(); out.replay = P.exportReplay(); out.replay.save = P.b64(out.replay.save);
      return out; }""", seed)
    plan = s['plan']
    check(plan is not None, f"seed {seed}: a plan at {s['home']}" + (f": {plan['tons']} t {plan['id']} at {plan['buy']} cr to sell at {plan['sell']}, with a delivery of {plan['offer']['tons']} t for {plan['offer']['pay']} cr" if plan else ' (no profitable offer: try another seed)'))
    if not plan:
        b.close(); sys.exit(1)
    o = plan['offer']
    print('session', json.dumps({k: s[k] for k in ('accept', 'buy', 'launch', 'auto', 'flight', 'below', 'land', 'sell')}))

    # the trade and the delivery, end to end
    check(s['accept'] == 0 and s['buy'] == 0 and s['loaded']['hold'].get(plan['id']) == plan['tons'] and s['loaded']['credits'] == s['start']['credits'] - plan['tons'] * plan['buy'],
          f"accepted the delivery to {s['dest']} and bought {plan['tons']} t {plan['id']} for {plan['tons'] * plan['buy']} cr")
    check(s['saved']['mode'] == 0 and s['saved']['auto'] == o['dest'], f"mid-flight on the autopilot at tick {s['saved']['tick']}: saved")
    check(s['auto'] == 0 and s['below'] == {'body': o['dest'], 'slow': True}, f"the autopilot flies to {s['dest']} in {s['flight']} s and stops clear to land")
    check(s['land'] == 0 and s['landed']['mode'] == 2 and s['landed']['at'] == o['dest'] and s['landed']['day'] == s['start']['day'] + 1, f"landed at {s['dest']} on day {s['landed']['day']}")
    check(s['mission']['state'] == 2 and s['landed']['credits'] == s['loaded']['credits'] + o['pay'], f"the delivery completed and paid {o['pay']} cr")
    check(s['sell'] == 0 and not s['end']['hold'] and s['end']['credits'] == s['landed']['credits'] + plan['tons'] * plan['sell'],
          f"sold the {plan['id']} for {plan['tons'] * plan['sell']} cr")
    gain = s['end']['credits'] - s['start']['credits']
    check(gain == plan['gain'] + o['pay'], f"the trip made {gain} cr: {plan['gain']} trading and {o['pay']} delivering")
    end = s['end']

    # reload the mid-flight save, then rerun the inputs logged after it, in the page
    before = len(log_lines(s['savedLog'])); after = log_lines(s['replay']['log'])[before:]
    r = ev("""([after, endTick]) => { const P = __play, S = P.sim, out = {};
      P.load(); out.loaded = P.probe(); P.pauseGame(true);
      const log = after.map(l => l.split(' ')); let k = 0;
      while (S.tick() < endTick) {
        while (k < log.length && +log[k][0] <= S.tick()) { const e = log[k++]; if (e[1] === 'cmd') S.command(+e[2], +e[3], +e[4]); else S.setInput(+e[1]); }
        S.step();
      }
      out.end = P.probe(); return out; }""", [after, end['tick']])
    check(r['loaded']['tick'] == s['saved']['tick'] and r['loaded']['hash'] == s['saved']['hash'], f"reloading the save restores tick {s['saved']['tick']} hash {s['saved']['hash']}")
    check(r['end']['tick'] == end['tick'] and r['end']['hash'] == end['hash'] and r['end']['credits'] == end['credits'],
          f"from the reload, the {len(after)} inputs logged after the save reach the session's end: tick {end['tick']} hash {end['hash']}")

    # the same inputs from a new game on the same seed
    a = ev("""([seed, lines, endTick]) => { const P = __play, S = P.sim;
      P.newGame(seed); P.pauseGame(true);
      const log = lines.map(l => l.split(' ')); let k = 0;
      while (S.tick() < endTick) {
        while (k < log.length && +log[k][0] <= S.tick()) { const e = log[k++]; if (e[1] === 'cmd') S.command(+e[2], +e[3], +e[4]); else S.setInput(+e[1]); }
        S.step();
      }
      return P.probe(); }""", [seed, log_lines(s['replay']['log']), end['tick']])
    check(a['hash'] == end['hash'], f"a new game on seed {seed} with the same {len(log_lines(s['replay']['log']))} logged inputs reaches the same hash")

    # natively: the whole session, and from the mid-flight save
    want = f"tick {end['tick']} hash {end['hash']}"
    full = native_replay(base64.b64decode(s['replay']['save']), s['replay']['log'], s['replay']['ticks'])
    check(full == want, f"natively, the session from its start ({s['replay']['ticks']} ticks): {full}")
    part = native_replay(base64.b64decode(s['saveBytes']), '\n'.join(after) + '\n', end['tick'] - s['saved']['tick'])
    check(part == want, f"natively, from the mid-flight save ({end['tick'] - s['saved']['tick']} ticks): {part}")
    check(not errs, 'no console errors' + (': ' + '; '.join(errs) if errs else ''))
    b.close()

print(f'{len(fails)} failed' if fails else 'M1 exit test passed')
sys.exit(1 if fails else 0)
