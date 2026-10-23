// Faction logos through OpenRouter, the same way gen-content.js paints vistas: each faction's emblem from a brief drawn
// from the setting (src/lore/setting.md), candidates to choose from, with every prompt, model, seed and cost in
// art/factions/log.json. Raw PNGs stay in art/factions/raw/ (gitignored). Two kinds, from the same mark:
//   painted  a rich enamel badge on near-black -> art/factions/<faction>-<n>.webp
//   flat     the clean-lines version: two or three flat colours, painted on solid magenta, which is then keyed out
//            (edges unmixed from the magenta, so no fringe) -> art/factions/<faction>-flat-<n>.png, transparent
// The candidates chosen are promoted by hand to <faction>.webp and <faction>-flat.png (the rest set aside in old/),
// which the build lists for the pages (tools/build.py: the universe index's art.logos).
//
// Usage: node tools/gen-logos.js [--kind painted|flat|both] [--only union,prism] [--variants 2] [--force] [--dry] [--rekey]
//          [--model M] [--size 1K|2K|4K]
//   --kind      which kind to paint (default painted)
//   --only      faction keys to paint (default: all)
//   --variants  candidates per faction and kind (default 2), each from its own seed
//   --force     repaint candidates that exist (the old ones move to art/factions/old/, never deleted)
//   --dry       print the prompts; no calls, no key needed
//   --rekey     key the flat logos out of their raw PNGs again (after changing the keying); no calls
// The key: OPENROUTER_API_KEY, else openrouter.token here (gitignored), else ~/openrouter.token.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const root = path.join(__dirname, '..'), dir = path.join(root, 'art', 'factions');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i < 0 ? def : argv[i + 1]; };
const flag = name => argv.includes('--' + name);
const DRY = flag('dry'), FORCE = flag('force'), REKEY = flag('rekey'), ONLY = opt('only') ? opt('only').split(',') : null;
const MODEL = opt('model', 'google/gemini-3-pro-image'), SIZE = opt('size', '1K'), VARIANTS = +opt('variants', 2);
const KINDS = { painted: ['painted'], flat: ['flat'], both: ['painted', 'flat'] }[opt('kind', 'painted')];
if (!KINDS) { console.error('gen-logos: --kind is painted, flat or both'); process.exit(1); }

