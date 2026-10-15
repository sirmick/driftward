(function () {
'use strict';
const $ = id => document.getElementById(id);
const CATALOG0 = ShipGen.resolveCatalog(JSON.parse($('catalog').textContent)); // factions' lines as brands
let catalog = JSON.parse(JSON.stringify(CATALOG0));
const GEN_TEXT = $('gen').textContent;
/*LOOK*/

const DRIFT_COLS = ['#ff5a4a', '#4ab8ff', '#ffd25a', '#b46bff', '#4dffa8', '#ff8ad8', '#ffffff', '#ff9a3d', '#6af0ff', '#c8ff5a'].map(h => lin(hexRGB(h)));
const state = {
  view: 'grid', brand: catalog.brands[0].id, size: catalog.sizes[2].id,
  map: 0, spin: true, trueScale: false, shadow: true, pl: true,
  sunAz: 135, sunEl: 35, star: 'sol', seed: 'kestrel-7',
  planetSeed: 'set-1', planetFocus: -1, sunSeed: 's1', sunFocus: -1, stSeed: 'stations-1', stFocus: -1, hvSeed: 'heavies-1', hvFocus: -1, astSeed: 'rocks-1', astFocus: -1, hoverItem: -1, sunOff: [-0.17, 0.12], flares: true,
  flyBrand: 'prism.military', flySize: 'c1', traffic: 60, zoom: 1, flightModel: 'assist', pirates: false, env: 'mixed', solarFlares: true,
  throttle: 0.6, bloom: 0.9, lightsN: 4, shields: true, shieldIdle: 0.3, barrage: false, click: 'inspect',
  mouse: null, hoverKey: null, editBrand: catalog.brands[0].id
};

// ---------------- WebGL setup ----------------
/*SHADERS*/
/*GFX*/
/*BAKE*/
const canvas = $('view');
const G = makeGfx(canvas);
if (!G) { $('glerr').hidden = false; return; }
const { gl, compile, P, quad, draw, tex } = G;
let HDR = G.HDR, scene = null, chain = [];
function buildTargets() {
  ({ scene, chain } = G.buildTargets()); HDR = G.HDR;
  $('hdr-note').textContent = HDR ? 'HDR float target' : '8-bit target (float render targets unavailable)';
}

// ---------------- baking (workers) ----------------
const { ships, queue, keyOf, enqueue, pump } = makeBaker({
  gl, tex, genText: GEN_TEXT, catalog: () => catalog, defaultSeed: () => state.seed,
  onBaked: key => {
    updateProgress();
    if (state.view === 'detail' && key === keyOf(state.brand, state.size)) renderInfo();
    if (STN) STN.onBaked(key);
    if (HVY) HVY.onBaked(key);
  },
  onError: (key, msg) => { showError(key, msg); updateProgress(); }
});
function rebakeAll() {
  for (const b of catalog.brands) for (const z of catalog.sizes) enqueue(keyOf(b.id, z.id));
  if (state.view === 'detail') enqueue(keyOf(state.brand, state.size), true);
  updateProgress(); pump();
}
function rebakeBrand(id) {
  for (const z of catalog.sizes) enqueue(keyOf(id, z.id), state.view === 'detail' && state.brand === id && state.size === z.id);
  updateProgress(); pump();
}
function updateProgress() {
  const total = catalog.brands.length * catalog.sizes.length;
  let done = 0; ships.forEach((s, k) => { if (s.ready && !s.pending && !/^(st|hv)\|/.test(k)) done++; });
  const el = $('progress');
  let stPending = 0; ships.forEach((s, k) => { if (/^(st|hv)\|/.test(k) && s.pending) stPending++; });
  el.hidden = done >= total && stPending === 0;
  el.textContent = done < total ? `Baking ${done} of ${total}` : `Baking ${stPending} large asset${stPending === 1 ? '' : 's'}`;
}
function showError(key, msg) { $('json-err').textContent = `Bake failed for ${key.replace('|', ' / ')}: ${msg}`; }

// ---------------- layout ----------------
let W = 0, H = 0, dpr = 1, cells = [];
function resize() {
  const r = canvas.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = r.width; H = r.height;
  canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr));
  buildTargets(); layout();
}
function layout() {
  const ov = $('overlay'); ov.innerHTML = '';
  cells = [];
  if (state.view === 'fly') { /* HUD canvas handles flight overlays */ }
  else if (GENERIC[state.view]) {
    const G = GENERIC[state.view], M = G.mod(), n = M ? M.count() : 0, fk = state[G.focus];
    if (fk >= 0) {
      const cell = Math.min(W, H) * 0.96;
      cells.push({ item: fk, x: (W - cell) / 2, y: (H - cell) / 2, cell, cx: W / 2, cy: H / 2 });
      const info = M && M.label(fk);
      if (info) { const d = document.createElement('div'); d.className = 'detail-cap'; d.innerHTML = `<span>${escapeHtml(info.kind)}</span><b>${escapeHtml(info.name)}</b>`; ov.appendChild(d); }
    } else {
      const cols = W > 1100 ? 4 : W > 640 ? 3 : 2, rows = Math.ceil(n / cols);
      const cell = Math.max(60, Math.min((W - 16) / cols, (H - 16) / rows));
      const gx = (W - cell * cols) / 2, gy = Math.max(8, (H - cell * rows) / 2);
      for (let k = 0; k < n; k++) {
        const c = k % cols, r = Math.floor(k / cols);
        cells.push({ item: k, x: gx + c * cell, y: gy + r * cell, cell, cx: gx + (c + 0.5) * cell, cy: gy + (r + 0.46) * cell });
        const info = M.label(k);
        if (info) { const d = document.createElement('div'); d.className = 'pl-label'; d.style.left = (gx + c * cell) + 'px'; d.style.width = cell + 'px'; d.style.top = (gy + (r + 1) * cell - 24) + 'px'; d.innerHTML = `<b>${escapeHtml(info.name)}</b><small>${escapeHtml(info.kind)}</small>`; ov.appendChild(d); }
      }
      const hv = document.createElement('div'); hv.className = 'hover-box'; hv.id = 'hover-box'; hv.hidden = true; ov.appendChild(hv);
    }
  }
  else if (state.view === 'suns') {
    const n = SUNS ? SUNS.count() : 0;
    if (state.sunFocus >= 0) {
      const cell = Math.min(W, H);
      cells.push({ sun: state.sunFocus, x: 0, y: 0, cell, cx: W / 2, cy: H / 2 });
      const info = SUNS && SUNS.label(state.sunFocus);
      if (info) { const d = document.createElement('div'); d.className = 'detail-cap'; d.innerHTML = `<span>${escapeHtml(info.kind)}</span><b>${escapeHtml(info.name)}</b><small>Drag the star to sweep the lens flare</small>`; ov.appendChild(d); }
    } else {
      const cols = W > 1100 ? 4 : W > 640 ? 3 : 2, rows = Math.ceil(n / cols);
      const cell = Math.max(60, Math.min((W - 16) / cols, (H - 16) / rows));
      const gx = (W - cell * cols) / 2, gy = Math.max(8, (H - cell * rows) / 2);
      for (let k = 0; k < n; k++) {
        const c = k % cols, r = Math.floor(k / cols);
        cells.push({ sun: k, x: gx + c * cell, y: gy + r * cell, cell, cx: gx + (c + 0.5) * cell, cy: gy + (r + 0.46) * cell });
        const info = SUNS.label(k);
        if (info) { const d = document.createElement('div'); d.className = 'pl-label'; d.style.left = (gx + c * cell) + 'px'; d.style.width = cell + 'px'; d.style.top = (gy + (r + 1) * cell - 24) + 'px'; d.innerHTML = `<b>${escapeHtml(info.kind)}</b><small>${escapeHtml(info.name)}</small>`; ov.appendChild(d); }
      }
      const hv = document.createElement('div'); hv.className = 'hover-box'; hv.id = 'hover-box'; hv.hidden = true; ov.appendChild(hv);
    }
  }
  else if (state.view === 'planets') {
    const n = 12;
    if (state.planetFocus >= 0) {
      const cell = Math.min(W, H) * 0.96;
      cells.push({ planet: state.planetFocus, x: (W - cell) / 2, y: (H - cell) / 2, cell, cx: W / 2, cy: H / 2 });
      const info = PLAN && PLAN.label(state.planetFocus);
      if (info) { const d = document.createElement('div'); d.className = 'detail-cap'; d.innerHTML = `<span>${escapeHtml(info.kind)}</span><b>${escapeHtml(info.name)}</b><small>Drag to move the sun</small>`; ov.appendChild(d); }
    } else {
      const cols = W > 1100 ? 4 : W > 640 ? 3 : 2, rows = Math.ceil(n / cols);
      const cell = Math.max(60, Math.min((W - 16) / cols, (H - 16) / rows));
      const gx = (W - cell * cols) / 2, gy = Math.max(8, (H - cell * rows) / 2);
      for (let k = 0; k < n; k++) {
        const c = k % cols, r = Math.floor(k / cols);
        cells.push({ planet: k, x: gx + c * cell, y: gy + r * cell, cell, cx: gx + (c + 0.5) * cell, cy: gy + (r + 0.47) * cell });
        const info = PLAN && PLAN.label(k);
        if (info) { const d = document.createElement('div'); d.className = 'pl-label'; d.style.left = (gx + c * cell) + 'px'; d.style.width = cell + 'px'; d.style.top = (gy + (r + 1) * cell - 24) + 'px'; d.innerHTML = `<b>${escapeHtml(info.name)}</b><small>${escapeHtml(info.kind)}</small>`; ov.appendChild(d); }
      }
      const hv = document.createElement('div'); hv.className = 'hover-box'; hv.id = 'hover-box'; hv.hidden = true; ov.appendChild(hv);
    }
  }
  else if (state.view === 'grid') {
    const cols = catalog.sizes.length, rows = catalog.brands.length;
    const top = 30, side = 8;
    const cell = Math.max(40, Math.min((W - side * 2) / cols, (H - top - 8) / rows));
    const gx = (W - cell * cols) / 2, gy = top + Math.max(0, (H - top - cell * rows) / 2);
    catalog.sizes.forEach((z, c) => {
      const d = document.createElement('div'); d.className = 'col-h';
      d.style.left = (gx + c * cell) + 'px'; d.style.width = cell + 'px'; d.style.top = Math.max(4, gy - 26) + 'px';
      d.innerHTML = `<span>${z.name}</span><small>${z.length} m</small>`; ov.appendChild(d);
    });
    catalog.brands.forEach((b, rI) => {
      const d = document.createElement('div'); d.className = 'row-h';
      d.style.left = (gx + 6) + 'px'; d.style.top = (gy + rI * cell + 6) + 'px';
      d.innerHTML = `<i style="background:${b.style.palette.hull[0]};box-shadow:inset 0 0 0 2px ${b.style.palette.emissive}"></i>${escapeHtml(b.name)}`;
      ov.appendChild(d);
      catalog.sizes.forEach((z, c) => cells.push({ key: keyOf(b.id, z.id), b: b.id, z: z.id, x: gx + c * cell, y: gy + rI * cell, cell, cx: gx + (c + 0.5) * cell, cy: gy + (rI + 0.55) * cell }));
    });
    const hv = document.createElement('div'); hv.className = 'hover-box'; hv.id = 'hover-box'; hv.hidden = true; ov.appendChild(hv);
  } else {
    const b = catalog.brands.find(x => x.id === state.brand), z = catalog.sizes.find(x => x.id === state.size);
    const d = document.createElement('div'); d.className = 'detail-cap';
    d.innerHTML = `<span>${escapeHtml(b.name)}</span><b>${z.name}</b><small>${z.length} m · seed ${escapeHtml(state.seed)}</small>`;
    ov.appendChild(d);
    const cell = Math.min(W, H) * 0.8;
    cells.push({ key: keyOf(b.id, z.id), b: b.id, z: z.id, x: (W - cell) / 2, y: (H - cell) / 2, cell, cx: W / 2, cy: H / 2 + 8 });
  }
  updateHint();
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function updateHint() {
  if (GENERIC[state.view]) { const G = GENERIC[state.view]; $('hint').textContent = state[G.focus] >= 0 ? G.one : G.grid; return; }
  if (state.view === 'suns') { $('hint').textContent = state.sunFocus >= 0 ? 'Drag the star to move it · the lens flare follows' : 'Click a star to open it in the builder'; return; }
  if (state.view === 'planets') { $('hint').textContent = state.planetFocus >= 0 ? 'Drag to move the sun · edit this planet in the side panel' : 'Click a planet to edit it · drag to move the sun'; return; }
  if (state.view === 'fly') { $('hint').textContent = 'W S speed · A D turn · Shift burn · Space fire · Tab contact · C cold · P ping · F assist · wheel zoom'; return; }
  const fire = state.view === 'detail' || state.click === 'fire';
  $('hint').textContent = 'Drag to move the sun · hover for a work light · ' + (fire ? 'click a shield to hit it' : 'click a ship to inspect');
}

// ---------------- per-frame helpers ----------------
function sunVec() {
  const az = state.sunAz * Math.PI / 180, el = state.sunEl * Math.PI / 180;
  return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
}
const rot = (a, x, y) => [Math.cos(a) * x - Math.sin(a) * y, Math.sin(a) * x + Math.cos(a) * y];
function shipThrottle(i, t) { return Math.min(1, state.throttle * (0.93 + 0.07 * Math.sin(t * 0.7 + i * 1.9))); }

// shield hits live in ship-local quad space so they ride with the ship
const HIT_LIFE = 2.6;
function addHit(s, qx, qy, now, strength) {
  s.hits = (s.hits || []).filter(h => now - h.t0 < HIT_LIFE);
  if (s.hits.length >= 8) s.hits.shift();
  s.hits.push({ qx, qy, t0: now, str: strength || 1 });
}
function fieldAt(s, qx, qy) { // meters from hull, from the CPU copy of the bake
  const r = s.maps.res, ix = Math.max(0, Math.min(r - 1, Math.floor((qx * 0.5 + 0.5) * r))), iy = Math.max(0, Math.min(r - 1, Math.floor((0.5 - qy * 0.5) * r)));
  return s.aux[(iy * r + ix) * 4] / 255 * s.maps.Dmax;
}
function shellPointToward(s, qx, qy) { // walk from the clicked point toward ship center until inside the shell
  let x = qx, y = qy;
  for (let i = 0; i < 60; i++) { if (fieldAt(s, x, y) <= s.maps.shieldS) return [x, y]; x *= 0.96; y *= 0.96; }
  return [x, y];
}
function shellPointRandom(s) {
  const a = Math.random() * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
  let last = [0, 0];
  for (let r = 0; r < 1; r += 0.01) { if (fieldAt(s, dx * r, dy * r) >= s.maps.shieldS) return last; last = [dx * r, dy * r]; }
  return last;
}

// ---------------- render ----------------
const t0 = performance.now();
let lastBarrage = 0;
function frame(now) {
  if (state.view === 'fly') {
    if (FLY) { try { FLY.frame(now); } catch (e) { console.error(e); FLY_ERR = String(e.message || e); FLY = null; } }
    if (!FLY) $('hint').textContent = FLY_ERR ? 'Flight mode failed to start: ' + FLY_ERR : 'Starting the sim core…';
    requestAnimationFrame(frame); return;
  }
  if (GENERIC[state.view]) {
    const G = GENERIC[state.view], M = G.mod();
    if (M) { try { M.frame(now); } catch (e) { console.error(e); $('hint').textContent = state.view + ' failed: ' + (e.message || e); } }
    else $('hint').textContent = state.view + ' failed to start: ' + G.err();
    requestAnimationFrame(frame); return;
  }
  if (state.view === 'suns') {
    if (SUNS) { try { SUNS.frame(now); } catch (e) { console.error(e); SUNS_ERR = String(e.message || e); SUNS = null; } }
    if (!SUNS) $('hint').textContent = 'Suns failed to start: ' + SUNS_ERR;
    requestAnimationFrame(frame); return;
  }
  if (state.view === 'planets') {
    if (PLAN) { try { PLAN.frame(now); } catch (e) { console.error(e); PLAN_ERR = String(e.message || e); PLAN = null; } }
    if (!PLAN) $('hint').textContent = 'Planets failed to start: ' + PLAN_ERR;
    requestAnimationFrame(frame); return;
  }
  gl.bindVertexArray(null);
  const t = (now - t0) / 1000;
  const nowS = now / 1000;
  const star = STARS[state.star];
  const sunCol = lin(star.col), amb = star.amb;
  const sv = sunVec(); const sl = Math.hypot(sv[0], sv[1]) || 1;
  const RW = canvas.width, RH = canvas.height;

  let maxExt = 1; ships.forEach((s, k) => { if (s.ready && !/^(st|hv)\|/.test(k)) maxExt = Math.max(maxExt, s.maps.extent); });
  // resolve each visible ship's transform for this frame
  const vis = [];
  cells.forEach((c, i) => {
    const s = ships.get(c.key); if (!s || !s.ready) return;
    const brand = catalog.brands.find(b => b.id === c.b); if (!brand) return;
    let half = (state.view === 'grid' && state.trueScale) ? (s.maps.extent * (c.cell * 0.98 / maxExt)) / 2 : c.cell * 0.5;
    const hd = half * dpr;
    const ang = state.spin ? t * (state.view === 'grid' ? 0.2 : 0.1) + i * 0.9 : 0;
    const cx = c.cx * dpr, cy = (H - c.cy) * dpr;
    c.ang = ang; c.half = half;
    vis.push({ c, s, brand, br: brandRender(brand), hd, ang, cx, cy, i, th: shipThrottle(i, t) });
  });

  // barrage: random hits across visible ships
  if (state.barrage && state.shields && nowS - lastBarrage > (state.view === 'grid' ? 0.18 : 0.35) && vis.length) {
    lastBarrage = nowS;
    const v = vis[Math.floor(Math.random() * vis.length)];
    const p = shellPointRandom(v.s); addHit(v.s, p[0], p[1], nowS, 0.7 + Math.random() * 0.6);
  }

  // ---- light list (device px, y up) ----
  const lights = [];
  if (state.pl && state.mouse) lights.push({ x: state.mouse.x * dpr, y: (H - state.mouse.y) * dpr, z: 110 * dpr, r: 220 * dpr, c: [1.6, 1.25, 0.85] });
  const drift = [];
  for (let k = 0; k < state.lightsN; k++) {
    const ph = k * 2.399;
    const x = RW * (0.5 + 0.44 * Math.cos(t * (0.13 + k * 0.017) + ph)), y = RH * (0.5 + 0.42 * Math.sin(t * (0.11 + k * 0.023) + ph * 1.7));
    const col = DRIFT_COLS[k % DRIFT_COLS.length];
    const L = { x, y, z: 70 * dpr, r: 170 * dpr, c: col.map(v => v * 2.4), col };
    lights.push(L); drift.push(L);
  }
  for (const v of vis) {
    if (state.map !== 0) break;
    const eng = v.s.maps.engines; if (!eng.length) continue;
    let ux = 0, uy = 0; eng.forEach(e => { ux += e.u; uy += e.v; }); ux /= eng.length; uy /= eng.length;
    const q = rot(v.ang, (ux - 0.5) * 2 * v.hd, (0.5 - uy) * 2 * v.hd);
    const d = rot(v.ang, 0, -1);
    const pw = plumePower(v.th);
    lights.push({ x: v.cx + q[0] + d[0] * v.hd * 0.12, y: v.cy + q[1] + d[1] * v.hd * 0.12, z: 14 * dpr, r: v.hd * 0.55, c: v.br.plCol.map(c => c * 1.4 * pw), owner: v });
    if (state.shields) for (const h of v.s.hits || []) {
      const age = nowS - h.t0; if (age > 0.6) continue;
      const hq = rot(v.ang, h.qx * v.hd, h.qy * v.hd);
      lights.push({ x: v.cx + hq[0], y: v.cy + hq[1], z: 24 * dpr, r: v.hd * 0.45, c: v.br.shCol.map(c => c * 5 * Math.exp(-age * 5) * h.str) });
    }
  }

  // ---- scene pass ----
  gl.bindFramebuffer(gl.FRAMEBUFFER, scene.f);
  gl.viewport(0, 0, RW, RH);
  gl.disable(gl.BLEND);
  gl.useProgram(P.bg.p);
  gl.uniform2f(P.bg.u.uRes, RW, RH); gl.uniform1f(P.bg.u.uTime, t);
  gl.uniform3fv(P.bg.u.uStar, star.col); gl.uniform3fv(P.bg.u.uNeb, star.neb);
  gl.uniform2f(P.bg.u.uSunDir, sv[0] / sl, sv[1] / sl);
  gl.uniform2f(P.bg.u.uOff, 0, 0);
  draw();
  gl.enable(gl.BLEND);

  // plumes (additive, under the hulls)
  if (state.map === 0) {
    gl.blendFunc(gl.ONE, gl.ONE);
    const u = P.plume.u; gl.useProgram(P.plume.p);
    gl.uniform2f(u.uRes, RW, RH); gl.uniform1f(u.uTime, t);
    for (const v of vis) {
      const br = v.br, pw = plumePower(v.th), boost = v.th > 0.85 ? 1 + (v.th - 0.85) * 3 : 1;
      gl.uniform3fv(u.uCol, br.plCol);
      const core = br.plCore.map((c, k) => c + (1 - c) * (boost - 1) * 0.8);
      gl.uniform3fv(u.uCore, core);
      gl.uniform1f(u.uTurb, br.plTurb); gl.uniform1f(u.uDiamonds, br.plDia); gl.uniform1f(u.uSputter, br.plSput); gl.uniform1f(u.uPulse, br.plPulse); gl.uniform1f(u.uSpread, br.plSpread);
      gl.uniform1f(u.uPower, pw);
      v.s.maps.engines.forEach((e, k) => {
        const q = rot(v.ang, (e.u - 0.5) * 2 * v.hd, (0.5 - e.v) * 2 * v.hd);
        const d = rot(v.ang, e.dx, e.dy);
        const wid = Math.max(e.w * 2 * v.hd, 1.5 * dpr);
        gl.uniform2f(u.uNoz, v.cx + q[0], v.cy + q[1]); gl.uniform2f(u.uDir, d[0], d[1]);
        gl.uniform1f(u.uWid, wid * br.plWid * 1.1);
        gl.uniform1f(u.uLen, wid * br.plLen * (0.3 + 1.7 * v.th) * boost);
        gl.uniform1f(u.uSeed, v.i * 7.3 + k * 1.37);
        draw();
      });
    }
  }

  // hulls (premultiplied over)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  {
    const u = P.ship.u; gl.useProgram(P.ship.p);
    gl.uniform2f(u.uRes, RW, RH);
    gl.uniform3fv(u.uSun, sv); gl.uniform3fv(u.uSunCol, sunCol); gl.uniform3fv(u.uAmb, amb);
    gl.uniform1f(u.uTime, t); gl.uniform1i(u.uMode, state.map);
    gl.uniform1f(u.uShadow, state.shadow ? 1 : 0);
    gl.uniform1i(u.uA, 0); gl.uniform1i(u.uN, 1); gl.uniform1i(u.uE, 2); gl.uniform1i(u.uX, 3);
    const LP = new Float32Array(64), LC = new Float32Array(64);
    for (const v of vis) {
      const m = v.brand.style.material;
      // pick the 16 most relevant lights for this ship
      const reach = v.hd * 1.5;
      const cand = lights.map(L => { const d = Math.hypot(L.x - v.cx, L.y - v.cy); return { L, d, w: (L.c[0] + L.c[1] + L.c[2]) * L.r / (d + L.r) }; })
        .filter(o => o.d < reach + o.L.r * 4).sort((a, b) => b.w - a.w).slice(0, 16);
      cand.forEach((o, k) => { LP.set([o.L.x, o.L.y, o.L.z, o.L.r], k * 4); LC.set([o.L.c[0], o.L.c[1], o.L.c[2], 0], k * 4); });
      gl.uniform4fv(u.uLP, LP); gl.uniform4fv(u.uLC, LC); gl.uniform1i(u.uLN, cand.length);
      gl.uniform2f(u.uCenter, v.cx, v.cy); gl.uniform1f(u.uHalf, v.hd); gl.uniform1f(u.uAngle, v.ang);
      gl.uniform1f(u.uExtent, v.s.maps.extent); gl.uniform1f(u.uHRange, v.s.maps.hRange);
      gl.uniform1f(u.uPxPerM, 2 * v.hd / v.s.maps.extent);
      gl.uniform1f(u.uDmax, v.s.maps.Dmax); gl.uniform1f(u.uS, v.s.maps.shieldS);
      gl.uniform1f(u.uGloss, m.gloss); gl.uniform1f(u.uSpecK, 0.6 + m.spec * 1.4);
      gl.uniform1f(u.uWrap, m.wrap); gl.uniform1f(u.uIrid, m.irid); gl.uniform1f(u.uRim, m.rim);
      gl.uniform1f(u.uThrottle, v.th);
      gl.uniform1f(u.uHover, state.hoverKey === v.c.key && state.view === 'grid' ? 1 : 0);
      for (let k = 0; k < 4; k++) { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, v.s.tex[k]); }
      draw();
    }
  }

  // shields + light markers (additive)
  gl.blendFunc(gl.ONE, gl.ONE);
  if (state.map === 0 && state.shields) {
    const u = P.shield.u; gl.useProgram(P.shield.p);
    gl.uniform2f(u.uRes, RW, RH); gl.uniform1f(u.uTime, t); gl.uniform1i(u.uX, 0);
    const HU = new Float32Array(32);
    for (const v of vis) {
      v.s.hits = (v.s.hits || []).filter(h => nowS - h.t0 < HIT_LIFE);
      for (let k = 0; k < 8; k++) {
        const h = v.s.hits[k];
        if (h) HU.set([h.qx, h.qy, nowS - h.t0, h.str], k * 4); else HU.set([0, 0, -1, 0], k * 4);
      }
      gl.uniform4fv(u.uHits, HU);
      gl.uniform2f(u.uCenter, v.cx, v.cy); gl.uniform1f(u.uHalf, v.hd); gl.uniform1f(u.uAngle, v.ang);
      gl.uniform1f(u.uExtent, v.s.maps.extent); gl.uniform1f(u.uS, v.s.maps.shieldS); gl.uniform1f(u.uDmax, v.s.maps.Dmax);
      gl.uniform1f(u.uIdle, state.shieldIdle); gl.uniform1f(u.uStrength, v.br.shStr); gl.uniform1f(u.uSeed, v.i * 3.7);
      gl.uniform3fv(u.uCol, v.br.shCol); gl.uniform1i(u.uPat, v.br.shPat);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, v.s.tex[3]);
      draw();
    }
  }
  if (drift.length) {
    const u = P.mark.u; gl.useProgram(P.mark.p);
    gl.uniform2f(u.uRes, RW, RH); gl.uniform1f(u.uSz, 26 * dpr);
    for (const L of drift) { gl.uniform2f(u.uC, L.x, L.y); gl.uniform3fv(u.uCol, L.col.map(c => c * 1.2)); draw(); }
  }
  gl.disable(gl.BLEND);

  postProcess();
  requestAnimationFrame(frame);
}
function postProcess() { G.postProcess(state.bloom); }

