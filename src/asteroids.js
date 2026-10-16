// ======================= ASTEROIDS =======================
// The lab's Asteroids tab: a set of rocks, one of each composition first, and a builder for one. The rocks, their
// types and the shader are the game's own (rocks.js), so what this tab shows is what a belt or field is made of.
let AST = null, AST_ERR = '';
try { AST = (function () {
  const KIT = makeRockKit(gl, compile, quad, 16), inst = new Float32Array(16 * ROCK_STRIDE);
  const TYPES = ROCK_TYPES, ORDER = ROCK_ORDER;
  const RANGES = {
    size: ['Diameter', 15, 3000, 1, v => v >= 1000 ? (v / 1000).toFixed(2) + ' km' : Math.round(v) + ' m'],
    sx: ['Length', .5, 1.6, .01, v => v.toFixed(2) + '×'], sy: ['Width', .5, 1.4, .01, v => v.toFixed(2) + '×'], sz: ['Depth', .4, 1.3, .01, v => v.toFixed(2) + '×'],
    lump: ['Lumpiness', 0, .8, .01, v => Math.round(v * 100) + '%'], freq: ['Roughness scale', 1, 4, .05, v => v.toFixed(2)],
    crater: ['Craters', 0, 1, .01, v => Math.round(v * 100) + '%'], ore: ['Ore veins', 0, 1.5, .01, v => Math.round(v * 100) + '%'],
    frost: ['Frost', 0, 1, .01, v => Math.round(v * 100) + '%'], tumble: ['Tumble', 0, 1, .01, v => Math.round(v * 100) + '%']
  };
  let rocks = [];
  function newSet() { const r = rockRng(state.astSeed); rocks = []; for (let k = 0; k < 12; k++) rocks.push(makeRock(k < ORDER.length ? ORDER[k] : ORDER[Math.floor(r() * ORDER.length)], state.astSeed + k)); }
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
    // device pixels as world units: the camera at the canvas centre, one unit a pixel, y up
    KIT.begin({ res: [RW, RH], cam: [RW / 2, RH / 2], scale: 1, time: state.spin ? t : 0, sun: sv, sunCol: lin(star.col), amb: star.amb });
    const focus = state.astFocus >= 0;
    const maxSize = focus ? 1 : Math.max(...rocks.map(r => r.size));
    let n = 0;
    for (const c of cells) {
      const a = rocks[c.item]; if (!a) continue;
      const frac = focus ? 1 : 0.3 + 0.7 * Math.sqrt(a.size / maxSize);
      KIT.pack(inst, n++, a, c.cx * dpr, (H - c.cy) * dpr, c.cell * 0.46 * frac / rockExt(a) * dpr);
    }
    KIT.draw(inst, n);
    gl.disable(gl.BLEND);
    postProcess();
  }

  // ---------- builder ----------
  $('as-type').innerHTML = ORDER.map(k => `<option value="${k}">${TYPES[k].label} (${TYPES[k].cls})</option>`).join('');
  $('as-sliders').innerHTML = Object.keys(RANGES).map(k => { const R = RANGES[k]; return `<label class="slider" for="as-${k}">${R[0]} <input id="as-${k}" type="range" min="${R[1]}" max="${R[2]}" step="${R[3]}"><output id="as-${k}-v"></output></label>`; }).join('');
  const cur = () => rocks[state.astFocus];
  const showJSON = () => { const a = cur(); if (a) $('as-json').textContent = JSON.stringify(a, (k, v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v, 1); };
  function syncPanel() {
    const a = cur();
    $('as-editor').hidden = !a; $('as-gridnote').hidden = !!a;
    if (!a) return;
    $('as-name').textContent = a.name; $('as-kind').textContent = TYPES[a.type].label + ' · class ' + TYPES[a.type].cls;
    $('as-type').value = a.type;
    for (const k in RANGES) { $('as-' + k).value = a[k]; $('as-' + k + '-v').textContent = RANGES[k][4](a[k]); }
    showJSON();
  }
  for (const k in RANGES) $('as-' + k).addEventListener('input', e => { const a = cur(); if (!a) return; a[k] = +e.target.value; $('as-' + k + '-v').textContent = RANGES[k][4](a[k]); showJSON(); });
  $('as-type').addEventListener('change', e => { const a = cur(); if (!a) return; const T = TYPES[e.target.value]; a.type = e.target.value; a.ore = T.ore; a.frost = T.frost; a.crater = T.crater; syncPanel(); layout(); });
  $('as-random').addEventListener('click', () => { if (state.astFocus < 0) return; const a = cur(); rocks[state.astFocus] = makeRock(a.type, Math.random()); syncPanel(); layout(); });
  $('as-newset').addEventListener('click', () => { state.astSeed = 'rocks-' + Math.floor(Math.random() * 1e6); newSet(); layout(); });
  $('as-back').addEventListener('click', () => { state.astFocus = -1; syncPanel(); layout(); });

  return {
    frame, count: () => rocks.length, sync: syncPanel,
    focus: k => { state.astFocus = k; syncPanel(); layout(); },
    label: k => { const a = rocks[k]; return a ? { name: TYPES[a.type].label, kind: a.name + ' · ' + RANGES.size[4](a.size) } : null; }
  };
})(); } catch (e) { AST_ERR = String(e.message || e); console.error(e); }