const STYLE = {
  painted: 'A faction emblem for a space trading game, in the spirit of Escape Velocity: a single bold insignia, centred, '
    + 'filling most of a square frame, on a plain flat near-black background. Clean enough to read at 32 pixels and rich '
    + 'enough to hold a full screen: a painted-enamel or printed-badge finish, crisp edges, no drop shadow, no scene behind it. '
    + 'No text, letters, numbers or words anywhere.',
  flat: 'A faction logo for a space trading game, as a flat vector mark: a single bold insignia, centred, filling about '
    + 'three quarters of a square frame with clear space all round it. Only the two or three flat colours named below: no '
    + 'gradients, no shading, no texture, no wear, no glow, no outline glow, no drop shadow, no 3D. Clean geometric shapes and '
    + 'thick, even lines that still read at 16 pixels, like a printed decal or a flag. The background is solid pure magenta '
    + '(#FF00FF), perfectly flat, filling the whole frame edge to edge; magenta and pink appear nowhere in the logo itself. '
    + 'No text, letters, numbers or words anywhere.'
};
// Each faction: what it stands for in the setting, the mark (its shapes, shared by both kinds), the painted finish,
// and the flat version's colours
const LOGOS = {
  federation: {
    about: 'The Federation: the old compact that governs the jump lanes, an alliance of the inner ring\'s worlds, and its navy, which kept the lanes open through two centuries of the Rush and now holds the line against the Shadow.',
    mark: 'An alliance badge in the manner of NATO\'s: a four-pointed compass star, long thin points to north, south, east and west, centred in a circle, with four straight lane-lines running out from the circle to the edges of the badge, '
      + 'and a ring of small five-pointed stars round the circle, one for each founding world.',
    finish: 'Dark navy blue and white enamel with fine silver edging; official, orderly, symmetrical, a little cold. No bird and no crest.',
    flat: 'Dark navy blue and white only.'
  },
  union: {
    about: 'The Union: the miners\' councils of the middle ring, the Red Ring, which rose in 2394, seized the mines, refineries and yards from the charter companies, and broke away from the Federation. A workers\' state 130 years on: proud, plain, short of everything but metal.',
    mark: 'A constructivist emblem: a red ring, and inside it a miner\'s pick crossed with a hauler\'s heavy wrench, a five-pointed star above, bold geometric shapes like a 1920s revolutionary poster. Not a copy of any real-world flag or symbol.',
    finish: 'Red, black and sodium-lamp orange, stencilled as if sprayed on a welded hull plate, slightly worn, rivets at the edge.',
    flat: 'Red, black and sodium-lamp orange only.'
  },
  prism: {
    about: 'Prism: the AI-run corporation that builds every navigation core, runs the inner ring\'s finance and medicine, and owns the debt of half the outer ring. The richest thing humanity has made, and very polite.',
    mark: 'A corporate logo like a 1980s bank or airline mark: a rounded triangle seen face on, its three facets meeting at one point in the middle, set in a thin ring. '
      + 'No light beam, no rainbow (too close to a famous album cover), and no three-pointed star (too close to a car maker\'s badge). Calm, a little too perfect, faintly unsettling, as if the middle point were watching.',
    finish: 'Tinted glass, the three facets graded in soft pastel gradients (peach, lilac, pale aqua) that meet at one bright point, a chrome ring, airbrushed and glossy.',
    flat: 'Pale lilac, pale aqua and white only: each facet one flat colour, the ring white.'
  },
  freeflag: {
    about: 'Freeflag: the outer-ring rebellion that began in 2499 when Prism repossessed the habitat at Tarrow and the navy vented it, killing two hundred people. Converted freighters under painted flags.',
    mark: 'A rebel flag: a ragged banner with a broken habitat ring on it, open to the stars, and a raised fist holding a torch.',
    finish: 'Painted fast with a brush and spray stencil; warm yellow and black with a little red, uneven, improvised and defiant.',
    flat: 'Warm yellow, black and red only.'
  },
  blackhulls: {
    about: 'The Blackhulls: pirates descended from the strikers who never accepted the Treaty, preying on inner-ring shipping from captured and kitbashed hulls run dark.',
    mark: 'A pirate mark: a skull made of riveted hull plates with weld seams, crossed with two cutting torches, inside a ring scratched with a kill tally.',
    finish: 'Matte black and rust on scratched, over-painted metal, mismatched paint; menacing, scavenged.',
    flat: 'Black, bone white and rust orange only.'
  },
  bloom: {
    about: 'The Bloom: an alien hive of grown, living things across a sector of its own, bound to humanity by the Accord: no weapons hot near a living world, no taking anything that grows.',
    mark: 'Its sigil as humans see it: an organic glyph grown rather than drawn, a spiral of seed pods and veined leaves unfolding from a centre.',
    finish: 'Chitinous and bioluminescent: glowing greens and soft teal light; alive, patient, not quite comprehensible.',
    flat: 'Bright green, deep teal and pale green only.'
  },
  glass: {
    about: 'The Glass: whatever took four human systems in 2524. Every screen and speaker showed the same perfect pattern, and the worlds are being built over in clean geometric shapes at no human scale.',
    mark: 'The pattern itself: a perfect, self-similar geometric figure of nested triangles and facets in a hexagon, flawlessly symmetrical. Beautiful, exact and inhuman; it should feel like it is looking back.',
    finish: 'Pale cyan and white light refracting as if through glass.',
    flat: 'Pale cyan, white and deep blue only.'
  },
  shadow: {
    about: 'The Shadow: the alien exterminators that came through the lanes in 2521 and killed every living thing at Corran, the dark that eats the Bloom warned of. They do not negotiate and build nothing that is not for war.',
    mark: 'The Federation navy\'s threat marker for them: a stark warning insignia, a jagged black tear ripping through a red ring, like a hazard symbol for something that eats light.',
    finish: 'Black and blood red enamel with hard edges; massive, brutal, uniform and frightening.',
    flat: 'Black and blood red only.'
  }
};
const promptOf = (kind, L) => kind === 'painted' ? `${STYLE.painted}\n\n${L.about} ${L.mark}\n\n${L.finish}` : `${STYLE.flat}\n\n${L.about} ${L.mark}\n\nColours: ${L.flat}`;

