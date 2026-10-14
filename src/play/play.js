// ======================= PLAY =======================
// The game page, on the way to M1. Rule: anything that changes game state runs in the sim core, so a session
// saves, loads and replays exactly (natively too). This page only turns keys into one input bitmask per tick,
// and draws what the core's columns say. Flight is the core's player model: assist on holds a set speed along
// the nose; assist off is raw thrust.
const $ = id => document.getElementById(id);
const catalog = JSON.parse($('catalog').textContent);
const canvas = $('view'), hud = $('hud'), hx = hud.getContext('2d');
const G = makeGfx(canvas);
if (!G) { $('glerr').hidden = false; return; }
const { gl, compile, P, quad, draw, tex } = G;

// ---------- the system (hand-authored until the system schema lands) ----------
const SYSTEM = {
  star: 'sol', sunAz: 135, sunEl: 35, start: [1800, 1800],
  planets: [
    { x: -3200, y: 2600, r: 1300, kind: 0, c1: '#1d4f7a', c2: '#5d7a3c', c3: '#d8cba8', atm: '#6fb3ff', seed: 1.3, name: 'Tessaly', city: 1 },
    { x: 6800, y: -4400, r: 2700, kind: 1, c1: '#c9925c', c2: '#7d4e33', c3: '#ecd9b0', atm: '#ffc98a', seed: 4.1, name: 'Orrin' },
    { x: -8200, y: -6400, r: 820, kind: 2, c1: '#5e5953', c2: '#8a8178', c3: '#c9c0b4', atm: '#b0a8a0', seed: 7.7, name: 'Kell' }
  ]
};
const PLANETS = SYSTEM.planets.map(p => Object.assign({}, p, { g: 0.004 * p.r, L1: hexRGB(p.c1), L2: hexRGB(p.c2), L3: hexRGB(p.c3), LA: lin(hexRGB(p.atm)) }));
const star = STARS[SYSTEM.star];
const sunVec = (() => { const az = SYSTEM.sunAz * Math.PI / 180, el = SYSTEM.sunEl * Math.PI / 180; return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)]; })();

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
  return true;
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
  planet: compile(PLANET_VS, PLANET_FS)
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
let assist = true, zoom = 1, bloomOn = true, nanView = 0, navOn = false;
function setNav(on) { navOn = on; $('b-nav').setAttribute('aria-pressed', String(on)); }
$('b-nav').onclick = () => { setNav(!navOn); canvas.focus(); };
window.addEventListener('keydown', e => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'F6', 'F9'].includes(e.code)) e.preventDefault();
  if (!keys.has(e.code)) {
    if (e.code === 'KeyF') assist = !assist;
    if (e.code === 'KeyI') setNav(!navOn);
    // debugging the flashing black squares: B toggles bloom, N paints bad scene pixels (see postProcess)
    if (e.code === 'KeyB') { bloomOn = !bloomOn; toast(`Bloom ${bloomOn ? 'on' : 'off'}`); }
    if (e.code === 'KeyN') { nanView = 1 - nanView; toast(nanView ? 'NaN view: magenta = bad scene pixel, cyan = bad bloom, yellow = negative' : 'NaN view off'); }
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
    | (assist ? IN.assist : 0);
}

let toastT = 0;
function toast(msg) { const el = $('toast'); el.textContent = msg; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2200); }
const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// these need the core; bound once it loads
let saveGame = () => {}, loadGame = () => {};

