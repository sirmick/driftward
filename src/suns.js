// ======================= SUNS =======================
// Stars: analytic sphere with limb darkening, Worley granulation, spots, corona streamers, chromosphere and prominences.
// Compact objects: pulsar beams from a tilted magnetic axis; black holes ray-marched through Schwarzschild bending,
// with a Doppler-beamed accretion disk and a lensed copy of the real sky behind it. Lens flare is a screen pass.
const STAR_VS = `#version 300 es
in vec2 aPos; uniform vec2 uRes, uCenter; uniform float uRpx, uExt; out vec2 vQ;
void main(){ vQ = aPos*uExt; vec2 w = uCenter + aPos*uExt*uRpx; gl_Position = vec4(w/uRes*2.-1., 0., 1.); }`;

const STAR_FS = `#version 300 es
precision highp float;
in vec2 vQ; out vec4 o;
uniform vec3 uCol, uChrom, uBeam, uShellCol;
uniform float uBright, uGran, uCell, uSpots, uCorona, uStreamers, uProm, uLimb, uRot, uSeed, uTime, uPx, uBands, uGlowR, uShell, uBeamOn, uBeamW, uPulse, uNeb;
uniform float uExt;
${NOISE}
${NOISE3}
void main(){
  vec2 q = vQ; float r = length(q), ang = atan(q.y, q.x);
  vec3 col = vec3(0.); float a = 0.;
  if (r < 1.) {
    float z = sqrt(1. - r*r); vec3 P = vec3(q, z);
    float cr = cos(uRot), sr = sin(uRot);
    vec3 S = vec3(P.x*cr + P.z*sr, P.y, -P.x*sr + P.z*cr);
    float I = 1. - uLimb*(1. - pow(z, .55));
    if (uGran > .01) {
      vec2 w = worley3(S*uCell + vec3(0., 0., uTime*.05));
      float gran = smoothstep(0., .5, w.y - w.x), fine = fbm3(S*uCell*4. + uTime*.1);
      I *= mix(1., .62 + .5*gran + .15*fine, uGran);
      I *= 1. + .3*pow(1. - z, 2.)*uGran*smoothstep(.55, .7, fbm3(S*uCell*.6 + uSeed));
    }
    if (uBands > .01) { float b = sin(S.y*14. + fbm3(S*2. + uSeed)*3.); I *= mix(1., .72 + .28*b, uBands); }
    if (uSpots > .01) {
      float lat = abs(S.y), sp = fbm3(S*2.6 + uSeed);
      float band = smoothstep(.05, .2, lat)*(1. - smoothstep(.45, .6, lat));
      I *= 1. - uSpots*(smoothstep(.66, .72, sp)*band*.35 + smoothstep(.72, .78, sp)*band*.5);
    }
    col = uCol*uBright*I;
    a = 1. - smoothstep(1. - uPx*1.5, 1., r);
  }
  float x = max(r, 1.) - 1.;
  float cor = exp(-x/(uGlowR*.3))*.55 + exp(-x/uGlowR)*.25 + .08*uGlowR/(x + uGlowR);
  float str = fbm(vec2(ang*1.2732 + uSeed, x*1.5/uGlowR - uTime*.03));
  cor *= mix(1., .35 + 1.5*str*str, uStreamers);
  vec3 glow = uCol*uBright*uCorona*cor*.35;
  if (r >= 1.) {
    glow += uChrom*uBright*exp(-x*45.)*.6;
    if (uProm > .01) {
      float pn = n3(vec3(cos(ang)*6., sin(ang)*6., x*14. - uTime*.05) + uSeed);
      glow += uChrom*uBright*smoothstep(.62, .75, pn)*(1. - smoothstep(0., .16, x))*uProm*1.3;
    }
  }
  if (uShell > .01) {
    float R0 = 2.6, sh = exp(-pow((r - R0)/.35, 2.));
    float n = fbm(vec2(ang*.955 + uSeed, r*2.));
    glow += uShellCol*sh*(.3 + 1.5*n*n)*uShell*1.2;
    glow += uShellCol*uShell*.08*smoothstep(R0 + .4, 0., r)*fbm(q*1.2 + uSeed);
  }
  if (uBeamOn > .5) {
    float bl = length(uBeam.xy);
    if (bl > 1e-3) {
      vec2 d2 = uBeam.xy/bl; float al = dot(q, d2); vec2 pq = q - d2*al;
      float w = uBeamW*(1. + abs(al)*.22);
      glow += uCol*uBright*exp(-dot(pq,pq)/(w*w))*exp(-abs(al)/(uGlowR*3.))*bl*.9;
    }
    glow += uCol*uBright*uPulse*exp(-r/(uGlowR*.8))*1.6;
    if (uNeb > .01) { float nb = fbm(q*.75/uGlowR + uSeed + uTime*.01); glow += vec3(.35,.5,1.)*uNeb*smoothstep(.45,.85,nb)*exp(-r/(uGlowR*4.))*.7; }
  }
  glow *= 1. - smoothstep(uExt*.5, uExt*.97, r);
  o = vec4(col*a + glow*(1. - a*.9), a);
}`;

