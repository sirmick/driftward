// ======================= PLANETS =======================
// The lab's planets are the game's: each is a body's `look` from system.schema.json, clamped by the same schema
// and drawn by the game's planet shader (PLANET_FS, through look.js planetUniforms), so the JSON the builder shows is
// exactly what a system file (or a model writing one) gives a planet or moon. NOISE3 is the shared value noise the
// Suns and Asteroids tabs' shaders use.
const NOISE3 = `
float h31(vec3 p){ p = fract(p*.3183099+.1); p *= 17.; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float n3(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.-2.*f);
  return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x), mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x), f.y),
             mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x), mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x), f.y), f.z); }
float fbm3(vec3 p){ float s=0., a=.5; for(int i=0;i<6;i++){ s+=a*n3(p); p=p*2.02+vec3(1.7,9.2,3.1); a*=.5; } return s/.984; }
float ridge3(vec3 p){ float s=0., a=.5; for(int i=0;i<5;i++){ float n=1.-abs(n3(p)*2.-1.); s+=a*n*n; p=p*2.03+vec3(5.1,1.3,7.7); a*=.5; } return s; }
vec2 worley3(vec3 p){ vec3 i=floor(p), f=fract(p); float d1=8., d2=8.;
  for(int z=-1;z<=1;z++) for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
    vec3 g=vec3(float(x),float(y),float(z)); vec3 o=vec3(h31(i+g),h31(i+g+17.1),h31(i+g+31.7));
    float d=length(g+o-f); if(d<d1){ d2=d1; d1=d; } else if(d<d2) d2=d; }
  return vec2(d1,d2); }`;

