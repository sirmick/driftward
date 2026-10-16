"""The galaxy's worlds: every inhabited system's population and settlement tier, its ports and their economic roles, and
its wealth, security and unrest, from the map (src/galaxy/galaxy.json, tools/galaxy.py) into src/galaxy/worlds.json,
keyed by star id, so a galaxy rerun keeps what is still there. Seeded: the same map gives the same worlds.

Population (the Book's Population and colonies): a system's people are the sum of its bodies, from an outwatch of about
a thousand up to a few billion; some planets are very small. Ordered within each ring by how long it has been settled,
its star, its lanes and its owner (Freeflag and the Independents live thin), then placed on the ring's span (POP_SPAN,
log10 people). There are only six Builtworlds in human space, whole planets built over, about ten billion each: Earth,
Sol's only one, and the great old worlds of the first settlements (BUILTWORLDS), each one more planet's people on top. Sol and the Calder
March are fixed (the March's region file).

Economy: a port's role sets what it makes and needs (src/economy.json: 'low' it makes, 'high' it needs). Each system has
ports by its tier; their roles come from a MIP (tools/mip.py): across the galaxy every commodity's supply meets its
demand (a system's people eat, drink, burn fuel, and use goods and medicine), while each region of three or more
settled systems has a commodity it exports and one it must import, so trade runs between regions; roles follow their
owner's character (FACTION_ROLES), and some only certain owners hold (havens the outlaws, the military the powers).
The March keeps its system files' roles.

Wealth, security and unrest (0 to 100), from the ring, the owner, the front and the choke points.

Usage: python3 tools/worlds.py [--time SECONDS]
"""
import json, math, pathlib, random, sys
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from mip import Model
from universe import galaxy_hash

root = pathlib.Path(__file__).resolve().parent.parent
G = json.loads((root / 'src' / 'galaxy' / 'galaxy.json').read_text())
STARS = {s['id']: s for s in json.loads((root / 'src' / 'galaxy' / 'stars.json').read_text())['stars']}
for g in G.get('generated', []): STARS[g['id']] = g
ECON = json.loads((root / 'src' / 'economy.json').read_text())
out = root / 'src' / 'galaxy' / 'worlds.json'
args = sys.argv[1:]
TIME = float(args[args.index('--time') + 1]) if '--time' in args else 120
rng = random.Random(2526)

