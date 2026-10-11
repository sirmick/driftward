// ======================= STATIONS =======================
// Stations are assembled by gen.js (assembleStation) from an archetype layout plus an owning brand's style,
// baked by the same workers as ships, and lit with the yard ship shader.
let STN = null, STN_ERR = '';
try { STN = (function () {
  function rngOf(s) { let a = 0; for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 2654435761) >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const NAMES = ['Anchorage', 'Meridian', 'Halfway', 'Cinder Yard', 'Tollgate', 'Weir', 'Lantern', 'Keel', 'Foundry', 'Harbor', 'Crossing', 'Bastion', 'Spindle', 'Hearth', 'Waypoint', 'Slipway'];
  let items = [];
  const stKey = it => 'st|' + it.arch + '|' + it.brand + '|' + it.seed;
  function newSet() {
    purge();
    const r = rngOf(state.stSeed), A = catalog.stations, B = catalog.brands;
    items = [];
    for (let k = 0; k < 12; k++) items.push({ arch: A[k % A.length].id, brand: B[Math.floor(r() * B.length)].id, seed: 's' + Math.floor(r() * 1e6), name: NAMES[Math.floor(r() * NAMES.length)] });
  }
  function purge() {
    const live = new Set(items.map(stKey));
    for (const [k, s] of ships) if (k.startsWith('st|') && !live.has(k)) { if (s.tex) s.tex.forEach(t => gl.deleteTexture(t)); ships.delete(k); const i = queue.indexOf(k); if (i >= 0) queue.splice(i, 1); }
  }
  function ensure(it, front) {
    const k = stKey(it);
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
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const u = P.ship.u; gl.useProgram(P.ship.p);
    gl.uniform2f(u.uRes, RW, RH);
    gl.uniform3fv(u.uSun, sv); gl.uniform3fv(u.uSunCol, lin(star.col)); gl.uniform3fv(u.uAmb, star.amb);
    gl.uniform1f(u.uTime, t); gl.uniform1i(u.uMode, state.map === 5 ? 0 : state.map); gl.uniform1f(u.uShadow, state.shadow ? 1 : 0);
    gl.uniform1i(u.uA, 0); gl.uniform1i(u.uN, 1); gl.uniform1i(u.uE, 2); gl.uniform1i(u.uX, 3);
    const LP = new Float32Array(64), LC = new Float32Array(64); let nl = 0;
    if (state.pl && state.mouse) { LP.set([state.mouse.x * dpr, (H - state.mouse.y) * dpr, 120 * dpr, 240 * dpr], 0); LC.set([1.6, 1.25, 0.85, 0], 0); nl = 1; }
    gl.uniform4fv(u.uLP, LP); gl.uniform4fv(u.uLC, LC); gl.uniform1i(u.uLN, nl);
    gl.uniform1f(u.uThrottle, 0);
    const focus = state.stFocus >= 0;
    for (const c of cells) {
      const it = items[c.item]; if (!it) continue;
      const s = ensure(it, focus);
      if (!s || !s.ready) continue;
      const arch = catalog.stations.find(a => a.id === it.arch), brand = catalog.brands.find(b => b.id === it.brand), m = brand.style.material;
      const hd = c.cell * (focus ? 0.5 : 0.5) * dpr;
      const ang = state.spin ? t * (arch.spin || 0.01) * (focus ? 1 : 2) + c.item : 0;
      gl.uniform2f(u.uCenter, c.cx * dpr, (H - c.cy) * dpr); gl.uniform1f(u.uHalf, hd); gl.uniform1f(u.uAngle, ang);
      gl.uniform1f(u.uExtent, s.maps.extent); gl.uniform1f(u.uHRange, s.maps.hRange); gl.uniform1f(u.uPxPerM, 2 * hd / s.maps.extent);
      gl.uniform1f(u.uDmax, s.maps.Dmax); gl.uniform1f(u.uS, s.maps.shieldS);
      gl.uniform1f(u.uGloss, m.gloss); gl.uniform1f(u.uSpecK, 0.6 + m.spec * 1.4); gl.uniform1f(u.uWrap, m.wrap); gl.uniform1f(u.uIrid, m.irid); gl.uniform1f(u.uRim, m.rim);
      gl.uniform1f(u.uHover, !focus && state.hoverItem === c.item ? 1 : 0);
      for (let k = 0; k < 4; k++) { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, s.tex[k]); }
      draw();
    }
    gl.disable(gl.BLEND);
    postProcess();
  }

  // ---------- builder ----------
  $('st-arch').innerHTML = catalog.stations.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  $('st-brand').innerHTML = catalog.brands.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  const cur = () => items[state.stFocus];
  function syncPanel() {
    const it = cur();
    $('st-editor').hidden = !it; $('st-gridnote').hidden = !!it;
    if (!it) return;
    const arch = catalog.stations.find(a => a.id === it.arch), brand = catalog.brands.find(b => b.id === it.brand);
    $('st-name').textContent = it.name + ' ' + arch.name.split(' ').pop();
    $('st-kind').textContent = arch.blurb;
    $('st-arch').value = it.arch; $('st-brand').value = it.brand;
    const s = ships.get(stKey(it));
    if (!s || !s.ready || s.pending) { $('st-stats').innerHTML = '<dt>Status</dt><dd>Baking…</dd>'; $('st-json').textContent = ''; return; }
    const roles = {}; s.spec.parts.forEach(p => { roles[p.prim] = (roles[p.prim] || 0) + 1; });
    const rows = [['Owner style', brand.name], ['Diameter', Math.round(s.spec.length_m) + ' m'], ['Parts', s.maps.partCount], ['Bake', `${s.maps.res}² px`], ['Resolution', (s.maps.res / s.maps.extent).toFixed(2) + ' px/m']];
    $('st-stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
    $('st-json').textContent = JSON.stringify({ archetype: arch, owner: it.brand, seed: it.seed, parts: s.spec.parts.length, primitives: roles }, null, 1);
  }
  const rebuild = () => { purge(); ensure(cur(), true); syncPanel(); layout(); };
  $('st-arch').addEventListener('change', e => { const it = cur(); if (!it) return; it.arch = e.target.value; rebuild(); });
  $('st-brand').addEventListener('change', e => { const it = cur(); if (!it) return; it.brand = e.target.value; rebuild(); });
  $('st-random').addEventListener('click', () => { const it = cur(); if (!it) return; it.seed = 's' + Math.floor(Math.random() * 1e6); rebuild(); });
  $('st-newset').addEventListener('click', () => { state.stSeed = 'stations-' + Math.floor(Math.random() * 1e6); newSet(); layout(); });
  $('st-back').addEventListener('click', () => { state.stFocus = -1; syncPanel(); layout(); });

  return {
    frame, count: () => items.length, sync: syncPanel,
    focus: k => { state.stFocus = k; syncPanel(); layout(); },
    onBaked: key => { if (state.view === 'stations' && state.stFocus >= 0 && key === stKey(cur())) syncPanel(); },
    label: k => { const it = items[k]; if (!it) return null; const a = catalog.stations.find(x => x.id === it.arch), b = catalog.brands.find(x => x.id === it.brand); return { name: a.name, kind: b.name }; }
  };
})(); } catch (e) { STN_ERR = String(e.message || e); console.error(e); }