/*CORE*/
/*FLY*/
/*PLANETS*/
/*SUNS*/
/*STATIONS*/
/*ASTEROIDS*/

// Grid-and-builder tabs that share layout, hover and click handling
const GENERIC = {
  stations: { mod: () => STN, err: () => STN_ERR, focus: 'stFocus', grid: 'Click a station to open it in the builder · drag to move the sun', one: 'Drag to move the sun · hover for a work light' },
  heavies: { mod: () => HVY, err: () => HVY_ERR, focus: 'hvFocus', grid: 'Click a ship to open it in the builder · throttle lives under Drives and effects', one: 'Drag to move the sun · hover for a work light' },
  asteroids: { mod: () => AST, err: () => AST_ERR, focus: 'astFocus', grid: 'Sizes are to scale within the set · click one to open it in the builder', one: 'Drag to move the sun' }
};

// ---------------- interaction ----------------
let drag = null;
function cellAt(x, y) { return cells.find(c => x >= c.x && x < c.x + c.cell && y >= c.y && y < c.y + c.cell); }
function setSunFromPointer(x, y) {
  const dx = x - W / 2, dy = (H / 2) - y;
  state.sunAz = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
  const rr = Math.min(1, Math.hypot(dx, dy) / (Math.min(W, H) * 0.5));
  state.sunEl = Math.round(80 - rr * 72);
  syncSunControls();
}
function fireAt(c, x, y) {
  const s = ships.get(c.key); if (!s || !s.ready || c.half == null) return;
  const dx = x - c.cx, dy = c.cy - y;
  const q = rot(-c.ang, dx / c.half, dy / c.half);
  if (Math.abs(q[0]) > 1 || Math.abs(q[1]) > 1) return;
  const p = shellPointToward(s, q[0], q[1]);
  addHit(s, p[0], p[1], performance.now() / 1000, 1.2);
}
canvas.addEventListener('pointermove', e => {
  if (state.view === 'fly') return;
  const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
  state.mouse = { x, y };
  if (drag) {
    if (Math.hypot(x - drag.x, y - drag.y) > 5) drag.moved = true;
    if (drag.moved) { if (state.view === 'suns' && state.sunFocus >= 0) state.sunOff = [(x - W / 2) / W, (H / 2 - y) / H]; else setSunFromPointer(x, y); }
  }
  if (GENERIC[state.view]) {
    const fk = state[GENERIC[state.view].focus], c = fk < 0 ? cellAt(x, y) : null, hb = $('hover-box');
    state.hoverItem = c ? c.item : -1;
    if (hb) { if (c) { hb.hidden = false; hb.style.left = c.x + 'px'; hb.style.top = c.y + 'px'; hb.style.width = hb.style.height = c.cell + 'px'; } else hb.hidden = true; }
    canvas.style.cursor = drag && drag.moved ? 'grabbing' : c ? 'pointer' : 'crosshair';
  } else if (state.view === 'suns') {
    const c = state.sunFocus < 0 ? cellAt(x, y) : null, hb = $('hover-box');
    if (hb) { if (c) { hb.hidden = false; hb.style.left = c.x + 'px'; hb.style.top = c.y + 'px'; hb.style.width = hb.style.height = c.cell + 'px'; } else hb.hidden = true; }
    canvas.style.cursor = drag && drag.moved ? 'grabbing' : c ? 'pointer' : (state.sunFocus >= 0 ? 'grab' : 'crosshair');
  } else if (state.view === 'planets') {
    const c = state.planetFocus < 0 ? cellAt(x, y) : null, hb = $('hover-box');
    if (hb) { if (c) { hb.hidden = false; hb.style.left = c.x + 'px'; hb.style.top = c.y + 'px'; hb.style.width = hb.style.height = c.cell + 'px'; } else hb.hidden = true; }
    canvas.style.cursor = drag && drag.moved ? 'grabbing' : c ? 'pointer' : 'crosshair';
  } else if (state.view === 'grid') {
    const c = cellAt(x, y); state.hoverKey = c ? c.key : null;
    const hb = $('hover-box');
    if (hb) { if (c && state.click === 'inspect') { hb.hidden = false; hb.style.left = c.x + 'px'; hb.style.top = c.y + 'px'; hb.style.width = hb.style.height = c.cell + 'px'; } else hb.hidden = true; }
    canvas.style.cursor = drag && drag.moved ? 'grabbing' : c ? (state.click === 'fire' ? 'crosshair' : 'pointer') : 'default';
  } else canvas.style.cursor = drag && drag.moved ? 'grabbing' : 'crosshair';
});
canvas.addEventListener('pointerleave', () => { state.mouse = null; state.hoverKey = null; const hb = $('hover-box'); if (hb) hb.hidden = true; });
canvas.addEventListener('pointerdown', e => {
  if (state.view === 'fly') { canvas.focus(); return; }
  const r = canvas.getBoundingClientRect(); drag = { x: e.clientX - r.left, y: e.clientY - r.top, moved: false };
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
});
canvas.addEventListener('pointerup', e => {
  if (state.view === 'fly') return;
  const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
  if (drag && !drag.moved && GENERIC[state.view]) { const G = GENERIC[state.view], M = G.mod(), c = cellAt(x, y); if (c && state[G.focus] < 0 && M) M.focus(c.item); drag = null; return; }
  if (drag && !drag.moved && state.view === 'suns') { const c = cellAt(x, y); if (c && state.sunFocus < 0 && SUNS) SUNS.focus(c.sun); drag = null; return; }
  if (drag && !drag.moved && state.view === 'planets') { const c = cellAt(x, y); if (c && state.planetFocus < 0 && PLAN) PLAN.focus(c.planet); drag = null; return; }
  if (drag && !drag.moved) {
    const c = cellAt(x, y);
    if (c) { if (state.view === 'grid' && state.click === 'inspect') openDetail(c.b, c.z); else fireAt(c, x, y); }
  }
  drag = null;
});

