"""Extract the real stars round Sol from the HYG database (v4.1, CC BY-SA 4.0, github.com/astronexus/HYG-Database)
into src/galaxy/stars.json: every star system within 80 light years, and out to 100 toward the galactic core (where
the Shadow comes from, beyond the outer ring), its companions folded in, each with a position
and one of the game's star classes (src/stars.js). The galaxy map picks its systems from these.

Positions are light years in galactic coordinates, Sol at the origin: +x toward the galactic centre, +y the way the
Sun orbits it, +z galactic north, so the x-y plane is the galactic plane (the map's floor).

Usage: python3 tools/hyg.py   (downloads the catalogue to ~/.cache/driftward on first run)
"""
import csv, json, pathlib, urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
out = root / 'src' / 'galaxy' / 'stars.json'
cache = pathlib.Path.home() / '.cache' / 'driftward' / 'hygdata_v41.csv'
URL = 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv'
LY_PER_PC, RANGE_LY, CORE_LY = 3.26156, 80, 100
CORE_CONE = 0.7  # the cosine of the half-angle round the galactic core's direction that reaches out to CORE_LY

# J2000 equatorial to galactic (the IAU rotation)
EQ_TO_GAL = [[-0.0548755604, -0.8734370902, -0.4838350155],
             [0.4941094279, -0.4448296300, 0.7469822445],
             [-0.8676661490, -0.1980763734, 0.4559837762]]

def star_class(spect, ci, absmag):
    """The game's class for a spectral type, falling back on colour index and brightness when it is missing."""
    s = (spect or '').strip()
    if s[:1] in 'gkm' and s: s = s[0].upper() + s[1:]  # Gliese's rough lowercase types (k-m: call it K)
    if s.startswith('sd'): s = s[2:]  # subdwarfs: the class after the prefix
    if s.startswith('d') and len(s) > 1 and s[1] in 'OBAFGKM': s = s[1:]
    if s.startswith('D'): return 'white-dwarf'
    if s and s[0] in 'LTY': return 'brown-dwarf'
    if s.startswith('W'): return 'wolf-rayet'
    t = s[:1]
    if t in 'OB' and absmag is not None and absmag > 3: t = ''  # a B type too faint to be one: a catalogue slip
    if not t or t not in 'OBAFGKM':
        # no usable type: guess from the B-V colour, and call anything faint and blue a white dwarf
        if ci is None: return 'red-dwarf'
        if absmag is not None and absmag > 10 and ci < .5: return 'white-dwarf'
        t = 'B' if ci < 0 else 'A' if ci < .3 else 'F' if ci < .58 else 'G' if ci < .81 else 'K' if ci < 1.4 else 'M'
    lum = s[1:].replace('IV', '').replace('V', '')
    giant = 'III' in lum or 'II' in lum or 'I' in lum.replace('II', '')
    if t in 'OB': return 'blue-giant'
    if t == 'A' or (t == 'F' and s[1:2] in '01234'): return 'white'
    if t in 'FG': return 'red-giant' if giant and t == 'G' else 'yellow'
    if t == 'K': return 'red-giant' if giant else 'orange'
    return 'red-giant' if giant else 'red-dwarf'

GREEK = dict(Alp='Alpha', Bet='Beta', Gam='Gamma', Del='Delta', Eps='Epsilon', Zet='Zeta', Eta='Eta', The='Theta', Iot='Iota',
             Kap='Kappa', Lam='Lambda', Mu='Mu', Nu='Nu', Xi='Xi', Omi='Omicron', Pi='Pi', Rho='Rho', Sig='Sigma', Tau='Tau',
             Ups='Upsilon', Phi='Phi', Chi='Chi', Psi='Psi', Ome='Omega')
# constellation genitives by IAU abbreviation, for "Tau Ceti" rather than "Tau Cet"
CON = dict(And='Andromedae', Ant='Antliae', Aps='Apodis', Aqr='Aquarii', Aql='Aquilae', Ara='Arae', Ari='Arietis', Aur='Aurigae',
           Boo='Boötis', Cae='Caeli', Cam='Camelopardalis', Cnc='Cancri', CVn='Canum Venaticorum', CMa='Canis Majoris',
           CMi='Canis Minoris', Cap='Capricorni', Car='Carinae', Cas='Cassiopeiae', Cen='Centauri', Cep='Cephei', Cet='Ceti',
           Cha='Chamaeleontis', Cir='Circini', Col='Columbae', Com='Comae Berenices', CrA='Coronae Australis',
           CrB='Coronae Borealis', Crv='Corvi', Crt='Crateris', Cru='Crucis', Cyg='Cygni', Del='Delphini', Dor='Doradus',
           Dra='Draconis', Equ='Equulei', Eri='Eridani', For='Fornacis', Gem='Geminorum', Gru='Gruis', Her='Herculis',
           Hor='Horologii', Hya='Hydrae', Hyi='Hydri', Ind='Indi', Lac='Lacertae', Leo='Leonis', LMi='Leonis Minoris',
           Lep='Leporis', Lib='Librae', Lup='Lupi', Lyn='Lyncis', Lyr='Lyrae', Men='Mensae', Mic='Microscopii',
           Mon='Monocerotis', Mus='Muscae', Nor='Normae', Oct='Octantis', Oph='Ophiuchi', Ori='Orionis', Pav='Pavonis',
           Peg='Pegasi', Per='Persei', Phe='Phoenicis', Pic='Pictoris', Psc='Piscium', PsA='Piscis Austrini', Pup='Puppis',
           Pyx='Pyxidis', Ret='Reticuli', Sge='Sagittae', Sgr='Sagittarii', Sco='Scorpii', Scl='Sculptoris', Sct='Scuti',
           Ser='Serpentis', Sex='Sextantis', Tau='Tauri', Tel='Telescopii', Tri='Trianguli', TrA='Trianguli Australis',
           Tuc='Tucanae', UMa='Ursae Majoris', UMi='Ursae Minoris', Vel='Velorum', Vir='Virginis', Vol='Volantis', Vul='Vulpeculae')