const BH_FS = `#version 300 es
precision highp float;
in vec2 vQ; out vec4 o;
${SKY}
uniform vec3 uN, uHot, uCool, uJetCol;
uniform float uIn, uOut, uDiskB, uJets, uExt, uPxPerRs, uBHSeed;
uniform vec2 uCenterPx;
void main(){
  vec2 q = vQ; float rq = length(q);
  vec3 pos = vec3(q, 22.), vel = vec3(0., 0., -1.);
  vec3 cx = cross(pos, vel); float h2 = dot(cx, cx);
  vec3 N = normalize(uN);
  vec3 ref = abs(N.z) < .95 ? vec3(0.,0.,1.) : vec3(1.,0.,0.);
  vec3 U = normalize(cross(N, ref)), V = cross(N, U);
  vec3 acc = vec3(0.); float T = 1.; bool hole = false;
  for (int i = 0; i < 160; i++) {
    float r = length(pos);
    if (r < 1.) { hole = true; break; }
    if (r > 26. && dot(pos, vel) > 0.) break;
    float dt = clamp(.12*(r - .8), .02, 1.2);
    vec3 prev = pos;
    vel += -1.5*h2*pos/pow(r, 5.)*dt; pos += vel*dt;
    float s0 = dot(prev, N), s1 = dot(pos, N);
    if (s0*s1 < 0.) {
      vec3 hp = mix(prev, pos, s0/(s0 - s1)); float rd = length(hp);
      if (rd > uIn && rd < uOut) {
        float ph = atan(dot(hp, V), dot(hp, U)), x = (rd - uIn)/(uOut - uIn);
        float tprof = pow(uIn/rd, .75)*pow(max(1. - sqrt(uIn/rd), 0.), .25)*2.2;
        vec3 ud = normalize(cross(N, hp));
        float beta = min(.7, sqrt(.5/(rd - 1.))), cth = dot(ud, -normalize(vel));
        float D = sqrt(1. - beta*beta)/(1. - beta*cth), g = D*sqrt(max(1. - 1./rd, 0.));
        float turb = fbm(vec2(rd*1.4, ph*2.5 - uTime*1.6/pow(rd, 1.5)) + uBHSeed);
        float dens = (.35 + .9*turb)*smoothstep(0., .06, x)*smoothstep(1., .7, x);
        vec3 tc = mix(uCool, uHot, clamp(tprof*g, 0., 1.4));
        vec3 em = tc*pow(g, 3.)*tprof*uDiskB*dens*2.5;
        float al = clamp(dens*.9, 0., .95);
        acc += T*em*al; T *= 1. - al;
        if (T < .02) break;
      }
    }
  }
  vec3 bg = vec3(0.);
  if (!hole) {
    float tz = vel.z < -1e-3 ? (pos.z + 60.)/(-vel.z) : 200.;
    vec3 pf = pos + vel*tz;
    bg = sky(uCenterPx + pf.xy*uPxPerRs);
  }
  vec3 col = acc + T*bg;
  if (uJets > .01) {
    vec2 j2 = N.xy; float jl = length(j2); vec2 jd = jl > 1e-3 ? j2/jl : vec2(0., 1.);
    float al = dot(q, jd); vec2 pq = q - jd*al;
    float w = .45 + abs(al)*.06;
    float knots = .6 + .8*fbm(vec2(abs(al)*.5 - uTime*2.*sign(al), uBHSeed));
    float jet = exp(-dot(pq,pq)/(w*w))*exp(-abs(al)/(uExt*.45))*knots*smoothstep(1.2, 3., abs(al));
    float side = al*sign(N.z + 1e-4) > 0. ? 1.7 : .6;
    col += uJetCol*jet*uJets*side*(jl*.8 + .2)*3.;
    col += uJetCol*uJets*exp(-rq/1.5)*2.*(1. - jl);
  }
  float fade = 1. - smoothstep(uExt*.8, uExt*.98, rq);
  o = vec4(col*fade, fade);
}`;