function openDetail(b, z) {
  state.brand = b; state.size = z; state.editBrand = b; setView('detail');
  const key = keyOf(b, z); const s = ships.get(key);
  if (!s || !s.ready) { const i = queue.indexOf(key); if (i > 0) { queue.splice(i, 1); queue.unshift(key); } }
  renderBrandCards(); loadEditor();
}
function setView(v) {
  if (state.view === 'fly' && v !== 'fly' && FLY) FLY.clearKeys();
  state.view = v;
  $('fly-panel').hidden = v !== 'fly';
  $('planet-panel').hidden = v !== 'planets';
  $('sun-panel').hidden = v !== 'suns';
  $('station-panel').hidden = v !== 'stations';
  $('heavy-panel').hidden = v !== 'heavies';
  $('asteroid-panel').hidden = v !== 'asteroids';
  if (GENERIC[v] && GENERIC[v].mod()) GENERIC[v].mod().sync();
  if (v === 'suns' && SUNS) SUNS.sync();
  document.querySelectorAll('[data-hide]').forEach(el => { el.hidden = el.dataset.hide.split(' ').includes(v); });
  if (v === 'planets' && PLAN) PLAN.sync();
  $('touch').hidden = v !== 'fly';
  $('hud').hidden = v !== 'fly';
  if (v === 'fly') { state.mouse = null; canvas.focus(); }
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  $('detail-panel').hidden = v !== 'detail';
  $('opt-truescale').disabled = v !== 'grid';
  layout(); renderInfo();
}

