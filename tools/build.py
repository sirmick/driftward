"""Assemble src/ into self-contained pages, index.html (the lab) and play.html (the game), with the Rust sim core
compiled to WASM and inlined into both, and map.html (the star map).

Usage: python3 tools/build.py [--skip-core]   (--skip-core reuses the last compiled WASM)
"""
import base64, json, os, pathlib, shutil, subprocess, sys
root = pathlib.Path(__file__).resolve().parent.parent
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
    '/*ASTEROIDS*/': 'asteroids.js', '/*ROCKS*/': 'rocks.js', '/*PLAY*/': 'play/play.js', '/*SCHEMA*/': 'schema.js', '/*DEBUG*/': 'play/debug.js', '/*SHIPYARD*/': 'play/shipyard.js', '/*JITTER*/': 'play/jitter.js',
    '/*MAP*/': 'map/map.js', '/*MAPPANEL*/': 'map/panel.js', '/*MAPVIEW*/': 'map/view.js',
}

def inline_modules(script, needed):
    for marker in needed:
        assert script.count(marker) == 1, f'{marker} must appear exactly once'
        script = script.replace(marker, (src / MODULES[marker]).read_text())
    return script

# the game's systems (every file in src/systems/, the start system first), and the schema each is validated (clamped)
# against at load; the economy (prices by port role); traffic (hulls by culture and role, population weights)
START_SYSTEM = 'm1.json'
system_files = sorted((src / 'systems').glob('*.json'), key=lambda f: (f.name != START_SYSTEM, f.name))
systems_raw = [json.loads(f.read_text()) for f in system_files]
systems = json.dumps(systems_raw)
system_schema = json.dumps(json.loads((src / 'schema' / 'system.schema.json').read_text()))
economy = json.dumps(json.loads((src / 'economy.json').read_text()))
traffic = json.dumps(json.loads((src / 'traffic.json').read_text()))
assert '</script' not in systems + system_schema + economy + traffic

# each system's lore (tools/gen-content.js writes it; absent if there is none yet) and the lore schema, inlined, keyed
# by system id; the art is not: the page loads the vistas and portraits from art/<id>/ beside it, so the manifest lists
# only files that exist, and a page without them (opened on its own) shows the procedural backdrop and no portraits
def read_json(f):
    return json.loads(f.read_text()) if f.exists() else None
lore_map, art_map, log_map = {}, {}, {}
for raw in systems_raw:
    sid = raw['id']
    lore_file = src / 'lore' / f'{sid}.json'
    if lore_file.exists():
        lore_map[sid] = json.loads(lore_file.read_text())
    art_dir = root / 'art' / sid
    a = {'vistas': {}, 'portraits': {}}
    for f in sorted(art_dir.glob('*.webp')) if art_dir.exists() else []:
        kind, _, name = f.stem.partition('-')
        if kind in ('vista', 'portrait'):
            a[kind + 's'][name] = f.relative_to(root).as_posix()
    art_map[sid] = a
    # how the content was made, for the debug screen: the lore run's record (facts, messages, model, cost) and the art
    # log (every image's prompt, model, seed, reference and cost)
    log_map[sid] = {'lore': read_json(src / 'lore' / f'{sid}.log.json'), 'art': read_json(art_dir / 'log.json')}
lore = json.dumps(lore_map)
lore_schema = json.dumps(json.loads((src / 'schema' / 'lore.schema.json').read_text()))
art = json.dumps(art_map)
content_log = json.dumps(log_map)
assert '</script' not in lore + lore_schema + art + content_log

def page(template, script):
    t = template.replace('/*COREWASM*/', core_b64).replace('/*CATALOG*/', catalog).replace('/*GEN*/', gen).replace('/*APP*/', script)
    t = t.replace('/*LORE*/', lore).replace('/*LORESCHEMA*/', lore_schema).replace('/*ART*/', art).replace('/*CONTENTLOG*/', content_log)
    return t.replace('/*SYSTEMS*/', systems).replace('/*SYSTEMSCHEMA*/', system_schema).replace('/*ECONOMY*/', economy).replace('/*TRAFFIC*/', traffic)

# the lab: app.js pulls in the shared kit and every tab
lab = page((src / 'template.html').read_text(), inline_modules((src / 'app.js').read_text(),
    ['/*LOOK*/', '/*SHADERS*/', '/*GFX*/', '/*ROCKS*/', '/*BAKE*/', '/*CORE*/', '/*FLY*/', '/*STARS*/', '/*SCHEMA*/', '/*PLANETS*/', '/*STATIONS*/', '/*ASTEROIDS*/']))
# the game: its template carries the script shell and markers itself
# the galaxy: the real stars round Sol (tools/hyg.py writes src/galaxy/stars.json) and the game's systems, lanes and
# factions among them (tools/galaxy.py writes src/galaxy/galaxy.json), for the star map: its own page and the game's
# debug screen
galaxy_data = json.loads((src / 'galaxy' / 'stars.json').read_text())
galaxy_data['game'] = json.loads((src / 'galaxy' / 'galaxy.json').read_text())
# and its worlds (tools/worlds.py: people, ports, wealth) and stories (tools/stories.py: backstories), where made
for k, f in (('worlds', 'worlds.json'), ('stories', 'stories.json')):
    if (src / 'galaxy' / f).exists(): galaxy_data['game'][k] = json.loads((src / 'galaxy' / f).read_text())
# and the regions' hand-written notes (src/lore/regions/<region>.md), for the debug screen's Regions tab
galaxy_data['game']['regionNotes'] = {f.stem: f.read_text() for f in sorted((src / 'lore' / 'regions').glob('*.md'))}
galaxy = json.dumps(galaxy_data, ensure_ascii=False, separators=(',', ':'))
assert '</script' not in galaxy
game = page(inline_modules((src / 'play' / 'template.html').read_text(), ['/*LOOK*/', '/*SHADERS*/', '/*GFX*/', '/*ROCKS*/', '/*BAKE*/', '/*CORE*/', '/*STARS*/', '/*SCHEMA*/', '/*DEBUG*/', '/*SHIPYARD*/', '/*SUNS*/', '/*MAP*/', '/*MAPPANEL*/', '/*JITTER*/', '/*PLAY*/']), '').replace('/*GALAXY*/', galaxy)
starmap = inline_modules((src / 'map' / 'template.html').read_text(), ['/*SHADERS*/', '/*GFX*/', '/*STARS*/', '/*MAP*/', '/*MAPPANEL*/', '/*MAPVIEW*/']).replace('/*GALAXY*/', galaxy)

for name, html in (('index.html', lab), ('play.html', game), ('map.html', starmap)):
    (root / name).write_text(html)
    print(f'wrote {name} ({len(html):,} bytes)', end='; ')
print(f"{len(systems_raw)} systems ({', '.join(r['id'] for r in systems_raw)}); lore for {len(lore_map)}; art {sum(len(a['vistas']) for a in art_map.values())} vistas and {sum(len(a['portraits']) for a in art_map.values())} portraits", end='; ')
print(f'core {wasm.stat().st_size:,} bytes of WASM')
