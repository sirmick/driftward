// Validate every system file against its schema with the game's own clamp (src/schema.js), check the economy's
// price tables and traffic's hulls, and check the clamp itself on a deliberately bad system. Usage: node tools/validate.js (part of npm run check)
const fs = require('fs'), path = require('path');
const { clampToSchema, loadSystem, loadLore } = require('../src/schema.js');
const root = path.join(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'src', 'schema', 'system.schema.json'), 'utf8'));
let bad = 0;

for (const f of fs.readdirSync(path.join(root, 'src', 'systems')).filter(f => f.endsWith('.json'))) {
  const { system, bodies, notes } = loadSystem(JSON.parse(fs.readFileSync(path.join(root, 'src', 'systems', f), 'utf8')), schema);
  const ports = bodies.filter(b => b.port).map(b => b.port.name);
  // what the clamp can't see (loadSystem notes a bad parent or start): ids unique, every orbit clear of its parent and
  // inside the jump zones (traffic's arrivals start there), services listed once
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
const catalog = require('../src/gen.js').resolveCatalog(JSON.parse(fs.readFileSync(path.join(root, 'src', 'catalog.json'), 'utf8')));
const tBad = [];
const MAX_MIX = +fs.readFileSync(path.join(root, 'core', 'src', 'traffic.rs'), 'utf8').match(/pub const MAX_MIX: usize = (\d+);/)[1];
for (const tier of schema.properties.bodies.items.properties.port.properties.population.enum) if (!(traffic.population[tier] > 0)) tBad.push(`traffic.json: no weight for population ${tier}`);
let mixes = 0;
for (const f of fs.readdirSync(path.join(root, 'src', 'systems')).filter(f => f.endsWith('.json'))) {
  const { system, bodies } = loadSystem(JSON.parse(fs.readFileSync(path.join(root, 'src', 'systems', f), 'utf8')), schema);
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
  // the page writes one core mix row per entry and class (writeTraffic in src/play/play.js); rows past MAX_MIX are lost
  const rows = [...(T.local || []), ...(T.through || []), ...(T.loiter || [])].reduce((n, e) => n + Object.values(e.classes || {}).filter(w => w > 0).length, 0);
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

// the clamp on bad input: out-of-range numbers clamp, bad enums fall back to defaults, unknown fields drop,
// a missing required field is fatal
const notes = [];
const out = clampToSchema(schema, {
  id: 'test', name: 'Test', owner: 'ironhulls', ring: 'sideways', star: { name: 'Sol', class: 'purple', radius: 99999 },
  bodies: [{ id: 'a', name: 'A', kind: 'planet', orbit: { radius: 100, angle: 45 }, radius: 500, colour: 'red', look: { palette: ['#123456'] } }]
}, '$', notes);
const expect = [
  ['$.ring', n => n.fatal], ['$.star.class', n => !n.fatal && out.star.class === 'yellow'], ['$.star.radius', n => !n.fatal && out.star.radius === 6000],
  ['$.bodies[0].orbit.radius', n => !n.fatal && out.bodies[0].orbit.radius === 1500], ['$.bodies[0]', n => /colour/.test(n.msg)],
  ['$.bodies[0].look.palette', n => !n.fatal && out.bodies[0].look.palette.length === 3]
];
for (const [p, ok] of expect) {
  const n = notes.find(n => n.path === p);
  if (!n || !ok(n)) { bad++; console.log(`clamp check failed at ${p}: ${n ? n.msg : 'no note'}`); }
}
console.log(bad ? `${bad} validation problem(s)` : 'schema clamp behaves; all systems, the economy and traffic valid');
process.exit(bad ? 1 : 0);