// ---------------- panel ----------------
function seg(containerId, items, get, set) {
  const el = $(containerId); el.innerHTML = '';
  items.forEach(([val, label]) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.setAttribute('aria-pressed', String(get() === val));
    b.addEventListener('click', () => { set(val); el.querySelectorAll('button').forEach((x, i) => x.setAttribute('aria-pressed', String(items[i][0] === get()))); });
    el.appendChild(b);
  });
}
seg('seg-map', [[0, 'Lit'], [1, 'Albedo'], [2, 'Normal'], [3, 'Height'], [4, 'Emissive'], [5, 'Field']], () => state.map, v => { state.map = v; });
seg('seg-star', Object.keys(STARS).map(k => [k, STARS[k].name]), () => state.star, v => { state.star = v; });
seg('seg-click', [['inspect', 'Inspect'], ['fire', 'Fire']], () => state.click, v => { state.click = v; updateHint(); });
function bindToggle(id, key) { const el = $(id); el.checked = state[key]; el.addEventListener('change', () => { state[key] = el.checked; }); }
bindToggle('opt-spin', 'spin'); bindToggle('opt-truescale', 'trueScale'); bindToggle('opt-shadow', 'shadow'); bindToggle('opt-pl', 'pl');
bindToggle('opt-shields', 'shields'); bindToggle('opt-barrage', 'barrage');
function bindRange(id, key, fmt, scale) {
  const el = $(id), out = $(id + '-v'); scale = scale || 1;
  const sync = () => { out.textContent = fmt(state[key]); };
  el.value = state[key] * scale; sync();
  el.addEventListener('input', () => { state[key] = +el.value / scale; sync(); });
}
bindRange('throttle', 'throttle', v => v > 0.85 ? 'Burn' : Math.round(v * 100) + '%', 100);
bindRange('bloom', 'bloom', v => v.toFixed(2), 100);
bindRange('lights', 'lightsN', v => String(v), 1);
bindRange('shield-idle', 'shieldIdle', v => Math.round(v * 100) + '%', 100);
function syncSunControls() { $('sun-az').value = Math.round(state.sunAz); $('sun-el').value = state.sunEl; $('sun-az-v').textContent = Math.round(state.sunAz) + '°'; $('sun-el-v').textContent = state.sunEl + '°'; }
$('sun-az').addEventListener('input', e => { state.sunAz = +e.target.value; syncSunControls(); });
$('sun-el').addEventListener('input', e => { state.sunEl = +e.target.value; syncSunControls(); });
syncSunControls();

