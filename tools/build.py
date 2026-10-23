"""Assemble src/ into self-contained pages, index.html (the lab) and play.html (the game), with the Rust sim core
compiled to WASM and inlined into both, and map.html (the star map). On the way it remakes the universe index
(src/galaxy/universe.json, tools/universe.py).

The game's content reaches the pages as data files (src/data.js; docs/data.md): the universe index, each system's
file, lore and art manifest, how its content was made, the real stars, the setting and the stories' log. A
self-contained build (the default, into the repository root) carries every file inline, each in its own script tag,
so the pages open from disk. A hosted build (--hosted, into dist/ or DIR) writes them to data/ beside the pages,
which fetch each one when they need it, with art/ copied alongside: serve that directory.

Usage: python3 tools/build.py [--skip-core] [--hosted [DIR]]   (--skip-core reuses the last compiled WASM)
"""
import base64, json, os, pathlib, shutil, subprocess, sys
root = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / 'tools'))
import universe
src = root / 'src'
core = root / 'core'
wasm = core / 'target' / 'wasm32-unknown-unknown' / 'release' / 'driftward_core.wasm'

def find_cargo():
    # Prefer rustup's cargo: a distro cargo found first on PATH (e.g. Debian's /usr/bin/cargo in a non-login
    # shell that never sourced ~/.cargo/env) has no wasm32 standard library.
    rustup = pathlib.Path.home() / '.cargo' / 'bin' / 'cargo'
    return str(rustup) if rustup.exists() else shutil.which('cargo')

def cargo_env(cargo):
    # cargo runs whichever rustc comes first on PATH, so with /usr/bin ahead of ~/.cargo/bin it would pick the
    # distro rustc even when rustup's cargo is running: put the chosen cargo's directory first.
    env = dict(os.environ)
    env['PATH'] = os.pathsep.join([str(pathlib.Path(cargo).parent), env.get('PATH', '')])
    # core/rust-toolchain.toml pins the toolchain; a RUSTUP_TOOLCHAIN left in the shell (say, from a project
    # pinned to a toolchain without the WASM target) would override it, so the build ignores it
    if env.pop('RUSTUP_TOOLCHAIN', None):
        print(f"build: ignoring RUSTUP_TOOLCHAIN={os.environ['RUSTUP_TOOLCHAIN']}; core/rust-toolchain.toml pins the toolchain")
    return env

if '--skip-core' not in sys.argv:
    cargo = find_cargo()
    if not cargo:
        sys.exit('build: cargo not found; install Rust with rustup, then `rustup target add wasm32-unknown-unknown`')
    env = cargo_env(cargo)
    r = subprocess.run([cargo, 'build', '--release', '--target', 'wasm32-unknown-unknown', '--quiet'], cwd=core, capture_output=True, text=True, env=env)
    if r.returncode:
        sys.stderr.write(r.stderr)
        hint = ' (missing the WASM target: `rustup target add wasm32-unknown-unknown`)' if 'E0463' in r.stderr else ''
        sys.exit(f'build: core failed to compile with {cargo}{hint}')
if not wasm.exists():
    sys.exit(f'build: {wasm} missing; run without --skip-core')
core_b64 = base64.b64encode(wasm.read_bytes()).decode()

catalog = json.dumps(json.loads((src / 'catalog.json').read_text()), indent=1)
assert '</script' not in catalog
gen = (src / 'gen.js').read_text()

# Script modules, inlined at their /*MARKER*/ in a page's script (order of inclusion is the page's choice).
MODULES = {
    '/*LOOK*/': 'look.js', '/*SHADERS*/': 'shaders.js', '/*GFX*/': 'gfx.js', '/*BAKE*/': 'bake.js', '/*CORE*/': 'core.js',
    '/*FLY*/': 'fly.js', '/*PLANETS*/': 'planets.js', '/*STARS*/': 'stars.js', '/*SUNS*/': 'play/suns.js', '/*STATIONS*/': 'stations.js',
    '/*ASTEROIDS*/': 'asteroids.js', '/*ROCKS*/': 'rocks.js', '/*PLAY*/': 'play/play.js', '/*SCHEMA*/': 'schema.js', '/*DEBUG*/': 'play/debug.js', '/*SHIPYARD*/': 'play/shipyard.js', '/*JITTER*/': 'play/jitter.js', '/*KEYS*/': 'play/keys.js',
    '/*MAP*/': 'map/map.js', '/*MAPPANEL*/': 'map/panel.js', '/*MAPVIEW*/': 'map/view.js', '/*DATA*/': 'data.js', '/*GALAXYMAP*/': 'play/galaxy.js',
}