# ---------- the numbers ----------
# each ring's span of people per settled system (log10), from the most to the fewest
POP_SPAN = {'inner': (9.8, 8.4), 'middle': (9.6, 6.0), 'outer': (8.6, 3.0)}
# fixed: Sol (Earth's Builtworld and the rest of the system), the March (its region file)
FIXED_POP = {'Sol': 13e9, 'Brannock': 4e9, 'Ostry': 150e6, 'Calder': 900e6, 'Merrow': 7.5e9, 'Serein': 2.8e9, 'Quire': 600e6}
STAR_HOME = {'yellow': 1, 'orange': .8, 'white': .6, 'red-dwarf': .2, 'red-giant': .3, 'white-dwarf': 0, 'blue-giant': .1}
OWNER_POP = {'federation': .3, 'prism': .4, 'ironhulls': .1, 'freeflag': -.8, 'independent': -.7, 'blackhulls': -1}
# settlement tiers by people (the Book's, at the setting's scale), and how many ports each has
TIERS = [('outwatch', 3e3, 1), ('outpost', 3e4, 1), ('colony', 1e6, 2), ('town', 1e8, 2), ('world', math.inf, 3)]
# the six Builtworlds in human space: Earth, and the great old worlds of the first settlements (Prism's at 61 Cygni);
# the people on one
BUILTWORLDS, BUILTWORLD = ['Sol', 'Alpha Centauri', 'Tau Ceti', 'Epsilon Eridani', 'Procyon', '61 Cygni'], 1e10
# what each owner likes to build (an objective weight per role), and who may hold a role at all
FACTION_ROLES = {
    'federation':   {'agri': 1.2, 'habitat': 1, 'container-port': 1, 'military': 1.2, 'shipyard': .8, 'relay': .8, 'forge': .4, 'research': .5},
    'ironhulls':  {'mining': 1.5, 'refinery': 1.3, 'forge': 1.2, 'ice': 1, 'gas': 1, 'shipyard': .9, 'habitat': .5},
    'prism': {'research': 1.6, 'forge': 1, 'relay': 1, 'habitat': .8, 'shipyard': .5},
    'freeflag':  {'ice': 1, 'gas': 1, 'agri': .8, 'haven': 1.2, 'mining': .8},
    'independent': {'mining': 1, 'ice': 1, 'gas': 1, 'agri': .8, 'haven': .6, 'habitat': .4},
    'blackhulls': {'haven': 1.6, 'gas': .6, 'ice': .6},
}
ONLY = {'haven': {'freeflag', 'independent', 'blackhulls'}, 'military': {'federation', 'ironhulls', 'prism'}, 'research': {'federation', 'prism', 'ironhulls'}}
NEEDS = {'food': .5, 'water': .4, 'goods': .3, 'medicine': .2, 'fuel': .25}  # what people (and their ships) use, per unit of a system's size
# what a port makes of a commodity, per unit of its system's size: staples in bulk (a farm world feeds many), finished
# goods less; and what a port needs of a commodity it uses
PRODUCE = {'food': 4, 'water': 3, 'fuel': 3, 'goods': 3, 'medicine': 3, 'components': 3, 'ore': 2, 'metals': 2, 'chemicals': 2, 'alloys': 2}
INDUSTRY = .5
# the rare roles: at most this many in the galaxy, and only in systems this big
RARE = {'shipyard': (12, 'world'), 'military': (20, 'town'), 'relay': (14, 'town'), 'research': (22, 'town')}
SUPPLY = .9        # every commodity's galactic supply at least this share of its demand
EDGE = .5          # a region's export: a surplus of at least this; its import: a shortfall of at least this
MARCH_ROLES = {'Brannock': ['mining', 'habitat', 'refinery', 'shipyard'], 'Calder': ['habitat', 'military', 'container-port'],
               'Merrow': ['agri', 'container-port'], 'Serein': ['research'], 'Quire': ['forge', 'relay'], 'Ostry': ['ice', 'gas']}

# ---------- the map ----------
systems = G['systems']
by_star = {c['star']: c for c in systems}
nb = {c['star']: set() for c in systems}
for l in G['lanes']:
    if l['a'] in nb and l['b'] in nb: nb[l['a']].add(l['b']); nb[l['b']].add(l['a'])
border = {s for l in G['lanes'] if l.get('border') for s in (l['a'], l['b'])}
settled = [c for c in systems if c['status'] == 'inhabited']

# ---------- populations ----------
pop = {}
for ring, (hi, lo) in POP_SPAN.items():
    here = [c for c in settled if c.get('ring') == ring]
    def weight(c):
        cls = c.get('class') or STARS[c['star']]['class']
        return ((2526 - c.get('settled', 2176)) / 350 * 2 + STAR_HOME.get(cls, 0) + .1 * len(nb[c['star']])
                + OWNER_POP.get(c.get('faction'), 0) + rng.gauss(0, .4))
    here.sort(key=weight, reverse=True)
    for n, c in enumerate(here):
        f = n / max(1, len(here) - 1)
        pop[c['star']] = 10 ** (hi + (lo - hi) * f + rng.gauss(0, .15))
for c in settled:
    if c['name'] in FIXED_POP: pop[c['star']] = FIXED_POP[c['name']]
# the Builtworlds: one more planet's people on each system that has one (Sol's are fixed with Earth's)
built = {c['star'] for c in settled if c['name'] in BUILTWORLDS}
for s in built:
    if by_star[s]['name'] not in FIXED_POP: pop[s] += BUILTWORLD
def tier(p):
    return next(t for t in TIERS if p < t[1])
size = {s: max(.3, math.log10(p) / 10) for s, p in pop.items()}  # a system's weight in the economy: 1k 0.3, 10 billion 1

