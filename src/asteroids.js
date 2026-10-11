// ======================= ASTEROIDS =======================
// Sphere-traced in the fragment shader: an ellipsoid displaced by low-frequency noise for the silhouette,
// with craters, grit and ore veins applied as shading-only detail. Each body tumbles about its own axis.
const AST_VS = `#version 300 es
in vec2 aPos; uniform vec2 uRes, uCenter; uniform float uRpx, uExt; out vec2 vQ;
void main(){ vQ = aPos*uExt; vec2 w = uCenter + aPos*uExt*uRpx; gl_Position = vec4(w/uRes*2.-1., 0., 1.); }`;

const AST_FS = `#version 300 es
precision highp float;
in vec2 vQ; out vec4 o;
uniform vec3 uSun, uSunCol, uAmb, uScale, uC1, uC2, uC3, uOreCol;
uniform mat3 uRot;
uniform float uLump, uFreq, uCrater, uSeed, uSpec, uOre, uFrost, uExt;
${NOISE3}
float n4(vec3 p){ float s=0., a=.5; for(int i=0;i<4;i++){ s+=a*n3(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=.5; } return s/.9375; }
float shape(vec3 p){
  vec3 q = p/uScale;
  float base = (length(q) - 1.)*min(min(uScale.x, uScale.y), uScale.z);
  return base - (n3(p*1.1 + uSeed) - .5)*uLump*.9 - (n4(p*uFreq + uSeed*1.3) - .5)*uLump*.45;
}
float detail(vec3 p){
  float h = (fbm3(p*uFreq*3. + uSeed) - .5)*.05;
  if (uCrater > .01) {
    vec2 w = worley3(p*uFreq*1.1 + uSeed);
    h += (smoothstep(.38,.46,w.x)*(1.-smoothstep(.46,.6,w.x))*.05 - (1.-smoothstep(0.,.45,w.x))*.12)*uCrater;
    vec2 w2 = worley3(p*uFreq*3.2 + uSeed*2.);
    h += (smoothstep(.36,.42,w2.x)*(1.-smoothstep(.42,.5,w2.x))*.02 - (1.-smoothstep(0.,.36,w2.x))*.04)*uCrater;
  }
  return h;
}
float field(vec3 p){ return shape(p) - detail(p); }
void main(){
  vec2 q = vQ;
  if (length(q) > uExt) discard;
  vec3 ro = uRot*vec3(q, 4.), rd = uRot*vec3(0., 0., -1.);
  float t = 4. - uExt, hit = -1.;
  for (int i = 0; i < 80; i++) {
    float d = shape(ro + rd*t);
    if (d < .002) { hit = t; break; }
    t += d*.75;
    if (t > 4. + uExt) break;
  }
  if (hit < 0.) discard;
  vec3 p = ro + rd*hit;
  vec2 e = vec2(.004, 0.);
  float f0 = field(p);
  vec3 nObj = normalize(vec3(field(p+e.xyy) - f0, field(p+e.yxy) - f0, field(p+e.yyx) - f0));
  vec3 N = normalize(transpose(uRot)*nObj);
  float cav = detail(p);
  float m = fbm3(p*uFreq*.7 + uSeed*3.);
  vec3 alb = mix(uC1, uC2, smoothstep(.35, .7, m));
  alb = mix(alb, uC3, smoothstep(.62, .85, fbm3(p*uFreq*2. + uSeed*5.))*.6);
  alb *= .78 + 3.5*clamp(cav + .04, -.05, .08);
  float frost = uFrost*smoothstep(.45, .65, n3(p*2.5 + uSeed*4.) + dot(N, vec3(0.,0.,1.))*.15);
  alb = mix(alb, vec3(.9,.95,1.), frost);
  float v = pow(1. - abs(n3(p*uFreq*2.4 + uSeed*7.)*2. - 1.), 14.)*uOre;
  alb = mix(alb, uOreCol*.6, v*.7);
  alb = pow(alb, vec3(2.2));
  vec3 L = normalize(uSun);
  float dif = max(dot(N, L), 0.);
  float sh = 1.;
  { vec3 ld = uRot*L, lo = p + nObj*.02; float tt = .03;
    for (int i = 0; i < 20; i++) { float d = shape(lo + ld*tt); if (d < .001) { sh = .12; break; } sh = min(sh, .12 + .88*clamp(10.*d/tt, 0., 1.)); tt += max(d, .03); if (tt > uExt*2.) break; } }
  vec3 Hh = normalize(L + vec3(0.,0.,1.));
  float spec = pow(max(dot(N, Hh), 0.), mix(10., 70., uSpec))*(uSpec*1.6 + frost*.6);
  vec3 col = alb*uSunCol*dif*sh*2.4 + uSunCol*spec*sh + alb*uAmb*2.2;
  col += uOreCol*v*2.2*(.6 + .4*sin(uSeed*3. + p.x*4.));
  col += uAmb*3.*pow(1. - max(N.z, 0.), 3.);
  o = vec4(col, 1.);
}`;

