// Validate every system file against its schema with the game's own clamp (src/schema.js), check the economy's
// price tables and traffic's hulls, and check the clamp itself on a deliberately bad system. Usage: node tools/validate.js (part of npm run check)
const fs = require('fs'), path = require('path');
const { clampToSchema, loadSystem, loadLore } = require('../src/schema.js');
const root = path.join(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'src', 'schema', 'system.schema.json'), 'utf8'));
let bad = 0;
const catalog = require('../src/gen.js').resolveCatalog(JSON.parse(fs.readFileSync(path.join(root, 'src', 'catalog.json'), 'utf8')));
// environmental stations sized as the game sizes them (src/play/play.js)
const layout = { stationRadius: id => { const a = catalog.stations.find(x => x.id === id); return a && a.diameter ? (a.diameter[0] + a.diameter[1]) / 4 : 400; } };

for (const f of fs.readdirSync(path.join(root, 'src', 'systems')).filter(f => f.endsWith('.json'))) {
  const { system, bodies, notes } = loadSystem(JSON.parse(fs.readFileSync(path.join(root, 'src', 'systems', f), 'utf8')), schema, layout);
  const ports = bodies.filter(b => b.port).map(b => b.port.name);
  // what the clamp can't see (loadSystem notes a bad parent or start): ids unique, every orbit clear of its parent and
  // inside the jump zones (traffic's arrivals start there), services listed once, environmental stations clear of
  // every other body; belts and fields clear of every body (a belt's ring, a field's disc), and inside the jump zones
  if (system) {
    const ids = new Set(), jump = (system.traffic || {}).jumpRadius ?? schema.properties.traffic.properties.jumpRadius.default;
    for (const b of system.bodies) {
      const at = `$.bodies[${b.id}]`, P = bodies.find(o => o.id === (b.parent || 'star'));
      if (ids.has(b.id) || b.id === 'star') notes.push({ path: at, msg: `id ${b.id} used twice (or "star", the star's)`, fatal: true });
      ids.add(b.id);
      if (P && b.orbit.radius < P.r + b.radius) notes.push({ path: `${at}.orbit.radius`, msg: `${b.orbit.radius} m puts it inside ${P.id} (radius ${P.r} m, its own ${b.radius} m)`, fatal: true });
      const B = bodies.find(o => o.id === b.id);
      if (B && Math.hypot(B.x, B.y) + b.radius > jump) notes.push({ path: at, msg: `reaches past the jump radius (${jump} m)`, fatal: true });
      const R = b.look && b.look.rings;
      if (R && R.density > 0 && R.outer < R.inner + 0.1) notes.push({ path: `${at}.look.rings`, msg: `outer edge ${R.outer} is not 0.1 beyond inner ${R.inner}`, fatal: false });
      const sv = (b.port && b.port.services) || [];
      if (new Set(sv).size !== sv.length) notes.push({ path: `${at}.port.services`, msg: 'a service listed twice', fatal: false });
    }
    // the stars: a companion clear of the first star and inside the jump zones; hazard zones clear of every port and
    // of the jump zones (arrivals start there)
    const stars = bodies.filter(b => b.kind === 'star'), spread = 2500;
    if (stars[1] && Math.hypot(stars[1].x, stars[1].y) < stars[0].r * 2 + stars[1].r * 2) notes.push({ path: '$.star.companion.orbit.radius', msg: `the companion is within two radii of the first star`, fatal: true });
    if (stars[1] && Math.hypot(stars[1].x, stars[1].y) + stars[1].r > jump) notes.push({ path: '$.star.companion', msg: `reaches past the jump radius (${jump} m)`, fatal: true });
    for (const st of stars.filter(b => b.hazard > 0)) {
      const at = st.id === 'star' ? '$.star.hazard' : '$.star.companion.hazard';
      if (Math.hypot(st.x, st.y) + st.hazard > jump - spread) notes.push({ path: at, msg: `the ${st.hazard} m hazard zone reaches the jump zones (${jump} m out)`, fatal: true });
      for (const o of bodies.filter(o => o.port)) if (Math.hypot(o.x - st.x, o.y - st.y) - o.r < st.hazard) notes.push({ path: at, msg: `the hazard zone covers the port ${o.id}`, fatal: true });
    }
    // moving stations: every station round a planet or moon circles it, paced as real orbits are, so their orbits may
    // sweep through other bodies and each other (nothing collides; it is only drawn on top). What must hold is that
    // nothing circles a station (stations move), and that port stations start clear of each other (environmental ones
    // are checked above)
    for (const m of bodies.filter(b => b.motion)) {
      const at = m.env ? `$.bodies[${m.parent}].environs` : `$.bodies[${m.id}]`;
      for (const o of bodies) {
        if (o.parent === m.id && o.kind !== 'belt' && o.kind !== 'field') notes.push({ path: at, msg: `${o.id} circles it, and stations move`, fatal: true });
        if (!m.env && o.kind === 'station' && !o.env && o.id > m.id && Math.hypot(o.x - m.x, o.y - m.y) - o.r - m.r < 100) notes.push({ path: at, msg: `${o.id} is within ${Math.round(Math.hypot(o.x - m.x, o.y - m.y) - o.r - m.r)} m of it`, fatal: true });
      }
    }
    if (system.region && !fs.existsSync(path.join(root, 'src', 'lore', 'regions', `${system.region}.md`))) notes.push({ path: '$.region', msg: `no src/lore/regions/${system.region}.md`, fatal: false });
    const rocky = b => b.kind === 'belt' || b.kind === 'field';
    for (const e of bodies.filter(b => b.env)) for (const o of bodies) {
      if (o === e || rocky(o)) continue;
      const gap = Math.hypot(e.x - o.x, e.y - o.y) - e.r - o.r;
      if (gap < 100) notes.push({ path: `$.bodies[${e.parent}].environs`, msg: `${e.id} is within ${Math.round(gap)} m of ${o.id}`, fatal: false });
    }
    for (const k of bodies.filter(rocky)) {
      const at = `$.belts[${k.id}]`, half = k.belt.width / 2;
      if (ids.has(k.id)) notes.push({ path: at, msg: `id ${k.id} used twice`, fatal: true });
      ids.add(k.id);
      const P = bodies.find(o => o.id === k.parent);
      if (k.kind === 'belt' ? k.r - half < P.r : Math.hypot(k.x - P.x, k.y - P.y) - k.r < P.r) notes.push({ path: `${at}.orbit.radius`, msg: `it reaches inside ${P.id}`, fatal: true });
      if (Math.hypot(k.x, k.y) + (k.kind === 'belt' ? k.r + half : k.r) > jump) notes.push({ path: at, msg: `reaches past the jump radius (${jump} m)`, fatal: true });
      for (const o of bodies) {
        if (o === k || o === P || rocky(o)) continue;
        const d = Math.hypot(o.x - k.x, o.y - k.y), gap = (k.kind === 'belt' ? Math.abs(d - k.r) - half : d - k.r) - o.r;
        if (gap < 100) notes.push({ path: at, msg: `${o.id} is within ${Math.round(gap)} m of it`, fatal: false });
      }
    }
  }
  if (!system || notes.length) { bad++; console.log(`${f}: ${notes.length} problem(s)`); notes.forEach(n => console.log(`  ${n.fatal ? 'FATAL' : 'clamped'} ${n.path}: ${n.msg}`)); }
  else console.log(`${f}: valid; ${bodies.length} bodies, ${ports.length} ports (${ports.join(', ')})`);
}

