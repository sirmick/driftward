// Validate every system file against its schema with the game's own clamp (src/schema.js), check the economy's
// price tables and traffic's hulls, and check the clamp itself on a deliberately bad system. Usage: node tools/validate.js (part of npm run check)
const fs = require('fs'), path = require('path');
const { clampToSchema, loadSystem } = require('../src/schema.js');
const root = path.join(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'src', 'schema', 'system.schema.json'), 'utf8'));
let bad = 0;

for (const f of fs.readdirSync(path.join(root, 'src', 'systems')).filter(f => f.endsWith('.json'))) {
  const { system, bodies, notes } = loadSystem(JSON.parse(fs.readFileSync(path.join(root, 'src', 'systems', f), 'utf8')), schema);
  const ports = bodies.filter(b => b.port).map(b => b.port.name);
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

// traffic: every culture's roles name a catalog brand and size; every population tier has a weight
const traffic = JSON.parse(fs.readFileSync(path.join(root, 'src', 'traffic.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src', 'catalog.json'), 'utf8'));
const tBad = [];
for (const [id, c] of Object.entries(traffic.cultures)) {
  if (!catalog.brands.some(b => b.id === c.brand)) tBad.push(`${id}: unknown brand ${c.brand}`);
  for (const role of ['shuttle', 'hauler', 'liner']) if (!catalog.sizes.some(z => z.id === c.roles[role])) tBad.push(`${id}: ${role} has unknown size ${c.roles[role]}`);
}
for (const tier of schema.properties.bodies.items.properties.port.properties.population.enum) if (!(traffic.population[tier] > 0)) tBad.push(`no weight for population ${tier}`);
if (tBad.length) { bad += tBad.length; tBad.forEach(m => console.log(`traffic.json: ${m}`)); }
else console.log(`traffic.json: valid; ${Object.keys(traffic.cultures).length} culture(s)`);

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
