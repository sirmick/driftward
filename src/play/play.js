// ======================= PLAY =======================
// The game page, on the way to M1. Rule: anything that changes game state runs in the sim core, so a session
// saves, loads and replays exactly (natively too). This page only turns keys into one input bitmask per tick,
// and draws what the core's columns say. Flight is the core's player model, with the Book's three assist levels:
// full assist holds a set speed along the nose (and cancels drift and gravity); drift off is raw Newtonian thrust
// with strafe; full off adds torque rotation, where a spin keeps going until countered.
const $ = id => document.getElementById(id);
const catalog = ShipGen.resolveCatalog(JSON.parse($('catalog').textContent)); // factions' lines as brands (src/gen.js)
const canvas = $('view'), hud = $('hud'), hx = hud.getContext('2d');
const G = makeGfx(canvas);
if (!G) { $('glerr').hidden = false; return; }
const { gl, compile, P, quad, draw, tex } = G;

// ---------- the systems: every system file, validated (clamped) against its schema, then laid out (src/schema.js) ----------
// The build inlines every file in src/systems/, the start system first. The page draws one at a time, the one the core
// says the player is in (game.system; the atlas holds them all: core/src/atlas.rs), through setSystem below.
const SYSTEM_SCHEMA = JSON.parse($('system-schema').textContent), LORE_SCHEMA = JSON.parse($('lore-schema').textContent);
// environmental stations are sized from their archetype's diameter range (the middle of it, as a radius)
const LAYOUT = { stationRadius: id => { const a = catalog.stations.find(x => x.id === id); return a && a.diameter ? (a.diameter[0] + a.diameter[1]) / 4 : 400; } };
// the economy (src/economy.json): commodities, and each port role's price tier for each (validated by npm run check)
const ECON = JSON.parse($('economy').textContent), GOODS = ECON.commodities;
// ambient traffic (src/traffic.json): hulls by culture and role, population weights
const TRAFFIC_DATA = JSON.parse($('traffic').textContent);
// each system's lore (src/lore/<id>.json, from tools/gen-content.js), validated against its schema and the system; a
// port without it shows the system file's description and an empty bar. The art manifest lists the painted vistas
// and portraits found in art/<id>/ at build time; the content log, how they were made (the debug screen shows it).
const LORES = JSON.parse($('lore').textContent), ARTS = JSON.parse($('art').textContent), LOGS = JSON.parse($('content-log').textContent);
const SYSTEMS = JSON.parse($('systems').textContent).map(raw => {
  const loaded = loadSystem(raw, SYSTEM_SCHEMA, LAYOUT);
  loaded.notes.forEach(n => console.warn(`system ${raw.id} ${n.path}: ${n.msg}`));
  if (!loaded.system) { console.error(`system ${raw.id} is unusable: ` + loaded.notes.filter(n => n.fatal).map(n => `${n.path} ${n.msg}`).join('; ')); return null; }
  const id = loaded.system.id, lore = LORES[id] ? loadLore(LORES[id], LORE_SCHEMA, loaded.system) : { lore: null, ports: new Map(), notes: [] };
  lore.notes.forEach(n => console.warn(`lore ${id} ${n.path}: ${n.msg}`));
  return { id, raw, loaded, lore, art: ARTS[id] || { vistas: {}, portraits: {} }, log: LOGS[id] || {} };
}).filter(Boolean);
if (!SYSTEMS.length) { $('glerr').textContent = 'No usable system file'; $('glerr').hidden = false; return; }
const START_SYSTEM = 0;
// the system the page draws now, set by setSystem (below, once the bake helpers exist)
let sysK = -1, SYS, BODIES, STAR, LORE, ART, star, WORLDS, STATIONS;
// the debug screen (backquote): how the current system's content was made (src/play/debug.js), and the jump box
const debug = makeDebug({ el: $('debug'), econ: ECON, system: () => SYSTEMS[sysK] });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const BODY_KIND = { star: 0, planet: 1, moon: 2, station: 3, belt: 4, field: 5 };
// planets and moons, drawn by the planet shader (worldsOf, per system)
// city lights follow a port's population (look.cityLights is a floor on top, for a world brighter than its tier)
const CITY_LIGHTS = { outpost: 0.1, colony: 0.3, town: 0.6, world: 1 };
const worldsOf = bodies => bodies.filter(b => b.kind === 'planet' || b.kind === 'moon').map(b => {
  const pu = planetUniforms(b.look); // every field filled by the schema clamp, defaults and all
  if (b.port) pu.city = Math.max(pu.city || 0, CITY_LIGHTS[b.port.population] || 0);
  return Object.assign({}, b, { pu, LA: pu.atm, ext: pu.ext });
});
// light comes from the star: the direction toward it from (x, y), tipped toward the camera so day sides read
function sunFrom(x, y, out = new Float32Array(3)) {
  const dx = STAR.x - x, dy = STAR.y - y, l = Math.hypot(dx, dy);
  const vx = l > 1 ? dx / l : 0, vy = l > 1 ? dy / l : 0, vz = l > 1 ? 0.45 : 1, n = Math.hypot(vx, vy, vz);
  out[0] = vx / n; out[1] = vy / n; out[2] = vz / n; return out;
}