// the economy: at most the core's 16 commodities, a price table for every port role the schema allows, naming only
// known commodities and tiers
const econ = JSON.parse(fs.readFileSync(path.join(root, 'src', 'economy.json'), 'utf8'));
const roles = schema.properties.bodies.items.properties.port.properties.role.enum, ids = econ.commodities.map(c => c.id);
const econBad = [];
if (ids.length > 16) econBad.push(`${ids.length} commodities; the core holds 16`);
if (new Set(ids).size !== ids.length) econBad.push('duplicate commodity ids');
econ.commodities.forEach(c => { if (!(c.base > 0 && Number.isInteger(c.base))) econBad.push(`${c.id}: base price must be a positive integer`); });
for (const r of roles) if (!econ.roles[r]) econBad.push(`no price table for role ${r}`);
for (const [r, t] of Object.entries(econ.roles)) {
  if (!roles.includes(r)) econBad.push(`price table for unknown role ${r}`);
  for (const [g, tier] of Object.entries(t)) {
    if (!ids.includes(g)) econBad.push(`${r}: unknown commodity ${g}`);
    if (!(tier in econ.tiers)) econBad.push(`${r}.${g}: unknown tier ${tier}`);
  }
}
if (econBad.length) { bad += econBad.length; econBad.forEach(m => console.log(`economy.json: ${m}`)); }
else console.log(`economy.json: valid; ${ids.length} commodities, ${roles.length} role price tables`);