# ---------- economy ----------
roles = [r for r in ECON['roles']]
goods = [c['id'] for c in ECON['commodities']]
make = {r: {c: (1 if t == 'low' else -1 if t == 'high' else 0) for c, t in ECON['roles'][r].items()} for r in roles}
m = Model()
x = {}
for c in settled:
    s, owner = c['star'], c.get('faction')
    ports = len(MARCH_ROLES[c['name']]) if c['name'] in MARCH_ROLES else tier(pop[s])[2] + (1 if s in built else 0)
    for r in roles:
        if r in ONLY and owner not in ONLY[r]: continue
        x[s, r] = m.binary(f'x{s}{r}')
    m.eq({x[s, r]: 1 for r in roles if (s, r) in x}, min(ports, sum(1 for r in roles if (s, r) in x)), tag='ports')
    if c['name'] in MARCH_ROLES:
        for r in roles:
            if (s, r) in x: m.fix(x[s, r], 1 if r in MARCH_ROLES[c['name']] else 0)
tier_rank = {t[0]: n for n, t in enumerate(TIERS)}
m.add({v: 1 for (s, rr), v in x.items() if rr == 'shipyard'}, lo=8, tag='enough shipyards')
for r, (most, least) in RARE.items():  # the rare roles: few, and in big systems
    m.add({v: 1 for (s, rr), v in x.items() if rr == r}, hi=max(most, sum(1 for c in settled if r in MARCH_ROLES.get(c['name'], []))), tag=f'{r} rare')
    for (s, rr), v in x.items():
        if rr == r and tier_rank[tier(pop[s])[0]] < tier_rank[least] and r not in MARCH_ROLES.get(by_star[s]['name'], []): m.fix(v, 0)
def flows(sys_list, g):
    """A commodity over some systems: what their ports make, what their ports need (expressions), and what their
    people need (a constant)."""
    made, used, people = {}, {}, 0.0
    for c in sys_list:
        s = c['star']
        for r in roles:
            if (s, r) not in x: continue
            if make[r].get(g) == 1: made[x[s, r]] = made.get(x[s, r], 0) + PRODUCE[g] * size[s]
            if make[r].get(g) == -1: used[x[s, r]] = used.get(x[s, r], 0) + INDUSTRY * size[s]
        people += NEEDS.get(g, 0) * size[s]
    return made, used, people
def net(sys_list, g):
    """A commodity's net (made less needed) over some systems: an expression and a constant."""
    made, used, people = flows(sys_list, g)
    expr = dict(made)
    for v, a in used.items(): expr[v] = expr.get(v, 0) - a
    return expr, -people
for g in goods:  # the galaxy: every commodity's supply at least SUPPLY of its demand (a surplus is traded or stocked)
    made, used, people = flows(settled, g)
    expr = dict(made)
    for v, a in used.items(): expr[v] = expr.get(v, 0) - SUPPLY * a
    m.add(expr, lo=SUPPLY * people, tag=f'balance {g}')
regions = {}
for c in settled: regions.setdefault(c['region'], []).append(c)
ident = {}
for rg, here in regions.items():  # a region's trade: something it exports and something it must import
    if len(here) < 3: continue
    ex, im = {}, {}
    for g in goods:
        expr, const = net(here, g)
        big = sum(abs(v) for v in expr.values()) + abs(const) + 10
        ex[g] = m.binary(f'ex{rg}{g}'); im[g] = m.binary(f'im{rg}{g}')
        m.add({**expr, ex[g]: -big}, lo=EDGE - const - big)   # exporting g: net >= EDGE
        m.add({**expr, im[g]: big}, hi=-EDGE - const + big)   # importing g: net <= -EDGE
    m.add({v: 1 for v in ex.values()}, lo=1, tag=f'{rg} exports'); m.add({v: 1 for v in im.values()}, lo=1, tag=f'{rg} imports')
    ident[rg] = (ex, im)