# the names people use for a few stars the IAU has renamed (its name stays among the designations)
COMMON = {'Rigil Kentaurus': 'Alpha Centauri', 'Ran': 'Epsilon Eridani'}

def bayer_name(letter, con):
    """'Alp-1', 'Cen' -> 'Alpha-1 Centauri'; Flamsteed numbers pass through ('61', 'Cyg' -> '61 Cygni')."""
    g, _, n = letter.partition('-')
    return f"{GREEK.get(g, g)}{'-' + n if n else ''} {CON.get(con, con)}"

def num(v):
    return float(v) if v not in ('', None) else None

def designations(r):
    d = []
    for k in ('bayer', 'flam'):
        if r[k]: d.append(bayer_name(r[k], r['con']))
    for k, pre in (('gl', ''), ('hip', 'HIP '), ('hd', 'HD ')):
        if r[k]: d.append(pre + r[k])
    return d

def main():
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        print(f'hyg: downloading {URL}')
        urllib.request.urlretrieve(URL, cache)
    def keep(r):
        ly = float(r['dist']) * LY_PER_PC
        if ly <= RANGE_LY: return True
        if ly > CORE_LY: return False
        gx = sum(m * float(r[k]) for m, k in zip(EQ_TO_GAL[0], ('x', 'y', 'z'))) * LY_PER_PC
        return gx / ly >= CORE_CONE
    rows = [r for r in csv.DictReader(cache.open()) if float(r['dist']) < 100000 and keep(r)]
    systems = {}
    for r in sorted(rows, key=lambda r: int(r['id'])):
        prim = r['comp_primary'] or r['id']
        systems.setdefault(prim, []).append(r)
    stars = []
    for prim, comps in systems.items():
        comps.sort(key=lambda r: (r['id'] != prim, num(r['absmag']) or 99))  # the primary, then brightest first
        p = comps[0]
        x, y, z = (float(p[k]) * LY_PER_PC for k in ('x', 'y', 'z'))
        g = [round(sum(m * v for m, v in zip(row, (x, y, z))), 3) for row in EQ_TO_GAL]
        names = [c['proper'] for c in comps if c['proper']]
        cls = [star_class(c['spect'], num(c['ci']), num(c['absmag'])) for c in comps]
        des = designations(p)
        name = names[0] if names else (des or [f"HYG {p['id']}"])[0]
        if name in COMMON: des, name = [name] + des, COMMON[name]
        s = {'id': int(p['id']), 'name': name,
             'ly': round(float(p['dist']) * LY_PER_PC, 2), 'pos': g, 'class': cls[0], 'spect': p['spect'] or None,
             'absmag': num(p['absmag'])}
        if p['id'] == '0': s.update(name='Sol', pos=[0, 0, 0], ly=0)
        if not names and not (p['bayer'] or p['flam']): s['catalog'] = True  # named only by a catalogue number
        if des: s['desig'] = des
        if len(comps) > 1:
            s['companions'] = [{'name': c['proper'] or (designations(c) or [f"HYG {c['id']}"])[0], 'class': k, 'spect': c['spect'] or None}
                               for c, k in zip(comps[1:], cls[1:])]
        stars.append(s)
    stars.sort(key=lambda s: s['ly'])
    out.parent.mkdir(parents=True, exist_ok=True)
    body = ',\n'.join(json.dumps(s, ensure_ascii=False, separators=(',', ':')) for s in stars)
    out.write_text('{"source":"HYG database v4.1 (astronexus, CC BY-SA 4.0)","units":"ly, galactic coordinates, Sol at the origin",'
                   f'"range":{RANGE_LY},"coreRange":{CORE_LY},"coreCone":{CORE_CONE},\n"stars":[\n{body}\n]}}\n')
    counts = {}
    for s in stars: counts[s['class']] = counts.get(s['class'], 0) + 1
    print(f'hyg: {len(stars)} systems within {RANGE_LY} ly ({CORE_LY} toward the core) -> {out.relative_to(root)}')
    print('hyg: ' + ', '.join(f'{k} {v}' for k, v in sorted(counts.items(), key=lambda kv: -kv[1])))

main()
