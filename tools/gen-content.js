// The content generator: a system's lore and art, written by models through OpenRouter from the system's sim facts
// (the Book: "sim decides, LLM narrates"). It runs offline, before the game: what it writes is reviewed and committed,
// and the page only reads it, so play never waits on a model and a seed always shows the same words and pictures.
//
//   lore  one text call for the whole system (so its ports agree): history, culture, the art bible, and per port a
//         description, notable places, people, rumors and what its vista shows -> src/lore/<id>.json, clamped by
//         the game's own validator (src/schema.js) against src/schema/lore.schema.json; the facts include the
//         system's belts and fields, and src/lore/setting.md (the universe's backstory and recent events, by hand)
//         goes with them when it exists, and the system's region notes (src/lore/regions/<region>.md)
//   art   from the lore: a painted vista per port and a portrait per person -> art/<id>/*.webp, with every prompt,
//         model, seed and cost in art/<id>/log.json. The start port's vista goes first and is the style reference
//         for the other vistas (the Book: the first approved vista); likewise the first portrait for the portraits.
//         If you redo the reference (--only <it> --force), redo the rest after it too.
//   all   lore, then art
//
// Usage: node tools/gen-content.js <lore|art|all> [--system m1] [--only id,id] [--force] [--dry]
//          [--text-model M] [--vista-model M] [--portrait-model M] [--vista-size S] [--portrait-size S]
//          [--image-model M] [--image-size 1K|2K|4K] [--seed N]
//   --only   port body ids and person ids to (re)generate; art only
//   --force  regenerate what exists (lore always regenerates)
//   --dry    print the prompts; no calls, no key needed
//   --save   with lore --dry: record the prompt in src/lore/<id>.log.json, unsent (a real lore run always records it)
//   --no-ref paint without the style reference (when an image copies the reference's layout, not just its style)
//   --keep-people  with lore: keep the current lore's people (id, name, role, look: their portraits are painted), at
//            the same ports; the model rewrites who they are and what they say, and everything else
// Replaced images are never deleted: they move to art/<id>/old/ with their log entries (setAside).
// The key: OPENROUTER_API_KEY, else openrouter.token here (gitignored), else ~/openrouter.token. Images are
// converted to WebP with Python's Pillow; the raw PNGs stay in art/<id>/raw/ (gitignored).
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const { loadSystem, loadLore } = require('../src/schema.js');
const root = path.join(__dirname, '..');
const readJSON = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

// ---------- arguments ----------
const argv = process.argv.slice(2), cmd = argv[0];
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i < 0 ? def : argv[i + 1]; };
const flag = name => argv.includes('--' + name);
if (!['lore', 'art', 'all'].includes(cmd)) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n')); process.exit(cmd ? 1 : 0); }
const KEEP_PEOPLE = flag('keep-people'), DRY = flag('dry'), FORCE = flag('force'), NO_REF = flag('no-ref'), ONLY = opt('only') ? new Set(opt('only').split(',')) : null;
const TEXT_MODEL = opt('text-model', 'anthropic/claude-sonnet-5.5');
// Each kind of image has its own model and size (size: 1K, 2K or 4K, for models that take it, Gemini's; null, the
// model's default): vistas are big and seen full screen, so a high-quality model at 2K; portraits are small, so a cheap
// one. --image-model and --image-size set both kinds; --vista-model, --portrait-model, --vista-size and --portrait-size
// one kind.
const IMAGE = {
  vista: { model: opt('vista-model', opt('image-model', 'google/gemini-3-pro-image')), size: opt('vista-size', opt('image-size', '2K')) },
  portrait: { model: opt('portrait-model', opt('image-model', 'google/gemini-3.1-flash-image')), size: opt('portrait-size', opt('image-size', null)) }
};
const WORKERS = 3;

// ---------- the system and its facts ----------
const sysFile = `src/systems/${opt('system', 'm1')}.json`;
const sysSchema = readJSON('src/schema/system.schema.json'), loreSchema = readJSON('src/schema/lore.schema.json');
const { system: SYS, bodies: ALL_BODIES, notes: sysNotes } = loadSystem(readJSON(sysFile), sysSchema);
// asteroid belts and fields have facts of their own (beltFacts), not a body's
const BODIES = ALL_BODIES.filter(b => b.kind !== 'belt' && b.kind !== 'field'), BELTS = ALL_BODIES.filter(b => b.kind === 'belt' || b.kind === 'field');
// the universe's backstory and recent events (src/lore/setting.md, written by hand): canon every system's lore agrees
// with, sent whole with the facts; absent, the lore leans on the factions alone
const settingFile = path.join(root, 'src', 'lore', 'setting.md');
const SETTING = fs.existsSync(settingFile) ? fs.readFileSync(settingFile, 'utf8').trim() : '';
// the system's region (src/lore/regions/<region>.md, by hand): its systems, populations and what flows between them
const regionFile = SYS.region ? path.join(root, 'src', 'lore', 'regions', `${SYS.region}.md`) : null;
if (regionFile && !fs.existsSync(regionFile)) { console.error(`gen-content: ${SYS.id} names region ${SYS.region}, but ${path.relative(root, regionFile)} is missing`); process.exit(1); }
const REGION = regionFile ? fs.readFileSync(regionFile, 'utf8').trim() : '';
if (!SYS) { console.error(`${sysFile} is unusable:`, sysNotes); process.exit(1); }
const ECON = readJSON('src/economy.json');
const loreFile = path.join(root, 'src', 'lore', `${SYS.id}.json`), artDir = path.join(root, 'art', SYS.id);
const hashStr = s => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const SEED = +opt('seed', 1);
const seedOf = key => hashStr(`${SYS.id}:${key}:${SEED}`) % 2147483647;

