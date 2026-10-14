// Validate every system file against its schema with the game's own clamp (src/schema.js), and check the clamp
// itself on a deliberately bad system. Usage: node tools/validate.js (part of npm run check)
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
console.log(bad ? `${bad} validation problem(s)` : 'schema clamp behaves; all systems valid');
process.exit(bad ? 1 : 0);