function key() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  for (const f of [path.join(root, 'openrouter.token'), path.join(os.homedir(), 'openrouter.token')]) if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  console.error('gen-logos: no OpenRouter key (OPENROUTER_API_KEY, ./openrouter.token or ~/openrouter.token)'); process.exit(1);
}
async function paint(prompt, seed) {
  let last;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json', 'X-Title': 'Driftward content generator' },
        body: JSON.stringify({ model: MODEL, modalities: ['image', 'text'], image_config: Object.assign({ aspect_ratio: '1:1' }, SIZE ? { image_size: SIZE } : {}), seed, usage: { include: true }, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(300000)
      });
      const d = await r.json(), img = d.choices && ((d.choices[0].message.images || [])[0]);
      if (img) return { png: Buffer.from(img.image_url.url.split(',', 2)[1], 'base64'), cost: (d.usage && d.usage.cost) || 0, provider: d.provider || null, servedModel: d.model || MODEL };
      last = d.error ? JSON.stringify(d.error).slice(0, 300) : 'no image in the answer';
    } catch (e) { last = String(e); }
    await new Promise(res => setTimeout(res, 4000 * (a + 1)));
  }
  throw new Error(`paint: ${last}`);
}
function python(py, ...args) {
  const r = spawnSync('python3', ['-c', py, ...args], { encoding: 'utf8' });
  if (r.status) throw new Error(`image conversion failed (needs python3 with Pillow and numpy): ${r.stderr}`);
}
const toWebp = (rawFile, outFile) => python('import sys\nfrom PIL import Image, ImageOps\nsrc, dst = sys.argv[1:3]\n'
  + 'ImageOps.fit(Image.open(src).convert("RGB"), (512, 512), Image.LANCZOS).save(dst, "WEBP", quality=88, method=6)', rawFile, outFile);
// The flat kind's magenta keyed out (the model's own background colour, from the corners: it drifts a little off
// #FF00FF). Pixels near it are clear. A pixel within a few of the clear ones is an edge, a blend of the background and
// the logo colour beside it: its alpha is how far along the line from the background to the most logo-like pixel in
// its 7x7 neighbourhood it sits, and its colour is unmixed from the background, so no pink fringe is left (a plain
// distance test leaves one round dark colours, whose blends with magenta are still far from magenta). The rest is solid.
const toTransparent = (rawFile, outFile) => python([
  'import sys, numpy as np', 'from PIL import Image, ImageOps', 'from numpy.lib.stride_tricks import sliding_window_view as win',
  'src, dst = sys.argv[1:3]', 'R = 3',
  'im = np.asarray(ImageOps.fit(Image.open(src).convert("RGB"), (1024, 1024), Image.LANCZOS)).astype(float)',
  'bg = np.median(np.concatenate([im[:24, :24], im[:24, -24:], im[-24:, :24], im[-24:, -24:]]).reshape(-1, 3), axis=0)',
  'd = np.sqrt(((im - bg) ** 2).sum(-1)); clear = d < 40',
  'near = win(np.pad(clear, R), (2 * R + 1, 2 * R + 1)).any(axis=(-1, -2)); edge = near & ~clear',
  'h, w = d.shape; k = win(np.pad(d, R), (2 * R + 1, 2 * R + 1)).reshape(h, w, -1).argmax(-1)',
  'yy, xx = np.mgrid[:h, :w]; fg = np.pad(im, ((R, R), (R, R), (0, 0)), mode="edge")[yy + k // (2 * R + 1), xx + k % (2 * R + 1)]',
  'axis = fg - bg; t = ((im - bg) * axis).sum(-1) / np.maximum((axis ** 2).sum(-1), 1)',
  'a = np.where(clear, 0, np.where(edge, np.clip(t, 0, 1), 1))',
  'rgb = np.where(a[..., None] > 0, bg + (im - bg) / np.maximum(a[..., None], 1e-3), 0)',
  'out = np.dstack([np.clip(rgb, 0, 255), a * 255]).astype(np.uint8)',
  'Image.fromarray(out, "RGBA").resize((512, 512), Image.LANCZOS).save(dst, "PNG", optimize=True)'
].join('\n'), rawFile, outFile);
// never lose art: a candidate about to be repainted moves to old/ with its log entry (as gen-content.js's setAside)
function setAside(file, log) {
  const cur = path.join(dir, file), ext = path.extname(file), name = path.basename(file, ext);
  if (!fs.existsSync(cur)) return;
  const date = (log[file] || {}).date || new Date(fs.statSync(cur).mtimeMs).toISOString().slice(0, 10);
  fs.mkdirSync(path.join(dir, 'old'), { recursive: true }); fs.mkdirSync(path.join(dir, 'raw', 'old'), { recursive: true });
  let base = `${name}.${date}`;
  for (let n = 2; fs.existsSync(path.join(dir, 'old', base + ext)); n++) base = `${name}.${date}-${n}`;
  fs.renameSync(cur, path.join(dir, 'old', base + ext));
  const raw = path.join(dir, 'raw', name + '.png');
  if (fs.existsSync(raw)) fs.renameSync(raw, path.join(dir, 'raw', 'old', base + '.png'));
  if (log[file]) { log['old/' + base + ext] = log[file]; delete log[file]; }
}