// traffic: every population tier has a weight; every system's traffic mix names catalog lines, classes those lines
// build, and loiter ports that exist, with something in each stream it lists
const traffic = JSON.parse(fs.readFileSync(path.join(root, 'src', 'traffic.json'), 'utf8'));
const tBad = [];
const MAX_MIX = +fs.readFileSync(path.join(root, 'core', 'src', 'traffic.rs'), 'utf8').match(/pub const MAX_MIX: usize = (\d+);/)[1];
// every archetype's environs traffic: a rate, a jump share in 0..1, and a mix
for (const [a, E] of Object.entries(traffic.environs || {})) {
  if (!catalog.stations.some(s => s.id === a)) tBad.push(`traffic.json environs: ${a} is not a catalog station`);
  if (!(E.perMinute > 0) || !(E.jump >= 0 && E.jump <= 1) || !(E.mix || []).length) tBad.push(`traffic.json environs.${a}: needs perMinute > 0, jump in 0..1 and a mix`);
}
for (const tier of schema.properties.bodies.items.properties.port.properties.population.enum) if (!(traffic.population[tier] > 0)) tBad.push(`traffic.json: no weight for population ${tier}`);
let mixes = 0;
for (const f of fs.readdirSync(path.join(root, 'src', 'systems')).filter(f => f.endsWith('.json'))) {
  const { system, bodies } = loadSystem(JSON.parse(fs.readFileSync(path.join(root, 'src', 'systems', f), 'utf8')), schema, layout);
  const T = (system && system.traffic) || {};
  const check = (where, e) => {
    const B = catalog.brands.find(b => b.id === e.line);
    if (!B) return tBad.push(`${f} ${where}: unknown line ${e.line}`);
    const cls = Object.entries(e.classes || {}).filter(([, w]) => w > 0).map(([c]) => c);
    if (!cls.length) tBad.push(`${f} ${where} ${e.line}: no class with a weight`);
    for (const c of cls) if (B.classes && !B.classes.includes(c)) tBad.push(`${f} ${where} ${e.line}: the line builds no ${c}`);
    mixes++;
  };
  (T.local || []).forEach(e => check('local', e));
  (T.through || []).forEach(e => check('through', e));
  (T.loiter || []).forEach(e => { check('loiter', e); if (!bodies.some(b => b.id === e.port && b.port)) tBad.push(`${f} loiter: no port ${e.port}`); });
  // environmental stations: their archetype has traffic, and each of its lines (own.<line> as each owner's) is
  // flown by the classes it names; one group of rows per archetype and owner
  const envGroups = new Map();
  for (const b of bodies.filter(b => b.env)) {
    const E = (traffic.environs || {})[b.env.archetype], gk = b.env.archetype + '|' + b.env.brand;
    if (!E) { tBad.push(`${f} ${b.id}: traffic.json has no environs entry for ${b.env.archetype}`); continue; }
    if (!envGroups.has(gk)) envGroups.set(gk, E.mix.map(e => Object.assign({}, e, { line: e.line.replace(/^own\./, b.env.brand + '.') })));
  }
  for (const [gk, mix] of envGroups) mix.forEach(e => check(`environs ${gk}`, e));
  // the page writes one core mix row per entry and class (writeTraffic in src/play/play.js); rows past MAX_MIX are lost
  const rows = [...(T.local || []), ...(T.through || []), ...(T.loiter || []), ...[...envGroups.values()].flat()].reduce((n, e) => n + Object.values(e.classes || {}).filter(w => w > 0).length, 0);
  if (rows > MAX_MIX) tBad.push(`${f}: traffic mix needs ${rows} core rows; the core holds ${MAX_MIX}`);
}
if (tBad.length) { bad += tBad.length; tBad.forEach(m => console.log(m)); }
else console.log(`traffic: valid; population weights, ${mixes} mix entries`);

