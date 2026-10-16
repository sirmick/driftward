"""Bullet-point backstories for the galaxy's systems, a region at a time, written by a model through OpenRouter from the
systems' facts (the Book: sim decides, LLM narrates). Facts come from src/galaxy/galaxy.json (who holds it, its region,
when it was settled, its lanes, hazards, the front) and src/galaxy/worlds.json (its people, ports and their roles,
wealth, security, unrest, and the region's trade); the setting (src/lore/setting.md) and the region's notes
(src/lore/regions/<region>.md, if any) go with them as canon. One call per region, so neighbours agree.

Each settled system gets three to six bullets (how it was founded, what it is known for, what is wrong there now, and
one thread a captain could pull); each notable dead system (a hazard, a choke point, one the Shadow emptied, one of
Mirrorspace, or any dead system in a small region) one or two; the region a short summary. The answer is checked
against the facts' systems and the limits, and asked again with the problems if it fails. Results merge into
src/galaxy/stories.json; every call's prompt, model and cost go to src/galaxy/stories.log.json.

Usage: python3 tools/stories.py <region,...|all> [--dry] [--model M]
  --dry   print the prompt and a cost estimate; no call, no key needed
The key: OPENROUTER_API_KEY, else openrouter.token here (gitignored), else ~/openrouter.token.
"""
import datetime, json, os, pathlib, re, sys, time
import requests

root = pathlib.Path(__file__).resolve().parent.parent
args = sys.argv[1:]
if not args or args[0].startswith('--'): print(__doc__); sys.exit(1)
DRY = '--dry' in args
MODEL = args[args.index('--model') + 1] if '--model' in args else 'anthropic/claude-sonnet-5.5'
G = json.loads((root / 'src' / 'galaxy' / 'galaxy.json').read_text())
W = json.loads((root / 'src' / 'galaxy' / 'worlds.json').read_text())
STARS = {s['id']: s for s in json.loads((root / 'src' / 'galaxy' / 'stars.json').read_text())['stars']}
for g in G.get('generated', []): STARS[g['id']] = g
SETTING = (root / 'src' / 'lore' / 'setting.md').read_text()
store_file, log_file = root / 'src' / 'galaxy' / 'stories.json', root / 'src' / 'galaxy' / 'stories.log.json'
REGION_NAMES, FACTIONS = G.get('regions', {}), G.get('factions', {})
BULLETS, DEAD_BULLETS, SUMMARY, WORDS = (3, 6), (1, 2), (3, 5), 30

systems = G['systems']
by_star = {c['star']: c for c in systems}
nb = {c['star']: [] for c in systems}
for l in G['lanes']:
    if l['a'] in nb and l['b'] in nb: nb[l['a']].append((l['b'], l)); nb[l['b']].append((l['a'], l))
regions = sorted({c['region'] for c in systems if c.get('region')}) if args[0] == 'all' else args[0].split(',')
for r in regions:
    if r not in REGION_NAMES: sys.exit(f'stories: no region {r} (the regions: {", ".join(sorted(REGION_NAMES))})')

def people(n):
    return f'about {n / 1e9:.0f} billion' if n >= 1e10 else f'about {n / 1e9:.1f} billion' if n >= 1e9 else \
        f'about {n / 1e6:.0f} million' if n >= 1e6 else f'about {n / 1e3:.0f} thousand' if n >= 1e3 else f'about {n}'

def facts(c):
    """One system's facts, as the model sees them."""
    s, w, star = c['star'], W['systems'].get(str(c['star'])), STARS[c['star']]
    f = {'id': s, 'name': c['name'], 'star': (c.get('class') or star['class']).replace('-', ' '),
         'catalogue name': star['name'] if star['name'] != c['name'] else None,
         'status': c['status'], 'held by': FACTIONS.get(c.get('faction')), 'ring': c.get('ring'),
         'settled': c.get('settled'), 'distance from Sol (ly)': round(star['ly']), 'jumps from Sol': c.get('jumps')}
    if w:
        f.update({'people': people(w['population']), 'settlement': w['tier'] + (' with a Builtworld (a whole planet built over into one city; one of only six in human space)' if w.get('builtworld') else ''),
                  'ports by role': w['roles'], 'wealth, security, unrest (0-100)': [w['wealth'], w['security'], w['unrest']]})
    for k, v in (('charted by human surveyors in', c.get('charted')), ('the Shadow seen here from', c.get('seen')), ('Drift depth (jumps from human space)', c.get('depth')),
                 ('hazard star', c.get('hazard')), ('faces the Shadow (the front)', c.get('front')), ("cut off from its owner's main territory", c.get('exclave')),
                 ('a gateway into the open Drift', c.get('gateway')), ('emptied by the Shadow in', c.get('emptied')), ('went glass in', c.get('lost'))):
        if v: f[k] = v
    lanes = []
    for o, l in sorted(nb[c['star']], key=lambda t: t[1]['ly']):
        oc = by_star[o]
        lanes.append(f"{oc['name']} ({REGION_NAMES.get(oc.get('region'), '?')}, {FACTIONS.get(oc.get('faction'), oc['status'])}, {l['days']} days{', across a border: a choke point' if l.get('border') else ''})")
    f['lanes to'] = lanes
    return {k: v for k, v in f.items() if v not in (None, [], '')}