// the setting facts the lore may lean on (the Book's appendix)
const FACTIONS = {
  federation: ['the Federation', 'the navy', 'disciplined, symmetrical, armored; grey and white with heraldic markings; monumental architecture'],
  prism: ['Prism', 'an AI corporation', 'sleek and seamless; white, glass and light; clean luxury, unsettling calm'],
  union: ['the Union', 'the miners' councils of the middle ring, the Red Ring, broken away from the Federation in the Rising (Union crews; nicknamed rusters or rockheads)', 'welded, modular, rusted and patched; sodium-lamp orange; hab rings bolted to rock'],
  blackhulls: ['the Blackhulls', 'pirates, aligned with the Union', 'kitbashed Union and captured hulls, run dark; trophies, mismatched paint'],
  freeflag: ['Freeflag', 'rebels', 'converted civilian craft, improvised; flags and slogans'],
  bloom: ['the Bloom', 'an organic alien hive', 'grown and chitinous, bioluminescent, membranes'],
  glass: ['the Glass', 'an AI zone', 'geometric, fractal, alien precision; no human scale'],
  shadow: ['the Shadow', 'xenophobic alien exterminators', 'massive, brutal, uniform; built only for war'],
  none: ['no one', 'unclaimed', 'whatever the settlers brought']
};
const RING = { inner: 'the inner ring (prosperous)', middle: 'the middle ring (industrial, hard)', outer: 'the outer ring (poor and lawless)' };
const STAR_WORDS = { 'red-dwarf': 'a dim red dwarf', orange: 'an orange star', yellow: 'a yellow star', white: 'a white star', 'blue-giant': 'a blue giant' };

// Image models read colour words, not hex codes, so every colour a prompt carries is named: a hue, darkened or
// paled by lightness, with near-greys named as greys (warm greys as ashen, cool ones as slate).
function colourName(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2, d = mx - mn, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : mx === r ? 60 * (((g - b) / d + 6) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (s < 0.12 || d < 0.085) {
    const tint = d < 0.02 ? '' : h < 70 ? 'ashen ' : h > 180 && h < 260 ? 'slate ' : '';
    return l < 0.16 ? 'charcoal' : l < 0.32 ? `dark ${tint}grey` : l < 0.62 ? `${tint || 'mid '}grey` : l < 0.82 ? `pale ${tint}grey` : 'off-white';
  }
  const dark = l < 0.3, pale = l > 0.68;
  if (h < 12 || h >= 345) return dark ? 'oxblood' : pale ? 'rose pink' : 'red';
  if (h < 40) return dark ? 'dark brown' : l < 0.45 ? 'rust brown' : pale ? 'peach' : s < 0.55 ? 'tan' : 'burnt orange';
  if (h < 58) return dark ? 'umber' : pale ? (s < 0.65 ? 'cream' : 'pale gold') : s < 0.45 ? 'sand' : 'ochre';
  if (h < 80) return dark ? 'dark olive' : pale ? 'pale khaki' : 'olive';
  if (h < 160) return dark ? 'deep forest green' : pale ? 'pale green' : s < 0.4 ? 'olive green' : 'green';
  if (h < 195) return dark ? 'dark teal' : pale ? 'pale aqua' : 'teal';
  if (h < 250) return dark ? 'deep navy blue' : l < 0.45 ? 'deep sea blue' : pale ? 'pale sky blue' : 'sky blue';
  if (h < 290) return dark ? 'deep indigo' : pale ? 'lavender' : 'violet';
  return dark ? 'dark plum' : pale ? 'pink' : 'magenta';
}
const names = list => { const n = [...new Set(list.map(colourName))]; return n.length > 1 ? n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1] : n[0]; };
// What a body looks like from close, in the words a painter needs, from the same look the planet shader draws: each
// palette slot means what the shader uses it for (seas, lowlands, highlands; bands and storms; floors, ground, rims)
function bodyLooks(b) {
  const L = b.look || {}, [c1, c2, c3] = (L.palette || []).map(colourName), atm = L.atmosphere ? colourName(L.atmosphere) : null;
  if (b.kind === 'station' || !c1) return '';
  // what the flight view adds round it: storms flickering with lightning (in terran clouds and giants' belts only: the
  // planet shader draws none on rock), a glittering haze of orbital debris
  const storms = L.surface === 'rock' ? '' : L.lightning >= 0.5 ? ', its night side flickering with lightning' : L.lightning > 0 ? ', with lightning in its storms' : '';
  const junk = (L.debris || 0) * (L.surface === 'rock' ? 3 : 1) >= 2 ? '; a glittering haze of orbital debris rings it' : '';
  const R = L.rings || {}, rings = R.density > 0 ? `; circled by ${R.density > 0.6 ? 'broad, bright' : 'thin, faint'} rings of ${names(R.colours || [])}, seen ${R.tilt > 75 ? 'nearly edge-on' : R.tilt < 35 ? 'nearly face-on' : 'at a slant'}` : '';
  if (L.surface === 'terran') return `a water world: ${c1} seas, ${c2} lowlands and ${c3} highlands with snow on the peaks, under drifting white cloud; its sky is ${atm || 'blue'}${L.cityLights ? ', and its settlements show warm lights at dusk' : ''}${storms}${rings}${junk}`;
  if (L.surface === 'giant') return `a gas giant banded ${c1} and ${c2}, streaked with ${c3} storms${storms}${rings}${junk}`;
  // an ice world: the shader draws it as rock, but its port works ice, so its pale ground is ice and frost, not dust
  if (b.port && b.port.role === 'ice') return `a frozen world of ice and frost with no open water: ${c1} ice in the crater floors and plains, ${c2} higher ground, ${c3} frost on the ridges and crater rims${atm && L.air > 0.05 ? `, under a thin ${atm} haze` : ', under a black sky'}${storms}${rings}${junk}`;
  const all = (L.palette || []).map(colourName), grey = all.every(n => /grey|charcoal|off-white/.test(n));
  return `${grey ? 'an ashen grey' : /^[aeiou]/.test(c2) ? `an ${c2}` : `a ${c2}`} world of bare rock and dust with no water and no plants: ${c1} plains and crater floors, ${c2} higher ground, ${c3} ridges and crater rims${atm && L.air > 0.05 ? `, under a thin ${atm} haze` : ', under a black sky'}${storms}${rings}${junk}`;
}
const byId = id => BODIES.find(b => b.id === id);
const ports = BODIES.filter(b => b.port);

function marketOf(port) {
  const t = ECON.roles[port.role] || {}, name = id => ECON.commodities.find(c => c.id === id).name.toLowerCase();
  const tier = k => Object.keys(t).filter(g => t[g] === k).map(name);
  return { cheapHere: tier('low'), dearHere: tier('high'), traded: tier('medium'), notTraded: ECON.commodities.filter(c => !t[c.id]).map(c => c.name.toLowerCase()) };
}
// The game's map is compressed (a planet is a kilometre or two across), so the facts give order and comparison,
// never sizes or distances: order out from the star, size among the bodies, and each route as near or far.
const fromStar = BODIES.filter(b => b.kind !== 'star' && (!b.parent || b.parent === 'star')).sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
const sizeWord = b => b.kind === 'station' ? 'a station' : b.r >= 2500 ? 'giant' : b.r >= 1200 ? 'large' : b.r >= 800 ? 'middling' : 'small';
const STATION_WORDS = { ring: 'a habitat ring', port: 'a container port', forge: 'a forge', refinery: 'a refinery', shipyard: 'a shipyard', relay: 'a relay array' };
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
function bodyFacts(b) {
  const parent = b.parent && b.parent !== 'star' ? byId(b.parent) : null, d = o => Math.hypot(o.x - b.x, o.y - b.y);
  const others = ports.filter(o => o !== b).sort((x, y) => d(x) - d(y));
  return {
    id: b.id, name: b.name, kind: b.kind, orbits: parent ? parent.name : SYS.star.name,
    position: b.env ? `a station orbiting ${parent.name}, not open to visiting ships` : parent ? (b.kind === 'station' ? `a station orbiting ${parent.name}` : `a moon of ${parent.name}`) : `the ${ORDINAL[fromStar.indexOf(b)]} body out from the star`, size: sizeWord(b),
    owner: b.env ? FACTIONS[b.env.brand][0] : undefined,
    surface: b.kind !== 'station' && b.look ? b.look.surface : undefined, looks: bodyLooks(b) || undefined,
    cityLights: b.kind !== 'station' ? !!(b.look && b.look.cityLights) : undefined, station: b.station ? STATION_WORDS[b.station.archetype] : undefined,
    port: b.port ? {
      name: b.port.name, role: b.port.role, population: b.port.population, builtworld: b.port.builtworld || undefined, services: b.port.services,
      description: b.port.description, market: marketOf(b.port),
      routes: Object.fromEntries(others.map((o, i) => [o.port.name, i === 0 ? 'nearest' : i === others.length - 1 ? 'farthest' : 'between']))
    } : undefined
  };
}
// Belts and fields: where (between which bodies, or round which), what the rocks are, how crowded, and which port routes
// cross a belt; like the bodies, no sizes or distances
const ROCK_WORDS = { carbon: 'dark carbon-rich rubble', silicate: 'stony silicate rock', metal: 'metallic nickel-iron', basalt: 'dark basalt', iron: 'rust-red iron-rich rock',
  olivine: 'green olivine', icy: 'dirty ice', crystal: 'violet crystal', gold: 'gold-veined rock', cobalt: 'blue cobalt-veined rock' };
function beltFacts(k) {
  const parent = k.parent && k.parent !== 'star' ? byId(k.parent) : null, belt = k.kind === 'belt';
  const R = belt ? k.r : Math.hypot(k.x - (parent ? parent.x : 0), k.y - (parent ? parent.y : 0));
  const around = parent ? BODIES.filter(b => b.parent === parent.id) : fromStar, dist = b => Math.hypot(b.x - (parent ? parent.x : 0), b.y - (parent ? parent.y : 0));
  const inner = around.filter(b => dist(b) < R).sort((a, b) => dist(b) - dist(a))[0], outer = around.filter(b => dist(b) > R).sort((a, b) => dist(a) - dist(b))[0];
  const between = inner && outer ? `between ${inner.name} and ${outer.name}` : inner ? `beyond ${inner.name}` : outer ? `inside ${outer.name}'s orbit` : '';
  const where = belt ? (parent ? `a ring of rock circling ${parent.name}` : `a ring of rock round ${SYS.star.name}, ${between}`) : (parent ? `a cluster of rock circling ${parent.name}` : `a cluster of rock on its own orbit, ${between}`);
  const centre = parent || { x: 0, y: 0 }, r = b => Math.hypot(b.x - centre.x, b.y - centre.y);
  const crossedBy = belt ? ports.flatMap((p, i) => ports.slice(i + 1).filter(q => (r(p) - R) * (r(q) - R) < 0).map(q => `${p.port.name} to ${q.port.name}`)) : [];
  return {
    id: k.id, name: k.name, kind: k.kind, where, rocks: k.belt.rocks.map(t => ROCK_WORDS[t]),
    crowding: k.belt.density < 0.3 ? 'scattered' : k.belt.density < 0.7 ? 'loose' : 'thick', sizes: 'mostly boulders and small rocks, a few as big as a station',
    crossedBy: crossedBy.length ? crossedBy : undefined
  };
}
const facts = {
  era: 'the year 2526, about 500 years in the future',
  system: { id: SYS.id, name: SYS.name, description: SYS.description, ring: RING[SYS.ring], star: `${SYS.star.name}, ${STAR_WORDS[SYS.star.class]}` },
  owner: { name: FACTIONS[SYS.owner][0], what: FACTIONS[SYS.owner][1], designLanguage: FACTIONS[SYS.owner][2] },
  otherFactions: Object.entries(FACTIONS).filter(([k]) => k !== SYS.owner && k !== 'none').map(([, f]) => `${f[0]}: ${f[1]}`),
  bodies: BODIES.filter(b => b.kind !== 'star').map(bodyFacts),
  beltsAndFields: BELTS.length ? BELTS.map(beltFacts) : undefined,
  ports: ports.map(b => b.id)
};

// ---------- OpenRouter ----------
function key() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  for (const f of [path.join(root, 'openrouter.token'), path.join(os.homedir(), 'openrouter.token')]) if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  console.error('gen-content: no OpenRouter key (OPENROUTER_API_KEY, ./openrouter.token or ~/openrouter.token)'); process.exit(1);
}
async function chat(body, tries = 3) {
  let last;
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json', 'X-Title': 'Driftward content generator' },
        body: JSON.stringify(Object.assign({ usage: { include: true } }, body)), signal: AbortSignal.timeout(300000)
      });
      const d = await r.json();
      if (d.error) { last = JSON.stringify(d.error).slice(0, 300); }
      else if (!d.choices || !d.choices[0]) last = 'no choices in response';
      else return { msg: d.choices[0].message, cost: (d.usage && d.usage.cost) || 0, provider: d.provider || null, model: d.model || body.model };
    } catch (e) { last = String(e); }
    await new Promise(res => setTimeout(res, 4000 * (a + 1)));
  }
  throw new Error(`OpenRouter call failed: ${last}`);
}

