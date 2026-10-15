// The content generator: a system's lore and art, written by models through OpenRouter from the system's sim facts
// (the Book: "sim decides, LLM narrates"). It runs offline, before the game: what it writes is reviewed and committed,
// and the page only reads it, so play never waits on a model and a seed always shows the same words and pictures.
//
//   lore  one text call for the whole system (so its ports agree): history, culture, the art bible, and per port a
//         description, notable places, people, rumors and what its vista shows -> src/lore/<id>.json, clamped by
//         the game's own validator (src/schema.js) against src/schema/lore.schema.json
//   art   from the lore: a painted vista per port and a portrait per person -> art/<id>/*.webp, with every prompt,
//         model, seed and cost in art/<id>/log.json. The start port's vista goes first and is the style reference
//         for the other vistas (the Book: the first approved vista); likewise the first portrait for the portraits.
//         If you redo the reference (--only <it> --force), redo the rest after it too.
//   all   lore, then art
//
// Usage: node tools/gen-content.js <lore|art|all> [--system m1] [--only id,id] [--force] [--dry]
//          [--text-model M] [--image-model M] [--seed N]
//   --only   port body ids and person ids to (re)generate; art only
//   --force  regenerate what exists (lore always regenerates)
//   --dry    print the prompts; no calls, no key needed
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
const DRY = flag('dry'), FORCE = flag('force'), ONLY = opt('only') ? new Set(opt('only').split(',')) : null;
const TEXT_MODEL = opt('text-model', 'anthropic/claude-sonnet-5.5');
const IMAGE_MODEL = opt('image-model', 'google/gemini-3.1-flash-image');
const WORKERS = 3;

// ---------- the system and its facts ----------
const sysFile = `src/systems/${opt('system', 'm1')}.json`;
const sysSchema = readJSON('src/schema/system.schema.json'), loreSchema = readJSON('src/schema/lore.schema.json');
const { system: SYS, bodies: BODIES, notes: sysNotes } = loadSystem(readJSON(sysFile), sysSchema);
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
  ironhulls: ['the Ironhulls', 'miners (an ironhull, ironhulls; nicknamed rusters or rockheads)', 'welded, modular, rusted and patched; sodium-lamp orange; hab rings bolted to rock'],
  blackhulls: ['the Blackhulls', 'pirates, aligned with the Ironhulls', 'kitbashed Ironhull and captured hulls, run dark; trophies, mismatched paint'],
  freeflag: ['Freeflag', 'rebels', 'converted civilian craft, improvised; flags and slogans'],
  bloom: ['the Bloom', 'an organic alien hive', 'grown and chitinous, bioluminescent, membranes'],
  glass: ['the Glass', 'an AI zone', 'geometric, fractal, alien precision; no human scale'],
  shadow: ['the Shadow', 'xenophobic alien exterminators', 'massive, brutal, uniform; built only for war'],
  none: ['no one', 'unclaimed', 'whatever the settlers brought']
};
const RING = { inner: 'the inner ring (prosperous)', middle: 'the middle ring (industrial, hard)', outer: 'the outer ring (poor and lawless)' };
const STAR_WORDS = { 'red-dwarf': 'a dim red dwarf', orange: 'an orange star', yellow: 'a yellow star', white: 'a white star', 'blue-giant': 'a blue giant' };
const bodyWords = b => ({ rock: `a rocky ${b.kind}`, terran: `a temperate ${b.kind} of seas and cloud`, giant: 'a gas giant' })[(b.look || {}).surface] || `a ${b.kind}`;
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
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
function bodyFacts(b) {
  const parent = b.parent && b.parent !== 'star' ? byId(b.parent) : null, d = o => Math.hypot(o.x - b.x, o.y - b.y);
  const others = ports.filter(o => o !== b).sort((x, y) => d(x) - d(y));
  return {
    id: b.id, name: b.name, kind: b.kind, orbits: parent ? parent.name : SYS.star.name,
    position: parent ? `a moon of ${parent.name}` : `the ${ORDINAL[fromStar.indexOf(b)]} body out from the star`, size: sizeWord(b),
    surface: b.look && b.look.surface, colours: b.look && b.look.palette, atmosphere: b.look && b.look.atmosphere,
    cityLights: !!(b.look && b.look.cityLights), station: b.station ? b.station.archetype : undefined,
    port: b.port ? {
      name: b.port.name, role: b.port.role, population: b.port.population, services: b.port.services,
      description: b.port.description, market: marketOf(b.port),
      routes: Object.fromEntries(others.map((o, i) => [o.port.name, i === 0 ? 'nearest' : i === others.length - 1 ? 'farthest' : 'between']))
    } : undefined
  };
}
const facts = {
  era: 'about 500 years in the future',
  system: { id: SYS.id, name: SYS.name, description: SYS.description, ring: RING[SYS.ring], star: `${SYS.star.name}, ${STAR_WORDS[SYS.star.class]}` },
  owner: { name: FACTIONS[SYS.owner][0], what: FACTIONS[SYS.owner][1], designLanguage: FACTIONS[SYS.owner][2] },
  otherFactions: Object.entries(FACTIONS).filter(([k]) => k !== SYS.owner && k !== 'none').map(([, f]) => `${f[0]}: ${f[1]}`),
  bodies: BODIES.filter(b => b.kind !== 'star').map(bodyFacts),
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
      else return { msg: d.choices[0].message, cost: (d.usage && d.usage.cost) || 0 };
    } catch (e) { last = String(e); }
    await new Promise(res => setTimeout(res, 4000 * (a + 1)));
  }
  throw new Error(`OpenRouter call failed: ${last}`);
}

