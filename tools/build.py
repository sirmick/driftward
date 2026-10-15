"""Assemble src/ into two self-contained pages, index.html (the lab) and play.html (the game), with the Rust sim
core compiled to WASM and inlined into both.

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
    '/*FLY*/': 'fly.js', '/*PLANETS*/': 'planets.js', '/*SUNS*/': 'suns.js', '/*STATIONS*/': 'stations.js',
    '/*ASTEROIDS*/': 'asteroids.js', '/*PLAY*/': 'play/play.js', '/*SCHEMA*/': 'schema.js', '/*DEBUG*/': 'play/debug.js', '/*SHIPYARD*/': 'play/shipyard.js',
}

def inline_modules(script, needed):
    for marker in needed:
        assert script.count(marker) == 1, f'{marker} must appear exactly once'
        script = script.replace(marker, (src / MODULES[marker]).read_text())
    return script

# the game's system, and the schema it is validated (clamped) against at load; the economy (prices by port role);
# traffic (hulls by culture and role, population weights)
system = json.dumps(json.loads((src / 'systems' / 'm1.json').read_text()))
system_schema = json.dumps(json.loads((src / 'schema' / 'system.schema.json').read_text()))
economy = json.dumps(json.loads((src / 'economy.json').read_text()))
traffic = json.dumps(json.loads((src / 'traffic.json').read_text()))
assert '</script' not in system + system_schema + economy + traffic

# the system's lore (tools/gen-content.js writes it; null if there is none yet) and its schema, inlined; the art is
# not: the page loads the vistas and portraits from art/<system>/ beside it, so the manifest lists only files that
# exist, and a page without them (opened on its own) shows the procedural backdrop and no portraits
system_id = json.loads(system)['id']
lore_file = src / 'lore' / f'{system_id}.json'
lore = json.dumps(json.loads(lore_file.read_text())) if lore_file.exists() else 'null'
lore_schema = json.dumps(json.loads((src / 'schema' / 'lore.schema.json').read_text()))
art_dir = root / 'art' / system_id
art = {'vistas': {}, 'portraits': {}}
for f in sorted(art_dir.glob('*.webp')) if art_dir.exists() else []:
    kind, _, name = f.stem.partition('-')
    if kind in ('vista', 'portrait'):
        art[kind + 's'][name] = f.relative_to(root).as_posix()
art = json.dumps(art)
# how the content was made, for the debug screen: the lore run's record (facts, messages, model, cost) and the art
# log (every image's prompt, model, seed, reference and cost)
def read_json(f):
    return json.loads(f.read_text()) if f.exists() else None
content_log = json.dumps({'lore': read_json(src / 'lore' / f'{system_id}.log.json'), 'art': read_json(art_dir / 'log.json')})
assert '</script' not in lore + lore_schema + art + content_log

def page(template, script):
    t = template.replace('/*COREWASM*/', core_b64).replace('/*CATALOG*/', catalog).replace('/*GEN*/', gen).replace('/*APP*/', script)
    t = t.replace('/*LORE*/', lore).replace('/*LORESCHEMA*/', lore_schema).replace('/*ART*/', art).replace('/*CONTENTLOG*/', content_log)
    return t.replace('/*SYSTEM*/', system).replace('/*SYSTEMSCHEMA*/', system_schema).replace('/*ECONOMY*/', economy).replace('/*TRAFFIC*/', traffic)

# the lab: app.js pulls in the shared kit and every tab
lab = page((src / 'template.html').read_text(), inline_modules((src / 'app.js').read_text(),
    ['/*LOOK*/', '/*SHADERS*/', '/*GFX*/', '/*BAKE*/', '/*CORE*/', '/*FLY*/', '/*SCHEMA*/', '/*PLANETS*/', '/*SUNS*/', '/*STATIONS*/', '/*ASTEROIDS*/']))
# the game: its template carries the script shell and markers itself
game = page(inline_modules((src / 'play' / 'template.html').read_text(), ['/*LOOK*/', '/*SHADERS*/', '/*GFX*/', '/*BAKE*/', '/*CORE*/', '/*SCHEMA*/', '/*DEBUG*/', '/*SHIPYARD*/', '/*PLAY*/']), '')

for name, html in (('index.html', lab), ('play.html', game)):
    (root / name).write_text(html)
    print(f'wrote {name} ({len(html):,} bytes)', end='; ')
print(f"lore {'yes' if lore != 'null' else 'none'}, art {len(json.loads(art)['vistas'])} vistas and {len(json.loads(art)['portraits'])} portraits", end='; ')
print(f'core {wasm.stat().st_size:,} bytes of WASM')