// ---------- lore ----------
const LORE_RULES = `You write the lore for one star system of Driftward, an Escape Velocity-style space trading game. The simulation decides; you narrate.
Rules:
- Everything you write must agree with the facts given: bodies, ports, roles, populations, what each market sells cheap and pays well for, distances. Keep each port's authored description true; you expand it, you do not contradict it.
- Write no prices, credit amounts, quantities or game rules, and no sizes, distances or travel times in units: the facts give only order and comparison. The one exception is people: populations may be mentioned roughly, as the region gives them ("billions on Halde"). People may say what is cheap or dear at their own port, as the market facts list it, but never compare one port's prices with another's. Rumors are colour: they hint at the wider setting but promise no mission, reward or mechanic.
- Tone: grounded, worn, working-class science fiction; specific and sensory; dry humour allowed; no grand prophecy, no chosen ones. Plain prose in British English. Names should feel lived-in, not fantasy.
- The owning faction's design language shapes everything people build here.
- Belts and fields are part of the system: people know them, name places in them, work or avoid them, and tell rumors about them, as the facts make plausible. Nobody mines them yet in a way the facts don't support; they are no port.
- When the region is given, it is canon too: this system's population and its neighbours, trade and troubles as it describes them. The facts still decide the bodies and ports.
- When the setting is given, it is canon: agree with it, use its names and dates, and let its recent events reach this system as far as news, trade and travel would carry them, coloured by who hears them (in rumors, in people's lines, in the history's last years). Don't retell it wholesale or move its events here.
- "vista" describes the painting on the port screen: the view from the landing field or dock, foreground to sky, matching the body's colours and the star's light, with nothing that contradicts the flight view of the body (its surface type, colours and atmosphere). Moons show their parent in the sky.
- "look" describes a person for a portrait painter: face, age, build, clothes, one telling detail; the design language shows in their clothes and gear.
- Person ids are lowercase-hyphenated and unique across the system.
Answer with one JSON object and nothing else, conforming to this JSON Schema:
`;
// --keep-people: the people to keep, by port body id (read from the current lore before it is replaced)
const KEPT = KEEP_PEOPLE ? (() => {
  if (!fs.existsSync(loreFile)) { console.error(`gen-content: --keep-people, but there is no ${path.relative(root, loreFile)}`); process.exit(1); }
  return new Map(JSON.parse(fs.readFileSync(loreFile, 'utf8')).ports.map(p => [p.body, p.people.map(({ id, name, role, look }) => ({ id, name, role, look }))]));
})() : null;
const keptText = () => KEPT ? `\n\nKeep these people, at these ports, with exactly these ids, names, roles and looks (their portraits are already painted). Rewrite who they are ("text") and what they say ("line") to fit everything above, but never against their look: their sex, age, build, face and clothes are as the look says, since the portrait shows them. Add no one, drop no one:\n${JSON.stringify(Object.fromEntries(KEPT), null, 1)}` : '';
// the kept people's problems in an answer (missing, extra or moved); then their fixed fields are put back exactly
function keptProblems(lore) {
  if (!KEPT) return [];
  const out = [];
  for (const p of lore.ports) {
    const want = KEPT.get(p.body) || [], ids = p.people.map(q => q.id);
    for (const k of want) if (!ids.includes(k.id)) out.push(`$.ports[${p.body}]: person ${k.id} (${k.name}) is missing`);
    for (const id of ids) if (!want.some(k => k.id === id)) out.push(`$.ports[${p.body}]: person ${id} is not one of the people to keep here`);
  }
  return out;
}
function putBackKept(lore) {
  if (!KEPT) return;
  for (const p of lore.ports) for (const q of p.people) { const k = (KEPT.get(p.body) || []).find(k => k.id === q.id); if (k) Object.assign(q, { name: k.name, role: k.role, look: k.look }); }
}
// What the other systems' lore already uses (src/lore/<id>.json but this one's): its people's names and its rumors, so
// a system gets people and stories of its own. A name part (first name or surname) used elsewhere is a problem.
const OTHERS = fs.readdirSync(path.join(root, 'src', 'lore')).filter(f => /^[a-z0-9-]+\.json$/.test(f) && !f.endsWith('.log.json') && f !== `${SYS.id}.json`)
  .map(f => JSON.parse(fs.readFileSync(path.join(root, 'src', 'lore', f), 'utf8'))).filter(l => l && l.ports);
