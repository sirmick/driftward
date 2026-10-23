"""Choose the game's star systems from the real stars round Sol (src/galaxy/stars.json, from tools/hyg.py), give them
to the factions and join them with jump lanes, as three mixed-integer programs (tools/mip.py, HiGHS via scipy), then
grow the deep Drift, into src/galaxy/galaxy.json. Systems, then territories, then lanes: the lanes know who holds
what, so every territory is laced with its own lanes and borders cross at a few choke points.

The map model (stage select):
  * each candidate star takes at most one role: inhabited or dead (human space, three rings round Sol), Drift (dead
    stars round the exterior, past the outer ring, where the Drift begins), Bloom living or dead (a sector of its own
    above the plane), Shadow (past the outer ring toward the galactic core). Quotas per ring and role; the famous
    stars, the Calder March and the Glass are fixed; inhabited systems keep a ring's spacing; no two systems within a
    light year; the Drift spread round every side; room for lanes (a role's least lanes' worth of chosen stars within
    reach, and a flow from Sol through chosen stars within reach of each other, so the map is one piece). Named stars
    are chosen for what they are (sun-like ones to live by, dim ones dead); a star known only by a catalogue number
    for where it is, and its class is set by its role afterwards (nobody knows it).
The territory model (stage factions), on the lanes there could be (chosen systems within reach of each other):
  * every inhabited human system goes to a faction, to the setting's counts (src/lore/setting.md), in the rings the
    faction may hold, enough in its home ring; dead systems may be claimed as territory; the March's owners as its
    region file says; the factions that hold land hold it together (a flow from a root in each piece through their
    own systems), each piece beyond the first costed, the pieces apart from the main body exclaves (EXCLAVE); the
    the Union, Freeflag and Prism lean toward the March's side (BEARINGS); compact, splitting near neighbours costs.
  * the Drift is cut into eight sectors round the galactic pole; at least MIN_OPEN of them, whose edge the Bloom and
    the Shadow do not hold, are open frontier, and each growing faction (FRONTIER) must be able to hold the same number
    of gateways into them (the lane model makes them so). So every faction has equal room to grow.
The lane model (stage lanes, and after the territories in stage factions):
  * a lane joins two chosen systems within reach; each system between its role's least and most lanes; the map in
    one piece (a flow from Sol along the lanes), each jump on a system's way from Sol costed, so routes stay short
    without forbidding a long way round (the zones' HOPS are targets, reported); every Drift sector reached from human
    space by at least DRIFT_BORDER lanes; lanes cost their length.
  * with territories: each piece of a territory joined by lanes of its own, an inhabited system with two lanes inside
    its territory where it can; lanes inside a territory cheap and across a border dear (INSIDE_COST, BORDER_COST), so
    borders cross at a few choke points (marked on the lanes); each frontier faction with the same number of gateways
    (systems of its own with a lane into an open sector's Drift).

The deep Drift (after the models), grown rather than optimised, since the Drift is generated (the Book: Drift systems
are generated on first contact, seeded from their neighbors): from the Drift fringe the map model chose among the real
stars, reaches of generated stars push outward, branching, each step longer than the last, to depth 8 (fringe, wild,
deep, the black), with a few loops near the edge; never into the Bloom's or the Shadow's directions.

Usage: python3 tools/galaxy.py [--stage select|lanes|factions] [--time SECONDS] [--reuse | --drift-only]
  --reuse: the systems already in galaxy.json, then territories, lanes and the Drift
  --relane: the systems already in galaxy.json and the territories last solved, then lanes and the Drift
  --drift-only: the Drift alone, on the systems, territories and lanes already in galaxy.json
"""
import json, pathlib, random, sys
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from mip import Model
from galaxy_names import namer, INVENT_SETTLED, INVENT_DEAD

root = pathlib.Path(__file__).resolve().parent.parent
stars = json.loads((root / 'src' / 'galaxy' / 'stars.json').read_text())['stars']
out = root / 'src' / 'galaxy' / 'galaxy.json'
args = sys.argv[1:]
STAGE = args[args.index('--stage') + 1] if '--stage' in args else 'factions'
TIME = float(args[args.index('--time') + 1]) if '--time' in args else 300
DRIFT_ONLY = '--drift-only' in args
RELANE = '--relane' in args
REUSE = '--reuse' in args or DRIFT_ONLY or RELANE
TERRITORY_CACHE = pathlib.Path.home() / '.cache' / 'driftward' / 'territories.json'
rng = random.Random(2526)

# ---------- the numbers to reshape it by ----------
# zones by distance from Sol (ly): the rings of human space, then the exterior where the Drift begins
RINGS = [('inner', 22), ('middle', 42), ('outer', 65)]
EXTERIOR = 82
INHABITED = {'inner': 45, 'middle': 50, 'outer': 55}
DEAD = {'inner': 45, 'middle': 82, 'outer': 145}
DRIFT, DRIFT_PER_SECTOR = 100, (6, 22)
DRIFT_BORDER = 8  # lanes from human space into each sector's Drift, at least
BLOOM, BLOOM_DEAD, SHADOW = 30, 16, 24
GAP = {'inner': 2.5, 'middle': 4, 'outer': 5.5}  # least distance between inhabited systems
# a lane's longest, by the farther end's zone; and the most jumps from Sol, by zone
REACH = {'inner': 9, 'middle': 11, 'outer': 14, 'exterior': 16, 'bloom': 12, 'shadow': 16}
HOPS = {'inner': 6, 'middle': 10, 'outer': 14, 'exterior': 17, 'bloom': 18, 'shadow': 20}  # targets, reported
JUMP_COST = .5   # the lane model's cost of a jump on a system's way from Sol, against a lane's cost of its length
DEGREE = {'inh': (3, 7), 'dead': (2, 5), 'drift': (1, 4), 'bloom': (2, 5), 'bdead': (1, 4), 'shadow': (1, 4), 'glass': (1, 4)}
SOL_DEGREE = (3, 8)
NEIGHBOURS = 24  # a candidate lane joins one of each system's nearest this many systems
CANDIDATES = {'outer': 520, 'exterior': 330}  # thin the far zones' candidate stars to keep the model small
# the stars that are always inhabited: Sol, the Federation's -Max ports (docs/names.md) and the famous neighbours
PINNED = ['Sol', 'Alpha Centauri', "Barnard's Star", 'Wolf 359', 'Epsilon Eridani', 'Tau Ceti', 'Sirius', 'Procyon',
          '61 Cygni', 'Epsilon Indi', 'Altair', 'Vega', 'Fomalhaut', 'Arcturus', 'Pollux', 'Capella']
# a named star is chosen for what it is: how good a home its class makes, or how fitting a dead star; a star known
# only by a catalogue number is chosen for where it is (any class goes: its class is set by its role afterwards)
LIVE_SCORE = {'yellow': 3, 'orange': 2.6, 'white': 1.8, 'red-dwarf': 1, 'red-giant': .9, 'white-dwarf': .6, 'blue-giant': .5}
DEAD_SCORE = {'red-dwarf': .6, 'white-dwarf': .8, 'brown-dwarf': .8, 'red-giant': .5}
NAMED_BONUS, CATALOG_LIVE, CATALOG_DEAD = .8, 2, .5
# the classes set on catalogue stars, by role (weights); the absolute magnitude the map draws each class at
ROLE_CLASSES = {
    'inh': {'yellow': .3, 'orange': .32, 'white': .08, 'red-dwarf': .27, 'red-giant': .03},
    'dead': {'red-dwarf': .5, 'white-dwarf': .15, 'brown-dwarf': .12, 'orange': .1, 'yellow': .05, 'red-giant': .04, 'white': .04},
    'drift': {'red-dwarf': .4, 'brown-dwarf': .15, 'white-dwarf': .14, 'orange': .08, 'red-giant': .06, 'blue-giant': .04,
              'wolf-rayet': .03, 'pulsar': .06, 'black-hole': .04},
    'bloom': {'yellow': .4, 'orange': .35, 'white': .15, 'red-dwarf': .1},
    'bdead': {'red-dwarf': .5, 'white-dwarf': .2, 'brown-dwarf': .2, 'orange': .1},
    'shadow': {'red-dwarf': .4, 'white-dwarf': .2, 'pulsar': .1, 'black-hole': .1, 'brown-dwarf': .1, 'red-giant': .1},
    'glass': {'white': .4, 'yellow': .3, 'orange': .3},
}
ABSMAG = {'yellow': 4.8, 'orange': 6.5, 'white': 2, 'red-dwarf': 11, 'red-giant': .5, 'white-dwarf': 12, 'brown-dwarf': 16,
          'blue-giant': -4, 'wolf-rayet': -5, 'pulsar': 13, 'black-hole': 15}