def notable(c, small):
    return c['status'] != 'inhabited' and (small or c.get('hazard') or c.get('front') or c['status'] in ('emptied', 'glass')
                                           or any(l.get('border') for _, l in nb[c['star']]))

DRIFT_PICK = 6  # a Drift sector's systems told: its hazards, its way in from human space, then its deepest
def region_job(rk):
    here = [c for c in systems if c.get('region') == rk]
    settled = [c for c in here if c['status'] in ('inhabited', 'living')]  # people, or the Bloom's living worlds
    small = len(here) <= 12
    if here and all(c['group'] == 'drift' for c in here):
        human = lambda c: any(by_star[o]['group'] not in ('drift',) for o, _ in nb[c['star']])
        dead = sorted(here, key=lambda c: (not c.get('hazard'), not human(c), -(c.get('depth') or 0)))[:DRIFT_PICK]
    else:
        dead = [c for c in here if c not in settled and (notable(c, small) or c['status'] == 'held')]
    trade = W['regions'].get(rk, {})
    neighbours = sorted({REGION_NAMES.get(by_star[o].get('region')) for c in here for o, _ in nb[c['star']] if by_star[o].get('region') != rk} - {None})
    notes = root / 'src' / 'lore' / 'regions' / f'{rk}.md'
    region = {'name': REGION_NAMES[rk], 'settled systems': len(settled), 'dead systems': len(here) - len(settled),
              'people': people(trade['population']) if trade.get('population') else None,
              'exports': trade.get('exports'), 'imports': trade.get('imports'), 'borders': neighbours}
    return here, settled, dead, {k: v for k, v in region.items() if v}, notes.read_text() if notes.exists() else None

RULES = f"""You write short backstories for the star systems of one region of Driftward, an Escape Velocity-style space trading game. The simulation decides; you narrate.
Rules:
- Everything must agree with the facts given: who holds each system, when it was settled, its people, its ports' roles, its lanes and neighbours. The setting is canon: use its names and dates, and let its history and recent events reach these systems as far as trade and news would carry them. The region's notes, when given, are canon too.
- Each settled system (or living Bloom world): {BULLETS[0]} to {BULLETS[1]} bullets: how and when it was founded (and by whom, within the setting), what it is known for (from its ports' roles and its people), what is wrong there now (from its unrest, security, wealth, its neighbours and the setting), and one thread a captain could pull. Each listed dead system: {DEAD_BULLETS[0]} or {DEAD_BULLETS[1]} bullets: why nobody lives there, or what is there anyway. The region: {SUMMARY[0]} to {SUMMARY[1]} bullets on what it is, what it trades, and what binds or divides it.
- The Bloom's living worlds are not human: write what human surveyors have charted since contact in 2376, what they see there, and what the Accord lets them do (no weapons hot near a living world, no taking anything that grows, no torch through a seeding). The Shadow's systems are known only from navy pickets and survivors: write what was seen, and leave the rest unknown. Drift systems are uncharted or barely charted: write what surveyors and salvagers report.
- A bullet is one sentence of at most {WORDS} words. No prices, credit amounts or game rules; populations only roughly, as the facts give them. Hazard stars are real dangers (radiation, a deep well). Builtworlds are whole planets built over into cities.
- Tone: grounded, worn, working-class science fiction; specific; dry humour allowed; no prophecy, no chosen ones. British English. Vary the openings: not every bullet starts with the system's name.
- Answer with JSON only: {{"region": ["..."], "systems": [{{"id": <the system's id>, "bullets": ["..."]}}]}}, one entry for every system listed, using the ids given."""

def prompt(rk, feedback=None):
    here, settled, dead, region, notes = region_job(rk)
    user = (f"The setting (canon):\n{SETTING}\n\n" + (f"The region's notes (canon):\n{notes}\n\n" if notes else '')
            + f"The region:\n{json.dumps(region, ensure_ascii=False, indent=1)}\n\n"
            + f"Its settled systems:\n{json.dumps([facts(c) for c in settled], ensure_ascii=False, indent=1)}\n\n"
            + (f"Its notable dead systems:\n{json.dumps([facts(c) for c in dead], ensure_ascii=False, indent=1)}\n\n" if dead else '')
            + 'Write the region summary and every listed system\'s bullets.')
    if feedback: user += f'\n\nYour last answer had problems; fix them all:\n{feedback}'
    return [{'role': 'system', 'content': RULES}, {'role': 'user', 'content': user}], settled, dead

