// ======================= SHIPYARD =======================
// Every faction line's hulls in every size class, for the debug screen's Ships tab: drawn into the game's GL canvas
// behind the tab's grid of cells, with plumes and shields, lit by a fixed sun (the lab's Yard, ported). Each hull's
// seed is picked here: a click rerolls one, shift-click steps back through the ones it had. Picks are kept in this
// browser and used by the game's own ships too; "Copy picks" exports them for the catalog (a line's `seeds`).
function makeShipyard(o) {
  const { gl, P, draw, baker, catalog } = o;
  const STORE = 'driftward.shipSeeds', BASE_SEED = 'play-1';
  const picks = (() => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { return {}; } })();
  const history = new Map(); // hull|size -> earlier seeds, newest last
  // picks belong to the hull: lines that share hulls (the Ironhulls' refits) share their picks, so a pair stays one vessel
  const hullOf = b => { const B = catalog.brands.find(x => x.id === b); return (B && B.hullKey) || b; };
  const k = (b, z) => hullOf(b) + '|' + z;
  const zi = z => catalog.sizes.findIndex(s => s.id === z);
  // a hull's seed: this browser's pick, else the catalog's (a line's seeds, one per class), else the base seed
  function catalogSeed(b, z) { const B = catalog.brands.find(x => x.id === b); return (B && B.seeds && B.seeds[zi(z)]) || BASE_SEED; }
  const seedOf = (b, z) => picks[k(b, z)] || catalogSeed(b, z);
  const save = () => localStorage.setItem(STORE, JSON.stringify(picks));
  const keyOf = (b, z) => 'yard|' + b + '|' + z;
  function bake1(b, z, front) { const seed = seedOf(b, z); baker.enqueue(keyOf(b, z), front, { brand: b, size: z, seed }); baker.ships.get(keyOf(b, z)).seed = seed; }
  // rebake a hull in every line that shares it
  function bake(b, z, front) { for (const B of catalog.brands) if (hullOf(B.id) === hullOf(b) && builds(B, z)) bake1(B.id, z, front); baker.pump(); }
  function setSeed(b, z, seed, remember) {
    if (remember) { const h = history.get(k(b, z)) || []; h.push(seedOf(b, z)); history.set(k(b, z), h.slice(-20)); }
    if (seed === catalogSeed(b, z)) delete picks[k(b, z)]; else picks[k(b, z)] = seed;
    save(); bake(b, z, true);
  }
  const reroll = (b, z) => setSeed(b, z, Math.random().toString(36).slice(2, 8), true);
  function back(b, z) { const h = history.get(k(b, z)); if (h && h.length) setSeed(b, z, h.pop(), false); }
  const reset = () => { for (const key of Object.keys(picks)) delete picks[key]; save(); history.clear(); bakeAll(); };
  const builds = (B, z) => !B.classes || B.classes.includes(z); // a unique line builds only its own classes
  function bakeAll() { for (const B of catalog.brands) for (const z of catalog.sizes) { if (!builds(B, z.id)) continue; const s = baker.ships.get(keyOf(B.id, z.id)); if (!s || s.seed !== seedOf(B.id, z.id)) bake1(B.id, z.id, false); } baker.pump(); }
  // the picks as catalog entries: for each line with a pick, its five seeds
  function exportPicks() {
    const out = {};
    for (const B of catalog.brands) if (catalog.sizes.some(z => picks[k(B.id, z.id)])) out[B.id] = catalog.sizes.map(z => builds(B, z.id) ? seedOf(B.id, z.id) : null);
    return out;
  }
  const status = (b, z) => { const s = baker.ships.get(keyOf(b, z)); return !s ? 'queued' : s.error ? 'failed: ' + s.error : s.pending ? 'baking' : 'ready'; };

  // ---------- drawing: each visible cell's hull, at the cell's place on screen (device px, y up) ----------
  const rot = (a, x, y) => [Math.cos(a) * x - Math.sin(a) * y, Math.sin(a) * x + Math.cos(a) * y];
  const sun = (() => { const az = 135 * Math.PI / 180, el = 35 * Math.PI / 180; return [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)]; })();
  const STAR = STARS.sol, sunCol = lin(STAR.col);
  const HU = new Float32Array(32).map((v, i) => i % 4 === 2 ? -1 : 0), NOL = new Float32Array(64);
  // cells: [{ el, b, z }]; opts: { throttle, shields, trueScale, hover }
  function render(t, cells, opts) {
    const canvas = gl.canvas, RW = canvas.width, RH = canvas.height, dpr = RW / canvas.clientWidth;
    const vis = [];
    let maxExt = 1;
    for (const c of cells) {
      const s = baker.ships.get(keyOf(c.b, c.z));
      if (s && s.ready) maxExt = Math.max(maxExt, s.maps.extent);
    }
    for (const c of cells) {
      const s = baker.ships.get(keyOf(c.b, c.z)); if (!s || !s.ready || !s.tex) continue;
      const r = c.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > canvas.clientHeight || r.width < 4) continue;
      // the hull in the cell above its label, leaving room aft for the plume
      const B = catalog.brands.find(x => x.id === c.b), box = Math.min(r.width, r.height - 40);
      const half = (opts.trueScale ? s.maps.extent / maxExt : 1) * box * 0.36;
      vis.push({ c, s, B, br: brandRender(B), hd: half * dpr, cx: (r.left + r.width / 2) * dpr, cy: (canvas.clientHeight - (r.top + box * 0.42)) * dpr, ang: 0 });
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, o.target().f); gl.viewport(0, 0, RW, RH);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(P.bg.p);
    gl.uniform2f(P.bg.u.uRes, RW, RH); gl.uniform1f(P.bg.u.uTime, t);
    gl.uniform3fv(P.bg.u.uStar, STAR.col); gl.uniform3fv(P.bg.u.uNeb, STAR.neb);
    gl.uniform2f(P.bg.u.uSunDir, Math.SQRT1_2 * -1, Math.SQRT1_2); gl.uniform2f(P.bg.u.uOff, 0, 0);
    draw();
    gl.enable(gl.BLEND);
    // hulls only below opts.clipTop (CSS px from the top: the tab's toolbar), so none show through it
    if (opts.clipTop) { gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, RW, Math.max(0, RH - Math.round(opts.clipTop * dpr))); }
    // plumes (additive, under the hulls)
    gl.blendFunc(gl.ONE, gl.ONE);
    { const u = P.plume.u; gl.useProgram(P.plume.p);
      gl.uniform2f(u.uRes, RW, RH); gl.uniform1f(u.uTime, t);
      vis.forEach((v, i) => {
        const th = Math.min(1, opts.throttle * (0.93 + 0.07 * Math.sin(t * 0.7 + i * 1.9))), br = v.br, pw = plumePower(th), boost = th > 0.85 ? 1 + (th - 0.85) * 3 : 1;
        gl.uniform3fv(u.uCol, br.plCol); gl.uniform3fv(u.uCore, br.plCore.map(c => c + (1 - c) * (boost - 1) * 0.8));
        gl.uniform1f(u.uTurb, br.plTurb); gl.uniform1f(u.uDiamonds, br.plDia); gl.uniform1f(u.uSputter, br.plSput); gl.uniform1f(u.uPulse, br.plPulse); gl.uniform1f(u.uSpread, br.plSpread);
        gl.uniform1f(u.uPower, pw);
        v.s.maps.engines.forEach((e, n) => {
          const q = rot(v.ang, (e.u - 0.5) * 2 * v.hd, (0.5 - e.v) * 2 * v.hd), d = rot(v.ang, e.dx, e.dy), wid = Math.max(e.w * 2 * v.hd, 1.5 * dpr);
          gl.uniform2f(u.uNoz, v.cx + q[0], v.cy + q[1]); gl.uniform2f(u.uDir, d[0], d[1]);
          gl.uniform1f(u.uWid, wid * br.plWid * 1.1); gl.uniform1f(u.uLen, wid * br.plLen * (0.3 + 1.7 * th) * boost);
          gl.uniform1f(u.uSeed, i * 7.3 + n * 1.37);
          draw();
        });
      }); }
    // hulls (premultiplied over)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    { const u = P.ship.u; gl.useProgram(P.ship.p);
      gl.uniform2f(u.uRes, RW, RH); gl.uniform3fv(u.uSun, sun); gl.uniform3fv(u.uSunCol, sunCol); gl.uniform3fv(u.uAmb, STAR.amb);
      gl.uniform1f(u.uTime, t); gl.uniform1i(u.uMode, 0); gl.uniform1f(u.uShadow, 1);
      gl.uniform1i(u.uA, 0); gl.uniform1i(u.uN, 1); gl.uniform1i(u.uE, 2); gl.uniform1i(u.uX, 3);
      gl.uniform4fv(u.uLP, NOL); gl.uniform4fv(u.uLC, NOL); gl.uniform1i(u.uLN, 0);
      for (const v of vis) {
        const m = v.B.style.material, mp = v.s.maps;
        gl.uniform2f(u.uCenter, v.cx, v.cy); gl.uniform1f(u.uHalf, v.hd); gl.uniform1f(u.uAngle, v.ang);
        gl.uniform1f(u.uExtent, mp.extent); gl.uniform1f(u.uHRange, mp.hRange); gl.uniform1f(u.uPxPerM, 2 * v.hd / mp.extent);
        gl.uniform1f(u.uDmax, mp.Dmax); gl.uniform1f(u.uS, mp.shieldS);
        gl.uniform1f(u.uGloss, m.gloss); gl.uniform1f(u.uSpecK, 0.6 + m.spec * 1.4); gl.uniform1f(u.uWrap, m.wrap); gl.uniform1f(u.uIrid, m.irid); gl.uniform1f(u.uRim, m.rim);
        gl.uniform1f(u.uThrottle, opts.throttle); gl.uniform1f(u.uHover, opts.hover === v.c.el ? 1 : 0);
        for (let q = 0; q < 4; q++) { gl.activeTexture(gl.TEXTURE0 + q); gl.bindTexture(gl.TEXTURE_2D, v.s.tex[q]); }
        draw();
      } }
    // shields (additive), idling so their shell and pattern show
    if (opts.shields) {
      gl.blendFunc(gl.ONE, gl.ONE);
      const u = P.shield.u; gl.useProgram(P.shield.p);
      gl.uniform2f(u.uRes, RW, RH); gl.uniform1f(u.uTime, t); gl.uniform1i(u.uX, 0); gl.uniform4fv(u.uHits, HU);
      vis.forEach((v, i) => {
        const mp = v.s.maps;
        gl.uniform2f(u.uCenter, v.cx, v.cy); gl.uniform1f(u.uHalf, v.hd); gl.uniform1f(u.uAngle, v.ang);
        gl.uniform1f(u.uExtent, mp.extent); gl.uniform1f(u.uS, mp.shieldS); gl.uniform1f(u.uDmax, mp.Dmax);
        gl.uniform1f(u.uIdle, 0.45); gl.uniform1f(u.uStrength, v.br.shStr); gl.uniform1f(u.uSeed, i * 3.7);
        gl.uniform3fv(u.uCol, v.br.shCol); gl.uniform1i(u.uPat, v.br.shPat);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, v.s.tex[3]);
        draw();
      });
    }
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
  }
  return { catalog, seedOf, catalogSeed, reroll, back, reset, bakeAll, exportPicks, status, render, picked: (b, z) => !!picks[k(b, z)] };
}
