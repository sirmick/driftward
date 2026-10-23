"""The universe index: one file the game loads at start, merged from what the galaxy tools make. Each system once,
by star id: where it is, what it is, who holds it, its people and ports (tools/worlds.py) and its story
(tools/stories.py); the factions, the regions (name, trade, summary, the hand-written notes in src/lore/regions/), and
the lanes. A flyable system's layout is not here: `file` names its system file (src/systems/), loaded when it is
needed (src/data.js). Schema: src/schema/universe.schema.json; npm run check validates it and checks every system
file against its entry (tools/validate.js). Plan and audit: docs/data.md.

The galaxy hash: worlds.json and stories.json record the hash of the galaxy they were made from (each system's star,
name, region, owner, ring and status, and every lane's ends), so a galaxy rerun that renames, re-owns or re-regions a
system shows up as stale worlds or stories instead of passing silently. The index carries the galaxy's hash and theirs;
tools/validate.js fails when they differ.

The build (tools/build.py) writes src/galaxy/universe.json on every run, so it is never out of date; run this on its
own to see the counts: python3 tools/universe.py
"""
import hashlib, json, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
GALAXY = root / 'src' / 'galaxy'
OUT = GALAXY / 'universe.json'

# who holds a system that no faction does: the aliens' own, else nobody (the system schema's owner vocabulary)
ALIEN = ('bloom', 'glass', 'shadow')
# the factions, with the names the setting gives them and their map colours (linear RGB; src/map/map.js draws with
# them): the six that hold human space (galaxy.json), then the three alien powers
COLOURS = {'federation': [.3, .5, 1], 'union': [1, .45, .15], 'prism': [.7, .4, 1], 'freeflag': [1, .8, .2],
           'blackhulls': [.6, .38, .28], 'independent': [.55, .62, .7], 'bloom': [.2, 1, .35], 'shadow': [1, .15, .1], 'glass': [.6, .9, 1]}
ALIEN_NAMES = {'bloom': 'The Bloom', 'glass': 'The Glass', 'shadow': 'The Shadow'}
# galaxy.json's per-system fields the index keeps as they are (faction becomes owner, star becomes id, system file)
KEEP = ('name', 'group', 'status', 'region', 'ring', 'class', 'absmag', 'jumps', 'depth', 'sector', 'settled', 'charted',
        'seen', 'emptied', 'lost', 'gateway', 'exclave', 'hazard', 'front', 'provisional')


def read(name):
    f = GALAXY / name
    return json.loads(f.read_text()) if f.exists() else None


def galaxy_hash(G):
    """What worlds and stories depend on: each system's identity and place, and the lanes. Sixteen hex digits."""
    rows = [[c['star'], c['name'], c['region'], c.get('faction') or '', c.get('ring') or '', c['status']] for c in G['systems']]
    rows += [[l['a'], l['b']] for l in G['lanes']]
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:16]


def owner_of(c):
    return c.get('faction') or (c['group'] if c['group'] in ALIEN else 'none')


def build():
    G, W, ST = read('galaxy.json'), read('worlds.json') or {}, read('stories.json') or {}
    stars = {s['id']: s for s in read('stars.json')['stars']}
    for g in G.get('generated', []): stars[g['id']] = g
    notes = {f.stem: f.read_text() for f in sorted((root / 'src' / 'lore' / 'regions').glob('*.md'))}
    worlds, stories = W.get('systems', {}), ST.get('systems', {})

    factions = {k: {'name': n, 'colour': COLOURS[k]} for k, n in G['factions'].items()}
    factions.update({k: {'name': n, 'colour': COLOURS[k], 'alien': True} for k, n in ALIEN_NAMES.items()})
    regions = {}
    for k, name in G['regions'].items():
        r = {'name': name}
        trade, story = W.get('regions', {}).get(k), ST.get('regions', {}).get(k)
        if trade: r['trade'] = trade
        if story: r['summary'] = story['summary']; r['told'] = {'model': story['model'], 'date': story['date']}
        if k in notes: r['notes'] = notes[k]
        regions[k] = r

    systems = []
    for c in G['systems']:
        s, star = {'id': c['star']}, stars[c['star']]
        s.update({k: c[k] for k in KEEP if k in c})
        s['owner'] = owner_of(c)
        s['pos'] = star['pos']
        s.setdefault('class', star.get('class'))
        if 'absmag' not in s and star.get('absmag') is not None: s['absmag'] = star['absmag']
        if star.get('name') and star['name'] != c['name'] and not star.get('generated'): s['catalog'] = star['name']
        if star.get('generated'): s['generated'] = True
        w, st = worlds.get(str(c['star'])), stories.get(str(c['star']))
        if w: s['world'] = w
        if st: s['story'] = st['bullets']
        if c.get('system'): s['file'] = c['system']
        systems.append(s)

    lanes = [{k: l[k] for k in ('a', 'b', 'ly', 'days', 'border', 'drift') if k in l} for l in G['lanes']]
    made = {'galaxy': galaxy_hash(G), 'worlds': W.get('galaxy'), 'stories': {k: v.get('galaxy') for k, v in ST.get('regions', {}).items()}}
    return {'source': 'tools/universe.py from src/galaxy/ (galaxy, stars, worlds, stories) and src/lore/regions/; ids are star ids',
            'made': made, 'factions': factions, 'regions': regions, 'systems': systems, 'lanes': lanes}


def write(u=None):
    """Write src/galaxy/universe.json (only if it changed); returns the index."""
    u = u or build()
    # one system or lane a line, as galaxy.json is, so a change reads as a small diff
    head = {k: v for k, v in u.items() if k not in ('systems', 'lanes')}
    text = (json.dumps(head, ensure_ascii=False, separators=(',', ':'))[:-1]
            + ',\n"systems":[\n' + ',\n'.join(json.dumps(s, ensure_ascii=False, separators=(',', ':')) for s in u['systems'])
            + '\n],\n"lanes":[\n' + ',\n'.join(json.dumps(l, separators=(',', ':')) for l in u['lanes']) + '\n]}\n')
    if not OUT.exists() or OUT.read_text() != text: OUT.write_text(text)
    return u


if __name__ == '__main__':
    u = write()
    m = u['made']
    print(f"universe: {len(u['systems'])} systems ({sum(1 for s in u['systems'] if 'world' in s)} settled, "
          f"{sum(1 for s in u['systems'] if 'file' in s)} with a system file), {len(u['regions'])} regions, {len(u['lanes'])} lanes, "
          f"{OUT.stat().st_size:,} bytes -> {OUT.relative_to(root)}")
    stale = (['worlds'] if m['worlds'] != m['galaxy'] else []) + [f'stories of {k}' for k, h in m['stories'].items() if h != m['galaxy']]
    print(f"  galaxy {m['galaxy']}; " + (f"made from another galaxy: {', '.join(stale)}" if stale else 'worlds and stories match it'))