BLOOM_DIR, BLOOM_LY, BLOOM_R = (-.35, -.55, .76), 58, 24
SHADOW_FROM, SHADOW_CONE = 65, .7
# the Shadow holds together round a centre toward the galactic core, so it has a front rather than scattered clumps;
# the systems of its nearest Sol were human once, emptied as the front moved inward (Corran first, 2521); the human
# systems with a lane to it are the front, which the navy holds (the Federation's, FRONT_BONUS in the territory model)
SHADOW_CENTRE, SHADOW_PULL = (84, 0, 4), 12
EMPTIED, EMPTIED_YEARS = 3, (2521, 2522, 2523)
FRONT_BONUS = 1.5
# when humanity got where (src/lore/setting.md, the Rush): systems settled by year, the dozen by 2200, about forty by
# 2250, a hundred by 2320, some hundred and forty by the 2370s, the rest since; the nearest, by jumps and distance,
# first. Contact with the Bloom in 2376, its worlds charted over the years after; the Shadow seen from 2519; the
# Glass lost in 2524
SETTLED = [(0, 2176), (12, 2200), (40, 2250), (100, 2320), (140, 2375), (160, 2480)]
CONTACT, BLOOM_CHARTED, SHADOW_SEEN, GLASS_LOST = 2376, 2410, 2519, 2524
# the Calder March (src/lore/regions/calder-march.md): its systems, their stars' classes (src/systems/*.json; a white
# star may be any F type, since A stars are too rare to find two close together) and their owners
MARCH = [('brannock', 'Brannock', 'orange', 'union'), ('calder', 'Calder', 'white', 'federation'), ('merrow', 'Merrow', 'yellow', 'federation'),
         ('serein', 'Serein', 'yellow', 'prism'), ('quire', 'Quire', 'white', 'prism'), ('ostry', 'Ostry', 'red-dwarf', 'union')]
MARCH_LY = (18, 34)
MARCH_REACH = 24  # Union inhabited systems Brannock must join, through the Union's own, beyond itself
GLASS = ['Varrow', 'Hesk', 'Lucerne', 'Facet']  # the two Union systems, then Prism's research world and its foundry
# factions: the setting's count of inhabited systems, the rings they may lie in, at least how many in the home ring,
# and whether their territory holds together (each piece of it beyond the first costs PIECE_COST; the Blackhull havens
# and the Independents are scattered by nature)
FACTIONS = {
    'federation':   dict(name='Federation', n=45, rings=('inner', 'middle', 'outer'), home=('inner', 28), whole=True),
    'union':  dict(name='Union', n=35, rings=('middle', 'outer'), home=('middle', 24), whole=True),
    'prism': dict(name='Prism', n=20, rings=('inner', 'middle', 'outer'), home=('inner', 12), whole=True),
    'freeflag':  dict(name='Freeflag', n=20, rings=('outer',), home=('outer', 20), whole=True),
    'blackhulls': dict(name='Blackhull havens', n=5, rings=('middle', 'outer'), home=('outer', 2), whole=False),
    'independent': dict(name='Independent', n=25, rings=('middle', 'outer'), home=('outer', 18), whole=False),
}
PIECE_COST = 6
# the lane model's cost of a lane inside a territory (times its length), and across a border (times its length, plus a
# fixed cost): so territories are laced with lanes and borders cross at a few choke points
INSIDE_COST, BORDER_COST = .7, (1.6, 4)
FED_HOLDS = ['Sol', 'Alpha Centauri', "Barnard's Star", 'Wolf 359', 'Epsilon Eridani', 'Tau Ceti']
FRONTIER = ['federation', 'union', 'prism', 'freeflag']  # the factions given equal access to the open Drift
MIN_OPEN, MIN_GATEWAYS = 1, 2
SECTORS = 8
# where a faction's territory leans: toward a March system's bearing from Sol, each of its systems costing its angle
# off that bearing (radians) times the weight; the Union holds the March's side of the middle ring, Freeflag the
# outer ring beyond them (the strikes made them cousins), Prism's company worlds lean the same way, toward Serein
BEARINGS = {'union': ('brannock', 2.0), 'freeflag': ('brannock', 1.5), 'prism': ('serein', .6)}
# the regions: every system belongs to one, named here; built after the lanes (see the region stage below)
REGIONS = {
    'inner-sphere': 'The Inner Sphere', 'concord': 'The Concord Worlds', 'long-watch': 'The Long Watch',
    'calder-march': 'The Calder March', 'mirrorspace': 'Mirrorspace', 'prism-inc': 'Prism Incorporate',
    'prism-research': 'Prism Research', 'anvil': 'The Anvil', 'iron-outposts': 'The Union Outposts', 'reach': 'The Reach',
    'cells': 'The Cells', 'margins': 'The Margins', 'blackspace': 'Blackspace', 'garden': 'The Garden', 'hedge': 'The Hedge',
    'blightspace': 'Blightspace', 'corran-gate': 'Corran Gate', 'lighthouse-run': 'Lighthouse Run',
    'furnace-deeps': 'The Furnace Deeps', 'the-maw': 'The Maw', 'beacon-cells': 'Beacon Cells', 'the-sink': 'The Sink',
    'drift': 'The Drift', 'shoals': 'The Shoals', 'black-shelf': 'The Black Shelf', 'long-dark': 'The Long Dark',
    'far-lanterns': 'The Far Lanterns', 'outer-dark': 'The Outer Dark', 'farthest-reach': 'The Farthest Reach',
}
INNER_SPHERE_LY = 12.5   # the Inner Sphere: human space this near Sol, whoever holds it
LONG_WATCH = 55          # the Long Watch: the Federation's systems within this angle (degrees) of the Shadow, past 20 ly
HEDGE_SHARE = .35        # the Hedge: the Bloom's share farthest (in jumps) from human space, the part it has closed
OPEN_DRIFT = ['shoals', 'black-shelf', 'long-dark', 'far-lanterns', 'outer-dark', 'farthest-reach']  # by open sector, in turn
# hazard stars: a few catalogue stars made into hazards (nobody knows them), each where it matters, a region named
# round it: (name, class, where, region)
HAZARDS = [('The Lighthouse', 'pulsar', 'lighthouse', 'lighthouse-run'), ('The Furnace', 'wolf-rayet', 'furnace', 'furnace-deeps'),
           ('The Beacon', 'blue-giant', 'beacon', 'beacon-cells'), ('The Metronome', 'pulsar', 'metronome', 'corran-gate'),
           ('The Sink', 'black-hole', 'sink', 'the-sink'), ('The Maw', 'black-hole', 'maw', 'the-maw')]
# what a piece of a faction's territory apart from its main body is
EXCLAVE = {'federation': 'navy base', 'union': 'outpost', 'prism': 'company world', 'freeflag': 'rebel cell'}
# the deep Drift: depth by jumps from human space; at each depth how many systems a system spawns (on average), how
# far its children lie (ly), and the chance it links to a neighbour too (a loop)
DRIFT_DEPTH = 8
DRIFT_BRANCH = {1: 1.3, 2: .75, 3: .8, 4: .8, 5: .75, 6: .7, 7: .65}
DRIFT_STEP = {2: (7, 12), 3: (8, 13), 4: (9, 14), 5: (10, 15), 6: (11, 16), 7: (12, 17), 8: (13, 18)}
DRIFT_LOOP = {1: .5, 2: .45, 3: .35, 4: .25, 5: .15, 6: .08, 7: 0, 8: 0}
DRIFT_SEP, DRIFT_MAX_LY = 6, 150