// the schema's station enums name catalog entries: every archetype one of the catalog's stations, each of them
// offered, and every brand one the catalog resolves (src/play/play.js builds stations from them unchecked)
{
  const st = schema.properties.bodies.items.properties.station.properties, sBad = [];
  const archs = st.archetype.enum, catArchs = catalog.stations.map(a => a.id);
  for (const a of archs) if (!catArchs.includes(a)) sBad.push(`station archetype ${a} is not in the catalog`);
  for (const a of catArchs) if (!archs.includes(a)) sBad.push(`catalog station ${a} is missing from the schema's archetype enum`);
  for (const b of st.brand.enum) if (!require('../src/gen.js').brandOf(catalog, b)) sBad.push(`station brand ${b} is not a catalog faction or line`);
  if (sBad.length) { bad += sBad.length; sBad.forEach(m => console.log(`system.schema.json: ${m}`)); }
  else console.log(`stations: schema enums match the catalog; ${archs.length} archetypes, ${st.brand.enum.length} brands`);
}

// lore (src/lore/<system id>.json, from tools/gen-content.js): valid against its schema and its system, a port entry
// for every port, and every portrait and vista in art/<id>/ naming a person or port the lore has
const loreSchema = JSON.parse(fs.readFileSync(path.join(root, 'src', 'schema', 'lore.schema.json'), 'utf8'));
const loreDir = path.join(root, 'src', 'lore');
for (const f of fs.existsSync(loreDir) ? fs.readdirSync(loreDir).filter(f => f.endsWith('.json') && !f.endsWith('.log.json')) : []) {
  const raw = JSON.parse(fs.readFileSync(path.join(loreDir, f), 'utf8'));
  const sysF = fs.readdirSync(path.join(root, 'src', 'systems')).find(s => JSON.parse(fs.readFileSync(path.join(root, 'src', 'systems', s), 'utf8')).id === raw.system);
  if (!sysF) { bad++; console.log(`lore/${f}: no system ${raw.system}`); continue; }
  const { system } = loadSystem(JSON.parse(fs.readFileSync(path.join(root, 'src', 'systems', sysF), 'utf8')), schema);
  const { lore, ports, notes } = loadLore(raw, loreSchema, system);
  const people = new Set([...ports.values()].flatMap(p => p.people.map(q => q.id)));
  const artDir = path.join(root, 'art', raw.system), art = fs.existsSync(artDir) ? fs.readdirSync(artDir).filter(a => a.endsWith('.webp')) : [];
  const stray = art.filter(a => { const [, kind, id] = a.match(/^(vista|portrait)-(.+)\.webp$/) || []; return kind === 'vista' ? !ports.has(id) : kind === 'portrait' ? !people.has(id) : true; });
  if (!lore || notes.length || stray.length) {
    bad++; console.log(`lore/${f}: ${notes.length + stray.length} problem(s)`);
    notes.forEach(n => console.log(`  ${n.fatal ? 'FATAL' : 'clamped'} ${n.path}: ${n.msg}`)); stray.forEach(a => console.log(`  art/${raw.system}/${a} matches nothing in the lore`));
  } else console.log(`lore/${f}: valid; ${ports.size} ports, ${people.size} people, ${art.filter(a => a.startsWith('vista-')).length} vistas and ${art.filter(a => a.startsWith('portrait-')).length} portraits`);
}