(async () => {
  const factions = ONLY || Object.keys(LOGOS), bad = factions.filter(f => !LOGOS[f]);
  if (bad.length) { console.error(`gen-logos: no brief for ${bad.join(', ')} (have ${Object.keys(LOGOS).join(', ')})`); process.exit(1); }
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  if (REKEY) {
    const raws = fs.readdirSync(path.join(dir, 'raw')).filter(f => /-flat-\d+\.png$/.test(f) && factions.some(x => f.startsWith(x + '-')));
    raws.forEach(f => toTransparent(path.join(dir, 'raw', f), path.join(dir, f)));
    return console.log(`logos: keyed ${raws.length} flat logo(s) again from raw/`);
  }
  const logFile = path.join(dir, 'log.json'), log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : {};
  const jobs = KINDS.flatMap(kind => factions.flatMap(f => Array.from({ length: VARIANTS }, (_, i) => {
    const name = kind === 'flat' ? `${f}-flat-${i + 1}` : `${f}-${i + 1}`;
    return { f, kind, name, file: name + (kind === 'flat' ? '.png' : '.webp'), seed: 1000 + i };
  }))).filter(j => FORCE || !fs.existsSync(path.join(dir, j.file)));
  let total = 0;
  const done = await Promise.allSettled(jobs.map(async j => {
    const prompt = promptOf(j.kind, LOGOS[j.f]);
    if (DRY) { console.log(`--- ${j.file}: ${MODEL} at ${SIZE}, seed ${j.seed} ---\n${prompt}\n`); return; }
    const t = Date.now(), { png, cost, provider, servedModel } = await paint(prompt, j.seed);
    setAside(j.file, log);
    const raw = path.join(dir, 'raw', j.name + '.png');
    fs.writeFileSync(raw, png);
    (j.kind === 'flat' ? toTransparent : toWebp)(raw, path.join(dir, j.file));
    log[j.file] = { prompt, model: MODEL, provider, servedModel, size: SIZE, seed: j.seed, cost, seconds: Math.round((Date.now() - t) / 1000), date: new Date().toISOString().slice(0, 10) };
    total += cost; console.log(`  ${j.file} ($${cost.toFixed(3)}, ${Math.round((Date.now() - t) / 1000)} s)`);
  }));
  done.forEach((d, i) => d.status === 'rejected' && console.error(`  ${jobs[i].name}: ${d.reason.message}`));
  if (!DRY) {
    fs.writeFileSync(logFile, JSON.stringify(Object.fromEntries(Object.keys(log).sort().map(k => [k, log[k]])), null, 1) + '\n');
    console.log(`logos: ${jobs.length} image(s), $${total.toFixed(2)} (${MODEL} at ${SIZE})`);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