// ---------- ship types: one per brand x size; flight stats from the catalog, looks from the bake ----------
const baker = makeBaker({
  gl, tex, genText: $('gen').textContent, catalog: () => catalog, defaultSeed: () => 'play-1',
  onError: (key, msg) => console.error('bake failed', key, msg)
});
// the shipyard: every line's hulls for the debug screen's Ships tab, and the seed each hull class is built from
// (picked there; the game's ships use the same seeds)
const yard = makeShipyard({ gl, P: G.P, draw: G.draw, baker, catalog, target: () => G.targets.scene });
debug.setYard(yard);
const nSizes = catalog.sizes.length;
const types = [];
catalog.brands.forEach((b, bi) => catalog.sizes.forEach((z, zi) => {
  const fz = z.flight || {}, fb = b.style.flight || {};
  types.push({
    bi, zi, brand: b, L: z.length, name: b.series[zi], key: baker.keyOf(b.id, z.id), br: brandRender(b),
    accel: (fz.accel || 60) * (fb.accel || 1), turn: (fz.turn || 1) * (fb.turn || 1), vmax: (fz.vmax || 200) * (fb.vmax || 1),
    well: fz.well == null ? 0.5 : fz.well, // how much gravity wells pull this hull and bend its top speed
    cargo: Math.round((fz.cargo || 0) * (fb.cargo == null ? 1 : fb.cargo)), // hold, tons: the class's, times the line's
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
// The page's view of system k: its bodies, the worlds and stations to draw (made once per system; their positions are
// the core's, copied in when the system is laid out), its star, lore and art. Its stations start baking, unless it is
// only being laid out (bake false: every system is, at startup).
function setSystem(k, bake = true) {
  const S = SYSTEMS[k];
  sysK = k; SYS = S.loaded.system; BODIES = S.loaded.bodies; STAR = BODIES[0]; LORE = S.lore; ART = S.art;
  star = STARS[STAR.look] || STARS.sol;
  WORLDS = S.worlds || (S.worlds = worldsOf(BODIES));
  STATIONS = S.stations || (S.stations = stationsOf(BODIES));
  if (!bake) return;
  [...new Map(STATIONS.map(T => [T.key, T.req]))].forEach(([key, req]) => { if (!baker.ships.get(key)) baker.enqueue(key, false, req); });
  baker.pump();
}
setSystem(START_SYSTEM);
function stationReady(S) {
  if (S.s) return true;
  const s = baker.ships.get(S.key);
  if (!s || !s.ready || !s.tex) return false;
  S.s = s; S.half = s.maps.extent / 2; return true;
}
function playerTypeIndex(ship) {
  const q = ship || new URLSearchParams(location.search).get('ship') || 'ironhulls.civilian:c2'; // a used Copperhaul
  const [b, z] = q.split(':');
  const bi = Math.max(0, catalog.brands.findIndex(x => x.id === b)), zi = Math.max(0, catalog.sizes.findIndex(x => x.id === z));
  return bi * nSizes + zi;
}

// ---------- GL: instanced ships and plumes (same shaders as the lab's Fly tab), planets ----------
const FP = {
  ship: compile(FLY_SHIP_VS, derive(SHIP_FS, DERIVE.ship), { iA: 1, iB: 2 }),
  plume: compile(FLY_PLUME_VS, derive(PLUME_FS, DERIVE.plume), { iN: 1, iP: 2, iB: 3 }),
  planet: compile(PLANET_VS, PLANET_FS),
  star: compile(STARBODY_VS, STARBODY_FS),
  sheath: compile(SHEATH_VS, SHEATH_FS),
  orbiter: compile(ORBITER_VS, ORBITER_FS, { iA: 1, iB: 2 })
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

// ---------- input: keys -> one bitmask per tick ----------
const keys = new Set();
// assist level: 0 full assist, 1 drift off, 2 full off (the Book's three levels); Tab cycles (F too)
const ASSIST = [
  { hud: 'FULL ASSIST', toast: 'Full assist: W/S set speed, drift and gravity cancelled' },
  { hud: 'DRIFT OFF', toast: 'Drift off: raw thrust, Q/E strafe, X points retrograde' },
  { hud: 'FULL OFF', toast: 'Full off: as drift off, and spins persist until you counter-turn' }
];
let assistMode = 0, zoom = 1, bloomOn = true, nanView = 0, navOn = false;
const assist = () => assistMode === 0;
function setNav(on) { navOn = on; $('b-nav').setAttribute('aria-pressed', String(on)); }
// settings, kept in this browser; a new game starts from the assist level and overlay chosen here
const SETTINGS = Object.assign({ bloom: 1, nav: 0, assist: 0, debug: 1, quality: 0 }, (() => { try { return JSON.parse(localStorage.getItem('driftward.settings') || '{}'); } catch (e) { return {}; } })());
function applySettings() { bloomOn = !!SETTINGS.bloom; sceneStale = true; setRenderScale(); }
applySettings();
// the shell's screens over the game: the title, the pause menu, settings (on top of either)
const shellOpen = () => ['settings', 'pause', 'title'].find(id => !$(id).hidden) || null;
$('b-nav').onclick = () => { setNav(!navOn); canvas.focus(); };
window.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) { if (e.code === 'Escape') e.target.blur(); return; }
  if (barrierUp()) { e.preventDefault(); return; } // the world is stopped while the system's ships and stations bake
  if (noticeUp()) { if (['Enter', 'Space', 'Escape', 'NumpadEnter'].includes(e.code) && !e.repeat) closeNotice(); e.preventDefault(); return; }
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'F6', 'F9'].includes(e.code)) e.preventDefault();
  // the debug screen takes every key but its own: backquote opens and closes it, as does Esc
  if (e.code === 'Backquote' && !e.repeat) { if (debug.isOpen()) debug.close(); else { debug.open(); keys.clear(); } e.preventDefault(); return; }
  if (debug.isOpen()) { if (e.code === 'Escape') debug.close(); return; }
  // with a shell screen up, the game takes no keys: Esc and P step back out
  if (shellOpen()) { if (!e.repeat && (e.code === 'Escape' || e.code === 'KeyP')) shellBack(); return; }
  if (!keys.has(e.code)) {
    if (e.code === 'KeyP') pauseGame(true);
    if (e.code === 'Escape') onEscape();
    if (e.code === 'Tab' || e.code === 'KeyF') { assistMode = (assistMode + 1) % 3; toast(ASSIST[assistMode].toast); }
    if ((e.code === 'KeyQ' || e.code === 'KeyE') && assist()) toast('Strafe works with assist off: press Tab');
    // flight: T cycles ship targets, 1-9 pick from the location list, G flies to the target, M opens the map
    if (inFlight()) {
      if (e.code === 'KeyT') cycleTarget();
      if (e.code === 'KeyG') flyTo();
      if (e.code === 'KeyM') toggleMap();
      if (/^Digit[1-9]$/.test(e.code)) pickLocation(+e.code.slice(5));
    }
    if (e.code === 'KeyI' && !inPort()) setNav(!navOn);
    // debugging the flashing black squares: B toggles bloom (in flight; in port it is the bar), N paints bad scene
    // pixels (see postProcess)
    if (e.code === 'KeyB' || e.code === 'KeyN') sceneStale = true;
    if (e.code === 'KeyB' && !inPort()) { bloomOn = !bloomOn; toast(`Bloom ${bloomOn ? 'on' : 'off'}`); }
    if (e.code === 'KeyJ') toast(jitterToggle() ? 'Jitter probe: frame times, and motion jitter in pixels of a 1080p view (see src/play/jitter.js)' : 'Jitter probe off');
    if (e.code === 'KeyN') { nanView = 1 - nanView; toast(nanView ? 'NaN view: magenta = bad scene pixel, cyan = bad bloom, yellow = negative' : 'NaN view off'); }
    if (e.code === 'KeyL') landOrLaunch();
    if (e.code === 'Enter') skipSequence();
    if (e.code === 'KeyW' && inPort()) waitDay();
    if (e.code === 'KeyT' && inPort()) showPanel(panelOpen() === 'trade' ? null : 'trade');
    if (e.code === 'KeyM' && inPort()) showPanel(panelOpen() === 'board' ? null : 'board');
    if (e.code === 'KeyB' && inPort()) showPanel(panelOpen() === 'bar' ? null : 'bar');
    if (e.code === 'KeyI' && inPort()) showPanel(panelOpen() === 'about' ? null : 'about');
    if (e.code === 'F6') saveGame();
    if (e.code === 'F9') loadGame();
    if (e.code === 'Equal' || e.code === 'NumpadAdd') setZoom(zoom * 1.25);
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') setZoom(zoom / 1.25);
  }
  keys.add(e.code);
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
canvas.addEventListener('wheel', e => { e.preventDefault(); setZoom(zoom * Math.exp(-e.deltaY * 0.0012)); }, { passive: false });
function setZoom(z) { zoom = Math.max(0.25, Math.min(4, z)); }
function inputBits(IN) {
  const k = c => keys.has(c);
  return (k('KeyW') || k('ArrowUp') ? IN.thrust : 0) | (k('KeyS') || k('ArrowDown') ? IN.reverse : 0)
    | (k('KeyA') || k('ArrowLeft') ? IN.left : 0) | (k('KeyD') || k('ArrowRight') ? IN.right : 0)
    | (k('KeyQ') ? IN.strafeL : 0) | (k('KeyE') ? IN.strafeR : 0)
    | (k('ShiftLeft') || k('ShiftRight') ? IN.burn : 0) | (k('Space') ? IN.fire : 0) | (k('KeyX') ? IN.retro : 0)
    | (assistMode === 0 ? IN.assist : 0) | (assistMode === 2 ? IN.torque : 0);
}

// messages: a toast at the top, and in flight the message log (bottom left) keeps the last few
let toastT = 0;
const msgLog = [];
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2200);
  msgLog.push({ text: msg, at: performance.now() }); if (msgLog.length > 6) msgLog.shift();
}
const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// these need the core; bound once it loads
let saveGame = () => {}, loadGame = () => {}, landOrLaunch = () => {}, skipSequence = () => {}, waitDay = () => {}, inPort = () => false;
let inFlight = () => false, cycleTarget = () => {}, flyTo = () => {}, toggleMap = () => {}, pickLocation = () => {}, escapeFlight = () => false;
let pauseGame = () => {}, shellBack = () => {}, jitterToggle = () => false, barrierUp = () => false, noticeUp = () => false, closeNotice = () => {};
// Esc steps back: a sequence skips; in port, an open panel closes; in flight, the map closes, then the target
// clears; otherwise the game pauses
function onEscape() {
  if (skipSequence() === 0) return;
  if (inPort()) { if (panelOpen()) showPanel(null); else pauseGame(true); return; }
  if (inFlight() && escapeFlight()) return;
  pauseGame(true);
}
// the port screen's panels beside the port card, one at a time: the market, the mission board, the bar, about
const PANELS = ['trade', 'board', 'bar', 'about'];
const panelOpen = () => PANELS.find(p => !$(p).hidden) || null;
let showPanel = () => {};
const NUM = new Intl.NumberFormat('en-US'), fmtCr = n => NUM.format(n); // one formatter: toLocaleString builds one per call, and the HUD formats every frame

CORE_READY.then(CORE => {
  // body capacity: the schema's caps on bodies and belts, the star, and the most environmental stations a system holds
  const CFG = { maxShips: 128, maxTypes: 64, maxBodies: SYSTEM_SCHEMA.properties.bodies.maxItems + SYSTEM_SCHEMA.properties.belts.maxItems + 1 + MAX_ENVIRONS, envN: 16, envW: 40000, seed: 1 };
  const sim = CORE.world(CFG);
  const SH = sim.ship, IN = CORE.IN;
  types.forEach((T, k) => { sim.type.accel[k] = T.accel; sim.type.turn[k] = T.turn; sim.type.vmax[k] = T.vmax; sim.type.well[k] = T.well; sim.type.cargo[k] = T.cargo; });
  const CMD = CORE.CMD, MODE = CORE.MODE;
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
  function writeTraffic() {
    const M = sim.mix, B_ = sim.body, TCFG = SYS.traffic || {}; let m = 0;
    for (const k of ['stream', 'body', 'kind', 'weight', 'rate', 'dwell']) M[k].fill(0);
    const add = (stream, body, e, total) => {
      const cls = Object.entries(e.classes || {}).filter(([c, w]) => w > 0 && kindOf(e.line, c) >= 0), sum = cls.reduce((s, [, w]) => s + w, 0);
      for (const [c, w] of cls) { if (m >= sim.maxMix) { console.warn('traffic mix: too many rows'); return; } M.stream[m] = stream; M.body[m] = body; M.kind[m] = kindOf(e.line, c); M.weight[m] = total * w / sum; m++; }
    };
    (TCFG.local || []).forEach(e => add(TRAFFIC.mix.local, -1, e, e.share));
    (TCFG.through || []).forEach(e => add(TRAFFIC.mix.through, -1, e, e.share));
    (TCFG.loiter || []).forEach(e => { const j = BODIES.findIndex(b => b.id === e.port && b.port); if (j > 0) add(TRAFFIC.mix.loiter, j, e, e.count); });
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
    if (TCFG.ships !== undefined) sim.param('traffic_ships', TCFG.ships);
    if (TCFG.throughShare !== undefined) sim.param('share_through', TCFG.throughShare);
    if (TCFG.jumpRadius !== undefined) sim.param('jump_radius', TCFG.jumpRadius);
  }
  const mixKinds = () => [...new Set([...sim.mix.kind].filter((k, m) => sim.mix.stream[m]))];
  let bakeKinds = []; // every ship type the mix can fly, baked up front
  // Market prices: a port with a market trades what its role lists, at base price times the tier. Written at each new
  // game; a loaded save brings its own (prices are world state).
  if (GOODS.length > sim.maxGoods) console.error(`economy.json has ${GOODS.length} commodities; the core holds ${sim.maxGoods}`);
  function writePrices() {
    sim.market.price.fill(0);
    BODIES.forEach((b, j) => {
      if (!b.port || !(b.port.services || []).includes('market')) return;
      const table = ECON.roles[b.port.role] || {};
      GOODS.slice(0, sim.maxGoods).forEach((c, g) => { const t = table[c.id]; if (t) sim.market.price[j * sim.maxGoods + g] = Math.round(c.base * ECON.tiers[t]); });
    });
  }
  // orbiting debris and small traffic (core/src/orbit.rs, looks only): rocky worlds wear the most debris, the busier
  // a port the more traffic; look.debris scales a world's share
  function orbitersFor() {
    sim.orbitClear();
    // (a quarter of the first counts: enough to glitter, not a swarm); the ferries round the stations are below, unchanged
    const TRAFFIC_N = { outpost: 30, colony: 90, town: 225, world: 500 }, DEBRIS_N = { rock: 2250, terran: 625, giant: 750 };
    BODIES.forEach((b, j) => {
      if (b.kind !== 'planet' && b.kind !== 'moon') return;
      const L = b.look || {}, k = Math.min(1.6, Math.max(0.4, b.r / 1200));
      sim.orbitAdd(j, 0, Math.round((DEBRIS_N[L.surface] || 250) * k * L.debris), 1009 * j + 17);
      if (b.port) sim.orbitAdd(j, 1, Math.round((TRAFFIC_N[b.port.population] || 40) * L.orbitTraffic), 2027 * j + 5);
    });
    // ferries: specks coming and going between a world and its environmental stations, and between stations whose
    // route clears the world, a few to a route
    BODIES.forEach((w, j) => {
      if (w.kind !== 'planet' && w.kind !== 'moon') return;
      const st = BODIES.map((b, k) => [b, k]).filter(([b]) => b.env && b.parent === w.id);
      st.forEach(([s, k], n) => {
        const dx = s.x - w.x, dy = s.y - w.y, d = Math.hypot(dx, dy) || 1;
        sim.orbitFerries(j, w.x + dx / d * w.r * 0.97, w.y + dy / d * w.r * 0.97, s.x, s.y, w.r * 0.25, s.r * 0.3, 3, 3301 * k + 11);
        for (const [o, m] of st.slice(n + 1)) {
          // the closest the straight route comes to the world's centre
          const ex = o.x - s.x, ey = o.y - s.y, t = Math.max(0, Math.min(1, ((w.x - s.x) * ex + (w.y - s.y) * ey) / (ex * ex + ey * ey)));
          if (Math.hypot(s.x + ex * t - w.x, s.y + ey * t - w.y) > w.r * 1.15) sim.orbitFerries(j, s.x, s.y, o.x, o.y, s.r * 0.3, o.r * 0.3, 2, 7919 * k + 13 * m);
        }
      });
    });
  }
  // Every system is laid out in the core's live columns, as the one being played would be, and stored in the atlas
  // (core/src/atlas.rs), which keeps them all: a new game, a load or a jump then makes one live in the core alone.
  // bodies: the core places each on its orbit with its own trig (loadSystem lists parents first), and the page's
  // copies take the core's positions, so routes, wells and the drawing agree in every browser
  function layoutSystem(k) {
    setSystem(k, false);
    sim.setBodies(BODIES.length);
    BODIES.forEach((b, j) => {
      const B = sim.body; B.r[j] = b.r; B.g[j] = b.g; B.kind[j] = BODY_KIND[b.kind]; B.port[j] = b.port ? 1 : 0;
      if (j) sim.placeBody(j, BODIES.findIndex(p => p.id === b.parent), b.kind === 'belt' ? 0 : b.orbit.radius, b.orbit.angle); // a belt is centred on its parent
      b.x = B.x[j]; b.y = B.y[j];
      B.pop[j] = b.port ? TRAFFIC_DATA.population[b.port.population] || 1 : 0; // traffic's gravity model
    });
    for (const o of [...WORLDS, ...STATIONS]) { const b = BODIES.find(b => b.id === o.id); o.x = b.x; o.y = b.y; }
    writeTraffic(); writePrices();
    if (!sim.atlasStore(k)) console.error(`the atlas is full: system ${SYS.id} left out`);
  }
  SYSTEMS.forEach((_, k) => layoutSystem(k));
  // The page draws system k, live in the core: its rocks, orbiters, start port, the ship types its traffic flies, and
  // the views made from its bodies (systemViews, below: the location list's rows, the map's extent, the sky's colours)
  let startBody = 1;
  function showSystem(k) {
    setSystem(k);
    ({ list: ROCKS, grid: rockGrid, reach: rockReach } = rocksOf(SYSTEMS[k]));
    orbitersFor();
    startBody = Math.max(1, BODIES.findIndex(b => b.id === SYS.start && b.port), BODIES.findIndex(b => b.port));
    bakeKinds = mixKinds();
    systemViews();
    raiseBarrier();
  }
  // The system barrier: the world stops (the clock holds; the scene keeps drawing, blurred) behind a small dialog until
  // the system's stations, the hulls its traffic flies and the player's own are baked. The bakes themselves still run
  // on the worker pool as they always did; this only waits for them. A bake that fails counts as done, so it can't hang.
  let barrier = null; // { keys, total } while up
  const FACTION_NAME = { federation: 'The Federation', prism: 'Prism', ironhulls: 'The Ironhull Compact', blackhulls: 'The Blackhulls', freeflag: 'Freeflag', bloom: 'The Bloom', glass: 'The Glass', shadow: 'The Shadow', none: 'Unclaimed' };
  const PLURAL = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function raiseBarrier() {
    const st = [...new Set(STATIONS.map(T => T.key))], hulls = [...new Set([...bakeKinds, SH.kind[0]].map(k => types[k] && types[k].key).filter(Boolean))];
    hulls.forEach((key, n) => { const T = types.find(t => t.key === key); if (T) typeReady(T); }); // queue any not yet asked for
    barrier = { keys: [...st, ...hulls], total: st.length + hulls.length, st: st.length, hulls: hulls.length };
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
    $('barrier-note').textContent = `Baking ${PLURAL(barrier.st, 'station')} and ${PLURAL(barrier.hulls, 'hull')}: ${done} of ${barrier.total}`;
  }

  // replay recording: the snapshot at the start of the session plus every input change since
  let rec = null, lastBits = -1;
  function startRecording() { rec = { start: sim.save(), startTick: sim.tick(), log: [] }; lastBits = -1; }

  // A new game starts landed at the system's start port, as in EV. opts.space = [x, y] starts flying there instead
  // (tests and the debug hook use it).
  // opts.backdrop: the title's live view (no player ship, the shell stays up).
  let seedNow = 0;
  function newGame(seed, opts) {
    seedNow = seed === undefined ? (Math.random() * 4294967296) >>> 0 : seed >>> 0;
    sim.clear(); sim.reseed(seedNow);
    sim.atlasLoad(START_SYSTEM); showSystem(START_SYSTEM); // the start system, live in the core and drawn
    sim.setCount(1);
    SH.kind[0] = playerTypeIndex(opts && opts.ship); SH.alive[0] = 1; SH.ang[0] = 0; // opts.ship: 'faction.line:class' (dev and tests)
    sim.setPlayer(0);
    if (opts && opts.space) { SH.x[0] = opts.space[0]; SH.y[0] = opts.space[1]; sim.slotReset(0, true); }
    else { sim.slotReset(0, true); sim.placeLanded(startBody); }
    sim.game.day[0] = 1; // day one
    sim.game.credits[0] = ECON.start.credits; sim.game.debt[0] = ECON.start.debt; // a used ship and a debt to a lender
    sim.postBoards();
    sim.startTraffic(); // ambient traffic, already mid-flow
    raiseBarrier(); // again, now the player's hull is known
    camX = SH.x[0]; camY = SH.y[0]; lastMode = -1; // the next frame shows the port screen if landed
    navTarget = null; viewScale = 0; // the view snaps rather than glides to a new game
    if (sim.game.auto) sim.game.auto[0] = 0;
    if (opts && opts.backdrop) SH.alive[0] = 0; // nobody flies the title
    else { closeShell(); assistMode = SETTINGS.assist; setNav(!!SETTINGS.nav); zoom = 1; }
    missionSeen.set(sim.mission.state); closeNotice();
    startRecording();
  }
  // commands go through here: applied now (between ticks) and logged for replays when they take effect
  function command(code, a, b) {
    const r = sim.command(code, a || 0, b || 0);
    if (r === 0) rec.log.push([sim.tick(), 'cmd', code, a || 0, b || 0]);
    return r;
  }
  landOrLaunch = () => {
    const m = sim.mode();
    if (m === MODE.landed) { command(CMD.launch); return; }
    if (m !== MODE.flying) return;
    const r = command(CMD.land);
    if (r === 1) toast('Nothing to land on here: fly over a port');
    else if (r === 2) { const pb = sim.portBelow(), st = pb && BODIES[pb.body].kind === 'station'; toast(`Too fast to ${st ? 'dock' : 'land'}: slow below ${sim.param(st ? 'dock_speed' : 'land_speed')} m/s`); }
  };
  skipSequence = () => command(CMD.skip);
  waitDay = () => {
    const r = command(CMD.wait);
    if (r === 0) toast(`Day ${sim.day()}: docking fee ${fmtCr(sim.param('dock_fee'))} cr`);
    else if (r === 5) toast(`Can't pay the ${fmtCr(sim.param('dock_fee'))} cr docking fee`);
    refreshPort();
  };
  inPort = () => sim.mode() === MODE.landed;
  $('svc-wait').onclick = () => { waitDay(); canvas.focus(); };
  $('svc-trade').onclick = () => { showPanel(panelOpen() === 'trade' ? null : 'trade'); canvas.focus(); };
  $('svc-board').onclick = () => { showPanel(panelOpen() === 'board' ? null : 'board'); canvas.focus(); };
  $('svc-bar').onclick = () => { showPanel(panelOpen() === 'bar' ? null : 'bar'); canvas.focus(); };
  $('svc-about').onclick = () => { showPanel(panelOpen() === 'about' ? null : 'about'); canvas.focus(); };
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
    const err = sim.load(unb64(s));
    if (err) { toast(`Save is unreadable (error ${err}): saved by an older build?`); return false; }
    const meta = JSON.parse(localStorage.getItem(key + '.meta') || '{}');
    seedNow = meta.seed >>> 0;
    showSystem(sim.game.system[0]); // the save's system, live in the core already
    camX = SH.x[0]; camY = SH.y[0]; lastMode = -1; navTarget = null; viewScale = 0; missionSeen.set(sim.mission.state); closeNotice(); startRecording();
    closeShell(); assistMode = SETTINGS.assist; setNav(!!SETTINGS.nav);
    toast(`Loaded day ${sim.day()}`);
    return true;
  }
  loadGame = () => { if (!loadFrom('driftward.save') && !loadFrom('driftward.autosave')) toast('No saved game'); };
  // autosave on landing, as in EV (the Book: death reloads the last landing save)
  function autosave() { store('driftward.autosave'); }
  function exportReplay() {
    const ticks = sim.tick() - rec.startTick, hash = sim.hash();
    const log = `# driftward input log: replay with\n#   cargo run --release --bin replay -- driftward-save.bin driftward-inputs.txt ${ticks}\n# expect: tick ${sim.tick()} hash ${hash}\n` + rec.log.map(e => e[1] === 'cmd' ? `${e[0]} cmd ${e[2]} ${e[3]} ${e[4]}` : `${e[0]} ${e[1]}`).join('\n') + '\n';
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
    const H0 = BODIES[startBody];
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
  shellBack = () => { if (!$('settings').hidden) closeSettings(); else if (!$('pause').hidden) pauseGame(false); };
  $('p-resume').onclick = () => pauseGame(false);
  $('p-save').onclick = () => { saveGame(); pauseGame(false); };
  $('p-load').onclick = () => loadGame();
  $('p-replay').onclick = () => $('b-replay').onclick();
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
  $('b-replay').onclick = () => {
    const r = exportReplay();
    download('driftward-save.bin', r.save, 'application/octet-stream');
    download('driftward-inputs.txt', r.log, 'text/plain');
    toast(`Replay: ${r.ticks} ticks, hash ${r.hash}`); canvas.focus();
  };

  // ---------- frame ----------
  let last = 0, camX = 0, camY = 0, fps = 60, fpsAcc = 0, fpsN = 0, lastMode = -1;
  const JIT = makeJitter(CFG.maxShips); // motion smoothness, frame by frame (src/play/jitter.js; J shows it)
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
    if (!paused && !debug.isOpen() && !barrier && !notice) { // paused, debugging or behind the system barrier: the clock stops (the replay log is by tick, so a pause leaves no trace)
      const bits = inputBits(IN);
      if (bits !== lastBits) { sim.setInput(bits); rec.log.push([sim.tick(), bits]); lastBits = bits; }
      ran = sim.due(dt);
      for (let n = ran; n > 0; n--) sim.step();
    }
    const c1 = performance.now();
    sim.interpolate();
    const mode = sim.mode();
    if (mode !== lastMode) { onMode(mode, lastMode); lastMode = mode; }
    watchMissions();
    // the camera eases toward its target at the same rate whatever the frame rate: the exact exponential, so a long
    // frame (a hitch, a dropped frame) moves it as far as the short frames it replaced would have, with no lurch
    const k = 1 - Math.exp(-3.5 * dt);
    if (mode === MODE.landed) { const B = BODIES[sim.game.at[0]]; camX += (B.x - camX) * k; camY += (B.y - camY) * k; }
    else if (mode === MODE.flying) { const lead = 0.35; camX += (SH.rx[0] + SH.vx[0] * lead - camX) * k; camY += (SH.ry[0] + SH.vy[0] * lead - camY) * k; }
    else { const q = playerSeq().pose, lead = 0.35; camX += (q.x + q.vx * lead - camX) * k; camY += (q.y + q.vy * lead - camY) * k; } // following the curl, leading as in flight
    const yv = debug.yardView(); // the debug screen's Ships tab draws the shipyard instead of the game
    if (yv) { yard.render((now - t0) / 1000, yv.cells, yv.opts); G.postProcess(bloomOn ? 0.9 : 0, 0); hx.setTransform(1, 0, 0, 1, 0, 0); hx.clearRect(0, 0, hud.width, hud.height); return; }
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
      $('port-kicker').textContent = [B.name, P0.role.replace('-', ' '), P0.population].join(' · ');
      $('port-name').textContent = P0.name;
      const L = LORE.ports.get(B.id);
      $('port-desc').textContent = L ? L.description[0] : P0.description || '';
      $('svc-trade').disabled = !(P0.services || []).includes('market');
      $('svc-board').disabled = !(P0.services || []).includes('missions');
      $('svc-bar').disabled = !(P0.services || []).includes('bar') || !L;
      fillLore(B, L);
      showVista(B.id);
      port.hidden = false;
      showPanel(null);
      // newly landed (not a new game or a load): autosave. Any earlier mode counts, as a stalled frame or a test
      // stepping the sim directly can pass the whole descent between two frames
      if (prev !== -1 && prev !== MODE.landed) { autosave(); toast(`Landed at ${P0.name}: day ${sim.day()}, saved`); }
    } else { port.hidden = true; showVista(null); }
  }
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
  const portName = (j, s) => { const B = (s === undefined || s === sysK ? BODIES : SYSTEMS[s].loaded.bodies)[j]; return !B ? '?' : B.port ? B.port.name : B.name; };
  const missionDest = k => portName(MS.dest[k], MS.sys[k]) + (MS.sys[k] !== sysK && SYSTEMS[MS.sys[k]] ? ` (${SYSTEMS[MS.sys[k]].loaded.system.name})` : '');
  const activeHere = () => activeMissions().filter(k => MS.sys[k] === sysK); // the ones bound for this system's ports
  // a traffic route's end: a port, or jump zone z (coded -1 - z)
  const endName = c => c < 0 ? `the ${TRAFFIC.zones[-1 - c]} jump zone` : portName(c);
  const cargoText = (tons, g) => `${tons} t ${(GOODS[g] || { name: '?' }).name.toLowerCase()}`;
  const daysText = n => n <= 0 ? 'due today' : n === 1 ? '1 day' : `${n} days`;
  function refreshPort() {
    if (sim.mode() !== MODE.landed) return;
    $('port-day').textContent = `Day ${sim.day()} · ${SYS.name} system`;
    const nm = activeMissions().length;
    $('port-money').textContent = `${fmtCr(sim.credits())} cr · hold ${sim.holdUsed()}/${holdCap()} t · owe ${fmtCr(sim.debt())} cr` + (nm ? ` · ${nm} mission${nm > 1 ? 's' : ''}` : '');
    if (panelOpen() === 'board') refreshBoard();
    if (panelOpen() !== 'trade') return;
    const at = sim.game.at[0], room = holdCap() - sim.holdUsed(), cr = sim.credits();
    $('trade-sum').textContent = `${fmtCr(cr)} cr · hold ${sim.holdUsed()}/${holdCap()} t`;
    $('trade-rows').innerHTML = GOODS.map((c, g) => {
      const price = sim.price(at, g), aboard = sim.hold.tons[g];
      if (!price && !aboard) return '';
      const cls = !price ? 'none' : price < c.base ? 'low' : price > c.base ? 'high' : '';
      return `<tr><td>${c.name}</td><td class="num ${cls}">${price ? fmtCr(price) : 'not traded'}</td><td class="num">${aboard || ''}</td>`
        + `<td class="act"><button type="button" data-g="${g}" data-act="buy"${price && room > 0 && cr >= price ? '' : ' disabled'}>Buy</button>`
        + `<button type="button" data-g="${g}" data-act="sell"${price && aboard ? '' : ' disabled'}>Sell</button></td></tr>`;
    }).join('');
    const owe = sim.debt();
    $('trade-debt').textContent = owe ? `You owe the lender ${fmtCr(owe)} cr (${(sim.param('interest') * 100).toFixed(1)}% a day)` : 'You owe the lender nothing';
    $('repay-1k').disabled = !owe || cr < Math.min(1000, owe);
    $('repay-max').disabled = !owe || !cr;
  }
  // the board: offers at this port, then the player's missions
  function refreshBoard() {
    const at = sim.game.at[0], room = holdCap() - sim.holdUsed(), full = activeMissions().length >= NM;
    $('board-sum').textContent = `hold ${sim.holdUsed()}/${holdCap()} t · ${activeMissions().length}/${NM} missions`;
    let rows = '';
    for (let k = 0; k < NO; k++) {
      const o = at * NO + k;
      if (!OF.live[o]) continue;
      const fits = OF.tons[o] <= room;
      rows += `<tr><td>${portName(OF.dest[o])}<br><small>${BODIES[OF.dest[o]].name}</small></td><td>${cargoText(OF.tons[o], OF.good[o])}</td>`
        + `<td class="num">${fmtCr(OF.pay[o])}</td><td class="num">${daysText(OF.days[o])}</td>`
        + `<td class="act"><button type="button" data-k="${k}" data-act="accept"${fits && !full ? '' : ' disabled'} title="${full ? 'Carrying the most missions you can' : fits ? '' : 'Not enough room in the hold'}">Accept</button></td></tr>`;
    }
    $('board-rows').innerHTML = rows || '<tr><td class="empty" colspan="5">No offers today</td></tr>';
    $('mission-rows').innerHTML = activeMissions().map(k => `<tr><td>${missionDest(k)}</td><td>${cargoText(MS.tons[k], MS.good[k])}</td>`
      + `<td class="num">${fmtCr(MS.pay[k])}</td><td class="num ${MS.due[k] - sim.day() <= 1 ? 'high' : ''}">${daysText(MS.due[k] - sim.day())}</td>`
      + `<td class="act"><button type="button" data-k="${k}" data-act="abandon">Abandon</button></td></tr>`).join('')
      || '<tr><td class="empty">None</td></tr>';
  }
  showPanel = name => {
    for (const p of PANELS) {
      $(p).hidden = name !== p || $('svc-' + p).disabled;
      $('svc-' + p).setAttribute('aria-pressed', String(!$(p).hidden));
    }
    refreshPort();
  };
  // the debug screen's Player tab: a snapshot of the player's ship, flight, money, hold and missions
  debug.setLive(() => {
    const k = SH.kind[0], T = types[k], at = sim.game.at[0], mode = sim.mode(), landed = mode === MODE.landed, below = sim.portBelow();
    const ports = BODIES.map((b, j) => ({ j, b })).filter(o => o.b.port), price = (j, g) => sim.price(j, g);
    const missions = activeMissions().map(m => ({ k: m, dest: missionDest(m), good: (GOODS[MS.good[m]] || { name: '?' }).name.toLowerCase(), tons: MS.tons[m], pay: MS.pay[m], due: MS.due[m], left: MS.due[m] - sim.day() }));
    const missionTons = missions.reduce((n, m) => n + m.tons, 0);
    const goods = GOODS.map((c, g) => ({ name: c.name, base: c.base, aboard: Math.max(0, sim.hold.tons[g] - missions.filter(m => MS.good[m.k] === g).reduce((n, m) => n + m.tons, 0)), prices: ports.map(o => price(o.j, g)) }));
    const tradeTons = goods.reduce((n, g) => n + g.aboard, 0);
    return {
      ship: { name: T.name, kind: k, length: T.L, accel: sim.type.accel[k], turn: sim.type.turn[k], vmax: sim.type.vmax[k], well: sim.type.well[k], cargo: sim.type.cargo[k] },
      mode: Object.keys(MODE).find(m => MODE[m] === mode), assist: ASSIST[assistMode].hud.toLowerCase(),
      at: landed || mode !== MODE.flying ? portName(at) : '', below: mode === MODE.flying && below ? `${portName(below.body)}${below.slow ? ', slow enough to land' : ', too fast to land'}` : '',
      x: SH.x[0], y: SH.y[0], vx: SH.vx[0], vy: SH.vy[0], v: Math.hypot(SH.vx[0], SH.vy[0]), heading: ((SH.ang[0] * 180 / Math.PI) % 360 + 360) % 360, av: SH.av[0],
      set: sim.playerSet(), auto: sim.game.auto[0] ? BODIES[sim.game.auto[0] - 1].name : '',
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
    if (n === undefined) n = act === 'buy' ? Math.min(holdCap() - sim.holdUsed(), Math.floor(sim.credits() / Math.max(1, price))) : sim.hold.tons[g];
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

  // ---------- render ----------
  const MAXS = CFG.maxShips;
  const MAX_STATIONS = Math.max(1, ...SYSTEMS.map(S => S.stations.length)); // every system's were made by layoutSystem
  const VS = { ship: instVAO([4, 2], MAXS), station: instVAO([4, 2], MAX_STATIONS), plume: instVAO([4, 4, 2], MAXS * 12),
    orbiter: instVAO([4, 4], sim.orbitOut.length / 8), ghost: instVAO([4, 4], 8), speck: instVAO([4, 4], MAX_ROCKS) };
  const shipInst = new Float32Array(MAXS * 6), plumeInst = new Float32Array(MAXS * 12 * 10);
  const typeCount = new Int32Array(types.length), typeStart = new Int32Array(types.length), typeFill = new Int32Array(types.length);
  const LP = new Float32Array(64), LC = new Float32Array(64);
  const plCol = new Float32Array(51), plCore = new Float32Array(51), plP = new Float32Array(68), plSpread = new Float32Array(17), plBurn = new Float32Array(51);
  catalog.brands.slice(0, 16).forEach((b, k) => { const br = brandRender(b); plCol.set(br.plCol, k * 3); plCore.set(br.plCore, k * 3); plP.set([br.plTurb, br.plDia, br.plSput, br.plPulse], k * 4); plSpread[k] = br.plSpread; plBurn.set(br.plBurn, k * 3); });
  const RCS = 16; // the last look: cold thruster gas for the side, reverse and turning jets
  const spinVis = new Float32Array(MAXS); // per-slot turning-jet pulse, decaying (visual only)
  const turnSlew = sim.param('turn_slew');
  plCol.set(lin([0.72, 0.78, 0.88]), RCS * 3); plCore.set([1, 1, 1], RCS * 3); plP.set([0.5, 0, 0.25, 0], RCS * 4); plSpread[RCS] = 0.9; plBurn.set(plCol.subarray(RCS * 3, RCS * 3 + 3), RCS * 3);
  let sunCol = lin(star.col), starCol = sunCol; // the current system's star (systemViews)
  // the plume look tables are constant: set once on the program
  gl.useProgram(FP.plume.p);
  { const u = FP.plume.u; gl.uniform3fv(u.uPlCol, plCol); gl.uniform3fv(u.uPlCore, plCore); gl.uniform4fv(u.uPlP, plP); gl.uniform1fv(u.uPlSpread, plSpread); gl.uniform3fv(u.uPlBurn, plBurn); }
  const stInst = new Float32Array(MAX_STATIONS * 6);
  // rocks on screen: drawn as rocks (at most ROCK_DRAW), or under a pixel and a half across as specks of light
  const ROCK_DRAW = 3000, rockKit = makeRockKit(gl, compile, quad, ROCK_DRAW), rockInst = new Float32Array(ROCK_DRAW * ROCK_STRIDE);
  const rockSeen = [], speckInst = new Float32Array(MAX_ROCKS * 8);
  const sunCam = new Float32Array(3), sunAt = new Float32Array(3); // sunFrom's results, reused
  const nearW = new Int32Array(4); // the star dimming's nearest worlds
  const dimU = new Float32Array(16); // worlds the sky dims its stars round: screen x, y, radius (px)
  // lens ghosts per flare: [distance along the flare-to-centre line (1 is the far side), size in px at 900 px tall, tint]
  const GHOSTS = [[-0.35, 9, 0.8], [0.4, 22, 0.2], [0.75, 12, 0.9], [1.25, 38, 0.35]], ghostInst = new Float32Array(2 * 4 * 8);
  // draw order: largest classes first, so small ships sit on top
  const order = types.map((_, k) => k).sort((a, b) => types[b].zi - types[a].zi);
  let scale = 1;
  const sheaths = []; // [slot, sequence look] to draw this frame (reused)
  const LAUNCH_S = sim.launchS, DESCENT_S = sim.descentS;
  const TR = sim.traffic;
  // a landing or launch sequence's look at d (0 in flight .. 1 down) over body B: hull scale, plasma heat, fade-out
  // into the atmosphere's tint
  const ATM_NONE = [0.6, 0.7, 0.8];
  let atmOf = new Map(); // body -> its atmosphere's colour, for the sheath (systemViews)
  function seqLook(d, B) {
    const st = B.kind === 'station', ss = x => x * x * (3 - 2 * x), seg = (a, b, x) => ss(Math.max(0, Math.min(1, (x - a) / (b - a))));
    return { sc: st ? 1 - 0.45 * seg(0, 1, d) : 1 - 0.85 * seg(0.08, 1, d), heat: st ? 0 : seg(0, 0.2, d) * (1 - seg(0.88, 1, d)), fade: seg(0.5, 0.95, d), atm: atmOf.get(B) || ATM_NONE };
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
    const T = landing ? DESCENT_S : LAUNCH_S, p = seqProgress(sim.game.timer[0], T), x = SH.x[0], y = SH.y[0];
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
    return { p, B, landing, pose: seqPose(i, landing, p, SH.x[i], SH.y[i], SH.ang[i], roundDir(B, SH.x[i], SH.y[i], hx, hy), landing ? 0 : TR.cruise[i], B, T) };
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
    sunFrom(cx, cy, sunCam); const sl = Math.hypot(sunCam[0], sunCam[1]) || 1;
    const halfW = RW / scale / 2, halfH = RH / scale / 2;
    const TW = G.targets.scene.w, TH = G.targets.scene.h, ss = sceneScale = scale * TW / RW; // the scene target, and px per m in it
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, G.targets.scene.f); gl.viewport(0, 0, TW, TH);
    gl.disable(gl.BLEND);
    gl.useProgram(P.bg.p);
    gl.uniform2f(P.bg.u.uRes, TW, TH); gl.uniform1f(P.bg.u.uTime, t);
    gl.uniform3fv(P.bg.u.uStar, star.col); gl.uniform3fv(P.bg.u.uNeb, star.neb);
    gl.uniform2f(P.bg.u.uSunDir, sunCam[0] / sl, sunCam[1] / sl);
    gl.uniform2f(P.bg.u.uOff, cx * ss * 0.04, cy * ss * 0.04);
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

    // the star
    if (Math.abs(STAR.x - cx) < halfW + STAR.r * 2.4 && Math.abs(STAR.y - cy) < halfH + STAR.r * 2.4) {
      setView(FP.star, TW, TH, cx, cy);
      const u = FP.star.u;
      gl.uniform2f(u.uC, STAR.x, STAR.y); gl.uniform1f(u.uR, STAR.r); gl.uniform3fv(u.uCol, starCol);
      gl.uniform1f(u.uTime, t); gl.uniform1f(u.uPx, 1 / (STAR.r * ss));
      draw();
    }
    // planets and moons, each lit from the star's direction
    setView(FP.planet, TW, TH, cx, cy);
    { const u = FP.planet.u;
      gl.uniform3fv(u.uSunCol, sunCol); gl.uniform3fv(u.uAmb, star.amb); gl.uniform1f(u.uTime, t);
      for (const p of WORLDS) {
        if (Math.abs(p.x - cx) > halfW + p.r * p.ext || Math.abs(p.y - cy) > halfH + p.r * p.ext) continue;
        gl.uniform3fv(u.uSun, sunFrom(p.x, p.y, sunAt));
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
      if (nr) { rockKit.begin({ res: [TW, TH], cam: [cx, cy], scale: ss, time: t, star: [STAR.x, STAR.y], sunCol, amb: star.amb }); rockKit.draw(rockInst, nr); }
      if (ns) {
        gl.blendFunc(gl.ONE, gl.ONE);
        setView(FP.orbiter, TW, TH, cx, cy); gl.uniform1f(FP.orbiter.u.uTime, t); gl.uniform3fv(FP.orbiter.u.uSunCol, sunCol);
        gl.bindVertexArray(VS.speck.vao); upload(VS.speck, speckInst, ns); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ns); gl.bindVertexArray(null);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
    }
    // orbiters: the core places them and keeps only what can be seen; then lens ghosts for the brightest flares, along
    // the line from the flare through the middle of the screen
    { const n = sim.orbitEval((sim.tick() + sim.alpha()) * sim.DT, STAR.x, STAR.y, cx, cy, halfW, halfH, 0.06 / scale);
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
        plumeInst[o + 4] = E.w * T.br.plLen * (0.5 + 2.6 * th) * (1 + 1.2 * bi); plumeInst[o + 5] = E.w * T.br.plWid * 1.35 * (1 + 0.3 * bi);
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
      shipInst[o + 3] = SH.thr[i]; shipInst[o + 4] = 0; shipInst[o + 5] = q ? q.sc : 0;
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
  // the nav target bottom-right; the message log bottom-left; prompts bottom centre. (Ship status, and radar
  // contacts at their sensor error radius, wait for damage, fuel and sensors in the core.)
  function drawHUD() {
    hx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hx.clearRect(0, 0, W, H);
    const mode = sim.mode();
    $('loc').hidden = mode !== MODE.flying || mapOn || titleUp();
    if ((mode !== MODE.flying || titleUp()) && mapOn) toggleMap(false);
    if (mode === MODE.landed || titleUp()) return; // the port screen is the HUD; the title has none
    if (mode !== MODE.flying) { // in a landing or launch sequence: the day and how to skip it
      hx.font = '600 12px "IBM Plex Mono", ui-monospace, monospace'; hx.textBaseline = 'middle'; hx.textAlign = 'center';
      const B = BODIES[sim.game.at[0]];
      label(`${mode === MODE.descending ? (B.kind === 'station' ? 'DOCKING AT' : 'LANDING AT') : 'LAUNCHING FROM'} ${B.port.name.toUpperCase()}  ·  ENTER TO SKIP`, W / 2, H - stripH - 40);
      hx.textAlign = 'left'; return;
    }
    const T0 = types[SH.kind[0]], sp = Math.hypot(SH.vx[0], SH.vy[0]), hd = ((-SH.ang[0] * 180 / Math.PI) % 360 + 360) % 360;
    const burn = SH.burn[0] && SH.main[0] > 0;
    // top speed along the nose here, by the core's rule: raised pointing into a well, lowered pointing out
    const nx0 = -Math.sin(SH.ang[0]), ny0 = Math.cos(SH.ang[0]), cIn = nx0 * SH.well_x[0] + ny0 * SH.well_y[0];
    const wk = SH.well[0] * T0.well * (sim.param('well_in') * Math.max(cIn, 0) - sim.param('well_out') * Math.max(-cIn, 0));
    const topNow = Math.max(0.15, 1 + wk) * T0.vmax * (burn ? sim.param('burn_cap') : 1);
    const auto = sim.game.auto[0] - 1;
    const lines = [
      [`DAY ${sim.day()}  ·  ${fmtCr(sim.credits())} CR  ·  HOLD ${sim.holdUsed()}/${holdCap()} T`, '#dbe0e7'],
      [`SPD ${sp.toFixed(0).padStart(4)} / ${topNow.toFixed(0)} m/s${assist() ? `  SET ${sim.playerSet().toFixed(0)}` : ''}`, wk < -0.03 ? '#e08a4a' : wk > 0.03 ? '#7fd08a' : '#dbe0e7'],
      [`HDG ${hd.toFixed(0).padStart(3, '0')}°  ${ASSIST[assistMode].hud}${burn ? '  BURN' : ''}`, burn ? '#e2b866' : assistMode ? '#c8a27a' : '#8a95a4'],
      [`${T0.name.toUpperCase()}${SETTINGS.debug ? `  ·  TICK ${sim.tick()}  ${fps.toFixed(0)} fps${renderScale < 1 ? `  res ${Math.round(renderScale * 100)}%` : ''}` : ''}`, '#8a95a4']
    ];
    hx.font = '500 11.5px "IBM Plex Mono", ui-monospace, monospace'; hx.textBaseline = 'middle';
    // under the nearest-body line: the autopilot, then the active missions with days left
    const ms = activeMissions().map(k => { const left = MS.due[k] - sim.day(); return [`→ ${missionDest(k).toUpperCase()}  ${MS.tons[k]} T  ${fmtCr(MS.pay[k])} CR  ${daysText(left).toUpperCase()}`, left <= 1 ? NAV_HOT : MIS_COL]; });
    if (auto >= 0) ms.unshift([`AUTOPILOT → ${BODIES[auto].name.toUpperCase()}  ·  STICK TO TAKE OVER`, '#7fd08a']);
    hx.fillStyle = 'rgba(7,9,12,.55)'; hx.fillRect(6, 6, 340, (lines.length + ms.length) * 17 + 31); // + the nearest-body line
    lines.forEach(([t, c], k) => { hx.fillStyle = c; hx.fillText(t, 14, 20 + k * 17); });
    ms.forEach(([t, c], k) => { hx.fillStyle = c; hx.fillText(t, 14, 20 + (lines.length + 1 + k) * 17); });
    if (!typeReady(T0)) { hx.fillStyle = '#e2b866'; hx.fillText('Baking your ship…', 14, 20 + lines.length * 17 + 28); }
    drawShipMarks(T0);
    drawLandingPrompt();
    const navs = navObjects().map(o => Object.assign(o, navInfo(o)));
    drawNav(navs);
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
    hx.lineWidth = 1.5;
    if (sp > 1) {
      const len = 30 + 60 * Math.min(1.3, sp / T0.vmax), ux = SH.vx[0] / sp, uy = -SH.vy[0] / sp;
      hx.strokeStyle = 'rgba(226,184,102,.8)';
      hx.beginPath(); hx.moveTo(cx + ux * r0, cy + uy * r0); hx.lineTo(cx + ux * (r0 + len), cy + uy * (r0 + len)); hx.stroke();
      hx.beginPath(); hx.arc(cx + ux * (r0 + len), cy + uy * (r0 + len), 4, 0, 6.283); hx.stroke();
    }
    const nx = -Math.sin(SH.ra[0]), ny = -Math.cos(SH.ra[0]); // nose direction on screen
    if (assist()) {
      const len = 30 + 60 * Math.min(1.3, sim.playerSet() / T0.vmax), qx = cx + nx * (r0 + len), qy = cy + ny * (r0 + len);
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

  // over a port: say so, and whether the ship is slow enough to land (the Book: be over it and nearly still)
  function drawLandingPrompt() {
    const pb = sim.portBelow();
    if (!pb) return;
    const B = BODIES[pb.body], st = B.kind === 'station', limit = sim.param(st ? 'dock_speed' : 'land_speed');
    hx.font = '600 13px "IBM Plex Mono", ui-monospace, monospace'; hx.textAlign = 'center'; hx.textBaseline = 'middle';
    hx.fillStyle = pb.slow ? '#7fd08a' : '#e2b866';
    label(pb.slow ? `L  ${st ? 'DOCK AT' : 'LAND AT'} ${B.port.name.toUpperCase()}` : `${B.port.name.toUpperCase()}: SLOW BELOW ${limit} M/S TO ${st ? 'DOCK' : 'LAND'}`, W / 2, H - stripH - 40);
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
    return BODIES.map((b, j) => { const [x, y] = navPoint(j, SH.rx[0], SH.ry[0]); return { j, name: b.port ? `${b.name} (${b.port.name})` : b.name, short: b.name, x, y, r: navReach(b), kind: b.kind, port: !!b.port, mission: dest.has(j), env: !!b.env, rocky: rocky(b) }; })
      .filter(o => !o.env); // environmental stations are scenery: on the map and radar, not in the overlay
  };
  function navInfo(o) {
    const dx = o.x - SH.rx[0], dy = o.y - SH.ry[0], d = Math.hypot(dx, dy) || 1;
    return { d, surf: d - o.r, closing: (SH.vx[0] * dx + SH.vy[0] * dy) / d }; // surface distance; closing speed > 0
  }
  const fmtDist = m => m < 1000 ? `${Math.max(0, m).toFixed(0)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
  const fmtClose = v => Math.abs(v) < 1 ? '' : `${v > 0 ? 'closing' : 'opening'} ${Math.abs(v).toFixed(0)} m/s`;
  const toScreen = (x, y) => [(x - camX) * scale / dpr + W / 2, H / 2 - (y - camY) * scale / dpr];
  const NAV_COL = '#9fb4c8', NAV_HOT = '#e2b866', MIS_COL = '#8fd3ff', TGT_COL = '#e2b866'; // mission destinations in light blue
  // text with a dark outline, readable over bright cloud tops
  function label(text, x, y) { hx.lineWidth = 3.5; hx.lineJoin = 'round'; hx.strokeStyle = 'rgba(7,9,12,.85)'; hx.strokeText(text, x, y); hx.fillText(text, x, y); }
  // the inset box off-screen markers sit on, and where the line from the view centre to (sx, sy) leaves it
  function edgePoint(sx, sy) {
    const m = 34, x0 = m, y0 = m, x1 = W - m, y1 = H - stripH - m, cx = W / 2, cy = (H - stripH) / 2;
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

  // The status line names the nearest body; with the overlay on (I), every body gets a label where it is on
  // screen, or an arrow on the screen edge pointing at it, with surface distance and closing speed.
  function drawNav(navs) {
    let near = navs[0];
    for (const o of navs) if (o.surf < near.surf) near = o;
    hx.font = '600 12px "IBM Plex Mono", ui-monospace, monospace';
    hx.fillStyle = near.surf <= 0 ? NAV_HOT : NAV_COL;
    const well = SH.well[0]; // strength of the well here (1: a full-strength planet's surface)
    hx.fillText((near.surf <= 0 ? `${near.rocky ? 'IN' : 'OVER'} ${near.name.toUpperCase()}` : `NEAREST ${near.name.toUpperCase()} ${fmtDist(near.surf)}`) + (well > 0.01 ? `  WELL ${Math.round(well * 100)}%` : ''), 14, 20 + 4 * 17);
    if (!navOn) return;
    hx.textBaseline = 'middle';
    for (const o of navs) {
      const [sx, sy] = toScreen(o.x, o.y), hot = o.surf <= 0, col = hot ? NAV_HOT : o.mission ? MIS_COL : NAV_COL;
      const name = (o.mission ? 'DELIVER: ' : '') + o.name.toUpperCase(), sub = hot ? (o.rocky ? 'IN IT' : 'OVER') : `${fmtDist(o.surf)}  ${fmtClose(o.closing)}`.trim();
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
      hx.font = '600 12px "IBM Plex Mono", ui-monospace, monospace'; label(name, lx, ly - 7);
      hx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace'; label(sub, lx, ly + 8);
    }
    hx.textAlign = 'left';
  }

  // ---------- targeting ----------
  // The nav target is the page's (what the panels show); only flying to it is a core command. A body target is
  // { body: j }; a ship target holds the core's handle, so it lapses when the ship lands and its slot is reused.
  let navTarget = null;
  function setTarget(t, quiet) {
    navTarget = t;
    if (!quiet && t) toast(`Target: ${targetName(t)}`);
  }
  const targetBody = () => navTarget && navTarget.body !== undefined ? navTarget.body : -1;
  const targetShip = () => navTarget && navTarget.ship !== undefined ? sim.resolve(navTarget.ship) : -1;
  // a traffic ship by its hull: the faction and the line's name for its class (Ironhulls Brasshaul)
  function targetName(t) {
    if (t.body !== undefined) { const B = BODIES[t.body]; return B.port ? `${B.name} (${B.port.name})` : B.name; }
    const i = sim.resolve(t.ship);
    if (i < 0) return 'lost';
    const T = types[SH.kind[i]];
    return T ? `${T.brand.factionName.replace(/^The /, '')} ${T.name}` : 'ship';
  }
  // T: ships within radar range, nearest first; each press takes the next
  cycleTarget = () => {
    const px = SH.rx[0], py = SH.ry[0], list = [];
    for (let i = 1; i < sim.count(); i++) if (SH.alive[i] && Math.hypot(SH.rx[i] - px, SH.ry[i] - py) < MAP_RANGE) list.push(i);
    if (!list.length) { toast('No ships on the radar'); return; }
    list.sort((a, b) => Math.hypot(SH.rx[a] - px, SH.ry[a] - py) - Math.hypot(SH.rx[b] - px, SH.ry[b] - py));
    const cur = targetShip(), k = list.indexOf(cur);
    setTarget({ ship: sim.handle(list[(k + 1) % list.length]) });
  };
  // G: the autopilot to the target body, under full assist; G again disengages
  flyTo = () => {
    const j = targetBody();
    if (sim.game.auto[0] > 0) { command(CMD.autopilot, -1); toast('Autopilot off'); return; }
    if (j < 0) { toast('Pick a body to fly to: a location (1-9) or the map (M)'); return; }
    if (!assist()) { toast('The autopilot flies under full assist: press Tab'); return; }
    if (command(CMD.autopilot, j) === 0) toast(`Autopilot: flying to ${targetName(navTarget)}`);
  };
  // The debug jump (the debug screen's jump box, and tests): to system k, at rest over its body j, flying. A logged core
  // command (core/src/atlas.rs), so saves and replays follow it.
  function jumpTo(k, j) {
    const r = command(CMD.jump, k, j);
    if (r !== 0) { toast(`Can't jump there: ${CORE.RESULT[r] || r}`); return r; }
    showSystem(k); closeNotice();
    camX = SH.x[0]; camY = SH.y[0]; lastMode = -1; viewScale = 0;
    toast(`Jumped to ${BODIES[j].name}, ${SYS.name} system`);
    return r;
  }
  // every place a jump can go: each system's bodies but its star
  const jumpPlaces = () => SYSTEMS.flatMap((S, k) => S.loaded.bodies.map((b, j) => ({ k, j, id: b.id, place: b.name, port: b.port ? b.port.name : '', kind: b.kind, system: S.loaded.system.name, sysId: S.id })).filter(p => p.j > 0));
  // each system, arriving over its start port (the jump box's *@system)
  const jumpSystems = () => SYSTEMS.map((S, k) => { const B = S.loaded.bodies, j = Math.max(1, B.findIndex(b => b.id === S.loaded.system.start && b.port), B.findIndex(b => b.port));
    return { k, j, id: B[j].id, place: B[j].name, port: B[j].port ? B[j].port.name : '', kind: B[j].kind, system: S.loaded.system.name, sysId: S.id }; });
  debug.setJump({ places: jumpPlaces, systems: jumpSystems, current: () => sysK, go: (k, j) => { const r = jumpTo(k, j); if (r === 0) debug.close(); return r; } });
  escapeFlight = () => {
    if (mapOn) { toggleMap(false); return true; }
    if (navTarget) { setTarget(null); toast('Target cleared'); return true; }
    return false;
  };
  inFlight = () => sim.mode() === MODE.flying;

  // the target, marked where it is: corner brackets round it on screen, or an arrow on the screen edge
  function drawTargetMark() {
    let x, y, r;
    const j = targetBody(), i = targetShip();
    if (j >= 0) { [x, y] = navPoint(j, SH.rx[0], SH.ry[0]); r = navReach(BODIES[j]) * scale / dpr; }
    else if (i >= 0) { x = SH.rx[i]; y = SH.ry[i]; r = Math.max(12, types[SH.kind[i]].half * scale / dpr * 1.2); }
    else { if (navTarget && navTarget.ship !== undefined) { setTarget(null); toast('Target lost: it landed'); } return; }
    const [sx, sy] = toScreen(x, y), e = edgePoint(sx, sy);
    if (e) { edgeArrow(e, TGT_COL); return; }
    const k = Math.min(r * 0.4, 16);
    hx.strokeStyle = TGT_COL; hx.lineWidth = 1.5;
    for (const [ux, uy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const cx = sx + ux * r, cy = sy + uy * r;
      hx.beginPath(); hx.moveTo(cx - ux * k, cy); hx.lineTo(cx, cy); hx.lineTo(cx, cy - uy * k); hx.stroke();
    }
  }

  // Nav target panel, bottom right: what it is, range, relative speed, and for a port whether you are clear to land.
  function drawTarget() {
    const j = targetBody(), i = targetShip();
    if (j < 0 && i < 0) return;
    const w = 268, x = W - w - 14, rows = [];
    let range, close, title, sub;
    if (j >= 0) {
      const B = BODIES[j], [nx, ny] = navPoint(j, SH.rx[0], SH.ry[0]), o = navInfo({ x: nx, y: ny, r: navReach(B) });
      title = B.port ? B.port.name : B.name;
      sub = [B.name !== title ? B.name : '', B.kind, B.port ? B.port.role.replace('-', ' ') : '', B.belt ? B.belt.rocks.map(k => ROCK_TYPES[k].label.toLowerCase()).join(', ') : ''].filter(Boolean).join(' · ');
      range = fmtDist(o.surf); close = o.closing;
      if (B.port) {
        const pb = sim.portBelow(), st = B.kind === 'station', limit = sim.param(st ? 'dock_speed' : 'land_speed');
        if (pb && pb.body === j) rows.push(pb.slow ? [`CLEAR TO ${st ? 'DOCK' : 'LAND'}  ·  L`, '#7fd08a'] : [`SLOW BELOW ${limit} M/S TO ${st ? 'DOCK' : 'LAND'}`, NAV_HOT]);
        else rows.push([`${st ? 'DOCK' : 'LAND'} OVER IT BELOW ${limit} M/S`, '#8a95a4']);
      }
      if (activeHere().some(k => MS.dest[k] === j)) rows.push(['MISSION DESTINATION', MIS_COL]);
      if (sim.game.auto[0] - 1 === j) rows.push(['AUTOPILOT ENGAGED', '#7fd08a']);
      else if (!rows.length || B.port) rows.push(['G  FLY TO IT', '#8a95a4']);
    } else {
      const dx = SH.rx[i] - SH.rx[0], dy = SH.ry[i] - SH.ry[0], d = Math.hypot(dx, dy) || 1;
      title = targetName(navTarget);
      sub = TR.role[i] === 4 && TR.phase[i] === TRAFFIC.cruise ? `loitering round ${endName(TR.to[i])}` : `${TR.phase[i] === TRAFFIC.launch ? 'launching from' : TR.phase[i] === TRAFFIC.land ? 'landing at' : TR.to[i] < 0 ? 'leaving by' : 'bound for'} ${endName(TR.phase[i] === TRAFFIC.launch ? TR.from[i] : TR.to[i])}`;
      range = fmtDist(d); close = ((SH.vx[0] - SH.vx[i]) * dx + (SH.vy[0] - SH.vy[i]) * dy) / d;
      rows.push([`SPEED ${Math.hypot(SH.vx[i], SH.vy[i]).toFixed(0)} M/S`, '#8a95a4']);
    }
    const h = 64 + rows.length * 16, y = H - stripH - h - 14;
    hx.fillStyle = 'rgba(7,9,12,.72)'; hx.fillRect(x, y, w, h);
    hx.strokeStyle = 'rgba(226,184,102,.55)'; hx.lineWidth = 1; hx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    hx.textBaseline = 'middle'; hx.textAlign = 'left';
    hx.fillStyle = '#8a95a4'; hx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace'; hx.fillText('NAV TARGET', x + 10, y + 12);
    hx.fillStyle = TGT_COL; hx.font = '600 13px "IBM Plex Mono", ui-monospace, monospace'; hx.fillText(title.toUpperCase().slice(0, 30), x + 10, y + 28);
    hx.fillStyle = '#9fb4c8'; hx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace'; hx.fillText(sub.slice(0, 40), x + 10, y + 43);
    hx.fillStyle = '#dbe0e7'; hx.fillText(`RANGE ${range}   ${Math.abs(close) < 1 ? 'HOLDING' : `${close > 0 ? 'CLOSING' : 'OPENING'} ${Math.abs(close).toFixed(0)} M/S`}`, x + 10, y + 58);
    rows.forEach(([t, c], k) => { hx.fillStyle = c; hx.fillText(t, x + 10, y + 74 + k * 16); });
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
  // The Book: the star, planets and free-orbiting stations in orbital order; the body whose local zone the player is
  // in (ZONE_IN radii, left at ZONE_OUT) expands to show its moons and stations. A row shows the range and landable,
  // dockable and mission markers; a click or its number key sets the nav target. Belts and fields take their place in
  // the order (a belt by its ring's radius), the range to a belt is to its nearest edge.
  const ZONE_IN = 6, ZONE_OUT = 7;
  const orbitOf = j => { const B = BODIES[j], P = BODIES.find(o => o.id === B.parent) || STAR; return B.kind === 'belt' ? B.r : Math.hypot(B.x - P.x, B.y - P.y); };
  let TOP = [], KIDS = []; // the current system's rows (systemViews)
  function locationRows() {
    TOP = BODIES.map((_, j) => j).filter(j => j === 0 || BODIES[j].parent === STAR.id).sort((a, b) => orbitOf(a) - orbitOf(b));
    // a body's moons, stations, belts and fields, nearest first; the star's are top-level rows already, so it has none
    KIDS = TOP.map(p => BODIES.map((_, j) => j).filter(j => p !== 0 && BODIES[j].parent === BODIES[p].id && !BODIES[j].env).sort((a, b) => orbitOf(a) - orbitOf(b)));
  }
  const ICON = { star: '✹', planet: '●', moon: '•', station: '◇', belt: '◌', field: '⁘' };
  // the range to a body's surface, a field's rim or a belt's nearer edge (0 inside)
  const surfFrom = (j, px, py) => { const B = BODIES[j], d = Math.hypot(B.x - px, B.y - py); return B.kind === 'belt' ? Math.abs(d - B.r) - B.belt.width / 2 : d - B.r; };
  let expanded = -1, locRows = [], locAt = 0;
  function refreshLocations() {
    const now = performance.now();
    if (now - locAt < 250) return; // a few times a second is plenty, and keeps clicks landing on stable rows
    locAt = now;
    const px = SH.rx[0], py = SH.ry[0], dist = j => Math.hypot(BODIES[j].x - px, BODIES[j].y - py);
    if (expanded >= 0 && dist(TOP[expanded]) > BODIES[TOP[expanded]].r * ZONE_OUT) expanded = -1;
    if (expanded < 0) TOP.forEach((p, k) => { if (KIDS[k].length && dist(p) < BODIES[p].r * ZONE_IN) expanded = k; });
    locRows = [];
    TOP.forEach((p, k) => { locRows.push([p, false]); if (k === expanded) KIDS[k].forEach(c => locRows.push([c, true])); });
    const dest = new Set(activeHere().map(k => MS.dest[k])), tb = targetBody();
    const el = $('loc');
    el.style.top = `${radarBox().y + radarBox().h + 12}px`;
    el.innerHTML = locRows.map(([j, child], n) => {
      const B = BODIES[j], tags = (B.port ? `<span class="tag">${B.kind === 'station' ? 'DOCK' : 'LAND'}</span>` : '') + (dest.has(j) ? '<span class="tag m">◆</span>' : '');
      return `<button type="button" data-j="${j}" class="${child ? 'child' : ''}${j === tb ? ' target' : ''}"><span class="n">${n < 9 ? n + 1 : ''}</span><span class="ico">${ICON[B.kind] || '•'}</span>`
        + `<span>${B.name}${tags}</span><span class="r">${fmtDist(surfFrom(j, px, py))}</span></button>`;
    }).join('');
  }
  pickLocation = n => { const row = locRows[n - 1]; if (row) setTarget({ body: row[0] }); locAt = 0; };
  $('loc').addEventListener('pointerdown', e => {
    const b = e.target.closest('button[data-j]');
    if (b) { setTarget({ body: +b.dataset.j }); locAt = 0; e.preventDefault(); canvas.focus(); }
  });

  // ---------- radar (top right) ----------
  // North up, centred on the player, bodies to scale; anything beyond the range sits on the rim. Ships appear only
  // here (the Book), as dots; the target is ringed.
  const MAP_RANGE = 24000; // meters from centre to rim
  const STN_PX = 4.5; // the smallest a station draws on the radar (px from centre to corner): to scale it would be a dot
  function stationMark(x, y, r) { hx.beginPath(); hx.moveTo(x, y - r); hx.lineTo(x + r, y); hx.lineTo(x, y + r); hx.lineTo(x - r, y); hx.closePath(); }
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
    // environmental stations: not in the nav list, but on the radar as smaller, fainter diamonds, unlabelled
    for (let j = 0; j < BODIES.length; j++) {
      const B = BODIES[j];
      if (!B.env) continue;
      const mx = (B.x - px) * k, my = -(B.y - py) * k, rr = Math.max(STN_PX * 0.8, B.r * k);
      if (Math.hypot(mx, my) - rr > R) continue;
      stationMark(cx + mx, cy + my, rr);
      hx.fillStyle = j === tb ? NAV_HOT : 'rgba(159,180,200,.65)'; hx.fill();
    }
    for (let i = 1; i < sim.count(); i++) { // slot 0 is the player
      if (!SH.alive[i]) continue;
      const mx = (SH.rx[i] - px) * k, my = -(SH.ry[i] - py) * k;
      if (mx * mx + my * my > R * R) continue;
      hx.fillStyle = 'rgba(219,224,231,.75)'; hx.fillRect(cx + mx - 1.25, cy + my - 1.25, 2.5, 2.5);
      if (i === ts) { hx.strokeStyle = TGT_COL; hx.lineWidth = 1.5; hx.beginPath(); hx.arc(cx + mx, cy + my, 5, 0, 6.283); hx.stroke(); }
    }
    // the player: velocity line and heading arrow (world y up, screen y down)
    const vx = SH.vx[0] * k * 6, vy = -SH.vy[0] * k * 6;
    hx.strokeStyle = 'rgba(226,184,102,.8)'; hx.lineWidth = 1; hx.beginPath(); hx.moveTo(cx, cy); hx.lineTo(cx + vx, cy + vy); hx.stroke();
    hx.translate(cx, cy); hx.rotate(-SH.ra[0]);
    hx.fillStyle = '#dbe0e7'; hx.beginPath(); hx.moveTo(0, -6); hx.lineTo(4, 5); hx.lineTo(-4, 5); hx.closePath(); hx.fill();
    hx.restore();
    hx.strokeStyle = 'rgba(138,149,164,.45)'; hx.lineWidth = 1; hx.beginPath(); hx.arc(cx, cy, R, 0, 6.283); hx.stroke();
    hx.fillStyle = '#8a95a4'; hx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace'; hx.textAlign = 'right';
    hx.fillText(`RADAR ${MAP_RANGE / 1000} km`, cx + R, cy + R + 9);
    hx.textAlign = 'left';
  }

  // ---------- the system map (M) ----------
  // Orbits, bodies, ships, mission destinations and the target, the whole system in view. Click a body (or a ship)
  // to target it; G flies there. The sim runs on underneath.
  const mapEl = $('map'), mx2 = mapEl.getContext('2d');
  let mapOn = false;
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
    // the jump zones: where through traffic arrives and leaves
    c.font = '600 11px "IBM Plex Mono", ui-monospace, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    TRAFFIC.zones.forEach((name, z) => {
      const R = jumpR(), [x, y] = mapPos([0, R, 0, -R][z], [R, 0, -R, 0][z], v), r = Math.max(6, jumpSpread() * v.s);
      c.setLineDash([3, 4]); c.strokeStyle = 'rgba(143,211,255,.55)'; c.lineWidth = 1; c.beginPath(); c.arc(x, y, r, 0, 6.283); c.stroke(); c.setLineDash([]);
      c.fillStyle = 'rgba(143,211,255,.75)'; c.fillText(`${name.toUpperCase()} JUMP`, x, y + (z === 0 ? -r - 10 : r + 10));
    });
    // the autopilot's course: to the point it is steering for (round any obstacle), then the target
    const auto = sim.game.auto[0] - 1;
    if (auto >= 0) {
      const [ax, ay] = mapPos(SH.rx[0], SH.ry[0], v), [wx, wy] = mapPos(sim.game.aim_x[0], sim.game.aim_y[0], v), [bx, by] = mapPos(...navPoint(auto, SH.rx[0], SH.ry[0]), v);
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
      c.fillStyle = B.kind === 'star' ? '#f2b26b' : B.env ? 'rgba(201,210,220,.55)' : B.kind === 'station' ? '#c9d2dc' : '#6f8296';
      if (B.kind === 'station') { c.save(); c.translate(x, y); c.rotate(Math.PI / 4); c.fillRect(-r, -r, 2 * r, 2 * r); c.restore(); }
      else if (B.kind !== 'field') { c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill(); }
      if (j === tb) { c.strokeStyle = TGT_COL; c.lineWidth = 2; c.beginPath(); c.arc(x, y, r + 6, 0, 6.283); c.stroke(); }
      if (dest.has(j)) { c.strokeStyle = MIS_COL; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, r + 10, 0, 6.283); c.stroke(); }
      if (B.env && j !== tb) return; // environmental stations: a marker, no label (unless targeted)
      c.font = '600 12px "IBM Plex Mono", ui-monospace, monospace';
      c.fillStyle = j === tb ? TGT_COL : dest.has(j) ? MIS_COL : B.port ? '#7fd08a' : B.kind === 'field' ? '#b0a492' : '#9fb4c8';
      c.fillText(B.name.toUpperCase(), x, y - r - 12);
      if (B.port) { c.font = '500 10.5px "IBM Plex Mono", ui-monospace, monospace'; c.fillStyle = '#8a95a4'; c.fillText(B.port.name, x, y + r + 12); }
    });
    for (let i = 1; i < sim.count(); i++) {
      if (!SH.alive[i]) continue;
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
    c.fillText('Click a body or ship to target it  ·  G fly to the target (full assist)  ·  M or Esc close', 20, 48);
    if (navTarget) { c.fillStyle = TGT_COL; c.fillText(`Target: ${targetName(navTarget)}${auto >= 0 ? '  ·  autopilot engaged' : ''}`, 20, 66); }
  }
  mapEl.addEventListener('pointerdown', e => {
    const v = mapView(), r = mapEl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 22;
    BODIES.forEach((B, j) => {
      const [bx, by] = mapPos(B.x, B.y, v), e = Math.hypot(bx - x, by - y);
      const d = B.kind === 'belt' ? Math.abs(e - B.r * v.s) - Math.max(0, B.belt.width * v.s / 2 - 4) : e - Math.max(0, B.r * v.s - 4); // a belt: anywhere on its band
      if (d < bd) { bd = d; best = { body: j }; }
    });
    for (let i = 1; i < sim.count(); i++) {
      if (!SH.alive[i]) continue;
      const [sx, sy] = mapPos(SH.rx[i], SH.ry[i], v), d = Math.hypot(sx - x, sy - y);
      if (d < Math.min(bd, 8)) { bd = d; best = { ship: sim.handle(i) }; }
    }
    if (best) setTarget(best);
    e.preventDefault(); canvas.focus();
  });

  // the views made from the current system's bodies: called by showSystem
  function systemViews() {
    sunCol = starCol = lin(star.col);
    atmOf = new Map(WORLDS.map(w => [BODIES.find(b => b.id === w.id), w.LA]));
    locationRows(); expanded = -1; locAt = 0; locRows = [];
    mapExtent = extentOf();
    navTarget = null;
  }

  // test hook: drive and inspect the session from a console or a headless browser
  window.__play = {
    sim, IN, CMD, MODE, newGame, exportReplay, command, ECON, showTitle, pauseGame,
    get BODIES() { return BODIES; }, // the current system's
    // the systems (ids, in atlas order), the one being played, the debug jump and every place it can go
    systems: () => SYSTEMS.map(S => S.id), system: () => sysK, jump: (k, j) => jumpTo(k, j), places: () => jumpPlaces(),
    // the player's landing or launch sequence now: progress and the drawn pose (null when not in one)
    seq: () => sim.mode() === MODE.descending || sim.mode() === MODE.launching ? playerSeq() : null,
    setNav, trade, repay, showPanel, accept, abandon, setTarget, flyTo, cycleTarget, toggleMap, pickLocation,
    target: () => navTarget && (navTarget.body !== undefined ? { body: navTarget.body } : { ship: sim.resolve(navTarget.ship) }),
    locations: () => { locAt = 0; refreshLocations(); return locRows.map(([j, child]) => ({ j, name: BODIES[j].name, child })); }, // as the list shows them now
    // ambient traffic: every ship in flight, with its role, phase, route and whether it is on rails
    traffic: () => { const out = []; for (let i = 0; i < sim.count(); i++) if (TR.role[i]) out.push({ i, role: TRAFFIC.streams[TR.role[i] - 1], line: types[SH.kind[i]].brand.id, cls: catalog.sizes[types[SH.kind[i]].zi].id, phase: TR.phase[i], from: TR.from[i], to: TR.to[i], rail: SH.rail[i], x: SH.x[i], y: SH.y[i], v: Math.hypot(SH.vx[i], SH.vy[i]) }); return out; },
    // how many rocks the belts and fields hold (scenery: src/rocks.js)
    rocks: () => ROCKS.length,
    // dev: put the (flying) player at rest over body j; a logged command, so replays still match
    teleport: j => command(CMD.teleport, j),
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
            target: navTarget ? targetName(navTarget) : null },
          jitter: JIT.report(), replay: { ticks: r.ticks, tick: r.tick, hash: r.hash } },
        save: b64(r.save), inputs: r.log
      };
    },
    probe: () => ({ barrier: !!barrier, notice, tick: sim.tick(), hash: sim.hash(), x: SH.x[0], y: SH.y[0], v: Math.hypot(SH.vx[0], SH.vy[0]), set: sim.playerSet(), assist: assistMode, mode: sim.mode(), day: sim.day(), at: sim.game.at[0], ready: typeReady(types[SH.kind[0]]), auto: sim.game.auto[0] - 1, map: mapOn, shell: shellOpen(), paused, seed: seedNow,
      credits: sim.credits(), debt: sim.debt(), hold: Object.fromEntries(GOODS.map((c, g) => [c.id, sim.hold.tons[g]]).filter(e => e[1])), holdCap: holdCap() }),
    // hold keys for sec seconds of sim time (recorded like live input)
    advance: (sec, held) => {
      const saved = new Set(keys); keys.clear(); (held || []).forEach(k => keys.add(k));
      const bits = inputBits(IN);
      if (bits !== lastBits) { sim.setInput(bits); rec.log.push([sim.tick(), bits]); lastBits = bits; }
      for (let k = 0; k < Math.round(sec / sim.DT); k++) sim.step();
      keys.clear(); saved.forEach(k => keys.add(k));
    },
    save: () => saveGame(), load: () => loadGame(), b64, unb64,
    inspect: () => G.inspectScene(), setZoom
  };
  showTitle();
  requestAnimationFrame(frame);
}).catch(e => { console.error(e); $('glerr').textContent = 'The sim core failed to start: ' + (e.message || e); $('glerr').hidden = false; });