# ---------- geometry ----------
N = len(stars)
P = np.array([s['pos'] for s in stars], dtype=float)
LY = np.array([s['ly'] for s in stars])
D = np.sqrt(((P[:, None, :] - P[None, :, :]) ** 2).sum(-1))
by_name = {s['name']: i for i, s in enumerate(stars)}
bloom_c = np.array(BLOOM_DIR) / np.linalg.norm(BLOOM_DIR) * BLOOM_LY
in_bloom = np.linalg.norm(P - bloom_c, axis=1) < BLOOM_R
in_shadow = (LY > SHADOW_FROM) & (P[:, 0] / np.maximum(LY, 1e-9) >= SHADOW_CONE)
def zone(i):
    if in_bloom[i]: return 'bloom'
    if in_shadow[i]: return 'shadow'
    for name, edge in RINGS:
        if LY[i] < edge: return name
    return 'exterior' if LY[i] < EXTERIOR else None
Z = [zone(i) for i in range(N)]
sector = ((np.degrees(np.arctan2(P[:, 1], P[:, 0])) % 360) // (360 / SECTORS)).astype(int)

# the March: the tightest six stars that can be its classes (a named star must be; a catalogue star can be anything),
# fixed before the model: it is narrative, not optimised; the Glass beside it, a little farther out
def fits(s, cls): return s.get('catalog') or s['class'] == cls or (cls == 'white' and (s['spect'] or '')[:1] == 'F')
band = [i for i in range(N) if MARCH_LY[0] <= LY[i] <= MARCH_LY[1] and Z[i] in ('inner', 'middle') and stars[i]['name'] not in PINNED]
best = None
for c in band:
    near, pick = sorted(band, key=lambda i: D[i, c]), []
    for _, _, cls, _ in MARCH:
        j = next((j for j in near if fits(stars[j], cls) and all(D[j, k] >= GAP['middle'] for k in pick)), None)
        if j is None: break
        pick.append(j)
    if len(pick) == len(MARCH):
        spread = max(D[a, b] for a in pick for b in pick)
        if not best or spread < best[0]: best = (spread, pick)
march = best[1]
ostry = march[-1]
pinned = [by_name[n] for n in PINNED]
glass = []
for i in sorted([i for i in range(N) if Z[i] == 'middle' and i not in march and stars[i]['name'] not in PINNED],
                key=lambda i: D[i, ostry] - .4 * (LY[i] - LY[ostry])):
    if len(glass) < len(GLASS) and all(D[i, j] >= GAP['middle'] for j in march + glass + pinned): glass.append(i)
fixed_inh = set(pinned + march)
ring_of = {i: ('middle' if i in march else Z[i]) for i in range(N)}

# candidates: every star in a zone, the far zones thinned (keeping named stars first)
cand = []
for z in ('inner', 'middle', 'outer', 'exterior', 'bloom', 'shadow'):
    zs = [i for i in range(N) if Z[i] == z]
    cap = CANDIDATES.get(z)
    if cap and len(zs) > cap:
        keep = [i for i in zs if i in fixed_inh or i in glass]
        rest = [i for i in zs if i not in keep]
        rng.shuffle(rest); rest.sort(key=lambda i: bool(stars[i].get('catalog')))
        zs = keep + rest[:cap - len(keep)]
    cand += zs
cand.sort()
roles_for = {'inner': ('inh', 'dead'), 'middle': ('inh', 'dead', 'glass'), 'outer': ('inh', 'dead'), 'exterior': ('drift',),
             'bloom': ('bloom', 'bdead'), 'shadow': ('shadow',)}

# ---------- the map model ----------
m = Model()
y = {}  # (star, role) -> binary
for i in cand:
    for r in roles_for[Z[i]]:
        if r == 'glass' and i not in glass: continue
        y[i, r] = m.binary(f'y{i}{r}')
roles_of = {i: [] for i in cand}
for (i, r), v in y.items(): roles_of[i].append((r, v))
x = {i: {v: 1 for _, v in roles_of[i]} for i in cand}  # whether star i is chosen, as an expression
for i in cand: m.add(x[i], hi=1, tag='one role')
for i in fixed_inh: m.fix(y[i, 'inh'], 1)
for i in glass: m.fix(y[i, 'glass'], 1)
sel = lambda r, pred: {y[i, r]: 1 for i in cand if (i, r) in y and pred(i)}
for ring, n in INHABITED.items(): m.eq(sel('inh', lambda i: ring_of[i] == ring), n, tag=f'inhabited {ring}')
for ring, n in DEAD.items(): m.eq(sel('dead', lambda i: ring_of[i] == ring), n, tag=f'dead {ring}')
m.eq(sel('drift', lambda i: True), DRIFT, tag='drift')
for k in range(SECTORS):
    ks = sel('drift', lambda i: sector[i] == k)
    if ks: m.add(ks, min(DRIFT_PER_SECTOR[0], len(ks)), DRIFT_PER_SECTOR[1], tag=f'drift sector {k}')
m.eq(sel('bloom', lambda i: True), BLOOM, tag='bloom'); m.eq(sel('bdead', lambda i: True), BLOOM_DEAD, tag='bloom dead'); m.eq(sel('shadow', lambda i: True), SHADOW, tag='shadow')
# spacing: no two systems within a light year; no two inhabited within the farther one's ring gap
live = {i: {v: 1 for r, v in roles_of[i] if r in ('inh', 'glass')} for i in cand}
ca = np.array(cand)
for a in cand:
    for b in ca[(D[a, ca] < max(GAP.values())) & (ca > a)]:
        b = int(b)
        if D[a, b] < 1: m.add({**x[a], **x[b]}, hi=1, tag='a light year apart')
        ga = GAP.get(ring_of[a] if LY[a] > LY[b] else ring_of[b])
        if ga and D[a, b] < ga and live[a] and live[b]: m.add({**live[a], **live[b]}, hi=1, tag='inhabited spacing')
objective = {}
for (i, r), v in y.items():
    s = stars[i]
    if r == 'shadow': objective[v] = 2 - np.linalg.norm(P[i] - np.array(SHADOW_CENTRE)) / SHADOW_PULL; continue
    if s.get('catalog'): objective[v] = CATALOG_LIVE if r in ('inh', 'bloom', 'glass') else CATALOG_DEAD
    else: objective[v] = LIVE_SCORE.get(s['class'], .5) + NAMED_BONUS if r in ('inh', 'bloom', 'glass') else DEAD_SCORE.get(s['class'], .2)

lanes_on = STAGE in ('lanes', 'factions')
space = ('inner', 'middle', 'outer', 'exterior')
def reach(a, b):
    """A lane's longest: the farther end's ring or zone (the Bloom's and the Shadow's own for lanes into them)."""
    if Z[a] in space and Z[b] in space: return REACH[ring_of[a] if LY[a] > LY[b] else ring_of[b]]
    return max(REACH[Z[a]] if Z[a] not in space else 0, REACH[Z[b]] if Z[b] not in space else 0)
lo_deg = lambda i, r: SOL_DEGREE[0] if stars[i]['name'] == 'Sol' else DEGREE[r][0]
if lanes_on:
    # room for lanes: a chosen system needs at least its least lanes' worth of chosen stars within reach (the lane
    # model then picks the lanes among the chosen; choosing and laning in one model is too slow to solve)
    for i in cand:
        near = [int(j) for j in ca[(D[i, ca] <= 16) & (ca != i)] if D[i, int(j)] <= reach(i, int(j))]
        for r, v in roles_of[i]:
            m.add({**{k: 1 for j in near for k in x[j]}, v: -lo_deg(i, r)}, lo=0, tag='room for lanes')
    # and all in one piece: a flow from Sol over pairs within reach, through chosen stars only, each consuming a unit
    # (a cluster may hang off the map by a long way round: hard places to reach are welcome)
    sol_i = by_name['Sol']
    arcs = {}
    for a in cand:
        for b in ca[np.argsort(D[a, ca])][1:NEIGHBOURS + 1]:
            b = int(b)
            if D[a, b] <= reach(a, b):
                for s_, t_ in ((a, b), (b, a)):
                    if (s_, t_) not in arcs: arcs[s_, t_] = m.var(f'f{s_},{t_}', 0, len(cand))
    flow_cap = sum(INHABITED.values()) + sum(DEAD.values()) + DRIFT + BLOOM + BLOOM_DEAD + SHADOW + len(GLASS)
    for (s_, t_), v in arcs.items():
        m.add({v: 1, **{k: -flow_cap for k in x[s_]}}, hi=0); m.add({v: 1, **{k: -flow_cap for k in x[t_]}}, hi=0)
    net = {i: {} for i in cand}
    for (s_, t_), v in arcs.items(): net[t_][v] = net[t_].get(v, 0) + 1; net[s_][v] = net[s_].get(v, 0) - 1
    for i in cand:  # inflow - outflow = 1 when chosen (Sol: supplies the rest)
        if i == sol_i: continue
        m.eq({**net[i], **{k: -1 for k in x[i]}}, 0, tag=f'way in, {Z[i]}')
m.maximize(objective)
index = {s['id']: i for i, s in enumerate(stars)}
if REUSE:  # the systems as last chosen: each one's role from its group and status (and, for --drift-only, its lanes)
    prev = json.loads(out.read_text())
    ROLE = {('human', 'inhabited'): 'inh', ('human', 'dead'): 'dead', ('glass', 'glass'): 'glass', ('drift', 'dead'): 'drift',
            ('bloom', 'living'): 'bloom', ('bloom', 'dead'): 'bdead', ('shadow', 'held'): 'shadow', ('shadow', 'emptied'): 'shadow'}
    role = {index[c['star']]: ROLE[c['group'], c['status']] for c in prev['systems'] if not c.get('generated')}
    prev_by = {index[c['star']]: c for c in prev['systems'] if not c.get('generated')}
    print(f'map: {len(role)} systems from {out.relative_to(root)}')
else:
    print(f'map model (select{", with room for lanes" if lanes_on else ""}): {len(cand)} candidate stars, ' + m.size())
    try:
        S = m.solve(time_limit=TIME, gap=.02)
    except RuntimeError as err:
        print('  ' + str(err) + '; what cannot be met:', m.diagnose()); sys.exit(1)
    print('  ' + S.report())
    role = {i: r for (i, r), v in y.items() if S.on(v)}

# the lanes there could be: two chosen systems within reach, each among the other's nearest NEIGHBOURS
ch = np.array(sorted(role))
E = set()
for a in ch:
    for b in ch[np.argsort(D[a, ch])][1:NEIGHBOURS + 1]:
        a_, b_ = int(a), int(b)
        if D[a_, b_] <= reach(a_, b_): E.add((min(a_, b_), max(a_, b_)))
E = sorted(E)
near = {i: [] for i in role}
for a, b in E: near[a].append(b); near[b].append(a)
human = [i for i in role if role[i] in ('inh', 'dead')]
hset = set(human)
inh = [i for i in human if role[i] == 'inh']
sol_i = by_name['Sol']
held = lambda s_, rs: sum(1 for i in role if role[i] in rs and int(sector[i]) == s_)
blocked = {s_ for s_ in range(SECTORS) if held(s_, ('bloom', 'bdead', 'shadow')) >= held(s_, ('drift',))}

# ---------- the territory model: who holds what, before there are lanes ----------
# On the lanes there could be, so a territory is a coherent stretch of space rather than whatever a finished network
# happens to join: the lane model then gives each piece of territory lanes of its own.
owner, gateways, open_sectors, pieces, parts_of = {}, {}, [], {}, {}
if DRIFT_ONLY:  # the factions and lanes as last solved
    owner = {i: c['faction'] for i, c in prev_by.items() if c.get('faction')}
    gateways = {k: sorted(i for i, c in prev_by.items() if c.get('gateway') and c.get('faction') == k) for k in FRONTIER}
    open_sectors = prev.get('openSectors', [])
elif RELANE:  # the territories as last solved (the cache the territory model leaves)
    tc = json.loads(TERRITORY_CACHE.read_text())
    owner = {int(i): k for i, k in tc['owner'].items()}
    gateways, open_sectors = {k: v for k, v in tc['gateways'].items()}, tc['open']
    parts_of = tc['parts']
elif STAGE == 'factions':
    F = list(FACTIONS)
    f = Model()
    own = {(i, k): f.binary(f'o{i}{k}') for i in human for k in F}
    for i in inh:  # each inhabited system has one owner, in a ring that owner may hold
        f.eq({own[i, k]: 1 for k in F}, 1, tag='one owner')
        for k in F:
            if ring_of[i] not in FACTIONS[k]['rings']: f.fix(own[i, k], 0)
    for i in human:
        if role[i] == 'dead': f.add({own[i, k]: 1 for k in F}, hi=1)  # dead: claimed by one faction, or none
    for k, spec in FACTIONS.items():
        f.eq({own[i, k]: 1 for i in inh}, spec['n'], tag=f'{k} count')
        f.add({own[i, k]: 1 for i in inh if ring_of[i] == spec['home'][0]}, lo=spec['home'][1], tag=f'{k} home ring')
        if not spec['whole']:
            for i in human:
                if role[i] == 'dead': f.fix(own[i, k], 0)
    for (_, _, _, k), i in zip(MARCH, march): f.fix(own[i, k], 1)
    for n in FED_HOLDS: f.fix(own[by_name[n], 'federation'], 1)
    # held together over the lanes there could be: a flow from a root in each piece through the faction's own
    # systems, each consuming a unit; a piece beyond the first costs PIECE_COST
    M = 120
    roots = {}
    for k, spec in FACTIONS.items():
        if not spec['whole']: continue
        rt = {i: f.binary(f'r{i}{k}') for i in human}
        roots[k] = rt
        f.add({v: 1 for v in rt.values()}, lo=1)
        for i in human: f.add({rt[i]: 1, own[i, k]: -1}, hi=0)
        g = {}
        for a, b in E:
            if a in hset and b in hset:
                for s_, t_ in ((a, b), (b, a)):
                    g[s_, t_] = f.var(f'g{s_},{t_}{k}', 0, M)
                    f.add({g[s_, t_]: 1, own[s_, k]: -M}, hi=0); f.add({g[s_, t_]: 1, own[t_, k]: -M}, hi=0)
        for i in human:  # inflow - outflow >= own - M root
            expr = {own[i, k]: -1, rt[i]: M}
            for j in near[i]:
                if (j, i) in g: expr[g[j, i]] = expr.get(g[j, i], 0) + 1
                if (i, j) in g: expr[g[i, j]] = expr.get(g[i, j], 0) - 1
            f.add(expr, lo=0, tag=f'{k} held together')
    # the March is the Union's way in to the rest of its space (its region file): Brannock reaches, through
    # Union systems, at least MARCH_REACH of the Union's inhabited systems; a flow from Brannock, each system it
    # reaches taking a unit
    bran = march[[m_[0] for m_ in MARCH].index('brannock')]
    gb, zb = {}, {i: f.var(f'zb{i}', 0, 1) for i in human if i != bran}
    for i, v in zb.items(): f.add({v: 1, own[i, 'union']: -1}, hi=0)
    for a, b in E:
        if a in hset and b in hset:
            for s_, t_ in ((a, b), (b, a)):
                gb[s_, t_] = f.var(f'gb{s_},{t_}', 0, M)
                f.add({gb[s_, t_]: 1, own[s_, 'union']: -M}, hi=0); f.add({gb[s_, t_]: 1, own[t_, 'union']: -M}, hi=0)
    for i in zb:  # inflow - outflow = what i takes
        expr = {zb[i]: -1}
        for j in near[i]:
            if (j, i) in gb: expr[gb[j, i]] = expr.get(gb[j, i], 0) + 1
            if (i, j) in gb: expr[gb[i, j]] = expr.get(gb[i, j], 0) - 1
        f.eq(expr, 0, tag='the March joins the Union')
    f.add({zb[i]: 1 for i in inh if i in zb}, lo=MARCH_REACH, tag='the March joins the Union')
    # the open Drift: sectors whose edge the Bloom and the Shadow do not hold, at least MIN_OPEN open; each frontier
    # faction designates the same number of gateways, systems of its own that could have a lane into an open sector's
    # Drift (the lane model gives each one, and no other system, such a lane)
    print('  sectors held by the Bloom or the Shadow:', sorted(blocked), '; the March in sector', int(sector[march[0]]))
    o = {s_: f.binary(f'open{s_}') for s_ in range(SECTORS)}
    for s_ in blocked: f.fix(o[s_], 0)
    f.add({v: 1 for v in o.values()}, lo=MIN_OPEN, tag='open sectors')
    adj = {i: {int(sector[j]) for j in near[i] if role[j] == 'drift'} for i in human}
    gw = {}
    for i in human:
        if not adj[i]: continue
        for k in FRONTIER:  # a gateway: k's, and beside an open sector's Drift
            gw[i, k] = f.binary(f'gw{i}{k}')
            f.add({gw[i, k]: 1, own[i, k]: -1}, hi=0)
            f.add({gw[i, k]: 1, **{o[s_]: -1 for s_ in adj[i]}}, hi=0)
    A = f.var('access', MIN_GATEWAYS, 50, integer=True)
    for k in FRONTIER: f.eq({**{v: 1 for (i, kk), v in gw.items() if kk == k}, A: -1}, 0, tag=f'{k} gateways')
    # compact: each pair of neighbours (lanes there could be) split between a faction and anyone else costs, the more
    # the nearer they are
    obj = {A: 2}
    for a, b in E:
        if a in hset and b in hset:
            w = (.5 if role[a] == 'inh' and role[b] == 'inh' else .2) * 8 / max(D[a, b], 4)
            for k in F:
                cut = f.var(f'c{a},{b}{k}', 0, 1)
                f.add({cut: 1, own[a, k]: -1, own[b, k]: 1}, lo=0); f.add({cut: 1, own[b, k]: -1, own[a, k]: 1}, lo=0)
                obj[cut] = -w
    for i in human:
        if role[i] == 'dead':
            for k in F: obj[own[i, k]] = obj.get(own[i, k], 0) - .05
    for rt in roots.values():
        for v in rt.values(): obj[v] = obj.get(v, 0) - PIECE_COST
    for i in human:  # the navy holds the front: the systems that could have a lane to the Shadow
        if any(role[j] == 'shadow' for j in near[i]): obj[own[i, 'federation']] = obj.get(own[i, 'federation'], 0) + FRONT_BONUS
    # leaning toward a bearing: each system costs its angle off the faction's (dead ones, claimed as territory, less)
    for k, (sid, w) in BEARINGS.items():
        b = P[march[[m_[0] for m_ in MARCH].index(sid)]]; b = b / np.linalg.norm(b)
        for i in human:
            ang = float(np.arccos(np.clip(P[i] @ b / max(LY[i], 1e-9), -1, 1)))
            obj[own[i, k]] = obj.get(own[i, k], 0) - w * ang * (1 if role[i] == 'inh' else .3)
    f.maximize(obj)
    print(f'territory model: {len(inh)} inhabited and {len(human) - len(inh)} dead human systems, {len(E):,} lanes there could be, ' + f.size())
    try:
        T = f.solve(time_limit=TIME, gap=.03)
    except RuntimeError as err:
        print('  ' + str(err) + '; what cannot be met:', f.diagnose()); sys.exit(1)
    print('  ' + T.report())
    owner = {i: k for (i, k), v in own.items() if T.on(v)}
    open_sectors = [s_ for s_, v in o.items() if T.on(v)]
    gateways = {k: sorted(i for (i, kk), v in gw.items() if kk == k and T.on(v)) for k in FRONTIER}
    # each faction's pieces over the lanes there could be: the lane model joins each with lanes of its own
    for k in FACTIONS:
        if not FACTIONS[k]['whole']: continue
        mine, seen = {i for i in owner if owner[i] == k}, set()
        for i in mine:
            if i in seen: continue
            part, stack = [], [i]; seen.add(i)
            while stack:
                a = stack.pop(); part.append(a)
                for b in near[a]:
                    if b in mine and b not in seen: seen.add(b); stack.append(b)
            parts_of.setdefault(k, []).append(part)
    TERRITORY_CACHE.parent.mkdir(parents=True, exist_ok=True)
    TERRITORY_CACHE.write_text(json.dumps({'owner': {str(i): k for i, k in owner.items()}, 'gateways': gateways, 'open': open_sectors,
                                           'parts': {k: [[int(i) for i in p_] for p_ in v] for k, v in parts_of.items()}}))

# ---------- the lane model: lanes, knowing the territories ----------
lanes = []
if DRIFT_ONLY:
    lanes = [(index[l['a']], index[l['b']]) for l in prev['lanes'] if l['a'] in index and l['b'] in index]
elif lanes_on:
    # a lane joins two chosen systems among the lanes there could be; each system between its role's least and most
    # lanes; one piece, by a flow from Sol along the lanes with a unit for every system, each jump on the way costed
    # (JUMP_COST) so routes stay short without forbidding a long way round. With territories: each piece of a
    # faction's territory joined by lanes of its own, with loops inside (an inhabited system two lanes within its
    # territory, where it can), lanes inside a territory cheap and across a border dear, so borders cross at a few
    # choke points; every frontier faction with the same number of gateways into the open Drift
    L = Model()
    e = {ab: L.binary(f'e{ab}') for ab in E}
    inc = {i: [] for i in role}
    for ab in E: inc[ab[0]].append(e[ab]); inc[ab[1]].append(e[ab])
    for i, r in role.items():
        hi = SOL_DEGREE[1] if i == sol_i else DEGREE[r][1]
        L.add({v: 1 for v in inc[i]}, lo_deg(i, r), hi, tag=f'lanes per system, {r}')
    cap = len(role)
    fl, net = {}, {i: {} for i in role}
    for (a, b), v in e.items():
        for s_, t_ in ((a, b), (b, a)):
            fl[s_, t_] = L.var(f'f{s_},{t_}', 0, cap)
            L.add({fl[s_, t_]: 1, v: -cap}, hi=0)
            net[t_][fl[s_, t_]] = 1; net[s_][fl[s_, t_]] = -1
    for i in role:
        if i != sol_i: L.eq(net[i], 1, tag=f'way in, {Z[i]}')
    # each piece of territory joined by its own lanes (and the Shadow's pieces, so it holds a front): a flow from its
    # first system to the rest, inside the piece
    shadow_parts, seen_ = [], set()
    for i in role:
        if role[i] != 'shadow' or i in seen_: continue
        part, stack = [], [i]; seen_.add(i)
        while stack:
            a = stack.pop(); part.append(a)
            for b in near[a]:
                if role[b] == 'shadow' and b not in seen_: seen_.add(b); stack.append(b)
        shadow_parts.append(part)
    for k, parts in list(parts_of.items()) + [('shadow', shadow_parts)]:
        for n_, part in enumerate(parts):
            if len(part) < 2: continue
            pset, pn = set(part), {i: {} for i in part}
            for (a, b), v in e.items():
                if a in pset and b in pset:
                    for s_, t_ in ((a, b), (b, a)):
                        q_ = L.var(f'h{s_},{t_}', 0, len(part))
                        L.add({q_: 1, v: -len(part)}, hi=0)
                        pn[t_][q_] = 1; pn[s_][q_] = -1
            for i in part[1:]: L.eq(pn[i], 1, tag=f'{k} piece joined')
    # loops inside a territory: an inhabited system has two lanes within its territory, where it could
    for i in inh:
        if i not in owner: continue
        inside = [e[(min(i, j), max(i, j))] for j in near[i] if owner.get(j) == owner[i]]
        if inside: L.add({v: 1 for v in inside}, lo=min(2, len(inside)), tag='loops inside')
    # equal access to the open Drift: a frontier faction's gateway is a system of its own with a lane into an open
    # sector's Drift, and every frontier faction has the same number (the territory model made sure each could)
    zg = {}
    for i in owner:
        if owner[i] not in FRONTIER: continue
        into = [e[(min(i, j), max(i, j))] for j in near[i] if role[j] == 'drift' and int(sector[j]) in open_sectors]
        if not into: continue
        zg[i] = L.binary(f'z{i}')
        for v in into: L.add({zg[i]: 1, v: -1}, lo=0)
        L.add({zg[i]: 1, **{v: -1 for v in into}}, hi=0)
    AG = L.var('access', MIN_GATEWAYS, 50, integer=True)
    for k in FRONTIER: L.eq({**{zg[i]: 1 for i in zg if owner[i] == k}, AG: -1}, 0, tag=f'{k} gateways')
    # the Drift's edge: each sector at least DRIFT_BORDER lanes from human space into its Drift (or all it can have)
    for k in range(SECTORS):
        edge = [(a, b) for (a, b) in e if 'drift' in (role[a], role[b]) and {role[a], role[b]} & {'inh', 'dead'}
                and sector[a if role[a] == 'drift' else b] == k]
        ends = {a if role[a] == 'drift' else b for a, b in edge}
        if edge: L.add({e[ab]: 1 for ab in edge}, lo=min(DRIFT_BORDER, len(edge), 2 * len(ends)), tag=f'drift border {k}')
    def lane_cost(a, b):
        if owner and a in hset and b in hset:
            oa, ob = owner.get(a), owner.get(b)
            if oa and oa == ob: return D[a, b] * INSIDE_COST
            if oa or ob: return D[a, b] * BORDER_COST[0] + BORDER_COST[1]
        return D[a, b]
    L.minimize({**{v: lane_cost(a, b) for (a, b), v in e.items()}, **{v: JUMP_COST for v in fl.values()}})
    print(f'lane model: {len(role)} systems, {len(E):,} lanes there could be, ' + L.size())
    try:
        S2 = L.solve(time_limit=TIME, gap=.02)
    except RuntimeError as err:
        print('  ' + str(err) + '; what cannot be met:', L.diagnose()); sys.exit(1)
    print('  ' + S2.report())
    lanes = [ab for ab, v in e.items() if S2.on(v)]
    if zg: gateways = {k: sorted(i for i in zg if owner[i] == k and S2.on(zg[i])) for k in FRONTIER}

# ---------- the deep Drift: grown from the fringe ----------
grown = []  # generated stars: {'id', 'name', 'pos', 'ly', 'depth', 'sector'}
grown_lanes = []  # (a, b) by key: an int is a real star's index, a string 'g<n>' the nth generated star
depth, pos = {}, {}
if lanes:
    drng = random.Random(2526)
    nbr = {i: set() for i in role}
    for a, b in lanes: nbr[a].add(b); nbr[b].add(a)
    # the fringe's depth: jumps from human space through the Drift
    front = [i for i in role if role[i] in ('inh', 'dead', 'glass')]
    for i in front: depth[i] = 0
    while front:
        nxt = []
        for a in front:
            for b in nbr[a]:
                if role[b] == 'drift' and b not in depth: depth[b] = depth[a] + 1; nxt.append(b)
        front = nxt
    pos = {i: P[i] for i in role}
    taken = [P[i] for i in role]
    bloom_u = bloom_c / np.linalg.norm(bloom_c)
    def open_space(q):
        ly = np.linalg.norm(q)
        if ly > DRIFT_MAX_LY or np.linalg.norm(q - bloom_c) < BLOOM_R + 8: return False
        if ly > 60 and q @ bloom_u / ly > np.cos(np.radians(30)): return False  # the Bloom's sector, past its charted part
        if ly > SHADOW_FROM - 5 and q[0] / ly >= SHADOW_CONE - .05: return False  # the Shadow's
        return min(np.linalg.norm(q - t_) for t_ in taken) >= DRIFT_SEP
    level = [i for i in role if role[i] == 'drift']
    for d in range(1, DRIFT_DEPTH):
        drng.shuffle(level)
        nxt = []
        for a in level:
            if depth.get(a) != d: continue
            want = int(DRIFT_BRANCH[d]) + (drng.random() < DRIFT_BRANCH[d] % 1)
            pa = pos[a]; out_ = pa / np.linalg.norm(pa)
            for _ in range(want):
                for _try in range(16):
                    v = out_ + np.array([drng.gauss(0, .55) for _ in range(3)]); v /= np.linalg.norm(v)
                    q = pa + v * drng.uniform(*DRIFT_STEP[d + 1])
                    if np.linalg.norm(q) > np.linalg.norm(pa) + 2 and open_space(q): break
                else: continue
                key = f'g{len(grown)}'
                grown.append({'id': 9_000_000 + len(grown), 'name': f'DR-{len(grown) + 1:04d}', 'pos': [round(float(x), 3) for x in q],
                              'ly': round(float(np.linalg.norm(q)), 2), 'depth': d + 1,
                              'sector': int((np.degrees(np.arctan2(q[1], q[0])) % 360) // (360 / SECTORS))})
                pos[key] = q; taken.append(q); depth[key] = d + 1
                grown_lanes.append((a, key)); nxt.append(key)
        level = nxt + [k for k in level if depth.get(k, 0) > d]
    # loops: near the edge a Drift system often links to a neighbour of about its depth as well
    drift_keys = [i for i in role if role[i] == 'drift'] + [f'g{n}' for n in range(len(grown))]
    linked = {frozenset(ab) for ab in grown_lanes} | {frozenset(ab) for ab in lanes}
    for k in drift_keys:
        d = depth.get(k, 1)
        if drng.random() >= DRIFT_LOOP.get(d, 0): continue
        reach_ = DRIFT_STEP[min(d + 1, DRIFT_DEPTH)][1] + 2
        near = sorted((o for o in drift_keys if o != k and abs(depth.get(o, 1) - d) <= 1 and frozenset((k, o)) not in linked),
                      key=lambda o: np.linalg.norm(pos[o] - pos[k]))
        if near and np.linalg.norm(pos[near[0]] - pos[k]) <= reach_:
            grown_lanes.append((k, near[0])); linked.add(frozenset((k, near[0])))

# a faction's pieces: its systems joined by lanes through its own; the biggest (by inhabited systems) its main body,
# each other one an exclave of the faction's kind (EXCLAVE)
exclave = {}
if owner:
    nbr_h = {i: set() for i in role}
    for a, b in lanes: nbr_h[a].add(b); nbr_h[b].add(a)
    for k in EXCLAVE:
        mine, seen, parts = {i for i in owner if owner[i] == k}, set(), []
        for i in mine:
            if i in seen: continue
            part, stack = [], [i]; seen.add(i)
            while stack:
                a = stack.pop(); part.append(a)
                for b in nbr_h[a]:
                    if b in mine and b not in seen: seen.add(b); stack.append(b)
            parts.append(part)
        parts.sort(key=lambda p_: -sum(role[i] == 'inh' for i in p_))
        pieces[k] = len(parts)
        for p_ in parts[1:]:
            for i in p_: exclave[i] = EXCLAVE[k]

# ---------- write it ----------
GROUP = {'inh': 'human', 'dead': 'human', 'glass': 'glass', 'drift': 'drift', 'bloom': 'bloom', 'bdead': 'bloom', 'shadow': 'shadow'}
STATUS = {'inh': 'inhabited', 'dead': 'dead', 'glass': 'glass', 'drift': 'dead', 'bloom': 'living', 'bdead': 'dead', 'shadow': 'held'}
# jumps from Sol along the lanes, for the report and the map
hops = {by_name['Sol']: 0}
if lanes:
    nbr = {i: [] for i in role}
    for a, b in lanes: nbr[a].append(b); nbr[b].append(a)
    front = [by_name['Sol']]
    while front:
        nxt = []
        for a in front:
            for b in nbr[a]:
                if b not in hops: hops[b] = hops[a] + 1; nxt.append(b)
        front = nxt
names = {**{i: n for (_, n, _, _), i in zip(MARCH, march)}, **{i: n for n, i in zip(GLASS, glass)}}
name, reserve = namer()
for n in names.values(): reserve(n)
for i in role: reserve(stars[i]['name'])
lane_nb = {i: set() for i in role}
for a, b in lanes: lane_nb[a].add(b); lane_nb[b].add(a)
# the Shadow's systems nearest Sol were human, emptied as the front moved in; the human systems facing it, the front
emptied = sorted((i for i in role if role[i] == 'shadow'), key=lambda i: LY[i])[:EMPTIED] if lanes else []
front = {i for i in role if role[i] in ('inh', 'dead') and any(role[j] == 'shadow' for j in lane_nb[i])}
# emptied farthest first: Corran in 2521, then the front moved inward twice
emptied = emptied[::-1]
reserve('Corran')
for n_, i in enumerate(emptied): names[i] = 'Corran' if n_ == 0 else name('emptied')

# ---------- hazard stars, and the regions ----------
main = lambda i, k: owner.get(i) == k and i not in exclave  # in faction k's main body
centre = lambda ks: np.mean([P[i] for i in ks], axis=0) if ks else np.zeros(3)
dead_cat = [i for i in role if role[i] == 'dead' and stars[i].get('catalog')]
hazard = {}  # star index (or 'g<n>' for a grown Drift star) -> (name, class)
def pick(cands, anchor):
    cands = [i for i in cands if i not in hazard]
    return min(cands, key=lambda i: np.linalg.norm(P[i] - anchor)) if cands else None
corran = emptied[0] if emptied else None
where = {
    'lighthouse': lambda: pick([i for i in dead_cat if any(owner.get(j) == 'federation' for j in lane_nb[i]) and any(owner.get(j) == 'prism' for j in lane_nb[i])]
                               or [i for i in dead_cat if any(owner.get(j) == 'prism' for j in lane_nb[i])], np.zeros(3)),
    'furnace': lambda: pick([i for i in dead_cat if main(i, 'union')], centre([i for i in role if main(i, 'union')])),
    'beacon': lambda: pick([i for i in dead_cat if main(i, 'freeflag') or any(main(j, 'freeflag') for j in lane_nb[i])], centre([i for i in role if main(i, 'freeflag')])),
    'metronome': lambda: pick([i for i in dead_cat if any(j in front or role[j] == 'shadow' for j in lane_nb[i])], P[corran] if corran is not None else np.zeros(3)),
    'sink': lambda: pick([i for i in dead_cat if i not in owner and any(owner.get(j) == 'independent' for j in lane_nb[i])], centre([i for i in role if owner.get(i) == 'independent'])),
}
for hname, hclass, rule, _ in HAZARDS:
    if rule in where:
        i = where[rule]()
        if i is not None: hazard[i] = (hname, hclass); names[i] = hname; reserve(hname)
# the Maw: a grown Drift star four or five jumps out, in the open Drift
deep = [n for n, g_ in enumerate(grown) if g_['depth'] in (4, 5) and g_['sector'] in open_sectors]
if deep:
    mid = np.mean([pos[f'g{n}'] for n in deep], axis=0)
    maw = min(deep, key=lambda n: np.linalg.norm(pos[f'g{n}'] - mid))
    hazard[f'g{maw}'] = ('The Maw', 'black-hole'); grown[maw]['name'] = 'The Maw'

# the regions: each system's from what it is (the March, the Glass, the Inner Sphere, a faction's main body or its
# pieces apart, the Bloom, the Shadow, the Drift by sector), then the hazards' round them, then any system left (an
# unclaimed dead one) takes the region of its nearest neighbour along the lanes
region = {}
shadow_u = np.array(SHADOW_CENTRE) / np.linalg.norm(SHADOW_CENTRE)
open_name = {s_: OPEN_DRIFT[n % len(OPEN_DRIFT)] for n, s_ in enumerate(sorted(open_sectors))}
bloom_hops = {}
front_ = [i for i in role if role[i] in ('inh', 'dead', 'glass')]
for i in front_: bloom_hops[i] = 0
while front_:
    nxt = []
    for a in front_:
        for b in lane_nb[a]:
            if role[b] in ('bloom', 'bdead') and b not in bloom_hops: bloom_hops[b] = bloom_hops[a] + 1; nxt.append(b)
    front_ = nxt
bloom_sys = sorted((i for i in role if role[i] in ('bloom', 'bdead')), key=lambda i: bloom_hops.get(i, 99))
hedge = set(bloom_sys[int(len(bloom_sys) * (1 - HEDGE_SHARE)):])
for i, r_ in role.items():
    o = owner.get(i)
    if i in march: region[i] = 'calder-march'
    elif r_ == 'glass': region[i] = 'mirrorspace'
    elif r_ in ('inh', 'dead') and LY[i] <= INNER_SPHERE_LY: region[i] = 'inner-sphere'
    elif r_ in ('bloom', 'bdead'): region[i] = 'hedge' if i in hedge else 'garden'
    elif r_ == 'shadow': region[i] = 'corran-gate' if i in emptied else 'blightspace'
    elif r_ == 'drift': region[i] = open_name.get(int(sector[i]), 'drift')
    elif o == 'federation' and main(i, 'federation'):
        ang = np.degrees(np.arccos(np.clip(P[i] @ shadow_u / max(LY[i], 1e-9), -1, 1)))
        region[i] = 'long-watch' if ang < LONG_WATCH and LY[i] > 20 else 'concord'
    elif o == 'prism': region[i] = 'prism-inc' if main(i, 'prism') else 'prism-research'
    elif o == 'union': region[i] = 'anvil' if main(i, 'union') else 'iron-outposts'
    elif o == 'freeflag': region[i] = 'reach' if main(i, 'freeflag') else 'cells'
    elif o == 'independent': region[i] = 'margins'
    elif o == 'blackhulls': region[i] = 'blackspace'
for i in front: region[i] = 'corran-gate'
for i, (hname, _) in hazard.items():  # a hazard and its neighbours in its kind of space
    if isinstance(i, str): continue
    rk = next(h[3] for h in HAZARDS if h[0] == hname)
    region[i] = rk
    for j in lane_nb[i]:
        if role[j] in ('inh', 'dead') and j not in march and LY[j] > INNER_SPHERE_LY: region[j] = rk
left = [i for i in role if i not in region]
while left:  # the rest from their nearest neighbour with a region
    took = {i: next((region[j] for j in sorted(lane_nb[i], key=lambda j: D[i, j]) if j in region), None) for i in left}
    for i, rk in took.items():
        if rk: region[i] = rk
    if all(rk is None for rk in took.values()):
        for i in left: region[i] = 'drift' if role[i] == 'drift' else 'margins'
    left = [i for i in role if i not in region]
# the grown Drift: by sector, the Maw round its black hole (two jumps)
grown_region = {}
for n, g_ in enumerate(grown): grown_region[n] = open_name.get(g_['sector'], 'drift')
if deep:
    gnb = {}
    for a, b in grown_lanes: gnb.setdefault(a, set()).add(b); gnb.setdefault(b, set()).add(a)
    ring_ = {f'g{maw}'}
    for _ in range(2): ring_ |= {b for a in ring_ for b in gnb.get(a, ())}
    for k in ring_:
        if isinstance(k, str): grown_region[int(k[1:])] = 'the-maw'
# invented names: settled systems more often the farther out, in their owner's style; now and then a dead one; the
# Bloom's worlds by their surveyors' names
# a star with a proper name keeps it (Capella, Arcturus); one known by a designation (a catalogue number, or a Bayer
# or Flamsteed name like 58 Eridani) may be renamed by whoever lives there
nrng = random.Random(2526)
proper = lambda s: not s.get('catalog') and s['name'] not in (s.get('desig') or [])[:2] and not s['name'][:1].isdigit()
for i in sorted(role, key=lambda i: LY[i]):
    if i in names or proper(stars[i]) or stars[i]['name'] in PINNED: continue
    r_ = role[i]
    if r_ == 'inh' and nrng.random() < INVENT_SETTLED[ring_of[i]]: names[i] = name(owner.get(i, 'independent'))
    elif r_ == 'dead' and nrng.random() < INVENT_DEAD[ring_of[i]]: names[i] = name('claim')
    elif r_ == 'bloom': names[i] = name('bloom')
# when: settled systems in order of jumps from Sol and distance (Freeflag's and the Independents' late, marginal),
# placed on the Rush's curve; the Bloom charted after contact, nearest first
yrng = random.Random(2526)
def on_curve(n):
    for (n0, y0), (n1, y1) in zip(SETTLED, SETTLED[1:]):
        if n <= n1: return round(y0 + (y1 - y0) * (n - n0) / max(1, n1 - n0))
    return SETTLED[-1][1]
late = {'freeflag': 3, 'independent': 2, 'blackhulls': 2}
settled_order = sorted((i for i in role if (role[i] in ('inh', 'glass') or i in emptied) and stars[i]['name'] != 'Sol'),
                       key=lambda i: hops.get(i, 30) + LY[i] / 8 + late.get(owner.get(i), 0) + yrng.uniform(0, 3))
settled = {i: on_curve(n) for n, i in enumerate(settled_order)}
bloom_order = sorted((i for i in role if role[i] == 'bloom'), key=lambda i: hops.get(i, 30))
charted = {i: CONTACT + round((BLOOM_CHARTED - CONTACT) * n / max(1, len(bloom_order) - 1)) for n, i in enumerate(bloom_order)}
# a catalogue star's class, set by its role (the March's by its system file); a named star keeps its own
crng = random.Random(2526)
def set_class(i):
    if i in hazard: return hazard[i][1]
    if not stars[i].get('catalog'): return None
    if i in march: return MARCH[march.index(i)][2]
    w = ROLE_CLASSES[role[i]]
    return crng.choices(list(w), weights=list(w.values()))[0]
systems = []
for i in sorted(role, key=lambda i: LY[i]):
    c = {'star': stars[i]['id'], 'name': names.get(i, stars[i]['name']), 'group': GROUP[role[i]], 'status': STATUS[role[i]]}
    if i in names and names[i] != stars[i]['name'] and i not in march: c['provisional'] = True  # an invented name
    c['region'] = region.get(i, 'drift')
    if i in hazard: c['hazard'] = True
    if i in emptied: c['status'] = 'emptied'; c['emptied'] = EMPTIED_YEARS[emptied.index(i)]
    elif role[i] == 'shadow': c['seen'] = SHADOW_SEEN
    if i in front: c['front'] = True
    if i in settled: c['settled'] = settled[i]
    if i in charted: c['charted'] = charted[i]
    if role[i] == 'glass': c['lost'] = GLASS_LOST
    cls = set_class(i)
    if cls: c['class'], c['absmag'] = cls, ABSMAG[cls]
    if ring_of[i] in INHABITED: c['ring'] = ring_of[i]
    if i in hops and lanes: c['jumps'] = hops[i]
    if role[i] == 'drift': c['sector'] = int(sector[i]); c['depth'] = depth.get(i, 1)
    if i in exclave: c['exclave'] = exclave[i]
    if i in march: c['system'] = MARCH[march.index(i)][0]
    if i in owner: c['faction'] = owner[i]
    if any(i in g for g in gateways.values()): c['gateway'] = True
    systems.append(c)
for n_, g_ in enumerate(grown):  # the grown Drift: generated stars, their classes by the Drift's mix
    w = ROLE_CLASSES['drift']; cls = crng.choices(list(w), weights=list(w.values()))[0]
    if f'g{n_}' in hazard: cls = hazard[f'g{n_}'][1]
    g_.update({'class': cls, 'absmag': ABSMAG[cls], 'catalog': True, 'generated': True})
    systems.append({'star': g_['id'], 'name': g_['name'], 'group': 'drift', 'status': 'dead', 'generated': True,
                    'sector': g_['sector'], 'depth': g_['depth'], 'class': cls, 'absmag': ABSMAG[cls], 'region': grown_region[n_],
                    **({'hazard': True} if f'g{n_}' in hazard else {})})
lo_ly = min((D[a, b] for a, b in lanes), default=0)
days = lambda ly: round(1 + 2 * min(1, (ly - lo_ly) / (REACH['outer'] - lo_ly)), 1)
lane_list = [{'a': stars[a]['id'], 'b': stars[b]['id'], 'ly': round(float(D[a, b]), 2), 'days': days(D[a, b])} for a, b in lanes]
for l, (a, b) in zip(lane_list, lanes):  # a choke point: a lane across a border, out of a faction's territory
    if a in hset and b in hset and owner.get(a) != owner.get(b) and (owner.get(a) or owner.get(b)) \
            and (FACTIONS.get(owner.get(a), {}).get('whole') or FACTIONS.get(owner.get(b), {}).get('whole')): l['border'] = True
gid = lambda k: 9_000_000 + int(k[1:]) if isinstance(k, str) else stars[k]['id']
for a, b in grown_lanes:  # Drift lanes shift (the Book): the map marks them
    ly = float(np.linalg.norm(pos[a] - pos[b]))
    lane_list.append({'a': gid(a), 'b': gid(b), 'ly': round(ly, 2), 'days': days(ly), 'drift': True})
meta = {'source': 'tools/galaxy.py from stars.json; star ids are stars.json ids', 'stage': STAGE,
        'factions': {k: v['name'] for k, v in FACTIONS.items()}, 'sectors': SECTORS, 'openSectors': open_sectors,
        'regions': {k: REGIONS[k] for k in sorted(set(region.values()) | set(grown_region.values()))}}
out.write_text(json.dumps(meta)[:-1] + ',\n"generated":[\n' + ',\n'.join(json.dumps(g_, separators=(',', ':')) for g_ in grown) + '\n],\n"systems":[\n' + ',\n'.join(json.dumps(c, ensure_ascii=False, separators=(',', ':')) for c in systems)
               + '\n],\n"lanes":[\n' + ',\n'.join(json.dumps(l, separators=(',', ':')) for l in lane_list) + '\n]}\n')

tally = {}
for c in systems: k = (c['group'], c['status'], c.get('ring', '')); tally[k] = tally.get(k, 0) + 1
print(f'galaxy: {len(systems)} systems, {len(lane_list)} lanes -> {out.relative_to(root)}')
for k in sorted(tally): print('  ' + ' '.join(x for x in k if x).ljust(28), tally[k])
if lane_list:
    L = sorted(l['ly'] for l in lane_list)
    print(f'  lanes {L[0]:.1f} to {L[-1]:.1f} ly, median {L[len(L) // 2]:.1f}')
    for z, target in HOPS.items():
        js = [hops[i] for i in role if (ring_of[i] if Z[i] in space else Z[i]) == z]
        if js: print(f"  jumps from Sol, {z}: up to {max(js)} (target {target}), {sum(j > target for j in js)} past it, mean {sum(js) / len(js):.1f}")
print('  march spread', round(float(max(D[a, b] for a in march for b in march)), 1), 'ly:', ', '.join(f"{n} on {stars[i]['name']}" for (_, n, _, _), i in zip(MARCH, march)))
if owner:
    for k, spec in FACTIONS.items():
        mine = [i for i in owner if owner[i] == k]
        rings = {r: sum(1 for i in mine if role[i] == 'inh' and ring_of[i] == r) for r in INHABITED}
        dead = sum(1 for i in mine if role[i] == 'dead')
        gw_txt = f", gateways {len(gateways[k])}" if k in gateways else ''
        pc_txt = f", in {pieces[k]} piece{'s' if pieces[k] > 1 else ''}" if k in pieces else ''
        print(f"  {spec['name']:<18} inhabited {sum(rings.values())} ({', '.join(f'{r} {n}' for r, n in rings.items())}), dead claimed {dead}{pc_txt}{gw_txt}")
    print('  open Drift sectors:', open_sectors, '; border lanes (choke points):', sum(1 for l in lane_list if l.get('border')))
if region:
    from collections import Counter
    rc = Counter(c['region'] for c in systems)
    print('  regions:', ', '.join(f"{REGIONS[k]} {n}" for k, n in rc.most_common()))
    print('  hazards:', ', '.join(f"{h[0]} ({h[1]}) at {stars[i]['name'] if not isinstance(i, str) else grown[int(i[1:])]['id']}" for i, h in hazard.items()))
if grown:
    from collections import Counter
    dc = Counter(c['depth'] for c in systems if c['group'] == 'drift')
    print(f"  the Drift: {sum(dc.values())} systems ({len(grown)} grown), {sum(1 for l in lane_list if l.get('drift'))} grown lanes; by depth "
          + ', '.join(f'{d}: {dc[d]}' for d in sorted(dc)))
    print('  Drift by sector:', dict(sorted(Counter(c['sector'] for c in systems if c['group'] == 'drift').items())))
