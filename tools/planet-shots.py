"""Render the game's planets with the flight planet shader at several zooms, into one contact sheet, for judging looks.

Each world from src/systems/m1.json is lit as in play (from the star, raised 0.45 out of the plane) and drawn:
whole, and at the game's zoom range (2800 m, 700 m and 175 m across: zoom 0.25, 1 and 4) centred on the
terminator, plus 700 m on the sunward limb (the atmosphere edge-on). Headless Chromium on SwiftShader, so slow.
Needs Playwright for Python (on the dev box: ~/.venvs/web/bin/python tools/planet-shots.py).
Usage: planet-shots.py [out.png] [body ids, comma-separated] [time s]
"""
import json, math, pathlib, sys, tempfile, base64, io
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw

root = pathlib.Path(__file__).resolve().parent.parent
src = root / 'src'
out = sys.argv[1] if len(sys.argv) > 1 else 'planets.png'
only = sys.argv[2].split(',') if len(sys.argv) > 2 and sys.argv[2] else None
T = float(sys.argv[3]) if len(sys.argv) > 3 else 40.0
W, H = 720, 450

system = json.loads((src / 'systems' / 'm1.json').read_text())
STAR_CLASS = system['star']['class']
pos = {}
for b in system['bodies']:
    a = math.radians(b['orbit']['angle']); px, py = pos.get(b.get('parent'), (0, 0))
    pos[b['id']] = (px + b['orbit']['radius'] * math.cos(a), py + b['orbit']['radius'] * math.sin(a))
SURF = {'terran': 0, 'giant': 1, 'rock': 2}
worlds = []
for b in system['bodies']:
    if b['kind'] not in ('planet', 'moon') or (only and b['id'] not in only): continue
    x, y = pos[b['id']]; l = math.hypot(x, y)
    sv = [-x / l, -y / l, 0.45]; n = math.hypot(*sv); sv = [v / n for v in sv]
    L = b['look']
    worlds.append({'id': b['id'], 'r': b['radius'], 'sun': sv, 'pal': L['palette'], 'atm': L.get('atmosphere', '#9fb4c8'),
                   'seed': L.get('seed', 1), 'kind': SURF[L['surface']], 'city': L.get('cityLights', 0), 'air': L.get('air', 0.6)})

def views(w):
    r, (lx, ly, lz) = w['r'], w['sun']; h = math.hypot(lx, ly); dx, dy = lx / h, ly / h
    z = 1 / math.sqrt(1 + (lz / h) ** 2); s = z * lz / h       # the terminator's nearest point to the disc centre
    term = (-dx * s * r, -dy * s * r)
    return [('whole', (0, 0), r * 2.5 * W / H), ('2800 m', term, 2800), ('700 m', term, 700), ('175 m', term, 175),
            ('limb 700 m', (dx * r, dy * r), 700), ('day 175 m', (dx * .45 * r, dy * .45 * r), 175)]

page = """<!doctype html><html><body style="margin:0;background:#000"><canvas id="c" width="%d" height="%d"></canvas><script>
%s
%s
%s
const canvas = document.getElementById('c'), G = makeGfx(canvas), gl = G.gl;
const FP = G.compile(PLANET_VS, PLANET_FS);
G.buildTargets();
window.shot = (w, cam, scale, t) => {
  const RW = canvas.width, RH = canvas.height, star = STARS[%s];
  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, G.targets.scene.f); gl.viewport(0, 0, RW, RH);
  gl.disable(gl.BLEND); gl.clearColor(0.0006, 0.0008, 0.0014, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(FP.p); const u = FP.u;
  gl.uniform2f(u.uRes, RW, RH); gl.uniform2f(u.uCam, cam[0], cam[1]); gl.uniform1f(u.uScale, scale);
  gl.uniform3fv(u.uSunCol, lin(star.col)); gl.uniform3fv(u.uAmb, star.amb); gl.uniform1f(u.uTime, t);
  gl.uniform3fv(u.uSun, w.sun); gl.uniform2f(u.uC, 0, 0); gl.uniform1f(u.uR, w.r); gl.uniform1f(u.uPx, 1 / (w.r * scale));
  gl.uniform3fv(u.uC1, hexRGB(w.pal[0])); gl.uniform3fv(u.uC2, hexRGB(w.pal[1])); gl.uniform3fv(u.uC3, hexRGB(w.pal[2]));
  gl.uniform3fv(u.uAtm, lin(hexRGB(w.atm)));
  gl.uniform1f(u.uSeed, w.seed); gl.uniform1i(u.uKind, w.kind); gl.uniform1f(u.uCity, w.city); gl.uniform1f(u.uAir, w.air);
  G.draw();
  gl.disable(gl.BLEND);
  G.postProcess(1, 0);
  gl.finish();
  return canvas.toDataURL('image/png');
};
</script></body></html>""" % (W, H, (src / 'look.js').read_text(), (src / 'shaders.js').read_text(), (src / 'gfx.js').read_text(),
                               json.dumps(STAR_CLASS if STAR_CLASS in ('sol', 'red', 'blue', 'orange', 'white') else 'sol'))

with tempfile.TemporaryDirectory() as d, sync_playwright() as p:
    f = pathlib.Path(d) / 'planets.html'; f.write_text(page)
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': W, 'height': H})
    errs = []
    pg.on('console', lambda m: m.type == 'error' and errs.append(m.text))
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f.as_uri())
    pg.wait_for_load_state('load')
    if errs or not pg.evaluate('!!window.shot'): sys.exit('page failed: ' + '\n'.join(errs))
    V = views(worlds[0])
    sheet = Image.new('RGB', (W * len(V), H * len(worlds)), (0, 0, 0))
    for row, w in enumerate(worlds):
        for col, (label, cam, width) in enumerate(views(w)):
            url = pg.evaluate('([w, cam, scale, t]) => shot(w, cam, scale, t)', [w, list(cam), W / width, T])
            im = Image.open(io.BytesIO(base64.b64decode(url.split(',')[1]))).convert('RGB')
            ImageDraw.Draw(im).text((8, 6), f"{w['id']} · {label}", fill=(220, 220, 220))
            sheet.paste(im, (col * W, row * H))
            print(w['id'], label, flush=True)
    if errs: sys.exit('\n'.join(errs))
    b.close()
sheet.save(out)
print('wrote', out)