// the universe index (src/galaxy/universe.json, from tools/universe.py, which the build reruns): valid against its
// schema; worlds and stories made from the galaxy it was (their recorded hashes match); every reference resolves; and
// every system file agrees with its entry: name, owner, ring, region and star class, its ports' roles exactly the
// world's, no port's tier above the system's, and a Builtworld where the world has one
{
  const uSchema = JSON.parse(fs.readFileSync(path.join(root, 'src', 'schema', 'universe.schema.json'), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'src', 'galaxy', 'universe.json'), 'utf8'));
  const uNotes = [], U = clampToSchema(uSchema, raw, '$', uNotes), uBad = uNotes.map(n => `${n.path}: ${n.msg}`);
  const made = raw.made || {};
  if (made.worlds !== made.galaxy) uBad.push(`worlds.json was made from galaxy ${made.worlds}, not this one (${made.galaxy}): rerun tools/worlds.py`);
  const stale = Object.entries(made.stories || {}).filter(([, h]) => h !== made.galaxy).map(([k]) => k);
  if (stale.length) uBad.push(`stories.json's ${stale.join(', ')} told from another galaxy: rerun tools/stories.py ${stale.join(',')}`);
  const byId = new Map(), byFile = new Map(), owners = schema.properties.owner.enum, tiers = schema.properties.bodies.items.properties.port.properties.population.enum;
  for (const k of Object.keys(raw.factions || {})) if (!owners.includes(k) || k === 'none') uBad.push(`faction ${k} is not a system schema owner`);
  for (const s of raw.systems || []) {
    if (byId.has(s.id)) uBad.push(`system ${s.id} listed twice`);
    byId.set(s.id, s);
    if (!(raw.regions || {})[s.region]) uBad.push(`${s.name} (${s.id}): no region ${s.region}`);
    if (s.owner !== 'none' && !(raw.factions || {})[s.owner]) uBad.push(`${s.name} (${s.id}): no faction ${s.owner}`);
    if (s.file) { if (byFile.has(s.file)) uBad.push(`file ${s.file} given to two systems`); byFile.set(s.file, s); }
  }
  for (const l of raw.lanes || []) if (!byId.has(l.a) || !byId.has(l.b)) uBad.push(`lane ${l.a}-${l.b}: no such system`);
  const files = fs.readdirSync(path.join(root, 'src', 'systems')).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const { system, bodies } = loadSystem(JSON.parse(fs.readFileSync(path.join(root, 'src', 'systems', f), 'utf8')), schema, layout);
    if (!system) continue; // reported above
    const e = byFile.get(system.id), at = `${f} (${system.id})`;
    if (!e) { uBad.push(`${at}: no system in the index has file ${system.id}`); continue; }
    byFile.delete(system.id);
    for (const [k, mine, theirs] of [['name', system.name, e.name], ['owner', system.owner, e.owner], ['ring', system.ring, e.ring], ['region', system.region, e.region], ['star class', system.star.class, e.class]])
      if (mine !== theirs) uBad.push(`${at}: ${k} ${mine}, the index says ${theirs}`);
    const ports = bodies.filter(b => b.port).map(b => b.port), w = e.world;
    if (!w) { if (ports.length) uBad.push(`${at}: has ports, but the index gives ${e.name} no people`); continue; }
    const roles = [...new Set(ports.map(p => p.role))].sort(), want = [...new Set(w.roles)].sort();
    if (roles.join() !== want.join()) uBad.push(`${at}: port roles ${roles.join(', ')}, the index's world has ${want.join(', ')}`);
    for (const p of ports) if (tiers.indexOf(p.population) > tiers.indexOf(w.tier)) uBad.push(`${at}: ${p.name} is a ${p.population}, above the system's tier (${w.tier})`);
    if (!!w.builtworld !== ports.some(p => p.builtworld)) uBad.push(`${at}: ${w.builtworld ? 'the index has a Builtworld here and no port is one' : 'a port is a Builtworld, and the index has none here'}`);
  }
  for (const [id, e] of byFile) uBad.push(`${e.name} (${e.id}): file ${id}, but src/systems/ has no system ${id}`);
  if (uBad.length) { bad += uBad.length; uBad.forEach(m => console.log(`universe.json: ${m}`)); }
  else console.log(`universe.json: valid; ${raw.systems.length} systems (${files.length} with files, each agreeing), ${Object.keys(raw.regions).length} regions, ${raw.lanes.length} lanes; galaxy ${made.galaxy}, worlds and stories made from it`);
}

// the clamp on bad input: out-of-range numbers clamp, bad enums fall back to defaults, unknown fields drop,
// a missing required field is fatal
const notes = [];
const out = clampToSchema(schema, {
  id: 'test', name: 'Test', owner: 'ironhulls', ring: 'sideways', star: { name: 'Sol', class: 'purple', radius: 99999 },
  bodies: [{ id: 'a', name: 'A', kind: 'planet', orbit: { radius: 100, angle: 45 }, radius: 500, colour: 'red', look: { palette: ['#123456'] } }]
}, '$', notes);
const expect = [
  ['$.ring', n => n.fatal], ['$.star.class', n => !n.fatal && out.star.class === 'yellow'], ['$.star.radius', n => !n.fatal && out.star.radius === 8000],
  ['$.bodies[0].orbit.radius', n => !n.fatal && out.bodies[0].orbit.radius === 1500], ['$.bodies[0]', n => /colour/.test(n.msg)],
  ['$.bodies[0].look.palette', n => !n.fatal && out.bodies[0].look.palette.length === 3]
];
for (const [p, ok] of expect) {
  const n = notes.find(n => n.path === p);
  if (!n || !ok(n)) { bad++; console.log(`clamp check failed at ${p}: ${n ? n.msg : 'no note'}`); }
}
console.log(bad ? `${bad} validation problem(s)` : 'schema clamp behaves; all systems, the economy and traffic valid');
process.exit(bad ? 1 : 0);
