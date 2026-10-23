// ======================= FLIGHT MODE =======================
// Simulation state is structure-of-arrays (typed arrays indexed by entity id).
// Rendering is instanced: one draw per ship type, one each for plumes, shields, bolts and particles.
// Its shaders are in shaders.js.

// Flight mode starts once the sim core is ready (WASM instantiation is async). Physics runs in the core;
// AI, weapons, shields, sensors and effects still run here, around each core tick.
let FLY = null, FLY_ERR = '';
const FLY_READY = CORE_READY.then(CORE => { FLY = (function () {
  const FP = {
    ship: compile(FLY_SHIP_VS, derive(SHIP_FS, DERIVE.ship), { iA: 1, iB: 2 }),
    shield: compile(FLY_SHIELD_VS, derive(SHIELD_FS, DERIVE.shield), { iA: 1, iH1: 2, iH2: 3 }),
    plume: compile(FLY_PLUME_VS, derive(PLUME_FS, DERIVE.plume), { iN: 1, iP: 2, iB: 3 }),
    bolt: compile(FLY_BOLT_VS, FLY_BOLT_FS, { iA: 1, iC: 2 }),
    part: compile(FLY_PART_VS, FLY_PART_FS, { iA: 1, iC: 2 }),
    planet: compile(PLANET_VS, PLANET_FS),
    neb: compile(NEB_VS, NEB_FS)
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
  function upload(V, data, count) { gl.bindBuffer(gl.ARRAY_BUFFER, V.buf); gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, Math.max(1, count) * V.per), gl.DYNAMIC_DRAW); }
  function pointAt(V, first) { // VAO bound: re-point instance attributes at instance `first`
    gl.bindBuffer(gl.ARRAY_BUFFER, V.buf);
    let off = first * V.stride;
    V.sizes.forEach((sz, k) => { gl.vertexAttribPointer(k + 1, sz, gl.FLOAT, false, V.stride, off); off += sz * 4; });
  }
  const VS = { ship: instVAO([4, 2]), shield: instVAO([4, 4, 4]), plume: instVAO([4, 4, 2]), bolt: instVAO([4, 4]), part: instVAO([4, 4]) };

  // ---------- entity storage (structure of arrays) ----------
  const MAXS = 320, MAXB = 4096, MAXP = 8192, MAXL = 64, BOLT_V = 1100, HIT_LIFE = 2.6;
  const SENS = 100; // sensor constant
  const ENV_N = 128, ENV_W = 26000, CELL = ENV_W / ENV_N, START = [1800, 1800]; // gas grid; start sunlit, off Tessaly's shadow
  // The sim core owns pose, motion, actuators and the gas grid; these names are views into its columns.
  const sim = CORE.world({ maxShips: MAXS, maxTypes: 64, maxBodies: 8, envN: ENV_N, envW: ENV_W, seed: 1 });
  const rnd = sim.rand; // seeded: every sim decision draws from the core's generator; visual-only noise keeps Math.random
  let seed = 1, forcedSeed;
  const SH = sim.ship;
  const sType = SH.kind, sAlive = SH.alive, sBurn = SH.burn;
  const sx = SH.x, sy = SH.y, svx = SH.vx, svy = SH.vy, sAng = SH.ang, sAv = SH.av, sThr = SH.thr;
  // actuators: main (-1 reverse .. 1 forward), lateral RCS (-1 left .. 1 right), turn; the core's assist writes them when cMode > 0
  const sTurnIn = SH.turn_in, sMain = SH.main, sLat = SH.lat;
  const cMode = SH.ctl, cVx = SH.want_vx, cVy = SH.want_vy, cFace = SH.want_face;
  const rX = SH.rx, rY = SH.ry, rA = SH.ra; // interpolated render pose, written each frame
  const sBrand = new Uint8Array(MAXS), sSize = new Uint8Array(MAXS);
  const sRole = new Uint8Array(MAXS), sMode = new Uint8Array(MAXS), sMount = new Uint8Array(MAXS);
  const sHp = new Float32Array(MAXS), sSh = new Float32Array(MAXS), sSince = new Float32Array(MAXS), sDmg = new Float32Array(MAXS);
  const sCd = new Float32Array(MAXS), sAi = new Float32Array(MAXS), sTx = new Float32Array(MAXS), sTy = new Float32Array(MAXS), sResp = new Float32Array(MAXS);
  const sFireIn = new Uint8Array(MAXS);
  const hAx = new Float32Array(MAXS), hAy = new Float32Array(MAXS), hAt = new Float32Array(MAXS), hAs = new Float32Array(MAXS);
  const hBx = new Float32Array(MAXS), hBy = new Float32Array(MAXS), hBt = new Float32Array(MAXS), hBs = new Float32Array(MAXS);
  // sensors: emitted signature, recent-fire glow, NPC's track of the player, player's track of each NPC, scan progress
  const sSig = new Float32Array(MAXS), sFireT = new Float32Array(MAXS), sDetP = new Float32Array(MAXS), pDet = new Float32Array(MAXS), pScan = new Float32Array(MAXS);
  let nS = 0;
  const bx = new Float32Array(MAXB), by = new Float32Array(MAXB), bvx = new Float32Array(MAXB), bvy = new Float32Array(MAXB), bLife = new Float32Array(MAXB), bDmg = new Float32Array(MAXB);
  const bOwn = new Int16Array(MAXB), bBrand = new Uint8Array(MAXB);
  let nB = 0;
  const px = new Float32Array(MAXP), py = new Float32Array(MAXP), pvx = new Float32Array(MAXP), pvy = new Float32Array(MAXP);
  const pLife = new Float32Array(MAXP), pMax = new Float32Array(MAXP), pSz = new Float32Array(MAXP), pGrow = new Float32Array(MAXP);
  const pr = new Float32Array(MAXP), pg = new Float32Array(MAXP), pb = new Float32Array(MAXP);
  let nP = 0;
  const lX = new Float32Array(MAXL), lY = new Float32Array(MAXL), lZ = new Float32Array(MAXL), lR = new Float32Array(MAXL), lT = new Float32Array(MAXL), lLife = new Float32Array(MAXL);
  const lCr = new Float32Array(MAXL), lCg = new Float32Array(MAXL), lCb = new Float32Array(MAXL);
  let nL = 0;
  const hostile = new Uint8Array(8);
  // player-only systems
  const pl = { set: 0, heat: 0, fuel: 1, cold: false, lock: false, ping: 0, pingCd: 0, pingR: -1, gas: [0, 0, 0], rad: 0, lit: 1, noise: 1 };

  // ---------- environment: nebula gas (three species on a coarse grid) and radiation ----------
  const gH = sim.env.h, gD = sim.env.d, gI = sim.env.i; // the core samples these for drag; JS for sensors and the radar
  const gasTex = gl.createTexture();
  const gasImg = document.createElement('canvas'); gasImg.width = gasImg.height = ENV_N;
  const ENV_KINDS = { mixed: [1, 0.9, 0.8], hydrogen: [1.5, 0, 0], dust: [0.35, 1.6, 0], ion: [0.3, 0, 1.6], clear: [0, 0, 0] };
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  function h2(x, y, s) { let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function vnoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = h2(xi, yi, s), b = h2(xi + 1, yi, s), c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }
  function fbm2(x, y, s) { let v = 0, a = 0.5; for (let o = 0; o < 5; o++) { v += a * vnoise(x, y, s + o * 17); x = x * 2.03 + 1.3; y = y * 2.03 - 0.7; a *= 0.5; } return v; }
  function genEnv() {
    const m = ENV_KINDS[state.env] || ENV_KINDS.mixed, seed = (rnd() * 1e6) | 0;
    const img = gasImg.getContext('2d').createImageData(ENV_N, ENV_N), tex = new Uint8Array(ENV_N * ENV_N * 4);
    for (let j = 0; j < ENV_N; j++) for (let i = 0; i < ENV_N; i++) {
      const wx = (i + 0.5) * CELL - ENV_W / 2, wy = (j + 0.5) * CELL - ENV_W / 2, k = j * ENV_N + i;
      const keep = smooth(1500, 4200, Math.hypot(wx - START[0], wy - START[1])) * smooth(0, 2500, ENV_W / 2 - Math.max(Math.abs(wx), Math.abs(wy))); // clear start, soft map edge
      const h = smooth(0.46 - 0.08 * (m[0] - 1), 0.72, fbm2(wx / 5200, wy / 5200, seed)) * Math.min(1, m[0]);
      const ridge = 1 - Math.abs(fbm2(wx / 3000, wy / 3000, seed + 99) * 2 - 1);
      const d = smooth(0.78 - 0.1 * (m[1] - 1), 0.93, ridge) * smooth(0.4, 0.6, fbm2(wx / 7000, wy / 7000, seed + 7)) * Math.min(1, m[1]);
      const io = smooth(0.6 - 0.12 * (m[2] - 1), 0.78, fbm2(wx / 3600, wy / 3600, seed + 51)) * Math.min(1, m[2]);
      gH[k] = h * keep; gD[k] = d * keep; gI[k] = io * keep;
      tex[k * 4] = gH[k] * 255; tex[k * 4 + 1] = gD[k] * 255; tex[k * 4 + 2] = gI[k] * 255; tex[k * 4 + 3] = 255;
      const q = ((ENV_N - 1 - j) * ENV_N + i) * 4; // radar image, north up
      img.data[q] = 40 + gH[k] * 150 + gD[k] * 50; img.data[q + 1] = 30 + gI[k] * 120 + gD[k] * 30; img.data[q + 2] = 40 + gI[k] * 170 + gH[k] * 40;
      img.data[q + 3] = Math.min(255, (gH[k] + gD[k] * 1.4 + gI[k]) * 150);
    }
    gasImg.getContext('2d').putImageData(img, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gasTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ENV_N, ENV_N, 0, gl.RGBA, gl.UNSIGNED_BYTE, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  const G3 = [0, 0, 0];
  function gasAt(x, y, out) { // bilinear sample of the three species
    const fx = (x + ENV_W / 2) / CELL - 0.5, fy = (y + ENV_W / 2) / CELL - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fy), tx = fx - i0, ty = fy - j0;
    out[0] = out[1] = out[2] = 0;
    if (i0 < 0 || j0 < 0 || i0 >= ENV_N - 1 || j0 >= ENV_N - 1) return out;
    const k = j0 * ENV_N + i0, w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    out[0] = gH[k] * w00 + gH[k + 1] * w10 + gH[k + ENV_N] * w01 + gH[k + ENV_N + 1] * w11;
    out[1] = gD[k] * w00 + gD[k + 1] * w10 + gD[k + ENV_N] * w01 + gD[k + ENV_N + 1] * w11;
    out[2] = gI[k] * w00 + gI[k + 1] * w10 + gI[k + ENV_N] * w01 + gI[k + ENV_N + 1] * w11;
    return out;
  }
  // optical depth between two points (per km): dust blinds, hydrogen and ions mildly
  function transmission(x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0), n = Math.min(12, 2 + Math.ceil(d / 1200)), ds = d / 1000 / n;
    let tau = 0;
    for (let k = 0; k < n; k++) { const f = (k + 0.5) / n; gasAt(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, G3); tau += (0.25 * G3[0] + 1.7 * G3[1] + 0.5 * G3[2]) * ds; }
    return Math.exp(-tau);
  }
  // radiation: the star (dimmed in planet shadows) plus ionized gas; flares multiply the stellar part
  const STAR_RAD = { sol: 1, red: 0.6, blue: 1.8 };
  const flare = { next: 75, warn: 0, t: -1, level: 0 };
  const LD = [1, 0];
  function sunDir2() { const v = sunVec(), l = Math.hypot(v[0], v[1]) || 1; LD[0] = v[0] / l; LD[1] = v[1] / l; return LD; }
  function litAt(x, y) {
    let lit = 1;
    for (const p of PLANETS) {
      const qx = x - p.x, qy = y - p.y, al = qx * LD[0] + qy * LD[1];
      if (al < 0) lit = Math.min(lit, smooth(p.r * 0.92, p.r * 1.04, Math.hypot(qx - al * LD[0], qy - al * LD[1])));
    }
    return lit;
  }
  function radAt(x, y, ion, out) { const lit = litAt(x, y); if (out) out.lit = lit; return (STAR_RAD[state.star] || 1) * (1 + 9 * flare.level) * lit + 0.8 * ion; }
  function stepFlare(dt) {
    if (flare.t >= 0) { flare.t += dt; flare.level = smooth(0, 1.2, flare.t) * (1 - smooth(7, 9, flare.t)); if (flare.t > 9) { flare.t = -1; flare.level = 0; flare.next = 70 + rnd() * 50; } return; }
    if (flare.warn > 0) { flare.warn -= dt; if (flare.warn <= 0) flare.t = 0; return; }
    if (state.solarFlares !== false) { flare.next -= dt; if (flare.next <= 0) flare.warn = 8; }
  }

  // instance scratch buffers
  const shipInst = new Float32Array(MAXS * 6), shieldInst = new Float32Array(MAXS * 12), plumeInst = new Float32Array(MAXS * 12 * 10);
  const boltInst = new Float32Array(MAXB * 8), partInst = new Float32Array(MAXP * 8);
  const typeCount = new Int32Array(64), typeStart = new Int32Array(64), typeFill = new Int32Array(64);
  const shieldCount = new Int32Array(64), shieldStart = new Int32Array(64), shieldFill = new Int32Array(64);

  const PLANETS = [
    { x: -3200, y: 2600, r: 1300, kind: 0, c1: '#1d4f7a', c2: '#5d7a3c', c3: '#d8cba8', atm: '#6fb3ff', air: 1, seed: 1.3, name: 'Tessaly' },
    { x: 6800, y: -4400, r: 2700, kind: 1, c1: '#c9925c', c2: '#7d4e33', c3: '#ecd9b0', atm: '#ffc98a', air: 1.2, seed: 4.1, name: 'Orrin' },
    { x: -8200, y: -6400, r: 820, kind: 2, c1: '#5e5953', c2: '#8a8178', c3: '#c9c0b4', atm: '#b0a8a0', air: 0, seed: 7.7, name: 'Kell' }
  ].map(p => Object.assign(p, { g: 0.004 * p.r, L1: hexRGB(p.c1), L2: hexRGB(p.c2), L3: hexRGB(p.c3), LA: lin(hexRGB(p.atm)) }));
  PLANETS.forEach((p, j) => { sim.body.x[j] = p.x; sim.body.y[j] = p.y; sim.body.r[j] = p.r; sim.body.g[j] = p.g; });
  sim.setBodies(PLANETS.length);

  // ---------- ship types (one per baked brand x size) ----------
  let types = [];
  const nSizes = () => catalog.sizes.length;
  function buildTypes() {
    types = [];
    catalog.brands.forEach((b, bi) => catalog.sizes.forEach((z, zi) => {
      const s = ships.get(keyOf(b.id, z.id));
      const fz = z.flight || {}, fb = b.style.flight || {};
      const T = {
        bi, zi, s, ready: !!(s && s.ready && s.tex), texRef: s && s.tex, name: b.name + ' ' + z.name, brand: b, L: z.length,
        accel: (fz.accel || 60) * (fb.accel || 1), turn: (fz.turn || 1) * (fb.turn || 1), vmax: (fz.vmax || 200) * (fb.vmax || 1),
        hull: (fz.hull || 100) * (fb.hull || 1), shield: (fz.shield || 100) * (fb.shield || 1), rate: fz.rate || 4, dmg: fz.dmg || 8, br: brandRender(b)
      };
      if (T.ready) {
        const m = s.maps;
        T.half = m.extent / 2; T.extent = m.extent; T.S = m.shieldS; T.Dmax = m.Dmax;
        T.eng = m.engines.map(e => ({ lx: (e.u - 0.5) * m.extent, ly: (0.5 - e.v) * m.extent, w: e.w * m.extent, dx: e.dx, dy: e.dy }));
        let ax = 0, ay = 0; T.eng.forEach(e => { ax += e.lx; ay += e.ly; });
        T.engX = T.eng.length ? ax / T.eng.length : 0; T.engY = T.eng.length ? ay / T.eng.length : -T.half * 0.6;
        T.mounts = s.spec.parts.filter(p => p.role === 'weapon').map(p => [p.x, p.y]);
        if (!T.mounts.length) T.mounts = [[0, T.half * 0.3]];
        T.hullEps = T.Dmax / 255 * 1.5;
      }
      const ti = types.length;
      sim.type.accel[ti] = T.accel; sim.type.turn[ti] = T.turn; sim.type.vmax[ti] = T.vmax; sim.type.well[ti] = fz.well == null ? 0.5 : fz.well;
      types.push(T);
    }));
  }
  function typesStale() { return types.length !== catalog.brands.length * nSizes() || types.some(T => { const s = ships.get(keyOf(T.brand.id, catalog.sizes[T.zi].id)); return !s || s.tex !== T.texRef || T.brand !== catalog.brands[T.bi]; }); }
  const allReady = () => types.length && types.every(T => T.ready);

  // ---------- spawning ----------
  const SIZE_W = [0.36, 0.3, 0.2, 0.1, 0.04];
  function randomType() {
    let x = rnd(), zi = 0; for (; zi < SIZE_W.length - 1; zi++) { x -= SIZE_W[zi]; if (x <= 0) break; }
    const bi = Math.floor(rnd() * catalog.brands.length);
    return bi * nSizes() + Math.min(zi, nSizes() - 1);
  }
  function pickWaypoint(i) {
    if (sRole[i] === 0) { const p = PLANETS[Math.floor(rnd() * PLANETS.length)]; const a = rnd() * 6.283; sTx[i] = p.x + Math.cos(a) * p.r * 1.35; sTy[i] = p.y + Math.sin(a) * p.r * 1.35; }
    else { const a = rnd() * 6.283, r = 1500 + rnd() * 6000; sTx[i] = Math.cos(a) * r; sTy[i] = Math.sin(a) * r; }
  }
  // ang: facing (random if omitted)
  function spawn(i, ti, x, y, role, ang) {
    const T = types[ti];
    sType[i] = ti; sBrand[i] = T.bi; sSize[i] = T.zi; sAlive[i] = 1; sRole[i] = role; sMode[i] = 0; sMount[i] = 0; sBurn[i] = 0;
    sx[i] = x; sy[i] = y; sAng[i] = ang === undefined ? rnd() * 6.283 : ang; sAv[i] = 0; sThr[i] = 0;
    const v0 = i === 0 ? 0 : T.vmax * (0.2 + rnd() * 0.3);
    svx[i] = -Math.sin(sAng[i]) * v0; svy[i] = Math.cos(sAng[i]) * v0;
    sHp[i] = T.hull; sSh[i] = T.shield; sSince[i] = 99; sDmg[i] = 0; sCd[i] = rnd(); sAi[i] = rnd() * 0.5; sResp[i] = 0;
    sTurnIn[i] = 0; sFireIn[i] = 0; sMain[i] = 0; sLat[i] = 0; cMode[i] = 0;
    sim.slotReset(i, true); // new generation, and no interpolation streak from the old pose
    sSig[i] = 1; sFireT[i] = 0; sDetP[i] = 0; pDet[i] = 0; pScan[i] = 0;
    hAt[i] = -1e9; hBt[i] = -1e9;
    if (i === 0) { pl.set = v0; pl.heat = 0; pl.fuel = 1; pl.cold = false; pl.lock = false; }
    if (i !== 0) pickWaypoint(i);
  }
  function playerType() {
    const bi = Math.max(0, catalog.brands.findIndex(b => b.id === state.flyBrand)), zi = Math.max(0, catalog.sizes.findIndex(z => z.id === state.flySize));
    return bi * nSizes() + zi;
  }
  function resetWorld() {
    nB = 0; nP = 0; nL = 0; hostile.fill(0);
    // the one host-random draw (unless a seed is forced): everything after replays from it, given the same inputs
    seed = forcedSeed !== undefined ? forcedSeed >>> 0 : (Math.random() * 4294967296) >>> 0; forcedSeed = undefined;
    sim.clear(); sim.reseed(seed);
    nS = Math.min(MAXS, 1 + state.traffic); sim.setCount(nS);
    spawn(0, playerType(), START[0], START[1], 1, 0);
    for (let i = 1; i < nS; i++) {
      const a = rnd() * 6.283, r = 1200 + rnd() * 9000;
      spawn(i, randomType(), Math.cos(a) * r, Math.sin(a) * r, rnd() < 0.55 ? 0 : 1);
    }
    applyPirates();
    camX = START[0]; camY = START[1]; target = -1; simT = 0; pl.ping = 0; pl.pingCd = 0; pl.pingR = -1;
    genEnv(); flare.next = 60 + rnd() * 40; flare.warn = 0; flare.t = -1; flare.level = 0;
  }
  function ping() { if (pl.pingCd > 0 || !sAlive[0]) return; pl.ping = 1; pl.pingCd = 6; pl.pingR = 0; }
  function flareNow() { if (flare.t < 0 && flare.warn <= 0) flare.warn = 5; }
  function applyPirates() { const ri = catalog.brands.findIndex(b => b.id === 'union.military'); if (ri >= 0 && state.pirates) hostile[ri] = 1; }
  function respawnNPC(i) {
    const a = rnd() * 6.283, r = 4000 + rnd() * 5000;
    spawn(i, randomType(), sx[0] + Math.cos(a) * r, sy[0] + Math.sin(a) * r, rnd() < 0.55 ? 0 : 1);
  }

  // ---------- effects ----------
  function addParticle(x, y, vx, vy, life, size, grow, r, g, b) {
    if (nP >= MAXP) return;
    const k = nP++; px[k] = x; py[k] = y; pvx[k] = vx; pvy[k] = vy; pLife[k] = life; pMax[k] = life; pSz[k] = size; pGrow[k] = grow; pr[k] = r; pg[k] = g; pb[k] = b;
  }
  function addLight(x, y, z, r, life, c, k) {
    if (nL >= MAXL) return;
    const j = nL++; lX[j] = x; lY[j] = y; lZ[j] = z; lR[j] = r; lT[j] = 0; lLife[j] = life; lCr[j] = c[0] * k; lCg[j] = c[1] * k; lCb[j] = c[2] * k;
  }
  function sparks(x, y, vx, vy, n, col, speed, size, life) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.283, s = speed * (0.3 + Math.random());
      addParticle(x, y, vx + Math.cos(a) * s, vy + Math.sin(a) * s, life * (0.5 + Math.random()), size * (0.6 + Math.random() * 0.8), -0.4, col[0] * 3, col[1] * 3, col[2] * 3);
    }
  }
  let shake = 0;
  function explode(i) {
    const T = types[sType[i]], L = T.L;
    sAlive[i] = 0; sResp[i] = i === 0 ? 3 : 5 + rnd() * 6;
    const hot = [1.0, 0.75, 0.45], col = T.br.plCol;
    addParticle(sx[i], sy[i], svx[i] * 0.5, svy[i] * 0.5, 0.6, L * 0.9, 1.6, 6, 4.5, 3);
    addParticle(sx[i], sy[i], svx[i] * 0.5, svy[i] * 0.5, 1.4, L * 0.6, 0.9, col[0] * 2, col[1] * 2, col[2] * 2);
    const n = 40 + sSize[i] * 45;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.283, s = (40 + L * 1.5) * Math.pow(Math.random(), 0.6);
      const c = Math.random() < 0.7 ? hot : col;
      addParticle(sx[i] + Math.cos(a) * L * 0.2 * Math.random(), sy[i] + Math.sin(a) * L * 0.2 * Math.random(), svx[i] + Math.cos(a) * s, svy[i] + Math.sin(a) * s, 0.6 + Math.random() * 1.4, L * (0.04 + Math.random() * 0.1), 0.6, c[0] * 4, c[1] * 4, c[2] * 4);
    }
    addLight(sx[i], sy[i], L * 0.4, L * 7, 1.1, [1.0, 0.7, 0.4], 9);
    const d = Math.hypot(sx[i] - sx[0], sy[i] - sy[0]);
    shake = Math.max(shake, Math.min(1, (L / 40) * Math.max(0, 1 - d / (L * 30 + 1500))));
    if (target === i) target = -1;
  }
  function hit(i, qx, qy, wx, wy, dmg, owner) {
    const T = types[sType[i]];
    sSince[i] = 0;
    if (owner === 0 && i !== 0) { hostile[sBrand[i]] = 1; }
    if (sSh[i] > 0) {
      sSh[i] -= dmg; if (sSh[i] <= 0) sSh[i] = Math.max(sSh[i], -0.25 * T.shield);
      hBx[i] = hAx[i]; hBy[i] = hAy[i]; hBt[i] = hAt[i]; hBs[i] = hAs[i];
      hAx[i] = qx; hAy[i] = qy; hAt[i] = simT; hAs[i] = Math.min(1.6, 0.6 + dmg / 12);
      sparks(wx, wy, svx[i], svy[i], 5, T.br.shCol, 90, 1.2 + T.L * 0.01, 0.35);
      addLight(wx, wy, T.L * 0.15 + 4, 40 + T.L * 1.2, 0.35, T.br.shCol, 4);
    } else {
      sHp[i] -= dmg; sDmg[i] = 1;
      sparks(wx, wy, svx[i], svy[i], 9, [1, 0.62, 0.3], 140, 1.0 + T.L * 0.008, 0.55);
      addLight(wx, wy, T.L * 0.1 + 3, 30 + T.L, 0.25, [1, 0.6, 0.3], 4);
      if (sHp[i] <= 0) explode(i);
    }
  }
  function fire(i, aimX, aimY) {
    const T = types[sType[i]]; if (nB >= MAXB) return;
    const volley = sSize[i] >= 3 ? 2 : 1;
    sFireT[i] = 1; if (i === 0) pl.heat += 0.014 * volley;
    for (let v = 0; v < volley; v++) {
      const m = T.mounts[sMount[i]++ % T.mounts.length];
      const c = Math.cos(sAng[i]), s = Math.sin(sAng[i]);
      const wx = sx[i] + c * m[0] - s * m[1], wy = sy[i] + s * m[0] + c * m[1];
      let dx = -s, dy = c;
      if (aimX !== undefined) { const ax = aimX - wx, ay = aimY - wy, al = Math.hypot(ax, ay) || 1; dx = ax / al; dy = ay / al; }
      const k = nB++;
      bx[k] = wx; by[k] = wy; bvx[k] = svx[i] + dx * BOLT_V; bvy[k] = svy[i] + dy * BOLT_V;
      bLife[k] = 1.15 + sSize[i] * 0.15; bDmg[k] = T.dmg; bOwn[k] = i; bBrand[k] = sBrand[i];
      addParticle(wx, wy, svx[i], svy[i], 0.08, 2 + T.L * 0.02, 2, T.br.plCol[0] * 4, T.br.plCol[1] * 4, T.br.plCol[2] * 4);
    }
  }

  // ---------- AI ----------
  const wrap = a => { a = (a + Math.PI) % 6.283185307; if (a < 0) a += 6.283185307; return a - Math.PI; };
  const clamp1 = v => v < -1 ? -1 : v > 1 ? 1 : v;
  // Flight assist: ask for a velocity (and optionally a facing); the core's control stage turns it into turn,
  // main/reverse and lateral commands each tick. face undefined: auto; null: leave the turn command alone.
  // NPCs always fly through it; the player does when assist is on.
  function control(i, tvx, tvy, face) {
    cVx[i] = tvx; cVy[i] = tvy;
    if (face === undefined) cMode[i] = 1;
    else if (face === null) cMode[i] = 3;
    else { cMode[i] = 2; cFace[i] = face; }
  }
  function seek(i, tx, ty, arrive) {
    const T = types[sType[i]], dx = tx - sx[i], dy = ty - sy[i], d = Math.hypot(dx, dy) || 1;
    const vd = arrive ? Math.min(T.vmax, Math.sqrt(2 * T.accel * sim.param('rev') * 0.6 * d)) : T.vmax * (sBurn[i] ? sim.param('burn_cap') : 1);
    control(i, dx / d * vd, dy / d * vd);
    return d;
  }
  function ai(i, dt) {
    const T = types[sType[i]];
    sFireIn[i] = 0; sBurn[i] = 0;
    const pdx = sx[0] - sx[i], pdy = sy[0] - sy[i], pd = Math.hypot(pdx, pdy) || 1;
    sAi[i] -= dt;
    if (sAi[i] <= 0) {
      sAi[i] = 0.35 + rnd() * 0.35;
      // hostiles only act on what their sensors hold: a cold player in dust can slip away
      if (hostile[sBrand[i]] && sAlive[0] && sDetP[i] > 1 && pd < 6000 + T.L * 6) sMode[i] = sRole[i] === 0 && sSize[i] < 3 ? 2 : 1;
      else sMode[i] = 0;
    }
    if (sMode[i] === 1) {
      const range = 900 + T.L * 3, t = pd / BOLT_V;
      const ax = sx[0] + (svx[0] - svx[i]) * t, ay = sy[0] + (svy[0] - svy[i]) * t;
      if (pd > range * 0.85) { sBurn[i] = pd > range * 2 ? 1 : 0; seek(i, ax, ay, false); }
      else {
        const k = (pd - range * 0.6) * 0.4, aim = Math.atan2(-(ax - sx[i]), ay - sy[i]);
        control(i, svx[0] + pdx / pd * k, svy[0] + pdy / pd * k, aim);
        if (Math.abs(wrap(aim - sAng[i])) < 0.12 + 25 / pd) sFireIn[i] = 1;
      }
      if (sSize[i] >= 3 && pd < range) { sFireIn[i] = 2; sTx[i] = ax; sTy[i] = ay; }
    } else if (sMode[i] === 2) {
      sBurn[i] = 1; seek(i, sx[i] - pdx / pd * 5000, sy[i] - pdy / pd * 5000, false);
    } else {
      const d = seek(i, sTx[i], sTy[i], true);
      if (d < 180 + T.L * 1.5) pickWaypoint(i);
    }
  }

  // ---------- simulation step ----------
  const keys = new Set();
  let simT = 0, camX = 0, camY = 0, target = -1, last = 0;
  function playerInput(dt) {
    const T = types[sType[0]];
    const left = keys.has('ArrowLeft') || keys.has('KeyA'), right = keys.has('ArrowRight') || keys.has('KeyD');
    const up = keys.has('ArrowUp') || keys.has('KeyW'), down = keys.has('ArrowDown') || keys.has('KeyS');
    sTurnIn[0] = (left ? 1 : 0) - (right ? 1 : 0);
    sBurn[0] = up && (keys.has('ShiftLeft') || keys.has('ShiftRight')) && pl.fuel > 0.01 && !pl.lock ? 1 : 0;
    sFireIn[0] = keys.has('Space') && !pl.lock ? 1 : 0;
    const hx = -Math.sin(sAng[0]), hy = Math.cos(sAng[0]);
    if (state.flightModel === 'assist') {
      // assist on: W/S move a set speed along the nose; the controller holds it and cancels drift
      const cap = T.vmax * (sBurn[0] ? sim.param('burn_cap') : 1);
      if (up) pl.set = Math.min(cap, pl.set + T.accel * (sBurn[0] ? sim.param('burn_accel') : 1) * dt);
      if (down) pl.set = Math.max(0, pl.set - T.accel * dt);
      if (!sBurn[0] && pl.set > T.vmax) pl.set = Math.max(T.vmax, pl.set - T.accel * 0.6 * dt);
      control(0, hx * pl.set, hy * pl.set, null);
    } else {
      // assist off: raw actuators
      cMode[0] = 0;
      sMain[0] = up ? 1 : down ? -1 : 0;
      sLat[0] = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
      if (keys.has('KeyX') && !left && !right && Math.hypot(svx[0], svy[0]) > 2) sTurnIn[0] = clamp1(wrap(Math.atan2(svx[0], -svy[0]) - sAng[0]) * 3 / T.turn);
      pl.set = Math.max(0, svx[0] * hx + svy[0] * hy);
    }
  }
  function puff(i, lx, ly, dx, dy) {
    const T = types[sType[i]], c = Math.cos(sAng[i]), s = Math.sin(sAng[i]);
    const wx = sx[i] + c * lx - s * ly, wy = sy[i] + s * lx + c * ly, vx = c * dx - s * dy, vy = s * dx + c * dy, sp = 25 + T.L * 0.8;
    addParticle(wx, wy, svx[i] + vx * sp, svy[i] + vy * sp, 0.22 + Math.random() * 0.15, 0.6 + T.L * 0.035, 2.2, 1.4, 1.45, 1.6);
  }
  const sNoise = new Float32Array(MAXS);
  // One fixed tick: decide (JS), then the core moves every ship (assist control, gas fields, turning, thrust,
  // drag, gravity, integration, dampers, engine glow), then the systems that react to the new state (JS).
  function step(dt) {
    preTick(dt);
    sim.step();
    postTick(dt);
  }
  function preTick(dt) {
    simT += dt;
    stepFlare(dt); sunDir2();
    if (sAlive[0]) playerInput(dt);
    pl.ping = Math.max(0, pl.ping - dt * 0.25); pl.pingCd = Math.max(0, pl.pingCd - dt); if (pl.pingR >= 0) { pl.pingR += dt * 9000; if (pl.pingR > 30000) pl.pingR = -1; }
    for (let i = 0; i < nS; i++) {
      if (!sAlive[i]) {
        sResp[i] -= dt;
        if (sResp[i] <= 0) { if (i === 0) { spawn(0, playerType(), sx[0], sy[0], 1); svx[0] = 0; svy[0] = 0; pl.set = 0; } else respawnNPC(i); }
        continue;
      }
      if (i !== 0) ai(i, dt);
    }
  }
  function postTick(dt) {
    for (let i = 0; i < nS; i++) {
      if (!sAlive[i]) continue;
      const T = types[sType[i]];
      const burn = sBurn[i] && sMain[i] > 0;
      G3[0] = SH.gas_h[i]; G3[1] = SH.gas_d[i]; G3[2] = SH.gas_i[i]; // sampled by the core this tick
      if (Math.abs(sx[i] - camX) < 2600 && Math.abs(sy[i] - camY) < 2600 && Math.random() < dt * 26) {
        if (Math.abs(sLat[i]) > 0.25) { const sg = sLat[i] > 0 ? 1 : -1; puff(i, -sg * T.half * 0.32, T.half * (Math.random() < 0.5 ? 0.25 : -0.2), -sg, 0); }
        if (sMain[i] < -0.25) puff(i, (Math.random() - 0.5) * T.half * 0.3, T.half * 0.42, 0, 1);
      }
      sCd[i] -= dt;
      if (sFireIn[i] && sCd[i] <= 0) { sCd[i] = 1 / T.rate * (i === 0 ? 1 : 1.6); if (sFireIn[i] === 2) fire(i, sTx[i], sTy[i]); else fire(i); }
      sFireT[i] = Math.max(0, sFireT[i] - dt * 1.2);
      // shields soak ionized gas and radiation; at zero they collapse into a deficit (a cold restart)
      const ion = G3[2], rad = radAt(sx[i], sy[i], ion, i === 0 ? pl : null), cold = i === 0 && pl.cold;
      sNoise[i] = 1 + 0.35 * rad + 0.6 * ion;
      if (cold && sSh[i] > 0) sSh[i] = 0;
      if (sSh[i] > 0) { sSh[i] -= T.shield * (0.12 * ion + 0.015 * rad) * dt; if (sSh[i] <= 0) sSh[i] = -0.25 * T.shield; }
      sSince[i] += dt;
      if (sSince[i] > 2.5 && sSh[i] < T.shield && !cold) sSh[i] = Math.min(T.shield, sSh[i] + T.shield * 0.07 * dt);
      sDmg[i] = Math.max(0, sDmg[i] - dt * 5);
      if (i === 0) {
        pl.gas[0] = G3[0]; pl.gas[1] = G3[1]; pl.gas[2] = G3[2]; pl.rad = rad; pl.noise = sNoise[0];
        const unshielded = sSh[0] <= 0;
        if (unshielded && rad > 1.5) { sHp[0] -= T.hull * 0.004 * (rad - 1.5) * dt; sDmg[0] = Math.max(sDmg[0], 0.25); if (sHp[0] <= 0) explode(0); }
        // heat: burn, fire and radiation add it; radiators shed it, much faster inside gas
        pl.heat += ((burn ? 0.05 : 0) + (unshielded ? 0.012 : 0.003) * rad) * dt;
        pl.heat = Math.max(0, pl.heat - 0.06 * (1 + 3 * (G3[0] + G3[1] + G3[2])) * dt);
        if (pl.heat >= 1) pl.lock = true; else if (pl.lock && pl.heat < 0.55) pl.lock = false;
        if (pl.heat > 1.2) { sHp[0] -= T.hull * 0.02 * dt; if (sHp[0] <= 0 && sAlive[0]) explode(0); }
        // fuel: the burner drinks it, hydrogen gas tops it up through the scoop
        pl.fuel = Math.max(0, Math.min(1, pl.fuel - (burn ? 0.035 : 0) * dt + 0.04 * G3[0] * dt));
      }
      // signature: hull size times what the ship is doing
      let e = 0.15 + 0.6 * sThr[i] + (burn ? 1.6 : 0) + (sSh[i] > 0 ? 0.25 : 0) + sFireT[i] * 1.2 + Math.abs(sLat[i]) * 0.1;
      if (i === 0) { e += pl.heat * 0.6 + pl.ping * 8; if (pl.cold) e *= 0.35; }
      sSig[i] = Math.pow(T.L / 18, 1.2) * e;
    }
    // sensors: SNR = signature / range^2 x gas transmission / local noise (radiation, ions)
    const gain = 1 + 5 * pl.ping;
    for (let i = 1; i < nS; i++) {
      if (!sAlive[i] || !sAlive[0]) { pDet[i] = 0; sDetP[i] = 0; continue; }
      const dx = sx[i] - sx[0], dy = sy[i] - sy[0], r2 = (dx * dx + dy * dy) / 1e6 + 0.04;
      const rawMe = SENS * sSig[i] * gain / r2 / pl.noise, rawThem = SENS * sSig[0] / r2 / sNoise[i];
      const tr = Math.max(rawMe, rawThem) < 0.5 ? 1 : transmission(sx[0], sy[0], sx[i], sy[i]);
      const me = rawMe * tr, them = rawThem * tr;
      pDet[i] += (me - pDet[i]) * Math.min(1, dt * (me > pDet[i] ? 4 : 1.5));
      sDetP[i] += (them - sDetP[i]) * Math.min(1, dt * (them > sDetP[i] ? 3 : 0.35)); // they remember where they last saw you
      if (target === i && pDet[i] >= 3 && dx * dx + dy * dy < 5000 * 5000) pScan[i] = Math.min(1, pScan[i] + dt / 2.2);
    }
    // bolts: integrate, then test against ships (broadphase box, then the baked shield/hull field)
    for (let k = 0; k < nB; k++) {
      bLife[k] -= dt;
      const ox = bx[k], oy = by[k];
      bx[k] += bvx[k] * dt; by[k] += bvy[k] * dt;
      let dead = bLife[k] <= 0;
      if (!dead) {
        const own = bOwn[k];
        for (let i = 0; i < nS; i++) {
          if (!sAlive[i] || i === own) continue;
          if (own !== 0 && i !== 0) continue; // NPC fire only threatens the player
          const T = types[sType[i]], h = T.half;
          if (Math.abs(bx[k] - sx[i]) > h + 40 || Math.abs(by[k] - sy[i]) > h + 40) continue;
          const c = Math.cos(sAng[i]), s = Math.sin(sAng[i]), thr = sSh[i] > 0 ? T.S : T.hullEps;
          for (let j = 1; j <= 6; j++) {
            const wx = ox + (bx[k] - ox) * j / 6, wy = oy + (by[k] - oy) * j / 6;
            const dx = wx - sx[i], dy = wy - sy[i];
            const qx = (c * dx + s * dy) / h, qy = (-s * dx + c * dy) / h;
            if (qx < -1 || qx > 1 || qy < -1 || qy > 1) continue;
            if (fieldAt(T.s, qx, qy) <= thr) { hit(i, qx, qy, wx, wy, bDmg[k], own); dead = true; break; }
          }
          if (dead) break;
        }
      }
      if (dead) { const e = --nB; bx[k] = bx[e]; by[k] = by[e]; bvx[k] = bvx[e]; bvy[k] = bvy[e]; bLife[k] = bLife[e]; bDmg[k] = bDmg[e]; bOwn[k] = bOwn[e]; bBrand[k] = bBrand[e]; k--; }
    }
    for (let k = 0; k < nP; k++) {
      pLife[k] -= dt;
      if (pLife[k] <= 0) { const e = --nP; px[k] = px[e]; py[k] = py[e]; pvx[k] = pvx[e]; pvy[k] = pvy[e]; pLife[k] = pLife[e]; pMax[k] = pMax[e]; pSz[k] = pSz[e]; pGrow[k] = pGrow[e]; pr[k] = pr[e]; pg[k] = pg[e]; pb[k] = pb[e]; k--; continue; }
      const dr = Math.max(0, 1 - dt * 0.8);
      pvx[k] *= dr; pvy[k] *= dr; px[k] += pvx[k] * dt; py[k] += pvy[k] * dt; pSz[k] *= 1 + pGrow[k] * dt;
    }
    for (let j = 0; j < nL; j++) {
      lT[j] += dt;
      if (lT[j] >= lLife[j]) { const e = --nL; lX[j] = lX[e]; lY[j] = lY[e]; lZ[j] = lZ[e]; lR[j] = lR[e]; lT[j] = lT[e]; lLife[j] = lLife[e]; lCr[j] = lCr[e]; lCg[j] = lCg[e]; lCb[j] = lCb[e]; j--; }
    }
    shake = Math.max(0, shake - dt * 1.8);
  }

  // ---------- rendering ----------
  let scale = 1;
  const LP = new Float32Array(64), LC = new Float32Array(64);
  const candW = new Float32Array(512), candD = new Float32Array(512 * 7);
  function gatherLights(viewR) {
    let n = 0;
    const push = (x, y, z, r, cr, cg, cb) => {
      if (n >= 512) return;
      const d = Math.hypot(x - camX, y - camY); if (d > viewR + r * 4) return;
      candW[n] = (cr + cg + cb) * r / (d + r);
      candD.set([x, y, z, r, cr, cg, cb], n * 7); n++;
    };
    for (let i = 0; i < nS; i++) {
      if (!sAlive[i] || sThr[i] < 0.05) continue;
      const T = types[sType[i]], c = Math.cos(rA[i]), s = Math.sin(rA[i]);
      const ex = T.engX, ey = T.engY - T.L * 0.12, pw = plumePower(sThr[i]) * 1.5;
      push(rX[i] + c * ex - s * ey, rY[i] + s * ex + c * ey, T.L * 0.05 + 1.5, T.L * 1.6 + 8, T.br.plCol[0] * pw, T.br.plCol[1] * pw, T.br.plCol[2] * pw);
    }
    for (let j = 0; j < nL; j++) { const f = 1 - lT[j] / lLife[j], k = f * f; push(lX[j], lY[j], lZ[j], lR[j], lCr[j] * k, lCg[j] * k, lCb[j] * k); }
    for (let k = 0; k < Math.min(nB, 48); k++) { const c = types[bBrand[k] * nSizes()].br.plCol; push(bx[k], by[k], 6, 70, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6); }
    // pick the strongest 16
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => candW[b] - candW[a]).slice(0, 16);
    idx.forEach((ci, k) => { LP.set(candD.subarray(ci * 7, ci * 7 + 4), k * 4); LC.set([candD[ci * 7 + 4], candD[ci * 7 + 5], candD[ci * 7 + 6], 0], k * 4); });
    return idx.length;
  }
  function setView(prog, RW, RH) {
    gl.useProgram(prog.p);
    gl.uniform2f(prog.u.uRes, RW, RH); gl.uniform2f(prog.u.uCam, camX, camY); gl.uniform1f(prog.u.uScale, scale);
  }
  const plU = new Float32Array(9);
  function drawNebula(front, t, RW, RH) {
    const u = FP.neb.u;
    gl.useProgram(FP.neb.p);
    gl.uniform2f(u.uRes, RW, RH); gl.uniform2f(u.uCam, camX, camY); gl.uniform1f(u.uScale, scale);
    gl.uniform1f(u.uTime, t); gl.uniform1f(u.uFront, front ? 1 : 0); gl.uniform1f(u.uWorld, ENV_W);
    gl.uniform1f(u.uFlare, flare.level + (flare.warn > 0 ? 0.08 * (0.5 + 0.5 * Math.sin(t * 9)) : 0));
    gl.uniform2f(u.uLdir, LD[0], LD[1]);
    PLANETS.forEach((p, k) => { plU[k * 3] = p.x; plU[k * 3 + 1] = p.y; plU[k * 3 + 2] = p.r; });
    gl.uniform3fv(u.uPl, plU);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gasTex); gl.uniform1i(u.uGas, 0);
    draw();
  }
  // Draws from the interpolated pose (rX, rY, rA): between the last two ticks at the clock's alpha, so motion is
  // smooth at any refresh rate. Bolts and particles are stepped back by the same fraction of a tick to match.
  function render(t) {
    const RW = canvas.width, RH = canvas.height, back = (1 - sim.alpha()) * sim.DT;
    const T0 = types[sType[0]];
    const viewW = Math.max(700, T0.L * 16) / state.zoom;
    scale = RW / viewW;
    const halfW = RW / scale / 2, halfH = RH / scale / 2, viewR = Math.hypot(halfW, halfH);
    const visible = i => Math.abs(rX[i] - camX) < halfW + types[sType[i]].half * 1.2 + types[sType[i]].L * 2 && Math.abs(rY[i] - camY) < halfH + types[sType[i]].half * 1.2 + types[sType[i]].L * 2;
    const star = STARS[state.star], sunCol = lin(star.col), sv = sunVec(), sl = Math.hypot(sv[0], sv[1]) || 1;

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.f); gl.viewport(0, 0, RW, RH);
    gl.disable(gl.BLEND);
    gl.useProgram(P.bg.p);
    gl.uniform2f(P.bg.u.uRes, RW, RH); gl.uniform1f(P.bg.u.uTime, t);
    gl.uniform3fv(P.bg.u.uStar, star.col); gl.uniform3fv(P.bg.u.uNeb, star.neb);
    gl.uniform2f(P.bg.u.uSunDir, sv[0] / sl, sv[1] / sl);
    gl.uniform2f(P.bg.u.uOff, camX * scale * 0.04, camY * scale * 0.04);
    draw();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    drawNebula(false, t, RW, RH);

    // planets
    setView(FP.planet, RW, RH);
    { const u = FP.planet.u;
      gl.uniform3fv(u.uSun, sv); gl.uniform3fv(u.uSunCol, sunCol); gl.uniform3fv(u.uAmb, star.amb); gl.uniform1f(u.uTime, t);
      for (const p of PLANETS) {
        if (Math.abs(p.x - camX) > halfW + p.r * 1.3 || Math.abs(p.y - camY) > halfH + p.r * 1.3) continue;
        gl.uniform2f(u.uC, p.x, p.y); gl.uniform1f(u.uR, p.r); gl.uniform1f(u.uPx, 1 / (p.r * scale));
        gl.uniform3fv(u.uC1, p.L1); gl.uniform3fv(u.uC2, p.L2); gl.uniform3fv(u.uC3, p.L3); gl.uniform3fv(u.uAtm, p.LA);
        gl.uniform1f(u.uSeed, p.seed); gl.uniform1i(u.uKind, p.kind); gl.uniform1f(u.uAir, p.air);
        draw();
      } }

    const nLights = gatherLights(viewR);

    // plumes: one instanced draw for every engine on screen
    let nPl = 0;
    if (state.map === 0) {
      for (let i = 0; i < nS && nPl < MAXS * 12; i++) {
        if (!sAlive[i] || sThr[i] < 0.03 || !visible(i)) continue;
        const T = types[sType[i]], br = T.br, c = Math.cos(rA[i]), s = Math.sin(rA[i]);
        const th = sThr[i], burn = sBurn[i] && sMain[i] > 0 ? 1 : 0, pw = plumePower(th) * (burn ? 1.3 : 1);
        for (let e = 0; e < T.eng.length; e++) {
          const E = T.eng[e], o = nPl * 10;
          plumeInst[o] = rX[i] + c * E.lx - s * E.ly; plumeInst[o + 1] = rY[i] + s * E.lx + c * E.ly;
          plumeInst[o + 2] = c * E.dx - s * E.dy; plumeInst[o + 3] = s * E.dx + c * E.dy;
          plumeInst[o + 4] = E.w * br.plLen * (0.3 + 1.7 * th) * (burn ? 1.6 : 1); plumeInst[o + 5] = E.w * br.plWid * 1.1;
          plumeInst[o + 6] = i * 7.3 + e * 1.37; plumeInst[o + 7] = pw;
          plumeInst[o + 8] = T.bi; plumeInst[o + 9] = burn;
          nPl++;
        }
      }
    }
    if (nPl) {
      gl.blendFunc(gl.ONE, gl.ONE);
      setView(FP.plume, RW, RH);
      const u = FP.plume.u; gl.uniform1f(u.uTime, t);
      const col = new Float32Array(48), core = new Float32Array(48), pp = new Float32Array(64), spr = new Float32Array(16), bcol = new Float32Array(48);
      catalog.brands.slice(0, 16).forEach((b, k) => { const br = brandRender(b); col.set(br.plCol, k * 3); core.set(br.plCore, k * 3); pp.set([br.plTurb, br.plDia, br.plSput, br.plPulse], k * 4); spr[k] = br.plSpread; bcol.set(br.plBurn, k * 3); });
      gl.uniform3fv(u.uPlCol, col); gl.uniform3fv(u.uPlCore, core); gl.uniform4fv(u.uPlP, pp); gl.uniform1fv(u.uPlSpread, spr); gl.uniform3fv(u.uPlBurn, bcol);
      gl.bindVertexArray(VS.plume.vao); upload(VS.plume, plumeInst, nPl);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nPl);
      gl.bindVertexArray(null);
    }

    // hulls: bucket visible ships by type, draw largest classes first
    const NT = types.length;
    typeCount.fill(0); shieldCount.fill(0);
    for (let i = 0; i < nS; i++) {
      if (!sAlive[i] || !visible(i)) continue;
      typeCount[sType[i]]++;
      if (state.map === 0 && (simT - hAt[i] < HIT_LIFE || (state.shields && state.shieldIdle > 0 && sSh[i] > 0))) shieldCount[sType[i]]++;
    }
    const order = Array.from({ length: NT }, (_, k) => k).sort((a, b) => types[b].zi - types[a].zi);
    let acc = 0, accS = 0;
    for (const k of order) { typeStart[k] = acc; acc += typeCount[k]; typeFill[k] = typeStart[k]; shieldStart[k] = accS; accS += shieldCount[k]; shieldFill[k] = shieldStart[k]; }
    for (let i = 0; i < nS; i++) {
      if (!sAlive[i] || !visible(i)) continue;
      const ti = sType[i], o = typeFill[ti]++ * 6;
      shipInst[o] = rX[i]; shipInst[o + 1] = rY[i]; shipInst[o + 2] = rA[i]; shipInst[o + 3] = sThr[i]; shipInst[o + 4] = sDmg[i]; shipInst[o + 5] = 0;
      if (state.map === 0 && (simT - hAt[i] < HIT_LIFE || (state.shields && state.shieldIdle > 0 && sSh[i] > 0))) {
        const q = shieldFill[ti]++ * 12, a1 = simT - hAt[i], a2 = simT - hBt[i];
        shieldInst.set([rX[i], rY[i], rA[i], state.shields && sSh[i] > 0 ? state.shieldIdle * 0.6 : 0,
          hAx[i], hAy[i], a1 < HIT_LIFE ? a1 : -1, hAs[i], hBx[i], hBy[i], a2 < HIT_LIFE ? a2 : -1, hBs[i]], q);
      }
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    setView(FP.ship, RW, RH);
    { const u = FP.ship.u;
      gl.uniform3fv(u.uSun, sv); gl.uniform3fv(u.uSunCol, sunCol); gl.uniform3fv(u.uAmb, star.amb);
      gl.uniform1f(u.uTime, t); gl.uniform1i(u.uMode, state.map); gl.uniform1f(u.uShadow, state.shadow ? 1 : 0);
      gl.uniform4fv(u.uLP, LP); gl.uniform4fv(u.uLC, LC); gl.uniform1i(u.uLN, nLights);
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
      gl.bindVertexArray(null); }

    // shields
    gl.blendFunc(gl.ONE, gl.ONE);
    if (accS) {
      setView(FP.shield, RW, RH);
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
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    drawNebula(true, t, RW, RH);
    gl.blendFunc(gl.ONE, gl.ONE);
    // bolts
    let nb = 0;
    for (let k = 0; k < nB; k++) {
      if (Math.abs(bx[k] - camX) > halfW + 80 || Math.abs(by[k] - camY) > halfH + 80) continue;
      const c = types[bBrand[k] * nSizes()].br.plCol, o = nb * 8;
      boltInst[o] = bx[k] - bvx[k] * back; boltInst[o + 1] = by[k] - bvy[k] * back; boltInst[o + 2] = bvx[k] - 0; boltInst[o + 3] = bvy[k];
      boltInst[o + 4] = c[0] * 3; boltInst[o + 5] = c[1] * 3; boltInst[o + 6] = c[2] * 3; boltInst[o + 7] = 22 + Math.min(40, bDmg[k] * 1.2);
      nb++;
    }
    if (nb) { setView(FP.bolt, RW, RH); gl.bindVertexArray(VS.bolt.vao); upload(VS.bolt, boltInst, nb); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nb); gl.bindVertexArray(null); }
    // particles
    let np = 0;
    for (let k = 0; k < nP; k++) {
      if (Math.abs(px[k] - camX) > halfW + pSz[k] || Math.abs(py[k] - camY) > halfH + pSz[k]) continue;
      const o = np * 8, f = pLife[k] / pMax[k];
      partInst[o] = px[k] - pvx[k] * back; partInst[o + 1] = py[k] - pvy[k] * back; partInst[o + 2] = pSz[k]; partInst[o + 3] = f * f;
      partInst[o + 4] = pr[k]; partInst[o + 5] = pg[k]; partInst[o + 6] = pb[k]; partInst[o + 7] = 0;
      np++;
    }
    if (np) { setView(FP.part, RW, RH); gl.bindVertexArray(VS.part.vao); upload(VS.part, partInst, np); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, np); gl.bindVertexArray(null); }
    gl.disable(gl.BLEND);
    postProcess();
    drawHUD(T0, viewW);
    stats.ships = nS; stats.bolts = nB; stats.parts = nP; stats.lights = nLights; stats.drawn = acc;
  }

  // ---------- HUD (2D canvas over the GL view) ----------
  const hud = $('hud'), hx = hud.getContext('2d');
  const stats = { ships: 0, bolts: 0, parts: 0, lights: 0, drawn: 0, fps: 60 };
  function toScreen(x, y) { return [(x - camX) * scale / dpr + W / 2, H / 2 - (y - camY) * scale / dpr]; }
  const level = i => pDet[i] >= 3 ? (pScan[i] >= 1 ? 3 : 2) : pDet[i] >= 1 ? 1 : 0; // 0 none, 1 contact, 2 identified, 3 scanned
  function drawHUD(T0, viewW) {
    if (hud.width !== Math.round(W * dpr) || hud.height !== Math.round(H * dpr)) { hud.width = Math.round(W * dpr); hud.height = Math.round(H * dpr); }
    hx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hx.clearRect(0, 0, W, H);
    const amber = '#e2b866', red = '#ff7a62', dim = '#8a95a4', fg = '#dbe0e7', mono = '500 11.5px "IBM Plex Mono", ui-monospace, monospace';
    hx.font = mono; hx.textBaseline = 'middle';
    const assist = state.flightModel === 'assist';
    if (sAlive[0]) {
      const [cx, cy] = toScreen(rX[0], rY[0]);
      const sp = Math.hypot(svx[0], svy[0]), r0 = Math.max(18, T0.half * scale / dpr * 0.75);
      if (sp > 1) {
        const len = 30 + 60 * Math.min(1.3, sp / T0.vmax), ux = svx[0] / sp, uy = -svy[0] / sp;
        hx.strokeStyle = 'rgba(226,184,102,.75)'; hx.lineWidth = 1.5;
        hx.beginPath(); hx.moveTo(cx + ux * r0, cy + uy * r0); hx.lineTo(cx + ux * (r0 + len), cy + uy * (r0 + len)); hx.stroke();
        hx.beginPath(); hx.arc(cx + ux * (r0 + len), cy + uy * (r0 + len), 4, 0, 6.283); hx.stroke();
      }
      if (assist) { // set-speed tick along the nose
        const nx = -Math.sin(rA[0]), ny = -Math.cos(rA[0]), len = 30 + 60 * Math.min(1.3, pl.set / T0.vmax);
        hx.strokeStyle = 'rgba(159,180,200,.7)'; hx.lineWidth = 1.5;
        const qx = cx + nx * (r0 + len), qy = cy + ny * (r0 + len);
        hx.beginPath(); hx.moveTo(qx - ny * 6, qy + nx * 6); hx.lineTo(qx + ny * 6, qy - nx * 6); hx.stroke();
      }
      if (pl.pingR >= 0) { // sensor ping wavefront
        hx.strokeStyle = `rgba(120,220,255,${Math.max(0, 0.6 - pl.pingR / 30000)})`; hx.lineWidth = 2;
        hx.beginPath(); hx.arc(cx, cy, pl.pingR * scale / dpr, 0, 6.283); hx.stroke();
      }
    }
    // target bracket: a scanned or identified target gets corners, a raw contact only an uncertainty circle
    if (target >= 0 && sAlive[target] && level(target) > 0) {
      const T = types[sType[target]], [tx, ty] = toScreen(rX[target], rY[target]), lv = level(target);
      const on = tx > 0 && ty > 0 && tx < W && ty < H;
      const col = lv >= 2 && hostile[sBrand[target]] ? red : '#9fb4c8';
      hx.strokeStyle = col; hx.fillStyle = col; hx.lineWidth = 1.5;
      if (on) {
        if (lv === 1) { const err = Math.hypot(rX[target] - rX[0], rY[target] - rY[0]) * 0.12 / Math.max(1, pDet[target]); hx.setLineDash([4, 4]); hx.beginPath(); hx.arc(tx, ty, Math.max(14, err * scale / dpr), 0, 6.283); hx.stroke(); hx.setLineDash([]); }
        else {
          const r = Math.max(14, T.half * scale / dpr * 0.7), k = r * 0.35;
          for (const [sxn, syn] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { hx.beginPath(); hx.moveTo(tx + sxn * r, ty + syn * (r - k)); hx.lineTo(tx + sxn * r, ty + syn * r); hx.lineTo(tx + sxn * (r - k), ty + syn * r); hx.stroke(); }
        }
      } else {
        const a = Math.atan2(ty - H / 2, tx - W / 2), rx = W / 2 - 30, ry = H / 2 - 30;
        const t = Math.min(rx / Math.abs(Math.cos(a) || 1e-6), ry / Math.abs(Math.sin(a) || 1e-6));
        const ax = W / 2 + Math.cos(a) * t, ay = H / 2 + Math.sin(a) * t;
        hx.beginPath(); hx.moveTo(ax + Math.cos(a) * 10, ay + Math.sin(a) * 10); hx.lineTo(ax + Math.cos(a + 2.5) * 9, ay + Math.sin(a + 2.5) * 9); hx.lineTo(ax + Math.cos(a - 2.5) * 9, ay + Math.sin(a - 2.5) * 9); hx.closePath(); hx.fill();
      }
    }
    // readout panel
    const lines = [];
    const pct = v => Math.round(v * 100) + '%';
    if (sAlive[0]) {
      const sp = Math.hypot(svx[0], svy[0]), hd = ((-rA[0] * 180 / Math.PI) % 360 + 360) % 360, burn = sBurn[0] && sMain[0] > 0;
      lines.push([T0.name, fg]);
      lines.push([`SPD ${sp.toFixed(0).padStart(4)} / ${T0.vmax.toFixed(0)} m/s${assist ? `  SET ${pl.set.toFixed(0)}` : ''}`, fg]);
      const flags = [assist ? 'ASSIST' : 'MANUAL', burn ? 'BURN' : '', pl.cold ? 'COLD' : '', pl.lock ? 'OVERHEAT' : ''].filter(Boolean).join('  ');
      lines.push([`HDG ${hd.toFixed(0).padStart(3, '0')}°  ${flags}`, pl.lock ? red : burn || pl.cold ? amber : dim]);
      const g = pl.gas, gasTxt = [['HYDROGEN', g[0]], ['DUST', g[1]], ['IONIZED', g[2]]].filter(e => e[1] > 0.05).map(e => `${e[0]} ${pct(e[1])}`).join(' · ') || 'CLEAR SPACE';
      lines.push([gasTxt, g[1] > 0.3 ? '#c8a27a' : g[2] > 0.3 ? '#6fd3ff' : g[0] > 0.3 ? '#ff8aa0' : dim]);
      lines.push([`RAD ${pl.rad.toFixed(1)}${pl.lit < 0.5 ? '  IN SHADOW' : ''}  NOISE ${pl.noise.toFixed(1)}`, pl.rad > 3 ? red : dim]);
    } else lines.push(['Hull breached. Respawning…', red]);
    if (target >= 0 && sAlive[target] && level(target) > 0) {
      const T = types[sType[target]], d = Math.hypot(rX[target] - rX[0], rY[target] - rY[0]), lv = level(target);
      const rv = ((svx[target] - svx[0]) * (rX[target] - rX[0]) + (svy[target] - svy[0]) * (rY[target] - rY[0])) / (d || 1);
      lines.push(['', '']);
      if (lv === 1) lines.push([`TGT unknown contact  SNR ${pDet[target].toFixed(1)}`, '#9fb4c8']);
      else lines.push([`TGT ${T.name}${hostile[sBrand[target]] ? '  HOSTILE' : ''}`, hostile[sBrand[target]] ? red : '#9fb4c8']);
      lines.push([`RNG ${(d / 1000).toFixed(2)} km ±${lv === 1 ? (d * 0.12 / Math.max(1, pDet[target]) / 1000).toFixed(2) : '0.00'}  ${rv < 0 ? 'CLOSING' : 'OPENING'} ${Math.abs(rv).toFixed(0)}`, dim]);
      if (lv === 3) {
        const sh = T.brand.style.shield || {};
        lines.push([`SCAN shield ${sh.pattern || 'hex'} ${pct(Math.max(0, sSh[target]) / T.shield)} · hull ${pct(sHp[target] / T.hull)}`, fg]);
        lines.push([`     sig ${sSig[target].toFixed(1)} · ${['trader', 'patrol'][sRole[target]] || 'ship'} · ${sDetP[target] > 1 ? 'TRACKING YOU' : 'unaware'}`, sDetP[target] > 1 ? amber : dim]);
      } else if (lv === 2) lines.push([d < 5000 ? `SCANNING ${pct(pScan[target])}` : 'SCAN: close to 5 km', dim]);
    }
    const bx0 = 14, by0 = 14, rows = sAlive[0] ? 5 : 0;
    hx.fillStyle = 'rgba(7,9,12,.55)'; hx.fillRect(bx0 - 8, by0 - 8, 300, lines.length * 17 + rows * 14 + 16);
    lines.forEach(([t, c], k) => { hx.fillStyle = c; hx.fillText(t, bx0, by0 + 6 + k * 17); });
    if (sAlive[0]) {
      const yb = by0 + lines.length * 17 + 6, T = T0;
      const bar = (y, f, col, label, note) => { hx.fillStyle = '#1e2630'; hx.fillRect(bx0 + 34, y - 3, 200, 6); hx.fillStyle = col; hx.fillRect(bx0 + 34, y - 3, 200 * Math.max(0, Math.min(1, f)), 6); hx.fillStyle = dim; hx.fillText(label, bx0, y); if (note) { hx.fillStyle = col; hx.fillText(note, bx0 + 240, y); } };
      bar(yb, sSh[0] / T.shield, 'rgb(' + T.br.shCol.map(v => Math.round(Math.pow(v, 1 / 2.2) * 255)).join(',') + ')', 'SHD', pl.cold ? 'OFF' : sSh[0] < 0 ? 'RESTART' : '');
      bar(yb + 14, sHp[0] / T.hull, amber, 'HUL');
      bar(yb + 28, pl.fuel, '#7fd08a', 'FUEL', pl.gas[0] > 0.1 ? 'SCOOP' : '');
      bar(yb + 42, Math.min(1, pl.heat), pl.heat > 0.8 ? red : '#e08a4a', 'HEAT');
      bar(yb + 56, Math.log10(1 + sSig[0]) / 1.5, '#9fb4c8', 'SIG', sSig[0].toFixed(1));
    }
    // flare warning
    if (flare.warn > 0 || flare.level > 0.02) {
      const msg = flare.warn > 0 ? `STELLAR FLARE IN ${Math.ceil(flare.warn)} s · GET INTO A PLANET'S SHADOW` : `FLARE ACTIVE${pl.lit < 0.5 ? ' · SHELTERED' : ' · EXPOSED'}`;
      hx.font = '600 13px "IBM Plex Mono", ui-monospace, monospace'; hx.textAlign = 'center';
      hx.fillStyle = 'rgba(7,9,12,.6)'; const w = hx.measureText(msg).width + 24; hx.fillRect(W / 2 - w / 2, 40, w, 26);
      hx.fillStyle = flare.warn > 0 ? amber : pl.lit < 0.5 ? '#7fd08a' : red; hx.fillText(msg, W / 2, 53);
      hx.textAlign = 'left'; hx.font = mono;
    }
    // radar: gas underlay, then contacts drawn at the level the sensors hold them
    const R = Math.min(96, Math.min(W, H) * 0.18), rcx = W - R - 16, rcy = H - R - 16, range = Math.max(14000, T0.L * 80);
    const cxw = rX[0], cyw = rY[0];
    hx.save(); hx.beginPath(); hx.arc(rcx, rcy, R, 0, 6.283); hx.clip();
    hx.fillStyle = 'rgba(7,9,12,.7)'; hx.fillRect(rcx - R, rcy - R, R * 2, R * 2);
    const pxPerM = R / range, imgS = ENV_W * pxPerM;
    hx.globalAlpha = 0.8; hx.imageSmoothingEnabled = true;
    hx.drawImage(gasImg, rcx - (cxw + ENV_W / 2) * pxPerM, rcy - (ENV_W / 2 - cyw) * pxPerM, imgS, imgS);
    hx.globalAlpha = 1;
    if (flare.level > 0.02 || flare.warn > 0) { // shadow corridors behind planets
      hx.fillStyle = 'rgba(140,240,160,.22)';
      for (const p of PLANETS) {
        const px0 = rcx + (p.x - cxw) * pxPerM, py0 = rcy - (p.y - cyw) * pxPerM, r = p.r * pxPerM, dx = -LD[0], dy = LD[1];
        hx.beginPath(); hx.moveTo(px0 - dy * r, py0 + dx * r); hx.lineTo(px0 - dy * r + dx * 400, py0 + dx * r + dy * 400); hx.lineTo(px0 + dy * r + dx * 400, py0 - dx * r + dy * 400); hx.lineTo(px0 + dy * r, py0 - dx * r); hx.closePath(); hx.fill();
      }
    }
    for (const p of PLANETS) {
      const dx = (p.x - cxw) * pxPerM, dy = -(p.y - cyw) * pxPerM;
      hx.strokeStyle = 'rgba(159,180,200,.5)'; hx.lineWidth = 1; hx.beginPath(); hx.arc(rcx + dx, rcy + dy, Math.max(2, p.r * pxPerM), 0, 6.283); hx.stroke();
    }
    for (let i = 1; i < nS; i++) {
      if (!sAlive[i]) continue;
      const lv = level(i); if (!lv) continue;
      const dx = (rX[i] - cxw) * pxPerM, dy = -(rY[i] - cyw) * pxPerM; if (dx * dx + dy * dy > R * R) continue;
      if (lv === 1) {
        const err = Math.hypot(rX[i] - cxw, rY[i] - cyw) * 0.12 / Math.max(1, pDet[i]) * pxPerM;
        hx.strokeStyle = 'rgba(200,210,220,.45)'; hx.beginPath(); hx.arc(rcx + dx, rcy + dy, Math.max(2.5, err), 0, 6.283); hx.stroke();
        hx.fillStyle = 'rgba(200,210,220,.8)'; hx.fillRect(rcx + dx - 1, rcy + dy - 1, 2, 2);
      } else {
        hx.fillStyle = hostile[sBrand[i]] ? red : types[sType[i]].brand.style.palette.emissive;
        const sz = 1.5 + sSize[i] * 0.6; hx.fillRect(rcx + dx - sz / 2, rcy + dy - sz / 2, sz, sz);
        if (sDetP[i] > 1 && hostile[sBrand[i]]) { hx.strokeStyle = red; hx.beginPath(); hx.arc(rcx + dx, rcy + dy, sz + 2.5, 0, 6.283); hx.stroke(); }
      }
      if (i === target) { hx.strokeStyle = fg; hx.strokeRect(rcx + dx - 4, rcy + dy - 4, 8, 8); }
    }
    if (pl.pingR >= 0) { hx.strokeStyle = 'rgba(120,220,255,.6)'; hx.beginPath(); hx.arc(rcx, rcy, pl.pingR * pxPerM, 0, 6.283); hx.stroke(); }
    hx.restore();
    hx.strokeStyle = 'rgba(138,149,164,.4)'; hx.lineWidth = 1; hx.beginPath(); hx.arc(rcx, rcy, R, 0, 6.283); hx.stroke();
    hx.fillStyle = fg; hx.save(); hx.translate(rcx, rcy); hx.rotate(-rA[0]); hx.beginPath(); hx.moveTo(0, -5); hx.lineTo(3.5, 4); hx.lineTo(-3.5, 4); hx.closePath(); hx.fill(); hx.restore();
    let nc = 0, ni = 0; for (let i = 1; i < nS; i++) { const lv = sAlive[i] ? level(i) : 0; if (lv === 1) nc++; else if (lv > 1) ni++; }
    hx.fillStyle = dim; hx.textAlign = 'right';
    hx.fillText(`${(range / 1000).toFixed(0)} km · ${ni} identified · ${nc} contacts`, rcx + R, rcy - R - 8);
    hx.fillText(`${stats.ships} ships · ${stats.bolts} bolts · ${stats.parts} particles · ${stats.fps.toFixed(0)} fps`, W - 16, 16);
    hx.textAlign = 'left';
  }

  // ---------- public ----------
  let needsReset = true, fpsAcc = 0, fpsN = 0;
  function frame(now) {
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016); last = now;
    fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { stats.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    if (typesStale()) buildTypes();
    const t = (now - t0) / 1000;
    if (!allReady()) {
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.f); gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.BLEND); gl.useProgram(P.bg.p); gl.uniform2f(P.bg.u.uRes, canvas.width, canvas.height); gl.uniform1f(P.bg.u.uTime, t); gl.uniform2f(P.bg.u.uOff, 0, 0); draw();
      postProcess();
      hx.setTransform(dpr, 0, 0, dpr, 0, 0); hx.clearRect(0, 0, W, H); hx.fillStyle = '#e2b866'; hx.font = '500 13px "IBM Plex Mono", monospace'; hx.fillText('Baking the fleet…', 20, 30);
      return;
    }
    if (needsReset) { resetWorld(); needsReset = false; }
    sim.checkViews();
    // fixed 60 Hz ticks: the core's clock says how many this frame owes, then the render pose is interpolated
    for (let n = sim.due(dt); n > 0; n--) step(sim.DT);
    sim.interpolate();
    { const lead = 0.35, tx = rX[0] + svx[0] * lead, ty = rY[0] + svy[0] * lead;
      const k = Math.min(1, dt * 3.5); camX += (tx - camX) * k; camY += (ty - camY) * k; }
    const shx = shake * shake * 14 / scale, a = Math.random() * 6.283;
    camX += Math.cos(a) * shx; camY += Math.sin(a) * shx;
    render(t);
  }
  function cycleTarget() {
    const list = [];
    for (let i = 1; i < nS; i++) if (sAlive[i] && pDet[i] >= 1) list.push([Math.hypot(sx[i] - sx[0], sy[i] - sy[0]), i]);
    list.sort((a, b) => a[0] - b[0]);
    if (!list.length) { target = -1; return; }
    const at = list.findIndex(e => e[1] === target);
    target = list[(at + 1) % Math.min(list.length, 8)][1];
  }
  function key(code, down, e) {
    if (down) {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(code) && e) e.preventDefault();
      if (code === 'Tab' || code === 'KeyT') { if (!keys.has(code)) cycleTarget(); }
      if (code === 'KeyF' && !keys.has(code)) { state.flightModel = state.flightModel === 'assist' ? 'newton' : 'assist'; syncFlightModel(); }
      if (code === 'KeyC' && !keys.has(code)) pl.cold = !pl.cold;
      if (code === 'KeyP' && !keys.has(code)) ping();
      if (code === 'KeyR' && !keys.has(code)) flareNow();
      if ((code === 'Equal' || code === 'NumpadAdd') && !keys.has(code)) setZoom(state.zoom * 1.25);
      if ((code === 'Minus' || code === 'NumpadSubtract') && !keys.has(code)) setZoom(state.zoom / 1.25);
      keys.add(code);
    } else keys.delete(code);
  }
  return {
    frame, key, clearKeys: () => keys.clear(),
    // reset(seed) restarts now with that seed (for replays and tests); reset() picks a fresh one next frame
    reset: s => { if (s !== undefined && allReady()) { forcedSeed = s; resetWorld(); needsReset = false; } else needsReset = true; },
    pirates: () => { applyPirates(); },
    calm: () => { hostile.fill(0); applyPirates(); },
    env: () => { if (allReady()) genEnv(); else needsReset = true; },
    flare: () => flareNow(),
    // test hooks: read player systems, teleport to the densest gas of a species (0 hydrogen, 1 dust, 2 ionized)
    probe: () => ({ t: +simT.toFixed(2), tick: sim.tick(), hash: sim.hash(), fps: +stats.fps.toFixed(1), set: +pl.set.toFixed(0), x: sx[0], y: sy[0], v: Math.hypot(svx[0], svy[0]), sh: sSh[0], hp: sHp[0], sig: sSig[0], heat: pl.heat, fuel: pl.fuel, gas: pl.gas.slice(), rad: pl.rad, lit: pl.lit, flare: flare.level, contacts: Array.from(pDet.subarray(1, nS)).filter(v => v >= 1).length, tracking: Array.from(sDetP.subarray(1, nS)).filter(v => v > 1).length }),
    advance: (sec, held) => { (held || []).forEach(k => keys.add(k)); for (let k = 0; k < Math.round(sec / sim.DT); k++) step(sim.DT); sim.interpolate(); (held || []).forEach(k => keys.delete(k)); },
    teleport: sp => { const g = [gH, gD, gI][sp]; let best = 0; for (let k = 1; k < g.length; k++) if (g[k] > g[best]) best = k; sx[0] = (best % ENV_N + 0.5) * CELL - ENV_W / 2; sy[0] = (Math.floor(best / ENV_N) + 0.5) * CELL - ENV_W / 2; sim.slotReset(0, false); camX = sx[0]; camY = sy[0]; },
    swapPlayer: () => { if (!allReady()) { needsReset = true; return; } spawn(0, playerType(), sx[0], sy[0], 1, sAng[0]); },
    // the sim core: columns, params (sim.param('damper', 0.6)), tick count and state hash
    sim, seed: () => seed
  };
})(); window.__fly = FLY; /* test hook */ }).catch(e => { FLY_ERR = String(e.message || e); console.error(e); });
window.__flyReady = FLY_READY; // test hook: settles once flight mode has started (or failed)
