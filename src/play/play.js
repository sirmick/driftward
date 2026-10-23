// ======================= PLAY =======================
// The game page, on the way to M1. Rule: anything that changes game state runs in the sim core, so a session
// saves, loads and replays exactly (natively too). This page only turns keys into one input bitmask per tick,
// and draws what the core's columns say. Flight is the core's player model, with the Book's three assist levels as
// three modes: ASSIST (full assist) holds a throttle's share of the top speed along the nose (and cancels drift and
// gravity); DRIFT (drift off) is raw Newtonian thrust with strafe; FREE (full off) adds torque rotation, where a spin
// keeps going until countered.
const $ = id => document.getElementById(id);
const catalog = ShipGen.resolveCatalog(JSON.parse($('catalog').textContent)); // factions' lines as brands (src/gen.js)
const canvas = $('view'), hud = $('hud'), hx = hud.getContext('2d');
const G = makeGfx(canvas);
if (!G) { $('glerr').hidden = false; return; }
const { gl, compile, P, quad, draw, tex } = G;

// ---------- the systems: the universe index at start, each system the first time it is needed ----------
// Through src/data.js (inline in a self-contained page, fetched in a hosted one): the universe index (every system,
// region, faction and lane: src/galaxy/universe.json) before the game starts, and a system's file, lore and art when
// the game first needs it. A system file is validated (clamped) against its schema and laid out (src/schema.js) when it
// is read. The core's atlas (core/src/atlas.rs) holds the layouts of the systems this game has been to, a slot each by
// star id; the page draws one at a time, the one the core says the player is in (game.system, a slot), through
// setSystem below.
const SYSTEM_SCHEMA = JSON.parse($('system-schema').textContent), LORE_SCHEMA = JSON.parse($('lore-schema').textContent);
// environmental stations are sized from their archetype's diameter range (the middle of it, as a radius)
const LAYOUT = { stationRadius: id => { const a = catalog.stations.find(x => x.id === id); return a && a.diameter ? (a.diameter[0] + a.diameter[1]) / 4 : 400; } };
// the economy (src/economy.json): commodities, and each port role's price tier for each (validated by npm run check)
const ECON = JSON.parse($('economy').textContent), GOODS = ECON.commodities;
// ambient traffic (src/traffic.json): hulls by culture and role, population weights
const TRAFFIC_DATA = JSON.parse($('traffic').textContent);
const DATA = makeData();
// the universe index, filled in when it is read (before the game starts); its entries by system file id and by star id;
// the systems with a file, the start system first (where a new game begins: economy.json's start.system)
const UNIVERSE = { systems: [], lanes: [], factions: {}, regions: {} }, ENTRY = new Map(), BY_STAR = new Map();
let FLYABLE = [];
const START_ID = ECON.start.system;
// each system read so far, by id: { id, raw, loaded, lore, art, entry }. Its lore (src/lore/<id>.json, from
// tools/gen-content.js) is validated against its schema and the system; a port without it shows the system file's
// description and an empty bar. The art manifest lists the painted vistas and portraits found in art/<id>/ at build
// time. How its content was made (logs/<id>.json) is read only by the debug screen.
const SYSTEMS = new Map();
function addSystem(id, bundle) {
  const raw = bundle.system, loaded = loadSystem(raw, SYSTEM_SCHEMA, LAYOUT);
  loaded.notes.forEach(n => console.warn(`system ${id} ${n.path}: ${n.msg}`));
  if (!loaded.system) { console.error(`system ${id} is unusable: ` + loaded.notes.filter(n => n.fatal).map(n => `${n.path} ${n.msg}`).join('; ')); return null; }
  const lore = bundle.lore ? loadLore(bundle.lore, LORE_SCHEMA, loaded.system) : { lore: null, ports: new Map(), notes: [] };
  lore.notes.forEach(n => console.warn(`lore ${id} ${n.path}: ${n.msg}`));
  const rec = { id, raw, loaded, lore, art: bundle.art || { vistas: {}, portraits: {} }, entry: ENTRY.get(id) };
  SYSTEMS.set(id, rec);
  return rec;
}
// A system's lanes as its gates (core/src/jump.rs): each takes the zone of the 16 round the system (zone k on the
// bearing k x 22.5 degrees counter-clockwise from +x, the galactic plane's x and y) nearest its bearing toward its
// destination, the next free one where two want the same (in the index's lane order, so every page agrees). Each:
// { dest (star id), zone, ly, days, name, file (the destination's system file, if it can be flown), owner }.
function gatesOf(S) {
  if (S.gates) return S.gates;
  const me = S.entry, taken = new Set(), out = [];
  for (const l of UNIVERSE.lanes) {
    if (l.a !== me.id && l.b !== me.id) continue;
    const o = BY_STAR.get(l.a === me.id ? l.b : l.a), a = Math.atan2(o.pos[1] - me.pos[1], o.pos[0] - me.pos[0]);
    const off = z => { const d = Math.abs(((a - z * Math.PI / 8) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI); return d; };
    const free = [...Array(16).keys()].filter(z => !taken.has(z)).sort((p, q) => off(p) - off(q));
    if (!free.length) break;
    taken.add(free[0]);
    out.push({ dest: o.id, zone: free[0], ly: l.ly, days: l.days, name: o.name, file: o.file || null, owner: o.owner });
  }
  return (S.gates = out);
}
// read the systems not read yet; resolves once each has its record (an unusable one has none)
const needSystems = ids => Promise.all(ids.filter(id => !SYSTEMS.has(id)).map(id => DATA.system(id).then(b => { if (!SYSTEMS.has(id)) addSystem(id, b); })));
// the system the page draws now, set by setSystem (below, once the bake helpers exist)
let sysRec = null, SYS, BODIES, STAR, SUNS, LORE, ART, star, WORLDS, STATIONS;
// the debug screen (backquote): how the current system's content was made (src/play/debug.js), and the jump box
const debug = makeDebug({ el: $('debug'), econ: ECON, data: DATA, universe: UNIVERSE, system: () => sysRec });
// the galaxy map (M in flight, G in port; src/play/galaxy.js), and the course set on it ({ dest: a star id, by: 'days'
// or 'jumps' }), which the HUD shows with the next jump. Page state, not the core's: it changes nothing in the game.
let course = null;
const galaxy = makeGalaxyMap({ el: $('galaxy'), universe: UNIVERSE, econ: ECON, here: () => sysRec.entry.id, course: () => course, onCourse: c => { course = c; }, missions: () => galaxyMissions(),
  onClose: () => canvas.focus(),
  // the star map, once the real stars are read (asked for here the first time)
  makeMap: labels => DATA.has('stars.json') ? makeStarMap(G, canvas, labels, { catalogue: DATA.peek('stars.json'), universe: UNIVERSE }) : (DATA.catalogue(), null) });
let galaxyMissions = () => []; // the active missions as the galaxy map shows them (bound once the core has loaded)
const openGalaxy = () => { if (debug.isOpen() || jumping()) return; galaxy.open(); keys.clear(); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const BODY_KIND = { star: 0, planet: 1, moon: 2, station: 3, belt: 4, field: 5 };
// planets and moons, drawn by the planet shader (worldsOf, per system)
// city lights follow a port's population (look.cityLights is a floor on top, for a world brighter than its tier)
const CITY_LIGHTS = { outwatch: 0.03, outpost: 0.1, colony: 0.3, complex: 0.6, world: 1 };
const worldsOf = bodies => bodies.filter(b => b.kind === 'planet' || b.kind === 'moon').map(b => {
  const pu = planetUniforms(b.look); // every field filled by the schema clamp, defaults and all
  if (b.port) pu.city = Math.max(pu.city || 0, CITY_LIGHTS[b.port.population] || 0);
  return Object.assign({}, b, { pu, LA: pu.atm, ext: pu.ext });
});
// Light comes from the stars: the direction toward them from (x, y), tipped toward the camera so day sides read. A
// binary's two stars each count by 1 / distance² (its nearer star lights a world most), the directions and their
// colours (col, linear, if given) mixed by those weights; two stars on opposite sides light a world from the front.
function sunFrom(x, y, out = new Float32Array(3), col) {
  let vx = 0, vy = 0, sum = 0;
  if (col) col.fill(0);
  for (const S of SUNS) {
    const dx = S.x - x, dy = S.y - y, l = Math.hypot(dx, dy), w = 1 / Math.max(l, S.r) ** 2;
    if (l > 1) { vx += dx / l * w; vy += dy / l * w; }
    sum += w;
    if (col) for (let k = 0; k < 3; k++) col[k] += S.lightLin[k] * w;
  }
  vx /= sum; vy /= sum;
  if (col) for (let k = 0; k < 3; k++) col[k] /= sum;
  const h = Math.hypot(vx, vy), vz = 0.45 * h + (1 - h), n = Math.hypot(vx, vy, vz);
  out[0] = vx / n; out[1] = vy / n; out[2] = vz / n; return out;
}
// the star lighting (x, y) most: what the orbiters and rocks take as their sun
const sunAtPoint = (x, y) => SUNS.reduce((a, S) => Math.hypot(S.x - x, S.y - y) / S.r < Math.hypot(a.x - x, a.y - y) / a.r ? S : a, SUNS[0]);

// ---------- ship types: one per brand x size; flight stats from the catalog, looks from the bake ----------
const baker = makeBaker({
  gl, tex, genText: $('gen').textContent, catalog: () => catalog, defaultSeed: () => 'play-1',
  onError: (key, msg) => console.error('bake failed', key, msg)
});
// the shipyard: every line's hulls for the debug screen's Ships tab, and the seed each hull class is built from
// (picked there; the game's ships use the same seeds)
const yard = makeShipyard({ gl, P: G.P, draw: G.draw, baker, catalog, target: () => G.targets.scene });
debug.setYard(yard);
// the stars (src/stars.js): the game draws its systems' with the kit, the debug screen's Suns tab every class
const starKit = makeStarKit(gl, compile, draw);
const sunGallery = makeSunGallery({ gl, P: G.P, draw: G.draw, kit: starKit, target: () => G.targets.scene });
debug.setSuns(sunGallery);
// the galaxy (the real stars round Sol and the universe's systems, lanes and factions) for the debug screen's Map tab,
// built when the tab first opens
debug.setStarMap((labels, data) => makeStarMap(G, canvas, labels, data));
const nSizes = catalog.sizes.length;
// a line's frame multipliers (catalog.json lines' `frame`), from the raw catalog (the resolved brands don't carry them)
const RAW_LINES = new Map(JSON.parse($('catalog').textContent).factions.flatMap(f => f.lines.map(l => [f.id + '.' + l.id, l])));
const lineFrame = b => (RAW_LINES.get(b.id) || {}).frame || {};
const types = [];
catalog.brands.forEach((b, bi) => catalog.sizes.forEach((z, zi) => {
  const fz = z.flight || {}, fb = b.style.flight || {};
  types.push({
    bi, zi, brand: b, L: z.length, name: b.series[zi], key: baker.keyOf(b.id, z.id), br: brandRender(b),
    accel: (fz.accel || 60) * (fb.accel || 1), turn: (fz.turn || 1) * (fb.turn || 1), vmax: (fz.vmax || 200) * (fb.vmax || 1),
    well: fz.well == null ? 0.5 : fz.well, // how much gravity wells pull this hull and bend its top speed
    cargo: Math.round((fz.cargo || 0) * (fb.cargo == null ? 1 : fb.cargo)), // hold, tons: the class's, times the line's
    hull: (fz.hull || 100) * (fb.hull || 1), fuel: (fz.fuel || 4) * (fb.fuel || 1), // hull points when sound; the tank, tons
    // the frame (core/src/fit.rs; docs/outfitting.md): the class's, its bay times the line's (a container line's is
    // bigger), and its structure, the hull points before armour: those of the line it builds on (a Clad's are its
    // Haul's, the rest welded on); the stock shield
    frame: Object.assign({}, z.frame, { bayP: z.frame.bayP * (lineFrame(b).bayP || 1), bayU: z.frame.bayU * (lineFrame(b).bayU || 1) }), shield: (fz.shield || 0) * (fb.shield || 1),
    structure: (fz.hull || 100) * ((catalog.brands.find(x => x.id === b.hullKey) || b).style.flight.hull || 1),
    s: null, half: z.length / 2
  });
}));
// A type is baked the first time a ship of it needs drawing (each finished bake uploads four textures on the
// main thread, so baking the whole catalog up front stalls frames for seconds). It is drawable only once its
// textures exist; until then it is simply not drawn.
function typeReady(T) {
  if (T.s) return true;
  const s = baker.ships.get(T.key);
  if (!s) { baker.enqueue(T.key, true, { brand: T.brand.id, size: catalog.sizes[T.zi].id, seed: yard.seedOf(T.brand.id, catalog.sizes[T.zi].id) }); baker.pump(); return false; }
  if (!s.ready || !s.tex) return false;
  const m = s.maps;
  T.s = s; T.half = m.extent / 2; T.extent = m.extent; T.S = m.shieldS; T.Dmax = m.Dmax;
  T.eng = m.engines.map(e => ({ lx: (e.u - 0.5) * m.extent, ly: (0.5 - e.v) * m.extent, w: e.w * m.extent, dx: e.dx, dy: e.dy }));
  let ax = 0, ay = 0; T.eng.forEach(e => { ax += e.lx; ay += e.ly; });
  T.engX = T.eng.length ? ax / T.eng.length : 0; T.engY = T.eng.length ? ay / T.eng.length : -T.half * 0.6;
  T.rcs = hullAnchors(s, m);
  return true;
}
// Thruster anchors on the actual hull, from the bake's CPU copy of the aux map (red: distance outside the hull,
// zero inside). Side jets sit on the flanks a quarter of the way back from the nose and a fifth from the tail;
// reverse jets on the nose. Local metres: +x right, +y forward.
function hullAnchors(s, m) {
  const res = m.res, ext = m.extent, aux = s.aux, inside = (ix, iy) => aux[(iy * res + ix) * 4] < 2;
  const lx = ix => ((ix + 0.5) / res - 0.5) * ext, ly = iy => (0.5 - (iy + 0.5) / res) * ext;
  let top = -1, bot = -1;
  for (let iy = 0; iy < res; iy++) for (let ix = 0; ix < res; ix++) if (inside(ix, iy)) { if (top < 0) top = iy; bot = iy; break; }
  if (top < 0) return null;
  const edges = iy => { let a = -1, b = -1; for (let ix = 0; ix < res; ix++) if (inside(ix, iy)) { if (a < 0) a = ix; b = ix; } return [lx(a), lx(b)]; };
  const fy = Math.round(top + 0.25 * (bot - top)), ry = Math.round(top + 0.8 * (bot - top)), ny = Math.round(top + 0.03 * (bot - top));
  const [fl, fr] = edges(fy), [rl, rr] = edges(ry), [nl, nr] = edges(ny);
  return { fl: [fl, ly(fy)], fr: [fr, ly(fy)], rl: [rl, ly(ry)], rr: [rr, ly(ry)], nl: [nl * 0.6, ly(ny)], nr: [nr * 0.6, ly(ny)] };
}
// stations, baked from their catalog archetype in an owning brand's style; drawn like ships, slowly spinning (stationsOf,
// per system)
const stationsOf = bodies => bodies.filter(b => b.kind === 'station').map(b => {
  // the schema's archetype and brand enums name catalog entries (checked by npm run check); loadSystem fills the rest
  const st = b.station, arch = catalog.stations.find(a => a.id === st.archetype), brand = ShipGen.brandOf(catalog, st.brand);
  // keyed by what is baked, so environmental stations of one archetype, owner and seed share a bake; they draw at
  // their own scale
  return Object.assign({}, b, { key: `stn|${arch.id}|${brand.id}|${st.seed}`, req: { station: arch.id, brand: brand.id, seed: st.seed }, brand, spin: arch.spin || 0.01, scale: b.env ? b.env.scale : 1, s: null });
});
// The page's view of a system (its record): its bodies, the worlds and stations to draw (made once per system; their
// positions are the core's, copied in when the system is laid out), its star, lore and art. Its stations start baking,
// unless it is only being laid out (bake false).
function setSystem(S, bake = true) {
  sysRec = S; SYS = S.loaded.system; BODIES = S.loaded.bodies; STAR = BODIES[0]; LORE = S.lore; ART = S.art;
  // the stars (a binary has two), each with its light (src/stars.js); the first's lights the sky
  SUNS = BODIES.filter(b => b.kind === 'star');
  SUNS.forEach(S => { S.light = starLight(S.starClass); S.lightLin = lin(S.light.col); });
  star = STAR.light;
  WORLDS = S.worlds || (S.worlds = worldsOf(BODIES));
  STATIONS = S.stations || (S.stations = stationsOf(BODIES));
  if (!bake) return;
  [...new Map(STATIONS.map(T => [T.key, T.req]))].forEach(([key, req]) => { if (!baker.ships.get(key)) baker.enqueue(key, false, req); });
  baker.pump();
}
function stationReady(S) {
  if (S.s) return true;
  const s = baker.ships.get(S.key);
  if (!s || !s.ready || !s.tex) return false;
  S.s = s; S.half = s.maps.extent / 2; return true;
}
function playerTypeIndex(ship) {
  const q = ship || new URLSearchParams(location.search).get('ship') || 'union.civilian:c2'; // a used Copperhaul
  const [b, z] = q.split(':');
  const bi = Math.max(0, catalog.brands.findIndex(x => x.id === b)), zi = Math.max(0, catalog.sizes.findIndex(x => x.id === z));
  return bi * nSizes + zi;
}

// ---------- GL: instanced ships and plumes (same shaders as the lab's Fly tab), planets ----------
const FP = {
  ship: compile(FLY_SHIP_VS, derive(SHIP_FS, DERIVE.ship), { iA: 1, iB: 2 }),
  plume: compile(FLY_PLUME_VS, derive(PLUME_FS, DERIVE.plume), { iN: 1, iP: 2, iB: 3 }),
  planet: compile(PLANET_VS, PLANET_FS),
  sheath: compile(SHEATH_VS, SHEATH_FS),
  orbiter: compile(ORBITER_VS, ORBITER_FS, { iA: 1, iB: 2 }),
  // combat's looks (core/src/combat.rs), the lab's shaders: shield hits, shells as tracers, sparks and fire
  shield: compile(FLY_SHIELD_VS, derive(SHIELD_FS, DERIVE.shield), { iA: 1, iH1: 2, iH2: 3 }),
  bolt: compile(FLY_BOLT_VS, FLY_BOLT_FS, { iA: 1, iC: 2 }),
  part: compile(FLY_PART_VS, FLY_PART_FS, { iA: 1, iC: 2 })
};
// an instanced quad's VAO and its instance buffer, allocated once for `cap` instances; `upload` refills it in place
function instVAO(sizes, cap) {
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const per = sizes.reduce((a, b) => a + b, 0), stride = per * 4;
  gl.bufferData(gl.ARRAY_BUFFER, cap * stride, gl.DYNAMIC_DRAW);
  let off = 0;
  sizes.forEach((sz, k) => { gl.enableVertexAttribArray(k + 1); gl.vertexAttribPointer(k + 1, sz, gl.FLOAT, false, stride, off); gl.vertexAttribDivisor(k + 1, 1); off += sz * 4; });
  gl.bindVertexArray(null);
  return { vao, buf, sizes, per, stride, cap };
}
function upload(V, data, count) {
  if (count > V.cap) throw new Error(`instance upload of ${count} past capacity ${V.cap}`);
  gl.bindBuffer(gl.ARRAY_BUFFER, V.buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * V.per);
}
function pointAt(V, first) {
  gl.bindBuffer(gl.ARRAY_BUFFER, V.buf);
  let off = first * V.stride;
  V.sizes.forEach((sz, k) => { gl.vertexAttribPointer(k + 1, sz, gl.FLOAT, false, V.stride, off); off += sz * 4; });
}

// ---------- layout ----------
let W = 0, H = 0, dpr = 1, stripH = 0;
// the scene is not redrawn while something covers it (see frame); a resize, a setting or a key that changes how it
// draws marks it stale, so it is drawn once more underneath
let sceneStale = true;
function resize() {
  sceneStale = true;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  stripH = document.querySelector('.strip').getBoundingClientRect().height;
  canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr));
  hud.width = canvas.width; hud.height = canvas.height;
  G.buildTargets(renderScale);
  frameVista();
}
// The scene's resolution, as a fraction of the canvas's (G.buildTargets): fixed by the quality setting, or on Auto
// (quality 0) stepped by the frame loop's governor (renderGovernor) when the GPU can't keep up
let renderScale = 1;
const RS_STEPS = [1, 0.85, 0.75, 0.62, 0.5];
function setRenderScale(rs) {
  const want = SETTINGS.quality > 0 ? SETTINGS.quality : (rs || renderScale);
  if (want === renderScale && G.targets.scene) return;
  renderScale = want; G.buildTargets(renderScale); sceneStale = true;
}
// The port's painted vista fills the screen while that stretches it no more than VISTA_STRETCH times its own pixels
// (real device pixels: a high-DPI screen counts double). Past that it would go soft, so it becomes a framed picture
// in the middle of the screen at about its own size (but at least VISTA_MIN, so the port card and a panel fit in it
// side by side), the port's controls inside it, and the live world you landed on filling the view around it. If
// the screen has no room for that frame, the vista stays full screen.
const VISTA_STRETCH = 1.25, VISTA_MIN = [1120, 630];
function frameVista() {
  const img = $('vista'), nw = img.naturalWidth || 1600, nh = img.naturalHeight || 900, ddpr = window.devicePixelRatio || 1;
  const big = W * ddpr > nw * VISTA_STRETCH || H * ddpr > nh * VISTA_STRETCH;
  const room = [W - 96, H - stripH - 72], w = Math.min(Math.max(nw * VISTA_STRETCH / ddpr, VISTA_MIN[0]), room[0], room[1] * nw / nh), h = w * nh / nw;
  const framed = big && w >= VISTA_MIN[0] && h >= VISTA_MIN[1];
  document.body.classList.toggle('vista-framed', framed);
  if (framed) {
    const st = document.body.style;
    st.setProperty('--vista-w', `${Math.round(w)}px`); st.setProperty('--vista-h', `${Math.round(h)}px`);
    st.setProperty('--vista-x', `${Math.round((W - w) / 2)}px`); st.setProperty('--vista-y', `${Math.round((H - stripH - h) / 2)}px`);
  }
}
window.addEventListener('resize', resize);
resize();

// ---------- input: keys -> one bitmask per tick, and actions (src/play/keys.js: the bindings) ----------
const keys = new Set(), KB = makeKeys();
// flight mode: 0 ASSIST (the Book's full assist: a throttle), 1 DRIFT (drift off), 2 FREE (full off); F cycles
const ASSIST = [
  { hud: 'ASSIST', toast: () => `Assist: ${KB.name('thrust')}/${KB.name('reverse')} throttle, ${KB.name('retro')} all stop, ${KB.name('burn')} burn; drift and gravity cancelled` },
  { hud: 'DRIFT', toast: () => `Drift: raw thrust, ${KB.name('strafeL')}/${KB.name('strafeR')} strafe, ${KB.name('retro')} turns to face backward; momentum stays` },
  { hud: 'FREE', toast: () => 'Free: as drift, and spins persist until you counter-turn' }
];
let assistMode = 0, zoom = 1, bloomOn = true, nanView = 0, navOn = false;
const assist = () => assistMode === 0;
function setNav(on) { navOn = on; $('b-nav').setAttribute('aria-pressed', String(on)); }
// settings, kept in this browser; a new game starts from the assist level and overlay chosen here
const SETTINGS = Object.assign({ bloom: 1, nav: 0, assist: 0, debug: 0, quality: 0 }, (() => { try { return JSON.parse(localStorage.getItem('driftward.settings') || '{}'); } catch (e) { return {}; } })());
function applySettings() { bloomOn = !!SETTINGS.bloom; sceneStale = true; setRenderScale(); }
applySettings();
// the shell's screens over the game: the title, the pause menu, settings (on top of either)
const shellOpen = () => ['keys', 'settings', 'pause', 'title'].find(id => !$(id).hidden) || null;
$('b-nav').onclick = () => { setNav(!navOn); canvas.focus(); };
window.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) { if (e.code === 'Escape') e.target.blur(); return; }
  if (barrierUp()) { e.preventDefault(); return; } // the world is stopped while the system's ships and stations bake
  if (noticeUp()) { if (['Enter', 'Space', 'Escape', 'NumpadEnter'].includes(e.code) && !e.repeat) closeNotice(); e.preventDefault(); return; }
  if (lostUp()) { if (['Enter', 'NumpadEnter'].includes(e.code) && !e.repeat) $('lost-reload').click(); e.preventDefault(); return; }
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'F6', 'F9'].includes(e.code)) e.preventDefault();
  // the debug screen takes every key but its own: backquote opens and closes it, as does Esc
  if (e.code === 'Backquote' && !e.repeat) { if (debug.isOpen()) debug.close(); else { galaxy.close(); debug.open(); keys.clear(); } e.preventDefault(); return; }
  if (debug.isOpen()) { if (e.code === 'Escape') debug.close(); return; }
  // the galaxy map takes every key while it is open
  if (galaxy.isOpen()) { if (!e.repeat) galaxy.key(e); e.preventDefault(); return; }
  // with a shell screen up, the game takes no keys: Esc and P step back out
  if (shellOpen()) { if (!e.repeat && (e.code === 'Escape' || KB.pressed(e, c => c === 'any').includes('pause'))) shellBack(); return; }
  if (!keys.has(e.code)) { // (not the key's auto-repeat)
    if (e.code === 'Escape') onEscape();
    if (inFlight() && /^Digit[1-9]$/.test(e.code)) pickLocation(+e.code.slice(5));
    if (assist() && ['strafeL', 'strafeR'].some(id => KB.held(id, new Set([e.code])))) toast(`Strafe works in drift and free: ${KB.name('mode')}`);
    for (const id of KB.pressed(e, keyLive)) (ACTIONS[id] || (() => {}))();
  }
  keys.add(e.code);
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
canvas.addEventListener('wheel', e => { e.preventDefault(); setZoom(zoom * Math.exp(-e.deltaY * 0.0012)); }, { passive: false });
function setZoom(z) { zoom = Math.max(0.25, Math.min(4, z)); }
function inputBits(IN) {
  const k = id => KB.held(id, keys);
  return (k('thrust') ? IN.thrust : 0) | (k('reverse') ? IN.reverse : 0) | (k('left') ? IN.left : 0) | (k('right') ? IN.right : 0)
    | (k('strafeL') ? IN.strafeL : 0) | (k('strafeR') ? IN.strafeR : 0) | (k('burn') ? IN.burn : 0) | (k('fire') ? IN.fire : 0) | (k('retro') ? IN.retro : 0)
    | (assistMode === 0 ? IN.assist : 0) | (assistMode === 2 ? IN.torque : 0);
}

// messages: in flight the message log (bottom left) keeps the last few; elsewhere, and over the maps, a toast at the
// top (not both: a message said twice is noise)
let toastT = 0, logShows = () => false;
const msgLog = [];
function toast(msg) {
  msgLog.push({ text: msg, at: performance.now() }); if (msgLog.length > 6) msgLog.shift();
  if (logShows()) return;
  const el = $('toast'); el.textContent = msg; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2200);
}
const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// these need the core; bound once it loads
let saveGame = () => {}, loadGame = () => {}, landOrLaunch = () => {}, skipSequence = () => {}, waitDay = () => {}, inPort = () => false;
let inFlight = () => false, cycleTarget = () => {}, cycleScreen = () => {},cycleBody = () => {}, cycleUnknown = () => {}, nearestHostile = () => {}, nextZone = () => {}, flyTo = () => {}, toggleMap = () => {}, pickLocation = () => {}, escapeFlight = () => false, portService = () => {};
let pauseGame = () => {}, shellBack = () => {}, jitterToggle = () => false, barrierUp = () => false, noticeUp = () => false, closeNotice = () => {};
let lostUp = () => false, closeLost = () => {}, jumpKey = () => {}, jumping = () => false, coldKey = () => {}, pingKey = () => {};
// Esc steps back: a sequence skips; in port, an open panel closes; in flight, the map closes, then the target
// clears; otherwise the game pauses
// where each binding's context is live (src/play/keys.js), and what each action does
const keyLive = ctx => ctx === 'any' || (ctx === 'flight' ? inFlight() : ctx === 'space' ? !inPort() : ctx === 'port' ? inPort() : false);
const togglePanel = p => showPanel(panelOpen() === p ? null : p);
const ACTIONS = {
  mode: () => { assistMode = (assistMode + 1) % 3; toast(ASSIST[assistMode].toast()); },
  targetNext: () => cycleTarget(1), targetPrev: () => cycleTarget(-1), screenNext: () => cycleScreen(1), screenPrev: () => cycleScreen(-1),unknownNext: () => cycleUnknown(1), unknownPrev: () => cycleUnknown(-1), hostile: () => nearestHostile(),
  placeNext: () => cycleBody(1), placePrev: () => cycleBody(-1), zoneNext: () => nextZone(),
  autopilot: () => flyTo(), land: () => landOrLaunch(), jump: () => jumpKey(), skip: () => skipSequence(),
  cold: () => coldKey(), ping: () => pingKey(), galaxy: () => openGalaxy(), systemMap: () => toggleMap(), nav: () => setNav(!navOn),
  trade: () => togglePanel('trade'), missions: () => togglePanel('board'), bar: () => togglePanel('bar'), about: () => togglePanel('about'), outfit: () => togglePanel('outfit'),
  refuel: () => portService('refuel'), repair: () => portService('repair'), wait: () => waitDay(), portMap: () => openGalaxy(),
  pause: () => pauseGame(true), save: () => saveGame(), load: () => loadGame(), zoomIn: () => setZoom(zoom * 1.25), zoomOut: () => setZoom(zoom / 1.25),
  // debugging the flashing black squares: bloom off, and a view of bad scene pixels (see postProcess)
  bloom: () => { sceneStale = true; bloomOn = !bloomOn; toast(`Bloom ${bloomOn ? 'on' : 'off'}`); },
  nanView: () => { sceneStale = true; nanView = 1 - nanView; toast(nanView ? 'NaN view: magenta = bad scene pixel, cyan = bad bloom, yellow = negative' : 'NaN view off'); },
  jitter: () => toast(jitterToggle() ? 'Jitter probe: frame times, and motion jitter in pixels of a 1080p view (see src/play/jitter.js)' : 'Jitter probe off')
};
function onEscape() {
  if (skipSequence() === 0) return;
  if (inPort()) { if (panelOpen()) showPanel(null); else pauseGame(true); return; }
  if (inFlight() && escapeFlight()) return;
  pauseGame(true);
}
// the port screen's panels beside the port card, one at a time: the market, the mission board, the bar, about
const PANELS = ['trade', 'board', 'bar', 'about', 'outfit'];
const panelOpen = () => PANELS.find(p => !$(p).hidden) || null;
let showPanel = () => {};
const NUM = new Intl.NumberFormat('en-US'), fmtCr = n => NUM.format(n); // one formatter: toLocaleString builds one per call, and the HUD formats every frame