def inline_modules(script, needed):
    for marker in needed:
        assert script.count(marker) == 1, f'{marker} must appear exactly once'
        script = script.replace(marker, (src / MODULES[marker]).read_text())
    return script

# the system schema each system file is validated (clamped) against at load; the economy (prices by port role, and
# where and with what a new game starts); traffic (hulls by culture and role, population weights)
system_files = sorted((src / 'systems').glob('*.json'))
systems_raw = [json.loads(f.read_text()) for f in system_files]
system_schema = json.dumps(json.loads((src / 'schema' / 'system.schema.json').read_text()))
economy = json.dumps(json.loads((src / 'economy.json').read_text()))
traffic = json.dumps(json.loads((src / 'traffic.json').read_text()))
lore_schema = json.dumps(json.loads((src / 'schema' / 'lore.schema.json').read_text()))
assert '</script' not in system_schema + economy + traffic + lore_schema

# ---------- the data files (src/data.js) ----------
def read_json(f):
    return json.loads(f.read_text()) if f.exists() else None
DATA = {}
# the universe index (tools/universe.py), remade from src/galaxy/ and the region notes every build
DATA['universe.json'] = universe.write()
# and, as the page's copy only, the factions' logos found in art/factions/ (tools/gen-logos.js; the picks promoted
# to <faction>.webp, the painted badge, and <faction>-flat.png, the clean transparent mark): a page loads them beside
# it, so the manifest lists only files that exist, and a faction without one shows its colour as before
DATA['universe.json']['art'] = {'logos': {k: {kind: f'art/factions/{name}' for kind, name in (('badge', f'{k}.webp'), ('flat', f'{k}-flat.png'))
    if (root / 'art' / 'factions' / name).exists()} for k in DATA['universe.json']['factions'] if (root / 'art' / 'factions' / f'{k}-flat.png').exists()}}
# each system: its file, its lore (tools/gen-content.js writes it; null if there is none yet) and the art found in
# art/<id>/ (the page loads the images beside it, so the manifest lists only files that exist; a page without them
# shows the procedural backdrop and no portraits); and, apart, how its content was made, for the debug screen: the
# lore run's record (facts, messages, model, cost) and the art log (every image's prompt, model, seed and cost)
for raw in systems_raw:
    sid, art_dir = raw['id'], root / 'art' / raw['id']
    a = {'vistas': {}, 'portraits': {}}
    for f in sorted(art_dir.glob('*.webp')) if art_dir.exists() else []:
        kind, _, name = f.stem.partition('-')
        if kind in ('vista', 'portrait'):
            a[kind + 's'][name] = f.relative_to(root).as_posix()
    DATA[f'systems/{sid}.json'] = {'system': raw, 'lore': read_json(src / 'lore' / f'{sid}.json'), 'art': a}
    DATA[f'logs/{sid}.json'] = {'lore': read_json(src / 'lore' / f'{sid}.log.json'), 'art': read_json(art_dir / 'log.json')}
# the real stars round Sol (tools/hyg.py), for the map
DATA['stars.json'] = json.loads((src / 'galaxy' / 'stars.json').read_text())
# the setting (canon for all the lore), and how the stories were written (each call: model, cost, problems, prompt; the
# setting, sent with every prompt, cut out of them: it is shown once), for the debug screen's Regions tab
setting_md = (src / 'lore' / 'setting.md').read_text()
slog = read_json(src / 'galaxy' / 'stories.log.json') or []
earlier = []  # the settings older stories were told from, if the setting has changed since: each shown once too
for rec in slog:
    for msg in rec.get('messages', []):
        c = msg['content']; i = c.find('# The setting\n'); j = c.find('\n\n\nThe region:', i) if i >= 0 else -1
        if j < 0: continue
        told = c[i:j].strip()
        if told == setting_md.strip(): cut = '[the setting: shown once, on the Regions tab]'
        else:
            if told not in earlier: earlier.append(told)
            cut = f'[an earlier setting ({earlier.index(told) + 1}): shown once, on the Regions tab]'
        msg['content'] = c[:i] + cut + c[j:]