def check(raw, settled, dead):
    """The problems with an answer (an empty list: it passes)."""
    problems = []
    try: d = json.loads(re.sub(r'^```(json)?|```$', '', raw.strip(), flags=re.M))
    except Exception as e: return [f'not valid JSON: {e}'], None
    want = {c['star']: (BULLETS if c in settled else DEAD_BULLETS) for c in settled + dead}
    got = {e.get('id'): e.get('bullets') for e in d.get('systems', []) if isinstance(e, dict)}
    for s, (lo, hi) in want.items():
        b = got.get(s)
        if not isinstance(b, list): problems.append(f'no bullets for {by_star[s]["name"]} (id {s})'); continue
        if not lo <= len(b) <= hi: problems.append(f'{by_star[s]["name"]} (id {s}): {len(b)} bullets, want {lo} to {hi}')
        problems += [f'{by_star[s]["name"]}: a bullet over {WORDS} words' for x in b if len(str(x).split()) > WORDS + 5][:1]
    problems += [f'unknown id {s}' for s in got if s not in want]
    if not SUMMARY[0] <= len(d.get('region') or []) <= SUMMARY[1]: problems.append(f'region summary: {len(d.get("region") or [])} bullets, want {SUMMARY[0]} to {SUMMARY[1]}')
    return problems, d

def key():
    if os.environ.get('OPENROUTER_API_KEY'): return os.environ['OPENROUTER_API_KEY'].strip()
    for f in (root / 'openrouter.token', pathlib.Path.home() / 'openrouter.token'):
        if f.exists(): return f.read_text().strip()
    sys.exit('stories: no OpenRouter key (OPENROUTER_API_KEY, ./openrouter.token or ~/openrouter.token)')

def price():
    """The model's price per token (prompt, completion), from OpenRouter's public list; None if it can't be had."""
    try:
        for m in requests.get('https://openrouter.ai/api/v1/models', timeout=20).json()['data']:
            if m['id'] == MODEL: return float(m['pricing']['prompt']), float(m['pricing']['completion'])
    except Exception: pass
    return None

if DRY:
    p, total = price(), 0
    for rk in regions:
        msgs, settled, dead = prompt(rk)
        tin = sum(len(m_['content']) for m_ in msgs) / 3.6
        tout = (len(settled) * 5 + len(dead) * 2 + 5) * 75  # about 75 tokens a bullet, JSON and all (measured)
        cost = p and tin * p[0] + tout * p[1]
        total += cost or 0
        print(f'--- {REGION_NAMES[rk]}: {len(settled)} settled, {len(dead)} notable dead; about {tin:,.0f} tokens in, {tout:,.0f} out'
              + (f', about ${cost:.3f}' if cost else ' (price unknown)'))
    print(f'\n--- the first prompt ---\n{msgs[0]["content"]}\n\n{prompt(regions[0])[0][1]["content"][-6000:]}')
    print(f'\nestimate: about ${total:.2f} for {len(regions)} region(s) with {MODEL}' if p else f'\n(no price for {MODEL})')
    sys.exit(0)

store = json.loads(store_file.read_text()) if store_file.exists() else {'regions': {}, 'systems': {}}
log = json.loads(log_file.read_text()) if log_file.exists() else []
spent = 0
for rk in regions:
    feedback, t0 = None, time.time()
    for attempt in range(1, 4):
        msgs, settled, dead = prompt(rk, feedback)
        r = requests.post('https://openrouter.ai/api/v1/chat/completions', timeout=600, headers={'Authorization': 'Bearer ' + key(), 'X-Title': 'Driftward stories'},
                          json={'model': MODEL, 'messages': msgs, 'temperature': .8, 'max_tokens': 16000, 'usage': {'include': True}}).json()
        if 'error' in r: sys.exit(f'stories: {REGION_NAMES[rk]}: {r["error"]}')
        cost = (r.get('usage') or {}).get('cost') or 0; spent += cost
        problems, d = check(r['choices'][0]['message']['content'], settled, dead)
        log.append({'date': datetime.date.today().isoformat(), 'region': rk, 'attempt': attempt, 'model': MODEL, 'served': r.get('model'),
                    'cost': cost, 'problems': problems, 'messages': msgs})
        if not problems: break
        feedback = '\n'.join(problems[:30])
        print(f'{REGION_NAMES[rk]} attempt {attempt}: {len(problems)} problem(s), asking again')
    if problems: print(f'{REGION_NAMES[rk]}: still {len(problems)} problem(s) after three tries; kept what passed')
    store['regions'][rk] = {'summary': d.get('region', []) if d else [], 'model': MODEL, 'date': datetime.date.today().isoformat()}
    for e in (d or {}).get('systems', []):
        if e.get('id') in by_star: store['systems'][str(e['id'])] = {'bullets': e['bullets'], 'region': rk}
    print(f'{REGION_NAMES[rk]}: {len(settled)} settled and {len(dead)} dead systems, ${cost:.3f}, {time.time() - t0:.0f} s')
store_file.write_text(json.dumps(store, ensure_ascii=False, indent=1) + '\n')
log_file.write_text(json.dumps(log, ensure_ascii=False, indent=1) + '\n')
print(f'stories: {len(regions)} region(s), ${spent:.2f} -> {store_file.relative_to(root)}')
