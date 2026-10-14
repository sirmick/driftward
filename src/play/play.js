// ======================= PLAY =======================
// The game page, on the way to M1. Rule: anything that changes game state runs in the sim core, so a session
// saves, loads and replays exactly (natively too). This page only turns keys into one input bitmask per tick,
// and draws what the core's columns say. Flight is the core's player model, with the Book's three assist levels:
// full assist holds a set speed along the nose (and cancels drift and gravity); drift off is raw Newtonian thrust
// with strafe; full off adds torque rotation, where a spin keeps going until countered.
const $ = id => document.getElementById(id);
const catalog = JSON.parse($('catalog').textContent);
const canvas = $('view'), hud = $('hud'), hx = hud.getContext('2d');
const G = makeGfx(canvas);
if (!G) { $('glerr').hidden = false; return; }
const { gl, compile, P, quad, draw, tex } = G;

// ---------- the system: validated (clamped) against its schema, then laid out (src/schema.js) ----------
const loaded = loadSystem(JSON.parse($('system').textContent), JSON.parse($('system-schema').textContent));
loaded.notes.forEach(n => console.warn(`system ${n.path}: ${n.msg}`));
if (!loaded.system) { $('glerr').textContent = 'The system file is unusable: ' + loaded.notes.filter(n => n.fatal).map(n => `${n.path} ${n.msg}`).join('; '); $('glerr').hidden = false; return; }
const SYS = loaded.system, BODIES = loaded.bodies, STAR = BODIES[0];
// the economy (src/economy.json): commodities, and each port role's price tier for each (validated by npm run check)
const ECON = JSON.parse($('economy').textContent), GOODS = ECON.commodities;
// ambient traffic (src/traffic.json): hulls by culture and role, population weights
const TRAFFIC_DATA = JSON.parse($('traffic').textContent);
const star = STARS[STAR.look] || STARS.sol;
const SURFACE = { terran: 0, giant: 1, rock: 2 }, BODY_KIND = { star: 0, planet: 1, moon: 2, station: 3 };
// planets and moons, drawn by the planet shader
const WORLDS = BODIES.filter(b => b.kind === 'planet' || b.kind === 'moon').map(b => {
  const L = b.look || {}, pal = L.palette || ['#5e5953', '#8a8178', '#c9c0b4'];
  return Object.assign({}, b, { L1: hexRGB(pal[0]), L2: hexRGB(pal[1]), L3: hexRGB(pal[2]), LA: lin(hexRGB(L.atmosphere || '#9fb4c8')), seed: L.seed || 1, surface: SURFACE[L.surface] || 0, city: L.cityLights || 0 });
});
// light comes from the star: the direction toward it from (x, y), tipped toward the camera so day sides read
function sunFrom(x, y) {
  const dx = STAR.x - x, dy = STAR.y - y, l = Math.hypot(dx, dy);
  const v = l > 1 ? [dx / l, dy / l, 0.45] : [0, 0, 1], n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}

// ---------- ship types: one per brand x size; flight stats from the catalog, looks from the bake ----------
const baker = makeBaker({
  gl, tex, genText: $('gen').textContent, catalog: () => catalog, defaultSeed: () => 'play-1',
  onError: (key, msg) => console.error('bake failed', key, msg)
});
const nSizes = catalog.sizes.length;
const types = [];
catalog.brands.forEach((b, bi) => catalog.sizes.forEach((z, zi) => {
  const fz = z.flight || {}, fb = b.style.flight || {};
  types.push({
    bi, zi, brand: b, L: z.length, name: b.name + ' ' + z.name, key: baker.keyOf(b.id, z.id), br: brandRender(b),
    accel: (fz.accel || 60) * (fb.accel || 1), turn: (fz.turn || 1) * (fb.turn || 1), vmax: (fz.vmax || 200) * (fb.vmax || 1),
    well: fz.well == null ? 0.5 : fz.well, // how much gravity wells pull this hull and bend its top speed
    cargo: fz.cargo || 0, // hold, tons
    s: null, half: z.length / 2
  });
}));
// A type is baked the first time a ship of it needs drawing (each finished bake uploads four textures on the
// main thread, so baking the whole catalog up front stalls frames for seconds). It is drawable only once its
// textures exist; until then it is simply not drawn.
function typeReady(T) {
  if (T.s) return true;
  const s = baker.ships.get(T.key);
  if (!s) { baker.enqueue(T.key, true); baker.pump(); return false; }
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
// stations, baked from their catalog archetype in an owning brand's style; drawn like ships, slowly spinning
const STATIONS = BODIES.filter(b => b.kind === 'station').map(b => {
  const st = b.station || {}, arch = catalog.stations.find(a => a.id === st.archetype) || catalog.stations[0];
  const brand = catalog.brands.find(x => x.id === st.brand) || catalog.brands[0];
  return Object.assign({}, b, { key: 'stn|' + b.id, req: { station: arch.id, brand: brand.id, seed: st.seed || b.id }, brand, spin: arch.spin || 0.01, s: null });
});
STATIONS.forEach(S => baker.enqueue(S.key, false, S.req));
baker.pump();
function stationReady(S) {
  if (S.s) return true;
  const s = baker.ships.get(S.key);
  if (!s || !s.ready || !s.tex) return false;
  S.s = s; S.half = s.maps.extent / 2; return true;
}
function playerTypeIndex() {
  const q = new URLSearchParams(location.search).get('ship') || 'halcyon:fighter';
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
  sheath: compile(SHEATH_VS, SHEATH_FS)
};
function instVAO(sizes) {
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const per = sizes.reduce((a, b) => a + b, 0), stride = per * 4;
  let off = 0;
  sizes.forEach((sz, k) => { gl.enableVertexAttribArray(k + 1); gl.vertexAttribPointer(k + 1, sz, gl.FLOAT, false, stride, off); gl.vertexAttribDivisor(k + 1, 1); off += sz * 4; });
  gl.bindVertexArray(null);
  return { vao, buf, sizes, per, stride };
}
const VS = { ship: instVAO([4, 2]), plume: instVAO([4, 4, 2]) };
function upload(V, data, count) { gl.bindBuffer(gl.ARRAY_BUFFER, V.buf); gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, Math.max(1, count) * V.per), gl.DYNAMIC_DRAW); }
function pointAt(V, first) {
  gl.bindBuffer(gl.ARRAY_BUFFER, V.buf);
  let off = first * V.stride;
  V.sizes.forEach((sz, k) => { gl.vertexAttribPointer(k + 1, sz, gl.FLOAT, false, V.stride, off); off += sz * 4; });
}