const otherNames = OTHERS.flatMap(l => l.ports.flatMap(p => p.people.map(q => q.name)));
const otherParts = new Set(otherNames.flatMap(n => n.replace(/^(Dr|Lt|Lieutenant|Corporal|Captain|Sergeant)\.? /, '').split(/\s+/)).map(w => w.toLowerCase()));
const othersText = () => OTHERS.length ? `\n\nOther systems' lore is already written. Give this system's people first names and surnames none of these use: ${otherNames.join(', ')}. And give it rumors of its own, not new versions of these:\n${OTHERS.flatMap(l => l.ports.flatMap(p => p.rumors)).map(r => '- ' + r).join('\n')}` : '';
function nameProblems(lore) {
  if (KEPT) return [];
  return lore.ports.flatMap(p => p.people.flatMap(q => q.name.replace(/^(Dr|Lt|Lieutenant|Corporal|Captain|Sergeant)\.? /, '').split(/\s+/).filter(w => otherParts.has(w.toLowerCase()))
    .map(w => `$.ports[${p.body}].people[${q.id}]: "${w}" (in ${q.name}) is already used by another system's people`)));
}
function lorePrompt(feedback) {
  return [
    { role: 'system', content: LORE_RULES + JSON.stringify(loreSchema) },
    { role: 'user', content: (SETTING ? `The setting:\n${SETTING}\n\n` : '') + (REGION ? `The region:\n${REGION}\n\n` : '') + `The facts:\n${JSON.stringify(facts, null, 1)}\n\nWrite the lore for system "${SYS.id}", with one entry in "ports" for each of these bodies: ${facts.ports.join(', ')}.` + keptText() + othersText() + (feedback ? `\n\nYour last answer had these problems; fix them:\n${feedback}` : '') }
  ];
}
function parseJSON(text) {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  return JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s);
}
// The lore run's record, beside the lore (src/lore/<id>.log.json): the facts, the messages sent, the model, seed,
// cost and each attempt's problems; the game's debug screen shows it. `lore --dry --save` records the prompt as the
// tool builds it now without sending it (sent: false), for lore written before the log existed.
const loreLogFile = loreFile.replace(/\.json$/, '.log.json');
const LORE_PARAMS = { seed: seedOf('lore'), temperature: 0.8, max_tokens: 16000 };
function writeLoreLog(rec) {
  fs.mkdirSync(path.dirname(loreLogFile), { recursive: true });
  fs.writeFileSync(loreLogFile, JSON.stringify(Object.assign({ date: new Date().toISOString().slice(0, 10), model: TEXT_MODEL }, LORE_PARAMS, rec, { facts, messages: lorePrompt(rec.feedback) }), null, 1) + '\n');
}
// Lore is never lost either: the lore and its record about to be replaced move to src/lore/old/<id>.<date>.json and
// <id>.<date>.log.json (numbered if taken)
function setAsideLore() {
  if (!fs.existsSync(loreFile)) return;
  const oldDir = path.join(path.dirname(loreFile), 'old'), rec = fs.existsSync(loreLogFile) ? JSON.parse(fs.readFileSync(loreLogFile, 'utf8')) : {};
  const date = rec.date || new Date(fs.statSync(loreFile).mtimeMs).toISOString().slice(0, 10);
  fs.mkdirSync(oldDir, { recursive: true });
  let base = `${SYS.id}.${date}`;
  for (let n = 2; fs.existsSync(path.join(oldDir, base + '.json')); n++) base = `${SYS.id}.${date}-${n}`;
  fs.renameSync(loreFile, path.join(oldDir, base + '.json'));
  if (fs.existsSync(loreLogFile)) fs.renameSync(loreLogFile, path.join(oldDir, base + '.log.json'));
  console.log(`  set aside the old lore as src/lore/old/${base}.json`);
}
async function genLore() {
  if (DRY) {
    lorePrompt().forEach(m => console.log(`--- ${m.role} ---\n${m.content}\n`));
    if (flag('save')) { writeLoreLog({ sent: false, note: 'Recorded with --dry --save: the prompt as the tool builds it now, not necessarily the one the lore was written from.' }); console.log(`wrote ${path.relative(root, loreLogFile)} (unsent)`); }
    return null;
  }
  let feedback = '', total = 0, served = {};
  const attempts = [], t0 = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t = Date.now();
    const { msg, cost, provider, model } = await chat(Object.assign({ model: TEXT_MODEL, messages: lorePrompt(feedback) }, LORE_PARAMS));
    total += cost; served = { provider, servedModel: model };
    let raw;
    try { raw = parseJSON(msg.content); } catch (e) { attempts.push({ cost, provider, problems: [`not valid JSON: ${e.message}`] }); feedback = `not valid JSON: ${e.message}`; console.log(`lore attempt ${attempt}: ${feedback}`); continue; }
    const { lore, notes } = loadLore(raw, loreSchema, SYS);
    notes.forEach(n => console.log(`  ${n.fatal ? 'FATAL' : 'clamped'} ${n.path}: ${n.msg}`));
    attempts.push({ cost, provider, problems: notes.map(n => `${n.fatal ? 'FATAL' : 'clamped'} ${n.path}: ${n.msg}`) });
    const kept = lore ? [...keptProblems(lore), ...nameProblems(lore)] : [];
    if (kept.length) { kept.forEach(k => console.log(`  ${k}`)); attempts[attempts.length - 1].problems.push(...kept); }
    if (!lore || kept.length || notes.some(n => /no lore for port|dropped/.test(n.msg))) { feedback = [...notes.map(n => `${n.path}: ${n.msg}`), ...kept].join('\n'); console.log(`lore attempt ${attempt}: ${notes.length + kept.length} problem(s), retrying`); continue; }
    putBackKept(lore);
    fs.mkdirSync(path.dirname(loreFile), { recursive: true });
    setAsideLore();
    fs.writeFileSync(loreFile, JSON.stringify(lore, null, 2) + '\n');
    writeLoreLog({ sent: true, ...served, cost: total, seconds: Math.round((Date.now() - t0) / 1000), attempts, feedback });
    console.log(`wrote ${path.relative(root, loreFile)}: ${lore.ports.length} ports, ${lore.ports.reduce((n, p) => n + p.people.length, 0)} people (${TEXT_MODEL} via ${served.provider || 'unknown provider'}, ${((Date.now() - t) / 1000).toFixed(0)} s, $${total.toFixed(3)})`);
    return lore;
  }
  throw new Error('lore: no usable answer in 3 attempts');
}