// the index, then the start system, then the game
const UNIVERSE_READY = DATA.universe().then(u => {
  Object.assign(UNIVERSE, u);
  for (const c of UNIVERSE.systems) { BY_STAR.set(c.id, c); if (c.file) ENTRY.set(c.file, c); }
  FLYABLE = UNIVERSE.systems.filter(c => c.file).map(c => c.file).sort((a, b) => (b === START_ID) - (a === START_ID) || (a < b ? -1 : a > b ? 1 : 0));
  return needSystems([START_ID]);
}).then(() => { if (!SYSTEMS.get(START_ID)) throw new Error(`the start system ${START_ID} is unusable`); });
Promise.all([CORE_READY, UNIVERSE_READY]).then(([CORE]) => {
  setSystem(SYSTEMS.get(START_ID), false); // the page's view holds a system from the start; a new game lays it out and draws it
  // body capacity: the schema's caps on bodies and belts, the star, and the most environmental stations a system holds
  const CFG = { maxShips: 512, maxTypes: 64, maxBodies: SYSTEM_SCHEMA.properties.bodies.maxItems + SYSTEM_SCHEMA.properties.belts.maxItems + 1 + MAX_ENVIRONS, envN: 16, envW: 40000, seed: 1 };
  const sim = CORE.world(CFG);
  // a second world, never stepped, that systems are laid out in (layoutSystem); making it grows WASM memory, so the
  // first's views are made again before anything holds on to them
  const lay = CORE.world(CFG);
  sim.rebind();
  const SH = sim.ship, IN = CORE.IN;
  types.forEach((T, k) => { sim.type.accel[k] = T.accel; sim.type.turn[k] = T.turn; sim.type.vmax[k] = T.vmax; sim.type.well[k] = T.well; sim.type.cargo[k] = T.cargo; sim.type.hull[k] = T.hull; sim.type.fuel[k] = T.fuel; sim.type.len[k] = T.L; });
  // The frames (core/src/fit.rs): each type's class frame, structure and stock shield, and its plumes, the nozzles its
  // generated hull has (assembled here, without the bake: the part list alone, from the seed it is baked from). And
  // its geometry (core/src/combat.rs; src/gen.js footprint): the outline shells hit, its shield's standoff and its turret
  // sites, by size.
  const PK = sim.playerKind, FIT = Object.fromEntries(sim.fitSlots.map((n, k) => [n, k]).filter(([n]) => n));
  types.forEach((T, k) => {
    const F = T.frame, t = sim.type, B = catalog.brands[T.bi], Z = catalog.sizes[T.zi];
    const ship = ShipGen.assemble(B, Z, yard.seedOf(B.id, Z.id), T.zi), parts = ship.parts;
    T.plumes = Math.max(1, Math.min(8, parts.filter(q => q.em && q.em.type === 'exhaust').length));
    t.frame[k] = F.mass; t.bay_p[k] = F.bayP; t.bay_u[k] = F.bayU; t.crew[k] = F.crew; t.sensors[k] = F.sensors;
    t.plumes[k] = T.plumes; t.structure[k] = T.structure; t.shield[k] = T.shield;
    const fp = ShipGen.footprint(ship, sim.maxOutline), MO = sim.maxOutline, MM = sim.maxMounts;
    T.mounts = fp.mounts.slice(0, MM);
    fp.outline.forEach(([x, y], v) => { sim.outline.x[k * MO + v] = x; sim.outline.y[k * MO + v] = y; });
    T.mounts.forEach(([x, y, z], m) => { sim.mount.x[k * MM + m] = x; sim.mount.y[k * MM + m] = y; sim.mount.size[k * MM + m] = z; });
    t.outline[k] = fp.outline.length; t.guns[k] = T.mounts.length; t.rad[k] = Math.max(...fp.outline.map(([x, y]) => Math.hypot(x, y)));
    t.standoff[k] = ShipGen.shieldStandoff(ship, B);
  });
  // the player's ship flies as the core's last type row, built from its fit; it looks like the type it is built on
  const fittedLooks = () => { if (sim.game.fitted[0]) types[PK] = types[sim.game.base[0]]; };
  types[PK] = types[0];
  // each commodity's hold (economy.json: bulk, general, climate)
  GOODS.slice(0, sim.maxGoods).forEach((c, g) => { sim.goods.class[g] = { bulk: 0, general: 1, climate: 2 }[c.hold] || 0; });
  const CMD = CORE.CMD, MODE = CORE.MODE, BURST = CORE.BURST;
  // Asteroid belts and fields: their rocks (src/rocks.js), placed once from each one's seed round where the core put
  // it. Scenery: not in the sim (ships fly through them), so the page owns them. Density 1 is a rock per 22,000 m²;
  // a belt's rocks thin toward its edges and gather in clumps along it, a field's toward its rim. Sizes follow a power
  // law (ROCK_SIZES, by the belt's sizes; mixed is 15 to 500 m, half under 23 m, one in a hundred over 200 m), so a belt
  // is open space with rocks in it rather than a wall (the lab's 3 km rocks would cover it). Its clumping and profile
  // shape it along and across the ring. The types are the belt's, the first commonest. Sorted by size, so a cell's rocks
  // draw small first and big ones sit on top.
  const ROCK_CELL = 2000, MAX_ROCKS = 24000;
  // a belt's sizes (the schema's belts.sizes): a power law from min to max metres, steeper (k) for fewer big rocks,
  // and a count factor so the three cover about as much of a belt at one density
  const ROCK_SIZES = { gravel: { min: 8, max: 120, k: 2.0, count: 2.5 }, mixed: { min: 15, max: 500, k: 1.7, count: 1 }, boulders: { min: 40, max: 900, k: 1.35, count: 0.3 } };
  let ROCKS = [], rockGrid = new Map(), rockReach = 0; // the current system's
  function rocksOf(S) {
    if (S.rocks) return S.rocks;
    const ROCKS = [], rockGrid = new Map();
    let rockReach = 0;
    for (const B of S.loaded.bodies) {
      if (B.kind !== 'belt' && B.kind !== 'field') continue;
      const K = B.belt, r = rockRng(`${B.id}:${K.seed}`), belt = B.kind === 'belt', half = K.width / 2, SZ = ROCK_SIZES[K.sizes] || ROCK_SIZES.mixed;
      const n = Math.min(MAX_ROCKS - ROCKS.length, Math.round((belt ? 2 * Math.PI * B.r * K.width : Math.PI * B.r * B.r) * K.density / 22000 * SZ.count));
      const ph = [r() * 6.283, r() * 6.283, r() * 6.283], wt = K.rocks.map((_, i) => [6, 3, 1][i]), wsum = wt.reduce((a, b) => a + b, 0);
      // clumps along the ring at the belt's own frequencies (2 to 5 big knots, 7 to 15 small), as strong as its clumping
      const f1 = 2 + Math.floor(r() * 4), f2 = 7 + Math.floor(r() * 9), cl = K.clumping == null ? 0.5 : K.clumping;
      // banded: three or four ringlets at the belt's own spacing
      const bands = Array.from({ length: 3 + Math.floor(r() * 2) }, () => -0.85 + 1.7 * r());
      for (let k = 0, tries = 0; k < n && tries < n * 4; tries++) {
        let x, y;
        if (belt) {
          const a = r() * 6.283, clump = 0.5 + 0.3 * Math.sin(f1 * a + ph[0]) + 0.2 * Math.sin(f2 * a + ph[1]);
          if (r() > 1 - cl + cl * clump) continue;
          const u = K.profile === 'core' ? (r() + r() + r() + r() - 2) / 2 * (r() < 0.75 ? 0.45 : 1)            // a dense core in thin skirts
            : K.profile === 'banded' ? Math.max(-1, Math.min(1, bands[Math.floor(r() * bands.length)] + (r() + r() - 1) * 0.07)) // ringlets
            : r() + r() - 1;                                                                                       // soft: thickest mid-belt
          const d = B.r + u * half;
          x = B.x + Math.cos(a) * d; y = B.y + Math.sin(a) * d;
        } else {
          const a = r() * 6.283, d = B.r * Math.pow(r(), 0.7);
          x = B.x + Math.cos(a) * d; y = B.y + Math.sin(a) * d;
        }
        let pick = r() * wsum, ti = 0; while (ti < wt.length - 1 && (pick -= wt[ti]) > 0) ti++;
        const rock = makeRock(K.rocks[ti], k, r);
        rock.size = SZ.min * Math.pow(1 - r() * (1 - Math.pow(SZ.min / SZ.max, SZ.k)), -1 / SZ.k);
        const m = rock.size / 2, reach = m * rockExt(rock);
        ROCKS.push({ a: rock, x, y, m, reach, seed: r() });
        rockReach = Math.max(rockReach, reach);
        k++;
      }
    }
    ROCKS.sort((p, q) => p.m - q.m);
    ROCKS.forEach((o, i) => { const key = Math.floor(o.x / ROCK_CELL) + ',' + Math.floor(o.y / ROCK_CELL); if (!rockGrid.has(key)) rockGrid.set(key, []); rockGrid.get(key).push(i); });
    return (S.rocks = { list: ROCKS, grid: rockGrid, reach: rockReach });
  }
  // traffic hulls: the owning culture's brand, a size class per role (src/traffic.json; validated by npm run check)
  // the traffic mix (the system file's traffic, validated against the catalog by npm run check): each entry's share
  // split over its classes by weight, one core mix row per line and class; loiter rows carry ships to keep up
  const TRAFFIC = CORE.TRAFFIC;
  const kindOf = (line, cls) => { const bi = catalog.brands.findIndex(b => b.id === line), zi = catalog.sizes.findIndex(z => z.id === cls); return bi < 0 || zi < 0 ? -1 : bi * nSizes + zi; };
  // (into world w's live columns, for system record S)
  function writeTraffic(w, S) {
    const M = w.mix, B_ = w.body, BODIES = S.loaded.bodies, TCFG = S.loaded.system.traffic || {}; let m = 0;
    for (const k of ['stream', 'body', 'kind', 'weight', 'rate', 'dwell']) M[k].fill(0);
    const add = (stream, body, e, total) => {
      const cls = Object.entries(e.classes || {}).filter(([c, w]) => w > 0 && kindOf(e.line, c) >= 0), sum = cls.reduce((s, [, w]) => s + w, 0);
      for (const [c, wt] of cls) { if (m >= w.maxMix) { console.warn('traffic mix: too many rows'); return; } M.stream[m] = stream; M.body[m] = body; M.kind[m] = kindOf(e.line, c); M.weight[m] = total * wt / sum; m++; }
    };
    (TCFG.local || []).forEach(e => add(TRAFFIC.mix.local, -1, e, e.share));
    (TCFG.through || []).forEach(e => add(TRAFFIC.mix.through, -1, e, e.share));
    (TCFG.loiter || []).forEach(e => { const j = BODIES.findIndex(b => b.id === e.port && b.port); if (j > 0) add(TRAFFIC.mix.loiter, j, e, e.count); });
    // a lab's standing fight (core/src/combat.rs): each side's ships as mix rows (body: the side), its zone and numbers
    const C = S.loaded.system.combat || {}, contested = BODIES.findIndex(b => b.id === C.contested);
    w.side.count.fill(0); w.side.contested.fill(-1);
    (C.sides || []).slice(0, w.maxSides).forEach((e, s) => { add(TRAFFIC.mix.side, s, e, 1); w.side.zone[s] = e.zone || 0; w.side.count[s] = e.count; w.side.contested[s] = contested; });
    // environmental stations: one group per archetype and owner, its rows from traffic.json's environs (own.<line> is
    // the owner faction's line); each station launches at its archetype's rate, a share of trips via the jump zones
    const groups = new Map();
    BODIES.forEach((b, j) => {
      B_.env[j] = 0; B_.env_rate[j] = 0; B_.env_jump[j] = 0;
      if (!b.env) return;
      const E = (TRAFFIC_DATA.environs || {})[b.env.archetype]; if (!E) return;
      const gk = b.env.archetype + '|' + b.env.brand;
      if (!groups.has(gk)) {
        const g = groups.size; groups.set(gk, g);
        for (const e of E.mix) add(TRAFFIC.mix.env, g, Object.assign({}, e, { line: e.line.replace(/^own\./, b.env.brand + '.') }), e.share);
      }
      B_.env[j] = groups.get(gk) + 1; B_.env_rate[j] = E.perMinute / 60 * b.env.scale; B_.env_jump[j] = E.jump;
    });
    if (TCFG.ships !== undefined) w.param('traffic_ships', TCFG.ships);
    if (TCFG.throughShare !== undefined) w.param('share_through', TCFG.throughShare);
    if (TCFG.jumpRadius !== undefined) w.param('jump_radius', TCFG.jumpRadius);
  }
  const mixKinds = () => [...new Set([...sim.mix.kind].filter((k, m) => sim.mix.stream[m]))];
  let bakeKinds = []; // every ship type the mix can fly, baked up front
  // Market prices: a port with a market trades what its role lists, at base price times the tier. Written at each new
  // game; a loaded save brings its own (prices are world state).
  if (GOODS.length > sim.maxGoods) console.error(`economy.json has ${GOODS.length} commodities; the core holds ${sim.maxGoods}`);
  function writePrices(w, BODIES) {
    w.market.price.fill(0);
    BODIES.forEach((b, j) => {
      if (!b.port || !(b.port.services || []).includes('market')) return;
      const table = ECON.roles[b.port.role] || {};
      GOODS.slice(0, w.maxGoods).forEach((c, g) => { const t = table[c.id]; if (t) w.market.price[j * w.maxGoods + g] = Math.round(c.base * ECON.tiers[t]); });
    });
  }
  // orbiting debris and small traffic (core/src/orbit.rs, looks only): rocky worlds wear the most debris, the busier
  // a port the more traffic; look.debris scales a world's share
  function orbitersFor() {
    sim.orbitClear();
    // (a quarter of the first counts: enough to glitter, not a swarm); the ferries round the stations are below, unchanged
    const TRAFFIC_N = { outwatch: 10, outpost: 30, colony: 90, complex: 225, world: 500 }, DEBRIS_N = { rock: 2250, terran: 625, giant: 750 };
    BODIES.forEach((b, j) => {
      if (b.kind !== 'planet' && b.kind !== 'moon') return;
      const L = b.look || {}, k = Math.min(1.6, Math.max(0.4, b.r / 1200));
      sim.orbitAdd(j, 0, Math.round((DEBRIS_N[L.surface] || 250) * k * L.debris), 1009 * j + 17);
      if (b.port) sim.orbitAdd(j, 1, Math.round((TRAFFIC_N[b.port.population] || 40) * L.orbitTraffic), 2027 * j + 5);
    });
    // a station's turning rate round its parent, rad/s (0 if it holds still)
    const spinOf = b => b.motion ? 2 * Math.PI / b.motion.period * (b.motion.clockwise ? -1 : 1) : 0;
    // ferries: specks coming and going between a world and its environmental stations, and between stations whose
    // route clears the world, a few to a route; from where the stations were laid out, turning round the world with them
    BODIES.forEach((w, j) => {
      if (w.kind !== 'planet' && w.kind !== 'moon') return;
      const st = BODIES.map((b, k) => [b, k]).filter(([b]) => b.env && b.parent === w.id);
      st.forEach(([s, k], n) => {
        const dx = s.x0 - w.x, dy = s.y0 - w.y, d = Math.hypot(dx, dy) || 1, spin = spinOf(s);
        sim.orbitFerries(j, w.x + dx / d * w.r * 0.97, w.y + dy / d * w.r * 0.97, s.x0, s.y0, w.r * 0.25, s.r * 0.3, spin, spin, 3, 3301 * k + 11); // the world's end under its station
        for (const [o, m] of st.slice(n + 1)) {
          // the closest the straight route comes to the world's centre
          const ex = o.x0 - s.x0, ey = o.y0 - s.y0, t = Math.max(0, Math.min(1, ((w.x - s.x0) * ex + (w.y - s.y0) * ey) / (ex * ex + ey * ey)));
          if (Math.hypot(s.x0 + ex * t - w.x, s.y0 + ey * t - w.y) > w.r * 1.15) sim.orbitFerries(j, s.x0, s.y0, o.x0, o.y0, s.r * 0.3, o.r * 0.3, spin, spinOf(o), 2, 7919 * k + 13 * m);
        }
      });
    });
  }
  // A system is laid out in the core's live columns, as the one being played would be, and stored in an atlas slot
  // (core/src/atlas.rs) the first time the game needs it: a new game's start system, a jump's destination. A new game,
  // a load or a jump then makes a slot live in the core alone.
  // bodies: the core places each on its orbit with its own trig (loadSystem lists parents first), and the page's
  // copies take the core's positions, so routes, wells and the drawing agree in every browser
  // a port's services the core runs (core/src/service.rs SVC_*), and its fuel price: the market's, where it sells fuel,
  // else dear (the base price at the high tier)
  const SVC = { refuel: 1, repair: 2, outfitter: 4 }, FUEL = GOODS.findIndex(c => c.id === 'fuel');
  // Laid out in a world of its own (lay: the same config, never stepped), so the live system is never touched, even
  // mid-flight; its slot's bytes then go into the game's atlas, as a replay puts them back. Returns those bytes.
  function layoutSystem(S, k) {
    const w = lay, BODIES = S.loaded.bodies;
    const WORLDS = S.worlds || (S.worlds = worldsOf(BODIES)), STATIONS = S.stations || (S.stations = stationsOf(BODIES));
    w.setBodies(BODIES.length);
    BODIES.forEach((b, j) => {
      const B = w.body; B.r[j] = b.r; B.g[j] = b.g; B.kind[j] = BODY_KIND[b.kind]; B.port[j] = b.port ? 1 : 0;
      // the stars' wells reach and hazard zones (src/stars.js); nothing else has either
      B.reach[j] = b.reach || 0; B.hazard[j] = b.hazard || 0; B.rad[j] = b.rad || 0; B.out[j] = b.out || 0; B.flares[j] = b.flares || 0;
      if (!j) { B.x[0] = 0; B.y[0] = 0; }
      w.placeBody(j, j ? BODIES.findIndex(p => p.id === b.parent) : 0, !j || b.kind === 'belt' ? 0 : b.orbit.radius, j ? b.orbit.angle : 0); // a belt is centred on its parent
      b.x0 = B.x[j]; b.y0 = B.y[j]; // (x0, y0): where it is at time 0, as placed
      if (b.motion) w.bodyMotion(j, b.motion.period * (b.motion.clockwise ? -1 : 1)); // a station that orbits (core/src/motion.rs)
      b.x = B.x[j]; b.y = B.y[j];
      B.pop[j] = b.port ? TRAFFIC_DATA.population[b.port.population] || 1 : 0; // traffic's gravity model
      const sv = (b.port && b.port.services) || [];
      B.svc[j] = sv.reduce((n, v) => n | (SVC[v] || 0), 0);
    });
    for (const o of [...WORLDS, ...STATIONS]) { const b = BODIES.find(b => b.id === o.id); o.x = b.x; o.y = b.y; }
    writeTraffic(w, S); writePrices(w, BODIES);
    BODIES.forEach((b, j) => { if (!b.port) return; const m = FUEL >= 0 ? w.price(j, FUEL) : 0; w.body.fuel_price[j] = m || Math.round((FUEL >= 0 ? GOODS[FUEL].base : 45) * ECON.tiers.high); });
    // its lanes (core/src/jump.rs): a gate per lane, in the zone nearest its bearing (gatesOf)
    w.gate.dest.fill(0xffffffff);
    gatesOf(S).forEach((G, n) => { w.gate.dest[n] = G.dest; w.gate.zone[n] = G.zone; w.gate.ly[n] = G.ly; w.gate.days[n] = G.days; });
    w.atlasReset();
    if (!w.atlasStore(0, S.entry.id)) throw new Error(`could not lay out system ${S.id}`);
    const row = w.atlasRow(0);
    if (!sim.atlasPut(k, row)) throw new Error(`atlas slot ${k} refused system ${S.id}`);
    return row;
  }
  // the atlas's slots, by system: slot k's record (every system in the atlas has been read: it was laid out from its
  // record, or a load read it first), and the slot a system is in (-1: none)
  const slotRec = k => { const c = BY_STAR.get(sim.atlasId(k)); return c && SYSTEMS.get(c.file); };
  const slotOf = S => sim.atlasFind(S.entry.id);
  // The page draws system k, live in the core: its rocks, orbiters, start port, the ship types its traffic flies, and
  // the views made from its bodies (systemViews, below: the location list's rows, the map's extent, the sky's colours)
  let startBody = 1;
  // moving stations (core/src/motion.rs): the page's copies of their positions follow the core's render positions each
  // frame (syncMovers)
  let MOVERS = [];
  function syncMovers() { for (const m of MOVERS) { m.b.x = sim.body.rx[m.j]; m.b.y = sim.body.ry[m.j]; if (m.st) { m.st.x = m.b.x; m.st.y = m.b.y; } } }
  // (quiet: no barrier yet: in transit the clock runs on, and the barrier goes up on arrival)
  let shownSlot = -1;
  function showSystem(S, quiet) {
    setSystem(S);
    shownSlot = sim.game.system[0];
    MOVERS = BODIES.map((b, j) => b.motion ? { j, b, st: STATIONS.find(o => o.id === b.id) } : null).filter(Boolean);
    syncMovers();
    ({ list: ROCKS, grid: rockGrid, reach: rockReach } = rocksOf(S));
    orbitersFor();
    startBody = Math.max(1, BODIES.findIndex(b => b.id === SYS.start && b.port), BODIES.findIndex(b => b.port));
    bakeKinds = mixKinds();
    systemViews();
    if (!quiet) raiseBarrier();
    // the systems its lanes lead to, read ahead so a jump or a chain need not wait
    needSystems(gatesOf(S).map(G => G.file).filter(Boolean));
  }
  // The system barrier: the world stops (the clock holds; the scene keeps drawing, blurred) behind a small dialog until
  // the system's stations, the hulls its traffic flies and the player's own are baked. The bakes themselves still run
  // on the worker pool as they always did; this only waits for them. A bake that fails counts as done, so it can't hang.
  let barrier = null; // { keys, total } while up
  const FACTION_NAME = { federation: 'The Federation', prism: 'Prism', union: 'The Union', blackhulls: 'The Blackhulls', freeflag: 'Freeflag', independent: 'Independent', bloom: 'The Bloom', glass: 'The Glass', shadow: 'The Shadow', none: 'Unclaimed' };
  function raiseBarrier() {
    const st = [...new Set(STATIONS.map(T => T.key))], hulls = [...new Set([...bakeKinds, SH.kind[0]].map(k => types[k] && types[k].key).filter(Boolean))];
    hulls.forEach((key, n) => { const T = types.find(t => t.key === key); if (T) typeReady(T); }); // queue any not yet asked for
    barrier = { keys: [...st, ...hulls], total: st.length + hulls.length };
    $('barrier-title').textContent = SYS.name;
    $('barrier-sub').textContent = [FACTION_NAME[SYS.owner] || '', SYS.ring ? `${SYS.ring} ring` : ''].filter(Boolean).join(' · ');
    checkBarrier();
  }
  barrierUp = () => !!barrier;
  const baked = key => { const s = baker.ships.get(key); return !!(s && ((s.ready && s.tex) || s.error)); };
  function checkBarrier() {
    if (!barrier) return;
    const done = barrier.keys.filter(baked).length;
    if (done >= barrier.total) { barrier = null; $('barrier').hidden = true; return; }
    $('barrier').hidden = false;
    $('barrier-fill').style.width = `${Math.round(100 * done / barrier.total)}%`;
    $('barrier-note').textContent = `${done}/${barrier.total}`;
  }

  // replay recording: the snapshot at the start of the session plus every input change since, every command, and every
  // system stored into the atlas since (its slot's bytes: a native replay has no page to lay it out)
  let rec = null, lastBits = -1;
  function startRecording() { rec = { start: sim.save(), startTick: sim.tick(), log: [] }; lastBits = -1; }

  // A new game starts landed at the system's start port, as in EV. opts.space = [x, y] starts flying there instead
  // (tests and the debug hook use it).
  // opts.backdrop: the title's live view (no player ship, the shell stays up).
  let seedNow = 0;
  function newGame(seed, opts) {
    seedNow = seed === undefined ? (Math.random() * 4294967296) >>> 0 : seed >>> 0;
    course = null; galaxy.close();
    sim.clear(); sim.reseed(seedNow);
    // the start system alone in the atlas, live in the core and drawn
    const S0 = SYSTEMS.get(START_ID);
    sim.atlasReset(); layoutSystem(S0, 0); sim.atlasLoad(0); showSystem(S0); galaxy.endTransit(); resetFollow();
    sim.setCount(1);
    // opts.ship: 'faction.line:class' (dev and tests), else ?ship=, else the start system's own (a lab's fast watcher)
    SH.kind[0] = playerTypeIndex((opts && opts.ship) || new URLSearchParams(location.search).get('ship') || S0.loaded.system.startShip); SH.alive[0] = 1; SH.ang[0] = 0;
    sim.setPlayer(0);
    sim.fitStock(); fittedLooks(); // its stock fit: sound, fuelled and charged (core/src/fit.rs)
    if (opts && opts.space) { SH.x[0] = opts.space[0]; SH.y[0] = opts.space[1]; sim.slotReset(0, true); }
    else { sim.slotReset(0, true); sim.placeLanded(startBody); }
    sim.game.day[0] = 1; // day one
    sim.game.credits[0] = ECON.start.credits; sim.game.debt[0] = ECON.start.debt; // a used ship and a debt to a lender
    sim.postBoards();
    sim.startTraffic(); // ambient traffic, already mid-flow
    raiseBarrier(); // again, now the player's hull is known
    camX = SH.x[0]; camY = SH.y[0]; lastMode = -1; // the next frame shows the port screen if landed
    navDest = navShip = null; viewScale = 0; // the view snaps rather than glides to a new game
    if (sim.game.auto) sim.game.auto[0] = 0;
    if (opts && opts.backdrop) SH.alive[0] = 0; // nobody flies the title
    else { closeShell(); assistMode = SETTINGS.assist; setNav(!!SETTINGS.nav); zoom = 1; }
    missionSeen.set(sim.mission.state); closeNotice(); closeLost();
    startRecording();
    if (!(opts && opts.backdrop) && sim.mode() === MODE.landed) autosave(); // so a ship lost before its first landing has a save to go back to
  }
  // commands go through here: applied now (between ticks) and logged for replays when they take effect
  function command(code, a, b) {
    const r = sim.command(code, a || 0, b || 0);
    if (r === 0) rec.log.push([sim.tick(), 'cmd', code, a || 0, b || 0]);
    return r;
  }
  // a system into the atlas mid-session: laid out (in its own world), stored in the slot the core picks for it, and
  // logged for replays; the slot, or -1 if every one is needed
  function storeSystem(S) {
    let k = slotOf(S);
    if (k >= 0) return k;
    k = sim.atlasSlotFor(S.entry.id);
    if (k < 0) return -1;
    rec.log.push([sim.tick(), 'atlas', k, layoutSystem(S, k)]);
    return k;
  }

  // ---------- units on screen ----------
  // The world is laid out in meters and small, as Escape Velocity's is: Halde is 1,500 round and 19,000 from its sun.
  // On screen a meter of the world reads as KM kilometres, which puts the worlds at real worlds' sizes (Halde, with its
  // four billion, about Earth's; moons a Luna or a Ganymede, gas giants a small Neptune), and speeds go with it (a
  // hauler's 300 is 1,200 km/s), so distance over speed is still the time a trip takes. Orbits stay close in and ships
  // are drawn far bigger than this scale: the genre's bargain. The core and the debug screen keep the world's meters.
  const KM = 4;
  const sig3 = x => { if (x < 1000) return Math.round(x); const q = 10 ** (Math.floor(Math.log10(x)) - 2); return Math.round(x / q) * q; };
  const kmNum = v => sig3(Math.max(0, v) * KM).toLocaleString('en-US');
  const fmtDist = m => `${kmNum(m)} km`;
  const fmtSpeed = v => `${Math.round(Math.abs(v) * KM).toLocaleString('en-US')} km/s`;
  // the time to cover d closing at v (nothing when not closing)
  const fmtEta = (d, v) => v < 1 ? '' : (t => t < 90 ? `${Math.round(t)} s` : `${Math.round(t / 60)} min`)(Math.max(0, d) / v);

  // ---------- jumping (core/src/jump.rs; docs/jumping.md) ----------
  // J in a lane's jump zone, moving out along it: the torch, the blink, a transit played on the galaxy map, the
  // arrival. In the transit's last moments a J chains on along the course: out in the next lane's zone, at speed, and
  // straight out again. The destination is stored in the atlas before each command (logged, for replays).
  const JUMP = CORE.JUMP, jumpPhase = () => sim.game.jump[0];
  jumping = () => jumpPhase() !== JUMP.none;
  const starName = id => (BY_STAR.get(id) || {}).name || '?';
  // the course's next lane out of this system: its gate here, or null
  function courseNext() {
    if (!course || course.dest === sysRec.entry.id) return null;
    const R = galaxyRoute(UNIVERSE, sysRec.entry.id, course.dest, course.by), G = gatesOf(sysRec);
    const g = R && R.ids.length > 1 ? G.findIndex(x => x.dest === R.ids[1]) : -1;
    return g < 0 ? null : { g, G: G[g] };
  }
  jumpKey = () => {
    const ph = jumpPhase();
    if (ph === JUMP.transit) { chainKey(); return; }
    if (ph !== JUMP.none || sim.mode() !== MODE.flying) return;
    const g = sim.zoneAt(SH.x[0], SH.y[0]), G = gatesOf(sysRec)[g];
    if (!G) { toast(`Not in a jump zone: fly out to one (${KB.name('systemMap')} shows them)`); return; }
    if (!G.file) { toast(`${G.name} is uncharted: no system to fly to yet`); return; }
    const S = SYSTEMS.get(G.file);
    if (!S) { needSystems([G.file]); toast(`Charting the lane to ${G.name}: ${KB.name('jump')} again`); return; }
    if (storeSystem(S) < 0) { toast("Can't jump: the atlas is full, with missions bound for every system in it"); return; }
    const r = command(CMD.hyper, -1);
    if (r !== 0) toast(`Can't jump to ${G.name}: ${CORE.RESULT[r] || r}`);
  };
  function chainKey() {
    const n = courseNext();
    if (!n) { toast(course ? 'The course ends here: no chain' : `No course to chain along: set one on the galaxy map (${KB.name('galaxy')})`); return; }
    const S = n.G.file && SYSTEMS.get(n.G.file);
    if (!S) { toast(`${n.G.name} ${n.G.file ? 'is still being charted' : 'is uncharted'}: no chain`); return; }
    const cost = sim.laneFuel(SH.kind[0], n.G.ly) * sim.param('chain_cost');
    if (sim.game.fuel[0] < cost) { toast(`Not enough fuel to chain on to ${n.G.name}: ${cost.toFixed(1)} t, ${sim.game.fuel[0].toFixed(1)} t aboard`); return; }
    if (storeSystem(S) < 0) return;
    const r = command(CMD.hyper, n.g);
    if (r !== 0 && r !== 20) toast(`No chain: ${CORE.RESULT[r] || r}`);
  }
  // Following the core: a blink switches system inside a tick, so the page catches up after the steps (each frame,
  // and after a test's advance): the new system drawn (quietly, in transit), and each phase change answered.
  let lastPhase = JUMP.none;
  function follow() {
    const k = sim.game.system[0];
    if (k !== shownSlot && k < sim.atlasCount()) { const S = slotRec(k); if (S) showSystem(S, jumpPhase() === JUMP.transit); }
    const ph = jumpPhase();
    if (ph === lastPhase) return;
    const prev = lastPhase; lastPhase = ph;
    if (prev === JUMP.transit) { // out of the transit: the view snaps to the ship, the barrier if bakes are left
      galaxy.endTransit();
      camX = SH.x[0]; camY = SH.y[0]; viewScale = 0; navDest = navShip = null;
      if (ph !== JUMP.torch) raiseBarrier(); // (a chained pass straight through doesn't wait for its bakes)
      flashes.push({ x: SH.x[0], y: SH.y[0], t0: performance.now() / 1000, out: false });
      if (ph === JUMP.torch) toast(`Chained through ${SYS.name}`);
      else if (course && course.dest === sysRec.entry.id) { course = null; toast(`Arrived at ${SYS.name}: course complete`); }
      else toast(`Arrived at ${SYS.name}`);
    }
  }
  const resetFollow = () => { lastPhase = jumpPhase(); };
  // the transit as the galaxy map draws it
  function transitInfo() {
    const T = sim.param('transit_secs'), t = sim.game.jt[0], n = courseNext();
    return { from: sim.game.jfrom[0], to: sysRec.entry.id, next: n ? n.G.dest : null, f: Math.min(1, t / T), window: t >= T - sim.param('chain_window'), chain: sim.game.jchain[0] };
  }
  // the HUD's jump line: the zone the player is in and what a jump needs, the torch, the arrival
  function jumpLine() {
    const ph = jumpPhase(), Gs = gatesOf(sysRec), vmax = sim.type.vmax[SH.kind[0]], v = Math.hypot(SH.vx[0], SH.vy[0]);
    if (ph === JUMP.torch) { const G = Gs[sim.game.jgate[0]]; return [`TORCH → ${G ? G.name.toUpperCase() : '?'}  ${(v / vmax).toFixed(1)}× OF ${sim.param('jump_speed')}×`, '#ffd08a', true]; }
    if (ph === JUMP.arrive) return [`ARRIVED FROM ${starName(sim.game.jfrom[0]).toUpperCase()}`, '#8fd3ff', false];
    const g = sim.zoneAt(SH.x[0], SH.y[0]), G = Gs[g];
    if (!G) return null;
    const cost = sim.laneFuel(SH.kind[0], G.ly), [dx, dy] = [Math.cos(G.zone * Math.PI / 8), Math.sin(G.zone * Math.PI / 8)];
    const need = !G.file ? 'UNCHARTED' : sim.game.fuel[0] < cost ? 'NOT ENOUGH FUEL' : v < sim.param('jump_min') * vmax ? `FASTER: ${fmtSpeed(Math.ceil(sim.param('jump_min') * vmax))}`
      : (SH.vx[0] * dx + SH.vy[0] * dy) < v * Math.cos(sim.param('jump_align') * Math.PI / 180) ? 'LINE UP OUTWARD' : null;
    return [`${G.name.toUpperCase()} LANE  ·  ${cost.toFixed(1)} t  ·  ${G.days} D${need ? `  ·  ${need}` : ''}`, need ? '#e2b866' : '#7fd08a', !need];
  }
  landOrLaunch = () => {
    const m = sim.mode();
    if (m === MODE.landed) { command(CMD.launch); return; }
    if (m !== MODE.flying) return;
    const r = command(CMD.land);
    if (r === 1) toast('Nothing to land on here: fly over a port');
    else if (r === 2) { const pb = sim.portBelow(), B = pb && BODIES[pb.body], st = B && B.kind === 'station'; toast(`Too fast to ${st ? 'dock' : 'land'}${B && B.motion ? ': match its speed' : ''}`); }
  };
  skipSequence = () => command(CMD.skip);
  waitDay = () => {
    const r = command(CMD.wait);
    if (r === 0) toast(`Day ${sim.day()}: docking fee ${fmtCr(sim.param('dock_fee'))} cr`);
    else if (r === 5) toast(`Can't pay the ${fmtCr(sim.param('dock_fee'))} cr docking fee`);
    refreshPort();
  };
  inPort = () => sim.mode() === MODE.landed;
  // refuel or repair (core/src/service.rs): as much as the credits pay for, at this port's price
  portService = what => {
    const refuel = what === 'refuel', cr0 = sim.credits(), before = refuel ? sim.game.fuel[0] : SH.hull[0];
    const r = command(refuel ? CMD.refuel : CMD.repair), paid = cr0 - sim.credits();
    if (r === 0) {
      const full = refuel ? sim.game.fuel[0] >= sim.type.fuel[SH.kind[0]] : SH.hull[0] >= sim.type.hull[SH.kind[0]];
      toast(refuel ? `${full ? 'Tank full' : 'Refuelled'}: ${(sim.game.fuel[0] - before).toFixed(1)} t for ${fmtCr(paid)} cr` : `${full ? 'Hull repaired' : 'Repaired'}: ${Math.round(SH.hull[0] - before)} points for ${fmtCr(paid)} cr`);
    } else toast(r === 14 ? (refuel ? 'The tank is full' : 'The hull is sound') : `Can't ${what}: ${CORE.RESULT[r] || r}`);
    refreshPort();
    return r;
  };
  $('svc-refuel').onclick = () => { portService('refuel'); canvas.focus(); };
  $('svc-repair').onclick = () => { portService('repair'); canvas.focus(); };
  $('svc-wait').onclick = () => { waitDay(); canvas.focus(); };
  $('svc-map').onclick = () => openGalaxy();
  $('svc-trade').onclick = () => { showPanel(panelOpen() === 'trade' ? null : 'trade'); canvas.focus(); };
  $('svc-board').onclick = () => { showPanel(panelOpen() === 'board' ? null : 'board'); canvas.focus(); };
  $('svc-bar').onclick = () => { showPanel(panelOpen() === 'bar' ? null : 'bar'); canvas.focus(); };
  $('svc-about').onclick = () => { showPanel(panelOpen() === 'about' ? null : 'about'); canvas.focus(); };
  $('svc-outfit').onclick = () => { showPanel(panelOpen() === 'outfit' ? null : 'outfit'); canvas.focus(); };
  $('svc-launch').onclick = () => { landOrLaunch(); canvas.focus(); };
  // saves: the world's bytes, and a note of where and when for the title's Continue
  function store(key) {
    localStorage.setItem(key, b64(sim.save()));
    const at = sim.mode() === MODE.flying ? null : BODIES[sim.game.at[0]];
    localStorage.setItem(key + '.meta', JSON.stringify({ day: sim.day(), credits: sim.credits(), port: at && at.port ? at.port.name : null, seed: seedNow }));
  }
  saveGame = () => { if (titleUp()) return; store('driftward.save'); toast(`Saved at tick ${sim.tick()}`); };
  function loadFrom(key) {
    const s = localStorage.getItem(key);
    if (!s) return false;
    const before = sim.save(), err = sim.load(unb64(s));
    if (err) { toast(`Save is unreadable (error ${err}): saved by an older build?`); return false; }
    // every system in the save's atlas must be read (to draw it, and to name missions' ports): if one isn't yet, the
    // world goes back as it was while they are read, then the save loads again (a promise of that, here)
    const ids = []; for (let k = 0; k < sim.atlasCount(); k++) ids.push(sim.atlasId(k));
    const missing = ids.map(id => BY_STAR.get(id)).filter(c => !c || !c.file || !SYSTEMS.has(c.file));
    if (missing.length) {
      sim.load(before);
      if (missing.some(c => !c || !c.file)) { toast('Save is from another universe: a system in it is not in this one'); return false; }
      return needSystems(missing.map(c => c.file)).then(() => loadFrom(key));
    }
    const meta = JSON.parse(localStorage.getItem(key + '.meta') || '{}');
    seedNow = meta.seed >>> 0;
    fittedLooks();
    showSystem(slotRec(sim.game.system[0]), sim.game.jump[0] === CORE.JUMP.transit); resetFollow(); // the save's system, live in the core already
    camX = SH.x[0]; camY = SH.y[0]; lastMode = -1; navDest = navShip = null; viewScale = 0; missionSeen.set(sim.mission.state); closeNotice(); closeLost(); startRecording();
    closeShell(); assistMode = SETTINGS.assist; setNav(!!SETTINGS.nav);
    toast(`Loaded day ${sim.day()}`);
    return true;
  }
  // (a promise, when a system the save holds must be read first)
  loadGame = () => { const r = loadFrom('driftward.save') || loadFrom('driftward.autosave'); if (!r) toast('No saved game'); return r; };
  // autosave on landing, as in EV (the Book: death reloads the last landing save)
  function autosave() { store('driftward.autosave'); }
  function exportReplay() {
    const ticks = sim.tick() - rec.startTick, hash = sim.hash();
    const hex = b => Array.from(b, v => v.toString(16).padStart(2, '0')).join('');
    const log = `# driftward input log: replay with\n#   cargo run --release --bin replay -- driftward-save.bin driftward-inputs.txt ${ticks}\n# expect: tick ${sim.tick()} hash ${hash}\n`
      + rec.log.map(e => e[1] === 'cmd' ? `${e[0]} cmd ${e[2]} ${e[3]} ${e[4]}` : e[1] === 'atlas' ? `${e[0]} atlas ${e[2]} ${hex(e[3])}` : `${e[0]} ${e[1]}`).join('\n') + '\n';
    return { save: rec.start, log, ticks, tick: sim.tick(), hash };
  }
  function download(name, data, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
  $('b-save').onclick = () => { saveGame(); canvas.focus(); };
  $('b-load').onclick = () => { loadGame(); canvas.focus(); };
  $('b-menu').onclick = () => { pauseGame(!$('pause').hidden ? false : true); };

  // ---------- the shell: title, pause, settings ----------
  let paused = false;
  const titleUp = () => !$('title').hidden;
  function closeShell() { for (const id of ['title', 'pause', 'settings']) $(id).hidden = true; paused = false; canvas.focus(); }
  // the title: over a live view of the system (traffic flying past Halde), with Continue from the last landing
  function showTitle() {
    // over the start system's start port (where its file places it, before the core lays it out the first time)
    const B0 = SYSTEMS.get(START_ID).loaded.bodies, H0 = B0[Math.max(1, B0.findIndex(b => b.id === SYSTEMS.get(START_ID).loaded.system.start && b.port), B0.findIndex(b => b.port))];
    newGame(1, { backdrop: true, space: [H0.x - H0.r * 1.05, H0.y + H0.r * 0.25] });
    zoom = 0.5; setNav(false);
    for (const id of ['pause', 'settings']) $(id).hidden = true;
    paused = false;
    const meta = JSON.parse(localStorage.getItem('driftward.autosave.meta') || 'null');
    $('t-continue').disabled = !localStorage.getItem('driftward.autosave');
    $('t-continue-sub').textContent = meta ? `day ${meta.day}${meta.port ? ' at ' + meta.port : ''} · ${fmtCr(meta.credits)} cr` : 'no landing yet';
    $('title-sub').textContent = `The ${SYS.name} system · ${BODIES.filter(b => b.port).length} ports`;
    $('title').hidden = false;
    ($('t-continue').disabled ? $('t-new') : $('t-continue')).focus();
  }
  // a seed from the field: blank is random; a number is used as is; any other text is hashed
  function seedFrom(text) {
    text = text.trim();
    if (!text) return undefined;
    if (/^\d+$/.test(text)) return Number(text) >>> 0;
    let h = 0x811c9dc5; for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    return h;
  }
  $('t-new').onclick = () => { newGame(seedFrom($('t-seed').value)); toast(`New game · seed ${seedNow}`); };
  $('t-continue').onclick = () => { if (!loadFrom('driftward.autosave')) showTitle(); };
  pauseGame = on => {
    if (titleUp()) return;
    paused = on;
    $('pause').hidden = !on;
    if (on) $('pause-sub').textContent = `Day ${sim.day()} · ${fmtCr(sim.credits())} cr · seed ${seedNow}`;
    else canvas.focus();
  };
  shellBack = () => { if (!$('keys').hidden) closeKeys(); else if (!$('settings').hidden) closeSettings(); else if (!$('pause').hidden) pauseGame(false); };
  $('p-resume').onclick = () => pauseGame(false);
  $('p-save').onclick = () => { saveGame(); pauseGame(false); };
  $('p-load').onclick = () => loadGame();
  $('p-title').onclick = () => showTitle();
  function openSettings() {
    $('s-bloom').value = String(SETTINGS.bloom); $('s-nav').value = String(SETTINGS.nav);
    $('s-assist').value = String(SETTINGS.assist); $('s-debug').value = String(SETTINGS.debug); $('s-quality').value = String(SETTINGS.quality);
    $('settings').hidden = false; $('s-done').focus();
  }
  function closeSettings() { $('settings').hidden = true; if (!shellOpen()) canvas.focus(); }
  for (const k of ['bloom', 'nav', 'assist', 'debug', 'quality']) $('s-' + k).onchange = e => {
    SETTINGS[k] = +e.target.value; localStorage.setItem('driftward.settings', JSON.stringify(SETTINGS)); applySettings();
  };
  $('t-settings').onclick = openSettings; $('p-settings').onclick = openSettings; $('s-done').onclick = closeSettings;
  // the hints that name keys, from the bindings: the strip's flight keys, the port's buttons, the pause menu
  function keyHints() {
    const N = KB.name, strip = [[['thrust', 'reverse'], 'throttle'], [['retro'], 'stop'], [['burn'], 'burn'], [['mode'], 'mode'], [['land'], 'land'], [['jump'], 'jump'],
      [['autopilot'], 'autopilot'], [['screenNext'], 'ships'], [['placeNext'], 'places'], [['cold'], 'cold'], [['ping'], 'ping'], [['galaxy'], 'maps'], [['nav'], 'nav']];
    document.querySelector('.strip .keys').textContent = strip.map(([ids, what]) => `${ids.map(N).join(' ')} ${what}`).join(' · ');
    for (const [id, act] of [['svc-trade', 'trade'], ['svc-board', 'missions'], ['svc-bar', 'bar'], ['svc-wait', 'wait'], ['svc-map', 'portMap'], ['svc-launch', 'land'], ['svc-about', 'about'], ['svc-outfit', 'outfit']]) $(id).querySelector('span').textContent = N(act);
    $('p-resume').querySelector('span').textContent = `${N('pause')} or Esc`; $('p-save').querySelector('span').textContent = N('save'); $('p-load').querySelector('span').textContent = N('load');
    refreshPort();
  }
  keyHints();
  // the Keys dialog over settings (src/play/keys.js); every change re-reads the hints that name keys
  KB.attach($('keys'), { onChange: () => keyHints(), toast });
  const closeKeys = () => { $('keys').hidden = true; $('settings').hidden = false; $('s-keys').focus(); }; // back to settings
  $('s-keys').onclick = () => { KB.render(); $('settings').hidden = true; $('keys').hidden = false; };
  $('keys').querySelector('[data-act=done]').onclick = closeKeys;
  $('p-replay').onclick = () => {
    const r = exportReplay();
    download('driftward-save.bin', r.save, 'application/octet-stream');
    download('driftward-inputs.txt', r.log, 'text/plain');
    toast(`Replay: ${r.ticks} ticks, hash ${r.hash}`); canvas.focus();
  };

  // ---------- frame ----------
  let last = 0, camX = 0, camY = 0, fps = 60, fpsAcc = 0, fpsN = 0, lastMode = -1;
  let held = false; // tests: the clock held while the page still draws (__play.hold), so only the script steps it
  const JIT = makeJitter(CFG.maxShips); // motion smoothness, frame by frame (src/play/jitter.js; Shift+J shows it)
  // a ship's motion state for the probe: 0 while a landing or launch sequence draws it, else 1 + phase + 4 x on rails
  const jitState = i => { const ph = sim.traffic.phase[i]; return sim.traffic.role[i] && ph !== TRAFFIC.cruise ? 0 : 1 + ph + 4 * sim.ship.rail[i]; };
  jitterToggle = () => JIT.toggle();
  // the GPU's time for the scene, where the browser can time it (Chrome on most desktops): queries read back a few
  // frames later without waiting, for the probe
  const TQ = gl.getExtension('EXT_disjoint_timer_query_webgl2'), tqFree = [], tqLive = [];
  const gpuBegin = () => { if (!TQ || tqLive.length > 6) return null; const q = tqFree.pop() || gl.createQuery(); gl.beginQuery(TQ.TIME_ELAPSED_EXT, q); return q; };
  const gpuEnd = q => { if (q) { gl.endQuery(TQ.TIME_ELAPSED_EXT); tqLive.push(q); } };
  function gpuPoll() {
    if (!TQ) return;
    if (gl.getParameter(TQ.GPU_DISJOINT_EXT)) { tqFree.push(...tqLive.splice(0)); return; } // the timer was disturbed: drop them
    while (tqLive.length && gl.getQueryParameter(tqLive[0], gl.QUERY_RESULT_AVAILABLE)) { const q = tqLive.shift(), ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; JIT.gpu(ms); gov.gpu = ms; tqFree.push(q); }
  }
  // Auto resolution (quality setting Auto): the scene drops a step (RS_STEPS) when, over the last 90 drawn frames,
  // more than 3% ran late, or where the GPU can be timed, when it takes over 92% of a frame; it climbs a step after
  // a calm spell (no late frames, and room on the GPU where it is timed), waiting twice as long each time a climb
  // had to be undone straight away, so it settles instead of see-sawing. The display's frame time is the quickest
  // the page has seen (each window's third-quickest frame, the lowest so far), so it works at any refresh rate and a
  // GPU that never keeps up (every frame late, at a steady 30 fps) still reads as late.
  const gov = { dts: new Float64Array(90), n: 0, gpu: NaN, at: 0, calmSince: 0, backoff: 4000, lastUp: -1e9, display: Infinity };
  function renderGovernor(now, dt) {
    if (SETTINGS.quality > 0) return;
    gov.dts[gov.n++ % 90] = dt * 1000;
    if (gov.n < 90 || now - gov.at < 1000) return;
    const v = Array.from(gov.dts).sort((a, b) => a - b);
    gov.display = Math.max(4, Math.min(gov.display, v[2]));
    const interval = gov.display, late = v.filter(x => x > interval * 1.5).length / v.length;
    const gpuBusy = gov.gpu === gov.gpu && gov.gpu > interval * 0.92, i = Math.max(0, RS_STEPS.indexOf(renderScale));
    if ((late > 0.03 || gpuBusy) && i < RS_STEPS.length - 1) {
      if (now - gov.lastUp < 6000) gov.backoff = Math.min(120000, gov.backoff * 2); // the last climb didn't hold
      setRenderScale(RS_STEPS[i + 1]); gov.at = gov.calmSince = now; gov.n = 0;
      console.info(`render resolution ${Math.round(renderScale * 100)}% (${Math.round(late * 100)}% of frames late, display ${interval.toFixed(1)} ms${gov.gpu === gov.gpu ? `, gpu ${gov.gpu.toFixed(1)} ms` : ''})`);
      return;
    }
    if (late > 0.01 || gpuBusy) { gov.calmSince = now; gov.at = now; return; }
    const room = !(gov.gpu === gov.gpu) || (i > 0 && gov.gpu * (RS_STEPS[i - 1] / renderScale) ** 2 < interval * 0.8);
    if (i > 0 && now - gov.calmSince > gov.backoff && room) {
      setRenderScale(RS_STEPS[i - 1]); gov.at = gov.calmSince = gov.lastUp = now; gov.n = 0;
      console.info(`render resolution ${Math.round(renderScale * 100)}% (calm for ${(gov.backoff / 1000).toFixed(0)} s)`);
    }
  }
  const t0 = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const c0 = performance.now(); // the frame's CPU time, by section, for the jitter probe
    const dt = last ? Math.min(0.25, (now - last) / 1000) : 1 / 60; last = now; frameDt = dt;
    fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    sim.checkViews();
    // bake the traffic hulls up front (behind the start port's screen), not when the first one flies into view
    for (const k of bakeKinds) typeReady(types[k]);
    let ran = 0;
    checkBarrier();
    if (!paused && !held && !debug.isOpen() && !galaxy.isOpen() && !barrier && !notice && !lost) { // paused, debugging, on the galaxy map, behind the system barrier or a dialog: the clock stops (the replay log is by tick, so a pause leaves no trace)
      const bits = inputBits(IN);
      if (bits !== lastBits) { sim.setInput(bits); rec.log.push([sim.tick(), bits]); lastBits = bits; }
      ran = sim.due(dt);
      for (let n = ran; n > 0; n--) sim.step();
    }
    const c1 = performance.now();
    follow();
    sim.interpolate();
    syncMovers();
    const mode = sim.mode();
    if (mode !== lastMode) { onMode(mode, lastMode); lastMode = mode; }
    watchMissions();
    // the camera eases toward its target at the same rate whatever the frame rate: the exact exponential, so a long
    // frame (a hitch, a dropped frame) moves it as far as the short frames it replaced would have, with no lurch
    const k = 1 - Math.exp(-3.5 * dt);
    if (mode === MODE.landed) { const B = BODIES[sim.game.at[0]]; camX += (B.x - camX) * k; camY += (B.y - camY) * k; }
    else if (mode === MODE.flying && jumping()) { camX = SH.rx[0]; camY = SH.ry[0]; } // the drive has the ship: the view holds it, however fast
    else if (mode === MODE.flying) { const lead = 0.35; camX += (SH.rx[0] + SH.vx[0] * lead - camX) * k; camY += (SH.ry[0] + SH.vy[0] * lead - camY) * k; }
    else { const q = playerSeq().pose, lead = 0.35; camX += (q.x + q.vx * lead - camX) * k; camY += (q.y + q.vy * lead - camY) * k; } // following the curl, leading as in flight
    const yv = debug.yardView(); // the debug screen's Ships tab draws the shipyard instead of the game
    if (yv) { yard.render((now - t0) / 1000, yv.cells, yv.opts); G.postProcess(bloomOn ? 0.9 : 0, 0); hx.setTransform(1, 0, 0, 1, 0, 0); hx.clearRect(0, 0, hud.width, hud.height); return; }
    const sv = debug.sunView(); // and its Suns tab, the star gallery
    if (sv) { sunGallery.render((now - t0) / 1000, sv.cells, sv.opts); G.postProcess(bloomOn ? 0.9 : 0, 0); hx.setTransform(1, 0, 0, 1, 0, 0); hx.clearRect(0, 0, hud.width, hud.height); return; }
    const mv = debug.mapView(); // and its Map tab, the star map
    if (mv) { mv.tick(dt); mv.draw(bloomOn ? 0.8 : 0); hx.setTransform(1, 0, 0, 1, 0, 0); hx.clearRect(0, 0, hud.width, hud.height); return; }
    if (jumpPhase() === JUMP.transit) { // between systems: the trip on the galaxy map, and the chain prompt
      const tv = galaxy.transit(transitInfo());
      if (tv) { tv.tick(dt); tv.draw(bloomOn ? 0.8 : 0); }
      else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
      $('loc').hidden = true; drawTransit(); return;
    }
    const gv = galaxy.view(); // the galaxy map: the star map instead of the game
    if (gv) { gv.tick(dt); gv.draw(bloomOn ? 0.8 : 0); hx.setTransform(1, 0, 0, 1, 0, 0); hx.clearRect(0, 0, hud.width, hud.height); return; }
    // nothing to see under the port's painted vista, the map, the debug screen or the pause menu: the canvas keeps
    // its last frame (pause shows it frozen behind the menu), and the GPU rests
    const covered = ($('vista').classList.contains('on') && !document.body.classList.contains('vista-framed')) || mapOn || debug.isOpen() || (paused && !titleUp());
    gpuPoll();
    const c2 = performance.now();
    const drew = !covered || sceneStale;
    if (drew) { const q = gpuBegin(); render((now - t0) / 1000, camX, camY); gpuEnd(q); sceneStale = false; }
    if (drew && !covered && !paused) renderGovernor(now, dt);
    if (mode === MODE.flying && !paused && !covered) JIT.record({ dt, ticks: ran, alpha: sim.alpha(), px: SH.rx[0], py: SH.ry[0], cx: camX, cy: camY, scale, h: canvas.height }, SH, sim.count(), jitState);
    else JIT.reset();
    const c3 = performance.now();
    drawHUD();
    hx.setTransform(dpr, 0, 0, dpr, 0, 0); JIT.draw(hx, 12, H - stripH - 262, 640, 250, now);
    const c4 = performance.now();
    drawMap();
    const c5 = performance.now();
    JIT.cpuTime({ total: c5 - c0, sim: c1 - c0, render: c3 - c2, hud: c4 - c3, map: c5 - c4 });
  }

  // the game mode changed: show or hide the port screen, autosave on landing
  function onMode(mode, prev) {
    const port = $('port');
    if (mode === MODE.landed) {
      const B = BODIES[sim.game.at[0]], P0 = B.port;
      $('port-kicker').textContent = [B.name, P0.role.replace('-', ' ')].join(' · ');
      $('port-name').textContent = P0.name;
      // whose port it is: a station's builder (its brand), else the system's owner; their logo on the card
      const own = (B.station && B.station.brand) || SYS.owner, logo = $('port-logo'), src = factionLogo(UNIVERSE, own);
      logo.hidden = !src; if (src) { logo.src = src; logo.title = FACTION_NAME[own] || own; }
      const L = LORE.ports.get(B.id);
      $('port-desc').textContent = brief(L ? L.description[0] : P0.description || ''); // the whole of it is on the about page
      $('svc-trade').disabled = !(P0.services || []).includes('market');
      $('svc-board').disabled = !(P0.services || []).includes('missions');
      $('svc-bar').disabled = !(P0.services || []).includes('bar') || !L;
      $('svc-refuel').hidden = !(P0.services || []).includes('refuel'); $('svc-repair').hidden = !(P0.services || []).includes('repair');
      $('svc-outfit').disabled = !(P0.services || []).includes('outfitter');
      fillLore(B, L);
      showVista(B.id);
      port.hidden = false;
      showPanel(null);
      // newly landed (not a new game or a load): autosave. Any earlier mode counts, as a stalled frame or a test
      // stepping the sim directly can pass the whole descent between two frames
      if (prev !== -1 && prev !== MODE.landed) { autosave(); toast(`Landed at ${P0.name}: day ${sim.day()}, saved`); }
    } else { port.hidden = true; showVista(null); }
    if (mode === MODE.dead) showLost();
  }
  // The ship lost (core/src/service.rs): the world stops behind a dialog that reloads the last landing's save (the
  // Book: death reloads the last landing save), or goes back to the title.
  let lost = false;
  function showLost() {
    const meta = JSON.parse(localStorage.getItem('driftward.autosave.meta') || 'null');
    const near = SUNS.filter(S => S.hazard > 0).sort((a, b) => Math.hypot(a.x - SH.x[0], a.y - SH.y[0]) - Math.hypot(b.x - SH.x[0], b.y - SH.y[0]))[0];
    $('lost-title').textContent = types[SH.kind[0]].name;
    $('lost-sub').textContent = `Day ${sim.day()} · ${SYS.name} system`;
    const flareStar = sim.game.flare[0] === 2 && BODIES[sim.game.flare_star[0]];
    $('lost-text').textContent = `${flareStar ? `A flare from ${flareStar.name} burned through the hull.` : near ? `Radiation from ${near.name} burned through the hull.` : 'The hull gave out.'} ${meta ? `The last landing was day ${meta.day}${meta.port ? ' at ' + meta.port : ''}.` : 'There is no landing to go back to.'}`;
    $('lost-reload').disabled = !localStorage.getItem('driftward.autosave');
    lost = true; $('lost').hidden = false; ($('lost-reload').disabled ? $('lost-title-btn') : $('lost-reload')).focus();
  }
  lostUp = () => lost;
  closeLost = () => { if (!lost) return; lost = false; $('lost').hidden = true; };
  $('lost-reload').onclick = () => { if (!loadFrom('driftward.autosave')) showTitle(); };
  $('lost-title-btn').onclick = () => { closeLost(); showTitle(); };
  // the painted vista of the port on body id (none: the procedural view shows), faded in once it has loaded
  function showVista(id) {
    const img = $('vista'), src = id && ART.vistas[id];
    img.classList.remove('on');
    document.body.classList.toggle('has-vista', !!src); // the framed layout is for a port with a painting
    if (!src) { img.removeAttribute('src'); return; }
    img.onload = () => { if (img.getAttribute('src') === src) { frameVista(); img.classList.add('on'); } };
    img.onerror = () => console.warn(`vista ${src} did not load; showing the procedural view`);
    img.src = src;
  }
  // a description's first sentence (two, if the first is short), for the port card
  function brief(t) {
    const S = t.match(/[^.!?]+[.!?]+(\s|$)/g) || [t];
    return (S[0].split(' ').length < 12 && S[1] ? S[0] + S[1] : S[0]).trim();
  }
  // the bar (people with their portraits, rumors) and the about page (description, places, the system), from the
  // lore; without it the about page has the system file's descriptions
  function fillLore(B, L) {
    const P0 = B.port, lore = LORE.lore;
    $('bar-sum').textContent = L ? `${L.people.length} people in tonight` : '';
    $('bar-people').innerHTML = L ? L.people.map(q => `<div class="person">${ART.portraits[q.id]
      ? `<img src="${esc(ART.portraits[q.id])}" alt="${esc(q.name)}">` : `<div class="face">${esc(q.name[0])}</div>`}`
      + `<div><h4>${esc(q.name)}</h4><p class="role">${esc(q.role)}</p><p>${esc(q.text)}</p><q>${esc(q.line)}</q></div></div>`).join('') : '';
    // a portrait that fails to load (the page opened without art/ beside it) falls back to an initial
    $('bar-people').querySelectorAll('img').forEach(img => { img.onerror = () => img.replaceWith(Object.assign(document.createElement('div'), { className: 'face', textContent: img.alt[0] })); });
    $('bar-rumors').innerHTML = L ? L.rumors.map(r => `<li>${esc(r)}</li>`).join('') : '';
    $('about-name').textContent = P0.name;
    $('about-sum').textContent = `${B.name} · ${P0.population}`;
    $('about-desc').innerHTML = (L ? L.description : [P0.description || '']).map(t => `<p>${esc(t)}</p>`).join('');
    $('about-places').innerHTML = L ? L.places.map(p => `<li><b>${esc(p.name)}</b> · ${esc(p.text)}</li>`).join('') : '<li>No guide to this port yet.</li>';
    $('about-sys-head').textContent = `The ${SYS.name} system`;
    $('about-sys').innerHTML = (lore ? [...lore.history, lore.culture] : [SYS.description || '']).map(t => `<p>${esc(t)}</p>`).join('');
  }

  // ---------- the port's market and mission board ----------
  // Every change is a core command (logged for replays); the panels only show the columns and send commands.
  const holdCap = () => sim.type.cargo[SH.kind[0]];
  const MS = sim.mission, OF = sim.offer, NM = sim.maxMissions, NO = sim.maxOffers, MSTATE = CORE.MISSION;
  const activeMissions = () => { const a = []; for (let k = 0; k < NM; k++) if (MS.state[k] === MSTATE.active) a.push(k); return a; };
  // a port's name in the current system, or in system s; a mission's destination, with its system if it is another
  // a port's name by body, in this system or atlas slot s; a mission's destination, with its system if it is elsewhere
  const here = () => sim.game.system[0];
  const portName = (j, s) => { const S = s === undefined || s === here() ? sysRec : slotRec(s), B = S && S.loaded.bodies[j]; return !B ? '?' : B.port ? B.port.name : B.name; };
  const missionDest = k => portName(MS.dest[k], MS.sys[k]) + (MS.sys[k] !== here() && slotRec(MS.sys[k]) ? ` (${slotRec(MS.sys[k]).loaded.system.name})` : '');
  const activeHere = () => activeMissions().filter(k => MS.sys[k] === here()); // the ones bound for this system's ports
  // a traffic route's end: a port, or jump zone z (coded -1 - z)
  const endName = c => c < 0 ? `the ${(gatesOf(sysRec)[-1 - c] || {}).name || TRAFFIC.zones[(-1 - c) % 4]} jump zone` : portName(c);
  const cargoText = (tons, g) => `${tons} t ${(GOODS[g] || { name: '?' }).name.toLowerCase()}`;
  // food and medicine, and no climate hold to put them in (core/src/fit.rs)
  const needsClimate = g => (GOODS[g] || {}).hold === 'climate' && sim.game.fitted[0] && !(sim.fit.t[FIT.climate] > 0);
  // each active mission for the galaxy map: the system it is bound to (its atlas slot's star id), the port, the cargo,
  // the pay and the days left
  galaxyMissions = () => activeMissions().map(k => ({ star: sim.atlasId(MS.sys[k]), port: portName(MS.dest[k], MS.sys[k]), tons: MS.tons[k], good: (GOODS[MS.good[k]] || {}).id, pay: MS.pay[k], left: MS.due[k] - sim.day() }));
  const daysText = n => n <= 0 ? 'due today' : n === 1 ? '1 day' : `${n} days`;
  function refreshPort() {
    if (sim.mode() !== MODE.landed) return;
    $('port-day').textContent = `Day ${sim.day()} · ${SYS.name}`;
    const nm = activeMissions().length;
    $('port-money').textContent = `${fmtCr(sim.credits())} cr · hold ${sim.holdUsed()}/${holdCap()} t · owe ${fmtCr(sim.debt())} cr` + (nm ? ` · ${nm} mission${nm > 1 ? 's' : ''}` : '');
    // refuel and repair: the full cost on each, or that there is nothing to do
    const fuelCost = sim.serviceCost(CMD.refuel), hullCost = sim.serviceCost(CMD.repair), k = SH.kind[0];
    $('svc-refuel').disabled = !fuelCost; $('svc-repair').disabled = !hullCost;
    $('svc-refuel-k').textContent = `${fuelCost ? `${fmtCr(fuelCost)} cr` : 'full'} · ${KB.name('refuel')}`;
    $('svc-repair-k').textContent = `${hullCost ? `${fmtCr(hullCost)} cr` : 'sound'} · ${KB.name('repair')}`;
    $('port-day').textContent += ` · hull ${Math.round(100 * SH.hull[0] / sim.type.hull[k])}% · fuel ${sim.game.fuel[0].toFixed(1)}/${sim.type.fuel[k].toFixed(1)} t`;
    if (panelOpen() === 'board') refreshBoard();
    if (panelOpen() === 'outfit') refreshOutfit();
    if (panelOpen() !== 'trade') return;
    const at = sim.game.at[0], cr = sim.credits();
    $('trade-rows').innerHTML = GOODS.map((c, g) => {
      const price = sim.price(at, g), aboard = sim.hold.tons[g], room = sim.roomFor(g); // room by hold class (core/src/fit.rs)
      if (!price && !aboard) return '';
      const cls = !price ? 'none' : price < c.base ? 'low' : price > c.base ? 'high' : '';
      const why = room > 0 ? '' : needsClimate(g) ? ' title="Food and medicine need a climate hold (outfitter)"' : ' title="No room in the hold for it"';
      return `<tr><td>${c.name}${c.hold === 'climate' ? ' <small>climate</small>' : ''}</td><td class="num ${cls}">${price ? fmtCr(price) : '—'}</td><td class="num">${aboard || ''}</td>`
        + `<td class="act"><button type="button" data-g="${g}" data-act="buy"${price && room > 0 && cr >= price ? '' : ' disabled'}${why}>Buy</button>`
        + `<button type="button" data-g="${g}" data-act="sell"${price && aboard ? '' : ' disabled'}>Sell</button></td></tr>`;
    }).join('');
    const owe = sim.debt();
    $('trade-debt').textContent = owe ? `Debt ${fmtCr(owe)} cr · ${+(sim.param('interest') * 100).toFixed(1)}% a day` : 'No debt';
    $('repay-1k').disabled = !owe || cr < Math.min(1000, owe);
    $('repay-max').disabled = !owe || !cr;
  }
  // the board: offers at this port, then the player's missions
  function refreshBoard() {
    const at = sim.game.at[0], full = activeMissions().length >= NM;
    $('board-sum').textContent = `${activeMissions().length}/${NM} taken`;
    let rows = '';
    for (let k = 0; k < NO; k++) {
      const o = at * NO + k;
      if (!OF.live[o]) continue;
      const fits = OF.tons[o] <= sim.roomFor(OF.good[o]), why = full ? 'Carrying the most missions you can' : fits ? '' : needsClimate(OF.good[o]) ? 'Food and medicine need a climate hold' : 'Not enough room in the hold';
      rows += `<tr><td>${portName(OF.dest[o])}${portName(OF.dest[o]) !== BODIES[OF.dest[o]].name ? `<br><small>${BODIES[OF.dest[o]].name}</small>` : ''}</td><td>${cargoText(OF.tons[o], OF.good[o])}</td>`
        + `<td class="num">${fmtCr(OF.pay[o])}</td><td class="num">${daysText(OF.days[o])}</td>`
        + `<td class="act"><button type="button" data-k="${k}" data-act="accept"${fits && !full ? '' : ' disabled'} title="${why}">Accept</button></td></tr>`;
    }
    $('board-rows').innerHTML = rows || '<tr><td class="empty" colspan="5">No offers today</td></tr>';
    $('mission-rows').innerHTML = activeMissions().map(k => `<tr><td>${missionDest(k)}</td><td>${cargoText(MS.tons[k], MS.good[k])}</td>`
      + `<td class="num">${fmtCr(MS.pay[k])}</td><td class="num ${MS.due[k] - sim.day() <= 1 ? 'high' : ''}">${daysText(MS.due[k] - sim.day())}</td>`
      + `<td class="act"><button type="button" data-k="${k}" data-act="abandon">Abandon</button></td></tr>`).join('')
      || '<tr><td class="empty">None</td></tr>';
  }
  showPanel = name => {
    if (name === 'outfit' && panelOpen() !== 'outfit' && !$('svc-outfit').disabled) command(CMD.draftFrom, 0); // a fresh draft, from the ship's fit
    for (const p of PANELS) {
      $(p).hidden = name !== p || $('svc-' + p).disabled;
      $('svc-' + p).setAttribute('aria-pressed', String(!$(p).hidden));
    }
    $('port').classList.toggle('wide', panelOpen() === 'outfit');
    refreshPort();
  };
  // the course set on the galaxy map, for the HUD: where to, the next jump, how many and how long (the route made again
  // only when here or the course changes); none once here is the destination
  let courseRoute = null, courseKey = '';
  function courseLine() {
    if (!course || course.dest === sysRec.entry.id) return null;
    const key = `${sysRec.entry.id}|${course.dest}|${course.by}`;
    if (key !== courseKey) { courseKey = key; courseRoute = galaxyRoute(UNIVERSE, sysRec.entry.id, course.dest, course.by); }
    const name = id => (BY_STAR.get(id) || {}).name || '?', R = courseRoute;
    return R ? `COURSE → ${name(course.dest).toUpperCase()}  ·  NEXT ${name(R.ids[1]).toUpperCase()}  ·  ${R.jumps} JUMP${R.jumps === 1 ? '' : 'S'} ${R.days.toFixed(1)} D`
      : `COURSE → ${name(course.dest).toUpperCase()}  ·  NO LANE FROM HERE`;
  }
  // the debug screen's Player tab: a snapshot of the player's ship, flight, money, hold and missions
  debug.setLive(() => {
    const k = SH.kind[0], T = types[k], at = sim.game.at[0], mode = sim.mode(), landed = mode === MODE.landed, below = sim.portBelow();
    const ports = BODIES.map((b, j) => ({ j, b })).filter(o => o.b.port), price = (j, g) => sim.price(j, g);
    const missions = activeMissions().map(m => ({ k: m, dest: missionDest(m), good: (GOODS[MS.good[m]] || { name: '?' }).name.toLowerCase(), tons: MS.tons[m], pay: MS.pay[m], due: MS.due[m], left: MS.due[m] - sim.day() }));
    const missionTons = missions.reduce((n, m) => n + m.tons, 0);
    const goods = GOODS.map((c, g) => ({ name: c.name, base: c.base, aboard: Math.max(0, sim.hold.tons[g] - missions.filter(m => MS.good[m.k] === g).reduce((n, m) => n + m.tons, 0)), prices: ports.map(o => price(o.j, g)) }));
    const tradeTons = goods.reduce((n, g) => n + g.aboard, 0);
    return {
      ship: { name: T.name, kind: k, length: T.L, accel: sim.type.accel[k], turn: sim.type.turn[k], vmax: sim.type.vmax[k], well: sim.type.well[k], cargo: sim.type.cargo[k],
        hull: SH.hull[0], hullCap: sim.type.hull[k], fuel: sim.game.fuel[0], fuelCap: sim.type.fuel[k], heat: sim.game.heat[0], hot: !!sim.game.hot[0], heatBurn: sim.param('heat_burn'), heatCool: sim.param('heat_cool'), radiation: sim.radiation(SH.x[0], SH.y[0]) },
      mode: Object.keys(MODE).find(m => MODE[m] === mode), assist: ASSIST[assistMode].hud.toLowerCase(),
      at: landed || mode !== MODE.flying ? portName(at) : '', below: mode === MODE.flying && below ? `${portName(below.body)}${below.slow ? ', slow enough to land' : ', too fast to land'}` : '',
      x: SH.x[0], y: SH.y[0], vx: SH.vx[0], vy: SH.vy[0], v: Math.hypot(SH.vx[0], SH.vy[0]), heading: ((SH.ang[0] * 180 / Math.PI) % 360 + 360) % 360, av: SH.av[0],
      set: sim.playerSet(), auto: autoName(),
      credits: sim.credits(), debt: sim.debt(), interest: sim.param('interest'), dockFee: sim.param('dock_fee'),
      here: landed ? portName(at) : '', cargoHere: landed ? goods.reduce((n, g, gi) => n + g.aboard * price(at, gi), 0) : 0,
      cargoBest: goods.reduce((n, g) => n + g.aboard * Math.max(0, ...g.prices), 0),
      holdUsed: sim.holdUsed(), tradeTons, missionTons,
      ports: ports.map(o => ({ name: o.b.port.name, role: o.b.port.role, here: landed && o.j === at })), goods, missions,
      day: sim.day(), tick: sim.tick(), hash: sim.hash(), seed: seedNow,
      traffic: trafficInfo()
    };
  });
  // the traffic for the debug screen: the targets, the mix rows with how many of each fly now, the counts by stream
  function trafficInfo() {
    const M = sim.mix, rows = [], live = new Map(), byStream = [0, 0, 0, 0];
    for (let i = 0; i < sim.count(); i++) if (TR.role[i]) { byStream[TR.role[i] - 1]++; live.set(TR.mix[i], (live.get(TR.mix[i]) || 0) + 1); }
    const total = s => { let t = 0; for (let m = 0; m < sim.maxMix; m++) if (M.stream[m] === s) t += M.weight[m]; return t; };
    const tot = [0, total(1), total(2), total(3)];
    for (let m = 0; m < sim.maxMix; m++) {
      if (!M.stream[m]) continue;
      const T = types[M.kind[m]];
      rows.push({ m, stream: ['', 'local', 'through', 'loiter'][M.stream[m]], at: M.body[m] >= 0 ? portName(M.body[m]) : '', line: T.brand.id, name: `${T.brand.factionName.replace(/^The /, '')} ${T.name}`, cls: catalog.sizes[T.zi].name,
        share: M.stream[m] === 3 ? M.weight[m] : M.weight[m] / (tot[M.stream[m]] || 1), live: live.get(m) || 0 });
    }
    return { ships: sim.param('traffic_ships'), through: sim.param('share_through'), cap: sim.param('traffic_cap'), jump: sim.param('jump_radius'),
      loiter: tot[3], byStream, rows };
  }
  // buy or sell n tons (n omitted: all that fits or is aboard); returns the core's result
  function trade(act, g, n) {
    const price = sim.price(sim.game.at[0], g), c = GOODS[g];
    if (n === undefined) n = act === 'buy' ? Math.min(sim.roomFor(g), Math.floor(sim.credits() / Math.max(1, price))) : sim.hold.tons[g];
    const r = command(act === 'buy' ? CMD.buy : CMD.sell, g, n);
    if (r === 0) toast(`${act === 'buy' ? 'Bought' : 'Sold'} ${n} t ${c.name.toLowerCase()} for ${fmtCr(n * price)} cr`);
    else toast(`Can't ${act} ${c.name.toLowerCase()}: ${CORE.RESULT[r] || r}`);
    refreshPort();
    return r;
  }
  function repay(amount) {
    const r = command(CMD.repay, Math.min(amount, sim.debt()));
    toast(r === 0 ? `Repaid; you owe ${fmtCr(sim.debt())} cr` : `Can't repay: ${CORE.RESULT[r] || r}`);
    refreshPort();
    return r;
  }
  $('trade-rows').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (b) trade(b.dataset.act, +b.dataset.g, e.shiftKey ? undefined : 1);
  });
  $('repay-1k').onclick = () => repay(1000);
  $('repay-max').onclick = () => repay(sim.credits());
  // accept offer k on this port's board; abandon mission slot k
  function accept(k) {
    const o = sim.game.at[0] * NO + k, what = OF.live[o] ? `${cargoText(OF.tons[o], OF.good[o])} to ${portName(OF.dest[o])}, by day ${sim.day() + OF.days[o]}` : '';
    const r = command(CMD.accept, k);
    toast(r === 0 ? `Accepted: ${what}` : `Can't accept: ${CORE.RESULT[r] || r}`);
    refreshPort();
    return r;
  }
  function abandon(k) {
    const what = `${cargoText(MS.tons[k], MS.good[k])} to ${missionDest(k)}`;
    const r = command(CMD.abandon, k);
    toast(r === 0 ? `Abandoned: ${what}` : `Can't abandon: ${CORE.RESULT[r] || r}`);
    refreshPort();
    return r;
  }
  $('board').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (b) (b.dataset.act === 'accept' ? accept : abandon)(+b.dataset.k);
  });
  // report missions the core delivered (on landing) or failed (a day passed the deadline)
  const missionSeen = new Uint8Array(NM);
  function watchMissions() {
    const done = [];
    for (let k = 0; k < NM; k++) {
      const st = MS.state[k];
      if (st === MSTATE.delivered && missionSeen[k] !== st) { done.push(k); toast(`Delivered ${cargoText(MS.tons[k], MS.good[k])} to ${missionDest(k)}: +${fmtCr(MS.pay[k])} cr`); }
      if (st === MSTATE.failed && missionSeen[k] !== st) toast(`Mission failed: ${cargoText(MS.tons[k], MS.good[k])} to ${missionDest(k)} is past its deadline`);
      if (missionSeen[k] !== st) { missionSeen[k] = st; refreshPort(); }
    }
    if (done.length) showDeliveries(done);
  }
  // A delivery's notice, on landing: the missions it completed, over the port screen in the barrier's blur. The clock
  // holds until it is closed (Enter, Space, Escape or its button); a new game, a load or a jump closes it.
  let notice = false;
  function showDeliveries(ks) {
    const at = BODIES[sim.game.at[0]], paid = ks.reduce((n, k) => n + MS.pay[k], 0);
    $('notice-kicker').textContent = ks.length > 1 ? `${ks.length} deliveries complete` : 'Delivery complete';
    $('notice-title').textContent = at && at.port ? at.port.name : at ? at.name : SYS.name;
    $('notice-sub').textContent = `Day ${sim.day()} · ${SYS.name} system`;
    $('notice-rows').innerHTML = ks.map(k => `<p class="notice-row"><span>${esc(cargoText(MS.tons[k], MS.good[k]))} from ${esc(portName(MS.from[k], MS.sys[k]))}</span><b>+${fmtCr(MS.pay[k])} cr</b></p>`).join('');
    $('notice-total').textContent = `Paid ${fmtCr(paid)} cr · balance ${fmtCr(sim.credits())} cr`;
    notice = true; $('notice').hidden = false; $('notice-ok').focus();
  }
  noticeUp = () => notice;
  closeNotice = () => { if (!notice) return; notice = false; $('notice').hidden = true; canvas.focus(); };
  $('notice-ok').onclick = () => closeNotice();

  // ---------- the outfitter (core/src/fit.rs; docs/outfitting.md) ----------
  // The ship's fit as rows by group, the draft's tonnes against the ship's, with steppers; the bay's two sides as bars,
  // a block a module as wide as its tonnes; the hull with its plumes and corners where they are on it; and the budget the
  // draft makes (the core's numbers, viewFit), with what changes from the ship's fit. Every change is a core command on
  // the draft (logged, so replays follow it); Refit puts it on the ship.
  const STAT = Object.fromEntries(sim.fitStats.map((n, k) => [n, k]));
  const fitStats = which => { sim.viewFit(which); const v = sim.fitView, o = {}; for (const n in STAT) o[n] = v[STAT[n]]; return o; };
  const fmt1 = x => (Math.round(x * 10) / 10).toLocaleString('en-US');
  const prm = n => sim.param(n);
  // a row: its slot (or the four corners together), its side of the bulkhead (P, U, or outside the bay), its step and
  // what a step gives, and its price a step
  const OUTFIT_GROUPS = [
    // weapons (core/src/combat.rs): the multicannons, a gun a turret site its size or bigger; the magazine they share
    ['Weapons', [
      { id: 'mc', name: 'Light multicannon', side: 'U', step: 1, unit: '', give: () => `30 mm, ${fmt1(prm('mc_rate'))}/s, ${kmNum(prm('mc_speed') * prm('mc_fuse'))} km · ${fmt1(prm('mc_t'))} t · any site`, price: () => prm('price_mc') },
      { id: 'mm', name: 'Medium multicannon', side: 'U', step: 1, unit: '', give: () => `57 mm, ${fmt1(prm('mm_rate'))}/s, ${kmNum(prm('mm_speed') * prm('mm_fuse'))} km · ${fmt1(prm('mm_t'))} t · a medium or heavy site`, price: () => prm('price_mm') },
      { id: 'ml', name: 'Heavy multicannon', side: 'U', step: 1, unit: '', give: () => `120 mm, ${fmt1(prm('ml_rate'))}/s, ${kmNum(prm('ml_speed') * prm('ml_fuse'))} km · ${fmt1(prm('ml_t'))} t · a heavy site`, price: () => prm('price_ml') },
      { id: 'magazine', name: 'Magazine', side: 'U', step: 1, give: () => `${Math.round(prm('mc_rounds'))} × 30 mm, ${Math.round(prm('mm_rounds'))} × 57 mm or ${Math.round(prm('ml_rounds'))} × 120 mm`, price: () => prm('price_magazine') }]],
    ['Drive', [
      { id: 'jets', name: 'Jet clusters', side: 'corners', step: 1, give: () => 'turning, a cluster per corner', price: () => prm('price_jet') }]],
    ['Power', [
      { id: 'furnace', name: 'Furnace reactor', side: 'P', step: 5, give: () => `${fmt1(prm('furnace_mw') * 5)} MW`, price: () => prm('price_furnace') * 5 },
      { id: 'battery', name: 'Accumulator', side: 'P', step: 1, give: () => `${fmt1(prm('battery_mj'))} MJ`, price: () => prm('price_battery') }]],
    ['Shields and heat', [
      { id: 'deflector', name: 'Deflector', side: 'U', step: 2, give: () => `${fmt1(prm('defl_regen') * 2)} pts/s regen`, price: () => prm('price_deflector') * 2 },
      { id: 'banks', name: 'Shield bank', side: 'P', step: 1, give: () => `${fmt1(prm('bank_pts'))} pts`, price: () => prm('price_bank') },
      { id: 'fins', name: 'Fin radiator', side: 'U', step: 1, give: () => `sheds ${fmt1(prm('fin_mw'))} MW`, price: () => prm('price_fin') },
      { id: 'sinks', name: 'Heat sink', side: 'U', step: 1, give: () => `${fmt1(prm('sink_mj'))} MJ of heat`, price: () => prm('price_sink') },
      { id: 'armour', name: 'Armour', side: 'hull', step: 1, give: () => `${fmt1(prm('armour_pts'))} hull`, price: () => prm('price_armour') }]],
    ['Crew and navigation', [
      { id: 'bunks', name: 'Bunk', side: 'P', step: 1, unit: '', give: () => `one crew, ${fmt1(prm('bunk_t'))} t`, price: () => prm('price_bunk') },
      { id: 'sensors', name: 'Sensors', side: 'P', step: 1, give: () => 'range', price: () => prm('price_sensor') },
      { id: 'jump', name: 'Jump drive', side: 'P', step: 1, give: () => `jumps ${fmt1(prm('jump_t'))} t`, price: () => prm('price_jump') }]],
    ['Cargo and fuel', [
      { id: 'hopper', name: 'Hopper', side: 'U', step: 1, give: () => 'bulk: ore, water, metals, fuel', price: () => prm('price_hopper') },
      { id: 'rack', name: 'Container rack', side: 'U', step: 1, give: () => 'bulk and general cargo', price: () => prm('price_rack') },
      { id: 'climate', name: 'Climate hold', side: 'P', step: 1, give: () => 'anything; food, medicine', price: () => prm('price_climate') },
      { id: 'tank', name: 'Fuel tank', side: 'U', step: 1, give: () => `${fmt1(prm('tank_fuel'))} t of fuel`, price: () => prm('price_tank') }]],
    ['Structure', [
      { id: 'bulkhead', name: 'Bulkhead', side: '±', step: 1, give: () => 'moves bay into pressure', price: () => prm('price_bulkhead'), signed: true }]]
  ];
  // the bay's blocks, by side, and their colours
  const BAY = { P: [['bunks', '#8fd3ff'], ['sensors', '#7fd0c4'], ['furnace', '#e8a05a'], ['jump', '#c9b3f0'], ['battery', '#e2b866'], ['banks', '#6fa8ff'], ['climate', '#7fd08a']],
    U: [['hopper', '#a08a6a'], ['rack', '#c8a27a'], ['tank', '#d07a5a'], ['deflector', '#6fa8ff'], ['fins', '#9fb4c8'], ['sinks', '#7a8aa0'], ['mc', '#e86a5a'], ['mm', '#d4553f'], ['ml', '#b8402c'], ['magazine', '#9a4a3e']] };
  const BAY_NAME = { bunks: 'bunks', sensors: 'sensors', furnace: 'reactor', jump: 'jump drive', battery: 'battery', banks: 'shield banks', climate: 'climate hold',
    hopper: 'hoppers', rack: 'racks', tank: 'fuel tank', deflector: 'deflector', fins: 'fins', sinks: 'heat sinks', mc: 'light guns', mm: 'medium guns', ml: 'heavy guns', magazine: 'magazine' };
  const draftT = n => sim.draft.t[FIT[n]], fitT = n => sim.fit.t[FIT[n]];
  const changed = () => sim.fitSlots.some((n, k) => n && sim.draft.t[k] !== sim.fit.t[k]);
  // set slot n of the draft to v tonnes (all four corners for the jets)
  function setDraft(n, v) {
    const slots = n === 'jets' ? [0, 1, 2, 3].map(c => FIT['corner' + c]) : [FIT[n]];
    for (const k of slots) { const r = command(CMD.draft, k, Math.round(v * 2)); if (r) { toast(`Can't: ${CORE.RESULT[r] || r}`); break; } }
    refreshOutfit();
  }
  function stepRow(n, dir, step, signed) {
    // torches and jets: nothing, half a tonne, then whole tonnes (the plumes' total is the hull's limit: the core says)
    const cur = n === 'jets' ? draftT('corner0') : draftT(n);
    if (n === 'jets' || n.startsWith('plume')) { setDraft(n, dir > 0 ? (cur < 0.5 ? 0.5 : cur < 1 ? 1 : cur + 1) : (cur > 1 ? cur - 1 : cur > 0.5 ? 0.5 : 0)); return; }
    const v = cur + dir * step;
    if (!signed && v < 0) return;
    setDraft(n, v);
  }
  // the hull, its plumes and corners where they are on it (the bake's silhouette and nozzles; the jet anchors)
  function drawOutfitShip(T) {
    const cv = $('outfit-ship'), c = cv.getContext('2d'), W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    if (!T || !typeReady(T)) { c.fillStyle = '#8a95a4'; c.font = '12px "IBM Plex Mono", monospace'; c.fillText('Baking the hull…', 12, H / 2); return; }
    // the silhouette (the bake's aux map: inside where its distance outside the hull is ~0), zoomed to the hull's own
    // extent with room round it for the plumes' marks
    const m = T.s.maps, res = m.res, aux = T.s.aux;
    const img = c.createImageData(res, res);
    let x0 = res, x1 = 0, y0 = res, y1 = 0;
    for (let o = 0; o < res * res; o++) if (aux[o * 4] < 2) {
      img.data[o * 4] = 60; img.data[o * 4 + 1] = 72; img.data[o * 4 + 2] = 88; img.data[o * 4 + 3] = 255;
      const ix = o % res, iy = (o / res) | 0; x0 = Math.min(x0, ix); x1 = Math.max(x1, ix); y0 = Math.min(y0, iy); y1 = Math.max(y1, iy);
    }
    const k = 0.8 * Math.min(W / Math.max(1, x1 - x0 + 1), H / Math.max(1, y1 - y0 + 1)), ox = W / 2 - (x0 + x1 + 1) / 2 * k, oy = H / 2 - (y0 + y1 + 1) / 2 * k;
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = res; tmp.getContext('2d').putImageData(img, 0, 0);
    c.imageSmoothingEnabled = true; c.drawImage(tmp, ox, oy, res * k, res * k);
    // texel (u, v) and hull metres (x right, y forward) on the canvas
    const at = (u, v) => [ox + u * res * k, oy + v * res * k], px = (lx, ly) => at(0.5 + lx / m.extent, 0.5 - ly / m.extent);
    c.font = '600 11px "IBM Plex Mono", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    (m.engines || []).slice(0, 8).forEach((e, q) => {
      const [x, y] = at(e.u, e.v), t = draftT('plume' + q);
      c.fillStyle = t > 0 ? '#ff8a2e' : '#4d5663'; c.beginPath(); c.arc(x, y + 6, 7, 0, 7); c.fill();
      c.fillStyle = '#07090c'; c.fillText(t ? fmt1(t) : '–', x, y + 6);
    });
    if (T.rcs) ['fl', 'fr', 'rl', 'rr'].forEach((n, q) => {
      const [x, y] = px(T.rcs[n][0], T.rcs[n][1]), t = draftT('corner' + q);
      c.fillStyle = '#8fd3ff'; c.fillRect(x - 6, y - 6, 12, 12); c.fillStyle = '#07090c'; c.fillText(fmt1(t), x, y);
    });
  }
  function refreshOutfit() {
    if (!sim.game.fitted[0]) return;
    const base = sim.game.base[0], T = types[base], cur = fitStats(0), d = fitStats(1);
    $('outfit-sum').textContent = `${T.name} · fit worth ${fmtCr(Math.round(d.value))} cr`;
    // the bars: pressurised and unpressurised, a block a module
    const bar = (side, used, space) => {
      const blocks = BAY[side].map(([n, col]) => { const t = n === 'bunks' ? draftT(n) * prm('bunk_t') : n === 'mc' || n === 'mm' || n === 'ml' ? draftT(n) * prm(n + '_t') : draftT(n); return t > 0 ? `<i style="width:${100 * t / Math.max(space, used, 1)}%;background:${col}" title="${BAY_NAME[n]} ${fmt1(t)} t"></i>` : ''; }).join('');
      return `<div class="bay"><span>${side === 'P' ? 'Pressurised' : 'Unpressurised'}</span><b class="${used > space + 1e-9 ? 'over' : ''}">${fmt1(used)} / ${fmt1(space)} t</b><div class="bay-bar">${blocks}</div></div>`;
    };
    $('outfit-bars').innerHTML = bar('P', d.pUsed, d.pSpace) + bar('U', d.uUsed, d.uSpace);
    // the rows: the plumes first (one a nozzle), then each group
    const cell = (n, name, side, give, price, step, unit, signed) => {
      const a = n === 'jets' ? draftT('corner0') : draftT(n), b = n === 'jets' ? fitT('corner0') : fitT(n);
      const u = unit === undefined ? ' t' : unit;
      return `<tr><td>${name}<br><small>${side} · ${give}${price ? ` · ${fmtCr(Math.round(price))} cr` : ''}</small></td>`
        + `<td class="num${a !== b ? ' high' : ''}">${signed && a > 0 ? '+' : ''}${fmt1(a)}${u}${a !== b ? `<br><small>was ${fmt1(b)}</small>` : ''}</td>`
        + `<td class="act"><button type="button" data-n="${n}" data-d="-1" data-s="${step}"${signed ? ' data-signed="1"' : ''}>−</button><button type="button" data-n="${n}" data-d="1" data-s="${step}"${signed ? ' data-signed="1"' : ''}>+</button></td></tr>`;
    };
    const torches = Array.from({ length: d.plumes }, (_, q) => draftT('plume' + q)).reduce((a, b) => a + b, 0);
    let rows = `<tr class="grp"><td colspan="3">Torches · a plume each · ${fmt1(torches)} of ${fmt1(d.torchCap)} t</td></tr>`;
    for (let q = 0; q < d.plumes; q++) { const t = draftT('plume' + q); rows += cell('plume' + q, `Plume ${q + 1}`, 'torch', `${fmt1(t * prm('torch_mn'))} MN`, prm('price_torch') * t * t * t, 1); }
    for (const [g, list] of OUTFIT_GROUPS) {
      rows += `<tr class="grp"><td colspan="3">${g}</td></tr>`;
      for (const R of list) rows += cell(R.id, R.name, R.side === 'P' ? 'pressurised' : R.side === 'U' ? 'unpressurised' : R.side, R.give(), R.price(), R.step, R.unit, R.signed);
    }
    $('outfit-rows').innerHTML = rows;
    // the budget: what the draft makes, and the change from the ship's fit
    const delta = (a, b, f = fmt1, good = 1) => Math.abs(a - b) < 1e-6 ? '' : ` <small class="${(a - b) * good > 0 ? 'up' : 'down'}">${a > b ? '+' : '−'}${f(Math.abs(a - b))}</small>`;
    const kms2 = a => Math.round(a * KM).toLocaleString('en-US'), deg = r => Math.round(r * 180 / Math.PI), int = x => Math.round(x).toLocaleString('en-US'); // (the screen's km: KM to the metre)
    const drive = d.mwLife + d.mwDrive, short = d.mwLife + d.mwDrive + d.mwRegen + d.mwBurn - d.mw;
    const perLy = sim.laneFuel(PK, 1) || 1, range = d.fuel / perLy;
    const line = (k, v) => `<p><span>${k}</span><b>${v}</b></p>`;
    $('outfit-budget').innerHTML = [
      line('Mass', `${int(d.massEmpty)} t${delta(d.massEmpty, cur.massEmpty, fmt1, -1)} · full ${int(d.massFull)} t`),
      line('Acceleration', `${kms2(d.accel)} km/s²${delta(d.accel, cur.accel, kms2)} · full ${kms2(d.accelFull)}`),
      line('Turn', `${deg(d.turn)}°/s${delta(d.turn, cur.turn, deg)}`),
      line('Power', `${fmt1(d.mw)} MW${delta(d.mw, cur.mw)} · cruise ${fmt1(drive)} · shields +${fmt1(d.mwRegen)} · burner +${fmt1(d.mwBurn)}`),
      line('Battery', `${fmt1(d.battery)} MJ${delta(d.battery, cur.battery)}${short > 0 ? ` · ${Math.round(d.battery / short)} s of burner short` : ''}`),
      line('Heat', d.burnSecs < 0 ? 'the burner never locks' : `burner locks after ${Math.round(d.burnSecs)} s${delta(d.burnSecs, cur.burnSecs, x => Math.round(x) + ' s')}`),
      line('Shield', `${fmt1(d.shield)} pts${delta(d.shield, cur.shield)} · ${fmt1(d.regen)}/s${d.regen > 0 ? ` · full in ${Math.round(d.shield / d.regen)} s` : ''}`),
      line('Guns', `${[['mc', 'light'], ['mm', 'medium'], ['ml', 'heavy']].filter(([n]) => draftT(n)).map(([n, w]) => `${draftT(n)} ${w}`).join(', ') || 'none'} · sites ${d.sites} light, ${d.sitesM} medium, ${d.sitesL} heavy${d.gunsOk ? '' : ' · TOO MANY GUNS FOR THE SITES'} · ${Math.round(d.fireSecs)} s of fire · reach ${kmNum(d.range)} km`),
      line('Hull', `${int(d.hull)} pts${delta(d.hull, cur.hull, int)}`),
      line('Holds', `bulk ${fmt1(d.hopper)} · racks ${fmt1(d.rack)} · climate ${fmt1(d.climate)} t`),
      line('Fuel', `${fmt1(d.fuel)} t${delta(d.fuel, cur.fuel)} · ${fmt1(range)} ly`),
      line('Jump drive', `jumps ${int(d.jump)} t · laden ${int(d.massFull)} t`),
      line('Crew', `${d.crew} bunks · needs ${d.crewMin}`)
    ].join('');
    const warn = [];
    if (d.problem) warn.push(`Can't fit: ${CORE.RESULT[d.problem] || d.problem}`);
    if (d.mw <= 0) warn.push('No reactor: the battery runs the ship until it is flat');
    else if (drive > d.mw) warn.push('Not enough power for full thrust: the drive browns out');
    else if (drive + d.mwRegen > d.mw) warn.push('Shields recharge slowly at full thrust');
    if (d.jump < d.massFull) warn.push(d.jump < d.massEmpty ? 'The jump drive can’t move the ship' : 'The jump drive can’t move a full hold');
    if (d.crew < d.crewMin) warn.push('Too few bunks for the crew it needs: it can’t launch');
    if (!(d.climate > 0)) warn.push('No climate hold: no food or medicine');
    $('outfit-warn').innerHTML = warn.map(w => `<li>${esc(w)}</li>`).join('');
    const ch = changed(), cost = d.cost;
    $('outfit-cost').textContent = !ch ? 'No changes' : cost >= 0 ? `Refit: ${fmtCr(cost)} cr${cost > sim.credits() ? ` (you have ${fmtCr(sim.credits())})` : ''}` : `Refit: ${fmtCr(-cost)} cr back`;
    $('outfit-refit').disabled = !ch || !!d.problem || cost > sim.credits();
    $('outfit-reset').disabled = !ch;
    drawOutfitShip(T);
  }
  function refit() {
    const before = sim.credits(), r = command(CMD.refit);
    if (r === 0) { const paid = before - sim.credits(); toast(paid >= 0 ? `Refitted for ${fmtCr(paid)} cr` : `Refitted: ${fmtCr(-paid)} cr back`); }
    else toast(`Can't refit: ${CORE.RESULT[r] || r}`);
    refreshPort();
    return r;
  }
  $('outfit-rows').addEventListener('click', e => { const b = e.target.closest('button[data-n]'); if (b) stepRow(b.dataset.n, +b.dataset.d, +b.dataset.s, !!b.dataset.signed); });
  $('outfit-refit').onclick = () => refit();
  // the debug screen's Outfitting tab: the ship's fit slot by slot, what it makes, its power, heat and shield now, the
  // stock fit of every catalog hull against its catalog stats, and the components' ratings and prices (core params)
  debug.setFit(() => {
    if (!sim.game.fitted[0]) return null;
    const base = sim.game.base[0], v = fitStats(0), g = sim.game, T = types[base];
    const meta = new Map(OUTFIT_GROUPS.flatMap(([grp, list]) => list.map(R => [R.id, { grp, name: R.name, side: R.side, price: R.price() / R.step, unit: R.unit }])));
    const slots = [];
    for (let q = 0; q < v.plumes; q++) { const t = fitT('plume' + q); slots.push({ grp: 'Torches', name: `Plume ${q + 1}`, side: 'torch', t, price: prm('price_torch') * t * t * t, each: true }); }
    ['fl', 'fr', 'rl', 'rr'].forEach((c, q) => slots.push({ grp: 'Drive', name: `Jets, ${{ fl: 'fore left', fr: 'fore right', rl: 'aft left', rr: 'aft right' }[c]}`, side: 'corner', t: fitT('corner' + q), price: prm('price_jet') * fitT('corner' + q), each: true }));
    for (const [n, M] of meta) if (n !== 'jets') slots.push({ grp: M.grp, name: M.name, side: M.side, t: fitT(n), unit: M.unit, price: n === 'bulkhead' ? 0 : M.price * fitT(n) });
    // cargo aboard by hold class (trade and mission cargo)
    const byClass = [0, 0, 0];
    GOODS.forEach((c, i) => { byClass[sim.goods.class[i]] += sim.hold.tons[i]; });
    activeMissions().forEach(k => { byClass[sim.goods.class[MS.good[k]]] += MS.tons[k]; });
    // every catalog hull's stock fit (the core's stock_fit), against the catalog's acceleration and turn
    const stock = [];
    types.forEach((S, k) => {
      if (k === PK || (S.brand.classes && !S.brand.classes.includes(catalog.sizes[S.zi].id))) return;
      sim.viewStock(k);
      const sv = {}; for (const n in STAT) sv[n] = sim.fitView[STAT[n]];
      const f = Object.fromEntries(Object.entries(FIT).map(([n, i]) => [n, sim.stockFit[i]]));
      stock.push({ k, name: S.name, line: S.brand.id, cls: catalog.sizes[S.zi].name, catAccel: sim.type.accel[k], catTurn: sim.type.turn[k], f, v: sv, mine: k === base });
    });
    const names = sim.paramNames, from = names.indexOf('torch_mn'), to = names.indexOf('price_bulkhead');
    const params = names.slice(from, to + 1).map(n => ({ n, v: sim.param(n) }));
    return { name: T.name, line: T.brand.id, base, v, slots, byClass, stock, params,
      live: { mw: g.mw_use[0], drive: g.drive[0], energy: g.energy[0], heat: g.heat[0], hot: !!g.hot[0], shield: g.shield[0], shieldT: g.shield_t[0], cold: !!g.cold[0], fuel: g.fuel[0], hull: SH.hull[0] } };
  });
  $('outfit-reset').onclick = () => { command(CMD.draftFrom, 0); refreshOutfit(); };
  $('outfit-stock').onclick = () => { command(CMD.draftFrom, 1); refreshOutfit(); };

  // ---------- render ----------
  const MAXS = CFG.maxShips;
  // the most stations a system can have: its bodies (the schema's cap) and its environmental stations
  const MAX_STATIONS = SYSTEM_SCHEMA.properties.bodies.maxItems + MAX_ENVIRONS;
  const VS = { ship: instVAO([4, 2], MAXS), station: instVAO([4, 2], MAX_STATIONS), plume: instVAO([4, 4, 2], MAXS * 12),
    orbiter: instVAO([4, 4], sim.orbitOut.length / 8), ghost: instVAO([4, 4], 8), speck: instVAO([4, 4], MAX_ROCKS) };
  const shipInst = new Float32Array(MAXS * 6), plumeInst = new Float32Array(MAXS * 12 * 10);
  // ---------- combat's looks (core/src/combat.rs; docs/weapons.md) ----------
  // Shells are drawn as tracers from the core's columns. Bursts come from the core's ring (each read once, by its time):
  // a shell in the open is a puff of fire; on a shield (its surface, standing off the hull) a ripple in the shield's
  // colour from where it struck (the shield shader's hits, two a ship) and sparks skating off, no fire, only a flicker
  // for a hit the shield shrugs off, and a fainter ripple where a burst nearby reached it; on a hull fire, debris,
  // embers left on the plating and the hull glowing; a ship destroyed, a fireball and debris. Particles are looks
  // only: Math.random, outside the sim.
  const MAXSH = sim.maxShells, MAXP = 8192, HIT_LIFE = 2.6;
  const TRACER_LEN = [10, 18, 30]; // a tracer's length (m), by calibre: light, medium, heavy
  const TRACER_COL = [[0.85, 0.72, 0.16], [1.0, 0.45, 0.08], [1.3, 0.16, 0.05]]; // and its colour, brightness in it: yellow, orange, red
  VS.shield = instVAO([4, 4, 4], MAXS); VS.bolt = instVAO([4, 4], MAXSH); VS.part = instVAO([4, 4], MAXP);
  const shieldInst = new Float32Array(MAXS * 12), boltInst = new Float32Array(MAXSH * 8), partInst = new Float32Array(MAXP * 8);
  const shieldCount = new Int32Array(types.length), shieldStart = new Int32Array(types.length), shieldFill = new Int32Array(types.length);
  // particles: a fixed pool of MAXP slots, live while life > 0. A new one takes the next slot round (when the pool is
  // full, the oldest written goes); nothing moves when one dies. `top`: slots used so far, so loops skip the rest
  const FX = { next: 0, top: 0, x: new Float32Array(MAXP), y: new Float32Array(MAXP), vx: new Float32Array(MAXP), vy: new Float32Array(MAXP), life: new Float32Array(MAXP),
    max: new Float32Array(MAXP), size: new Float32Array(MAXP), grow: new Float32Array(MAXP), r: new Float32Array(MAXP), g: new Float32Array(MAXP), b: new Float32Array(MAXP), shard: new Uint8Array(MAXP) };
  // per slot: the last two shield hits (local, in half-extents; the game time; strength), the hull's glow, and the
  // generation they belong to (a respawned slot starts clean)
  const HITS = { ax: new Float32Array(MAXS), ay: new Float32Array(MAXS), at: new Float64Array(MAXS).fill(-99), as: new Float32Array(MAXS),
    bx: new Float32Array(MAXS), by: new Float32Array(MAXS), bt: new Float64Array(MAXS).fill(-99), bs: new Float32Array(MAXS), glow: new Float32Array(MAXS), gen: new Uint32Array(MAXS) };
  const FLASH = []; // [x, y, radius, life, age, r, g, b]: brief lights on the hulls round a burst
  let burstAt = -1; // the newest burst read
  function addFx(x, y, vx, vy, life, size, grow, r, g, b, shard) {
    const k = FX.next;
    FX.next = (k + 1) % MAXP; FX.top = Math.max(FX.top, k + 1);
    FX.x[k] = x; FX.y[k] = y; FX.vx[k] = vx; FX.vy[k] = vy; FX.life[k] = life; FX.max[k] = life; FX.size[k] = size; FX.grow[k] = grow; FX.r[k] = r; FX.g[k] = g; FX.b[k] = b; FX.shard[k] = shard ? 1 : 0;
  }
  function sparks(x, y, vx, vy, n, col, speed, size, life) {
    for (let k = 0; k < n; k++) { const a = Math.random() * 6.283, s = speed * (0.3 + Math.random()); addFx(x, y, vx + Math.cos(a) * s, vy + Math.sin(a) * s, life * (0.5 + Math.random()), size * (0.6 + Math.random() * 0.8), -0.4, col[0] * 3, col[1] * 3, col[2] * 3); }
  }
  // sparks glancing off a shield at (x, y): along the surface, either way, a little outward (nx, ny: out from the ship)
  function skate(x, y, vx, vy, nx, ny, n, col, speed, size, life) {
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    for (let k = 0; k < n; k++) {
      const side = Math.random() < 0.5 ? -1 : 1, s = speed * (0.4 + Math.random()), out = 0.15 + Math.random() * 0.35;
      addFx(x, y, vx + (-ny * side + nx * out) * s, vy + (nx * side + ny * out) * s, life * (0.5 + Math.random()), size * (0.6 + Math.random() * 0.8), -0.5, col[0] * 3, col[1] * 3, col[2] * 3);
    }
  }
  // a ripple on ship j's shield from (x, y), into the newest of its two hits (the shield shader's); a weaker one than
  // a hit still fresh goes in the older slot instead, so a stream of light shells can't wipe out a heavy hit's ring
  function shieldHit(j, T, x, y, at, strength) {
    const c = Math.cos(SH.ra[j]), s = Math.sin(SH.ra[j]), dx = x - SH.rx[j], dy = y - SH.ry[j], h = (T.extent || T.L * 1.2) / 2;
    const lx = (dx * c + dy * s) / h, ly = (-dx * s + dy * c) / h;
    if (strength < HITS.as[j] && at - HITS.at[j] < 0.4) { HITS.bx[j] = lx; HITS.by[j] = ly; HITS.bt[j] = at; HITS.bs[j] = strength; return; }
    HITS.bx[j] = HITS.ax[j]; HITS.by[j] = HITS.ay[j]; HITS.bt[j] = HITS.at[j]; HITS.bs[j] = HITS.as[j];
    HITS.ax[j] = lx; HITS.ay[j] = ly; HITS.at[j] = at; HITS.as[j] = strength;
  }
  const FIRE = [1.0, 0.62, 0.3], HOT = [1.0, 0.75, 0.45];
  // the bursts the core has made since the last frame
  function readBursts() {
    const B = sim.burst, now = sim.tick() * sim.DT;
    if (burstAt > now) burstAt = -1; // a new game, a load or a jump: time went back
    const fresh = [];
    for (let n = 0; n < sim.maxBursts; n++) if (B.kind[n] && B.at[n] > burstAt) fresh.push(n);
    fresh.sort((a, b) => B.at[a] - B.at[b]);
    for (const n of fresh) {
      const x = B.x[n], y = B.y[n], kind = B.kind[n], j = B.ship[n] - 1, size = B.size[n];
      burstAt = Math.max(burstAt, B.at[n]);
      if (now - B.at[n] > 0.5) continue; // too old to show (the page was elsewhere)
      const ok = j >= 0 && j < MAXS, T = ok ? types[SH.kind[j]] : null, vx = ok ? SH.vx[j] : 0, vy = ok ? SH.vy[j] : 0;
      if (ok && HITS.gen[j] !== SH.generation[j]) { HITS.gen[j] = SH.generation[j]; HITS.at[j] = HITS.bt[j] = -99; HITS.glow[j] = 0; }
      if (kind === BURST.air) {
        addFx(x, y, 0, 0, 0.2, size * 0.3, 1.6, 1.0, 0.62, 0.3);
        sparks(x, y, 0, 0, 2, FIRE, 60, 1.0, 0.25);
      } else if ((kind === BURST.shield || kind === BURST.shrug || kind === BURST.splash) && T) {
        // a shield takes it: no fire, its own colour. A ripple from where it met the shield (a splash: from the burst,
        // off the shield), and a full hit's sparks skate off along the surface; a shrugged-off hit only flickers
        const full = kind === BURST.shield, sc = T.br.shCol, cal = Math.min(1, size / 40);
        shieldHit(j, T, x, y, B.at[n], full ? 0.8 + 0.6 * cal : kind === BURST.splash ? 0.35 : 0.18);
        if (full) {
          addFx(x, y, vx, vy, 0.12, size * 0.35, 1.2, 1.2 + sc[0] * 3, 1.2 + sc[1] * 3, 1.2 + sc[2] * 3); // a cold white flash
          skate(x, y, vx, vy, x - SH.rx[j], y - SH.ry[j], 4 + Math.round(8 * cal), sc, 110 + 120 * cal, 0.9 + T.L * 0.008, 0.35);
          FLASH.push([x, y, T.L * 0.8 + 20 + size, 0.22, 0, ...sc.map(v => v * 3)]);
        } else if (kind === BURST.shrug) skate(x, y, vx, vy, x - SH.rx[j], y - SH.ry[j], 1, sc, 80, 0.7, 0.2);
      } else if (kind === BURST.hull) {
        // through to the hull: fire, debris thrown out, and embers left burning on the plating
        const cal = Math.min(1, size / 40), L = T ? T.L : 20;
        addFx(x, y, vx, vy, 0.22, size * 0.55, 1.6, 3.4, 1.7, 0.6);
        sparks(x, y, vx, vy, 8 + Math.round(10 * cal), FIRE, 140, 1.0 + L * 0.008, 0.55);
        sparks(x, y, vx, vy, 2 + Math.round(4 * cal), [0.35, 0.3, 0.27], 45, 1.4 + L * 0.01, 1.4); // debris, dim and slow
        for (let e = 0; e < 2 + Math.round(3 * cal); e++) addFx(x + (Math.random() - 0.5) * 2, y + (Math.random() - 0.5) * 2, vx, vy, 1.4 + Math.random() * 1.2, 0.7 + L * 0.006, 0, 1.6, 0.45, 0.1);
        if (ok) HITS.glow[j] = 1;
        FLASH.push([x, y, 30 + L + size, 0.25, 0, 3, 1.6, 0.7]);
      } else if (kind === BURST.lost) {
        const L = T ? T.L : size, col = T ? T.br.plCol : FIRE;
        addFx(x, y, vx * 0.5, vy * 0.5, 0.6, L * 0.9, 1.6, 6, 4.5, 3);
        addFx(x, y, vx * 0.5, vy * 0.5, 1.4, L * 0.6, 0.9, col[0] * 2, col[1] * 2, col[2] * 2);
        const m = Math.min(220, 40 + L * 2);
        for (let k = 0; k < m; k++) {
          const a = Math.random() * 6.283, sp = (40 + L * 1.5) * Math.pow(Math.random(), 0.6), q = Math.random() < 0.7 ? HOT : col;
          addFx(x + Math.cos(a) * L * 0.2 * Math.random(), y + Math.sin(a) * L * 0.2 * Math.random(), vx * 0.5 + Math.cos(a) * sp, vy * 0.5 + Math.sin(a) * sp, 0.6 + Math.random() * 1.4, L * (0.04 + Math.random() * 0.1), 0.6, q[0] * 4, q[1] * 4, q[2] * 4);
        }
        // shards of the hull in its paint, flung every way, tumbling, fading to nothing
        const paint = T ? T.br.debris : [FIRE], ns = Math.min(480, 80 + Math.round(L * 1.8));
        for (let k = 0; k < ns; k++) {
          const a = Math.random() * 6.283, sp = (30 + L * 1.2) * (0.25 + Math.random() * 1.1), q = paint[(Math.random() * paint.length) | 0];
          addFx(x + Math.cos(a) * L * 0.25 * Math.random(), y + Math.sin(a) * L * 0.25 * Math.random(), vx * 0.5 + Math.cos(a) * sp, vy * 0.5 + Math.sin(a) * sp,
            1.6 + Math.random() * 2.4, L * (0.012 + Math.random() * 0.03), 0, q[0], q[1], q[2], true);
        }
        FLASH.push([x, y, L * 7, 1.1, 0, 9, 6.3, 3.6]);
      }
    }
  }
  function stepFx(dt) {
    for (let k = 0; k < FX.top; k++) {
      if (FX.life[k] <= 0) continue;
      FX.life[k] -= dt;
      const dr = FX.shard[k] ? 1 : Math.max(0, 1 - dt * 0.8); // fire and smoke slow; shards keep going, in vacuum
      FX.vx[k] *= dr; FX.vy[k] *= dr; FX.x[k] += FX.vx[k] * dt; FX.y[k] += FX.vy[k] * dt; FX.size[k] *= 1 + FX.grow[k] * dt;
    }
    for (let i = 0; i < MAXS; i++) HITS.glow[i] = Math.max(0, HITS.glow[i] - dt * 4);
    for (let k = FLASH.length - 1; k >= 0; k--) { FLASH[k][4] += dt; if (FLASH[k][4] >= FLASH[k][3]) FLASH.splice(k, 1); }
  }
  const typeCount = new Int32Array(types.length), typeStart = new Int32Array(types.length), typeFill = new Int32Array(types.length);
  const LP = new Float32Array(64), LC = new Float32Array(64);
  const plCol = new Float32Array(51), plCore = new Float32Array(51), plP = new Float32Array(68), plSpread = new Float32Array(17), plBurn = new Float32Array(51);
  catalog.brands.slice(0, 16).forEach((b, k) => { const br = brandRender(b); plCol.set(br.plCol, k * 3); plCore.set(br.plCore, k * 3); plP.set([br.plTurb, br.plDia, br.plSput, br.plPulse], k * 4); plSpread[k] = br.plSpread; plBurn.set(br.plBurn, k * 3); });
  const RCS = 16; // the last look: cold thruster gas for the side, reverse and turning jets
  const spinVis = new Float32Array(MAXS); // per-slot turning-jet pulse, decaying (visual only)
  const turnSlew = sim.param('turn_slew');
  plCol.set(lin([0.72, 0.78, 0.88]), RCS * 3); plCore.set([1, 1, 1], RCS * 3); plP.set([0.5, 0, 0.25, 0], RCS * 4); plSpread[RCS] = 0.9; plBurn.set(plCol.subarray(RCS * 3, RCS * 3 + 3), RCS * 3);
  let sunCol = lin(star.col); // the light at the camera (sunFrom's colour), for ships; worlds get their own
  // the plume look tables are constant: set once on the program
  gl.useProgram(FP.plume.p);
  { const u = FP.plume.u; gl.uniform3fv(u.uPlCol, plCol); gl.uniform3fv(u.uPlCore, plCore); gl.uniform4fv(u.uPlP, plP); gl.uniform1fv(u.uPlSpread, plSpread); gl.uniform3fv(u.uPlBurn, plBurn); }
  const stInst = new Float32Array(MAX_STATIONS * 6);
  // rocks on screen: drawn as rocks (at most ROCK_DRAW), or under a pixel and a half across as specks of light
  const ROCK_DRAW = 3000, rockKit = makeRockKit(gl, compile, quad, ROCK_DRAW), rockInst = new Float32Array(ROCK_DRAW * ROCK_STRIDE);
  const rockSeen = [], speckInst = new Float32Array(MAX_ROCKS * 8);
  const sunCam = new Float32Array(3), sunAt = new Float32Array(3), colAt = new Float32Array(3); // sunFrom's results, reused
  // the stars' brightness in the game, against the lab's (whose gallery the debug screen keeps): the scene's bloom
  // and tone map run hotter here
  const STAR_GAIN = 0.6, starSky = { star: null, neb: null, sd: [0, 0], off: [0, 0] };
  const nearW = new Int32Array(4); // the star dimming's nearest worlds
  const dimU = new Float32Array(16); // worlds the sky dims its stars round: screen x, y, radius (px)
  let specDeep = 0; // how deep in open space the specks think the ship is, eased (render)
  // lens ghosts per flare: [distance along the flare-to-centre line (1 is the far side), size in px at 900 px tall, tint]
  const GHOSTS = [[-0.35, 9, 0.8], [0.4, 22, 0.2], [0.75, 12, 0.9], [1.25, 38, 0.35]], ghostInst = new Float32Array(2 * 4 * 8);
  // draw order: largest classes first, so small ships sit on top
  const order = Object.keys(types).map(Number).sort((a, b) => types[b].zi - types[a].zi);
  let scale = 1;
  const sheaths = []; // [slot, sequence look] to draw this frame (reused)
  const LAUNCH_S = sim.launchS, DESCENT_S = sim.descentS;
  const TR = sim.traffic;
  // a landing or launch sequence's look at d (0 in flight .. 1 down) over body B: hull scale, plasma heat, fade-out
  // into the atmosphere's tint
  const ATM_NONE = [0.6, 0.7, 0.8];
  let atmOf = new Map(), airOf = new Map(); // body -> its atmosphere's colour and how much air it has (look.air), for the sheath (systemViews)
  function seqLook(d, B) {
    const st = B.kind === 'station', ss = x => x * x * (3 - 2 * x), seg = (a, b, x) => ss(Math.max(0, Math.min(1, (x - a) / (b - a))));
    // the plasma is air burning round the hull: none on an airless world (most moons), faint in thin air, full from 0.3
    const air = Math.min(1, (airOf.get(B) ?? 1) / 0.3);
    return { sc: st ? 1 - 0.45 * seg(0, 1, d) : 1 - 0.85 * seg(0.08, 1, d), heat: st ? 0 : seg(0, 0.2, d) * (1 - seg(0.88, 1, d)) * air, fade: seg(0.5, 0.95, d), atm: atmOf.get(B) || ATM_NONE };
  }
  // ---------- the sequences' path: the curl ----------
  // A landing turns across the planet and spirals out to its horizon (the limb), shrinking into the atmosphere; a
  // launch rises at the horizon and curls back in to the port, accelerating all the way, its last stretch straight
  // along the velocity the core hands back. Only drawn: the ship is out of the flight sim meanwhile, and the path meets the core's pose at both
  // ends (where a landing starts, where a launch ends). Stations: a straight slide into the clamps and back out.
  const angOf = (x, y) => Math.atan2(-x, y), wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
  const smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  // A sequence's path is fixed while it plays (its ends are the core's held pose), so each slot builds its path
  // once and keeps it, as points with arc lengths from the port, until the inputs change: a new sequence.
  const PATH_N = 61, pathX = new Float64Array(MAXS * PATH_N), pathY = new Float64Array(MAXS * PATH_N), pathS = new Float64Array(MAXS * PATH_N);
  const pathN = new Int32Array(MAXS), pathKey = new Float64Array(MAXS * 8).fill(NaN);
  const pathPush = (i, x, y, s) => { const o = i * PATH_N + pathN[i]++; pathX[o] = x; pathY[o] = y; pathS[o] = s; };
  const pathLen = i => pathS[i * PATH_N + pathN[i] - 1];
  // The spiral from (px, py) out to the horizon of body B, leaving the port going round it (dir +1 counter-clockwise,
  // -1 clockwise): its radius eases out from the port's to just inside the limb while it sweeps round; the sweep is
  // sized so the path is about `budget` metres. Written into slot i's path.
  function spiral(i, B, px, py, dir, budget) {
    const dx = px - B.x, dy = py - B.y, d0 = Math.hypot(dx, dy), th0 = Math.atan2(dy, dx), rh = Math.max(d0, B.r * 0.97);
    const dr = rh - d0, rm = Math.max(B.r * 0.3, (d0 + rh) / 2);
    const sweep = Math.max(0.5, Math.min(1.9, Math.sqrt(Math.max(0, budget * budget - dr * dr)) / rm));
    const N = 40;
    let len = 0, lx = 0, ly = 0;
    pathN[i] = 0;
    for (let k = 0; k <= N; k++) {
      const u = k / N, r = d0 + dr * Math.pow(u, 1.6), th = th0 + dir * sweep * u; // r' = 0 at the port: it leaves along the curl
      const x = B.x + Math.cos(th) * r, y = B.y + Math.sin(th) * r;
      if (k) len += Math.hypot(x - lx, y - ly);
      pathPush(i, x, y, len); lx = x; ly = y;
    }
  }
  // The launch's path, built backwards from the hand-off at (px, py) moving along (ux, uy): a straight run-in (the
  // last stretch is already on the course the flight sim carries on along, so nothing swerves when it takes over),
  // and before that the curl: going back, the heading swings by up to `turn` (dir +1: the ship turns
  // counter-clockwise as it comes in), easing in and out, so the path bends out to the horizon. Cut where it first
  // reaches the limb, if it does. Same shape as `spiral`.
  function launchPath(i, B, px, py, ux, uy, dir, budget) {
    const N = PATH_N - 1, ds = budget / N, run = budget * 0.35, turn = 1.4, a0 = Math.atan2(uy, ux), limb = B.r * 0.97;
    pathN[i] = 0; pathPush(i, px, py, 0);
    let x = px, y = py;
    for (let k = 1; k <= N; k++) {
      const sm = (k - 0.5) * ds, a = a0 + dir * turn * smooth((sm - run) / (budget - run));
      x -= Math.cos(a) * ds; y -= Math.sin(a) * ds;
      pathPush(i, x, y, k * ds);
      if (Math.hypot(x - B.x, y - B.y) >= limb && Math.hypot(px - B.x, py - B.y) < limb) break;
    }
  }
  // slot i's path for these inputs, built only if they differ from the last; returns its length
  function pathFor(i, landing, B, x, y, hx, hy, dir, budget) {
    const k = i * 8, bj = BODIES.indexOf(B), key = pathKey;
    if (key[k] !== +landing || key[k + 1] !== bj || key[k + 2] !== x || key[k + 3] !== y || key[k + 4] !== hx || key[k + 5] !== hy || key[k + 6] !== dir || key[k + 7] !== budget) {
      key[k] = +landing; key[k + 1] = bj; key[k + 2] = x; key[k + 3] = y; key[k + 4] = hx; key[k + 5] = hy; key[k + 6] = dir; key[k + 7] = budget;
      if (landing) spiral(i, B, x, y, dir, budget); else launchPath(i, B, x, y, hx, hy, dir, budget);
    }
    return pathLen(i);
  }
  // the point at arc length s from the port on slot i's path, and the outward direction there
  function along(i, s) {
    const o = i * PATH_N, n = pathN[i];
    s = Math.max(0, Math.min(pathLen(i), s));
    let k = 1;
    while (k < n - 1 && pathS[o + k] < s) k++;
    const a = o + k - 1, b = o + k, f = (s - pathS[a]) / Math.max(1e-6, pathS[b] - pathS[a]), ux = pathX[b] - pathX[a], uy = pathY[b] - pathY[a], l = Math.hypot(ux, uy) || 1;
    return { x: pathX[a] + ux * f, y: pathY[a] + uy * f, ux: ux / l, uy: uy / l };
  }
  // The drawn pose at progress p (0..1) of a sequence over body B. (x, y, ang): the core's pose, where a landing
  // starts or a launch ends. dir: which way round the port the path leaves it (+1 counter-clockwise). v: the speed a
  // launch ends at (the core hands it back), or a landing starts at. Speeds are kept honest: a launch accelerates
  // from the horizon (s = len p^n, so it ends at n len / T = v), and a path too long for that is trimmed.
  function seqPose(i, landing, p, x, y, ang, dir, v, B, T) {
    if (B.kind === 'station') { // straight in to the clamps, or out of them, easing
      const e = smooth(p), f = landing ? e : 1 - e, dx = x - B.x, dy = y - B.y;
      return { x: B.x + dx * (1 - f), y: B.y + dy * (1 - f), ang: landing || Math.hypot(dx, dy) < 1 ? ang : angOf(dx, dy) };
    }
    const full = Math.max(B.r * 0.6, B.r * 1.3), budget = landing ? full : Math.min(full, Math.max(150, v * T / 1.2));
    const hx = -Math.sin(ang), hy = Math.cos(ang);
    const L = pathFor(i, landing, B, x, y, hx, hy, dir, budget);
    if (landing) {
      // the nose swings onto the path first; it speeds up from rest (or from the speed it came in at) through the
      // middle, then slows as it sinks over the horizon: a cubic with start slope k0 and end slope K1 (in units of
      // the path's mean speed)
      const k0 = Math.min(1, v * T / L), K1 = 0.3, h = (k0 + K1 - 2) * p * p * p + (3 - 2 * k0 - K1) * p * p + k0 * p;
      const q = along(i, L * h);
      const turn = smooth(p / 0.25), a1 = angOf(q.ux, q.uy);
      return { x: q.x, y: q.y, ang: ang + wrapA(a1 - ang) * turn };
    }
    // accelerating in from the horizon (s = L p^n back from the port, so it arrives at n L / T = v), nose first
    const n = Math.max(1.2, Math.min(4, v * T / L)), s = L * (1 - Math.pow(p, n)), q = along(i, s);
    return { x: q.x, y: q.y, ang: s < 1 ? ang : angOf(-q.ux, -q.uy) };
  }
  // A sequence's progress, 0..1, from its timer in the core, interpolated between ticks like every other drawn pose:
  // the timer moves in 60 Hz steps, and at launch speeds a step is metres, which a faster display shows as a doubled,
  // flickering ship.
  const seqProgress = (timer, T) => Math.max(0, Math.min(1, 1 - (timer - sim.alpha() * sim.DT) / T));
  // which way round body B a ship at (x, y) heading (hx, hy) is going: +1 counter-clockwise
  const roundDir = (B, x, y, hx, hy) => (x - B.x) * hy - (y - B.y) * hx >= 0 ? 1 : -1;
  // the player's sequence pose now (the core's game state; a launch ends on the velocity the core wrote when it began)
  function playerSeq() {
    const mode = sim.mode(), landing = mode === MODE.descending, B = BODIES[sim.game.at[0]];
    // (at a moving station the ship rides along with it, so its pose is interpolated like the station's)
    const T = landing ? DESCENT_S : LAUNCH_S, p = seqProgress(sim.game.timer[0], T), mv = !!B.motion, x = mv ? SH.rx[0] : SH.x[0], y = mv ? SH.ry[0] : SH.y[0];
    const dir = sim.game.curl[0] ? -1 : 1, G0 = sim.game;
    const tx = G0.hand_x[0], ty = G0.hand_y[0], v = landing ? 0 : G0.hand_v[0]; // the launch's heading and speed
    const pose = seqPose(0, landing, p, x, y, landing ? SH.ang[0] : angOf(tx, ty), dir, v, B, T);
    // its drawn velocity, for the camera's lead (as in flight, so the hand-off does not jolt the view)
    const dp = 0.004, ahead = seqPose(0, landing, Math.min(1, p + dp), x, y, landing ? SH.ang[0] : angOf(tx, ty), dir, v, B, T);
    const live = Math.min(1, p + dp) - p;
    pose.vx = live > 0 ? (ahead.x - pose.x) / (live * T) : (landing ? 0 : v * tx);
    pose.vy = live > 0 ? (ahead.y - pose.y) / (live * T) : (landing ? 0 : v * ty);
    return { p, B, landing, pose };
  }
  // a traffic ship's: it lands the way it was flying, and launches into its route at cruise
  function npcPose(i) {
    const landing = TR.phase[i] === TRAFFIC.land, B = BODIES[landing ? TR.to[i] : TR.from[i]], T = landing ? DESCENT_S : LAUNCH_S;
    const p = seqProgress(TR.timer[i], T), hx = -Math.sin(SH.ang[i]), hy = Math.cos(SH.ang[i]);
    const x = B.motion ? SH.rx[i] : SH.x[i], y = B.motion ? SH.ry[i] : SH.y[i];
    return { p, B, landing, pose: seqPose(i, landing, p, x, y, SH.ang[i], roundDir(B, x, y, hx, hy), landing ? 0 : TR.cruise[i], B, T) };
  }
  // the view's scale glides between flight, a sequence (pulled back a little) and the port's vista, rather than
  // jumping
  let viewScale = 0, frameDt = 1 / 60;
  function shipUniforms(u, sun, t) {
    gl.uniform3fv(u.uSun, sun); gl.uniform3fv(u.uSunCol, sunCol); gl.uniform3fv(u.uAmb, star.amb);
    gl.uniform1f(u.uTime, t); gl.uniform1i(u.uMode, 0); gl.uniform1f(u.uShadow, 1);
    gl.uniform1i(u.uA, 0); gl.uniform1i(u.uN, 1); gl.uniform1i(u.uE, 2); gl.uniform1i(u.uX, 3);
  }
  function bindLook(u, s, half, brand) {
    const m = brand.style.material, mp = s.maps;
    gl.uniform1f(u.uHalfM, half); gl.uniform1f(u.uExtent, mp.extent); gl.uniform1f(u.uHRange, mp.hRange);
    gl.uniform1f(u.uDmax, mp.Dmax); gl.uniform1f(u.uS, mp.shieldS);
    gl.uniform1f(u.uGloss, m.gloss); gl.uniform1f(u.uSpecK, 0.6 + m.spec * 1.4); gl.uniform1f(u.uWrap, m.wrap); gl.uniform1f(u.uIrid, m.irid); gl.uniform1f(u.uRim, m.rim);
    for (let q = 0; q < 4; q++) { gl.activeTexture(gl.TEXTURE0 + q); gl.bindTexture(gl.TEXTURE_2D, s.tex[q]); }
  }
  // traffic ship i's landing or launch look and pose, or null when it is flying
  function npcSeq(i) {
    const ph = TR.phase[i];
    if (!TR.role[i] || (ph !== TRAFFIC.launch && ph !== TRAFFIC.land)) return null;
    const q = npcPose(i);
    return Object.assign(seqLook(q.landing ? q.p : 1 - q.p, q.B), q.pose);
  }
  // whether ship i is drawable and within (hw, hh) of (cx, cy)
  function shown(i, cx, cy, hw, hh) {
    if (!SH.alive[i]) return false;
    const T = types[SH.kind[i]];
    if (!typeReady(T)) return false;
    const m = T.half * 1.2 + T.L * 2;
    return Math.abs(SH.rx[i] - cx) < hw + m && Math.abs(SH.ry[i] - cy) < hh + m;
  }
  // a thruster jet of ship i (type T, heading c, s) at hull point (lx, ly), pointing (dx, dy), strength k
  function jet(nPl, i, T, c, s, lx, ly, dx, dy, k) {
    if (nPl >= MAXS * 12) return nPl;
    const o = nPl * 10;
    plumeInst[o] = SH.rx[i] + c * lx - s * ly; plumeInst[o + 1] = SH.ry[i] + s * lx + c * ly;
    plumeInst[o + 2] = c * dx - s * dy; plumeInst[o + 3] = s * dx + c * dy;
    plumeInst[o + 4] = T.L * (0.08 + 0.22 * k); plumeInst[o + 5] = T.L * 0.05; plumeInst[o + 6] = i * 3.1 + lx; plumeInst[o + 7] = 0.35 + 0.9 * k;
    plumeInst[o + 8] = RCS; plumeInst[o + 9] = 0;
    return nPl + 1;
  }
  // GL draws in scene-target pixels: the canvas's at renderScale (sceneScale is scale at that resolution); the HUD,
  // culling and world sizes stay in canvas terms (scale)
  let sceneScale = 1;
  // shields struck lately, then shells as tracers, then fire and sparks: added light over the hulls
  function drawCombat(t, cx, cy, TW, TH, halfW, halfH, live) {
    const now = sim.tick() * sim.DT;
    gl.blendFunc(gl.ONE, gl.ONE);
    shieldCount.fill(0);
    const struck = i => SH.alive[i] && HITS.gen[i] === SH.generation[i] && now - HITS.at[i] < HIT_LIFE && shown(i, cx, cy, halfW, halfH) && types[SH.kind[i]].s;
    for (let i = 0; i < live; i++) if (struck(i)) shieldCount[SH.kind[i]]++;
    let accS = 0;
    for (const k of order) { shieldStart[k] = accS; accS += shieldCount[k]; shieldFill[k] = shieldStart[k]; }
    for (let i = 0; i < live; i++) {
      if (!struck(i)) continue;
      const q = shieldFill[SH.kind[i]]++ * 12, a1 = now - HITS.at[i], a2 = now - HITS.bt[i];
      shieldInst.set([SH.rx[i], SH.ry[i], SH.ra[i], 0, HITS.ax[i], HITS.ay[i], a1 < HIT_LIFE ? a1 : -1, HITS.as[i], HITS.bx[i], HITS.by[i], a2 < HIT_LIFE ? a2 : -1, HITS.bs[i]], q);
    }
    if (accS) {
      setView(FP.shield, TW, TH, cx, cy);
      const u = FP.shield.u; gl.uniform1f(u.uTime, t); gl.uniform1i(u.uX, 0);
      gl.bindVertexArray(VS.shield.vao); upload(VS.shield, shieldInst, accS);
      for (const k of order) {
        if (!shieldCount[k]) continue;
        const T = types[k];
        gl.uniform1f(u.uHalfM, T.half); gl.uniform1f(u.uExtent, T.extent); gl.uniform1f(u.uS, T.S); gl.uniform1f(u.uDmax, T.Dmax);
        gl.uniform1f(u.uStrength, T.br.shStr); gl.uniform3fv(u.uCol, T.br.shCol); gl.uniform1i(u.uPat, T.br.shPat);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.s.tex[3]);
        pointAt(VS.shield, shieldStart[k]);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, shieldCount[k]);
      }
      gl.bindVertexArray(null);
    }
    // tracers: the shell's head where the core puts it, its tail a few metres back along its path
    const S = sim.shell;
    let nb = 0;
    for (let n = 0; n < MAXSH; n++) {
      if (!S.live[n] || Math.abs(S.rx[n] - cx) > halfW + 60 || Math.abs(S.ry[n] - cy) > halfH + 60) continue;
      const z = Math.max(0, Math.min(2, S.gun[n] - 1)), o = nb++ * 8, vx = S.vx[n], vy = S.vy[n], v = Math.hypot(vx, vy) || 1, len = TRACER_LEN[z], c = TRACER_COL[z];
      boltInst[o] = S.rx[n] - vx / v * len * 0.5; boltInst[o + 1] = S.ry[n] - vy / v * len * 0.5; boltInst[o + 2] = vx; boltInst[o + 3] = vy;
      boltInst[o + 4] = c[0]; boltInst[o + 5] = c[1]; boltInst[o + 6] = c[2]; boltInst[o + 7] = len;
    }
    if (nb) { setView(FP.bolt, TW, TH, cx, cy); gl.bindVertexArray(VS.bolt.vao); upload(VS.bolt, boltInst, nb); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nb); gl.bindVertexArray(null); }
    let np = 0;
    for (let k = 0; k < FX.top; k++) {
      if (FX.life[k] <= 0) continue;
      if (Math.abs(FX.x[k] - cx) > halfW + FX.size[k] || Math.abs(FX.y[k] - cy) > halfH + FX.size[k]) continue;
      const o = np++ * 8, f = FX.life[k] / FX.max[k];
      partInst[o] = FX.x[k]; partInst[o + 1] = FX.y[k]; partInst[o + 2] = FX.size[k]; partInst[o + 3] = f * f;
      partInst[o + 4] = FX.r[k]; partInst[o + 5] = FX.g[k]; partInst[o + 6] = FX.b[k]; partInst[o + 7] = FX.shard[k];
    }
    if (np) { setView(FP.part, TW, TH, cx, cy); gl.bindVertexArray(VS.part.vao); upload(VS.part, partInst, np); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, np); gl.bindVertexArray(null); }
  }
  function setView(prog, RW, RH, cx, cy) { gl.useProgram(prog.p); gl.uniform2f(prog.u.uRes, RW, RH); gl.uniform2f(prog.u.uCam, cx, cy); gl.uniform1f(prog.u.uScale, sceneScale); }
  function render(t, cx, cy) {
    const RW = canvas.width, RH = canvas.height, T0 = types[SH.kind[0]], live = Math.min(MAXS, sim.count());
    const mode = sim.mode();
    let want = RW / (Math.max(700, T0.L * 16) / zoom);
    if (mode === MODE.landed) { // the port screen's vista: the body you are on, filling the view
      const B = BODIES[sim.game.at[0]];
      want = Math.min(RW, RH) * (B.kind === 'station' ? 0.75 : 0.95) / (2 * B.r * (B.kind === 'station' ? 1.6 : 1));
    } else if ((mode === MODE.descending || mode === MODE.launching) && BODIES[sim.game.at[0]].kind !== 'station') {
      want *= 0.6; // pulled back a little: the camera follows the ship round its curl, so it must stay big enough to see
    }
    viewScale = viewScale > 0 ? Math.exp(Math.log(viewScale) + (Math.log(want) - Math.log(viewScale)) * (1 - Math.exp(-frameDt * 2.5))) : want;
    scale = viewScale;
    sunFrom(cx, cy, sunCam, sunCol); const sl = Math.hypot(sunCam[0], sunCam[1]) || 1;
    const halfW = RW / scale / 2, halfH = RH / scale / 2;
    const TW = G.targets.scene.w, TH = G.targets.scene.h, ss = sceneScale = scale * TW / RW; // the scene target, and px per m in it
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, G.targets.scene.f); gl.viewport(0, 0, TW, TH);
    gl.disable(gl.BLEND);
    gl.useProgram(P.bg.p);
    gl.uniform2f(P.bg.u.uRes, TW, TH); gl.uniform1f(P.bg.u.uTime, t);
    gl.uniform3fv(P.bg.u.uStar, star.col); gl.uniform3fv(P.bg.u.uNeb, star.neb);
    gl.uniform2f(P.bg.u.uSunDir, sunCam[0] / sl, sunCam[1] / sl);
    gl.uniform2f(P.bg.u.uOff, cx * ss * 0.04, cy * ss * 0.04); gl.uniform1f(P.bg.u.uRS, renderScale); starSky.rs = renderScale;
    // specks streaming past (BG_FS): their layers' offsets wrapped to whole periods of their grids (the shader hashes
    // cells modulo the period, so the wrap is seamless), and a streak back along the ship's motion, longer with speed
    // and longer still, brighter and thicker in deep space, where open space has raised the top speed
    { const flying = sim.mode() === MODE.flying && !jumping(), wrap = (v, cs) => { const P = cs * 1024; return ((v % P) + P) % P; };
      gl.uniform2f(P.bg.u.uSp0, wrap(cx * ss * 0.45, 170), wrap(cy * ss * 0.45, 170)); gl.uniform2f(P.bg.u.uSp1, wrap(cx * ss, 260), wrap(cy * ss, 260));
      const k = SH.kind[0], top0 = flying ? sim.topSpeed(k, SH.x[0], SH.y[0]) : 0, vm = sim.type.vmax[k] || 1;
      const deep = flying ? Math.max(0, Math.min(1, (top0 / vm - 1) / Math.max(0.01, sim.param('cruise_max') - 1))) : 0;
      specDeep += (deep - specDeep) * (1 - Math.exp(-frameDt * 1.5)); // eased, so the field thickens as you go
      const blur = 0.05 * (1 + 2.5 * specDeep), vx = flying ? SH.vx[0] : 0, vy = flying ? SH.vy[0] : 0;
      let sx = -vx * ss * blur, sy = -vy * ss * blur; const sl = Math.hypot(sx, sy), cap = 150 * renderScale;
      if (sl > cap) { sx *= cap / sl; sy *= cap / sl; }
      gl.uniform2f(P.bg.u.uStreak, sx, sy); gl.uniform1f(P.bg.u.uDeep, specDeep); // zoomed out (the view wider than its usual span for the hull), fewer and fainter: each cell covers more space
      const zk = Math.max(0, Math.min(1, scale * Math.max(700, T0.L * 16) / RW));
      gl.uniform1f(P.bg.u.uSpeckK, (0.45 + 0.3 * specDeep) * (0.35 + 0.65 * zk)); gl.uniform1f(P.bg.u.uSpeckN, zk * zk); }
    // dim the stars round the (up to four) nearest worlds whose debris could be on screen
    { let nd = 0; dimU.fill(0);
      const rank = p => Math.hypot(p.x - cx, p.y - cy) / p.r;
      for (let w = 0; w < WORLDS.length; w++) { // insertion into the nearest four, by distance in radii
        const p = WORLDS[w];
        if (Math.abs(p.x - cx) >= halfW + p.r * 2.6 || Math.abs(p.y - cy) >= halfH + p.r * 2.6) continue;
        let k = Math.min(nd, 3);
        if (nd === 4 && rank(p) >= rank(WORLDS[nearW[3]])) continue;
        while (k > 0 && rank(WORLDS[nearW[k - 1]]) > rank(p)) { nearW[k] = nearW[k - 1]; k--; }
        nearW[k] = w; if (nd < 4) nd++;
      }
      for (let k = 0; k < nd; k++) { const p = WORLDS[nearW[k]]; dimU[k * 4] = (p.x - cx) * ss + TW / 2; dimU[k * 4 + 1] = (p.y - cy) * ss + TH / 2; dimU[k * 4 + 2] = p.r * ss; }
      gl.uniform4fv(P.bg.u.uDim, dimU); gl.uniform1i(P.bg.u.uDimN, nd); }
    draw();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // the stars (a binary's two), by the star kit (src/stars.js); a black hole lenses the same sky as the background
    starSky.star = star.col; starSky.neb = star.neb; starSky.sd[0] = sunCam[0] / sl; starSky.sd[1] = sunCam[1] / sl; starSky.off[0] = cx * ss * 0.04; starSky.off[1] = cy * ss * 0.04;
    for (const S of SUNS) {
      const f = S.frame || (S.frame = starFrame(S.star, S.r, S.hazard)), reach = S.r * f.ext;
      if (Math.abs(S.x - cx) > halfW + reach || Math.abs(S.y - cy) > halfH + reach) continue;
      starKit.star(S.star, { res: [TW, TH], cx: (S.x - cx) * ss + TW / 2, cy: (S.y - cy) * ss + TH / 2, rpx: S.r * ss, glowR: f.glowR, ext: f.ext, t, gain: STAR_GAIN, sky: starSky });
    }
    // planets and moons, each lit from the star's direction
    setView(FP.planet, TW, TH, cx, cy);
    { const u = FP.planet.u;
      gl.uniform3fv(u.uAmb, star.amb); gl.uniform1f(u.uTime, t);
      for (const p of WORLDS) {
        if (Math.abs(p.x - cx) > halfW + p.r * p.ext || Math.abs(p.y - cy) > halfH + p.r * p.ext) continue;
        gl.uniform3fv(u.uSun, sunFrom(p.x, p.y, sunAt, colAt)); gl.uniform3fv(u.uSunCol, colAt);
        gl.uniform2f(u.uC, p.x, p.y); gl.uniform1f(u.uR, p.r); gl.uniform1f(u.uPx, 1 / (p.r * ss)); // detail follows the scene's pixels
        bindPlanet(gl, u, p.pu); planetClock(gl, u, t, p.pu.seed);
        draw();
      } }
    // belts' and fields' rocks near the view: each rock sphere-traced, small ones as specks (the orbiters' debris look)
    if (ROCKS.length) {
      const mx = halfW + rockReach, my = halfH + rockReach, minPx = 1.5 / ss;
      let nr = 0, ns = 0; rockSeen.length = 0;
      for (let gx = Math.floor((cx - mx) / ROCK_CELL), gx1 = Math.floor((cx + mx) / ROCK_CELL); gx <= gx1; gx++) {
        for (let gy = Math.floor((cy - my) / ROCK_CELL), gy1 = Math.floor((cy + my) / ROCK_CELL); gy <= gy1; gy++) {
          const cell = rockGrid.get(gx + ',' + gy);
          if (cell) for (const i of cell) { const o = ROCKS[i]; if (Math.abs(o.x - cx) < halfW + o.reach && Math.abs(o.y - cy) < halfH + o.reach) rockSeen.push(i); }
        }
      }
      rockSeen.sort((a, b) => a - b); // by size: big rocks over small
      for (const i of rockSeen) {
        const o = ROCKS[i];
        if (o.reach < minPx) { const k = ns++ * 8; speckInst[k] = o.x; speckInst[k + 1] = o.y; speckInst[k + 2] = o.m; speckInst[k + 3] = 0; speckInst[k + 4] = 0.7; speckInst[k + 5] = 0; speckInst[k + 6] = o.seed; speckInst[k + 7] = 1; }
        else if (nr < ROCK_DRAW) rockKit.pack(rockInst, nr++, o.a, o.x, o.y, o.m);
      }
      if (nr) { const S = sunAtPoint(cx, cy); rockKit.begin({ res: [TW, TH], cam: [cx, cy], scale: ss, time: t, star: [S.x, S.y], sunCol, amb: star.amb }); rockKit.draw(rockInst, nr); }
      if (ns) {
        gl.blendFunc(gl.ONE, gl.ONE);
        setView(FP.orbiter, TW, TH, cx, cy); gl.uniform1f(FP.orbiter.u.uTime, t); gl.uniform3fv(FP.orbiter.u.uSunCol, sunCol);
        gl.bindVertexArray(VS.speck.vao); upload(VS.speck, speckInst, ns); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ns); gl.bindVertexArray(null);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
    }
    // orbiters: the core places them and keeps only what can be seen; then lens ghosts for the brightest flares, along
    // the line from the flare through the middle of the screen
    { const S0 = sunAtPoint(cx, cy), n = sim.orbitEval((sim.tick() + sim.alpha()) * sim.DT, S0.x, S0.y, cx, cy, halfW, halfH, 0.06 / scale);
      if (n) {
        gl.blendFunc(gl.ONE, gl.ONE);
        setView(FP.orbiter, TW, TH, cx, cy);
        const u = FP.orbiter.u, O = sim.orbitOut, px = 1 / scale;
        gl.uniform1f(u.uTime, t); gl.uniform3fv(u.uSunCol, sunCol);
        gl.bindVertexArray(VS.orbiter.vao); upload(VS.orbiter, O, n);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
        let ng = 0, b0 = -1, b1 = -1;
        for (let k = 0; k < n; k++) {
          const g = O[k * 8 + 5];
          if (g < 0.8 || Math.abs(O[k * 8] - cx) > halfW || Math.abs(O[k * 8 + 1] - cy) > halfH) continue;
          if (b0 < 0 || g > O[b0 * 8 + 5]) { b1 = b0; b0 = k; } else if (b1 < 0 || g > O[b1 * 8 + 5]) b1 = k;
        }
        for (let b = 0; b < 2; b++) {
          const k = b ? b1 : b0;
          if (k < 0) continue;
          const fx = O[k * 8], fy = O[k * 8 + 1], g = Math.min(O[k * 8 + 5], 6) / 6;
          for (const [f, sz, tint] of GHOSTS) {
            const o = ng++ * 8;
            ghostInst[o] = cx + (cx - fx) * f; ghostInst[o + 1] = cy + (cy - fy) * f; ghostInst[o + 2] = sz * px * RH / 900; ghostInst[o + 3] = 2;
            ghostInst[o + 4] = g; ghostInst[o + 5] = 0; ghostInst[o + 6] = tint; ghostInst[o + 7] = 0;
          }
        }
        if (ng) { gl.bindVertexArray(VS.ghost.vao); upload(VS.ghost, ghostInst, ng); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ng); }
        gl.bindVertexArray(null);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      } }
    // stations: one upload, then a draw each with the ship shader and their own bake
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (let k = 0; k < STATIONS.length; k++) { const S = STATIONS[k], o = k * 6; stInst[o] = S.x; stInst[o + 1] = S.y; stInst[o + 2] = t * S.spin + k * 1.7; stInst[o + 3] = 0; stInst[o + 4] = 0; stInst[o + 5] = S.scale; }
    let stUp = false;
    for (let k = 0; k < STATIONS.length; k++) {
      const S = STATIONS[k];
      if (!stationReady(S) || Math.abs(S.x - cx) > halfW + S.half * S.scale || Math.abs(S.y - cy) > halfH + S.half * S.scale) continue;
      const u = FP.ship.u;
      if (!stUp) { setView(FP.ship, TW, TH, cx, cy); gl.bindVertexArray(VS.station.vao); upload(VS.station, stInst, STATIONS.length); gl.uniform1i(u.uLN, 0); stUp = true; }
      shipUniforms(u, sunFrom(S.x, S.y, sunAt), t);
      bindLook(u, S.s, S.half, S.brand);
      pointAt(VS.station, k);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
    }
    if (stUp) gl.bindVertexArray(null);

    // Landing and launch sequences, the player's and the traffic's: d runs 0 in flight .. 1 down. The player's ship
    // is out of the flight sim meanwhile (drawn from the game state); a traffic ship stays in its slot, held by the
    // core. Each shrinks into the surface inside a plasma sheath (docking at a station: a short shrink, no plasma).
    sheaths.length = 0;
    let pseq = null;
    if ((mode === MODE.descending || mode === MODE.launching) && typeReady(T0)) {
      const q = playerSeq();
      pseq = Object.assign(seqLook(q.landing ? q.p : 1 - q.p, q.B), q.pose);
    }
    typeCount.fill(0);
    let nL = 0, nPl = 0;
    readBursts(); stepFx(Math.min(0.1, frameDt));
    // a burst lights the hulls round it, briefly
    for (const f of FLASH) {
      if (nL >= 12) break;
      const o = nL++ * 4, k = Math.pow(1 - f[4] / f[3], 2);
      LP[o] = f[0]; LP[o + 1] = f[1]; LP[o + 2] = 6; LP[o + 3] = f[2];
      LC[o] = f[5] * k; LC[o + 1] = f[6] * k; LC[o + 2] = f[7] * k; LC[o + 3] = 0;
    }
    // the torch: the player's plume grows long as the drive takes it toward jump speed
    const torch = jumpPhase() === JUMP.torch ? 2 + 4 * Math.min(1, Math.hypot(SH.vx[0], SH.vy[0]) / (sim.param('jump_speed') * sim.type.vmax[SH.kind[0]])) : 0;
    for (let i = 0; i < live; i++) {
      if (!shown(i, cx, cy, halfW, halfH)) continue;
      const T = types[SH.kind[i]], c = Math.cos(SH.ra[i]), s = Math.sin(SH.ra[i]), th = SH.thr[i];
      typeCount[SH.kind[i]]++;
      // burner intensity follows the engine glow, which ramps toward 1 only on the burner (cruise tops out at .72),
      // so the tint, length and brightness flare in and fade out over a few frames instead of snapping
      const bi = Math.max(0, Math.min(1, (th - 0.72) / 0.28)), pw = plumePower(th) * 1.35 * (1 + 0.35 * bi);
      if (th >= 0.05 && nL < 16) { // engine light on the hull
        const ex = T.engX, ey = T.engY - T.L * 0.12, k = pw * 1.5;
        const o = nL++ * 4;
        LP[o] = SH.rx[i] + c * ex - s * ey; LP[o + 1] = SH.ry[i] + s * ex + c * ey; LP[o + 2] = T.L * 0.05 + 1.5; LP[o + 3] = T.L * 1.6 + 8;
        LC[o] = T.br.plCol[0] * k; LC[o + 1] = T.br.plCol[1] * k; LC[o + 2] = T.br.plCol[2] * k; LC[o + 3] = 0;
      }
      // thruster jets: side jets fire away from the push (lateral thrust +x pushes right), reverse jets out of the nose
      const lat = SH.lat[i], rev = -Math.min(0, SH.main[i]);
      const A = T.rcs || (T.rcs0 ||= { fl: [-T.half * 0.3, T.half * 0.28], fr: [T.half * 0.3, T.half * 0.28], rl: [-T.half * 0.3, -T.half * 0.24], rr: [T.half * 0.3, -T.half * 0.24], nl: [-T.half * 0.12, T.half * 0.42], nr: [T.half * 0.12, T.half * 0.42] });
      // turning: diagonal pairs (front-right with rear-left turns left, the other pair right). The torque is what the
      // core's steer stage applies this tick: the turn command itself in full off, else the step toward the target
      // rate. Pulses linger a few frames, and a faint trim shows while the ship is turning, so a turn reads clearly.
      const turnT = T.turn, step = turnT * turnSlew * sim.DT;
      const torque = SH.rot[i] ? SH.turn_in[i] : Math.max(-1, Math.min(1, (SH.turn_in[i] * turnT - SH.av[i]) / step));
      spinVis[i] = Math.abs(torque) >= Math.abs(spinVis[i]) * 0.86 ? torque : spinVis[i] * 0.86;
      const spin = Math.max(-1, Math.min(1, spinVis[i] + 0.25 * SH.av[i] / turnT)), ks = Math.abs(spin);
      if (ks > 0.06) {
        // turning left (counter-clockwise): front-right and rear-left fire outward; turning right, the other pair
        if (spin > 0) { nPl = jet(nPl, i, T, c, s, A.fr[0], A.fr[1], 1, 0, ks); nPl = jet(nPl, i, T, c, s, A.rl[0], A.rl[1], -1, 0, ks); }
        else { nPl = jet(nPl, i, T, c, s, A.fl[0], A.fl[1], -1, 0, ks); nPl = jet(nPl, i, T, c, s, A.rr[0], A.rr[1], 1, 0, ks); }
      }
      // strafing right (+x) fires the left flank outward, front and rear; strafing left, the right flank
      if (Math.abs(lat) > 0.05) {
        const k = Math.abs(lat);
        if (lat > 0) { nPl = jet(nPl, i, T, c, s, A.fl[0], A.fl[1], -1, 0, k); nPl = jet(nPl, i, T, c, s, A.rl[0], A.rl[1], -1, 0, k); }
        else { nPl = jet(nPl, i, T, c, s, A.fr[0], A.fr[1], 1, 0, k); nPl = jet(nPl, i, T, c, s, A.rr[0], A.rr[1], 1, 0, k); }
      }
      if (rev > 0.05) { nPl = jet(nPl, i, T, c, s, A.nl[0], A.nl[1], 0, 1, rev); nPl = jet(nPl, i, T, c, s, A.nr[0], A.nr[1], 0, 1, rev); }
      if (th < 0.03) continue;
      for (let e = 0; e < T.eng.length && nPl < MAXS * 12; e++) {
        const E = T.eng[e], o = nPl * 10;
        plumeInst[o] = SH.rx[i] + c * E.lx - s * E.ly; plumeInst[o + 1] = SH.ry[i] + s * E.lx + c * E.ly;
        plumeInst[o + 2] = c * E.dx - s * E.dy; plumeInst[o + 3] = s * E.dx + c * E.dy;
        // (a departing traffic ship's torch the same way, by how near jump speed it is)
        const tk = i === 0 && torch ? torch : sim.traffic.role[i] && sim.traffic.phase[i] === TRAFFIC.torch ? 2 + 4 * Math.min(1, Math.hypot(SH.vx[i], SH.vy[i]) / (sim.param('jump_speed') * sim.type.vmax[SH.kind[i]])) : 1;
        plumeInst[o + 4] = E.w * T.br.plLen * (0.5 + 2.6 * th) * (1 + 1.2 * bi) * tk; plumeInst[o + 5] = E.w * T.br.plWid * 1.35 * (1 + 0.3 * bi) * Math.sqrt(tk);
        plumeInst[o + 6] = i * 7.3 + e * 1.37; plumeInst[o + 7] = pw; plumeInst[o + 8] = T.bi; plumeInst[o + 9] = bi;
        nPl++;
      }
    }
    if (nPl) {
      gl.blendFunc(gl.ONE, gl.ONE);
      setView(FP.plume, TW, TH, cx, cy);
      const u = FP.plume.u; gl.uniform1f(u.uTime, t);
      gl.bindVertexArray(VS.plume.vao); upload(VS.plume, plumeInst, nPl);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nPl);
      gl.bindVertexArray(null);
    }
    // hulls, bucketed by type (the player's sequence, if any, in its type's bucket)
    if (pseq) typeCount[SH.kind[0]]++;
    let acc = 0;
    for (const k of order) { typeStart[k] = acc; acc += typeCount[k]; typeFill[k] = typeStart[k]; }
    for (let i = 0; i < live; i++) {
      if (!shown(i, cx, cy, halfW, halfH)) continue;
      const o = typeFill[SH.kind[i]]++ * 6, q = npcSeq(i);
      shipInst[o] = q ? q.x : SH.rx[i]; shipInst[o + 1] = q ? q.y : SH.ry[i]; shipInst[o + 2] = q ? q.ang : SH.ra[i];
      shipInst[o + 3] = SH.thr[i]; shipInst[o + 4] = HITS.gen[i] === SH.generation[i] ? HITS.glow[i] : 0; shipInst[o + 5] = q ? q.sc : 0;
      if (q && q.heat > 0.01) sheaths.push([i, q]);
    }
    if (pseq) {
      const o = typeFill[SH.kind[0]]++ * 6;
      shipInst[o] = pseq.x; shipInst[o + 1] = pseq.y; shipInst[o + 2] = pseq.ang; shipInst[o + 3] = 0; shipInst[o + 4] = 0; shipInst[o + 5] = pseq.sc;
      if (pseq.heat > 0.01) sheaths.push([0, pseq]);
    }
    if (acc) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      setView(FP.ship, TW, TH, cx, cy);
      const u = FP.ship.u;
      shipUniforms(u, sunCam, t);
      gl.uniform4fv(u.uLP, LP); gl.uniform4fv(u.uLC, LC); gl.uniform1i(u.uLN, nL);
      gl.bindVertexArray(VS.ship.vao); upload(VS.ship, shipInst, acc);
      for (const k of order) {
        if (!typeCount[k]) continue;
        const T = types[k], m = T.brand.style.material;
        gl.uniform1f(u.uHalfM, T.half); gl.uniform1f(u.uExtent, T.extent); gl.uniform1f(u.uHRange, T.s.maps.hRange);
        gl.uniform1f(u.uDmax, T.Dmax); gl.uniform1f(u.uS, T.S);
        gl.uniform1f(u.uGloss, m.gloss); gl.uniform1f(u.uSpecK, 0.6 + m.spec * 1.4); gl.uniform1f(u.uWrap, m.wrap); gl.uniform1f(u.uIrid, m.irid); gl.uniform1f(u.uRim, m.rim);
        for (let q = 0; q < 4; q++) { gl.activeTexture(gl.TEXTURE0 + q); gl.bindTexture(gl.TEXTURE_2D, T.s.tex[q]); }
        pointAt(VS.ship, typeStart[k]);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, typeCount[k]);
      }
      gl.bindVertexArray(null);
    }
    drawCombat(t, cx, cy, TW, TH, halfW, halfH, live);
    if (sheaths.length) {
      gl.blendFunc(gl.ONE, gl.ONE);
      setView(FP.sheath, TW, TH, cx, cy);
      const u = FP.sheath.u;
      gl.uniform1f(u.uTime, t); gl.uniform1i(u.uX, 0); gl.activeTexture(gl.TEXTURE0);
      for (const [i, q] of sheaths) {
        const T = types[SH.kind[i]], m = T.s.maps;
        gl.uniform2f(u.uC, q.x, q.y); gl.uniform1f(u.uHalfM, T.half); gl.uniform1f(u.uPad, 1.15); gl.uniform1f(u.uAng, q.ang); gl.uniform1f(u.uSc, q.sc);
        gl.uniform1f(u.uS, m.shieldS); gl.uniform1f(u.uDmax, m.Dmax); gl.uniform1f(u.uHeat, q.heat); gl.uniform1f(u.uFade, q.fade);
        gl.uniform3fv(u.uAtm, q.atm);
        gl.bindTexture(gl.TEXTURE_2D, T.s.tex[3]);
        draw();
      }
    }
    gl.disable(gl.BLEND);
    G.postProcess(bloomOn ? 0.9 : 0, nanView);
  }

  // ---------- HUD ----------
  // The Book's flight HUD: day, credits and status top-left; radar top-right with the location list under it;
  // the nav target bottom-right; the message log bottom-left; prompts bottom centre. Ship status is speed, fuel, shield,
  // hull, heat and charge (and radiation, in a hazard zone).
  let hudBoxH = 0; // the status box's height (top left): the edge markers keep below it
  const keysEl = document.querySelector('.strip .keys');
  function drawHUD() {
    hx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hx.clearRect(0, 0, W, H);
    const mode = sim.mode();
    $('loc').hidden = mode !== MODE.flying || mapOn || titleUp();
    const kh = mode !== MODE.flying || titleUp(); if (keysEl.hidden !== kh) keysEl.hidden = kh; // the strip's flight keys, in flight
    if ((mode !== MODE.flying || titleUp()) && mapOn) toggleMap(false);
    if (mode === MODE.landed || titleUp()) return; // the port screen is the HUD; the title has none
    if (mode !== MODE.flying) { // in a landing or launch sequence: the day and how to skip it
      hx.font = '600 12px "IBM Plex Mono", ui-monospace, monospace'; hx.textBaseline = 'middle'; hx.textAlign = 'center';
      hx.fillStyle = '#dbe0e7'; // (set here: the HUD's last colour is whatever drew before, often the outline's dark)
      const B = BODIES[sim.game.at[0]];
      label(`${mode === MODE.descending ? (B.kind === 'station' ? 'DOCKING AT' : 'LANDING AT') : 'LAUNCHING FROM'} ${B.port.name.toUpperCase()}  ·  ${KB.name('skip').toUpperCase()} TO SKIP`, W / 2, H - stripH - 40);
      hx.textAlign = 'left'; return;
    }
    drawBuoys();
    watchBlinks(); drawFlashes();
    const T0 = types[SH.kind[0]], sp = Math.hypot(SH.vx[0], SH.vy[0]), kms = v => Math.round(v * KM).toLocaleString('en-US').padStart(5);
    const burn = SH.burn[0] && SH.main[0] > 0;
    // top speed along the nose here, by the core's rule: raised pointing into a well, lowered pointing out
    const nx0 = -Math.sin(SH.ang[0]), ny0 = Math.cos(SH.ang[0]), cIn = nx0 * SH.well_x[0] + ny0 * SH.well_y[0];
    const wk = SH.well[0] * T0.well * (sim.param('well_in') * Math.max(cIn, 0) - sim.param('well_out') * Math.max(-cIn, 0));
    const topNow = Math.max(0.15, 1 + wk) * sim.topSpeed(SH.kind[0], SH.x[0], SH.y[0]) * (burn ? sim.param('burn_cap') : 1); // (raised in open space)
    const auto = sim.game.auto[0] - 1;
    // near a moving port the assist holds still relative to it (core/src/motion.rs): speed is shown relative to it
    const fvx = sim.game.fvx[0], fvy = sim.game.fvy[0], rel = Math.hypot(fvx, fvy) > 0.5, spRel = Math.hypot(SH.vx[0] - fvx, SH.vy[0] - fvy);
    // ship status: hull and fuel (core/src/service.rs), and radiation where the ship is
    const hullK = SH.hull[0] / sim.type.hull[SH.kind[0]], fuelT = sim.game.fuel[0], fuelK = fuelT / sim.type.fuel[SH.kind[0]];
    // the hull's wear a second: a hazard zone's radiation, and a flare's above the safe level (core/src/sensors.rs)
    const rad = sim.radiation(SH.x[0], SH.y[0]) + sim.param('rad_hull') * Math.max(0, sim.stellar(SH.x[0], SH.y[0]) - sim.param('rad_safe'));
    const heat = sim.game.heat[0], hot = sim.game.hot[0]; // the burner's heat; at full it locks until half cooled (core/src/service.rs)
    // The status panel (top left, styled as the target panel): the ship's name; day, credits and hold; amount bars, as
    // percentages, two to a row: speed (of the top speed here, the throttle's mark on it) and fuel (the next jump's cost
    // marked on it), shield and hull, heat and charge (the fit's: core/src/fit.rs); the flight mode
    // and where the ship is, in a well (its strength) or in deep space (how far the open-space top speed has risen);
    // then the jump zone, the course, the autopilot and the missions.
    const thr = sim.game.throttle[0], vmax0 = sim.type.vmax[SH.kind[0]], top0 = sim.topSpeed(SH.kind[0], SH.x[0], SH.y[0]);
    const deep = Math.max(0, Math.min(1, (top0 / vmax0 - 1) / Math.max(0.01, sim.param('cruise_max') - 1)));
    // the next jump: the zone the ship is in, else the course's next lane
    const zg = gatesOf(sysRec)[sim.zoneAt(SH.x[0], SH.y[0])], nj = zg || (courseNext() || {}).G, jCost = nj ? sim.laneFuel(SH.kind[0], nj.ly) : 0;
    const fuelCap = sim.type.fuel[SH.kind[0]];
    const ms = activeMissions().map(k => { const left = MS.due[k] - sim.day(); return [`◆ ${missionDest(k).toUpperCase()}  ${MS.tons[k]} t  ${fmtCr(MS.pay[k])} cr  ${daysText(left).toUpperCase()}`, left <= 1 ? NAV_HOT : MIS_COL]; });
    if (sim.game.auto[0]) ms.unshift([`AUTOPILOT → ${autoName().toUpperCase()}`, '#7fd08a']);
    const cl = courseLine(); if (cl) ms.unshift([cl, '#a8f0c4']);
    const jl = jumpLine(); if (jl) ms.unshift(jl.slice(0, 2));
    const guns = sim.arms.guns[0], gunLine = guns ? `  ·  GUNS ${guns} · MAG ${fmt1(sim.arms.ammo[0])} t` : ''; // the multicannons and the magazine's tonnes left
    const modeLine = `${ASSIST[assistMode].hud}${sim.game.cold[0] ? '  ·  COLD' : ''}  ·  ${SH.well[0] > 0.01 ? `WELL ${Math.round(SH.well[0] * 100)}%` : `DEEP SPACE ${Math.round(deep * 100)}%`}${gunLine}`
      + (rad > 0 ? `  ·  RAD −${(rad * 100).toFixed(1)}%/s` : '') + (SETTINGS.debug ? `  ·  ${sim.tick()}  ${fps.toFixed(0)} fps${renderScale < 1 ? ` ${Math.round(renderScale * 100)}%` : ''}` : '');
    const MONO = '500 11.5px "IBM Plex Mono", ui-monospace, monospace', SMALL = '500 10px "IBM Plex Mono", ui-monospace, monospace';
    hx.font = MONO; hx.textBaseline = 'middle'; hx.textAlign = 'left';
    const textW = Math.max(hx.measureText(modeLine).width, ...ms.map(([t]) => hx.measureText(t).width));
    const bx = 10, by = 10, pw = Math.max(318, textW + 22), RH = 17, bars = 3, gapY = ms.length ? 10 : 0;
    const ph = 22 + RH * (2 + bars) + gapY + ms.length * RH + 2;
    hudBoxH = by + ph - 6;
    hx.fillStyle = 'rgba(7,9,12,.72)'; hx.fillRect(bx, by, pw, ph);
    hx.strokeStyle = 'rgba(226,184,102,.55)'; hx.lineWidth = 1; hx.strokeRect(bx + 0.5, by + 0.5, pw - 1, ph - 1);
    const x0 = bx + 10;
    hx.font = SMALL; hx.fillStyle = '#8a95a4'; hx.fillText(T0.name.toUpperCase(), x0, by + 12);
    let y = by + 12 + RH;
    hx.font = MONO; hx.fillStyle = '#dbe0e7'; hx.fillText(`DAY ${sim.day()}  ·  ${fmtCr(sim.credits())} cr  ·  HOLD ${sim.holdUsed()}/${holdCap()} t`, x0, y);
    // an amount bar: a track, its fill (k of it), an optional mark (the throttle, the next jump's fuel); a placeholder is dashed
    const amount = (x, yy, w, k, col, mark, markCol) => {
      hx.fillStyle = 'rgba(219,224,231,.08)'; hx.fillRect(x, yy - 3, w, 6);
      if (k > 0) { hx.fillStyle = col; hx.fillRect(x, yy - 3, w * Math.min(1, k), 6); }
      if (mark !== undefined && mark !== null) { hx.fillStyle = markCol || '#e2b866'; hx.fillRect(Math.round(x + w * Math.max(0, Math.min(1, mark)) - 1), yy - 6, 2, 12); }
    };
    const none = (x, yy, w) => { hx.strokeStyle = 'rgba(138,149,164,.4)'; hx.setLineDash([2, 3]); hx.strokeRect(x + 0.5, yy - 2.5, w - 1, 5); hx.setLineDash([]); };
    const tag = (t, x, yy) => { hx.font = SMALL; hx.fillStyle = '#8a95a4'; hx.fillText(t, x, yy); hx.font = MONO; };
    const val = (t, x, yy, col) => { hx.fillStyle = col || '#dbe0e7'; hx.fillText(t, x, yy); };
    const LW = 40, half = 64, col2 = x0 + 150;
    // speed (its share of the top speed here, the throttle's mark on it) and fuel (the next jump's cost marked on it)
    y += RH;
    const spShown = rel ? spRel : sp, spK = spShown / Math.max(1, topNow), short = nj && fuelT < jCost;
    tag('SPEED', x0, y);
    amount(x0 + LW, y, half, spK, rel ? '#8fd3ff' : wk < -0.03 ? '#e08a4a' : wk > 0.03 ? '#7fd08a' : '#9fb4c8', assist() ? thr : null);
    val(`${Math.round(spK * 100)}%`, x0 + LW + half + 6, y, rel ? '#8fd3ff' : undefined);
    tag('FUEL', col2, y); amount(col2 + 30, y, half, fuelK, short ? '#f08a72' : fuelK < 0.2 ? '#e2b866' : '#c8a27a', nj ? jCost / fuelCap : null, short ? '#f08a72' : '#dbe0e7');
    val(`${Math.round(fuelK * 100)}%`, col2 + 30 + half + 6, y, short ? '#f08a72' : undefined);
    // shield and hull; a shield restarting (collapsed, or dropped to run cold) shows the restart's progress
    y += RH;
    const shCap = sim.fit.t[FIT.banks] * sim.param('bank_pts'), shK = shCap > 0 ? sim.game.shield[0] / shCap : 0, shT = sim.game.shield_t[0];
    tag('SHIELD', x0, y);
    if (!sim.game.fitted[0] || shCap <= 0) { none(x0 + LW, y, half); val('—', x0 + LW + half + 6, y, '#8a95a4'); }
    else if (shT > 0 && sim.game.shield[0] <= 0) { amount(x0 + LW, y, half, 1 - shT / sim.param('shield_restart'), 'rgba(143,211,255,.3)'); val(sim.game.cold[0] ? 'COLD' : 'DOWN', x0 + LW + half + 6, y, '#f08a72'); }
    else { amount(x0 + LW, y, half, shK, shK < 0.3 ? '#f08a72' : '#8fd3ff'); val(`${Math.round(shK * 100)}%`, x0 + LW + half + 6, y, rad > 0 ? '#8fd3ff' : undefined); }
    tag('HULL', col2, y); amount(col2 + 30, y, half, hullK, hullK < 0.3 ? '#f08a72' : hullK < 0.7 ? '#e2b866' : '#7fd08a'); val(`${Math.ceil(hullK * 100)}%`, col2 + 30 + half + 6, y, rad > 0 || hullK < 0.3 ? '#f08a72' : undefined);
    // heat and charge (M2)
    y += RH;
    tag('HEAT', x0, y); amount(x0 + LW, y, half, heat, hot ? '#f08a72' : heat > 0.7 ? '#e8a05a' : '#e2b866');
    val(hot ? 'LOCK' : burn ? 'BURN' : `${Math.round(heat * 100)}%`, x0 + LW + half + 6, y, hot ? '#f08a72' : burn ? '#e2b866' : undefined);
    // charge: the battery; it reads LOW when the helm and drive are browning out (core/src/fit.rs)
    const batCap = sim.fit.t[FIT.battery] * sim.param('battery_mj'), chK = batCap > 0 ? sim.game.energy[0] / batCap : 0, brown = sim.game.fitted[0] && sim.game.drive[0] < 0.999;
    tag('CHG', col2, y);
    if (!sim.game.fitted[0] || batCap <= 0) { none(col2 + 30, y, half); val(brown ? 'LOW' : '—', col2 + 30 + half + 6, y, brown ? '#f08a72' : '#8a95a4'); }
    else { amount(col2 + 30, y, half, chK, brown || chK < 0.2 ? '#f08a72' : chK < 0.5 ? '#e2b866' : '#c9b3f0'); val(brown ? 'LOW' : `${Math.round(chK * 100)}%`, col2 + 30 + half + 6, y, brown ? '#f08a72' : undefined); }
    // the flight mode and where the ship is
    y += RH;
    val(modeLine, x0, y, rad > 0 ? '#f08a72' : assistMode ? '#c8a27a' : '#9fb4c8');
    if (ms.length) { y += gapY; hx.fillStyle = 'rgba(226,184,102,.25)'; hx.fillRect(x0, y + RH / 2 - 4, pw - 20, 1); }
    ms.forEach(([t, c]) => { y += RH; val(t, x0, y, c); });
    if (!typeReady(T0)) { hx.fillStyle = '#e2b866'; hx.fillText('Baking your ship…', x0, by + ph + 14); }
    drawShipMarks(T0);
    drawFlare();
    drawLandingPrompt();
    drawJumpPrompt();
    const navs = navObjects().map(o => Object.assign(o, navInfo(o)));
    drawNav(navs);
    watchShipTarget();
    drawTargetMark();
    drawRadar(navs);
    drawTarget();
    drawLog();
    refreshLocations();
  }

  // Around the player's ship: the velocity vector (amber line and ring, longer with speed), the assist set-speed
  // tick along the nose, and a heading chevron when the hull is too small to read at this zoom.
  function drawShipMarks(T0) {
    const [cx, cy] = toScreen(SH.rx[0], SH.ry[0]), hullPx = T0.half * scale / dpr;
    const r0 = Math.max(18, hullPx * 0.75), sp = Math.hypot(SH.vx[0], SH.vy[0]);
    const top = sim.topSpeed(SH.kind[0], SH.x[0], SH.y[0]), mark = v => 8 + 82 * Math.min(1.2, v / top); // speed to length, against the top speed here
    hx.lineWidth = 1.5;
    if (sp > 1) {
      const len = mark(sp), ux = SH.vx[0] / sp, uy = -SH.vy[0] / sp;
      hx.strokeStyle = 'rgba(226,184,102,.8)';
      hx.beginPath(); hx.moveTo(cx + ux * r0, cy + uy * r0); hx.lineTo(cx + ux * (r0 + len), cy + uy * (r0 + len)); hx.stroke();
      hx.beginPath(); hx.arc(cx + ux * (r0 + len), cy + uy * (r0 + len), 4, 0, 6.283); hx.stroke();
    }
    const nx = -Math.sin(SH.ra[0]), ny = -Math.cos(SH.ra[0]); // nose direction on screen
    if (assist() && sim.playerSet() > 1) {
      const len = mark(sim.playerSet()), qx = cx + nx * (r0 + len), qy = cy + ny * (r0 + len);
      hx.strokeStyle = 'rgba(159,180,200,.75)';
      hx.beginPath(); hx.moveTo(qx - ny * 6, qy + nx * 6); hx.lineTo(qx + ny * 6, qy - nx * 6); hx.stroke();
    }
    if (hullPx < 7) {
      const s = 7, px = -ny, py = nx; // chevron centred on the ship, pointing along the nose
      hx.fillStyle = '#dbe0e7'; hx.strokeStyle = 'rgba(7,9,12,.85)'; hx.lineWidth = 2.5;
      hx.beginPath(); hx.moveTo(cx + nx * s, cy + ny * s);
      hx.lineTo(cx - nx * s * .7 + px * s * .7, cy - ny * s * .7 + py * s * .7); hx.lineTo(cx - nx * s * .3, cy - ny * s * .3);
      hx.lineTo(cx - nx * s * .7 - px * s * .7, cy - ny * s * .7 - py * s * .7); hx.closePath(); hx.stroke(); hx.fill();
    }
  }

  // a stellar flare (core/src/sensors.rs): the warning with its countdown, then whether the ship is sheltered; and the
  // active ping's wavefront going out from the ship
  function drawFlare() {
    const pr = pingRadius();
    if (pr > 0) { const [sx, sy] = toScreen(SH.rx[0], SH.ry[0]); hx.strokeStyle = 'rgba(120,220,255,.5)'; hx.lineWidth = 2; hx.beginPath(); hx.arc(sx, sy, pr * scale / dpr, 0, 6.283); hx.stroke(); }
    const ph = sim.game.flare[0];
    if (!ph) return;
    hx.font = '600 14px "IBM Plex Mono", ui-monospace, monospace'; hx.textAlign = 'center'; hx.textBaseline = 'middle';
    const open = sim.stellar(SH.x[0], SH.y[0]) > 2;
    hx.fillStyle = ph === 1 ? NAV_HOT : open ? '#f08a72' : '#7fd08a';
    label(ph === 1 ? `STELLAR FLARE IN ${Math.ceil(sim.param('flare_warn') - sim.game.flare_t[0])} s  ·  GET INTO A PLANET'S SHADOW` : `STELLAR FLARE  ·  ${open ? 'EXPOSED' : 'SHELTERED'}`, W / 2, 58);
    hx.textAlign = 'left';
  }
  // between systems: where from and to, the timing bar with the chain window at its end, and the chain prompt
  function drawTransit() {
    hx.setTransform(dpr, 0, 0, dpr, 0, 0); hx.clearRect(0, 0, W, H);
    const T = transitInfo(), n = courseNext(), y = H - stripH - 70;
    hx.textAlign = 'center'; hx.textBaseline = 'middle';
    hx.font = '600 16px "Saira Semi Condensed", sans-serif'; hx.fillStyle = '#dbe0e7';
    label(`IN TRANSIT  ·  ${starName(T.from).toUpperCase()} → ${SYS.name.toUpperCase()}`, W / 2, 34);
    // the bar: the trip so far, the window lit at its end
    const bw = Math.min(420, W * 0.5), bx = W / 2 - bw / 2, wf = 1 - sim.param('chain_window') / sim.param('transit_secs');
    hx.fillStyle = 'rgba(7,9,12,.7)'; hx.fillRect(bx - 2, y + 22, bw + 4, 10);
    hx.fillStyle = n ? (T.window ? 'rgba(255,208,138,.9)' : 'rgba(255,208,138,.35)') : 'rgba(138,149,164,.35)'; hx.fillRect(bx + bw * wf, y + 24, bw * (1 - wf), 6);
    hx.fillStyle = '#dbe0e7'; hx.fillRect(bx, y + 24, bw * T.f, 6);
    hx.font = '600 20px "Saira Semi Condensed", sans-serif';
    if (T.chain >= 0) { hx.fillStyle = '#7fd08a'; label(`CHAINED  ·  ON TO ${starName((gatesOf(sysRec)[T.chain] || {}).dest).toUpperCase()}`, W / 2, y); }
    else if (T.chain === -2) { hx.fillStyle = '#f08a72'; label('TOO EARLY: NO CHAIN THIS TIME', W / 2, y); }
    else if (n && sim.game.fuel[0] < sim.laneFuel(SH.kind[0], n.G.ly) * sim.param('chain_cost')) { hx.fillStyle = 'rgba(240,138,114,.85)'; label(`NOT ENOUGH FUEL TO CHAIN ON TO ${n.G.name.toUpperCase()}`, W / 2, y); }
    else if (n) { hx.fillStyle = T.window ? '#ffd08a' : 'rgba(219,224,231,.7)'; label(T.window ? `${KB.name('jump')}  ·  CHAIN ON TO ${n.G.name.toUpperCase()}` : `${KB.name('jump')} AS THE BAR LIGHTS TO CHAIN ON TO ${n.G.name.toUpperCase()}`, W / 2, y); }
    hx.textAlign = 'left';
  }
  // in a jump zone, lined up and ready: say so where the landing prompt goes
  function drawJumpPrompt() {
    const jl = jumpLine();
    if (!jl || !jl[2]) return;
    hx.font = '600 13px "IBM Plex Mono", ui-monospace, monospace'; hx.textAlign = 'center'; hx.textBaseline = 'middle';
    hx.fillStyle = jumpPhase() === JUMP.torch ? '#ffd08a' : '#7fd08a';
    label(jumpPhase() === JUMP.torch ? jl[0] : `${KB.name('jump')}  JUMP TO ${gatesOf(sysRec)[sim.zoneAt(SH.x[0], SH.y[0])].name.toUpperCase()}`, W / 2, H - stripH - 62);
    hx.textAlign = 'left';
  }
  // The jump zones' buoys: a field across each lane's runway, a buoy every 500 m along it and across it (so some are in
  // view wherever the ship is in the zone, at any zoom), lit in the colour of who holds the far end (the course's next
  // lane in green), the lights chasing outward along the bearing. Drawn on the HUD's canvas, in the world's place.
  const hexCol = c => `rgb(${c.map(v => Math.round(Math.pow(Math.min(1, v), 1 / 2.2) * 255)).join(',')})`;
  const gateCol = (G, g, n) => n && n.g === g ? '#7fd08a' : UNIVERSE.factions[G.owner] ? hexCol(UNIVERSE.factions[G.owner].colour) : '#9fb4c8';
  // Blinks: a flash where a ship leaves at jump speed (a traffic torch that ends) or comes in (a traffic arrival, the
  // player's arrival), an expanding ring and a glow over FLASH_S, drawn in the world's place on the HUD canvas.
  const FLASH_S = 0.7, flashes = [], torching = new Map(), arrived = new Set(); // slot -> where it was in its torch; arrivals flashed (handles)
  function watchBlinks() {
    const now = performance.now() / 1000, TR = sim.traffic;
    for (const [i, p] of torching) if (!(SH.alive[i] && TR.role[i] && TR.phase[i] === TRAFFIC.torch)) { flashes.push({ x: p.x, y: p.y, t0: now, out: true }); torching.delete(i); }
    for (let i = 1; i < sim.count(); i++) {
      if (!SH.alive[i] || !TR.role[i]) continue;
      if (TR.phase[i] === TRAFFIC.torch) torching.set(i, { x: SH.x[i], y: SH.y[i] });
      if (TR.phase[i] === TRAFFIC.arriving && !arrived.has(sim.handle(i))) { arrived.add(sim.handle(i)); if (TR.timer[i] < 0.5) flashes.push({ x: SH.x[i], y: SH.y[i], t0: now, out: false }); }
    }
    if (arrived.size > 256) arrived.clear(); // (handles of ships long cruising: forgetting them only risks a stray flash)
    while (flashes.length && now - flashes[0].t0 > FLASH_S) flashes.shift();
    if (flashes.length > 64) flashes.splice(0, flashes.length - 64);
  }
  function drawFlashes() {
    const now = performance.now() / 1000, pxm = scale / dpr;
    for (const f of flashes) {
      const a = (now - f.t0) / FLASH_S; if (a > 1) continue;
      const [sx, sy] = toScreen(f.x, f.y), r = Math.max(6, 160 * pxm) * (0.3 + a), k = 1 - a;
      hx.globalAlpha = k * 0.5; hx.fillStyle = f.out ? '#cfe6ff' : '#fff2d6'; hx.beginPath(); hx.arc(sx, sy, r * 0.6, 0, 6.283); hx.fill();
      hx.globalAlpha = k; hx.strokeStyle = '#ffffff'; hx.lineWidth = 1.5; hx.beginPath(); hx.arc(sx, sy, r, 0, 6.283); hx.stroke();
    }
    hx.globalAlpha = 1;
  }
  function drawBuoys() {
    const Gs = gatesOf(sysRec);
    if (!Gs.length) return;
    const R = sim.param('jump_radius'), L = sim.param('zone_len'), ZW = sim.param('zone_width'), pxm = scale / dpr, t = performance.now() / 1000, n = courseNext();
    const reachX = W / 2 / pxm + 100, reachY = H / 2 / pxm + 100, hull = Math.max(2, 10 * pxm), lamp = Math.max(1.2, 2.5 * pxm);
    for (let g = 0; g < Gs.length; g++) {
      const G = Gs[g], dx = Math.cos(G.zone * Math.PI / 8), dy = Math.sin(G.zone * Math.PI / 8), col = gateCol(G, g, n);
      for (let d = R - L / 2; d <= R + L / 2 + 1; d += 500) for (let a = -ZW / 2; a <= ZW / 2 + 1; a += 500) {
        const x = dx * d - dy * a, y = dy * d + dx * a;
        if (Math.abs(x - camX) > reachX || Math.abs(y - camY) > reachY) continue;
        const [sx, sy] = toScreen(x, y), ph = ((t * 0.7 - (d - R + L / 2) / L) % 1 + 1) % 1, lit = 0.2 + 0.8 * Math.exp(-ph * 9);
        hx.fillStyle = 'rgba(70,76,86,.95)'; stationMark(sx, sy, hull / 2); hx.fill(); // the buoy, a small dark diamond
        hx.globalAlpha = lit * 0.22; hx.fillStyle = col; hx.beginPath(); hx.arc(sx, sy, lamp * 6, 0, 6.283); hx.fill(); // its lamp's glow
        hx.globalAlpha = 0.35 + 0.65 * lit; hx.beginPath(); hx.arc(sx, sy, lamp, 0, 6.283); hx.fill();
        hx.globalAlpha = 1;
      }
    }
  }
  // over a port: say so, and whether the ship is slow enough to land (the Book: be over it and nearly still)
  function drawLandingPrompt() {
    const pb = sim.portBelow();
    if (!pb) return;
    const B = BODIES[pb.body], st = B.kind === 'station';
    if (!pb.slow && navInfo({ j: pb.body, x: B.x, y: B.y, r: B.r }).closing < -1) return; // leaving it (a launch, a pass): no nag
    hx.font = '600 13px "IBM Plex Mono", ui-monospace, monospace'; hx.textAlign = 'center'; hx.textBaseline = 'middle';
    hx.fillStyle = pb.slow ? '#7fd08a' : '#e2b866';
    label(pb.slow ? `${KB.name('land')}  ${st ? 'DOCK AT' : 'LAND AT'} ${B.port.name.toUpperCase()}` : `SLOW DOWN TO ${st ? 'DOCK' : 'LAND'}`, W / 2, H - stripH - 40);
    hx.textAlign = 'left';
  }

  // ---------- navigation: what is where ----------
  // Belts and fields: a belt's point is the nearest of its ring (where the autopilot flies, player.rs nav_point) and
  // its reach half its width; a field's are its centre and radius, as any body's
  const rocky = B => B.kind === 'belt' || B.kind === 'field';
  function navPoint(j, px, py) {
    const B = BODIES[j];
    if (B.kind !== 'belt') return [B.x, B.y];
    const dx = px - B.x, dy = py - B.y, d = Math.hypot(dx, dy);
    return d < 1e-6 ? [B.x + B.r, B.y] : [B.x + dx / d * B.r, B.y + dy / d * B.r];
  }
  const navReach = B => B.kind === 'belt' ? B.belt.width / 2 : B.r;
  // Every body, from the player's drawn (interpolated) position, with its mission marker.
  const navObjects = () => {
    const dest = new Set(activeHere().map(k => MS.dest[k]));
    return BODIES.map((b, j) => { const [x, y] = navPoint(j, SH.rx[0], SH.ry[0]); return { j, name: b.name, short: b.name, x, y, r: navReach(b), kind: b.kind, port: !!b.port, mission: dest.has(j), env: !!b.env, rocky: rocky(b) }; })
      .filter(o => !o.env); // environmental stations are scenery: on the map and radar, not in the overlay
  };
  // surface distance, and closing speed (> 0 closing; relative to a body that moves: a station on its orbit)
  function navInfo(o) {
    const dx = o.x - SH.rx[0], dy = o.y - SH.ry[0], d = Math.hypot(dx, dy) || 1, j = o.j ?? -1;
    const vx = SH.vx[0] - (j >= 0 ? sim.body.vx[j] : 0), vy = SH.vy[0] - (j >= 0 ? sim.body.vy[j] : 0);
    return { d, surf: d - o.r, closing: (vx * dx + vy * dy) / d };
  }
  const toScreen = (x, y) => [(x - camX) * scale / dpr + W / 2, H / 2 - (y - camY) * scale / dpr];
  const NAV_COL = '#9fb4c8', NAV_HOT = '#e2b866', MIS_COL = '#8fd3ff', TGT_COL = '#e2b866', DEST_COL = '#7fd0c8'; // the ship target amber, the destination teal // mission destinations in light blue
  // text with a dark outline, readable over bright cloud tops
  function label(text, x, y) { hx.lineWidth = 3.5; hx.lineJoin = 'round'; hx.strokeStyle = 'rgba(7,9,12,.85)'; hx.strokeText(text, x, y); hx.fillText(text, x, y); }
  // the inset box off-screen markers sit on, and where the line from the view centre to (sx, sy) leaves it: clear of
  // the status box (top left), the radar, location list and target panel (the right-hand column), and the prompts
  // and message log (bottom)
  function edgePoint(sx, sy) {
    const m = 34, x0 = m, y0 = Math.max(m, hudBoxH + 40), x1 = W - 300, y1 = H - stripH - 96, cx = W / 2, cy = (H - stripH) / 2;
    if (sx > x0 && sx < x1 && sy > y0 && sy < y1) return null;
    let dx = sx - cx, dy = sy - cy; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const t = Math.min(dx > 0 ? (x1 - cx) / dx : dx < 0 ? (x0 - cx) / dx : 1e9, dy > 0 ? (y1 - cy) / dy : dy < 0 ? (y0 - cy) / dy : 1e9);
    return { x: cx + dx * t, y: cy + dy * t, dx, dy };
  }
  function edgeArrow(e, col) {
    const a = Math.atan2(e.dy, e.dx);
    hx.fillStyle = col;
    hx.beginPath(); hx.moveTo(e.x + Math.cos(a) * 11, e.y + Math.sin(a) * 11);
    hx.lineTo(e.x + Math.cos(a + 2.5) * 10, e.y + Math.sin(a + 2.5) * 10); hx.lineTo(e.x + Math.cos(a - 2.5) * 10, e.y + Math.sin(a - 2.5) * 10);
    hx.closePath(); hx.lineWidth = 3; hx.strokeStyle = 'rgba(7,9,12,.85)'; hx.stroke(); hx.fill();
  }

  // With the overlay on (I), every body gets a label where it is on screen, or an arrow on the screen edge pointing at
  // it, with its surface distance and the time to it.
  function drawNav(navs) {
    if (!navOn) return;
    hx.textBaseline = 'middle';
    // nearest first, so where edge labels would overlap (each other, or another's arrow) the nearer keeps its label and
    // the farther only its arrow
    const placed = [];
    for (const o of navs) { const [sx, sy] = toScreen(o.x, o.y), e = edgePoint(sx, sy); if (e) placed.push([e.x - 11, e.y - 11, e.x + 11, e.y + 11, o]); }
    for (const o of navs.slice().sort((a, b) => a.surf - b.surf)) {
      const [sx, sy] = toScreen(o.x, o.y), hot = o.surf <= 0, col = hot ? NAV_HOT : o.mission ? MIS_COL : NAV_COL;
      const name = (o.mission ? '◆ ' : '') + o.name.toUpperCase(), eta = fmtEta(o.surf, o.closing), sub = hot ? '' : fmtDist(o.surf) + (eta ? `  ·  ${eta}` : ''); // (the status line says what you are over)
      hx.fillStyle = col; hx.strokeStyle = col; hx.lineWidth = 1.5;
      const e = edgePoint(sx, sy);
      if (!e) { // centre on screen: label it there
        hx.textAlign = 'center';
        hx.beginPath(); hx.arc(sx, sy, 5, 0, 6.283); hx.stroke();
        hx.font = '600 13px "IBM Plex Mono", ui-monospace, monospace'; label(name, sx, sy - 16);
        hx.font = '500 11.5px "IBM Plex Mono", ui-monospace, monospace'; label(sub, sx, sy + 17);
        continue;
      }
      edgeArrow(e, col);
      hx.fillStyle = col;
      const lx = e.x - e.dx * 26, ly = e.y - e.dy * 26; // label just inside the arrow
      hx.textAlign = e.dx > 0.5 ? 'right' : e.dx < -0.5 ? 'left' : 'center';
      hx.font = '600 12px "IBM Plex Mono", ui-monospace, monospace';
      const tw = Math.max(hx.measureText(name).width, hx.measureText(sub).width) + 8, x0 = hx.textAlign === 'right' ? lx - tw : hx.textAlign === 'left' ? lx : lx - tw / 2;
      const box = [x0, ly - 15, x0 + tw, ly + 15];
      if (placed.some(q => q[4] !== o && q[0] < box[2] && box[0] < q[2] && q[1] < box[3] && box[1] < q[3])) continue;
      placed.push(box);
      label(name, lx, ly - 7);
      hx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace'; label(sub, lx, ly + 8);
    }
    hx.textAlign = 'left';
  }

  // ---------- targeting ----------
  // The nav target is the page's (what the panels show); only flying to it is a core command. A body target is
  // { body: j }; a ship target holds the core's handle, so it lapses when the ship lands and its slot is reused.
  // Two targets: the destination (a body { body: j } or a jump zone { zone: g }): where the autopilot flies, marked on
  // the location list, radar and maps; and the ship target ({ ship: handle }), which the core holds (a scan needs it,
  // and weapons will). A ship target the sensors lose is kept LOST_S seconds as lost, and taken again if they find it;
  // one that lands or leaves goes at once.
  let navDest = null, navShip = null, lastSet = null; // lastSet: which was set last (tests)
  const LOST_S = 4;
  function setTarget(t, quiet) {
    if (!t) { clearShip(); navDest = null; return; }
    if (t.ship !== undefined) {
      const r = command(CMD.target, t.ship | 0, 0);
      if (r !== 0) { if (!quiet) toast(`Can't target that: ${CORE.RESULT[r] || r}`); return; }
      navShip = { ship: t.ship, lost: 0 }; navShip.name = targetName(navShip); lastSet = 'ship';
      if (!quiet) toast(`Target: ${navShip.name}`);
      return;
    }
    navDest = t; lastSet = 'dest';
    if (!quiet) toast(`Destination: ${targetName(t)}`);
  }
  function clearShip() { if (sim.game.target[0]) command(CMD.target, 0, -1); navShip = null; }
  // each frame: a ship target that landed or left goes; one the sensors lost (the core let go) is kept a while
  function watchShipTarget() {
    if (!navShip) return;
    const i = sim.resolve(navShip.ship), now = performance.now() / 1000;
    if (i < 0 || !SH.alive[i] || TR.phase[i] === TRAFFIC.land) { clearShip(); toast('Target gone: it landed or left'); return; }
    if (!navShip.lost && sim.game.target[0] !== navShip.ship + 1) navShip.lost = now;
    if (navShip.lost) {
      if (sensed(i) && command(CMD.target, navShip.ship | 0, 0) === 0) navShip.lost = 0; // found again
      else if (now - navShip.lost > LOST_S) { navShip = null; toast('Target lost'); }
    }
  }
  // what the sensors make of ship i (core/src/sensors.rs): 0 nothing, 1 a contact, 2 identified, 3 scanned
  const sensed = i => SH.det[i] >= sim.param('ident_snr') ? (SH.scan[i] >= 1 ? 3 : 2) : SH.det[i] >= sim.param('contact_snr') ? 1 : 0;
  // A contact is where the sensors put it, give or take its error (wider the farther and weaker it is): drawn as a soft
  // blob that wanders round the ship's true place, a new guess every 40 s, eased between (looks only; the
  // sim keeps the true place). Returns its error radius (m) and the guess's offset from the true place (m).
  const hash1 = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  function contactFix(i) {
    const err = Math.hypot(SH.rx[i] - SH.rx[0], SH.ry[i] - SH.ry[0]) * 0.3 / Math.sqrt(Math.max(1, SH.det[i]));
    const t = performance.now() / 1000 * 0.025, b = Math.floor(t), f = t - b, e = f * f * (3 - 2 * f), seed = i * 7.31 + SH.generation[i] * 0.173;
    const at = n => { const a = hash1(seed + n) * 6.283, r = Math.sqrt(hash1(seed + n + 0.5)) * 0.6; return [Math.cos(a) * r, Math.sin(a) * r]; };
    const [ax, ay] = at(b), [bx, by] = at(b + 1);
    return { err, dx: (ax + (bx - ax) * e) * err, dy: (ay + (by - ay) * e) * err };
  }
  // a soft blob (radius r px, colour rgb, peak alpha a) for a contact
  function blob(x, y, r, rgb, a) {
    const g = hx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(0.45, `rgba(${rgb},${a * 0.45})`); g.addColorStop(1, `rgba(${rgb},0)`);
    hx.fillStyle = g; hx.beginPath(); hx.arc(x, y, r, 0, 6.283); hx.fill();
  }
  coldKey = () => { const on = !sim.game.cold[0]; if (command(CMD.cold, on ? 1 : 0) === 0) toast(on ? 'Running cold: a third of the signature' : 'Running warm'); };
  pingKey = () => { const r = command(CMD.ping); toast(r === 0 ? 'Ping: every sensor hears it' : r === 21 ? `Ping recharging: ${Math.ceil(sim.game.ping_cd[0])} s` : `No ping: ${CORE.RESULT[r] || r}`); };
  const targetBody = () => navDest && navDest.body !== undefined ? navDest.body : -1;
  // where the autopilot is flying (core game.auto: a body plus one, or minus one minus a jump zone), by name; '' none
  const autoName = () => { const a = sim.game.auto[0]; return a > 0 ? BODIES[a - 1].name : a < 0 ? `${(gatesOf(sysRec)[-1 - a] || { name: '?' }).name} jump zone` : ''; };
  const targetZone = () => navDest && navDest.zone !== undefined && gatesOf(sysRec)[navDest.zone] ? navDest.zone : -1;
  const targetShip = () => navShip && !navShip.lost && sim.game.target[0] === navShip.ship + 1 ? sim.resolve(navShip.ship) : -1;
  // a traffic ship by its hull: the faction and the line's name for its class (Union Brasshaul)
  function targetName(t) {
    if (t.body !== undefined) return BODIES[t.body].name;
    if (t.zone !== undefined) return `${(gatesOf(sysRec)[t.zone] || { name: '?' }).name} jump zone`;
    const i = sim.resolve(t.ship);
    if (i < 0) return 'lost';
    const T = types[SH.kind[i]];
    if (sensed(i) < 2) return 'unknown contact'; // identified at ident_snr: class and faction
    return T ? `${T.brand.factionName.replace(/^The /, '')} ${T.name}` : 'ship';
  }
  // Cycling (T, Y, R and Shift with them): the list is sorted nearest first on the first press and kept while the same
  // key goes on being pressed within CYCLE_S, so the order holds as things move; entries gone since are skipped.
  const CYCLE_S = 3;
  let cyc = null;
  function cycle(kind, dir, build, valid, isCurrent, pick, empty) {
    const now = performance.now() / 1000;
    if (!cyc || cyc.kind !== kind || now - cyc.at > CYCLE_S) cyc = { kind, list: build(), k: -1 };
    cyc.at = now;
    const L = cyc.list, n = L.length;
    let k = cyc.k >= 0 ? cyc.k : L.findIndex(isCurrent);
    for (let step = 0; step < n; step++) {
      k = k < 0 ? (dir > 0 ? 0 : n - 1) : (k + dir + n) % n;
      if (valid(L[k])) { cyc.k = k; pick(L[k]); return; }
    }
    cyc = null; toast(empty);
  }
  // the ships passing a test, nearest first, by handle
  function shipsBy(test) {
    const px = SH.rx[0], py = SH.ry[0], list = [];
    for (let i = 1; i < sim.count(); i++) if (SH.alive[i] && test(i)) list.push(i);
    return list.sort((a, b) => Math.hypot(SH.rx[a] - px, SH.ry[a] - py) - Math.hypot(SH.rx[b] - px, SH.ry[b] - py)).map(i => sim.handle(i));
  }
  const shipCycle = (kind, level, empty) => dir => cycle(kind, dir, () => shipsBy(level), h => { const i = sim.resolve(h); return i >= 0 && SH.alive[i] && level(i); },
    h => !!navShip && navShip.ship === h, h => setTarget({ ship: h }), empty());
  // T: identified ships; Y: contacts not yet identified
  cycleTarget = (dir = 1) => shipCycle('known', i => sensed(i) >= 2, () => `No identified ships: ${KB.name('unknownNext')} for unknown contacts, ${KB.name('ping')} pings`)(dir);
  cycleUnknown = (dir = 1) => shipCycle('unknown', i => sensed(i) === 1, () => `No unknown contacts: ${KB.name('ping')} pings`)(dir);
  // Tab: any ship the sensors hold that is in view
  const inView = i => { const [x, y] = toScreen(SH.rx[i], SH.ry[i]); return x >= 0 && x <= W && y >= 0 && y <= H; };
  cycleScreen = (dir = 1) => shipCycle('screen', i => sensed(i) >= 1 && inView(i), () => `No ships on screen: ${KB.name('targetNext')} for any identified ship`)(dir);
  // H: the nearest hostile; until M2 brings hostiles, the nearest ship tracking you
  nearestHostile = () => {
    const list = shipsBy(i => sensed(i) >= 1 && SH.seen[i] >= sim.param('contact_snr'));
    if (list.length) setTarget({ ship: list[0] }); else toast('No hostiles: no ship is tracking you');
  };
  // R (Shift+R back): the planets, moons and stations (not the environmental ones) and the jump zones, nearest first
  cycleBody = (dir = 1) => {
    const px = SH.rx[0], py = SH.ry[0], tb = targetBody(), tz = targetZone();
    cycle('place', dir, () => BODIES.map((B, j) => j).filter(j => { const B = BODIES[j]; return (B.kind === 'planet' || B.kind === 'moon' || B.kind === 'station') && !B.env; }).map(j => ({ body: j }))
      .concat(gatesOf(sysRec).map((_, g) => ({ zone: g }))).sort((a, b) => placeFrom(a, px, py) - placeFrom(b, px, py)),
      p => p.zone === undefined ? !!BODIES[p.body] : !!gatesOf(sysRec)[p.zone], p => (p.body !== undefined && p.body === tb) || (p.zone !== undefined && p.zone === tz), p => setTarget(p), 'No places');
  };
  // K: the course's next jump zone
  nextZone = () => { const n = courseNext(); if (n) setTarget({ zone: n.g }); else toast(course ? 'The course ends here' : `No course: set one on the galaxy map (${KB.name('galaxy')})`); };
  // G: the autopilot to the target body, under full assist; G again disengages
  flyTo = () => {
    const j = targetBody(), z = targetZone();
    if (sim.game.auto[0] !== 0) { command(CMD.autopilot, -1); toast('Autopilot off'); return; }
    if (z >= 0) { if (!assist()) { toast(`The autopilot flies in assist: ${KB.name('mode')}`); return; } if (command(CMD.autopilot, -2 - z) === 0) toast(`Autopilot: to the ${targetName(navDest)}, then ${KB.name('jump')} to jump`); return; }
    if (j < 0) { toast(`Pick a destination: a location (1-9), ${KB.name('placeNext')}, or the map (${KB.name('systemMap')})`); return; }
    if (!assist()) { toast(`The autopilot flies in assist: ${KB.name('mode')}`); return; }
    if (command(CMD.autopilot, j) === 0) toast(`Autopilot: flying to ${targetName(navDest)}`);
  };
  // The debug jump (the debug screen's jump box, and tests): to system id (its file's), at rest over its body j,
  // flying. A logged core command (core/src/atlas.rs), so saves and replays follow it. A system not read yet is read
  // first (then this returns a promise of the result); one not in the atlas is stored first (storeSystem, logged too).
  function jumpTo(id, j) {
    const S = SYSTEMS.get(id), no = r => { toast(`Can't jump there: ${typeof r === 'string' ? r : CORE.RESULT[r] || r}`); return typeof r === 'string' ? 12 : r; };
    if (!S) return ENTRY.has(id) ? needSystems([id]).then(() => SYSTEMS.has(id) ? jumpTo(id, j) : no(`${id} is unusable`)) : no(`no system ${id}`);
    // what the core's jump refuses, refused here first: storing a new system lays it out over the live one, which only
    // the jump puts right
    const m = sim.mode();
    if (m === MODE.descending || m === MODE.launching || m === MODE.dead) return no(3);
    if (!(j >= 0 && j < S.loaded.bodies.length)) return no(12);
    const k = storeSystem(S);
    if (k < 0) return no('the atlas is full, with missions bound for every system in it');
    const r = command(CMD.jump, k, j);
    if (r !== 0) { console.error(`jump to ${id} refused after storing it: ${CORE.RESULT[r] || r}`); return no(r); }
    showSystem(S); closeNotice();
    const arrived = course && course.dest === S.entry.id; // the course set on the galaxy map, done
    if (arrived) course = null;
    camX = SH.x[0]; camY = SH.y[0]; lastMode = -1; viewScale = 0;
    toast(`Jumped to ${BODIES[j].name}, ${SYS.name} system${arrived ? ': course complete' : ''}`);
    return r;
  }
  // every place a jump can go: each read system's bodies but its star (n: the system's place among the flyable ones)
  const readFlyable = () => FLYABLE.map((id, n) => [SYSTEMS.get(id), n]).filter(([S]) => S);
  const jumpPlaces = () => readFlyable().flatMap(([S, n]) => S.loaded.bodies.map((b, j) => ({ n, j, id: b.id, place: b.name, port: b.port ? b.port.name : '', kind: b.kind, system: S.loaded.system.name, sysId: S.id })).filter(p => p.j > 0));
  // each system, arriving over its start port (the jump box's *@system)
  const jumpSystems = () => readFlyable().map(([S, n]) => { const B = S.loaded.bodies, j = Math.max(1, B.findIndex(b => b.id === S.loaded.system.start && b.port), B.findIndex(b => b.port));
    return { n, j, id: B[j].id, place: B[j].name, port: B[j].port ? B[j].port.name : '', kind: B[j].kind, system: S.loaded.system.name, sysId: S.id }; });
  debug.setJump({ places: jumpPlaces, systems: jumpSystems, current: () => sysRec.id, start: () => START_ID, prepare: () => needSystems(FLYABLE),
    side: s => { const r = command(CMD.side, s), C = SYS.combat || {}, e = (C.sides || [])[s - 1]; toast(r ? `Can't: ${CORE.RESULT[r] || r}` : s && e ? `On ${e.line}'s side` : 'On no side'); },
    go: (id, j) => Promise.resolve(jumpTo(id, j)).then(r => { if (r === 0) debug.close(); return r; }) });
  escapeFlight = () => {
    if (mapOn) { toggleMap(false); return true; }
    if (navShip) { clearShip(); toast('Target cleared'); return true; }
    if (navDest) { navDest = null; toast('Destination cleared'); return true; }
    return false;
  };
  inFlight = () => sim.mode() === MODE.flying;

  // the target, marked where it is: corner brackets round it on screen, or an arrow on the screen edge
  function drawTargetMark() {
    const bracket = (x, y, r, col) => {
      const [sx, sy] = toScreen(x, y), e = edgePoint(sx, sy);
      if (e) { edgeArrow(e, col); return; }
      const k = Math.min(r * 0.4, 16);
      hx.strokeStyle = col; hx.lineWidth = 1.5;
      for (const [ux, uy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const cx = sx + ux * r, cy = sy + uy * r;
        hx.beginPath(); hx.moveTo(cx - ux * k, cy); hx.lineTo(cx, cy); hx.lineTo(cx, cy - uy * k); hx.stroke();
      }
    };
    // the destination: a body, or a jump zone's runway middle
    const j = targetBody(), z = targetZone();
    if (j >= 0) { const [x, y] = navPoint(j, SH.rx[0], SH.ry[0]); bracket(x, y, navReach(BODIES[j]) * scale / dpr, DEST_COL); }
    else if (z >= 0) { const [x, y] = zoneMid(z); bracket(x, y, Math.max(14, sim.param('zone_width') / 2 * scale / dpr), DEST_COL); }
    // the ship target: brackets, or for a contact a soft amber blob where the sensors guess it is
    const i = targetShip();
    if (i < 0) return;
    if (sensed(i) === 1) {
      const f = contactFix(i), [sx, sy] = toScreen(SH.rx[i] + f.dx, SH.ry[i] + f.dy), e = edgePoint(sx, sy);
      if (e) { edgeArrow(e, TGT_COL); return; }
      blob(sx, sy, Math.max(14, Math.min(60, f.err * scale / dpr * 0.8)), '226,184,102', 0.35);
      return;
    }
    bracket(SH.rx[i], SH.ry[i], Math.max(12, types[SH.kind[i]].half * scale / dpr * 1.2), TGT_COL);
  }

  // The panels, bottom right: the destination's at the bottom (what it is, range and time, landing, the jump, the
  // autopilot), the ship target's above it (what the sensors make of it, the scan); a ship target lost, a few seconds
  // greyed out.
  function destPanel() {
    const j = targetBody(), z = targetZone(), rows = [];
    if (j < 0 && z < 0) return null;
    if (z >= 0) { // a jump zone: its lane, the fuel it takes, and whether the ship is in it and ready
      const G = gatesOf(sysRec)[z], [mx, my] = zoneMid(z), d = zoneFrom(z, SH.rx[0], SH.ry[0]), cost = sim.laneFuel(SH.kind[0], G.ly);
      const toMid = Math.hypot(mx - SH.rx[0], my - SH.ry[0]) || 1;
      if (d <= 0) { const jl = jumpLine(); rows.push(jl && jl[2] ? [`${KB.name('jump')}  JUMP`, '#7fd08a'] : [jl ? jl[0].split('  ·  ').pop() : 'LINE UP OUTWARD', NAV_HOT]); }
      if ((courseNext() || {}).g === z) rows.push(['NEXT ON THE COURSE', MIS_COL]);
      rows.push(sim.game.auto[0] === -1 - z ? ['AUTOPILOT ON', '#7fd08a'] : [`${KB.name('autopilot')}  AUTOPILOT`, '#8a95a4']);
      return { head: 'DESTINATION', col: DEST_COL, title: `${G.name} jump zone`, sub: G.file ? `${G.ly.toFixed(1)} ly · ${G.days} d · ${cost.toFixed(1)} t of fuel` : 'uncharted',
        range: d > 0 ? fmtDist(d) : 'IN IT', dist: d, close: ((mx - SH.rx[0]) * SH.vx[0] + (my - SH.ry[0]) * SH.vy[0]) / toMid, rows };
    }
    const B = BODIES[j], [nx, ny] = navPoint(j, SH.rx[0], SH.ry[0]), o = navInfo({ j, x: nx, y: ny, r: navReach(B) }), title = B.port ? B.port.name : B.name;
    if (B.port) {
      const pb = sim.portBelow(), st = B.kind === 'station';
      if (pb && pb.body === j) rows.push(pb.slow ? [`${KB.name('land')}  ${st ? 'DOCK' : 'LAND'}`, '#7fd08a'] : [`SLOW DOWN TO ${st ? 'DOCK' : 'LAND'}`, NAV_HOT]);
    }
    if (B.hazard) rows.push([`RADIATION ZONE ${fmtDist(B.hazard)}`, '#f08a72']);
    if (activeHere().some(k => MS.dest[k] === j)) rows.push(['◆ MISSION', MIS_COL]);
    if (sim.game.auto[0] - 1 === j) rows.push(['AUTOPILOT ON', '#7fd08a']);
    else if (!rows.length || B.port) rows.push([`${KB.name('autopilot')}  AUTOPILOT`, '#8a95a4']);
    return { head: 'DESTINATION', col: DEST_COL, title,
      sub: [B.name !== title ? B.name : '', B.kind === 'star' ? STAR_CLASSES[B.starClass].label.toLowerCase() : B.kind, B.port ? B.port.role.replace('-', ' ') : '', B.belt ? B.belt.rocks.map(k => ROCK_TYPES[k].label.toLowerCase()).join(', ') : ''].filter(Boolean).join(' · '),
      range: fmtDist(o.surf), dist: o.surf, close: o.closing, rows };
  }
  function shipPanel() {
    if (!navShip) return null;
    const i = sim.resolve(navShip.ship);
    if (navShip.lost || i < 0) return { head: 'TARGET', col: '#8a95a4', title: 'Lost contact', sub: navShip.name || '', range: '—', dist: 0, close: 0, rows: [[`${KB.name('targetNext')} or ${KB.name('unknownNext')} for another`, '#8a95a4']] };
    const dx = SH.rx[i] - SH.rx[0], dy = SH.ry[i] - SH.ry[0], d = Math.hypot(dx, dy) || 1, lv = sensed(i), scanR = sim.param('scan_range'), rows = [];
    if (lv >= 2) rows.push([`SPEED ${fmtSpeed(Math.hypot(SH.vx[i], SH.vy[i]))}`, '#8a95a4']);
    if (lv === 2) rows.push(d < scanR ? [`SCANNING ${Math.round(SH.scan[i] * 100)}%`, MIS_COL] : [`SCAN WITHIN ${fmtDist(scanR)}`, '#8a95a4']);
    if (lv === 3) {
      rows.push([`HULL ${Math.round(100 * SH.hull[i] / sim.type.hull[SH.kind[i]])}%  ·  ${['SHIP', 'LOCAL TRAFFIC', 'INBOUND', 'OUTBOUND', 'LOITERING', 'STATION RUN'][TR.role[i]] || 'SHIP'}`, '#dbe0e7']);
      rows.push(SH.seen[i] >= sim.param('contact_snr') ? ['TRACKING YOU', NAV_HOT] : ['UNAWARE OF YOU', '#8a95a4']);
    }
    return { head: 'TARGET', col: TGT_COL, title: targetName(navShip),
      sub: lv < 2 ? `SNR ${SH.det[i].toFixed(1)} · identified at ${sim.param('ident_snr')}`
        : TR.role[i] === 4 && TR.phase[i] === TRAFFIC.cruise ? `loitering round ${endName(TR.to[i])}` : `${TR.phase[i] === TRAFFIC.launch ? 'launching from' : TR.phase[i] === TRAFFIC.land ? 'landing at' : TR.to[i] < 0 ? 'leaving by' : 'bound for'} ${endName(TR.phase[i] === TRAFFIC.launch ? TR.from[i] : TR.to[i])}`,
      range: fmtDist(d), dist: d, close: ((SH.vx[0] - SH.vx[i]) * dx + (SH.vy[0] - SH.vy[i]) * dy) / d, rows };
  }
  function drawTarget() {
    const w = 268, x = W - w - 14;
    let bottom = H - stripH - 14;
    for (const p of [destPanel(), shipPanel()]) {
      if (!p) continue;
      const h = 70 + p.rows.length * 16, y = bottom - h;
      bottom = y - 8;
      hx.fillStyle = 'rgba(7,9,12,.72)'; hx.fillRect(x, y, w, h);
      hx.strokeStyle = p.col === TGT_COL ? 'rgba(226,184,102,.55)' : p.col === DEST_COL ? 'rgba(143,211,255,.45)' : 'rgba(138,149,164,.4)'; hx.lineWidth = 1; hx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      hx.textBaseline = 'middle'; hx.textAlign = 'left';
      hx.fillStyle = '#8a95a4'; hx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace'; hx.fillText(p.head, x + 10, y + 12);
      hx.fillStyle = p.col; hx.font = '600 13px "IBM Plex Mono", ui-monospace, monospace'; hx.fillText(p.title.toUpperCase().slice(0, 30), x + 10, y + 28);
      hx.fillStyle = '#9fb4c8'; hx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace'; hx.fillText(p.sub.slice(0, 40), x + 10, y + 43);
      const eta = fmtEta(p.dist, p.close);
      hx.fillStyle = '#dbe0e7'; hx.fillText(`RANGE ${p.range}${eta ? `  ·  ${eta}` : ''}`, x + 10, y + 58);
      p.rows.forEach(([t, c], k) => { hx.fillStyle = c; hx.fillText(t, x + 10, y + 74 + k * 16); });
    }
  }

  // Message log, bottom left: the last few messages, fading after a while.
  function drawLog() {
    const now = performance.now(), live = msgLog.filter(m => now - m.at < 12000).slice(-5);
    hx.font = '500 11.5px "IBM Plex Mono", ui-monospace, monospace'; hx.textBaseline = 'middle'; hx.textAlign = 'left';
    live.forEach((m, k) => {
      const a = Math.min(1, (12000 - (now - m.at)) / 2000);
      hx.globalAlpha = a; hx.fillStyle = k === live.length - 1 ? '#dbe0e7' : '#9fb4c8';
      label(m.text, 14, H - stripH - 18 - (live.length - 1 - k) * 17);
    });
    hx.globalAlpha = 1;
  }

  // ---------- the location list (right, under the radar) ----------
  // The star, planets and free-orbiting stations, and each lane's jump zone, nearest first (re-sorted a few times a
  // second); the body whose local zone the player is in (ZONE_IN radii, left at ZONE_OUT) expands to show its moons and
  // stations, nearest first. A row shows the range and landable, dockable, mission and course markers; a click or its
  // number key sets the nav target. The range to a belt is to its nearer edge, to a jump zone to its runway.
  const ZONE_IN = 6, ZONE_OUT = 7;
  let TOP = [], KIDS = []; // the current system's bodies at the top level, and each one's children (systemViews)
  function locationRows() {
    TOP = BODIES.map((_, j) => j).filter(j => j === 0 || BODIES[j].parent === STAR.id);
    // a body's moons, stations, belts and fields; the star's are top-level rows already, so it has none
    KIDS = TOP.map(p => BODIES.map((_, j) => j).filter(j => p !== 0 && BODIES[j].parent === BODIES[p].id && !BODIES[j].env));
  }
  const ICON = { star: '✹', planet: '●', moon: '•', station: '◇', belt: '◌', field: '⁘' };
  // the range to a body's surface, a field's rim or a belt's nearer edge (0 inside)
  const surfFrom = (j, px, py) => { const B = BODIES[j], d = Math.hypot(B.x - px, B.y - py); return B.kind === 'belt' ? Math.abs(d - B.r) - B.belt.width / 2 : d - B.r; };
  // a jump zone's runway (core/src/jump.rs): its middle, and the range to it from (px, py) (0 inside)
  const zoneDir = g => { const G = gatesOf(sysRec)[g], a = G.zone * Math.PI / 8; return [Math.cos(a), Math.sin(a)]; };
  const zoneMid = g => { const [dx, dy] = zoneDir(g), R = sim.param('jump_radius'); return [dx * R, dy * R]; };
  function zoneFrom(g, px, py) {
    const [dx, dy] = zoneDir(g), along = px * dx + py * dy - sim.param('jump_radius'), side = py * dx - px * dy;
    return Math.hypot(Math.max(0, Math.abs(along) - sim.param('zone_len') / 2), Math.max(0, Math.abs(side) - sim.param('zone_width') / 2));
  }
  // a place: { body: j } or { zone: g }, and its range
  const placeFrom = (p, px, py) => p.zone !== undefined ? zoneFrom(p.zone, px, py) : surfFrom(p.body, px, py);
  let expanded = -1, locRows = [], locAt = 0;
  function refreshLocations() {
    const now = performance.now();
    if (now - locAt < 250) return; // a few times a second is plenty, and keeps clicks landing on stable rows
    locAt = now;
    const px = SH.rx[0], py = SH.ry[0], dist = j => Math.hypot(BODIES[j].x - px, BODIES[j].y - py), byRange = (a, b) => placeFrom(a, px, py) - placeFrom(b, px, py);
    if (expanded >= 0 && dist(TOP[expanded]) > BODIES[TOP[expanded]].r * ZONE_OUT) expanded = -1;
    if (expanded < 0) TOP.forEach((p, k) => { if (KIDS[k].length && dist(p) < BODIES[p].r * ZONE_IN) expanded = k; });
    const top = TOP.map((j, k) => ({ body: j, k })).concat(gatesOf(sysRec).map((_, g) => ({ zone: g }))).sort(byRange);
    locRows = [];
    for (const p of top) {
      locRows.push(p);
      if (p.body !== undefined && p.k === expanded) KIDS[p.k].map(j => ({ body: j, child: true })).sort(byRange).forEach(c => locRows.push(c));
    }
    const dest = new Set(activeHere().map(k => MS.dest[k])), tb = targetBody(), tz = targetZone(), nx = courseNext();
    const el = $('loc');
    el.style.top = `${radarBox().y + radarBox().h + 12}px`;
    el.innerHTML = locRows.map((p, n) => {
      const r = placeFrom(p, px, py), range = `<span class="r">${r > 0 ? fmtDist(r) : 'here'}</span>`, num = `<span class="n">${n < 9 ? n + 1 : ''}</span>`;
      if (p.zone !== undefined) {
        const G = gatesOf(sysRec)[p.zone], tags = `<span class="tag z">JUMP</span>` + (nx && nx.g === p.zone ? '<span class="tag m">NEXT</span>' : '');
        return `<button type="button" data-g="${p.zone}" class="${p.zone === tz ? 'target' : ''}">${num}<span class="ico">»</span><span>${G.name}${tags}</span>${range}</button>`;
      }
      const j = p.body, B = BODIES[j], tags = (B.port ? `<span class="tag">${B.kind === 'station' ? 'DOCK' : 'LAND'}</span>` : '') + (dest.has(j) ? '<span class="tag m">◆</span>' : '') + (B.hazard ? '<span class="tag h">☢</span>' : '');
      return `<button type="button" data-j="${j}" class="${p.child ? 'child' : ''}${j === tb ? ' target' : ''}">${num}<span class="ico">${ICON[B.kind] || '•'}</span><span>${B.name}${tags}</span>${range}</button>`;
    }).join('');
  }
  const rowTarget = p => p.zone !== undefined ? { zone: p.zone } : { body: p.body };
  pickLocation = n => { const row = locRows[n - 1]; if (row) setTarget(rowTarget(row)); locAt = 0; };
  $('loc').addEventListener('pointerdown', e => {
    const b = e.target.closest('button[data-j], button[data-g]');
    if (b) { setTarget(b.dataset.g !== undefined ? { zone: +b.dataset.g } : { body: +b.dataset.j }); locAt = 0; e.preventDefault(); canvas.focus(); }
  });

  // ---------- radar (top right) ----------
  // North up, centred on the player, bodies to scale; anything beyond the range sits on the rim. Ships appear only
  // here (the Book), as dots; the target is ringed.
  const MAP_RANGE = 24000; // meters from centre to rim
  // the active ping's wavefront (core/src/sensors.rs): out at 9 km a second from the moment of the ping, to 30 km (0 none)
  const pingRadius = () => { const p = sim.game.ping[0], r = p > 0 ? (1 - p) / sim.param('ping_decay') * 9000 : 0; return r < 30000 ? r : 0; };
  const STN_PX = 4.5; // the smallest a station draws on the radar (px from centre to corner): to scale it would be a dot
  function stationMark(x, y, r) { hx.beginPath(); hx.moveTo(x, y - r); hx.lineTo(x + r, y); hx.lineTo(x, y + r); hx.lineTo(x - r, y); hx.closePath(); }
  // gunfire (core/src/combat.rs): each slot's shells in flight, so a ship firing (in the last second or so) glows
  // orange on the radar and the system map, the more the brighter
  const fireCount = new Float32Array(MAXS);
  function firing() {
    fireCount.fill(0);
    const S = sim.shell;
    for (let n = 0; n < sim.maxShells; n++) {
      if (!S.live[n]) continue;
      const h = S.owner[n], i = h & 0xffff;
      if (i < MAXS && SH.generation[i] === h >>> 16) fireCount[i]++;
    }
    return fireCount;
  }
  const FIRE_RGB = '255,138,46';
  // a firing ship's glow at (x, y) on canvas c, from its shells in flight (n), flickering
  function fireGlow(c, x, y, n, scale) {
    if (!n) return;
    const r = scale * (5 + Math.min(9, Math.sqrt(n) * 2)), a = Math.min(0.85, 0.35 + n * 0.03) * (0.75 + 0.25 * Math.random());
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${FIRE_RGB},${a})`); g.addColorStop(0.4, `rgba(${FIRE_RGB},${a * 0.45})`); g.addColorStop(1, `rgba(${FIRE_RGB},0)`);
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill();
  }
  const radarBox = () => { const R = Math.max(60, Math.min(96, Math.min(W, H) * 0.14)); return { R, x: W - 2 * R - 14, y: 14, h: 2 * R + 14 }; };
  function drawRadar(navs) {
    const { R } = radarBox(), cx = W - R - 14, cy = R + 24, k = R / MAP_RANGE;
    const px = SH.rx[0], py = SH.ry[0], tb = targetBody(), ts = targetShip();
    hx.save();
    hx.beginPath(); hx.arc(cx, cy, R, 0, 6.283); hx.fillStyle = 'rgba(7,9,12,.72)'; hx.fill(); hx.clip();
    hx.strokeStyle = 'rgba(138,149,164,.18)'; hx.lineWidth = 1;
    hx.beginPath(); hx.arc(cx, cy, R / 2, 0, 6.283); hx.stroke();
    hx.beginPath(); hx.moveTo(cx - R, cy); hx.lineTo(cx + R, cy); hx.moveTo(cx, cy - R); hx.lineTo(cx, cy + R); hx.stroke();
    hx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace'; hx.textAlign = 'center'; hx.textBaseline = 'middle';
    for (const o of navs) {
      let mx = (o.x - px) * k, my = -(o.y - py) * k;
      const md = Math.hypot(mx, my), hot = o.surf <= 0, tgt = o.j === tb;
      let rr = Math.max(2.5, o.r * k);
      if (md - rr > R) { // beyond range: a pip on the rim
        mx *= (R - 4) / md; my *= (R - 4) / md;
        hx.fillStyle = tgt ? TGT_COL : o.mission ? MIS_COL : NAV_COL; hx.beginPath(); hx.arc(cx + mx, cy + my, tgt || o.mission ? 3.5 : 2.5, 0, 6.283); hx.fill();
        continue;
      }
      if (o.kind === 'belt') { // its ring, as a band as wide as the belt
        const B = BODIES[o.j];
        hx.strokeStyle = tgt || hot ? 'rgba(226,184,102,.4)' : 'rgba(176,164,146,.28)'; hx.lineWidth = Math.max(2, B.belt.width * k);
        hx.beginPath(); hx.arc(cx + (B.x - px) * k, cy - (B.y - py) * k, B.r * k, 0, 6.283); hx.stroke();
        continue;
      }
      if (o.kind === 'field') hx.setLineDash([2, 3]);
      hx.strokeStyle = tgt || hot ? NAV_HOT : o.mission ? MIS_COL : 'rgba(159,180,200,.75)'; hx.lineWidth = hot || o.mission || tgt ? 1.5 : 1;
      if (o.kind === 'station') { rr = Math.max(STN_PX, rr); stationMark(cx + mx, cy + my, rr); hx.stroke(); } // a diamond, big enough to see
      else { hx.beginPath(); hx.arc(cx + mx, cy + my, rr, 0, 6.283); hx.stroke(); }
      hx.setLineDash([]);
      hx.fillStyle = tgt || hot ? NAV_HOT : o.mission ? MIS_COL : o.port ? 'rgba(127,208,138,.9)' : 'rgba(159,180,200,.85)'; hx.fillText(o.short.slice(0, 3).toUpperCase(), cx + mx, cy + my - rr - 7);
    }
    // the jump zones: a pip on the rim toward each (inside, its runway's middle), in the colour of its far end
    { const Gs = gatesOf(sysRec), nx = courseNext(), JR = sim.param('jump_radius');
      Gs.forEach((G, g) => {
        let mx = (Math.cos(G.zone * Math.PI / 8) * JR - px) * k, my = -(Math.sin(G.zone * Math.PI / 8) * JR - py) * k;
        const md = Math.hypot(mx, my), out = md > R - 6;
        if (out) { mx *= (R - 6) / md; my *= (R - 6) / md; }
        hx.fillStyle = gateCol(G, g, nx); hx.fillRect(cx + mx - 3, cy + my - 3, 6, 6);
        if (g === targetZone()) { hx.strokeStyle = TGT_COL; hx.lineWidth = 1.5; hx.strokeRect(cx + mx - 6, cy + my - 6, 12, 12); }
        hx.fillText(G.name.slice(0, 3).toUpperCase(), cx + mx * (out ? 0.82 : 1), cy + my * (out ? 0.82 : 1) - (out ? 0 : 9));
      }); }
    // hazard zones round the exotic stars: a red dashed ring
    hx.setLineDash([4, 4]); hx.strokeStyle = 'rgba(240,138,114,.7)'; hx.lineWidth = 1;
    for (const S of SUNS) if (S.hazard) { hx.beginPath(); hx.arc(cx + (S.x - px) * k, cy - (S.y - py) * k, S.hazard * k, 0, 6.283); hx.stroke(); }
    hx.setLineDash([]);
    // environmental stations: not in the nav list, but on the radar as smaller, fainter diamonds, unlabelled
    for (let j = 0; j < BODIES.length; j++) {
      const B = BODIES[j];
      if (!B.env) continue;
      const mx = (B.x - px) * k, my = -(B.y - py) * k, rr = Math.max(STN_PX * 0.8, B.r * k);
      if (Math.hypot(mx, my) - rr > R) continue;
      stationMark(cx + mx, cy + my, rr);
      hx.fillStyle = j === tb ? NAV_HOT : 'rgba(159,180,200,.65)'; hx.fill();
    }
    // ships, at the level the sensors hold them (core/src/sensors.rs): a contact as its error circle, an identified
    // ship as a dot, a scanned one brighter; nothing for one they don't hold; an orange glow under any that is firing
    const fc = firing();
    fireGlow(hx, cx, cy, fc[0], 1);
    for (let i = 1; i < sim.count(); i++) { // slot 0 is the player
      const lv = SH.alive[i] ? sensed(i) : 0;
      if (!lv) continue;
      let mx = (SH.rx[i] - px) * k, my = -(SH.ry[i] - py) * k;
      if (mx * mx + my * my > R * R) continue;
      fireGlow(hx, cx + mx, cy + my, fc[i], 1);
      if (lv === 1) { // a contact: a soft blob, wandering round where it is
        const f = contactFix(i), r = Math.max(4, Math.min(12, f.err * k * 0.8));
        mx += f.dx * k; my -= f.dy * k;
        blob(cx + mx, cy + my, r, '159,180,200', Math.min(0.75, 0.35 + 6 / r / 4));
      } else { hx.fillStyle = lv === 3 ? '#ffffff' : 'rgba(219,224,231,.75)'; hx.fillRect(cx + mx - 1.25, cy + my - 1.25, 2.5, 2.5); }
      if (i === ts) { hx.strokeStyle = TGT_COL; hx.lineWidth = 1.5; hx.beginPath(); hx.arc(cx + mx, cy + my, 5, 0, 6.283); hx.stroke(); }
    }
    const pr = pingRadius();
    if (pr > 0 && pr * k < R) { hx.strokeStyle = 'rgba(120,220,255,.6)'; hx.lineWidth = 1.5; hx.beginPath(); hx.arc(cx, cy, pr * k, 0, 6.283); hx.stroke(); }
    if (sim.game.flare[0]) { // a flare coming or here: the shadows behind the planets and moons, where it can't reach
      const st = BODIES[sim.game.flare_star[0]];
      hx.fillStyle = 'rgba(127,208,138,.16)';
      if (st) for (const B of BODIES) {
        if (B.kind !== 'planet' && B.kind !== 'moon') continue;
        const l = Math.hypot(B.x - st.x, B.y - st.y) || 1, ux = (B.x - st.x) / l, uy = (B.y - st.y) / l, far = 2 * MAP_RANGE;
        const pt = (a, b) => [cx + (B.x + ux * a - uy * b - px) * k, cy - (B.y + uy * a + ux * b - py) * k];
        hx.beginPath(); [pt(0, -B.r), pt(far, -B.r), pt(far, B.r), pt(0, B.r)].forEach(([x, y], n) => n ? hx.lineTo(x, y) : hx.moveTo(x, y)); hx.fill();
      }
    }
    // the player: velocity line and heading arrow (world y up, screen y down)
    const vx = SH.vx[0] * k * 6, vy = -SH.vy[0] * k * 6;
    hx.strokeStyle = 'rgba(226,184,102,.8)'; hx.lineWidth = 1; hx.beginPath(); hx.moveTo(cx, cy); hx.lineTo(cx + vx, cy + vy); hx.stroke();
    hx.translate(cx, cy); hx.rotate(-SH.ra[0]);
    hx.fillStyle = '#dbe0e7'; hx.beginPath(); hx.moveTo(0, -6); hx.lineTo(4, 5); hx.lineTo(-4, 5); hx.closePath(); hx.fill();
    hx.restore();
    hx.strokeStyle = 'rgba(138,149,164,.45)'; hx.lineWidth = 1; hx.beginPath(); hx.arc(cx, cy, R, 0, 6.283); hx.stroke();
    hx.fillStyle = '#8a95a4'; hx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace'; hx.textAlign = 'right';
    hx.fillText(`RADAR ${fmtDist(MAP_RANGE)}`, cx + R, cy + R + 9);
    hx.textAlign = 'left';
  }

  // ---------- the system map (M) ----------
  // Orbits, bodies, ships, mission destinations and the target, the whole system in view. Click a body (or a ship)
  // to target it; G flies there. The sim runs on underneath.
  const mapEl = $('map'), mx2 = mapEl.getContext('2d');
  let mapOn = false;
  // messages go to the flight HUD's log while it is in view, else to the toast
  logShows = () => sim.mode() === MODE.flying && jumpPhase() !== JUMP.transit && !mapOn && !galaxy.isOpen() && !debug.isOpen() && !paused && !titleUp() && !barrier && !lost;
  // the map shows the bodies and the jump zones (north, east, south and west, at the system's jump radius)
  const jumpR = () => sim.param('jump_radius'), jumpSpread = () => sim.param('jump_spread');
  let mapExtent = 1; // the current system's (systemViews)
  const extentOf = () => Math.max(...BODIES.map(b => Math.hypot(b.x - STAR.x, b.y - STAR.y) + b.r + (b.kind === 'belt' ? b.belt.width / 2 : 0)), ((SYS.traffic || {}).jumpRadius || 45000) + 4000) * 1.08;
  const MAP_TOP = 76; // the title and help lines
  const mapView = () => { const h = H - stripH, s = Math.min(W, h - MAP_TOP) / 2 / mapExtent; return { s, cx: W / 2, cy: MAP_TOP + (h - MAP_TOP) / 2, h }; };
  toggleMap = on => {
    mapOn = on === undefined ? !mapOn : on;
    mapEl.hidden = !mapOn;
    if (mapOn) { mapEl.width = Math.round(W * dpr); mapEl.height = Math.round((H - stripH) * dpr); mapEl.style.height = `${H - stripH}px`; }
  };
  const mapPos = (x, y, v) => [v.cx + (x - STAR.x) * v.s, v.cy - (y - STAR.y) * v.s];
  function drawMap() {
    if (!mapOn) return;
    if (mapEl.width !== Math.round(W * dpr) || mapEl.height !== Math.round((H - stripH) * dpr)) toggleMap(true); // resized
    const v = mapView(), c = mx2, dest = new Set(activeHere().map(k => MS.dest[k])), tb = targetBody(), ts = targetShip();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = 'rgba(7,9,12,.94)'; c.fillRect(0, 0, W, v.h);
    // orbits round each body's parent
    c.strokeStyle = 'rgba(138,149,164,.22)'; c.lineWidth = 1;
    for (const B of BODIES) {
      if (!B.parent || B.env || B.kind === 'belt') continue; // a belt is drawn as its own ring
      const P = BODIES.find(o => o.id === B.parent) || STAR, [px, py] = mapPos(P.x, P.y, v);
      c.beginPath(); c.arc(px, py, Math.hypot(B.x - P.x, B.y - P.y) * v.s, 0, 6.283); c.stroke();
    }
    // hazard zones round the exotic stars
    for (const S of SUNS) {
      if (!S.hazard) continue;
      const [x, y] = mapPos(S.x, S.y, v);
      c.setLineDash([5, 5]); c.strokeStyle = 'rgba(240,138,114,.75)'; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, S.hazard * v.s, 0, 6.283); c.stroke(); c.setLineDash([]);
      c.font = '600 11px "IBM Plex Mono", ui-monospace, monospace'; c.textAlign = 'center'; c.fillStyle = 'rgba(240,138,114,.9)'; c.fillText('RADIATION HAZARD', x, y + S.hazard * v.s + 12);
    }
    // the jump zones: each lane's runway, in the colour of who holds its far end (the course's next lane green), named;
    // a system without lanes keeps the four compass zones through traffic uses
    c.font = '600 11px "IBM Plex Mono", ui-monospace, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    const Gs = gatesOf(sysRec), nx = courseNext(), ZL = sim.param('zone_len'), ZW = sim.param('zone_width');
    Gs.forEach((G, g) => {
      const R = jumpR(), dx = Math.cos(G.zone * Math.PI / 8), dy = Math.sin(G.zone * Math.PI / 8), col = gateCol(G, g, nx);
      const pt = (a, b) => mapPos(dx * a - dy * b, dy * a + dx * b, v);
      c.beginPath(); [[R - ZL / 2, -ZW / 2], [R + ZL / 2, -ZW / 2], [R + ZL / 2, ZW / 2], [R - ZL / 2, ZW / 2]].forEach(([a, b], k) => { const [x, y] = pt(a, b); k ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath();
      c.globalAlpha = 0.18; c.fillStyle = col; c.fill(); c.globalAlpha = 1; c.strokeStyle = g === targetZone() ? TGT_COL : col; c.lineWidth = g === targetZone() || (nx && nx.g === g) ? 2 : 1; c.stroke();
      const [lx, ly] = pt(R + ZL / 2 + 5000, 0);
      c.fillStyle = col; c.fillText(`${G.name.toUpperCase()}${G.file ? '' : ' (UNCHARTED)'} · ${G.days} D`, lx, ly);
    });
    if (!Gs.length) TRAFFIC.zones.forEach((name, z) => {
      const R = jumpR(), [x, y] = mapPos([0, R, 0, -R][z], [R, 0, -R, 0][z], v), r = Math.max(6, jumpSpread() * v.s);
      c.setLineDash([3, 4]); c.strokeStyle = 'rgba(143,211,255,.55)'; c.lineWidth = 1; c.beginPath(); c.arc(x, y, r, 0, 6.283); c.stroke(); c.setLineDash([]);
      c.fillStyle = 'rgba(143,211,255,.75)'; c.fillText(`${name.toUpperCase()} JUMP`, x, y + (z === 0 ? -r - 10 : r + 10));
    });
    // the autopilot's course: to the point it is steering for (round any obstacle), then the target
    const auto = sim.game.auto[0] - 1;
    if (sim.game.auto[0]) {
      const [ax, ay] = mapPos(SH.rx[0], SH.ry[0], v), [wx, wy] = mapPos(sim.game.aim_x[0], sim.game.aim_y[0], v), [bx, by] = mapPos(...(auto >= 0 ? navPoint(auto, SH.rx[0], SH.ry[0]) : zoneMid(-2 - auto)), v);
      c.setLineDash([5, 5]); c.strokeStyle = 'rgba(127,208,138,.8)'; c.beginPath(); c.moveTo(ax, ay); c.lineTo(wx, wy); c.lineTo(bx, by); c.stroke(); c.setLineDash([]);
    }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    BODIES.forEach((B, j) => {
      const [x, y] = mapPos(B.x, B.y, v), r = Math.max(B.kind === 'star' ? 7 : 3.5, B.r * v.s);
      if (B.kind === 'belt') { // a band round its parent, labelled at its foot
        const bw = Math.max(3, B.belt.width * v.s);
        c.strokeStyle = 'rgba(176,164,146,.3)'; c.lineWidth = bw; c.beginPath(); c.arc(x, y, B.r * v.s, 0, 6.283); c.stroke();
        if (j === tb || dest.has(j)) { c.strokeStyle = j === tb ? TGT_COL : MIS_COL; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, B.r * v.s + bw / 2 + 3, 0, 6.283); c.stroke(); }
        c.font = '600 12px "IBM Plex Mono", ui-monospace, monospace'; c.fillStyle = j === tb ? TGT_COL : '#b0a492';
        c.fillText(B.name.toUpperCase(), x, y + B.r * v.s + bw / 2 + 12);
        return;
      }
      if (B.kind === 'field') { c.fillStyle = 'rgba(176,164,146,.22)'; c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill(); c.setLineDash([2, 3]); c.strokeStyle = 'rgba(176,164,146,.6)'; c.lineWidth = 1; c.stroke(); c.setLineDash([]); }
      c.fillStyle = B.kind === 'star' ? `rgb(${B.light.col.map(v => Math.round(Math.min(1, v * 1.05) * 242)).join(',')})` : B.env ? 'rgba(201,210,220,.55)' : B.kind === 'station' ? '#c9d2dc' : '#6f8296';
      if (B.kind === 'station') { c.save(); c.translate(x, y); c.rotate(Math.PI / 4); c.fillRect(-r, -r, 2 * r, 2 * r); c.restore(); }
      else if (B.kind !== 'field') { c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill(); }
      if (j === tb) { c.strokeStyle = TGT_COL; c.lineWidth = 2; c.beginPath(); c.arc(x, y, r + 6, 0, 6.283); c.stroke(); }
      if (dest.has(j)) { c.strokeStyle = MIS_COL; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, r + 10, 0, 6.283); c.stroke(); }
      if (B.env && j !== tb) return; // environmental stations: a marker, no label (unless targeted)
      c.font = '600 12px "IBM Plex Mono", ui-monospace, monospace';
      c.fillStyle = j === tb ? TGT_COL : dest.has(j) ? MIS_COL : B.port ? '#7fd08a' : B.kind === 'field' ? '#b0a492' : '#9fb4c8';
      c.fillText(B.name.toUpperCase(), x, y - r - 12);
      if (B.port && B.port.name !== B.name) { c.font = '500 10.5px "IBM Plex Mono", ui-monospace, monospace'; c.fillStyle = '#8a95a4'; c.fillText(B.port.name, x, y + r + 12); }
    });
    const fc = firing();
    for (let i = 0; i < sim.count(); i++) {
      if (!SH.alive[i] || !(i === 0 || sensed(i)) || !fc[i]) continue; // gunfire first, under the dots
      const [x, y] = mapPos(SH.rx[i], SH.ry[i], v);
      fireGlow(c, x, y, fc[i], 1.4);
    }
    for (let i = 1; i < sim.count(); i++) {
      if (!SH.alive[i] || !sensed(i)) continue; // only what the sensors hold
      const [x, y] = mapPos(SH.rx[i], SH.ry[i], v);
      c.fillStyle = 'rgba(219,224,231,.8)'; c.fillRect(x - 1.5, y - 1.5, 3, 3);
      if (i === ts) { c.strokeStyle = TGT_COL; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, 6, 0, 6.283); c.stroke(); }
    }
    const [px, py] = mapPos(SH.rx[0], SH.ry[0], v);
    c.save(); c.translate(px, py); c.rotate(-SH.ra[0]);
    c.fillStyle = TGT_COL; c.beginPath(); c.moveTo(0, -8); c.lineTo(5.5, 6); c.lineTo(-5.5, 6); c.closePath(); c.fill();
    c.restore();
    c.textAlign = 'left'; c.font = '700 18px "Saira Semi Condensed", system-ui, sans-serif'; c.fillStyle = '#dbe0e7';
    c.fillText(`${SYS.name.toUpperCase()} SYSTEM`, 20, 26);
    c.font = '500 11.5px "IBM Plex Mono", ui-monospace, monospace'; c.fillStyle = '#8a95a4';
    c.fillText(`Click to target  ·  G autopilot  ·  J in a lane's zone, heading out, to jump  ·  Esc close`, 20, 48);
    const tl = [navDest && `Destination: ${targetName(navDest)}${sim.game.auto[0] ? ' (autopilot)' : ''}`, navShip && !navShip.lost && `Target: ${targetName(navShip)}`].filter(Boolean).join('  ·  ');
    if (tl) { c.fillStyle = TGT_COL; c.fillText(tl, 20, 66); }
  }
  mapEl.addEventListener('pointerdown', e => {
    const v = mapView(), r = mapEl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 22;
    BODIES.forEach((B, j) => {
      const [bx, by] = mapPos(B.x, B.y, v), e = Math.hypot(bx - x, by - y);
      const d = B.kind === 'belt' ? Math.abs(e - B.r * v.s) - Math.max(0, B.belt.width * v.s / 2 - 4) : e - Math.max(0, B.r * v.s - 4); // a belt: anywhere on its band
      if (d < bd) { bd = d; best = { body: j }; }
    });
    gatesOf(sysRec).forEach((G, g) => { // a jump zone: its runway's middle
      const [zx, zy] = mapPos(...zoneMid(g), v), d = Math.hypot(zx - x, zy - y) - Math.max(6, sim.param('zone_len') / 2 * v.s);
      if (d < bd) { bd = d; best = { zone: g }; }
    });
    for (let i = 1; i < sim.count(); i++) {
      if (!SH.alive[i] || !sensed(i)) continue;
      const [sx, sy] = mapPos(SH.rx[i], SH.ry[i], v), d = Math.hypot(sx - x, sy - y);
      if (d < Math.min(bd, 8)) { bd = d; best = { ship: sim.handle(i) }; }
    }
    if (best) setTarget(best);
    e.preventDefault(); canvas.focus();
  });

  // the views made from the current system's bodies: called by showSystem
  function systemViews() {
    sunCol = lin(star.col);
    atmOf = new Map(WORLDS.map(w => [BODIES.find(b => b.id === w.id), w.LA]));
    airOf = new Map(WORLDS.map(w => [BODIES.find(b => b.id === w.id), w.pu.air]));
    locationRows(); expanded = -1; locAt = 0; locRows = [];
    mapExtent = extentOf();
    navDest = navShip = null;
  }

  // test hook: drive and inspect the session from a console or a headless browser
  window.__play = {
    sim, IN, CMD, MODE, newGame, exportReplay, command, ECON, showTitle, pauseGame,
    get BODIES() { return BODIES; }, // the current system's
    hold: on => { held = !!on; }, galaxy, course: () => course, setCourse: (dest, by) => { course = dest == null ? null : { dest, by: by || 'days' }; }, jumpKey: () => jumpKey(), gates: () => gatesOf(sysRec), route: (from, to, by) => galaxyRoute(UNIVERSE, from, to, by), // the galaxy map, the course set on it, a route between star ids
    // the flyable systems (ids, the start first), the one being played, the debug jump (a promise if the system must be
    // read first) and every place it can go in the systems read so far; preload() reads them all; atlas() lists each
    // slot's system
    systems: () => FLYABLE.slice(), system: () => sysRec.id, jump: (id, j) => jumpTo(id, j), places: () => jumpPlaces(), preload: () => needSystems(FLYABLE),
    atlas: () => Array.from({ length: sim.atlasCount() }, (_, k) => (BY_STAR.get(sim.atlasId(k)) || {}).file || null), universe: UNIVERSE,
    // the player's landing or launch sequence now: progress and the drawn pose (null when not in one)
    seq: () => sim.mode() === MODE.descending || sim.mode() === MODE.launching ? playerSeq() : null,
    setNav, trade, repay, showPanel, accept, abandon, setTarget, flyTo, cycleTarget, toggleMap, pickLocation,
    service: what => portService(what), // 'refuel' or 'repair', where landed
    // the outfitter (core/src/fit.rs): a fit's stats (0 the ship's, 1 the draft), a draft slot set (tonnes; 'jets' all four
    // corners), the refit, and the fit's slots
    fitStats: which => fitStats(which), setDraft: (n, v) => setDraft(n, v), refit: () => refit(), fitSlots: () => Object.fromEntries(Object.entries(FIT).map(([n, k]) => [n, sim.fit.t[k]])),
    roomFor: id => sim.roomFor(GOODS.findIndex(c => c.id === id)),
    get SUNS() { return SUNS; }, starKit, starLook, // the current system's stars, the star kit and looks (src/stars.js)
    // the target set last (the destination or the ship), and both
    target: () => { const t = lastSet === 'ship' ? navShip : navDest; return t && (t.body !== undefined ? { body: t.body } : t.zone !== undefined ? { zone: t.zone } : { ship: sim.resolve(t.ship) }); },
    targets: () => ({ dest: navDest && Object.assign({}, navDest), ship: navShip && !navShip.lost ? sim.resolve(navShip.ship) : -1, lost: !!(navShip && navShip.lost) }),
    locations: () => { locAt = 0; refreshLocations(); return locRows.map(p => Object.assign(p.zone !== undefined ? { zone: p.zone, name: gatesOf(sysRec)[p.zone].name } : { j: p.body, name: BODIES[p.body].name }, { child: !!p.child, r: placeFrom(p, SH.rx[0], SH.ry[0]) })); }, // as the list shows them now: bodies and jump zones, nearest first
    // ambient traffic: every ship in flight, with its role, phase, route and whether it is on rails
    traffic: () => { const out = []; for (let i = 0; i < sim.count(); i++) if (TR.role[i]) out.push({ i, role: TRAFFIC.streams[TR.role[i] - 1], line: types[SH.kind[i]].brand.id, cls: catalog.sizes[types[SH.kind[i]].zi].id, phase: TR.phase[i], from: TR.from[i], to: TR.to[i], rail: SH.rail[i], x: SH.x[i], y: SH.y[i], v: Math.hypot(SH.vx[i], SH.vy[i]) }); return out; },
    // how many rocks the belts and fields hold (scenery: src/rocks.js)
    rocks: () => ROCKS.length,
    // combat (core/src/combat.rs): the lab's fighters (side, AI phase, hull, shield, rounds), shells in flight, the side the
    // player is on, and joining one
    combat: () => { const A = sim.arms, out = []; for (let i = 0; i < sim.count(); i++) if (SH.alive[i] && sim.traffic.role[i] === TRAFFIC.combat) out.push({ i, side: A.side[i], phase: sim.traffic.phase[i], hull: SH.hull[i], shield: A.shield[i], ammo: A.ammo[i], target: A.target[i] ? A.target[i] - 1 & 0xffff : -1 });
      let shells = 0; for (let n = 0; n < sim.maxShells; n++) shells += sim.shell.live[n]; return { fighters: out, shells, side: sim.battle.player_side[0], angry: sim.battle.angry[0], guns: sim.arms.guns[0], ammo: sim.arms.ammo[0] }; },
    side: s => command(CMD.side, s),
    // dev: put the (flying) player at rest over body j; a logged command, so replays still match
    teleport: j => command(CMD.teleport, j),
    // sensors (core/src/sensors.rs): a flare's warning now (dev), and what the sensors make of every ship
    keys: () => KB.bindings(), // the key bindings now (src/play/keys.js)
    flare: () => command(CMD.flare), contacts: () => { const out = []; for (let i = 1; i < sim.count(); i++) if (SH.alive[i]) out.push({ i, level: sensed(i), det: SH.det[i], seen: SH.seen[i], scan: SH.scan[i], sig: SH.sig[i] }); return out; },
    setZoom: z => { setZoom(z); return zoom; }, // the view's zoom, 0.25 to 4 (the wheel's range)
    // this port's offers and the player's active missions, as plain objects
    offers: () => { const at = sim.game.at[0], out = []; for (let k = 0; k < NO; k++) { const o = at * NO + k; if (OF.live[o]) out.push({ k, dest: OF.dest[o], good: OF.good[o], tons: OF.tons[o], pay: OF.pay[o], days: OF.days[o] }); } return out; },
    missions: () => Array.from(MS.state, (state, k) => ({ k, state, sys: MS.sys[k], dest: MS.dest[k], tons: MS.tons[k], pay: MS.pay[k], due: MS.due[k] })),
    // commodity index by id, and its price where the player is landed
    good: id => GOODS.findIndex(c => c.id === id),
    price: id => sim.price(sim.game.at[0], GOODS.findIndex(c => c.id === id)),
    jitter: () => JIT.report(), jitterClear: () => JIT.clear(),
    // the game's part of a dev state report (tools/dev-client.js): what is happening now, the jitter probe, the
    // traffic, the settings, and a replay that reruns the session to this tick (save.bin + inputs.txt)
    report: () => {
      const r = exportReplay(), tr = {};
      for (let i = 0; i < sim.count(); i++) if (TR.role[i]) { const k = TRAFFIC.streams[TR.role[i] - 1]; tr[k] = (tr[k] || 0) + 1; }
      const modeName = Object.keys(MODE).find(k => MODE[k] === sim.mode());
      return {
        game: { probe: window.__play.probe(), mode: modeName, zoom, viewScale, assist: assistMode, bloom: bloomOn, fps: Math.round(fps * 10) / 10,
          camera: [camX, camY], canvas: [canvas.width, canvas.height], renderScale, scene: [G.targets.scene.w, G.targets.scene.h], settings: SETTINGS, traffic: tr, shipsLive: sim.count(),
          // the page's own UI (HTML, which the screenshot can't show): what is open
          ui: { port: !$('port').hidden ? $('port-name').textContent : null, panel: panelOpen(), map: mapOn, debug: debug.isOpen(), shell: shellOpen(),
            vista: $('vista').classList.contains('on') ? (document.body.classList.contains('vista-framed') ? 'framed' : 'full screen') : null, nav: navOn, jitterOverlay: !!JIT.shown,
            target: navShip ? targetName(navShip) : null, destination: navDest ? targetName(navDest) : null },
          jitter: JIT.report(), replay: { ticks: r.ticks, tick: r.tick, hash: r.hash } },
        save: b64(r.save), inputs: r.log
      };
    },
    probe: () => ({ barrier: !!barrier, notice, tick: sim.tick(), hash: sim.hash(), x: SH.x[0], y: SH.y[0], v: Math.hypot(SH.vx[0], SH.vy[0]), set: sim.playerSet(), assist: assistMode, mode: sim.mode(), day: sim.day(), at: sim.game.at[0], ready: typeReady(types[SH.kind[0]]), auto: sim.game.auto[0] - 1, map: mapOn, shell: shellOpen(), paused, seed: seedNow,
      credits: sim.credits(), debt: sim.debt(), hold: Object.fromEntries(GOODS.map((c, g) => [c.id, sim.hold.tons[g]]).filter(e => e[1])), holdCap: holdCap(),
      hull: SH.hull[0], hullCap: sim.type.hull[SH.kind[0]], fuel: sim.game.fuel[0], fuelCap: sim.type.fuel[SH.kind[0]], lost,
      fitted: !!sim.game.fitted[0], shield: sim.game.shield[0], energy: sim.game.energy[0], drive: sim.game.drive[0], heat: sim.game.heat[0] }),
    // hold keys for sec seconds of sim time (recorded like live input)
    advance: (sec, held) => {
      const saved = new Set(keys); keys.clear(); (held || []).forEach(k => keys.add(k));
      const bits = inputBits(IN);
      if (bits !== lastBits) { sim.setInput(bits); rec.log.push([sim.tick(), bits]); lastBits = bits; }
      for (let k = 0; k < Math.round(sec / sim.DT); k++) sim.step();
      follow();
      keys.clear(); saved.forEach(k => keys.add(k));
    },
    save: () => saveGame(), load: () => loadGame(), b64, unb64,
    inspect: () => G.inspectScene(), setZoom
  };
  showTitle();
  requestAnimationFrame(frame);
}).catch(e => { console.error(e); $('glerr').textContent = 'The game failed to start: ' + (e.message || e); $('glerr').hidden = false; });