// ---------- layout ----------
let W = 0, H = 0, dpr = 1, stripH = 0;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  stripH = document.querySelector('.strip').getBoundingClientRect().height;
  canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr));
  hud.width = canvas.width; hud.height = canvas.height;
  G.buildTargets();
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
$('b-nav').onclick = () => { setNav(!navOn); canvas.focus(); };
window.addEventListener('keydown', e => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'F6', 'F9'].includes(e.code)) e.preventDefault();
  if (!keys.has(e.code)) {
    if (e.code === 'Tab' || e.code === 'KeyF') { assistMode = (assistMode + 1) % 3; toast(ASSIST[assistMode].toast); }
    if ((e.code === 'KeyQ' || e.code === 'KeyE') && assist()) toast('Strafe works with assist off: press Tab');
    // flight: T cycles ship targets, 1-9 pick from the location list, G flies to the target, M opens the map
    if (inFlight()) {
      if (e.code === 'KeyT') cycleTarget();
      if (e.code === 'KeyG') flyTo();
      if (e.code === 'KeyM') toggleMap();
      if (/^Digit[1-9]$/.test(e.code)) pickLocation(+e.code.slice(5));
      if (e.code === 'Escape') escapeFlight();
    }
    if (e.code === 'KeyI') setNav(!navOn);
    // debugging the flashing black squares: B toggles bloom, N paints bad scene pixels (see postProcess)
    if (e.code === 'KeyB') { bloomOn = !bloomOn; toast(`Bloom ${bloomOn ? 'on' : 'off'}`); }
    if (e.code === 'KeyN') { nanView = 1 - nanView; toast(nanView ? 'NaN view: magenta = bad scene pixel, cyan = bad bloom, yellow = negative' : 'NaN view off'); }
    if (e.code === 'KeyL') landOrLaunch();
    if (e.code === 'Escape' && panelOpen()) showPanel(null);
    if (e.code === 'Enter' || e.code === 'Escape') skipSequence();
    if (e.code === 'KeyW' && inPort()) waitDay();
    if (e.code === 'KeyT' && inPort()) showPanel(panelOpen() === 'trade' ? null : 'trade');
    if (e.code === 'KeyM' && inPort()) showPanel(panelOpen() === 'board' ? null : 'board');
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
let inFlight = () => false, cycleTarget = () => {}, flyTo = () => {}, toggleMap = () => {}, pickLocation = () => {}, escapeFlight = () => {};
// the port screen's panels beside the port card: the market or the mission board, one at a time
const PANELS = ['trade', 'board'];
const panelOpen = () => PANELS.find(p => !$(p).hidden) || null;
let showPanel = () => {};
const fmtCr = n => n.toLocaleString('en-US');

CORE_READY.then(CORE => {
  const sim = CORE.world({ maxShips: 64, maxTypes: 64, maxBodies: 8, envN: 16, envW: 40000, seed: 1 });
  const SH = sim.ship, IN = CORE.IN;
  types.forEach((T, k) => { sim.type.accel[k] = T.accel; sim.type.turn[k] = T.turn; sim.type.vmax[k] = T.vmax; sim.type.well[k] = T.well; sim.type.cargo[k] = T.cargo; });
  const CMD = CORE.CMD, MODE = CORE.MODE;
  BODIES.forEach((b, j) => {
    const B = sim.body; B.x[j] = b.x; B.y[j] = b.y; B.r[j] = b.r; B.g[j] = b.g; B.kind[j] = BODY_KIND[b.kind]; B.port[j] = b.port ? 1 : 0;
    B.pop[j] = b.port ? TRAFFIC_DATA.population[b.port.population] || 1 : 0; // traffic's gravity model
  });
  // traffic hulls: the owning culture's brand, a size class per role (src/traffic.json; validated by npm run check)
  { const C = TRAFFIC_DATA.cultures[SYS.owner] || Object.values(TRAFFIC_DATA.cultures)[0];
    const bi = Math.max(0, catalog.brands.findIndex(b => b.id === C.brand));
    CORE.TRAFFIC.roles.forEach((r, k) => { sim.role.kind[k] = bi * nSizes + Math.max(0, catalog.sizes.findIndex(z => z.id === C.roles[r])); }); }
  sim.setBodies(BODIES.length);
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
  const startBody = Math.max(1, BODIES.findIndex(b => b.id === SYS.start && b.port), BODIES.findIndex(b => b.port));

  // replay recording: the snapshot at the start of the session plus every input change since
  let rec = null, lastBits = -1;
  function startRecording() { rec = { start: sim.save(), startTick: sim.tick(), log: [] }; lastBits = -1; }

  // A new game starts landed at the system's start port, as in EV. opts.space = [x, y] starts flying there instead
  // (tests and the debug hook use it).
  function newGame(seed, opts) {
    sim.clear(); sim.reseed(seed === undefined ? (Math.random() * 4294967296) >>> 0 : seed);
    writePrices();
    sim.setCount(1);
    SH.kind[0] = playerTypeIndex(); SH.alive[0] = 1; SH.ang[0] = 0;
    sim.setPlayer(0);
    if (opts && opts.space) { SH.x[0] = opts.space[0]; SH.y[0] = opts.space[1]; sim.slotReset(0, true); }
    else { sim.slotReset(0, true); sim.placeLanded(startBody); }
    sim.game.day[0] = 1; // day one
    sim.game.credits[0] = ECON.start.credits; sim.game.debt[0] = ECON.start.debt; // a used fighter and a debt to a lender
    sim.postBoards();
    sim.startTraffic(); // ambient traffic, already mid-flow
    camX = SH.x[0]; camY = SH.y[0]; lastMode = -1; // the next frame shows the port screen if landed
    navTarget = null;
    missionSeen.set(sim.mission.state);
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
  $('svc-launch').onclick = () => { landOrLaunch(); canvas.focus(); };
  saveGame = () => { localStorage.setItem('driftward.save', b64(sim.save())); toast(`Saved at tick ${sim.tick()}`); };
  loadGame = () => {
    const s = localStorage.getItem('driftward.save') || localStorage.getItem('driftward.autosave');
    if (!s) { toast('No saved game'); return; }
    const err = sim.load(unb64(s));
    if (err) { toast(`Save is unreadable (error ${err})`); return; }
    camX = SH.x[0]; camY = SH.y[0]; lastMode = -1; navTarget = null; missionSeen.set(sim.mission.state); startRecording(); toast(`Loaded day ${sim.day()}`);
  };
  // autosave on landing, as in EV (the Book: death reloads the last landing save)
  function autosave() { localStorage.setItem('driftward.autosave', b64(sim.save())); }
  function exportReplay() {
    const ticks = sim.tick() - rec.startTick, hash = sim.hash();
    const log = `# driftward input log: replay with\n#   cargo run --release --bin replay -- driftward-save.bin driftward-inputs.txt ${ticks}\n# expect: tick ${sim.tick()} hash ${hash}\n` + rec.log.map(e => e[1] === 'cmd' ? `${e[0]} cmd ${e[2]} ${e[3]} ${e[4]}` : `${e[0]} ${e[1]}`).join('\n') + '\n';
    return { save: rec.start, log, ticks, tick: sim.tick(), hash };
  }
  function download(name, data, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
  $('b-save').onclick = () => { saveGame(); canvas.focus(); };
  $('b-load').onclick = () => { loadGame(); canvas.focus(); };
  $('b-new').onclick = () => { newGame(); toast('New game'); canvas.focus(); };
  $('b-replay').onclick = () => {
    const r = exportReplay();
    download('driftward-save.bin', r.save, 'application/octet-stream');
    download('driftward-inputs.txt', r.log, 'text/plain');
    toast(`Replay: ${r.ticks} ticks, hash ${r.hash}`); canvas.focus();
  };

  // ---------- frame ----------
  let last = 0, camX = 0, camY = 0, fps = 60, fpsAcc = 0, fpsN = 0, lastMode = -1;
  const t0 = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = last ? Math.min(0.25, (now - last) / 1000) : 1 / 60; last = now;
    fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    sim.checkViews();
    // bake the traffic hulls up front (behind the start port's screen), not when the first one flies into view
    for (let k = 0; k < 3; k++) typeReady(types[sim.role.kind[k]]);
    const bits = inputBits(IN);
    if (bits !== lastBits) { sim.setInput(bits); rec.log.push([sim.tick(), bits]); lastBits = bits; }
    for (let n = sim.due(dt); n > 0; n--) sim.step();
    sim.interpolate();
    const mode = sim.mode();
    if (mode !== lastMode) { onMode(mode, lastMode); lastMode = mode; }
    watchMissions();
    const k = Math.min(1, dt * 3.5);
    if (mode === MODE.landed) { const B = BODIES[sim.game.at[0]]; camX += (B.x - camX) * k; camY += (B.y - camY) * k; }
    else if (mode === MODE.flying) { const lead = 0.35; camX += (SH.rx[0] + SH.vx[0] * lead - camX) * k; camY += (SH.ry[0] + SH.vy[0] * lead - camY) * k; }
    else { camX += (SH.x[0] - camX) * k; camY += (SH.y[0] - camY) * k; }
    render((now - t0) / 1000, camX, camY);
    drawHUD();
    drawMap();
  }

  // the game mode changed: show or hide the port screen, autosave on landing
  function onMode(mode, prev) {
    const port = $('port');
    if (mode === MODE.landed) {
      const B = BODIES[sim.game.at[0]], P0 = B.port;
      $('port-kicker').textContent = [B.name, P0.role.replace('-', ' '), P0.population].join(' · ');
      $('port-name').textContent = P0.name;
      $('port-desc').textContent = P0.description || '';
      $('svc-trade').disabled = !(P0.services || []).includes('market');
      $('svc-board').disabled = !(P0.services || []).includes('missions');
      port.hidden = false;
      showPanel(null);
      if (prev === MODE.descending) { autosave(); toast(`Landed at ${P0.name}: day ${sim.day()}, saved`); }
    } else port.hidden = true;
  }

  // ---------- the port's market and mission board ----------
  // Every change is a core command (logged for replays); the panels only show the columns and send commands.
  const holdCap = () => sim.type.cargo[SH.kind[0]];
  const MS = sim.mission, OF = sim.offer, NM = sim.maxMissions, NO = sim.maxOffers, MSTATE = CORE.MISSION;
  const activeMissions = () => { const a = []; for (let k = 0; k < NM; k++) if (MS.state[k] === MSTATE.active) a.push(k); return a; };
  const portName = j => BODIES[j].port ? BODIES[j].port.name : BODIES[j].name;
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
    $('mission-rows').innerHTML = activeMissions().map(k => `<tr><td>${portName(MS.dest[k])}</td><td>${cargoText(MS.tons[k], MS.good[k])}</td>`
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
    const what = `${cargoText(MS.tons[k], MS.good[k])} to ${portName(MS.dest[k])}`;
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
    for (let k = 0; k < NM; k++) {
      const st = MS.state[k];
      if (missionSeen[k] === MSTATE.active && st === MSTATE.delivered) toast(`Delivered ${cargoText(MS.tons[k], MS.good[k])} to ${portName(MS.dest[k])}: +${fmtCr(MS.pay[k])} cr`);
      if (missionSeen[k] === MSTATE.active && st === MSTATE.failed) toast(`Mission failed: ${cargoText(MS.tons[k], MS.good[k])} to ${portName(MS.dest[k])} is past its deadline`);
      if (missionSeen[k] !== st) { missionSeen[k] = st; refreshPort(); }
    }
  }

  // ---------- render ----------
  const MAXS = 64;
  const shipInst = new Float32Array(MAXS * 6), plumeInst = new Float32Array(MAXS * 12 * 10);
  const typeCount = new Int32Array(types.length), typeStart = new Int32Array(types.length), typeFill = new Int32Array(types.length);
  const LP = new Float32Array(64), LC = new Float32Array(64);
  const plCol = new Float32Array(15), plCore = new Float32Array(15), plP = new Float32Array(20), plSpread = new Float32Array(5), plBurn = new Float32Array(15);
  catalog.brands.slice(0, 4).forEach((b, k) => { const br = brandRender(b); plCol.set(br.plCol, k * 3); plCore.set(br.plCore, k * 3); plP.set([br.plTurb, br.plDia, br.plSput, br.plPulse], k * 4); plSpread[k] = br.plSpread; plBurn.set(br.plBurn, k * 3); });
  const RCS = 4; // the fifth look: cold thruster gas for the side, reverse and turning jets
  const spinVis = new Float32Array(MAXS); // per-slot turning-jet pulse, decaying (visual only)
  const turnSlew = sim.param('turn_slew');
  plCol.set(lin([0.72, 0.78, 0.88]), RCS * 3); plCore.set([1, 1, 1], RCS * 3); plP.set([0.5, 0, 0.25, 0], RCS * 4); plSpread[RCS] = 0.9; plBurn.set(plCol.subarray(RCS * 3, RCS * 3 + 3), RCS * 3);
  const sunCol = lin(star.col), starCol = lin(star.col);
  const stInst = new Float32Array(6);
  // draw order: largest classes first, so small ships sit on top
  const order = types.map((_, k) => k).sort((a, b) => types[b].zi - types[a].zi);
  let scale = 1;
  const sheaths = []; // [slot, sequence look] to draw this frame (reused)
  const LAUNCH_S = 2.0, DESCENT_S = 2.5; // core/src/port.rs
  const TR = sim.traffic, TRAFFIC = CORE.TRAFFIC;
  // a landing or launch sequence's look at d (0 in flight .. 1 down) over body B: hull scale, plasma heat, fade-out
  // into the atmosphere's tint
  function seqLook(d, B) {
    const st = B.kind === 'station', ss = x => x * x * (3 - 2 * x), seg = (a, b, x) => ss(Math.max(0, Math.min(1, (x - a) / (b - a))));
    return { sc: st ? 1 - 0.45 * seg(0, 1, d) : 1 - 0.85 * seg(0.08, 1, d), heat: st ? 0 : seg(0, 0.2, d) * (1 - seg(0.88, 1, d)), fade: seg(0.5, 0.95, d), atm: (WORLDS.find(w => w.id === B.id) || {}).LA || [0.6, 0.7, 0.8] };
  }
  function setView(prog, RW, RH, cx, cy) { gl.useProgram(prog.p); gl.uniform2f(prog.u.uRes, RW, RH); gl.uniform2f(prog.u.uCam, cx, cy); gl.uniform1f(prog.u.uScale, scale); }
  function render(t, cx, cy) {
    const RW = canvas.width, RH = canvas.height, T0 = types[SH.kind[0]], live = Math.min(MAXS, sim.count());
    const mode = sim.mode();
    scale = RW / (Math.max(700, T0.L * 16) / zoom);
    if (mode === MODE.landed) { // the port screen's vista: the body you are on, filling the view
      const B = BODIES[sim.game.at[0]];
      scale = Math.min(RW, RH) * (B.kind === 'station' ? 0.75 : 0.95) / (2 * B.r * (B.kind === 'station' ? 1.6 : 1));
    }
    const sunCam = sunFrom(cx, cy), sl = Math.hypot(sunCam[0], sunCam[1]) || 1;
    const halfW = RW / scale / 2, halfH = RH / scale / 2;
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, G.targets.scene.f); gl.viewport(0, 0, RW, RH);
    gl.disable(gl.BLEND);
    gl.useProgram(P.bg.p);
    gl.uniform2f(P.bg.u.uRes, RW, RH); gl.uniform1f(P.bg.u.uTime, t);
    gl.uniform3fv(P.bg.u.uStar, star.col); gl.uniform3fv(P.bg.u.uNeb, star.neb);
    gl.uniform2f(P.bg.u.uSunDir, sunCam[0] / sl, sunCam[1] / sl);
    gl.uniform2f(P.bg.u.uOff, cx * scale * 0.04, cy * scale * 0.04);
    draw();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // the star
    if (Math.abs(STAR.x - cx) < halfW + STAR.r * 2.4 && Math.abs(STAR.y - cy) < halfH + STAR.r * 2.4) {
      setView(FP.star, RW, RH, cx, cy);
      const u = FP.star.u;
      gl.uniform2f(u.uC, STAR.x, STAR.y); gl.uniform1f(u.uR, STAR.r); gl.uniform3fv(u.uCol, starCol);
      gl.uniform1f(u.uTime, t); gl.uniform1f(u.uPx, 1 / (STAR.r * scale));
      draw();
    }
    // planets and moons, each lit from the star's direction
    setView(FP.planet, RW, RH, cx, cy);
    { const u = FP.planet.u;
      gl.uniform3fv(u.uSunCol, sunCol); gl.uniform3fv(u.uAmb, star.amb); gl.uniform1f(u.uTime, t);
      for (const p of WORLDS) {
        if (Math.abs(p.x - cx) > halfW + p.r * 1.3 || Math.abs(p.y - cy) > halfH + p.r * 1.3) continue;
        gl.uniform3fv(u.uSun, sunFrom(p.x, p.y));
        gl.uniform2f(u.uC, p.x, p.y); gl.uniform1f(u.uR, p.r); gl.uniform1f(u.uPx, 1 / (p.r * scale));
        gl.uniform3fv(u.uC1, p.L1); gl.uniform3fv(u.uC2, p.L2); gl.uniform3fv(u.uC3, p.L3); gl.uniform3fv(u.uAtm, p.LA);
        gl.uniform1f(u.uSeed, p.seed); gl.uniform1i(u.uKind, p.surface); gl.uniform1f(u.uCity, p.city);
        draw();
      } }
    // stations: one draw each, with the ship shader and their own bake
    const shipUniforms = (u, sun) => {
      gl.uniform3fv(u.uSun, sun); gl.uniform3fv(u.uSunCol, sunCol); gl.uniform3fv(u.uAmb, star.amb);
      gl.uniform1f(u.uTime, t); gl.uniform1i(u.uMode, 0); gl.uniform1f(u.uShadow, 1);
      gl.uniform1i(u.uA, 0); gl.uniform1i(u.uN, 1); gl.uniform1i(u.uE, 2); gl.uniform1i(u.uX, 3);
    };
    const bindLook = (u, s, half, brand) => {
      const m = brand.style.material, mp = s.maps;
      gl.uniform1f(u.uHalfM, half); gl.uniform1f(u.uExtent, mp.extent); gl.uniform1f(u.uHRange, mp.hRange);
      gl.uniform1f(u.uDmax, mp.Dmax); gl.uniform1f(u.uS, mp.shieldS);
      gl.uniform1f(u.uGloss, m.gloss); gl.uniform1f(u.uSpecK, 0.6 + m.spec * 1.4); gl.uniform1f(u.uWrap, m.wrap); gl.uniform1f(u.uIrid, m.irid); gl.uniform1f(u.uRim, m.rim);
      for (let q = 0; q < 4; q++) { gl.activeTexture(gl.TEXTURE0 + q); gl.bindTexture(gl.TEXTURE_2D, s.tex[q]); }
    };
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const S of STATIONS) {
      if (!stationReady(S) || Math.abs(S.x - cx) > halfW + S.half || Math.abs(S.y - cy) > halfH + S.half) continue;
      setView(FP.ship, RW, RH, cx, cy);
      const u = FP.ship.u;
      shipUniforms(u, sunFrom(S.x, S.y)); gl.uniform1i(u.uLN, 0);
      bindLook(u, S.s, S.half, S.brand);
      stInst.set([S.x, S.y, t * S.spin, 0, 0, 1]);
      gl.bindVertexArray(VS.ship.vao); upload(VS.ship, stInst, 1); pointAt(VS.ship, 0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
      gl.bindVertexArray(null);
    }

    // Landing and launch sequences, the player's and the traffic's: d runs 0 in flight .. 1 down. The player's ship
    // is out of the flight sim meanwhile (drawn from the game state); a traffic ship stays in its slot, held by the
    // core. Each shrinks into the surface inside a plasma sheath (docking at a station: a short shrink, no plasma).
    sheaths.length = 0;
    let pseq = null;
    if ((mode === MODE.descending || mode === MODE.launching) && typeReady(T0)) {
      const p = 1 - sim.game.timer[0] / (mode === MODE.descending ? DESCENT_S : LAUNCH_S);
      pseq = seqLook(mode === MODE.descending ? p : 1 - p, BODIES[sim.game.at[0]]);
    }
    const npcSeq = i => {
      const ph = TR.phase[i];
      if (!TR.role[i] || (ph !== TRAFFIC.launch && ph !== TRAFFIC.land)) return null;
      return ph === TRAFFIC.launch ? seqLook(TR.timer[i] / LAUNCH_S, BODIES[TR.from[i]]) : seqLook(1 - TR.timer[i] / DESCENT_S, BODIES[TR.to[i]]);
    };
    // which ships are drawable and on screen
    typeCount.fill(0);
    const shown = i => {
      if (!SH.alive[i]) return false;
      const T = types[SH.kind[i]];
      if (!typeReady(T)) return false;
      const m = T.half * 1.2 + T.L * 2;
      return Math.abs(SH.rx[i] - cx) < halfW + m && Math.abs(SH.ry[i] - cy) < halfH + m;
    };
    let nL = 0, nPl = 0;
    for (let i = 0; i < live; i++) {
      if (!shown(i)) continue;
      const T = types[SH.kind[i]], c = Math.cos(SH.ra[i]), s = Math.sin(SH.ra[i]), th = SH.thr[i];
      typeCount[SH.kind[i]]++;
      // burner intensity follows the engine glow, which ramps toward 1 only on the burner (cruise tops out at .72),
      // so the tint, length and brightness flare in and fade out over a few frames instead of snapping
      const bi = Math.max(0, Math.min(1, (th - 0.72) / 0.28)), pw = plumePower(th) * 1.35 * (1 + 0.35 * bi);
      if (th >= 0.05 && nL < 16) { // engine light on the hull
        const ex = T.engX, ey = T.engY - T.L * 0.12, k = pw * 1.5;
        LP.set([SH.rx[i] + c * ex - s * ey, SH.ry[i] + s * ex + c * ey, T.L * 0.05 + 1.5, T.L * 1.6 + 8], nL * 4);
        LC.set([T.br.plCol[0] * k, T.br.plCol[1] * k, T.br.plCol[2] * k, 0], nL * 4); nL++;
      }
      // thruster jets: side jets fire away from the push (lateral thrust +x pushes right), reverse jets out of the nose
      const jet = (lx, ly, dx, dy, k) => {
        if (nPl >= MAXS * 12) return;
        const o = nPl * 10;
        plumeInst[o] = SH.rx[i] + c * lx - s * ly; plumeInst[o + 1] = SH.ry[i] + s * lx + c * ly;
        plumeInst[o + 2] = c * dx - s * dy; plumeInst[o + 3] = s * dx + c * dy;
        plumeInst[o + 4] = T.L * (0.08 + 0.22 * k); plumeInst[o + 5] = T.L * 0.05; plumeInst[o + 6] = i * 3.1 + lx; plumeInst[o + 7] = 0.35 + 0.9 * k;
        plumeInst[o + 8] = RCS; plumeInst[o + 9] = 0; nPl++;
      };
      const lat = SH.lat[i], rev = -Math.min(0, SH.main[i]);
      const A = T.rcs || { fl: [-T.half * 0.3, T.half * 0.28], fr: [T.half * 0.3, T.half * 0.28], rl: [-T.half * 0.3, -T.half * 0.24], rr: [T.half * 0.3, -T.half * 0.24], nl: [-T.half * 0.12, T.half * 0.42], nr: [T.half * 0.12, T.half * 0.42] };
      // turning: diagonal pairs (front-right with rear-left turns left, the other pair right). The torque is what the
      // core's steer stage applies this tick: the turn command itself in full off, else the step toward the target
      // rate. Pulses linger a few frames, and a faint trim shows while the ship is turning, so a turn reads clearly.
      const turnT = T.turn, step = turnT * turnSlew * sim.DT;
      const torque = SH.rot[i] ? SH.turn_in[i] : Math.max(-1, Math.min(1, (SH.turn_in[i] * turnT - SH.av[i]) / step));
      spinVis[i] = Math.abs(torque) >= Math.abs(spinVis[i]) * 0.86 ? torque : spinVis[i] * 0.86;
      const spin = Math.max(-1, Math.min(1, spinVis[i] + 0.25 * SH.av[i] / turnT)), ks = Math.abs(spin);
      if (ks > 0.06) {
        // turning left (counter-clockwise): front-right and rear-left fire outward; turning right, the other pair
        if (spin > 0) { jet(A.fr[0], A.fr[1], 1, 0, ks); jet(A.rl[0], A.rl[1], -1, 0, ks); }
        else { jet(A.fl[0], A.fl[1], -1, 0, ks); jet(A.rr[0], A.rr[1], 1, 0, ks); }
      }
      // strafing right (+x) fires the left flank outward, front and rear; strafing left, the right flank
      if (Math.abs(lat) > 0.05) { const k = Math.abs(lat); if (lat > 0) { jet(A.fl[0], A.fl[1], -1, 0, k); jet(A.rl[0], A.rl[1], -1, 0, k); } else { jet(A.fr[0], A.fr[1], 1, 0, k); jet(A.rr[0], A.rr[1], 1, 0, k); } }
      if (rev > 0.05) { jet(A.nl[0], A.nl[1], 0, 1, rev); jet(A.nr[0], A.nr[1], 0, 1, rev); }
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
      setView(FP.plume, RW, RH, cx, cy);
      const u = FP.plume.u; gl.uniform1f(u.uTime, t);
      gl.uniform3fv(u.uPlCol, plCol); gl.uniform3fv(u.uPlCore, plCore); gl.uniform4fv(u.uPlP, plP); gl.uniform1fv(u.uPlSpread, plSpread); gl.uniform3fv(u.uPlBurn, plBurn);
      gl.bindVertexArray(VS.plume.vao); upload(VS.plume, plumeInst, nPl);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nPl);
      gl.bindVertexArray(null);
    }
    // hulls, bucketed by type (the player's sequence, if any, in its type's bucket)
    if (pseq) typeCount[SH.kind[0]]++;
    let acc = 0;
    for (const k of order) { typeStart[k] = acc; acc += typeCount[k]; typeFill[k] = typeStart[k]; }
    for (let i = 0; i < live; i++) {
      if (!shown(i)) continue;
      const o = typeFill[SH.kind[i]]++ * 6, q = npcSeq(i);
      shipInst[o] = SH.rx[i]; shipInst[o + 1] = SH.ry[i]; shipInst[o + 2] = SH.ra[i]; shipInst[o + 3] = SH.thr[i]; shipInst[o + 4] = 0; shipInst[o + 5] = q ? q.sc : 0;
      if (q && q.heat > 0.01) sheaths.push([i, q]);
    }
    if (pseq) {
      shipInst.set([SH.x[0], SH.y[0], SH.ang[0], 0, 0, pseq.sc], typeFill[SH.kind[0]]++ * 6);
      if (pseq.heat > 0.01) sheaths.push([0, pseq]);
    }
    if (acc) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      setView(FP.ship, RW, RH, cx, cy);
      const u = FP.ship.u;
      shipUniforms(u, sunCam);
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
      setView(FP.sheath, RW, RH, cx, cy);
      const u = FP.sheath.u;
      gl.uniform1f(u.uTime, t); gl.uniform1i(u.uX, 0); gl.activeTexture(gl.TEXTURE0);
      for (const [i, q] of sheaths) {
        const T = types[SH.kind[i]], m = T.s.maps, px = i === 0 && pseq ? SH.x[0] : SH.rx[i], py = i === 0 && pseq ? SH.y[0] : SH.ry[i];
        gl.uniform2f(u.uC, px, py); gl.uniform1f(u.uHalfM, T.half * 1.15); gl.uniform1f(u.uAng, i === 0 && pseq ? SH.ang[0] : SH.ra[i]); gl.uniform1f(u.uSc, q.sc);
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
    $('loc').hidden = mode !== MODE.flying || mapOn;
    if (mode !== MODE.flying && mapOn) toggleMap(false);
    if (mode === MODE.landed) return; // the port screen is the HUD
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
      [`${T0.name.toUpperCase()}  ·  TICK ${sim.tick()}  ${fps.toFixed(0)} fps`, '#8a95a4']
    ];
    hx.font = '500 11.5px "IBM Plex Mono", ui-monospace, monospace'; hx.textBaseline = 'middle';
    // under the nearest-body line: the autopilot, then the active missions with days left
    const ms = activeMissions().map(k => { const left = MS.due[k] - sim.day(); return [`→ ${portName(MS.dest[k]).toUpperCase()}  ${MS.tons[k]} T  ${fmtCr(MS.pay[k])} CR  ${daysText(left).toUpperCase()}`, left <= 1 ? NAV_HOT : MIS_COL]; });
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
  // Every body, from the player's drawn (interpolated) position, with its mission marker.
  const navObjects = () => {
    const dest = new Set(activeMissions().map(k => MS.dest[k]));
    return BODIES.map((b, j) => ({ j, name: b.port ? `${b.name} (${b.port.name})` : b.name, short: b.name, x: b.x, y: b.y, r: b.r, kind: b.kind, port: !!b.port, mission: dest.has(j) }));
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
    hx.fillText((near.surf <= 0 ? `OVER ${near.name.toUpperCase()}` : `NEAREST ${near.name.toUpperCase()} ${fmtDist(near.surf)}`) + (well > 0.01 ? `  WELL ${Math.round(well * 100)}%` : ''), 14, 20 + 4 * 17);
    if (!navOn) return;
    hx.textBaseline = 'middle';
    for (const o of navs) {
      const [sx, sy] = toScreen(o.x, o.y), hot = o.surf <= 0, col = hot ? NAV_HOT : o.mission ? MIS_COL : NAV_COL;
      const name = (o.mission ? 'DELIVER: ' : '') + o.name.toUpperCase(), sub = hot ? 'OVER' : `${fmtDist(o.surf)}  ${fmtClose(o.closing)}`.trim();
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
  const ROLE_NAME = { shuttle: 'Shuttle', hauler: 'Hauler', liner: 'Liner' };
  const owner = (SYS.owner || '').replace(/s$/, '');
  function targetName(t) {
    if (t.body !== undefined) { const B = BODIES[t.body]; return B.port ? `${B.name} (${B.port.name})` : B.name; }
    const i = sim.resolve(t.ship);
    return i < 0 ? 'lost' : `${owner ? owner[0].toUpperCase() + owner.slice(1) + ' ' : ''}${ROLE_NAME[TRAFFIC.roles[TR.role[i] - 1]] || 'ship'}`;
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
  escapeFlight = () => { if (mapOn) toggleMap(false); else if (navTarget) { setTarget(null); toast('Target cleared'); } };
  inFlight = () => sim.mode() === MODE.flying;

  // the target, marked where it is: corner brackets round it on screen, or an arrow on the screen edge
  function drawTargetMark() {
    let x, y, r;
    const j = targetBody(), i = targetShip();
    if (j >= 0) { x = BODIES[j].x; y = BODIES[j].y; r = BODIES[j].r * scale / dpr; }
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
      const B = BODIES[j], o = navInfo({ x: B.x, y: B.y, r: B.r });
      title = B.port ? B.port.name : B.name;
      sub = [B.name !== title ? B.name : '', B.kind, B.port ? B.port.role.replace('-', ' ') : ''].filter(Boolean).join(' · ');
      range = fmtDist(o.surf); close = o.closing;
      if (B.port) {
        const pb = sim.portBelow(), st = B.kind === 'station', limit = sim.param(st ? 'dock_speed' : 'land_speed');
        if (pb && pb.body === j) rows.push(pb.slow ? [`CLEAR TO ${st ? 'DOCK' : 'LAND'}  ·  L`, '#7fd08a'] : [`SLOW BELOW ${limit} M/S TO ${st ? 'DOCK' : 'LAND'}`, NAV_HOT]);
        else rows.push([`${st ? 'DOCK' : 'LAND'} OVER IT BELOW ${limit} M/S`, '#8a95a4']);
      }
      if (activeMissions().some(k => MS.dest[k] === j)) rows.push(['MISSION DESTINATION', MIS_COL]);
      if (sim.game.auto[0] - 1 === j) rows.push(['AUTOPILOT ENGAGED', '#7fd08a']);
      else if (!rows.length || B.port) rows.push(['G  FLY TO IT', '#8a95a4']);
    } else {
      const dx = SH.rx[i] - SH.rx[0], dy = SH.ry[i] - SH.ry[0], d = Math.hypot(dx, dy) || 1;
      title = targetName(navTarget);
      sub = `${TR.phase[i] === TRAFFIC.launch ? 'launching from' : TR.phase[i] === TRAFFIC.land ? 'landing at' : 'bound for'} ${portName(TR.phase[i] === TRAFFIC.launch ? TR.from[i] : TR.to[i])}`;
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
  // dockable and mission markers; a click or its number key sets the nav target.
  const ZONE_IN = 6, ZONE_OUT = 7;
  const fromStar = j => Math.hypot(BODIES[j].x - STAR.x, BODIES[j].y - STAR.y);
  const TOP = BODIES.map((_, j) => j).filter(j => j === 0 || BODIES[j].parent === STAR.id).sort((a, b) => fromStar(a) - fromStar(b));
  const KIDS = TOP.map(p => BODIES.map((_, j) => j).filter(j => BODIES[j].parent === BODIES[p].id)
    .sort((a, b) => Math.hypot(BODIES[a].x - BODIES[p].x, BODIES[a].y - BODIES[p].y) - Math.hypot(BODIES[b].x - BODIES[p].x, BODIES[b].y - BODIES[p].y)));
  const ICON = { star: '✹', planet: '●', moon: '•', station: '◇' };
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
    const dest = new Set(activeMissions().map(k => MS.dest[k])), tb = targetBody();
    const el = $('loc');
    el.style.top = `${radarBox().y + radarBox().h + 12}px`;
    el.innerHTML = locRows.map(([j, child], n) => {
      const B = BODIES[j], tags = (B.port ? `<span class="tag">${B.kind === 'station' ? 'DOCK' : 'LAND'}</span>` : '') + (dest.has(j) ? '<span class="tag m">◆</span>' : '');
      return `<button type="button" data-j="${j}" class="${child ? 'child' : ''}${j === tb ? ' target' : ''}"><span class="n">${n < 9 ? n + 1 : ''}</span><span class="ico">${ICON[B.kind] || '•'}</span>`
        + `<span>${B.name}${tags}</span><span class="r">${fmtDist(dist(j) - B.r)}</span></button>`;
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
      const md = Math.hypot(mx, my), rr = Math.max(2.5, o.r * k), hot = o.surf <= 0, tgt = o.j === tb;
      if (md - rr > R) { // beyond range: a pip on the rim
        mx *= (R - 4) / md; my *= (R - 4) / md;
        hx.fillStyle = tgt ? TGT_COL : o.mission ? MIS_COL : NAV_COL; hx.beginPath(); hx.arc(cx + mx, cy + my, tgt || o.mission ? 3.5 : 2.5, 0, 6.283); hx.fill();
        continue;
      }
      hx.strokeStyle = tgt || hot ? NAV_HOT : o.mission ? MIS_COL : 'rgba(159,180,200,.75)'; hx.lineWidth = hot || o.mission || tgt ? 1.5 : 1;
      hx.beginPath(); hx.arc(cx + mx, cy + my, rr, 0, 6.283); hx.stroke();
      hx.fillStyle = tgt || hot ? NAV_HOT : o.mission ? MIS_COL : o.port ? 'rgba(127,208,138,.9)' : 'rgba(159,180,200,.85)'; hx.fillText(o.short.slice(0, 3).toUpperCase(), cx + mx, cy + my - rr - 7);
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
  const mapExtent = Math.max(...BODIES.map(b => Math.hypot(b.x - STAR.x, b.y - STAR.y) + b.r)) * 1.08;
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
    const v = mapView(), c = mx2, dest = new Set(activeMissions().map(k => MS.dest[k])), tb = targetBody(), ts = targetShip();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = 'rgba(7,9,12,.94)'; c.fillRect(0, 0, W, v.h);
    // orbits round each body's parent
    c.strokeStyle = 'rgba(138,149,164,.22)'; c.lineWidth = 1;
    for (const B of BODIES) {
      if (!B.parent) continue;
      const P = BODIES.find(o => o.id === B.parent) || STAR, [px, py] = mapPos(P.x, P.y, v);
      c.beginPath(); c.arc(px, py, Math.hypot(B.x - P.x, B.y - P.y) * v.s, 0, 6.283); c.stroke();
    }
    // the autopilot's course: to the point it is steering for (round any obstacle), then the target
    const auto = sim.game.auto[0] - 1;
    if (auto >= 0) {
      const [ax, ay] = mapPos(SH.rx[0], SH.ry[0], v), [wx, wy] = mapPos(sim.game.aim_x[0], sim.game.aim_y[0], v), [bx, by] = mapPos(BODIES[auto].x, BODIES[auto].y, v);
      c.setLineDash([5, 5]); c.strokeStyle = 'rgba(127,208,138,.8)'; c.beginPath(); c.moveTo(ax, ay); c.lineTo(wx, wy); c.lineTo(bx, by); c.stroke(); c.setLineDash([]);
    }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    BODIES.forEach((B, j) => {
      const [x, y] = mapPos(B.x, B.y, v), r = Math.max(B.kind === 'star' ? 7 : 3.5, B.r * v.s);
      c.fillStyle = B.kind === 'star' ? '#f2b26b' : B.kind === 'station' ? '#c9d2dc' : '#6f8296';
      if (B.kind === 'station') { c.save(); c.translate(x, y); c.rotate(Math.PI / 4); c.fillRect(-r, -r, 2 * r, 2 * r); c.restore(); }
      else { c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill(); }
      if (j === tb) { c.strokeStyle = TGT_COL; c.lineWidth = 2; c.beginPath(); c.arc(x, y, r + 6, 0, 6.283); c.stroke(); }
      if (dest.has(j)) { c.strokeStyle = MIS_COL; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, r + 10, 0, 6.283); c.stroke(); }
      c.font = '600 12px "IBM Plex Mono", ui-monospace, monospace';
      c.fillStyle = j === tb ? TGT_COL : dest.has(j) ? MIS_COL : B.port ? '#7fd08a' : '#9fb4c8';
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
    BODIES.forEach((B, j) => { const [bx, by] = mapPos(B.x, B.y, v), d = Math.hypot(bx - x, by - y) - Math.max(0, B.r * v.s - 4); if (d < bd) { bd = d; best = { body: j }; } });
    for (let i = 1; i < sim.count(); i++) {
      if (!SH.alive[i]) continue;
      const [sx, sy] = mapPos(SH.rx[i], SH.ry[i], v), d = Math.hypot(sx - x, sy - y);
      if (d < Math.min(bd, 8)) { bd = d; best = { ship: sim.handle(i) }; }
    }
    if (best) setTarget(best);
    e.preventDefault(); canvas.focus();
  });

  // test hook: drive and inspect the session from a console or a headless browser
  window.__play = {
    sim, IN, CMD, MODE, newGame, exportReplay, command, BODIES, ECON,
    setNav, trade, repay, showPanel, accept, abandon, setTarget, flyTo, cycleTarget, toggleMap, pickLocation,
    target: () => navTarget && (navTarget.body !== undefined ? { body: navTarget.body } : { ship: sim.resolve(navTarget.ship) }),
    locations: () => locRows.map(([j, child]) => ({ j, name: BODIES[j].name, child })),
    // ambient traffic: every ship in flight, with its role, phase, route and whether it is on rails
    traffic: () => { const out = []; for (let i = 0; i < sim.count(); i++) if (TR.role[i]) out.push({ i, role: TRAFFIC.roles[TR.role[i] - 1], phase: TR.phase[i], from: TR.from[i], to: TR.to[i], rail: SH.rail[i], x: SH.x[i], y: SH.y[i], v: Math.hypot(SH.vx[i], SH.vy[i]) }); return out; },
    // dev: put the (flying) player at rest over body j; a logged command, so replays still match
    teleport: j => command(CMD.teleport, j),
    // this port's offers and the player's active missions, as plain objects
    offers: () => { const at = sim.game.at[0], out = []; for (let k = 0; k < NO; k++) { const o = at * NO + k; if (OF.live[o]) out.push({ k, dest: OF.dest[o], good: OF.good[o], tons: OF.tons[o], pay: OF.pay[o], days: OF.days[o] }); } return out; },
    missions: () => Array.from(MS.state, (state, k) => ({ k, state, dest: MS.dest[k], tons: MS.tons[k], pay: MS.pay[k], due: MS.due[k] })),
    // commodity index by id, and its price where the player is landed
    good: id => GOODS.findIndex(c => c.id === id),
    price: id => sim.price(sim.game.at[0], GOODS.findIndex(c => c.id === id)),
    probe: () => ({ tick: sim.tick(), hash: sim.hash(), x: SH.x[0], y: SH.y[0], v: Math.hypot(SH.vx[0], SH.vy[0]), set: sim.playerSet(), assist: assistMode, mode: sim.mode(), day: sim.day(), at: sim.game.at[0], ready: typeReady(types[SH.kind[0]]), auto: sim.game.auto[0] - 1, map: mapOn,
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
  newGame(1);
  canvas.focus();
  requestAnimationFrame(frame);
}).catch(e => { console.error(e); $('glerr').textContent = 'The sim core failed to start: ' + (e.message || e); $('glerr').hidden = false; });