// ---------- art ----------
const VISTA_STYLE = 'A painted vista for the landing screen of a space trading game: futuristic, painterly, a cinematic matte painting with visible brushwork, wide 16:9. No text, lettering, logos, UI, borders or frames.';
// Each faction's art direction, in vistas and portraits alike: its systems look like its own (the art bible, from the
// lore, gives one system's palette, light and materials within it)
const FACTION_ART = {
  union: 'Union art direction: gritty industrial realism. Welded, rusted and patched metal, sodium-lamp orange against deep shadow, grime, steam and soot, everything built for work and mended rather than replaced.',
  federation: 'Federation art direction: brutalism. Monumental raw-concrete masses, heavy slabs and deep-set windows, stark repeated geometry and hard shadows, grey and white with heraldic banners and crests; architecture built to dwarf the people in it, ordered, imposing and austere.',
  prism: 'Prism art direction: slightly retro corporate futurism, like a 1970s or 1980s corporate brochure or airbrushed space art: smooth white curves, chrome trim and tinted glass, soft gradient skies, gentle pastel accent lights, a polished optimistic sheen that feels a little dated and a little too perfect.'
};
const factionArt = () => FACTION_ART[SYS.owner] || '';
const PORTRAIT_STYLE = 'A character portrait in a painterly fantasy-realism style, the classic CRPG portrait look: head and shoulders, three-quarter view, looking at the viewer, dramatic soft key light, a dark, softly painted background. No text, lettering, borders or frames.';
const bibleText = lore => { const a = lore.artBible; return `Art bible for the ${SYS.name} system. Palette: ${names(a.palette)}. Lighting: ${a.lighting} Architecture: ${a.architecture} Materials: ${a.materials} Mood: ${a.mood} Design language: ${a.design}`; };
// how busy a port looks, by its population tier: a world of billions is a city to the horizon, not a field and a few towers
const CROWD = { outwatch: ' A lonely outwatch: a few thousand people at most, and the dark all round.', outpost: ' A small, sparse outpost.', colony: ' A working settlement of a few million.',
  complex: ' A busy place of tens or hundreds of millions: built up all round the port, with ships coming and going.',
  world: ' One of the most crowded places in the region, home to billions: city to the horizon, towers and lights everywhere, the sky busy with ships.' };