DATA['galaxy-log.json'] = {'setting': setting_md, 'earlier': earlier, 'stories': slog}
DATA = {k: json.dumps(v, ensure_ascii=False, separators=(',', ':')) for k, v in DATA.items()}
for k, v in DATA.items(): assert '</script' not in v, k

HOSTED = '--hosted' in sys.argv
out_dir = root
if HOSTED:
    i = sys.argv.index('--hosted')
    out_dir = pathlib.Path(sys.argv[i + 1]).resolve() if i + 1 < len(sys.argv) and not sys.argv[i + 1].startswith('--') else root / 'dist'
# what a page carries inline: the files it reads (self-contained), or none (hosted: it fetches them from data/)
def data_tags(names):
    if HOSTED: return ''
    return '\n'.join(f'<script type="application/json" data-file="{n}">{DATA[n]}</script>' for n in names)
GAME_DATA = list(DATA)
MAP_DATA = ['universe.json', 'stars.json']

def page(template, script):
    t = template.replace('/*COREWASM*/', core_b64).replace('/*CATALOG*/', catalog).replace('/*GEN*/', gen).replace('/*APP*/', script)
    return t.replace('/*LORESCHEMA*/', lore_schema).replace('/*SYSTEMSCHEMA*/', system_schema).replace('/*ECONOMY*/', economy).replace('/*TRAFFIC*/', traffic)

# the lab: app.js pulls in the shared kit and every tab
lab = page((src / 'template.html').read_text(), inline_modules((src / 'app.js').read_text(),
    ['/*LOOK*/', '/*SHADERS*/', '/*GFX*/', '/*ROCKS*/', '/*BAKE*/', '/*CORE*/', '/*FLY*/', '/*STARS*/', '/*SCHEMA*/', '/*PLANETS*/', '/*STATIONS*/', '/*ASTEROIDS*/']))
# the game and the star map: their templates carry the script shell and markers themselves, and the data loader
# (src/data.js) first; the files they read inline where the build is self-contained
game = page(inline_modules((src / 'play' / 'template.html').read_text(), ['/*DATA*/', '/*LOOK*/', '/*SHADERS*/', '/*GFX*/', '/*ROCKS*/', '/*BAKE*/', '/*CORE*/', '/*STARS*/', '/*SCHEMA*/', '/*DEBUG*/', '/*GALAXYMAP*/', '/*SHIPYARD*/', '/*SUNS*/', '/*MAP*/', '/*MAPPANEL*/', '/*JITTER*/', '/*KEYS*/', '/*PLAY*/']), '').replace('<!--DATA-->', data_tags(GAME_DATA))
starmap = inline_modules((src / 'map' / 'template.html').read_text(), ['/*DATA*/', '/*SHADERS*/', '/*GFX*/', '/*STARS*/', '/*MAP*/', '/*MAPPANEL*/', '/*MAPVIEW*/']).replace('<!--DATA-->', data_tags(MAP_DATA))

out_dir.mkdir(parents=True, exist_ok=True)
for name, html in (('index.html', lab), ('play.html', game), ('map.html', starmap)):
    (out_dir / name).write_text(html)
    print(f'wrote {name} ({len(html):,} bytes)', end='; ')
if HOSTED:
    # the data files beside the pages, and the art they load (not the raw originals)
    for name, text in DATA.items():
        f = out_dir / 'data' / name
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
    shutil.copytree(root / 'art', out_dir / 'art', ignore=shutil.ignore_patterns('raw'), dirs_exist_ok=True)
    print(f'{len(DATA)} data files ({sum(len(v.encode()) for v in DATA.values()):,} bytes) and art/ -> {out_dir}', end='; ')
U = json.loads(DATA['universe.json'])
print(f"{len(U['systems'])} systems in the universe, {len(systems_raw)} with files ({', '.join(r['id'] for r in systems_raw)})", end='; ')
print(f'core {wasm.stat().st_size:,} bytes of WASM')