document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('seed').value = state.seed;
$('seed').addEventListener('change', e => { state.seed = e.target.value.trim() || 'kestrel-7'; rebakeAll(); layout(); });
const WORDS = ['kestrel', 'ember', 'lattice', 'drift', 'cinder', 'halo', 'marrow', 'vesper', 'quarry', 'tern', 'basalt', 'lumen', 'sable', 'orrery'];
$('reseed').addEventListener('click', () => {
  state.seed = WORDS[Math.floor(Math.random() * WORDS.length)] + '-' + Math.floor(Math.random() * 900 + 100);
  $('seed').value = state.seed; rebakeAll(); layout();
});
$('prev-size').addEventListener('click', () => stepDetail(0, -1));
$('next-size').addEventListener('click', () => stepDetail(0, 1));
$('prev-brand').addEventListener('click', () => stepDetail(-1, 0));
$('next-brand').addEventListener('click', () => stepDetail(1, 0));
function stepDetail(db, dz) {
  const bi = catalog.brands.findIndex(b => b.id === state.brand), zi = catalog.sizes.findIndex(z => z.id === state.size);
  const nb = catalog.brands[(bi + db + catalog.brands.length) % catalog.brands.length].id;
  const nz = catalog.sizes[(zi + dz + catalog.sizes.length) % catalog.sizes.length].id;
  openDetail(nb, nz);
}

