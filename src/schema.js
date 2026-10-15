// ======================= SCHEMA =======================
// Content enters through JSON Schemas (src/schema/*.schema.json): the contract an LLM writes against, and the
// validator that clamps what it writes before the game uses it (the Book: "output is clamped to schema ranges and
// enumerations before use"). clampToSchema walks a value against the subset of JSON Schema the schemas use
// (type, properties, required, items, minItems, maxItems, enum, minimum, maximum, minLength, maxLength, pattern,
// default) and returns a value that satisfies it, with a note for every change. A missing required field with no
// default is fatal: the value cannot be used.
function clampToSchema(schema, value, path, notes) {
  path = path || '$'; notes = notes || [];
  const note = (msg, fatal) => notes.push({ path, msg, fatal: !!fatal });
  const fallback = why => {
    if (schema.default !== undefined) { note(`${why}; using the default`); return JSON.parse(JSON.stringify(schema.default)); }
    note(why, true); return undefined;
  };
  if (value === undefined) {
    if (schema.default === undefined) return undefined;
    const d = JSON.parse(JSON.stringify(schema.default));
    return schema.type === 'object' ? clampToSchema(schema, d, path, notes) : d; // an object default gets its fields' defaults
  }
  if (schema.enum) return schema.enum.includes(value) ? value : fallback(`${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback('not an object');
      const out = {};
      for (const [k, sub] of Object.entries(schema.properties || {})) {
        const v = clampToSchema(sub, value[k], `${path}.${k}`, notes);
        if (v !== undefined) out[k] = v;
        else if ((schema.required || []).includes(k)) notes.push({ path: `${path}.${k}`, msg: 'required', fatal: true });
      }
      for (const k of Object.keys(value)) if (!(schema.properties || {})[k]) note(`unknown field ${k} dropped`);
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) return fallback('not an array');
      let arr = value.map((v, i) => clampToSchema(schema.items || {}, v, `${path}[${i}]`, notes)).filter(v => v !== undefined);
      if (schema.maxItems !== undefined && arr.length > schema.maxItems) { note(`more than ${schema.maxItems} items; extra dropped`); arr = arr.slice(0, schema.maxItems); }
      if (schema.minItems !== undefined && arr.length < schema.minItems) return fallback(`fewer than ${schema.minItems} items`);
      return arr;
    }
    case 'number': case 'integer': {
      let v = typeof value === 'number' && Number.isFinite(value) ? value : NaN;
      if (Number.isNaN(v)) return fallback('not a number');
      if (schema.type === 'integer' && !Number.isInteger(v)) { v = Math.round(v); note('rounded to an integer'); }
      if (schema.minimum !== undefined && v < schema.minimum) { note(`${v} below ${schema.minimum}; clamped`); v = schema.minimum; }
      if (schema.maximum !== undefined && v > schema.maximum) { note(`${v} above ${schema.maximum}; clamped`); v = schema.maximum; }
      return v;
    }
    case 'string': {
      if (typeof value !== 'string') return fallback('not a string');
      let v = value;
      if (schema.maxLength !== undefined && v.length > schema.maxLength) { note(`longer than ${schema.maxLength}; cut`); v = v.slice(0, schema.maxLength); }
      if (schema.minLength !== undefined && v.length < schema.minLength) return fallback(`shorter than ${schema.minLength}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(v)) return fallback(`does not match ${schema.pattern}`);
      return v;
    }
    case 'boolean': return typeof value === 'boolean' ? value : fallback('not a boolean');
    default: return value;
  }
}