const BUILTWORLD_CROWD = ' A Builtworld: the whole planet built over into one city of some ten billion people, no open ground left anywhere, towers to the horizon and the sky thick with ships.';
function vistaPrompt(lore, b, ref, cross) {
  const p = lore.ports.find(q => q.body === b.id), L = b.look || {}, parent = b.parent && b.parent !== 'star' ? byId(b.parent) : null;
  const role = b.port.role.replace('-', ' '), crowd = b.port.builtworld ? BUILTWORLD_CROWD : CROWD[b.port.population] || '';
  const where = b.kind === 'station'
    ? `${b.port.name}, the ${role} station of the system, ${STATION_WORDS[b.station.archetype]} in open space between the worlds.${crowd}`
    : `${b.port.name}, the ${role} port of ${b.name}${parent ? `, a moon of ${parent.name}` : ''}.${crowd} ${b.name} is ${bodyLooks(b)}.`;
  const sky = parent && parent.look ? ` ${parent.name}, ${bodyLooks(parent)}, hangs huge in the sky.` : '';
  return [VISTA_STYLE, factionArt(), bibleText(lore), `The place: ${where}${sky} The light comes from ${STAR_WORDS[SYS.star.class]}.`, `The scene: ${p.vista}`,
    'Composition: the left two fifths of the scene are naturally darker and calmer, in shadow, sky or empty ground, with no focal point there, because the port\'s text panel is drawn over it; the main interest sits right of centre. Paint that darkness as part of the scene itself: never a band, panel, overlay or straight vertical edge.',
    ref ? `The attached image is ${cross ? 'the style reference for this faction\'s systems, from another of them' : 'this system\'s style reference'}, for the painting only: match its brushwork, finish and treatment of light${cross ? ', within this faction\'s art direction above' : ''}. Take nothing else from it: not its landscape, sea, cliffs, buildings, rings or layout. The ground, sky and colours come from the description above.` : ''].filter(Boolean).join('\n\n');
}
function portraitPrompt(lore, b, q, ref, cross) {
  return [PORTRAIT_STYLE, factionArt(), bibleText(lore), `${q.name}, ${q.role}, at ${b.port.name} (${b.name}). ${q.look}`, `Who they are: ${q.text}`, `Their people: ${lore.culture}`,
    'The background is the dim bar of the port, out of focus, in the system\'s palette.',
    ref ? `The attached image is the style reference for ${cross ? 'this faction\'s portraits, from another of its systems' : 'this system\'s portraits'}: match its painting style, framing, light and finish, but paint this person, not the reference's subject.` : ''].filter(Boolean).join('\n\n');
}
async function image(kind, prompt, aspect, seed, refPng) {
  const { model: IMAGE_MODEL, size: IMAGE_SIZE } = IMAGE[kind];
  const content = [{ type: 'text', text: prompt }];
  if (refPng) content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + refPng.toString('base64') } });
  for (let a = 0; a < 3; a++) {
    const { msg, cost, provider, model } = await chat({ model: IMAGE_MODEL, modalities: ['image', 'text'], image_config: Object.assign({ aspect_ratio: aspect }, IMAGE_SIZE ? { image_size: IMAGE_SIZE } : {}), seed, messages: [{ role: 'user', content }] });
    const img = (msg.images || [])[0];
    if (img) return { png: Buffer.from(img.image_url.url.split(',', 2)[1], 'base64'), cost, provider, servedModel: model };
    console.log(`  no image in the answer (${String(msg.content || '').slice(0, 120)}); retrying`);
  }
  throw new Error('image: no image in 3 attempts');
}
// raw PNG -> WebP at the size the page shows it, cropped to the aspect if the model's drifts
function toWebp(rawFile, outFile, w, h, quality) {
  const py = 'import sys\nfrom PIL import Image, ImageOps\nsrc, dst, w, h, q = sys.argv[1:6]\n'
    + 'ImageOps.fit(Image.open(src).convert("RGB"), (int(w), int(h)), Image.LANCZOS).save(dst, "WEBP", quality=int(q), method=6)';
  const r = spawnSync('python3', ['-c', py, rawFile, outFile, w, h, quality], { encoding: 'utf8' });
  if (r.status) throw new Error(`WebP conversion failed (needs python3 with Pillow): ${r.stderr}`);
}
const ART = { vista: { aspect: '16:9', w: 1600, h: 900, q: 80 }, portrait: { aspect: '4:5', w: 512, h: 640, q: 82 } };