const FLARE_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform vec2 uRes, uS; uniform vec3 uCol; uniform float uK, uSpikes, uGhosts, uAnam, uScale, uSeed, uTime;
${NOISE}
float hexd(vec2 p){ p = abs(p); return max(p.x*.866 + p.y*.5, p.y); }
void main(){
  vec2 p = vUv*uRes, c = uRes*.5, d = p - uS;
  float r = length(d), ang = atan(d.y, d.x), sc = uScale;
  vec3 col = uCol*uK*(exp(-r/(sc*.02))*.7 + .1*(sc*.03)/(r + sc*.03));
  float spikes = pow(abs(cos(ang*uSpikes*.5 + uSeed)), 90.);
  float rays = pow(vn(vec2(ang*28. + uSeed*7., uSeed)), 5.)*(.7 + .3*sin(uTime*.7 + ang*5.));
  col += uCol*uK*(spikes*1.1 + rays*.45)*exp(-r/(sc*.22));
  vec3 halo = vec3(exp(-pow((r - sc*.30)/(sc*.012), 2.)), exp(-pow((r - sc*.31)/(sc*.012), 2.)), exp(-pow((r - sc*.32)/(sc*.012), 2.)));
  col += halo*uK*.05*uGhosts;
  col += vec3(.45,.65,1.)*uK*uAnam*exp(-abs(d.y)/(sc*.0035))*exp(-abs(d.x)/(sc*.6))*.8;
  vec2 axis = c - uS;
  float fac[6] = float[6](.35, .62, 1.08, 1.45, 1.95, -.32);
  float sz[6] = float[6](.035, .02, .06, .028, .11, .045);
  vec3 tint[6] = vec3[6](vec3(.5,.8,1.), vec3(1.,.6,.3), vec3(.4,1.,.6), vec3(1.,.4,.7), vec3(.5,.6,1.), vec3(1.,.9,.5));
  for (int k = 0; k < 6; k++) {
    vec2 g = uS + axis*fac[k]*2.;
    float gr = sc*sz[k], dd = k == 2 || k == 4 ? hexd(p - g) : length(p - g);
    float disc = (1. - smoothstep(gr*.85, gr, dd))*(.35 + .65*smoothstep(0., gr, dd));
    col += tint[k]*uCol*disc*uK*.035*uGhosts;
  }
  float vis = smoothstep(-.05, .06, min(min(uS.x, uS.y), min(uRes.x - uS.x, uRes.y - uS.y))/sc);
  o = vec4(col*vis, 0.);
}`;

let SUNS = null, SUNS_ERR = '';
try { SUNS = (function () {
  const SP = compile(STAR_VS, STAR_FS), BH = compile(STAR_VS, BH_FS), FL = compile(FS_VS, FLARE_FS);

  // Blackbody color (Tanner Helland fit) -> linear RGB normalized to its max channel
  function blackbody(T) {
    T = Math.max(1000, Math.min(40000, T)) / 100;
    let r, g, b;
    r = T <= 66 ? 255 : 329.698727446 * Math.pow(T - 60, -0.1332047592);
    g = T <= 66 ? 99.4708025861 * Math.log(T) - 161.1195681661 : 288.1221695283 * Math.pow(T - 60, -0.0755148492);
    b = T >= 66 ? 255 : T <= 19 ? 0 : 138.5177312231 * Math.log(T - 10) - 305.0447927307;
    const c = [r, g, b].map(v => Math.pow(Math.max(0, Math.min(255, v)) / 255, 2.2));
    const m = Math.max(...c, 1e-4); return c.map(v => v / m);
  }

  // Each type is a preset over one shared parameter set; the LLM picks a type and stays inside the ranges below.
  const TYPES = {
    yellow:   { label: 'Yellow dwarf', cls: 'G', kind: 'star', temp: 5800, radius: 1, bright: 6, gran: 1, cell: 7, spots: .35, corona: 1, streamers: .8, prom: .6, limb: .6, flare: 1, spikes: 6, anam: .2 },
    orange:   { label: 'Orange dwarf', cls: 'K', kind: 'star', temp: 4400, radius: .85, bright: 5, gran: 1, cell: 7, spots: .45, corona: .8, streamers: .7, prom: .5, limb: .65, flare: .8, spikes: 6, anam: .15 },
    reddwarf: { label: 'Red dwarf', cls: 'M', kind: 'star', temp: 3100, radius: .55, bright: 4, gran: .8, cell: 6, spots: .7, corona: .6, streamers: .5, prom: .9, limb: .7, flare: .55, spikes: 4, anam: .1 },
    brown:    { label: 'Brown dwarf', cls: 'L/T', kind: 'star', temp: 1500, radius: .5, bright: 1.6, gran: .3, cell: 4, spots: 0, corona: .25, streamers: .1, prom: 0, limb: .4, bands: .8, flare: .15, spikes: 4, anam: 0 },
    redgiant: { label: 'Red giant', cls: 'K/M III', kind: 'star', temp: 3500, radius: 2.6, bright: 4.5, gran: 1, cell: 2.2, spots: .2, corona: .9, streamers: .4, prom: .3, limb: .8, flare: .9, spikes: 6, anam: .15 },
    white:    { label: 'White giant', cls: 'A', kind: 'star', temp: 9200, radius: 1.8, bright: 7, gran: .5, cell: 5, spots: 0, corona: 1.2, streamers: .6, prom: .2, limb: .45, flare: 1.3, spikes: 8, anam: .35 },
    blue:     { label: 'Blue supergiant', cls: 'O/B I', kind: 'star', temp: 26000, radius: 2.2, bright: 9, gran: .4, cell: 4, spots: 0, corona: 1.5, streamers: .9, prom: .2, limb: .4, flare: 1.7, spikes: 8, anam: .5 },
    wolfrayet:{ label: 'Wolf-Rayet', cls: 'WR', kind: 'star', temp: 38000, radius: .7, bright: 10, gran: .3, cell: 4, spots: 0, corona: 1.6, streamers: 1, prom: 0, limb: .35, shell: 1, flare: 1.5, spikes: 6, anam: .4 },
    whitedwarf:{ label: 'White dwarf', cls: 'D', kind: 'star', temp: 18000, radius: .12, bright: 12, gran: 0, cell: 4, spots: 0, corona: 1.4, streamers: .2, prom: 0, limb: .3, flare: 1.2, spikes: 6, anam: .3 },
    pulsar:   { label: 'Pulsar', cls: 'NS', kind: 'pulsar', temp: 40000, radius: .07, bright: 14, gran: 0, cell: 4, spots: 0, corona: 1, streamers: 0, prom: 0, limb: .2, beamTilt: 55, beamRate: 1.6, beamW: .35, nebula: .8, flare: 1.1, spikes: 4, anam: .5 },
    blackhole:{ label: 'Black hole', cls: 'BH', kind: 'hole', diskTilt: 78, diskAngle: 12, diskIn: 3, diskOut: 11, diskTemp: 7000, diskB: 1.4, jets: 0, flare: .25, spikes: 4, anam: .3 },
    quasar:   { label: 'Quasar', cls: 'AGN', kind: 'hole', diskTilt: 70, diskAngle: -25, diskIn: 3, diskOut: 13, diskTemp: 16000, diskB: 2.6, jets: 1.2, flare: 1.8, spikes: 8, anam: .7 }
  };
  const ORDER = Object.keys(TYPES);
  const RANGES = {
    temp: [1000, 40000, 50, v => Math.round(v) + ' K', 'star pulsar'], radius: [.05, 3, .01, v => v.toFixed(2) + '×', 'star'],
    bright: [.5, 16, .1, v => v.toFixed(1), 'star pulsar'], gran: [0, 1, .01, pct, 'star'], cell: [1.5, 10, .1, v => v.toFixed(1), 'star'],
    spots: [0, 1, .01, pct, 'star'], corona: [0, 2, .01, pct, 'star pulsar'], streamers: [0, 1, .01, pct, 'star'], prom: [0, 1.2, .01, pct, 'star'],
    limb: [0, 1, .01, pct, 'star'], bands: [0, 1, .01, pct, 'star'], shell: [0, 1.5, .01, pct, 'star'],
    beamTilt: [5, 90, 1, v => Math.round(v) + '°', 'pulsar'], beamRate: [.1, 6, .05, v => v.toFixed(2) + ' Hz', 'pulsar'], beamW: [.1, 1, .01, v => v.toFixed(2), 'pulsar'], nebula: [0, 1.5, .01, pct, 'pulsar'],
    diskTilt: [0, 89, 1, v => Math.round(v) + '°', 'hole'], diskAngle: [-90, 90, 1, v => Math.round(v) + '°', 'hole'], diskIn: [1.6, 6, .05, v => v.toFixed(1) + ' Rs', 'hole'],
    diskOut: [5, 18, .1, v => v.toFixed(1) + ' Rs', 'hole'], diskTemp: [2500, 30000, 100, v => Math.round(v) + ' K', 'hole'], diskB: [0, 4, .01, v => v.toFixed(2), 'hole'], jets: [0, 2, .01, pct, 'hole'],
    flare: [0, 2.5, .01, pct, 'star pulsar hole'], spikes: [4, 10, 2, v => String(v), 'star pulsar hole'], anam: [0, 1, .01, pct, 'star pulsar hole']
  };
  const LABELS = { temp: 'Temperature', radius: 'Radius', bright: 'Brightness', gran: 'Granulation', cell: 'Cell scale', spots: 'Spots', corona: 'Corona', streamers: 'Streamers', prom: 'Prominences', limb: 'Limb darkening', bands: 'Bands', shell: 'Ejecta shell', beamTilt: 'Beam tilt', beamRate: 'Spin rate', beamW: 'Beam width', nebula: 'Wind nebula', diskTilt: 'Disk tilt', diskAngle: 'Disk angle', diskIn: 'Disk inner', diskOut: 'Disk outer', diskTemp: 'Disk temperature', diskB: 'Disk brightness', jets: 'Jets', flare: 'Lens flare', spikes: 'Diffraction spikes', anam: 'Anamorphic streak' };
  function pct(v) { return Math.round(v * 100) + '%'; }

  function rngOf(s) { let a = 0; for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 2654435761) >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Kappa', 'Sigma', 'Tau', 'Omega'];
  const CONS = ['Vela', 'Draconis', 'Lyrae', 'Ceti', 'Orionis', 'Carinae', 'Aquilae', 'Hydrae', 'Pavonis', 'Cygni', 'Leporis', 'Tauri'];
  function makeSun(type, seed) {
    const r = rngOf(type + ':' + seed), t = TYPES[type];
    const s = { type, name: GREEK[Math.floor(r() * GREEK.length)] + ' ' + CONS[Math.floor(r() * CONS.length)], seed: Math.round(r() * 1000) / 10, rot: .2 + r() * .3 };
    for (const k in RANGES) if (t[k] != null) s[k] = t[k];
    const j = (k, a) => { if (s[k] != null) { const R = RANGES[k]; s[k] = Math.max(R[0], Math.min(R[1], s[k] * (1 + (r() * 2 - 1) * a))); } };
    j('temp', .08); j('radius', .1); j('spots', .3); j('streamers', .2); j('diskTilt', .06); j('beamTilt', .2);
    if (s.diskAngle != null) s.diskAngle += (r() * 2 - 1) * 15;
    return s;
  }
  let suns = [];
  function newSet() { suns = ORDER.map((k, i) => makeSun(k, state.sunSeed + i)); }
  newSet();

  // ---------- drawing ----------
  const vecFromTilt = (tilt, ang) => { const t = tilt * Math.PI / 180, a = (ang + 90) * Math.PI / 180; return [Math.sin(t) * Math.cos(a), Math.sin(t) * Math.sin(a), Math.cos(t)]; };
  function beamDir(s, t) {
    const A = vecFromTilt(20, 30);
    const ref = Math.abs(A[2]) < .95 ? [0, 0, 1] : [1, 0, 0];
    let U = [A[1] * ref[2] - A[2] * ref[1], A[2] * ref[0] - A[0] * ref[2], A[0] * ref[1] - A[1] * ref[0]]; const ul = Math.hypot(...U); U = U.map(v => v / ul);
    const V = [A[1] * U[2] - A[2] * U[1], A[2] * U[0] - A[0] * U[2], A[0] * U[1] - A[1] * U[0]];
    const tl = s.beamTilt * Math.PI / 180, ph = t * s.beamRate * Math.PI * 2;
    return [0, 1, 2].map(k => Math.cos(tl) * A[k] + Math.sin(tl) * (Math.cos(ph) * U[k] + Math.sin(ph) * V[k]));
  }
  // display radius in px for a sun drawn in a cell of size `cell` (device px)
  const dispR = (s, cell) => s.radius != null ? cell * 0.11 * s.radius : cell * 0.02;
  function drawSun(s, cx, cy, cell, t, sky) {
    const T = TYPES[s.type], RW = canvas.width, RH = canvas.height;
    if (T.kind === 'hole') {
      const u = BH.u; gl.useProgram(BH.p);
      const ext = s.jets > 0.01 ? 26 : 16, rs = cell * 0.47 / ext;
      gl.uniform2f(u.uRes, RW, RH); gl.uniform1f(u.uTime, t); gl.uniform3fv(u.uStar, sky.star.col); gl.uniform3fv(u.uNeb, sky.star.neb); gl.uniform2f(u.uSunDir, sky.sd[0], sky.sd[1]); gl.uniform2f(u.uOff, 0, 0);
      gl.uniform2f(u.uCenter, cx, cy); gl.uniform1f(u.uRpx, rs); gl.uniform1f(u.uExt, ext);
      gl.uniform2f(u.uCenterPx, cx, cy); gl.uniform1f(u.uPxPerRs, rs);
      gl.uniform3fv(u.uN, vecFromTilt(s.diskTilt, s.diskAngle));
      gl.uniform1f(u.uIn, s.diskIn); gl.uniform1f(u.uOut, Math.max(s.diskOut, s.diskIn + 1)); gl.uniform1f(u.uDiskB, s.diskB); gl.uniform1f(u.uJets, s.jets); gl.uniform1f(u.uBHSeed, s.seed);
      const hot = blackbody(s.diskTemp * 1.6), cool = blackbody(s.diskTemp * 0.45).map(v => v * 0.5);
      gl.uniform3fv(u.uHot, hot); gl.uniform3fv(u.uCool, cool); gl.uniform3fv(u.uJetCol, blackbody(30000));
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      draw();
      return { col: blackbody(s.diskTemp), k: s.flare * (0.6 + s.diskB * 0.3 + s.jets * 0.6), rpx: rs * 3 };
    }
    const u = SP.u; gl.useProgram(SP.p);
    const rpx = Math.max(1.5, dispR(s, cell)), glowR = Math.max(0.6, cell * 0.07 / rpx);
    const ext = Math.min(cell * 0.5 / rpx, Math.max(4, s.shell > 0.01 ? 3.6 : 1 + glowR * 4.5));
    const col = blackbody(s.temp);
    let pulse = 0, beam = [0, 0, 0];
    if (T.kind === 'pulsar') { beam = beamDir(s, t); pulse = Math.pow(Math.abs(beam[2]), 30); }
    gl.uniform2f(u.uRes, RW, RH); gl.uniform2f(u.uCenter, cx, cy); gl.uniform1f(u.uRpx, rpx); gl.uniform1f(u.uExt, T.kind === 'pulsar' ? cell * 0.5 / rpx : ext);
    gl.uniform3fv(u.uCol, col); gl.uniform3fv(u.uChrom, s.temp < 7000 ? [1, 0.25, 0.3] : blackbody(s.temp * 1.3));
    gl.uniform3fv(u.uShellCol, [0.9, 0.35, 0.55]);
    gl.uniform1f(u.uBright, s.bright); gl.uniform1f(u.uGran, s.gran || 0); gl.uniform1f(u.uCell, s.cell || 5); gl.uniform1f(u.uSpots, s.spots || 0);
    gl.uniform1f(u.uCorona, s.corona || 0); gl.uniform1f(u.uStreamers, s.streamers || 0); gl.uniform1f(u.uProm, s.prom || 0); gl.uniform1f(u.uLimb, s.limb || 0);
    gl.uniform1f(u.uBands, s.bands || 0); gl.uniform1f(u.uShell, s.shell || 0);
    gl.uniform1f(u.uRot, t * (s.rot || 0.2) * 0.15); gl.uniform1f(u.uSeed, s.seed); gl.uniform1f(u.uTime, t); gl.uniform1f(u.uPx, 1 / rpx); gl.uniform1f(u.uGlowR, glowR);
    gl.uniform1f(u.uBeamOn, T.kind === 'pulsar' ? 1 : 0); gl.uniform3fv(u.uBeam, beam); gl.uniform1f(u.uBeamW, (s.beamW || 0.3) * glowR); gl.uniform1f(u.uPulse, pulse); gl.uniform1f(u.uNeb, s.nebula || 0);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    draw();
    return { col, k: s.flare * (0.5 + s.bright / 10) * (1 + pulse * 2), rpx };
  }
  function drawFlare(s, x, y, info, scaleRef, ghosts, t) {
    const u = FL.u; gl.useProgram(FL.p);
    gl.uniform2f(u.uRes, canvas.width, canvas.height); gl.uniform2f(u.uS, x, y);
    gl.uniform3fv(u.uCol, info.col); gl.uniform1f(u.uK, info.k);
    gl.uniform1f(u.uSpikes, s.spikes || 6); gl.uniform1f(u.uGhosts, ghosts); gl.uniform1f(u.uAnam, s.anam || 0);
    gl.uniform1f(u.uScale, scaleRef); gl.uniform1f(u.uSeed, s.seed); gl.uniform1f(u.uTime, t);
    gl.blendFunc(gl.ONE, gl.ONE);
    draw();
  }
  function frame(now) {
    const t = (now - t0) / 1000, RW = canvas.width, RH = canvas.height;
    const star = STARS[state.star], sv = sunVec(), sl = Math.hypot(sv[0], sv[1]) || 1;
    const sky = { star, sd: [sv[0] / sl, sv[1] / sl] };
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.f); gl.viewport(0, 0, RW, RH);
    gl.disable(gl.BLEND);
    gl.useProgram(P.bg.p);
    gl.uniform2f(P.bg.u.uRes, RW, RH); gl.uniform1f(P.bg.u.uTime, t);
    gl.uniform3fv(P.bg.u.uStar, star.col); gl.uniform3fv(P.bg.u.uNeb, star.neb);
    gl.uniform2f(P.bg.u.uSunDir, sky.sd[0], sky.sd[1]); gl.uniform2f(P.bg.u.uOff, 0, 0);
    draw();
    gl.enable(gl.BLEND);
    const focus = state.sunFocus >= 0;
    const drawn = [];
    for (const c of cells) {
      const s = suns[c.sun]; if (!s) continue;
      let cx = c.cx * dpr, cy = (H - c.cy) * dpr;
      if (focus) { cx = (W / 2 + state.sunOff[0] * W) * dpr; cy = (H / 2 - state.sunOff[1] * H) * dpr; }
      const info = drawSun(s, cx, cy, c.cell * dpr, t + c.sun * 7.1, sky);
      drawn.push([s, cx, cy, info, c]);
    }
    if (state.flares) for (const [s, cx, cy, info, c] of drawn) {
      if (focus) drawFlare(s, cx, cy, info, Math.min(RW, RH), 1, t);
      else drawFlare(s, cx, cy, { col: info.col, k: info.k * 0.5 }, c.cell * dpr * 0.6, 0, t);
    }
    gl.disable(gl.BLEND);
    postProcess();
  }

  // ---------- builder panel ----------
  $('sn-type').innerHTML = ORDER.map(k => `<option value="${k}">${TYPES[k].label} (${TYPES[k].cls})</option>`).join('');
  $('sn-sliders').innerHTML = Object.keys(RANGES).map(k => { const R = RANGES[k]; return `<label class="slider" for="sn-${k}" data-row="${k}">${LABELS[k]} <input id="sn-${k}" type="range" min="${R[0]}" max="${R[1]}" step="${R[2]}"><output id="sn-${k}-v"></output></label>`; }).join('');
  const cur = () => suns[state.sunFocus];
  const showJSON = () => { const s = cur(); if (s) $('sn-json').textContent = JSON.stringify(s, (k, v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v, 1); };
  function syncPanel() {
    const s = cur();
    $('sn-editor').hidden = !s; $('sn-gridnote').hidden = !!s;
    if (!s) return;
    const T = TYPES[s.type];
    $('sn-name').textContent = s.name; $('sn-kind').textContent = T.label + ' · class ' + T.cls;
    $('sn-type').value = s.type;
    for (const k in RANGES) {
      const R = RANGES[k], row = document.querySelector(`[data-row="${k}"]`), el = $('sn-' + k);
      const applies = R[4].split(' ').includes(T.kind) && (!(k === 'bands' || k === 'shell') || T[k] != null);
      row.hidden = !applies;
      if (applies) { if (s[k] == null) s[k] = 0; el.value = s[k]; $('sn-' + k + '-v').textContent = R[3](+el.value); }
    }
    showJSON();
  }
  for (const k in RANGES) $('sn-' + k).addEventListener('input', e => { const s = cur(); if (!s) return; s[k] = +e.target.value; $('sn-' + k + '-v').textContent = RANGES[k][3](s[k]); showJSON(); });
  $('sn-type').addEventListener('change', e => { if (state.sunFocus < 0) return; const old = cur(); const s = makeSun(e.target.value, Math.random()); s.name = old.name; suns[state.sunFocus] = s; syncPanel(); layout(); });
  $('sn-random').addEventListener('click', () => { if (state.sunFocus < 0) return; const old = cur(); suns[state.sunFocus] = makeSun(old.type, Math.random()); syncPanel(); layout(); });
  $('sn-newset').addEventListener('click', () => { state.sunSeed = 's' + Math.floor(Math.random() * 1e6); newSet(); layout(); });
  $('sn-back').addEventListener('click', () => { state.sunFocus = -1; syncPanel(); layout(); });
  $('sn-flares').checked = state.flares;
  $('sn-flares').addEventListener('change', e => { state.flares = e.target.checked; });

  return {
    frame, count: () => suns.length,
    focus: k => { state.sunFocus = k; state.sunOff = [-0.17, 0.12]; syncPanel(); layout(); },
    sync: syncPanel,
    label: k => { const s = suns[k]; return s ? { name: s.name, kind: TYPES[s.type].label } : null; }
  };
})(); } catch (e) { SUNS_ERR = String(e.message || e); console.error(e); }