// A star system, validated and laid out: the star at the origin, every body placed by its orbit (moons and
// stations around their parent), parents before children, with what the core and the renderer need. The game
// re-places bodies with the core's own trig (World::place_body) so a layout is bit-identical across browsers. Returns { system, bodies, notes };
// system is null if the file is unusable.
function loadSystem(raw, schema) {
  const notes = [];
  const sys = clampToSchema(schema, raw, '$', notes);
  if (!sys || notes.some(n => n.fatal)) return { system: null, bodies: [], notes };
  const STAR_LOOK = { 'red-dwarf': 'red', orange: 'orange', yellow: 'sol', white: 'white', 'blue-giant': 'blue' };
  const placed = new Map(), bodies = [];
  // a station body's build, its defaults from the schema whether or not the file has a station block; the seed
  // defaults to the body's id
  const stationSchema = schema.properties.bodies.items.properties.station;
  const stationOf = b => { const st = clampToSchema(stationSchema, b.station || {}, `$.bodies[${b.id}].station`, notes); if (!st.seed) st.seed = b.id; return st; };
  // the star is body 0
  bodies.push({ id: 'star', name: sys.star.name, kind: 'star', x: 0, y: 0, r: sys.star.radius, g: sys.star.gravity, starClass: sys.star.class, look: STAR_LOOK[sys.star.class] });
  placed.set('', bodies[0]);
  // place parents before children (a moon may be listed before its planet)
  let todo = sys.bodies.slice(), guard = 0;
  while (todo.length && guard++ < 50) {
    const next = [];
    for (const b of todo) {
      const parent = placed.get(b.parent || '');
      if (!parent) { if (sys.bodies.some(o => o.id === b.parent)) next.push(b); else notes.push({ path: `$.bodies[${b.id}]`, msg: `parent ${b.parent} not found; orbiting the star`, fatal: false }), next.push(Object.assign({}, b, { parent: '' })); continue; }
      const a = b.orbit.angle * Math.PI / 180;
      const body = {
        id: b.id, name: b.name, kind: b.kind, parent: parent.id, orbit: b.orbit,
        x: parent.x + Math.cos(a) * b.orbit.radius, y: parent.y + Math.sin(a) * b.orbit.radius, r: b.radius, g: b.gravity,
        look: b.look, station: b.kind === 'station' ? stationOf(b) : undefined, port: b.port || null
      };
      bodies.push(body); placed.set(b.id, body);
    }
    todo = next;
  }
  if (sys.start && !bodies.some(b => b.id === sys.start && b.port)) notes.push({ path: '$.start', msg: `${sys.start} is not a port body; starting at the first port`, fatal: false });
  return { system: sys, bodies, notes };
}

// A system's lore (src/lore/<id>.json), validated against its schema and against the system it narrates: it must
// name the system, and each port entry a body with a port, once; person ids are unique (they name the portraits).
// Entries that fail are dropped with a note, so a port without lore falls back to the system file's description.
// Returns { lore, ports: Map body id -> entry, notes }; lore is null if the file is unusable.
function loadLore(raw, schema, system) {
  const notes = [];
  const lore = clampToSchema(schema, raw, '$', notes);
  if (!lore || notes.some(n => n.fatal)) return { lore: null, ports: new Map(), notes };
  if (system && lore.system !== system.id) { notes.push({ path: '$.system', msg: `lore is for ${lore.system}, not ${system.id}`, fatal: true }); return { lore: null, ports: new Map(), notes }; }
  const portBodies = new Set(system ? system.bodies.filter(b => b.port).map(b => b.id) : []), ports = new Map(), people = new Set();
  lore.ports.forEach((p, i) => {
    const drop = msg => notes.push({ path: `$.ports[${i}]`, msg: `${msg}; dropped`, fatal: false });
    if (system && !portBodies.has(p.body)) return drop(`${p.body} is not a port body`);
    if (ports.has(p.body)) return drop(`second entry for ${p.body}`);
    p.people = p.people.filter(q => people.has(q.id) ? (notes.push({ path: `$.ports[${i}].people`, msg: `person id ${q.id} used twice; dropped`, fatal: false }), false) : people.add(q.id));
    ports.set(p.body, p);
  });
  for (const id of portBodies) if (!ports.has(id)) notes.push({ path: '$.ports', msg: `no lore for port ${id}`, fatal: false });
  return { lore, ports, notes };
}

if (typeof module !== 'undefined') module.exports = { clampToSchema, loadSystem, loadLore };