// Art is never lost: an image about to be replaced moves to art/<id>/old/ (and its raw PNG to raw/old/) as
// <name>.<date it was made>.webp, numbered if that is taken, with its log entry under old/<that name>
function setAside(name, log) {
  const cur = path.join(artDir, name + '.webp');
  if (!fs.existsSync(cur)) return;
  const rec = log[name + '.webp'] || {}, date = rec.date || new Date(fs.statSync(cur).mtimeMs).toISOString().slice(0, 10);
  const oldDir = path.join(artDir, 'old'), rawOld = path.join(artDir, 'raw', 'old');
  fs.mkdirSync(oldDir, { recursive: true }); fs.mkdirSync(rawOld, { recursive: true });
  let base = `${name}.${date}`;
  for (let n = 2; fs.existsSync(path.join(oldDir, base + '.webp')); n++) base = `${name}.${date}-${n}`;
  fs.renameSync(cur, path.join(oldDir, base + '.webp'));
  const raw = path.join(artDir, 'raw', name + '.png');
  if (fs.existsSync(raw)) fs.renameSync(raw, path.join(rawOld, base + '.png'));
  if (log[name + '.webp']) { log['old/' + base + '.webp'] = log[name + '.webp']; delete log[name + '.webp']; }
  console.log(`  set aside the old ${name}.webp as old/${base}.webp`);
}
async function genArt(lore) {
  if (!lore) {
    if (!fs.existsSync(loreFile)) { console.error(`art: no ${path.relative(root, loreFile)}; run lore first`); process.exit(1); }
    const r = loadLore(JSON.parse(fs.readFileSync(loreFile, 'utf8')), loreSchema, SYS);
    r.notes.forEach(n => console.log(`  lore ${n.path}: ${n.msg}`));
    if (!r.lore) process.exit(1);
    lore = r.lore;
  }
  const rawDir = path.join(artDir, 'raw'), logFile = path.join(artDir, 'log.json');
  fs.mkdirSync(rawDir, { recursive: true });
  const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : {};
  // the jobs, in order: the start port's vista first (the reference), then the other ports'; then the portraits
  const start = ports.find(b => b.id === SYS.start) || ports[0];
  const vistaJobs = [start, ...ports.filter(b => b !== start)].filter(b => lore.ports.some(p => p.body === b.id))
    .map(b => ({ kind: 'vista', id: b.id, name: `vista-${b.id}`, make: (ref, cross) => vistaPrompt(lore, b, ref, cross) }));
  const portraitJobs = lore.ports.flatMap(p => p.people.map(q => ({ kind: 'portrait', id: q.id, name: `portrait-${q.id}`, make: (ref, cross) => portraitPrompt(lore, byId(p.body), q, ref, cross) })));
  // A faction's style reference: another system of the same owner's reference vista or portrait (the one painted with
  // no reference of its own), if it has been painted here (its raw PNG). When there is one, every image of that kind in
  // this system takes it, so a faction's systems share a look; otherwise the system's own first image is the reference.
  const factionRef = kind => {
    for (const f of fs.readdirSync(path.join(root, 'src', 'systems')).filter(f => f.endsWith('.json'))) {
      const raw = readJSON(`src/systems/${f}`), d = path.join(root, 'art', raw.id), lg = path.join(d, 'log.json');
      if (raw.id === SYS.id || raw.owner !== SYS.owner || !fs.existsSync(lg)) continue;
      const e = Object.entries(JSON.parse(fs.readFileSync(lg, 'utf8'))).find(([k, v]) => k.startsWith(kind + '-') && v && !v.reference);
      const png = e && path.join(d, 'raw', e[0].replace(/\.webp$/, '.png'));
      if (png && fs.existsSync(png)) return { png, name: `${raw.id}/${e[0]}` };
    }
    return null;
  };
  const CROSS = NO_REF ? {} : { vista: factionRef('vista'), portrait: factionRef('portrait') };
  let total = 0, made = 0;
  const run = async (job, refJob) => {
    const cross = CROSS[job.kind];
    const ref = cross ? cross.png : refJob && job !== refJob && !NO_REF ? path.join(rawDir, refJob.name + '.png') : null, prompt = job.make(!!ref, !!cross), spec = ART[job.kind];
    if (DRY) { console.log(`--- ${job.name}${ref ? ` (reference ${cross ? cross.name : refJob.name})` : ''}: ${IMAGE[job.kind].model}${IMAGE[job.kind].size ? ` at ${IMAGE[job.kind].size}` : ''} ---\n${prompt}\n`); return; }
    const t = Date.now(), seed = seedOf(job.name);
    const { png, cost, provider, servedModel } = await image(job.kind, prompt, spec.aspect, seed, ref && fs.existsSync(ref) ? fs.readFileSync(ref) : null);
    const rawFile = path.join(rawDir, job.name + '.png'), outFile = path.join(artDir, job.name + '.webp');
    setAside(job.name, log);
    fs.writeFileSync(rawFile, png);
    toWebp(rawFile, outFile, spec.w, spec.h, spec.q);
    log[job.name + '.webp'] = { prompt, model: IMAGE[job.kind].model, provider, servedModel, size: IMAGE[job.kind].size || undefined, seed, reference: ref ? (cross ? cross.name : refJob.name + '.webp') : null, cost, seconds: Math.round((Date.now() - t) / 1000), date: new Date().toISOString().slice(0, 10) };
    total += cost; made++;
    console.log(`  ${path.relative(root, outFile)}  ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB  $${cost.toFixed(3)}  ${((Date.now() - t) / 1000).toFixed(0)} s`);
  };
  const want = job => (!ONLY || ONLY.has(job.id)) && (FORCE || DRY || !fs.existsSync(path.join(artDir, job.name + '.webp')));
  // the reference goes alone, before the jobs that use it; the rest run a few at a time
  for (const jobs of [vistaJobs, portraitJobs]) {
    if (!jobs.length) continue;
    const ref = jobs[0], rest = jobs.slice(1).filter(want);
    if (want(ref)) await run(ref, null);
    else if (rest.length && !DRY && !fs.existsSync(path.join(rawDir, ref.name + '.png'))) console.log(`  no raw ${ref.name}.png to use as the reference: the others go without one`);
    for (let i = 0; i < rest.length; i += WORKERS) await Promise.all(rest.slice(i, i + WORKERS).map(j => run(j, ref)));
  }
  if (DRY) return;
  fs.writeFileSync(logFile, JSON.stringify(Object.fromEntries(Object.entries(log).sort()), null, 1) + '\n');
  console.log(`art: ${made} image(s), $${total.toFixed(2)} (vistas ${IMAGE.vista.model}, portraits ${IMAGE.portrait.model})`);
}

(async () => {
  let lore = null;
  if (cmd === 'lore' || cmd === 'all') lore = await genLore();
  if (cmd === 'art' || cmd === 'all') {
    if (DRY && !lore && !fs.existsSync(loreFile)) { console.log('art: no lore file yet, so no art prompts to show'); return; }
    await genArt(lore);
  }
})().catch(e => { console.error('gen-content:', e.message); process.exit(1); });
