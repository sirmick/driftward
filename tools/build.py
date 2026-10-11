"""Assemble src/ into a single self-contained index.html."""
import json, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
src = root / 'src'
t = (src / 'template.html').read_text()
catalog = json.dumps(json.loads((src / 'catalog.json').read_text()), indent=1)
assert '</script' not in catalog
app = (src / 'app.js').read_text()
for marker, name in (('/*FLY*/', 'fly.js'), ('/*PLANETS*/', 'planets.js'), ('/*SUNS*/', 'suns.js'), ('/*STATIONS*/', 'stations.js'), ('/*ASTEROIDS*/', 'asteroids.js')):
    app = app.replace(marker, (src / name).read_text())
t = t.replace('/*CATALOG*/', catalog).replace('/*GEN*/', (src / 'gen.js').read_text()).replace('/*APP*/', app)
out = root / 'index.html'
out.write_text(t)
print(f'wrote {out} ({len(t):,} bytes)')
