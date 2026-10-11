// ======================= STATIONS & HEAVIES =======================
// Both are assembled by gen.js (assembleStation) from an archetype layout plus an owning brand's style,
// baked by the same workers as ships, and lit with the yard ship shader. Heavies also get engine plumes.
function makeBakedTab(cfg) {
  function rngOf(s) { let a = 0; for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 2654435761) >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const list = () => catalog[cfg.list];
  const id = k => $(cfg.idp + '-' + k);
  let items = [];
  const itemKey = it => cfg.prefix + it.arch + '|' + it.brand + '|' + it.seed;
  function newSet() {
    const r = rngOf(state[cfg.seedKey]), A = list(), B = catalog.brands;
    const next = [];
    for (let k = 0; k < 12; k++) next.push({ arch: A[k % A.length].id, brand: B[Math.floor(r() * B.length)].id, seed: 's' + Math.floor(r() * 1e6), name: cfg.names[Math.floor(r() * cfg.names.length)] });
    items = next; purge();
  }
  function purge() {
    const live = new Set(items.map(itemKey));
    for (const [k, s] of ships) if (k.startsWith(cfg.prefix) && !live.has(k)) { if (s.tex) s.tex.forEach(t => gl.deleteTexture(t)); ships.delete(k); const i = queue.indexOf(k); if (i >= 0) queue.splice(i, 1); }
  }
  function ensure(it, front) {
    const k = itemKey(it);
    if (!ships.has(k)) { enqueue(k, front, { station: it.arch, brand: it.brand, seed: it.seed }); updateProgress(); pump(); }
    return ships.get(k);
  }
  newSet();

  function frame(now) {
    const t = (now - t0) / 1000, RW = canvas.width, RH = canvas.height;
    const star = STARS[state.star], sv = sunVec(), sl = Math.hypot(sv[0], sv[1]) || 1;
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.f); gl.viewport(0, 0, RW, RH);
    gl.disable(gl.BLEND);
    gl.useProgram(P.bg.p);
    gl.uniform2f(P.bg.u.uRes, RW, RH); gl.uniform1f(P.bg.u.uTime, t);
    gl.uniform3fv(P.bg.u.uStar, star.col); gl.uniform3fv(P.bg.u.uNeb, star.neb);
    gl.uniform2f(P.bg.u.uSunDir, sv[0] / sl, sv[1] / sl); gl.uniform2f(P.bg.u.uOff, 0, 0);
    draw();
    gl.enable(gl.BLEND);
    const focus = state[cfg.focusKey] >= 0;
    // resolve visible, baked items for this frame
    const vis = [];
    for (const c of cells) {
      const it = items[c.item]; if (!it) continue;
      const s = ensure(it, focus); if (!s || !s.ready) continue;
      const arch = list().find(a => a.id === it.arch), brand = catalog.brands.find(b => b.id === it.brand);
      if (!arch || !brand) continue;
      const hd = c.cell * 0.5 * dpr;
      const ang = state.spin ? (cfg.plumes ? Math.sin(t * 0.15 + c.item) * 0.35 : t * (arch.spin || 0.01) * (focus ? 1 : 2) + c.item) : 0;
      vis.push({ c, s, arch, brand, hd, ang, cx: c.cx * dpr, cy: (H - c.cy) * dpr });
    }
    // engine plumes go under the hulls
    if (cfg.plumes && state.map === 0) {
      gl.blendFunc(gl.ONE, gl.ONE);
      const u = P.plume.u; gl.useProgram(P.plume.p);
      gl.uniform2f(u.uRes, RW, RH); gl.uniform1f(u.uTime, t);
      const th = state.throttle;
      for (const v of vis) {
        const br = brandRender(v.brand), pw = plumePower(th), boost = th > 0.85 ? 1 + (th - 0.85) * 3 : 1;
        gl.uniform3fv(u.uCol, br.plCol); gl.uniform3fv(u.uCore, br.plCore.map(c => c + (1 - c) * (boost - 1) * 0.8));
        gl.uniform1f(u.uTurb, br.plTurb); gl.uniform1f(u.uDiamonds, br.plDia); gl.uniform1f(u.uSputter, br.plSput); gl.uniform1f(u.uPulse, br.plPulse); gl.uniform1f(u.uSpread, br.plSpread);
        gl.uniform1f(u.uPower, pw);
        v.s.maps.engines.forEach((e, k) => {
          const q = rot(v.ang, (e.u - 0.5) * 2 * v.hd, (0.5 - e.v) * 2 * v.hd), d = rot(v.ang, e.dx, e.dy);
          const wid = Math.max(e.w * 2 * v.hd, 1.5 * dpr);
          gl.uniform2f(u.uNoz, v.cx + q[0], v.cy + q[1]); gl.uniform2f(u.uDir, d[0], d[1]);
          gl.uniform1f(u.uWid, wid * br.plWid * 1.1); gl.uniform1f(u.uLen, wid * br.plLen * (0.3 + 1.7 * th) * boost);
          gl.uniform1f(u.uSeed, v.c.item * 7.3 + k * 1.37);
          draw();
        });
      }
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const u = P.ship.u; gl.useProgram(P.ship.p);
    gl.uniform2f(u.uRes, RW, RH);
    gl.uniform3fv(u.uSun, sv); gl.uniform3fv(u.uSunCol, lin(star.col)); gl.uniform3fv(u.uAmb, star.amb);
    gl.uniform1f(u.uTime, t); gl.uniform1i(u.uMode, state.map === 5 ? 0 : state.map); gl.uniform1f(u.uShadow, state.shadow ? 1 : 0);
    gl.uniform1i(u.uA, 0); gl.uniform1i(u.uN, 1); gl.uniform1i(u.uE, 2); gl.uniform1i(u.uX, 3);
    const LP = new Float32Array(64), LC = new Float32Array(64); let nl = 0;
    if (state.pl && state.mouse) { LP.set([state.mouse.x * dpr, (H - state.mouse.y) * dpr, 120 * dpr, 240 * dpr], 0); LC.set([1.6, 1.25, 0.85, 0], 0); nl = 1; }
    gl.uniform4fv(u.uLP, LP); gl.uniform4fv(u.uLC, LC); gl.uniform1i(u.uLN, nl);
    gl.uniform1f(u.uThrottle, cfg.plumes ? state.throttle : 0);
    for (const v of vis) {
      const m = v.brand.style.material;
      gl.uniform2f(u.uCenter, v.cx, v.cy); gl.uniform1f(u.uHalf, v.hd); gl.uniform1f(u.uAngle, v.ang);
      gl.uniform1f(u.uExtent, v.s.maps.extent); gl.uniform1f(u.uHRange, v.s.maps.hRange); gl.uniform1f(u.uPxPerM, 2 * v.hd / v.s.maps.extent);
      gl.uniform1f(u.uDmax, v.s.maps.Dmax); gl.uniform1f(u.uS, v.s.maps.shieldS);
      gl.uniform1f(u.uGloss, m.gloss); gl.uniform1f(u.uSpecK, 0.6 + m.spec * 1.4); gl.uniform1f(u.uWrap, m.wrap); gl.uniform1f(u.uIrid, m.irid); gl.uniform1f(u.uRim, m.rim);
      gl.uniform1f(u.uHover, !focus && state.hoverItem === v.c.item ? 1 : 0);
      for (let k = 0; k < 4; k++) { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, v.s.tex[k]); }
      draw();
    }
    gl.disable(gl.BLEND);
    postProcess();
  }

  // ---------- builder ----------
  id('arch').innerHTML = list().map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  id('brand').innerHTML = catalog.brands.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  const cur = () => items[state[cfg.focusKey]];
  function syncPanel() {
    const it = cur();
    id('editor').hidden = !it; id('gridnote').hidden = !!it;
    if (!it) return;
    const arch = list().find(a => a.id === it.arch), brand = catalog.brands.find(b => b.id === it.brand);
    id('name').textContent = (it.name + ' ' + cfg.suffix(arch)).trim();
    id('kind').textContent = arch.blurb;
    id('arch').value = it.arch; id('brand').value = it.brand;
    const s = ships.get(itemKey(it));
    if (!s || !s.ready || s.pending) { id('stats').innerHTML = '<dt>Status</dt><dd>Baking…</dd>'; id('json').textContent = ''; return; }
    const prims = {}; s.spec.parts.forEach(p => { prims[p.prim] = (prims[p.prim] || 0) + 1; });
    const rows = [['Built by', brand.name], [cfg.sizeLabel, Math.round(s.spec.length_m) + ' m'], ['Parts', s.maps.partCount], ['Engines', s.maps.engines.length], ['Bake', `${s.maps.res}² px`], ['Resolution', (s.maps.res / s.maps.extent).toFixed(2) + ' px/m']];
    id('stats').innerHTML = rows.filter(r => cfg.plumes || r[0] !== 'Engines').map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
    id('json').textContent = JSON.stringify({ archetype: arch, owner: it.brand, seed: it.seed, parts: s.spec.parts.length, primitives: prims }, null, 1);
  }
  const rebuild = () => { purge(); ensure(cur(), true); syncPanel(); layout(); };
  id('arch').addEventListener('change', e => { const it = cur(); if (!it) return; it.arch = e.target.value; rebuild(); });
  id('brand').addEventListener('change', e => { const it = cur(); if (!it) return; it.brand = e.target.value; rebuild(); });
  id('random').addEventListener('click', () => { const it = cur(); if (!it) return; it.seed = 's' + Math.floor(Math.random() * 1e6); rebuild(); });
  id('newset').addEventListener('click', () => { state[cfg.seedKey] = cfg.list + '-' + Math.floor(Math.random() * 1e6); newSet(); layout(); });
  id('back').addEventListener('click', () => { state[cfg.focusKey] = -1; syncPanel(); layout(); });

  return {
    frame, count: () => items.length, sync: syncPanel,
    focus: k => { state[cfg.focusKey] = k; syncPanel(); layout(); },
    onBaked: key => { if (state[cfg.focusKey] >= 0 && cur() && key === itemKey(cur())) syncPanel(); },
    label: k => { const it = items[k]; if (!it) return null; const a = list().find(x => x.id === it.arch), b = catalog.brands.find(x => x.id === it.brand); return a && b ? { name: a.name, kind: b.name } : null; }
  };
}

let STN = null, STN_ERR = '', HVY = null, HVY_ERR = '';
try {
  STN = makeBakedTab({ list: 'stations', prefix: 'st|', idp: 'st', focusKey: 'stFocus', seedKey: 'stSeed', plumes: false, sizeLabel: 'Diameter',
    names: ['Anchorage', 'Meridian', 'Halfway', 'Cinder', 'Tollgate', 'Weir', 'Lantern', 'Keel', 'Hearth', 'Harbor', 'Crossing', 'Bastion', 'Spindle', 'Waypoint', 'Slipway'],
    suffix: a => a.name.split(' ').pop() });
} catch (e) { STN_ERR = String(e.message || e); console.error(e); }
try {
  HVY = makeBakedTab({ list: 'heavies', prefix: 'hv|', idp: 'hv', focusKey: 'hvFocus', seedKey: 'hvSeed', plumes: true, sizeLabel: 'Length',
    names: ['Long Patience', 'Ardent', 'Seedbearer', 'Iron Mule', 'Far Promise', 'Bulwark', 'Wanderlight', 'Grain Road', 'Slow Thunder', 'Cartographer', 'Undertow', 'Hesper'],
    suffix: () => '' });
} catch (e) { HVY_ERR = String(e.message || e); console.error(e); }