// ---------- lore ----------
const LORE_RULES = `You write the lore for one star system of Driftward, an Escape Velocity-style space trading game. The simulation decides; you narrate.
Rules:
- Everything you write must agree with the facts given: bodies, ports, roles, populations, what each market sells cheap and pays well for, distances. Keep each port's authored description true; you expand it, you do not contradict it.
- Write no prices, credit amounts, quantities or game rules, and no sizes, distances or travel times in units: the facts give only order and comparison. People may say what is cheap or dear at their own port, as the market facts list it, but never compare one port's prices with another's. Rumors are colour: they hint at the wider setting but promise no mission, reward or mechanic.
- Tone: grounded, worn, working-class science fiction; specific and sensory; dry humour allowed; no grand prophecy, no chosen ones. Plain prose in British English. Names should feel lived-in, not fantasy.
- The owning faction's design language shapes everything people build here.
- "vista" describes the painting on the port screen: the view from the landing field or dock, foreground to sky, matching the body's colours and the star's light, with nothing that contradicts the flight view of the body (its surface type, colours and atmosphere). Moons show their parent in the sky.
- "look" describes a person for a portrait painter: face, age, build, clothes, one telling detail; the design language shows in their clothes and gear.
- Person ids are lowercase-hyphenated and unique across the system.
Answer with one JSON object and nothing else, conforming to this JSON Schema:
`;
function lorePrompt(feedback) {
  return [
    { role: 'system', content: LORE_RULES + JSON.stringify(loreSchema) },
    { role: 'user', content: `The facts:\n${JSON.stringify(facts, null, 1)}\n\nWrite the lore for system "${SYS.id}", with one entry in "ports" for each of these bodies: ${facts.ports.join(', ')}.` + (feedback ? `\n\nYour last answer had these problems; fix them:\n${feedback}` : '') }
  ];
}
function parseJSON(text) {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  return JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s);
}
async function genLore() {
  if (DRY) { lorePrompt().forEach(m => console.log(`--- ${m.role} ---\n${m.content}\n`)); return null; }
  let feedback = '', total = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t = Date.now();
    const { msg, cost } = await chat({ model: TEXT_MODEL, messages: lorePrompt(feedback), seed: seedOf('lore'), temperature: 0.8, max_tokens: 16000 });
    total += cost;
    let raw;
    try { raw = parseJSON(msg.content); } catch (e) { feedback = `not valid JSON: ${e.message}`; console.log(`lore attempt ${attempt}: ${feedback}`); continue; }
    const { lore, notes } = loadLore(raw, loreSchema, SYS);
    notes.forEach(n => console.log(`  ${n.fatal ? 'FATAL' : 'clamped'} ${n.path}: ${n.msg}`));
    if (!lore || notes.some(n => /no lore for port|dropped/.test(n.msg))) { feedback = notes.map(n => `${n.path}: ${n.msg}`).join('\n'); console.log(`lore attempt ${attempt}: ${notes.length} problem(s), retrying`); continue; }
    fs.mkdirSync(path.dirname(loreFile), { recursive: true });
    fs.writeFileSync(loreFile, JSON.stringify(lore, null, 2) + '\n');
    console.log(`wrote ${path.relative(root, loreFile)}: ${lore.ports.length} ports, ${lore.ports.reduce((n, p) => n + p.people.length, 0)} people (${TEXT_MODEL}, ${((Date.now() - t) / 1000).toFixed(0)} s, $${total.toFixed(3)})`);
    return lore;
  }
  throw new Error('lore: no usable answer in 3 attempts');
}