let AST = null, AST_ERR = '';
try { AST = (function () {
  const PR = compile(AST_VS, AST_FS);
  const TYPES = {
    carbon:   { label: 'Carbonaceous', cls: 'C', cols: ['#2b2926', '#3a3631', '#57514a'], spec: .1, crater: .85, ore: 0, frost: 0, oreCol: '#ffffff' },
    silicate: { label: 'Silicate', cls: 'S', cols: ['#6e5c47', '#8b7559', '#b39b78'], spec: .15, crater: .7, ore: 0, frost: 0, oreCol: '#ffffff' },
    metal:    { label: 'Metallic', cls: 'M', cols: ['#55595f', '#767b82', '#a3a8b0'], spec: .75, crater: .5, ore: 0, frost: 0, oreCol: '#ffffff' },
    basalt:   { label: 'Basaltic', cls: 'V', cols: ['#34343a', '#4c4c54', '#76767f'], spec: .25, crater: .6, ore: 0, frost: 0, oreCol: '#ffffff' },
    iron:     { label: 'Iron-rich', cls: 'X', cols: ['#4e2a1c', '#74402a', '#a6643e'], spec: .3, crater: .6, ore: 0, frost: 0, oreCol: '#ffffff' },
    olivine:  { label: 'Olivine', cls: 'A', cols: ['#364528', '#586c38', '#8a9c5a'], spec: .2, crater: .6, ore: 0, frost: 0, oreCol: '#ffffff' },
    icy:      { label: 'Icy', cls: 'D', cols: ['#7f97ab', '#b9cbd9', '#eef5fb'], spec: .45, crater: .4, ore: 0, frost: .7, oreCol: '#ffffff' },
    crystal:  { label: 'Crystalline', cls: 'Q', cols: ['#231d33', '#3c3354', '#7e70a6'], spec: .55, crater: .3, ore: 1, frost: 0, oreCol: '#c47cff' },
    gold:     { label: 'Gold-veined', cls: 'S/M', cols: ['#5c4c3a', '#7d6a50', '#a58e6c'], spec: .3, crater: .6, ore: .8, frost: 0, oreCol: '#ffcf4a' },
    cobalt:   { label: 'Cobalt-veined', cls: 'M', cols: ['#3a3d44', '#565b64', '#878d98'], spec: .6, crater: .5, ore: .8, frost: 0, oreCol: '#3fa8ff' }
  };
  const ORDER = Object.keys(TYPES);
  const LIN = {}; for (const k in TYPES) LIN[k] = { cols: TYPES[k].cols.map(hexRGB), ore: lin(hexRGB(TYPES[k].oreCol)) };
  const RANGES = {
    size: ['Diameter', 15, 3000, 1, v => v >= 1000 ? (v / 1000).toFixed(2) + ' km' : Math.round(v) + ' m'],
    sx: ['Length', .5, 1.6, .01, v => v.toFixed(2) + '×'], sy: ['Width', .5, 1.4, .01, v => v.toFixed(2) + '×'], sz: ['Depth', .4, 1.3, .01, v => v.toFixed(2) + '×'],
    lump: ['Lumpiness', 0, .8, .01, v => Math.round(v * 100) + '%'], freq: ['Roughness scale', 1, 4, .05, v => v.toFixed(2)],
    crater: ['Craters', 0, 1, .01, v => Math.round(v * 100) + '%'], ore: ['Ore veins', 0, 1.5, .01, v => Math.round(v * 100) + '%'],
    frost: ['Frost', 0, 1, .01, v => Math.round(v * 100) + '%'], tumble: ['Tumble', 0, 1, .01, v => Math.round(v * 100) + '%']
  };
  function rngOf(s) { let a = 0; for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 2654435761) >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function make(type, seed) {
    const r = rngOf(type + ':' + seed), T = TYPES[type];
    const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
    const size = Math.round(15 * Math.pow(200, Math.pow(r(), 1.3)));
    const ax = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1]; const al = Math.hypot(...ax) || 1;
    return {
      type, name: `${L[Math.floor(r() * L.length)]}${L[Math.floor(r() * L.length)]}-${Math.floor(100 + r() * 9000)}`, seed: Math.round(r() * 1000) / 10, size,
      sx: 0.75 + r() * 0.75, sy: 0.6 + r() * 0.45, sz: 0.55 + r() * 0.4, lump: 0.2 + r() * 0.45, freq: 1.6 + r() * 1.6,
      crater: T.crater * (0.7 + r() * 0.5), ore: T.ore, frost: T.frost, tumble: 0.15 + r() * 0.5,
      axis: ax.map(v => v / al), phase: r() * 6.283
    };
  }
  let rocks = [];
  function newSet() { const r = rngOf(state.astSeed); rocks = []; for (let k = 0; k < 12; k++) rocks.push(make(k < ORDER.length ? ORDER[k] : ORDER[Math.floor(r() * ORDER.length)], state.astSeed + k)); }
  newSet();

  function rotMat(axis, a) { // rotation (object orientation), returned transposed: maps view to object
    const [x, y, z] = axis, c = Math.cos(a), s = Math.sin(a), C = 1 - c;
    const R = [c + x * x * C, x * y * C - z * s, x * z * C + y * s,
      y * x * C + z * s, c + y * y * C, y * z * C - x * s,
      z * x * C - y * s, z * y * C + x * s, c + z * z * C];
    return new Float32Array(R); // row-major R read as column-major = R transposed
  }
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
    const u = PR.u; gl.useProgram(PR.p);
    gl.uniform2f(u.uRes, RW, RH); gl.uniform3fv(u.uSun, sv); gl.uniform3fv(u.uSunCol, lin(star.col)); gl.uniform3fv(u.uAmb, star.amb);
    const focus = state.astFocus >= 0;
    const maxSize = focus ? 1 : Math.max(...rocks.map(r => r.size));
    for (const c of cells) {
      const a = rocks[c.item]; if (!a) continue;
      const L = LIN[a.type];
      const ext = Math.max(a.sx, a.sy, a.sz) * (1 + a.lump * 0.8) + 0.05;
      const frac = focus ? 1 : 0.3 + 0.7 * Math.sqrt(a.size / maxSize);
      const rpx = c.cell * 0.46 * frac / ext * dpr;
      gl.uniform2f(u.uCenter, c.cx * dpr, (H - c.cy) * dpr); gl.uniform1f(u.uRpx, rpx); gl.uniform1f(u.uExt, ext);
      gl.uniformMatrix3fv(u.uRot, false, rotMat(a.axis, a.phase + (state.spin ? t * a.tumble * 0.6 : 0)));
      gl.uniform3f(u.uScale, a.sx, a.sy, a.sz);
      gl.uniform3fv(u.uC1, L.cols[0]); gl.uniform3fv(u.uC2, L.cols[1]); gl.uniform3fv(u.uC3, L.cols[2]); gl.uniform3fv(u.uOreCol, L.ore);
      gl.uniform1f(u.uLump, a.lump); gl.uniform1f(u.uFreq, a.freq); gl.uniform1f(u.uCrater, a.crater); gl.uniform1f(u.uSeed, a.seed);
      gl.uniform1f(u.uSpec, TYPES[a.type].spec); gl.uniform1f(u.uOre, a.ore); gl.uniform1f(u.uFrost, a.frost);
      draw();
    }
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
  $('as-random').addEventListener('click', () => { if (state.astFocus < 0) return; const a = cur(); rocks[state.astFocus] = make(a.type, Math.random()); syncPanel(); layout(); });
  $('as-newset').addEventListener('click', () => { state.astSeed = 'rocks-' + Math.floor(Math.random() * 1e6); newSet(); layout(); });
  $('as-back').addEventListener('click', () => { state.astFocus = -1; syncPanel(); layout(); });

  return {
    frame, count: () => rocks.length, sync: syncPanel,
    focus: k => { state.astFocus = k; syncPanel(); layout(); },
    label: k => { const a = rocks[k]; return a ? { name: TYPES[a.type].label, kind: a.name + ' · ' + RANGES.size[4](a.size) } : null; }
  };
})(); } catch (e) { AST_ERR = String(e.message || e); console.error(e); }