CORE_READY.then(CORE => {
  const sim = CORE.world({ maxShips: 64, maxTypes: 64, maxBodies: 8, envN: 16, envW: 40000, seed: 1 });
  const SH = sim.ship, IN = CORE.IN;
  types.forEach((T, k) => { sim.type.accel[k] = T.accel; sim.type.turn[k] = T.turn; sim.type.vmax[k] = T.vmax; });
  PLANETS.forEach((p, j) => { sim.body.x[j] = p.x; sim.body.y[j] = p.y; sim.body.r[j] = p.r; sim.body.g[j] = p.g; });
  sim.setBodies(PLANETS.length);

  // replay recording: the snapshot at the start of the session plus every input change since
  let rec = null, lastBits = -1;
  function startRecording() { rec = { start: sim.save(), startTick: sim.tick(), log: [] }; lastBits = -1; }

  function newGame(seed) {
    sim.clear(); sim.reseed(seed === undefined ? (Math.random() * 4294967296) >>> 0 : seed);
    sim.setCount(1);
    SH.kind[0] = playerTypeIndex(); SH.alive[0] = 1;
    SH.x[0] = SYSTEM.start[0]; SH.y[0] = SYSTEM.start[1]; SH.ang[0] = 0;
    sim.slotReset(0, true); sim.setPlayer(0);
    camX = SH.x[0]; camY = SH.y[0];
    startRecording();
  }
  saveGame = () => { localStorage.setItem('driftward.save', b64(sim.save())); toast(`Saved at tick ${sim.tick()}`); };
  loadGame = () => {
    const s = localStorage.getItem('driftward.save');
    if (!s) { toast('No saved game'); return; }
    const err = sim.load(unb64(s));
    if (err) { toast(`Save is unreadable (error ${err})`); return; }
    camX = SH.x[0]; camY = SH.y[0]; startRecording(); toast(`Loaded tick ${sim.tick()}`);
  };
  function exportReplay() {
    const ticks = sim.tick() - rec.startTick, hash = sim.hash();
    const log = `# driftward input log: replay with\n#   cargo run --release --bin replay -- driftward-save.bin driftward-inputs.txt ${ticks}\n# expect: tick ${sim.tick()} hash ${hash}\n` + rec.log.map(([t, b]) => `${t} ${b}`).join('\n') + '\n';
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
  let last = 0, camX = 0, camY = 0, fps = 60, fpsAcc = 0, fpsN = 0;
  const t0 = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = last ? Math.min(0.25, (now - last) / 1000) : 1 / 60; last = now;
    fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    sim.checkViews();
    const bits = inputBits(IN);
    if (bits !== lastBits) { sim.setInput(bits); rec.log.push([sim.tick(), bits]); lastBits = bits; }
    for (let n = sim.due(dt); n > 0; n--) sim.step();
    sim.interpolate();
    const lead = 0.35, k = Math.min(1, dt * 3.5);
    camX += (SH.rx[0] + SH.vx[0] * lead - camX) * k; camY += (SH.ry[0] + SH.vy[0] * lead - camY) * k;
    render((now - t0) / 1000, camX, camY);
    drawHUD();
  }

  // ---------- render ----------
  const MAXS = 64;
  const shipInst = new Float32Array(MAXS * 6), plumeInst = new Float32Array(MAXS * 12 * 10);
  const typeCount = new Int32Array(types.length), typeStart = new Int32Array(types.length), typeFill = new Int32Array(types.length);
  const LP = new Float32Array(64), LC = new Float32Array(64);
  const plCol = new Float32Array(12), plCore = new Float32Array(12), plP = new Float32Array(16), plSpread = new Float32Array(4);
  catalog.brands.slice(0, 4).forEach((b, k) => { const br = brandRender(b); plCol.set(br.plCol, k * 3); plCore.set(br.plCore, k * 3); plP.set([br.plTurb, br.plDia, br.plSput, br.plPulse], k * 4); plSpread[k] = br.plSpread; });
  const sunCol = lin(star.col), sl = Math.hypot(sunVec[0], sunVec[1]) || 1;
  // draw order: largest classes first, so small ships sit on top
  const order = types.map((_, k) => k).sort((a, b) => types[b].zi - types[a].zi);
  let scale = 1;
  function setView(prog, RW, RH, cx, cy) { gl.useProgram(prog.p); gl.uniform2f(prog.u.uRes, RW, RH); gl.uniform2f(prog.u.uCam, cx, cy); gl.uniform1f(prog.u.uScale, scale); }
  function render(t, cx, cy) {
    const RW = canvas.width, RH = canvas.height, T0 = types[SH.kind[0]], live = Math.min(MAXS, sim.count());
    scale = RW / (Math.max(700, T0.L * 16) / zoom);
    const halfW = RW / scale / 2, halfH = RH / scale / 2;
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, G.targets.scene.f); gl.viewport(0, 0, RW, RH);
    gl.disable(gl.BLEND);
    gl.useProgram(P.bg.p);
    gl.uniform2f(P.bg.u.uRes, RW, RH); gl.uniform1f(P.bg.u.uTime, t);
    gl.uniform3fv(P.bg.u.uStar, star.col); gl.uniform3fv(P.bg.u.uNeb, star.neb);
    gl.uniform2f(P.bg.u.uSunDir, sunVec[0] / sl, sunVec[1] / sl);
    gl.uniform2f(P.bg.u.uOff, cx * scale * 0.04, cy * scale * 0.04);
    draw();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    setView(FP.planet, RW, RH, cx, cy);
    { const u = FP.planet.u;
      gl.uniform3fv(u.uSun, sunVec); gl.uniform3fv(u.uSunCol, sunCol); gl.uniform3fv(u.uAmb, star.amb); gl.uniform1f(u.uTime, t);
      for (const p of PLANETS) {
        if (Math.abs(p.x - cx) > halfW + p.r * 1.3 || Math.abs(p.y - cy) > halfH + p.r * 1.3) continue;
        gl.uniform2f(u.uC, p.x, p.y); gl.uniform1f(u.uR, p.r); gl.uniform1f(u.uPx, 1 / (p.r * scale));
        gl.uniform3fv(u.uC1, p.L1); gl.uniform3fv(u.uC2, p.L2); gl.uniform3fv(u.uC3, p.L3); gl.uniform3fv(u.uAtm, p.LA);
        gl.uniform1f(u.uSeed, p.seed); gl.uniform1i(u.uKind, p.kind); gl.uniform1f(u.uCity, p.city || 0);
        draw();
      } }

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
      const burn = SH.burn[i] && SH.main[i] > 0 ? 1 : 0, pw = plumePower(th) * (burn ? 1.3 : 1);
      if (th >= 0.05 && nL < 16) { // engine light on the hull
        const ex = T.engX, ey = T.engY - T.L * 0.12, k = pw * 1.5;
        LP.set([SH.rx[i] + c * ex - s * ey, SH.ry[i] + s * ex + c * ey, T.L * 0.05 + 1.5, T.L * 1.6 + 8], nL * 4);
        LC.set([T.br.plCol[0] * k, T.br.plCol[1] * k, T.br.plCol[2] * k, 0], nL * 4); nL++;
      }
      if (th < 0.03) continue;
      for (let e = 0; e < T.eng.length && nPl < MAXS * 12; e++) {
        const E = T.eng[e], o = nPl * 10;
        plumeInst[o] = SH.rx[i] + c * E.lx - s * E.ly; plumeInst[o + 1] = SH.ry[i] + s * E.lx + c * E.ly;
        plumeInst[o + 2] = c * E.dx - s * E.dy; plumeInst[o + 3] = s * E.dx + c * E.dy;
        plumeInst[o + 4] = E.w * T.br.plLen * (0.3 + 1.7 * th) * (burn ? 1.6 : 1); plumeInst[o + 5] = E.w * T.br.plWid * 1.1;
        plumeInst[o + 6] = i * 7.3 + e * 1.37; plumeInst[o + 7] = pw; plumeInst[o + 8] = T.bi; plumeInst[o + 9] = burn;
        nPl++;
      }
    }
    if (nPl) {
      gl.blendFunc(gl.ONE, gl.ONE);
      setView(FP.plume, RW, RH, cx, cy);
      const u = FP.plume.u; gl.uniform1f(u.uTime, t);
      gl.uniform3fv(u.uPlCol, plCol); gl.uniform3fv(u.uPlCore, plCore); gl.uniform4fv(u.uPlP, plP); gl.uniform1fv(u.uPlSpread, plSpread);
      gl.bindVertexArray(VS.plume.vao); upload(VS.plume, plumeInst, nPl);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nPl);
      gl.bindVertexArray(null);
    }
    // hulls, bucketed by type
    let acc = 0;
    for (const k of order) { typeStart[k] = acc; acc += typeCount[k]; typeFill[k] = typeStart[k]; }
    for (let i = 0; i < live; i++) {
      if (!shown(i)) continue;
      const o = typeFill[SH.kind[i]]++ * 6;
      shipInst[o] = SH.rx[i]; shipInst[o + 1] = SH.ry[i]; shipInst[o + 2] = SH.ra[i]; shipInst[o + 3] = SH.thr[i]; shipInst[o + 4] = 0; shipInst[o + 5] = 0;
    }
    if (acc) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      setView(FP.ship, RW, RH, cx, cy);
      const u = FP.ship.u;
      gl.uniform3fv(u.uSun, sunVec); gl.uniform3fv(u.uSunCol, sunCol); gl.uniform3fv(u.uAmb, star.amb);
      gl.uniform1f(u.uTime, t); gl.uniform1i(u.uMode, 0); gl.uniform1f(u.uShadow, 1);
      gl.uniform4fv(u.uLP, LP); gl.uniform4fv(u.uLC, LC); gl.uniform1i(u.uLN, nL);
      gl.uniform1i(u.uA, 0); gl.uniform1i(u.uN, 1); gl.uniform1i(u.uE, 2); gl.uniform1i(u.uX, 3);
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
    gl.disable(gl.BLEND);
    G.postProcess(bloomOn ? 0.9 : 0, nanView);
  }

  // ---------- HUD ----------
  function drawHUD() {
    hx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hx.clearRect(0, 0, W, H);
    const T0 = types[SH.kind[0]], sp = Math.hypot(SH.vx[0], SH.vy[0]), hd = ((-SH.ang[0] * 180 / Math.PI) % 360 + 360) % 360;
    const burn = SH.burn[0] && SH.main[0] > 0;
    const lines = [
      [T0.name, '#dbe0e7'],
      [`SPD ${sp.toFixed(0).padStart(4)} / ${T0.vmax.toFixed(0)} m/s${assist ? `  SET ${sim.playerSet().toFixed(0)}` : ''}`, '#dbe0e7'],
      [`HDG ${hd.toFixed(0).padStart(3, '0')}°  ${assist ? 'ASSIST' : 'MANUAL'}${burn ? '  BURN' : ''}`, burn ? '#e2b866' : '#8a95a4'],
      [`TICK ${sim.tick()}  ${fps.toFixed(0)} fps`, '#8a95a4']
    ];
    hx.font = '500 11.5px "IBM Plex Mono", ui-monospace, monospace'; hx.textBaseline = 'middle';
    hx.fillStyle = 'rgba(7,9,12,.55)'; hx.fillRect(6, 6, 300, lines.length * 17 + 31); // + the nearest-body line
    lines.forEach(([t, c], k) => { hx.fillStyle = c; hx.fillText(t, 14, 20 + k * 17); });
    if (!typeReady(T0)) { hx.fillStyle = '#e2b866'; hx.fillText('Baking your ship…', 14, 20 + lines.length * 17 + 28); }
    drawShipMarks(T0);
    const navs = navObjects().map(o => Object.assign(o, navInfo(o)));
    drawNav(navs);
    drawMinimap(navs);
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
    if (assist) {
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

  // ---------- navigation: what is where ----------
  // Everything the player might steer for, from the player's drawn (interpolated) position. Planets for now;
  // stations, ports and targets join this list as they arrive.
  const navObjects = () => PLANETS.map(p => ({ name: p.name, x: p.x, y: p.y, r: p.r, kind: 'planet' }));
  function navInfo(o) {
    const dx = o.x - SH.rx[0], dy = o.y - SH.ry[0], d = Math.hypot(dx, dy) || 1;
    return { d, surf: d - o.r, closing: (SH.vx[0] * dx + SH.vy[0] * dy) / d }; // surface distance; closing speed > 0
  }
  const fmtDist = m => m < 1000 ? `${Math.max(0, m).toFixed(0)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
  const fmtClose = v => Math.abs(v) < 1 ? '' : `${v > 0 ? 'closing' : 'opening'} ${Math.abs(v).toFixed(0)} m/s`;
  const toScreen = (x, y) => [(x - camX) * scale / dpr + W / 2, H / 2 - (y - camY) * scale / dpr];
  const NAV_COL = '#9fb4c8', NAV_HOT = '#e2b866';
  // text with a dark outline, readable over bright cloud tops
  function label(text, x, y) { hx.lineWidth = 3.5; hx.lineJoin = 'round'; hx.strokeStyle = 'rgba(7,9,12,.85)'; hx.strokeText(text, x, y); hx.fillText(text, x, y); }

  // The status line names the nearest body; with the overlay on (I), every body gets a label where it is on
  // screen, or an arrow on the screen edge pointing at it, with surface distance and closing speed.
  function drawNav(navs) {
    let near = navs[0];
    for (const o of navs) if (o.surf < near.surf) near = o;
    hx.font = '600 12px "IBM Plex Mono", ui-monospace, monospace';
    hx.fillStyle = near.surf <= 0 ? NAV_HOT : NAV_COL;
    hx.fillText(near.surf <= 0 ? `OVER ${near.name.toUpperCase()}` : `NEAREST ${near.name.toUpperCase()} ${fmtDist(near.surf)}`, 14, 20 + 4 * 17);
    if (!navOn) return;
    const m = 34, x0 = m, y0 = m, x1 = W - m, y1 = H - stripH - m, cx = W / 2, cy = (H - stripH) / 2;
    hx.textBaseline = 'middle';
    for (const o of navs) {
      const [sx, sy] = toScreen(o.x, o.y), hot = o.surf <= 0, col = hot ? NAV_HOT : NAV_COL;
      const name = o.name.toUpperCase(), sub = hot ? 'OVER' : `${fmtDist(o.surf)}  ${fmtClose(o.closing)}`.trim();
      hx.fillStyle = col; hx.strokeStyle = col; hx.lineWidth = 1.5;
      if (sx > x0 && sx < x1 && sy > y0 && sy < y1) { // centre on screen: label it there
        hx.textAlign = 'center';
        hx.beginPath(); hx.arc(sx, sy, 5, 0, 6.283); hx.stroke();
        hx.font = '600 13px "IBM Plex Mono", ui-monospace, monospace'; label(name, sx, sy - 16);
        hx.font = '500 11.5px "IBM Plex Mono", ui-monospace, monospace'; label(sub, sx, sy + 17);
        continue;
      }
      // off screen: an arrow where the line from the view centre leaves the inset box
      let dx = sx - cx, dy = sy - cy; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const t = Math.min(dx > 0 ? (x1 - cx) / dx : dx < 0 ? (x0 - cx) / dx : 1e9, dy > 0 ? (y1 - cy) / dy : dy < 0 ? (y0 - cy) / dy : 1e9);
      const ax = cx + dx * t, ay = cy + dy * t, a = Math.atan2(dy, dx);
      hx.beginPath(); hx.moveTo(ax + Math.cos(a) * 11, ay + Math.sin(a) * 11);
      hx.lineTo(ax + Math.cos(a + 2.5) * 10, ay + Math.sin(a + 2.5) * 10); hx.lineTo(ax + Math.cos(a - 2.5) * 10, ay + Math.sin(a - 2.5) * 10);
      hx.closePath(); hx.lineWidth = 3; hx.strokeStyle = 'rgba(7,9,12,.85)'; hx.stroke(); hx.fill();
      hx.strokeStyle = col;
      const lx = ax - dx * 26, ly = ay - dy * 26; // label just inside the arrow
      hx.textAlign = dx > 0.5 ? 'right' : dx < -0.5 ? 'left' : 'center';
      hx.font = '600 12px "IBM Plex Mono", ui-monospace, monospace'; label(name, lx, ly - 7);
      hx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace'; label(sub, lx, ly + 8);
    }
    hx.textAlign = 'left';
  }

  // Minimap: north up, centred on the player, bodies to scale; anything beyond the range sits on the rim.
  const MAP_RANGE = 16000; // meters from centre to rim
  function drawMinimap(navs) {
    const R = Math.max(60, Math.min(96, Math.min(W, H) * 0.14)), cx = W - R - 14, cy = H - stripH - R - 14, k = R / MAP_RANGE;
    const px = SH.rx[0], py = SH.ry[0];
    hx.save();
    hx.beginPath(); hx.arc(cx, cy, R, 0, 6.283); hx.fillStyle = 'rgba(7,9,12,.72)'; hx.fill(); hx.clip();
    hx.strokeStyle = 'rgba(138,149,164,.18)'; hx.lineWidth = 1;
    hx.beginPath(); hx.arc(cx, cy, R / 2, 0, 6.283); hx.stroke();
    hx.beginPath(); hx.moveTo(cx - R, cy); hx.lineTo(cx + R, cy); hx.moveTo(cx, cy - R); hx.lineTo(cx, cy + R); hx.stroke();
    hx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace'; hx.textAlign = 'center'; hx.textBaseline = 'middle';
    for (const o of navs) {
      let mx = (o.x - px) * k, my = -(o.y - py) * k;
      const md = Math.hypot(mx, my), rr = Math.max(2.5, o.r * k), hot = o.surf <= 0;
      if (md - rr > R) { // beyond range: a pip on the rim
        mx *= (R - 4) / md; my *= (R - 4) / md;
        hx.fillStyle = NAV_COL; hx.beginPath(); hx.arc(cx + mx, cy + my, 2.5, 0, 6.283); hx.fill();
        continue;
      }
      hx.strokeStyle = hot ? NAV_HOT : 'rgba(159,180,200,.75)'; hx.lineWidth = hot ? 1.5 : 1;
      hx.beginPath(); hx.arc(cx + mx, cy + my, rr, 0, 6.283); hx.stroke();
      hx.fillStyle = hot ? NAV_HOT : 'rgba(159,180,200,.85)'; hx.fillText(o.name.slice(0, 3).toUpperCase(), cx + mx, cy + my - rr - 7);
    }
    // the player: velocity line and heading arrow (world y up, screen y down)
    const vx = SH.vx[0] * k * 6, vy = -SH.vy[0] * k * 6;
    hx.strokeStyle = 'rgba(226,184,102,.8)'; hx.beginPath(); hx.moveTo(cx, cy); hx.lineTo(cx + vx, cy + vy); hx.stroke();
    hx.translate(cx, cy); hx.rotate(-SH.ra[0]);
    hx.fillStyle = '#dbe0e7'; hx.beginPath(); hx.moveTo(0, -6); hx.lineTo(4, 5); hx.lineTo(-4, 5); hx.closePath(); hx.fill();
    hx.restore();
    hx.strokeStyle = 'rgba(138,149,164,.45)'; hx.lineWidth = 1; hx.beginPath(); hx.arc(cx, cy, R, 0, 6.283); hx.stroke();
    hx.fillStyle = '#8a95a4'; hx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace'; hx.textAlign = 'right';
    hx.fillText(`${MAP_RANGE / 1000} km`, cx + R, cy - R - 8);
    hx.textAlign = 'left';
  }

  // test hook: drive and inspect the session from a console or a headless browser
  window.__play = {
    sim, IN, newGame, exportReplay,
    setNav,
    probe: () => ({ tick: sim.tick(), hash: sim.hash(), x: SH.x[0], y: SH.y[0], v: Math.hypot(SH.vx[0], SH.vy[0]), set: sim.playerSet(), assist, ready: typeReady(types[SH.kind[0]]) }),
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