obj = {}
for (s, r), v in x.items():
    c = by_star[s]
    w = FACTION_ROLES.get(c.get('faction'), {}).get(r, 0)
    if r in ('container-port', 'military') and s in border: w += .8   # choke points: ports and garrisons
    if r == 'relay' and len(nb[s]) >= 4: w += .6                      # hubs: relays
    if r == 'habitat' and s in built: w += 1                          # Builtworlds: habitats
    if r in ('agri', 'mining', 'ice', 'gas') and s in built: w -= .6
    obj[v] = w + rng.uniform(0, .3)
m.maximize(obj)
print(f'economy model: {len(settled)} settled systems, {len(regions)} regions, ' + m.size())
try:
    S = m.solve(time_limit=TIME, gap=.02)
except RuntimeError as err:
    print('  ' + str(err) + '; what cannot be met:', m.diagnose()); sys.exit(1)
print('  ' + S.report())
role_of = {c['star']: [r for r in roles if (c['star'], r) in x and S.on(x[c['star'], r])] for c in settled}

# ---------- wealth, security, unrest ----------
SEC = {'inner': 80, 'middle': 60, 'outer': 35}
SEC_OWNER = {'federation': 10, 'prism': 8, 'ironhulls': 0, 'freeflag': -15, 'independent': -20, 'blackhulls': -30}
UNREST = {'federation': 20, 'prism': 15, 'ironhulls': 35, 'freeflag': 70, 'independent': 45, 'blackhulls': 50}
mirror = {c['star'] for c in systems if c['region'] == 'mirrorspace'}
clamp = lambda v: int(max(0, min(100, round(v))))
worlds = {}
for c in settled:
    s, o = c['star'], c.get('faction')
    near_glass = any(n in mirror for n in nb[s])
    sec = SEC[c['ring']] + SEC_OWNER.get(o, 0) + (10 if c.get('front') else 0) - (5 if s in border else 0) + rng.uniform(-6, 6)
    unrest = UNREST.get(o, 30) + (10 if c['ring'] == 'outer' else 0) + (12 if near_glass and o == 'ironhulls' else 0) + rng.uniform(-8, 8)
    wealth = 20 + 6 * math.log10(pop[s]) + sum(8 for r in role_of[s] if r in ('research', 'shipyard', 'container-port', 'relay')) - (10 if o in ('freeflag', 'independent', 'blackhulls') else 0) + rng.uniform(-5, 5)
    t = tier(pop[s])
    worlds[str(s)] = {'population': int(pop[s]), 'tier': t[0], **({'builtworld': True} if s in built else {}),
                      'roles': role_of[s], 'wealth': clamp(wealth), 'security': clamp(sec), 'unrest': clamp(unrest)}
trade = {}
for rg, (ex, im) in ident.items():
    here = regions[rg]
    nets = {g: S.value(net(here, g)[0]) + net(here, g)[1] for g in goods}
    trade[rg] = {'exports': [g for g in goods if nets[g] >= EDGE], 'imports': [g for g in goods if nets[g] <= -EDGE],
                 'population': int(sum(pop[c['star']] for c in here))}
# the galaxy these worlds were made from (tools/universe.py): a galaxy rerun shows them stale until this runs again
out.write_text(json.dumps({'source': 'tools/worlds.py from galaxy.json; keyed by star id', 'galaxy': galaxy_hash(G), 'regions': trade, 'systems': worlds}, separators=(',', ':')) + '\n')

total = sum(pop.values())
print(f'worlds: {len(worlds)} settled systems, {total / 1e9:,.0f} billion people -> {out.relative_to(root)}')
from collections import Counter
print('  tiers:', dict(Counter(w['tier'] for w in worlds.values())), '; Builtworlds:', ', '.join(by_star[s]['name'] for s in built))
print('  roles:', dict(Counter(r for w in worlds.values() for r in w['roles']).most_common()))
for rg in ('inner-sphere', 'calder-march', 'reach'):
    if rg in trade: print(f"  {rg}: {trade[rg]['population'] / 1e9:,.1f} billion; exports {trade[rg]['exports']}, imports {trade[rg]['imports']}")