let PLAN = null, PLAN_ERR = '';
try { PLAN = (function () {
  const FP = compile(PLANET_VS, PLANET_FS);
  const LOOK = JSON.parse($('system-schema').textContent).properties.bodies.items.properties.look;
  const LP = LOOK.properties, RP = LP.rings.properties;
  // clamp a look to the schema, as the game does when it loads a system (notes are what the clamp changed)
  const clampLook = raw => { const notes = []; return { look: clampToSchema(LOOK, raw, '$.look', notes), notes }; };

  // presets: a surface, its three colours (what each means depends on the surface), the air and its colour, and
  // how stormy, lit and ringed such worlds tend to be
  const PRESETS = {
    verdant: { label: 'Verdant', surface: 'terran', palette: ['#1d5f8f', '#4b7a35', '#7d6b45'], atmosphere: '#7fb6ff', air: 1, cityLights: 0.6 },
    oceanic: { label: 'Oceanic', surface: 'terran', palette: ['#17689f', '#3d7a64', '#8c8a68'], atmosphere: '#8fd0ff', air: 1.1, cityLights: 0.25, lightning: 0.3 },
    frozen: { label: 'Frozen', surface: 'terran', palette: ['#9fc2dc', '#d6e6f2', '#eef5fb'], atmosphere: '#cfe8ff', air: 0.8 },
    toxic: { label: 'Toxic', surface: 'terran', palette: ['#4a6a12', '#7c8f24', '#b7c63c'], atmosphere: '#b8f060', air: 1.3, lightning: 0.5 },
    violet: { label: 'Violet', surface: 'terran', palette: ['#341c66', '#5f3594', '#9a6ac8'], atmosphere: '#c08cff', air: 1.1, cityLights: 0.4 },
    arid: { label: 'Arid', surface: 'rock', palette: ['#5e3f27', '#a8784c', '#d2a874'], atmosphere: '#ffc890', air: 0.7 },
    rust: { label: 'Rust', surface: 'rock', palette: ['#5c2715', '#9e4a2a', '#c47546'], atmosphere: '#ffad80', air: 0.45 },
    cinder: { label: 'Cinder', surface: 'rock', palette: ['#2a0f08', '#47291f', '#5e3a2c'], atmosphere: '#ff6a2a', air: 0.8 },
    barren: { label: 'Barren', surface: 'rock', palette: ['#4b4845', '#6d6862', '#8f8981'], atmosphere: '#a0a0a0', air: 0 },
    jovian: { label: 'Jovian giant', surface: 'giant', palette: ['#7d4e33', '#c9925c', '#ecd9b0'], atmosphere: '#ffcf9a', air: 0.7, lightning: 0.6 },
    azure: { label: 'Azure giant', surface: 'giant', palette: ['#16406f', '#2f6fb0', '#9cc8ec'], atmosphere: '#9fd0ff', air: 1, lightning: 0.3 },
    rose: { label: 'Rose giant', surface: 'giant', palette: ['#5a2240', '#a8506a', '#e09a8e'], atmosphere: '#ffb0c0', air: 0.8 },
    ember: { label: 'Ember giant', surface: 'giant', palette: ['#2a0c06', '#6a1e0c', '#c0461a'], atmosphere: '#ff7a3a', air: 0.9, lightning: 0.8 }
  };
  const RINGS = { ice: ['#dfe9f2', '#94a8bc'], dust: ['#b09a80', '#5e5040'], gold: ['#ecd29a', '#9c7c4a'], rose: ['#ecb4ac', '#8a5862'], ember: ['#ffb070', '#6a2a14'], jade: ['#b8e8d0', '#4a7a6a'] };
  const PAL_MEANS = { terran: 'Seas, lowlands, highlands', giant: 'Bands, bands, zones', rock: 'Plains, ground, ridges' };

  // ---------- generation ----------
  function rngOf(s) { let a = 0; for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 2654435761) >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const SYL = ['ka', 've', 'lor', 'tis', 'an', 'dra', 'mo', 'rin', 'sel', 'ux', 'thar', 'ion', 'be', 'qua', 'zen', 'or', 'phe', 'ly', 'ga', 'nox', 'cy', 'mar', 'ost', 'el'];
  const SUF = ['', '', '', ' Prime', ' II', ' IV', ' Minor', ' b'];
  function name(r) { let s = ''; const n = 2 + (r() < 0.4 ? 1 : 0); for (let i = 0; i < n; i++) s += SYL[Math.floor(r() * SYL.length)]; return s[0].toUpperCase() + s.slice(1) + SUF[Math.floor(r() * SUF.length)]; }
  const round = v => Math.round(v * 100) / 100;
  // a preset's look, without rings
  const presetLook = (key, seed) => { const P = PRESETS[key]; return { surface: P.surface, palette: P.palette.slice(), atmosphere: P.atmosphere, air: P.air, lightning: P.lightning || 0, cityLights: P.cityLights || 0, debris: 1, seed }; };
  function generate(seedText) {
    const r = rngOf(seedText), keys = Object.keys(PRESETS), preset = keys[Math.floor(r() * keys.length)];
    const raw = presetLook(preset, round(r() * 100));
    const giant = raw.surface === 'giant';
    if (r() < (giant ? 0.6 : 0.2)) {
      const inner = round(1.25 + r() * 0.35), rk = Object.keys(RINGS);
      raw.rings = { density: round(0.55 + r() * 0.4), inner, outer: round(inner + 0.45 + r() * 0.7), colours: RINGS[rk[Math.floor(r() * rk.length)]].slice(), tilt: Math.round(50 + r() * 32), angle: Math.round((r() * 2 - 1) * 35) };
    }
    return { name: name(r), preset, look: clampLook(raw).look };
  }
  let worlds = [];
  function newSet() { worlds = []; for (let i = 0; i < 12; i++) worlds.push(generate(state.planetSeed + ':' + i)); worlds.forEach(w => { w.pu = planetUniforms(w.look); }); }
  newSet();

  // ---------- drawing: in pixels, the game's planet shader on a camera at the canvas centre, one pixel a metre ----------
  function frame(now) {
    const t = (now - t0) / 1000;
    const star = STARS[state.star], sv = sunVec(), sl = Math.hypot(sv[0], sv[1]) || 1;
    const RW = canvas.width, RH = canvas.height;
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.f); gl.viewport(0, 0, RW, RH);
    gl.disable(gl.BLEND);
    gl.useProgram(P.bg.p);
    gl.uniform2f(P.bg.u.uRes, RW, RH); gl.uniform1f(P.bg.u.uTime, t);
    gl.uniform3fv(P.bg.u.uStar, star.col); gl.uniform3fv(P.bg.u.uNeb, star.neb);
    gl.uniform2f(P.bg.u.uSunDir, sv[0] / sl, sv[1] / sl); gl.uniform2f(P.bg.u.uOff, 0, 0);
    draw();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(FP.p);
    const u = FP.u;
    gl.uniform2f(u.uRes, RW, RH); gl.uniform2f(u.uCam, RW / 2, RH / 2); gl.uniform1f(u.uScale, 1);
    gl.uniform3fv(u.uSun, sv); gl.uniform3fv(u.uSunCol, lin(star.col)); gl.uniform3fv(u.uAmb, star.amb);
    // the game spins worlds slowly (a turn in about 26 minutes); the lab runs that clock 40 times faster to show it
    gl.uniform1f(u.uTime, t * 40);
    for (const c of cells) {
      const w = worlds[c.planet]; if (!w) continue;
      const fill = state.planetFocus >= 0 ? 0.5 : 0.47, Rp = c.cell * fill / w.pu.ext * dpr;
      gl.uniform2f(u.uC, c.cx * dpr, (H - c.cy) * dpr); gl.uniform1f(u.uR, Rp); gl.uniform1f(u.uPx, 1 / Rp);
      bindPlanet(gl, u, w.pu); planetClock(gl, u, t * 40, w.pu.seed);
      draw();
    }
    gl.disable(gl.BLEND);
    postProcess();
  }

  // ---------- builder panel ----------
  const pct = v => Math.round(v * 100) + '%', deg = v => Math.round(v) + '°', x2 = v => v.toFixed(2) + '×';
  // [field, label, format]; ranges and steps from the schema
  const SL = [['air', 'Air', pct], ['lightning', 'Lightning', pct], ['cityLights', 'City lights', pct], ['debris', 'Orbital debris (game only)', x2], ['seed', 'Seed', v => v.toFixed(1)]];
  const RSL = [['density', 'Density', pct], ['inner', 'Inner edge', x2], ['outer', 'Outer edge', x2], ['tilt', 'Tilt from face-on', deg], ['angle', 'Pole on screen', deg]];
  const sliderRow = (id, label, sc) => `<label class="slider" for="${id}" data-row="${id}">${label} <input id="${id}" type="range" min="${sc.minimum}" max="${sc.maximum}" step="${(sc.maximum - sc.minimum) > 50 ? 1 : 0.01}"><output id="${id}-v"></output></label>`;
  $('pl-sliders').innerHTML = SL.map(s => sliderRow('pl-' + s[0], s[1], LP[s[0]])).join('');
  $('pl-ring-sliders').innerHTML = RSL.map(s => sliderRow('pl-r' + s[0], s[1], RP[s[0]])).join('');
  $('pl-preset').innerHTML = Object.keys(PRESETS).map(k => `<option value="${k}">${PRESETS[k].label}</option>`).join('');
  $('pl-surface').innerHTML = LP.surface.enum.map(k => `<option value="${k}">${k[0].toUpperCase() + k.slice(1)}</option>`).join('');
  $('pl-ringstyle').innerHTML = '<option value="">Custom</option>' + Object.keys(RINGS).map(k => `<option value="${k}">${k[0].toUpperCase() + k.slice(1)}</option>`).join('');
  const cur = () => worlds[state.planetFocus];
  // an edit: clamp to the schema (as the game would), rework the uniforms, refresh the panel
  function apply(w) { w.look = clampLook(w.look).look; w.pu = planetUniforms(w.look); syncPanel(); }
  const json = w => JSON.stringify(w.look, (k, v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v, 1);
  function syncPanel() {
    const w = cur();
    $('pl-editor').hidden = !w; $('pl-gridnote').hidden = !!w;
    if (!w) return;
    const L = w.look, R = L.rings, on = R.density > 0;
    $('pl-name').textContent = w.name;
    $('pl-kind').textContent = (PRESETS[w.preset] ? PRESETS[w.preset].label : L.surface) + (on ? ' · ringed' : '');
    $('pl-preset').value = w.preset || ''; $('pl-surface').value = L.surface;
    $('pl-pal-label').textContent = PAL_MEANS[L.surface];
    L.palette.forEach((c, k) => { $('pl-c' + k).value = c; }); $('pl-atm').value = L.atmosphere;
    for (const s of SL) { const el = $('pl-' + s[0]); el.value = L[s[0]]; $('pl-' + s[0] + '-v').textContent = s[2](+L[s[0]]); }
    $('pl-rings').checked = on; $('pl-ring-body').hidden = !on;
    const style = Object.keys(RINGS).find(k => RINGS[k][0] === R.colours[0] && RINGS[k][1] === R.colours[1]);
    $('pl-ringstyle').value = style || ''; $('pl-r0').value = R.colours[0]; $('pl-r1').value = R.colours[1];
    for (const s of RSL) { const el = $('pl-r' + s[0]); el.value = R[s[0]]; $('pl-r' + s[0] + '-v').textContent = s[2](+R[s[0]]); }
    $('pl-json').textContent = json(w);
  }
  const edit = fn => e => { const w = cur(); if (!w) return; fn(w, e.target); apply(w); };
  for (const s of SL) $('pl-' + s[0]).addEventListener('input', edit((w, el) => { w.look[s[0]] = +el.value; }));
  for (const s of RSL) $('pl-r' + s[0]).addEventListener('input', edit((w, el) => {
    const R = w.look.rings; R[s[0]] = +el.value;
    if (R.outer < R.inner + 0.1) { if (s[0] === 'inner') R.outer = R.inner + 0.1; else R.inner = R.outer - 0.1; } // outer stays past inner
  }));
  [0, 1, 2].forEach(k => $('pl-c' + k).addEventListener('input', edit((w, el) => { w.look.palette[k] = el.value; w.preset = ''; })));
  $('pl-atm').addEventListener('input', edit((w, el) => { w.look.atmosphere = el.value; w.preset = ''; }));
  $('pl-surface').addEventListener('change', edit((w, el) => { w.look.surface = el.value; w.preset = ''; }));
  $('pl-preset').addEventListener('change', edit((w, el) => { w.look = Object.assign(presetLook(el.value, w.look.seed), { rings: w.look.rings, debris: w.look.debris }); w.preset = el.value; }));
  $('pl-rings').addEventListener('change', edit((w, el) => { w.look.rings.density = el.checked ? 0.75 : 0; }));
  $('pl-ringstyle').addEventListener('change', edit((w, el) => { if (RINGS[el.value]) w.look.rings.colours = RINGS[el.value].slice(); }));
  [0, 1].forEach(k => $('pl-r' + k).addEventListener('input', edit((w, el) => { w.look.rings.colours[k] = el.value; })));
  $('pl-random').addEventListener('click', () => { if (state.planetFocus < 0) return; const w = generate(state.planetSeed + ':' + state.planetFocus + ':' + Math.random()); w.pu = planetUniforms(w.look); worlds[state.planetFocus] = w; syncPanel(); layout(); });
  $('pl-newset').addEventListener('click', () => { state.planetSeed = 'set-' + Math.floor(Math.random() * 1e6); newSet(); state.planetFocus = -1; syncPanel(); layout(); });
  $('pl-back').addEventListener('click', () => { state.planetFocus = -1; syncPanel(); layout(); });

  return {
    frame, systems: () => worlds,
    focus: k => { state.planetFocus = k; syncPanel(); layout(); },
    sync: syncPanel,
    label: k => { const w = worlds[k]; return w ? { name: w.name, kind: (PRESETS[w.preset] ? PRESETS[w.preset].label : w.look.surface) + (w.look.rings.density > 0 ? ' · ringed' : '') } : null; }
  };
})(); } catch (e) { PLAN_ERR = String(e.message || e); console.error(e); }