function renderBrandCards() {
  const el = $('brands'); el.innerHTML = '';
  catalog.brands.forEach(b => {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'brand';
    card.setAttribute('aria-pressed', String(state.editBrand === b.id));
    const sw = [...b.style.palette.hull, b.style.palette.trim, b.style.palette.emissive].map(c => `<i style="background:${c}"></i>`).join('');
    const pl = b.style.plume || {}, sh = b.style.shield || {};
    card.innerHTML = `<span class="b-top"><b>${escapeHtml(b.name)}</b><small>${escapeHtml(b.kind)}</small></span><span class="b-blurb">${escapeHtml(b.blurb)}</span><span class="b-meta"><span class="sw">${sw}</span><small>${b.parts.length} parts · ${b.style.union} union · ${escapeHtml(sh.pattern || 'hex')} shield</small></span>`;
    card.addEventListener('click', () => { state.editBrand = b.id; renderBrandCards(); loadEditor(); });
    el.appendChild(card);
  });
}
function loadEditor() {
  const b = catalog.brands.find(x => x.id === state.editBrand);
  $('json-title').textContent = b.name;
  $('json').value = JSON.stringify(b, null, 2);
  $('json-err').textContent = '';
}
$('json-apply').addEventListener('click', () => {
  let nb;
  try { nb = JSON.parse($('json').value); } catch (e) { $('json-err').textContent = 'Invalid JSON: ' + e.message; return; }
  const problems = [];
  if (nb.id !== state.editBrand) problems.push(`keep "id" as "${state.editBrand}"`);
  if (!nb.style || !nb.style.palette || !Array.isArray(nb.style.palette.hull)) problems.push('style.palette.hull must be an array of colors');
  if (!Array.isArray(nb.parts)) problems.push('parts must be an array');
  if (!nb.loadout || !nb.core) problems.push('core and loadout are required');
  if (nb.core) for (const z of catalog.sizes) { const ids = nb.core[z.id] || []; if (!ids.some(id => (nb.parts || []).some(p => p.id === id && p.role === 'core'))) problems.push(`core.${z.id} names no core part`); }
  if (problems.length) { $('json-err').textContent = 'Fix: ' + problems.join('; '); return; }
  const i = catalog.brands.findIndex(x => x.id === nb.id); catalog.brands[i] = nb;
  $('json-err').textContent = 'Applied. Rebaking ' + nb.name + '.';
  renderBrandCards(); layout(); rebakeBrand(nb.id);
});
$('json-revert').addEventListener('click', () => {
  const orig = CATALOG0.brands.find(x => x.id === state.editBrand);
  const i = catalog.brands.findIndex(x => x.id === state.editBrand);
  catalog.brands[i] = JSON.parse(JSON.stringify(orig));
  loadEditor(); $('json-err').textContent = 'Reverted to the shipped catalog.'; renderBrandCards(); layout(); rebakeBrand(orig.id);
});