// ---------- art ----------
const VISTA_STYLE = 'A painted vista for the landing screen of a space trading game: futuristic, painterly, a cinematic matte painting with visible brushwork, wide 16:9. No text, lettering, logos, UI, borders or frames.';
const PORTRAIT_STYLE = 'A character portrait in a painterly fantasy-realism style, the classic CRPG portrait look: head and shoulders, three-quarter view, looking at the viewer, dramatic soft key light, a dark, softly painted background. No text, lettering, borders or frames.';
const bibleText = lore => { const a = lore.artBible; return `Art bible for the ${SYS.name} system. Palette: ${a.palette.join(', ')}. Lighting: ${a.lighting} Architecture: ${a.architecture} Materials: ${a.materials} Mood: ${a.mood} Design language: ${a.design}`; };
function vistaPrompt(lore, b, ref) {
  const p = lore.ports.find(q => q.body === b.id), L = b.look || {}, parent = b.parent && b.parent !== 'star' ? byId(b.parent) : null;
  const where = b.kind === 'station'
    ? `${b.port.name}, a ${b.port.population} ${b.port.role} station (a ${b.station.archetype}) in open space between the worlds.`
    : `${b.port.name}, a ${b.port.population} ${b.port.role} port on ${b.name}, ${bodyWords(b)}${parent ? ` of ${parent.name}` : ''}. Its ground and rock read as ${L.palette.join(', ')}; its sky and atmosphere glow ${L.atmosphere}${L.cityLights ? '; settlements show warm lights' : ''}.`;
  const sky = parent && parent.look ? ` ${parent.name}, ${bodyWords(parent)} banded ${parent.look.palette.join(', ')}, hangs huge in the sky.` : '';
  return [VISTA_STYLE, bibleText(lore), `The place: ${where}${sky} The light comes from ${STAR_WORDS[SYS.star.class]}.`, `The scene: ${p.vista}`,
    'Composition: keep the left two fifths of the image darker and calmer, with no focal point there, because the port\'s text panel is drawn over it; the main interest sits right of centre.',
    ref ? 'The attached image is this system\'s style reference: match its painting style, brushwork, palette treatment and light, but paint the place described here, not the reference\'s content.' : ''].filter(Boolean).join('\n\n');
}
function portraitPrompt(lore, b, q, ref) {
  return [PORTRAIT_STYLE, bibleText(lore), `${q.name}, ${q.role}, at ${b.port.name} (${b.name}). ${q.look}`, `Who they are: ${q.text}`, `Their people: ${lore.culture}`,
    'The background is the dim bar of the port, out of focus, in the system\'s palette.',
    ref ? 'The attached image is the style reference for this system\'s portraits: match its painting style, framing, light and finish, but paint this person, not the reference\'s subject.' : ''].filter(Boolean).join('\n\n');
}
async function image(prompt, aspect, seed, refPng) {
  const content = [{ type: 'text', text: prompt }];
  if (refPng) content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + refPng.toString('base64') } });
  for (let a = 0; a < 3; a++) {
    const { msg, cost } = await chat({ model: IMAGE_MODEL, modalities: ['image', 'text'], image_config: { aspect_ratio: aspect }, seed, messages: [{ role: 'user', content }] });
    const img = (msg.images || [])[0];
    if (img) return { png: Buffer.from(img.image_url.url.split(',', 2)[1], 'base64'), cost };
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
    .map(b => ({ kind: 'vista', id: b.id, name: `vista-${b.id}`, make: ref => vistaPrompt(lore, b, ref) }));
  const portraitJobs = lore.ports.flatMap(p => p.people.map(q => ({ kind: 'portrait', id: q.id, name: `portrait-${q.id}`, make: ref => portraitPrompt(lore, byId(p.body), q, ref) })));
  let total = 0, made = 0;
  const run = async (job, refJob) => {
    const ref = refJob && job !== refJob ? path.join(rawDir, refJob.name + '.png') : null, prompt = job.make(!!ref), spec = ART[job.kind];
    if (DRY) { console.log(`--- ${job.name}${ref ? ` (reference ${refJob.name})` : ''} ---\n${prompt}\n`); return; }
    const t = Date.now(), seed = seedOf(job.name);
    const { png, cost } = await image(prompt, spec.aspect, seed, ref && fs.existsSync(ref) ? fs.readFileSync(ref) : null);
    const rawFile = path.join(rawDir, job.name + '.png'), outFile = path.join(artDir, job.name + '.webp');
    fs.writeFileSync(rawFile, png);
    toWebp(rawFile, outFile, spec.w, spec.h, spec.q);
    log[job.name + '.webp'] = { prompt, model: IMAGE_MODEL, seed, reference: ref ? refJob.name + '.webp' : null, cost, seconds: Math.round((Date.now() - t) / 1000), date: new Date().toISOString().slice(0, 10) };
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
  console.log(`art: ${made} image(s), $${total.toFixed(2)} (${IMAGE_MODEL})`);
}

(async () => {
  let lore = null;
  if (cmd === 'lore' || cmd === 'all') lore = await genLore();
  if (cmd === 'art' || cmd === 'all') {
    if (DRY && !lore && !fs.existsSync(loreFile)) { console.log('art: no lore file yet, so no art prompts to show'); return; }
    await genArt(lore);
  }
})().catch(e => { console.error('gen-content:', e.message); process.exit(1); });