function renderInfo() {
  if (state.view !== 'detail') return;
  const s = ships.get(keyOf(state.brand, state.size));
  const b = catalog.brands.find(x => x.id === state.brand), z = catalog.sizes.find(x => x.id === state.size);
  $('d-title').textContent = `${b.name} ${z.name}`;
  if (!s || !s.ready || s.pending) { $('d-stats').innerHTML = '<dt>Status</dt><dd>Baking…</dd>'; $('d-spec').textContent = ''; $('d-roles').innerHTML = ''; return; }
  const roles = {}; s.spec.parts.forEach(p => { roles[p.role] = (roles[p.role] || 0) + 1; });
  const rows = [['Length', z.length + ' m'], ['Core', s.spec.core], ['Parts', s.maps.partCount], ['Engines', s.maps.engines.length], ['Bake', `${s.maps.res}² px`], ['Resolution', (s.maps.res / s.maps.extent).toFixed(2) + ' px/m'], ['Relief', s.maps.hRange.toFixed(1) + ' m'], ['Shield standoff', s.maps.shieldS.toFixed(1) + ' m']];
  $('d-stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  $('d-roles').innerHTML = Object.entries(roles).map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
  $('d-spec').textContent = JSON.stringify(s.spec, null, 1);
}

// ---------------- flight controls ----------------
function fillSelect(id, items, val) { const el = $(id); el.innerHTML = items.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join(''); el.value = val; }
fillSelect('fly-brand', catalog.brands.map(b => [b.id, b.name]), state.flyBrand);
fillSelect('fly-size', catalog.sizes.map(z => [z.id, z.name]), state.flySize);
$('fly-brand').addEventListener('change', e => { state.flyBrand = e.target.value; if (FLY) FLY.swapPlayer(); canvas.focus(); });
$('fly-size').addEventListener('change', e => { state.flySize = e.target.value; if (FLY) FLY.swapPlayer(); canvas.focus(); });
function syncFlightModel() { $('seg-fm').querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(['assist', 'newton'][i] === state.flightModel))); }
seg('seg-fm', [['assist', 'Assist on'], ['newton', 'Assist off']], () => state.flightModel, v => { state.flightModel = v; canvas.focus(); });
fillSelect('fly-env', [['mixed', 'Mixed nebula'], ['hydrogen', 'Hydrogen cloud'], ['dust', 'Dust cloud'], ['ion', 'Ion storm'], ['clear', 'Clear space']], state.env);
$('fly-env').addEventListener('change', e => { state.env = e.target.value; if (FLY) FLY.env(); canvas.focus(); });
$('opt-sflares').checked = state.solarFlares;
$('opt-sflares').addEventListener('change', e => { state.solarFlares = e.target.checked; });
$('fly-flare').addEventListener('click', () => { if (FLY) FLY.flare(); canvas.focus(); });
bindRange('traffic', 'traffic', v => String(v), 1);
$('traffic').addEventListener('change', () => { if (FLY) FLY.reset(); });
bindRange('zoom', 'zoom', v => Math.round(v * 100) + '%', 100);
function setZoom(z) { state.zoom = Math.max(0.25, Math.min(4, z)); $('zoom').value = state.zoom * 100; $('zoom-v').textContent = Math.round(state.zoom * 100) + '%'; }
$('opt-pirates').checked = state.pirates;
$('opt-pirates').addEventListener('change', e => { state.pirates = e.target.checked; if (FLY) FLY.calm(); });
$('fly-reset').addEventListener('click', () => { if (FLY) FLY.reset(); canvas.focus(); });
$('fly-calm').addEventListener('click', () => { if (FLY) FLY.calm(); canvas.focus(); });
canvas.addEventListener('wheel', e => { if (state.view !== 'fly') return; e.preventDefault(); setZoom(state.zoom * Math.exp(-e.deltaY * 0.0012)); }, { passive: false });
const typing = el => el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'range' && el.type !== 'checkbox';
window.addEventListener('keydown', e => { if (state.view !== 'fly' || !FLY || typing(e.target)) return; FLY.key(e.code, true, e); });
window.addEventListener('keyup', e => { if (state.view !== 'fly' || !FLY) return; FLY.key(e.code, false, e); });
window.addEventListener('blur', () => { if (FLY) FLY.clearKeys(); });
document.querySelectorAll('#touch [data-code]').forEach(b => {
  const code = b.dataset.code;
  const on = e => { e.preventDefault(); if (FLY) FLY.key(code, true); b.setAttribute('aria-pressed', 'true'); };
  const off = () => { if (FLY) FLY.key(code, false); b.setAttribute('aria-pressed', 'false'); };
  b.addEventListener('pointerdown', on); ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, off));
});

// ---------------- boot ----------------
new ResizeObserver(resize).observe(canvas);
resize();
renderBrandCards(); loadEditor();
setView('grid');
rebakeAll();
requestAnimationFrame(frame);
})();
