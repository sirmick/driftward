// ======================= PLANETS =======================
// Fully procedural in the fragment shader: an analytic sphere with seamless 3D noise for the surface,
// equatorial rings that cast and receive shadows, and moons on inclined orbits drawn behind or in front of the planet.
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

const BODY_VS = `#version 300 es
in vec2 aPos; uniform vec2 uRes, uCenter; uniform float uRpx, uExt; out vec2 vQ;
void main(){ vQ = aPos*uExt; vec2 w = uCenter + aPos*uExt*uRpx; gl_Position = vec4(w/uRes*2.-1., 0., 1.); }`;

const BODY_FS = `#version 300 es
precision highp float;
in vec2 vQ; out vec4 o;
uniform vec3 uSun, uSunCol, uAmb, uAxis;
uniform vec3 uPal[5]; uniform vec3 uCloudCol, uAtm, uEmis, uRingA, uRingB;
uniform float uGas, uSea, uCloud, uIce, uCity, uCrater, uLava, uAtmK, uFreq, uSeed, uRot, uCloudRot, uPx, uStorm;
uniform float uRingOn, uRingIn, uRingOut, uRingDens;
${NOISE3}
vec3 ramp5(float t){ t = clamp(t,0.,1.)*4.; int i = int(min(floor(t),3.)); return mix(uPal[i], uPal[i+1], smoothstep(0.,1.,t-float(i))); }
float ringDensity(float d){
  float t = (d-uRingIn)/(uRingOut-uRingIn); if (t < 0. || t > 1.) return 0.;
  float b = .5 + .5*n3(vec3(d*42., uSeed, 1.)); b *= .55 + .45*n3(vec3(d*9., uSeed*1.7, 3.));
  float gap = smoothstep(.012,.03,abs(t-.62)), gap2 = smoothstep(.004,.012,abs(t-.86));
  return uRingDens*b*gap*mix(1.,gap2,.85)*smoothstep(0.,.05,t)*smoothstep(1.,.92,t);
}
void main(){
  vec3 A = normalize(uAxis), L = normalize(uSun);
  vec2 q = vQ; float r = length(q);
  vec4 res = vec4(0.);
  float zs = r < 1. ? sqrt(1.-r*r) : -1.;
  if (r < 1.) {
    vec3 P = vec3(q, zs);
    vec3 ref = abs(A.z) < .95 ? vec3(0.,0.,1.) : vec3(1.,0.,0.);
    vec3 U = normalize(cross(A, ref)), V = cross(A, U);
    float lx = dot(P,U), ly = dot(P,V), lat = dot(P,A);
    float cr = cos(uRot), sr = sin(uRot);
    vec3 S = vec3(lx*cr - ly*sr, lx*sr + ly*cr, lat);
    vec3 alb, em = vec3(0.); float specMask = 0., land = 0.;
    float dl = dot(P, L), night = smoothstep(.08, -.18, dl);
    if (uGas > .5) {
      float w = fbm3(S*vec3(2.4,2.4,.9) + uSeed);
      float t = lat*1.7 + (w-.5)*.6 + (fbm3(S*vec3(3.,3.,28.) + uSeed*2.)-.5)*.14;
      alb = ramp5(abs(fract(t*.85)*2.-1.));
      vec3 sp = normalize(vec3(cos(uSeed*3.), sin(uSeed*3.), -.35));
      float sd = length((S - sp)*vec3(1.,1.,2.4));
      float swirl = n3(S*18. + uSeed);
      float storm = (1. - smoothstep(.1, .19, sd + (swirl-.5)*.04))*uStorm;
      alb = mix(alb, mix(uPal[4], uPal[1], .35 + .3*swirl), storm*.85);
      em += uEmis*uLava*night*(.4 + .6*w)*1.6;
    } else {
      float h = fbm3(S*uFreq + uSeed)*.85 + ridge3(S*uFreq*1.3 + uSeed*2.)*.25 - .1;
      if (uCrater > .01) {
        vec2 wv = worley3(S*uFreq*1.7 + uSeed);
        float bowl = 1. - smoothstep(0., .42, wv.x);
        float rim = smoothstep(.34,.42,wv.x)*(1.-smoothstep(.42,.56,wv.x));
        h += (rim*.12 - bowl*.2)*uCrater;
      }
      if (h < uSea) {
        alb = mix(uPal[0], uPal[1], smoothstep(uSea-.18, uSea, h)); specMask = 1. - uLava;
        if (uLava > .01) { float g = .5 + .5*n3(S*16. + uSeed); em += uEmis*uLava*(.55 + 1.1*g)*smoothstep(uSea-.3, uSea, h)*1.8; }
      } else {
        land = 1.;
        if (uSea < 0.) alb = ramp5(h*1.15 - .1);
        else { float t = (h - uSea)/max(1. - uSea, .05)*1.8; alb = mix(mix(uPal[2], uPal[3], smoothstep(0., .45, t)), uPal[4], smoothstep(.5, 1., t)); }
        if (uLava > .01) { float c = pow(1. - abs(n3(S*uFreq*3.5 + uSeed*3.)*2. - 1.), 10.); em += uEmis*c*uLava*2.2; alb *= 1. - c*.6; }
      }
      if (uIce > .01) {
        float ic = smoothstep(1. - uIce*.55, 1. - uIce*.55 + .06, abs(lat) + (n3(S*6. + uSeed)-.5)*.14);
        alb = mix(alb, vec3(.93,.96,1.), ic); specMask *= 1. - ic; em *= 1. - ic;
      }
      if (uCity > .01) {
        float cl = smoothstep(.62,.82,n3(S*46. + uSeed))*smoothstep(.45,.75,n3(S*7. + uSeed*2.));
        em += vec3(1.,.72,.38)*cl*night*uCity*land*1.7;
      }
    }
    alb = pow(alb, vec3(2.2));
    float lit = uGas > .5 ? max(dl*.92 + .08*smoothstep(-.15,.25,dl), 0.) : max(dl, 0.);
    float rs = 1.;
    if (uRingOn > .5) { float dn = dot(A, L); if (abs(dn) > 1e-3) { float t = -dot(A, P)/dn; if (t > 0.) rs = 1. - ringDensity(length(P + L*t))*.85; } }
    vec3 col = alb*uSunCol*lit*rs*2.4 + alb*uAmb*1.2;
    col += uSunCol*pow(max(dot(reflect(-L, P), vec3(0.,0.,1.)), 0.), 70.)*.7*specMask*max(dl,0.)*rs;
    if (uCloud > .01) {
      float cc = cos(uCloudRot), cs = sin(uCloudRot);
      vec3 Sc = vec3(lx*cc - ly*cs, lx*cs + ly*cc, lat);
      float cv = fbm3(Sc*vec3(2.6,2.6,uGas > .5 ? 7. : 2.6) + uSeed*3.);
      cv = smoothstep(1. - uCloud, 1. - uCloud + .22, cv);
      vec3 ccol = pow(uCloudCol, vec3(2.2));
      col = mix(col, ccol*uSunCol*max(dl*.95 + .05, 0.)*rs*2.4 + ccol*uAmb, cv*.92);
      em *= 1. - cv*.85;
    }
    col += em;
    col += uAtm*uAtmK*pow(1. - zs, 2.6)*uSunCol*(.12 + 1.1*max(dl + .25, 0.));
    float aa = 1. - smoothstep(1. - uPx*1.5, 1., r);
    res = vec4(col*aa, aa);
  }
  if (r > .98 && uAtmK > 0.) {
    float lt = clamp(dot(normalize(q), normalize(L.xy + 1e-5))*.7 + .45, 0., 1.);
    float hal = exp(-max(r - 1., 0.)*11.)*smoothstep(.98, 1.01, r);
    res.rgb += uAtm*uAtmK*hal*lt*uSunCol*.7;
  }
  if (uRingOn > .5) {
    float nz = abs(A.z) < .03 ? (A.z < 0. ? -.03 : .03) : A.z;
    float zr = -(A.x*q.x + A.y*q.y)/nz;
    vec3 Q = vec3(q, zr); float d = length(Q);
    float den = ringDensity(d);
    if (den > .001 && (r >= 1. || zr > zs)) {
      float b = dot(Q, L), c = dot(Q, Q) - 1.;
      float sh = (b < 0. && b*b - c > 0.) ? .06 : 1.;
      float face = .3 + .7*abs(dot(A, L));
      vec3 rc = pow(mix(uRingA, uRingB, n3(vec3(d*14., uSeed, 7.))), vec3(2.2));
      vec3 rcol = rc*uSunCol*face*sh*1.8 + rc*uAmb*1.6;
      float ra = clamp(den, 0., .95);
      res = vec4(rcol*ra + res.rgb*(1. - ra), ra + res.a*(1. - ra));
    }
  }
  o = res;
}`;

const ORBIT_FS = `#version 300 es
precision highp float;
in vec2 vQ; out vec4 o;
uniform vec3 uM, uCol; uniform float uRo;
void main(){
  float nz = abs(uM.z) < .02 ? (uM.z < 0. ? -.02 : .02) : uM.z;
  float z = -(uM.x*vQ.x + uM.y*vQ.y)/nz;
  float d = length(vec3(vQ, z)), fw = max(fwidth(d), 1e-4);
  float line = 1. - smoothstep(fw*.6, fw*1.6, abs(d - uRo));
  float r = length(vQ);
  if (r < 1. && z < sqrt(1. - r*r)) discard;
  float front = z > 0. ? 1. : .4;
  o = vec4(uCol*line*front*.3, 0.);
}`;

let PLAN = null, PLAN_ERR = '';
try { PLAN = (function () {
  const BP = compile(BODY_VS, BODY_FS), OP = compile(BODY_VS, ORBIT_FS);

  const PAL = {
    verdant: { label: 'Verdant', gas: 0, cols: ['#0a2747', '#1d5f8f', '#4b7a35', '#7d6b45', '#eceae4'], cloud: '#f4f6f8', atm: '#7fb6ff', d: { sea: .5, cloud: .5, ice: .3, crater: 0, lava: 0, city: .6, atm: 1, freq: 2.2 } },
    oceanic: { label: 'Oceanic', gas: 0, cols: ['#051c3a', '#17689f', '#3d7a64', '#8c8a68', '#f2f5f8'], cloud: '#ffffff', atm: '#8fd0ff', d: { sea: .66, cloud: .6, ice: .35, crater: 0, lava: 0, city: .25, atm: 1.1, freq: 2 } },
    arid: { label: 'Arid', gas: 0, cols: ['#2e1f15', '#5e3f27', '#a8784c', '#d2a874', '#efdcb8'], cloud: '#f0e2cc', atm: '#ffc890', d: { sea: 0, cloud: .12, ice: .12, crater: .25, lava: 0, city: .15, atm: .7, freq: 2.6 } },
    lava: { label: 'Lava', gas: 0, cols: ['#120604', '#2a0f08', '#2b1712', '#47291f', '#5e3a2c'], cloud: '#4a3a34', atm: '#ff6a2a', emis: '#ff5a14', d: { sea: .45, cloud: .15, ice: 0, crater: .2, lava: 1, city: 0, atm: .8, freq: 2.4 } },
    frozen: { label: 'Frozen', gas: 0, cols: ['#5f86a8', '#9fc2dc', '#d6e6f2', '#eef5fb', '#ffffff'], cloud: '#ffffff', atm: '#cfe8ff', d: { sea: .42, cloud: .3, ice: .6, crater: .15, lava: 0, city: 0, atm: .8, freq: 2 } },
    toxic: { label: 'Toxic', gas: 0, cols: ['#1a2508', '#4a6a12', '#7c8f24', '#b7c63c', '#e8f09a'], cloud: '#c9d878', atm: '#b8f060', d: { sea: .5, cloud: .62, ice: 0, crater: 0, lava: 0, city: 0, atm: 1.3, freq: 2.2 } },
    rust: { label: 'Rust', gas: 0, cols: ['#2c130b', '#5c2715', '#9e4a2a', '#c47546', '#e6c3a2'], cloud: '#e8cdb4', atm: '#ffad80', d: { sea: 0, cloud: .08, ice: .2, crater: .5, lava: 0, city: 0, atm: .45, freq: 2.4 } },
    barren: { label: 'Barren', gas: 0, cols: ['#2e2c2a', '#4b4845', '#6d6862', '#8f8981', '#bdb7ad'], cloud: '#ffffff', atm: '#a0a0a0', d: { sea: 0, cloud: 0, ice: 0, crater: 1, lava: 0, city: 0, atm: 0, freq: 2.8 } },
    violet: { label: 'Violet', gas: 0, cols: ['#0f0826', '#341c66', '#5f3594', '#9a6ac8', '#f0dcff'], cloud: '#e8d8ff', atm: '#c08cff', d: { sea: .48, cloud: .42, ice: .15, crater: 0, lava: 0, city: .4, atm: 1.1, freq: 2.2 } },
    jovian: { label: 'Jovian giant', gas: 1, cols: ['#7d4e33', '#c9925c', '#ecd9b0', '#a86a3a', '#f5e8cc'], cloud: '#f5e8cc', atm: '#ffcf9a', d: { cloud: 0, storm: 1, atm: .7, lava: 0 } },
    azure: { label: 'Azure giant', gas: 1, cols: ['#16406f', '#2f6fb0', '#5f9bd0', '#9cc8ec', '#dff0ff'], cloud: '#ffffff', atm: '#9fd0ff', d: { cloud: .15, storm: .6, atm: 1, lava: 0 } },
    rose: { label: 'Rose giant', gas: 1, cols: ['#5a2240', '#a8506a', '#e09a8e', '#7a3450', '#f8ddd2'], cloud: '#fff0ea', atm: '#ffb0c0', d: { cloud: 0, storm: .8, atm: .8, lava: 0 } },
    ember: { label: 'Ember giant', gas: 1, cols: ['#2a0c06', '#6a1e0c', '#c0461a', '#ff8a3a', '#ffd08a'], cloud: '#ffd8a8', atm: '#ff7a3a', emis: '#ff6a20', d: { cloud: 0, storm: 1, atm: .9, lava: .45 } }
  };
  const RINGS = { ice: ['#dfe9f2', '#94a8bc'], dust: ['#b09a80', '#5e5040'], gold: ['#ecd29a', '#9c7c4a'], rose: ['#ecb4ac', '#8a5862'], ember: ['#ffb070', '#6a2a14'], jade: ['#b8e8d0', '#4a7a6a'] };
  const MOON_PALS = ['barren', 'barren', 'frozen', 'rust', 'arid', 'lava', 'violet'];
  const LIN = {};
  for (const k in PAL) {
    const p = PAL[k];
    LIN[k] = { pal: new Float32Array(p.cols.flatMap(hexRGB)), cloud: hexRGB(p.cloud), atm: lin(hexRGB(p.atm)), emis: lin(hexRGB(p.emis || '#ff6a20')) };
  }
  const RLIN = {}; for (const k in RINGS) RLIN[k] = RINGS[k].map(hexRGB);

  // ---------- generation ----------
  function rngOf(s) { let a = 0; for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 2654435761) >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const SYL = ['ka', 've', 'lor', 'tis', 'an', 'dra', 'mo', 'rin', 'sel', 'ux', 'thar', 'ion', 'be', 'qua', 'zen', 'or', 'phe', 'ly', 'ga', 'nox', 'cy', 'mar', 'ost', 'el'];
  const SUF = ['', '', '', ' Prime', ' II', ' IV', ' Minor', ' b'];
  function name(r) { let s = ''; const n = 2 + (r() < 0.4 ? 1 : 0); for (let i = 0; i < n; i++) s += SYL[Math.floor(r() * SYL.length)]; return s[0].toUpperCase() + s.slice(1) + SUF[Math.floor(r() * SUF.length)]; }
  const jit = (r, v, a) => Math.max(0, v + (r() * 2 - 1) * a);
  function applyPalette(p, key) {
    const d = PAL[key].d;
    p.palette = key;
    p.sea = d.sea || 0; p.cloud = d.cloud || 0; p.ice = d.ice || 0; p.crater = d.crater || 0; p.lava = d.lava || 0; p.city = d.city || 0; p.atm = d.atm || 0; p.freq = d.freq || 2.2; p.storm = d.storm || 0;
  }
  function makeMoon(r, k, sys) {
    const key = MOON_PALS[Math.floor(r() * MOON_PALS.length)], d = PAL[key].d;
    const base = Math.max(sys.rings.on ? sys.rings.outer + 0.45 : 1.7, 1.7);
    return {
      palette: key, size: 0.1 + r() * 0.16, orbit: base + k * (0.55 + r() * 0.35), seed: r() * 50,
      speed: 0, phase: r() * 6.283, tilt: sys.tilt + (r() * 2 - 1) * 9, angle: sys.axisAngle + (r() * 2 - 1) * 10,
      sea: d.sea || 0, cloud: (d.cloud || 0) * 0.5, ice: d.ice || 0, crater: Math.max(d.crater || 0, 0.4), lava: d.lava || 0, city: 0, atm: (d.atm || 0) * 0.4, freq: 2.6, storm: 0
    };
  }
  function fixMoonSpeeds(sys) { sys.moons.forEach(m => { m.speed = 0.35 / Math.pow(m.orbit, 1.5) * (m.dir || 1); }); }
  function generate(seed) {
    const r = rngOf(seed);
    const keys = Object.keys(PAL);
    const key = keys[Math.floor(r() * keys.length)];
    const p = { name: name(r), seed: Math.round(r() * 1000) / 10, spin: 0.2 + r() * 0.5, tilt: 50 + r() * 32, axisAngle: (r() * 2 - 1) * 35 };
    applyPalette(p, key);
    p.sea = PAL[key].d.sea ? jit(r, p.sea, 0.06) : 0; p.cloud = jit(r, p.cloud, 0.1); p.freq = jit(r, p.freq, 0.4);
    const gas = PAL[key].gas;
    const rk = Object.keys(RINGS);
    const ringOn = r() < (gas ? 0.6 : 0.2);
    const inner = 1.25 + r() * 0.35;
    p.rings = { on: ringOn, style: rk[Math.floor(r() * rk.length)], inner, outer: inner + 0.45 + r() * 0.7, density: 0.55 + r() * 0.4 };
    p.moons = [];
    const nm = Math.floor(r() * (gas ? 4.5 : 3));
    for (let k = 0; k < nm; k++) p.moons.push(makeMoon(r, k, p));
    p.moons.forEach(m => { m.dir = 1; });
    fixMoonSpeeds(p);
    p.showOrbits = true;
    return p;
  }
  let systems = [];
  function newSet() { systems = []; for (let i = 0; i < 12; i++) systems.push(generate(state.planetSeed + ':' + i)); }
  newSet();

  // ---------- drawing ----------
  const axisVec = (tilt, ang) => { const t = tilt * Math.PI / 180, a = (ang + 90) * Math.PI / 180; return [Math.sin(t) * Math.cos(a), Math.sin(t) * Math.sin(a), Math.cos(t)]; };
  function orbitBasis(n) {
    const ref = Math.abs(n[2]) < 0.95 ? [0, 0, 1] : [1, 0, 0];
    let u = [n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]];
    const ul = Math.hypot(...u); u = u.map(v => v / ul);
    const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    return [u, v];
  }
  let frameCtx = null;
  function drawBody(b, cxPx, cyPx, rPx, axis, t, rings) {
    const u = BP.u, L = LIN[b.palette], pal = PAL[b.palette];
    const ext = rings && rings.on ? Math.max(1.3, rings.outer * 1.03) : 1.3;
    gl.uniform2f(u.uCenter, cxPx, cyPx); gl.uniform1f(u.uRpx, rPx); gl.uniform1f(u.uExt, ext); gl.uniform1f(u.uPx, 1 / rPx);
    gl.uniform3fv(u.uAxis, axis);
    gl.uniform3fv(u.uPal, L.pal); gl.uniform3fv(u.uCloudCol, L.cloud); gl.uniform3fv(u.uAtm, L.atm); gl.uniform3fv(u.uEmis, L.emis);
    gl.uniform1f(u.uGas, pal.gas); gl.uniform1f(u.uSea, b.sea < 0.02 ? -1 : b.sea); gl.uniform1f(u.uCloud, b.cloud); gl.uniform1f(u.uIce, b.ice);
    gl.uniform1f(u.uCity, b.city); gl.uniform1f(u.uCrater, b.crater); gl.uniform1f(u.uLava, b.lava); gl.uniform1f(u.uAtmK, b.atm);
    gl.uniform1f(u.uFreq, b.freq); gl.uniform1f(u.uSeed, b.seed); gl.uniform1f(u.uStorm, b.storm || 0);
    gl.uniform1f(u.uRot, t * (b.spin || 0.1) * 0.25); gl.uniform1f(u.uCloudRot, t * (b.spin || 0.1) * 0.3);
    if (rings && rings.on) {
      const R = RLIN[rings.style] || RLIN.ice;
      gl.uniform1f(u.uRingOn, 1); gl.uniform1f(u.uRingIn, rings.inner); gl.uniform1f(u.uRingOut, Math.max(rings.outer, rings.inner + 0.1)); gl.uniform1f(u.uRingDens, rings.density);
      gl.uniform3fv(u.uRingA, R[0]); gl.uniform3fv(u.uRingB, R[1]);
    } else gl.uniform1f(u.uRingOn, 0);
    draw();
  }
  function drawSystem(sys, cx, cy, Rp, t) {
    const RW = canvas.width, RH = canvas.height;
    const axis = axisVec(sys.tilt, sys.axisAngle);
    const moons = sys.moons.map(m => {
      const n = axisVec(m.tilt, m.angle), [e1, e2] = orbitBasis(n), th = m.phase + t * m.speed;
      const p = [0, 1, 2].map(k => m.orbit * (Math.cos(th) * e1[k] + Math.sin(th) * e2[k]));
      return { m, n, p, axis: axisVec(m.tilt * 0.5, m.angle) };
    });
    gl.useProgram(BP.p); setCommon(BP);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const o of moons) if (o.p[2] < 0) { gl.uniform2f(BP.u.uRes, RW, RH); drawBody(o.m, cx + o.p[0] * Rp, cy + o.p[1] * Rp, o.m.size * Rp, o.axis, t, null); }
    drawBody(sys, cx, cy, Rp, axis, t, sys.rings);
    if (sys.showOrbits && moons.length) {
      gl.useProgram(OP.p); gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform2f(OP.u.uRes, RW, RH); gl.uniform2f(OP.u.uCenter, cx, cy); gl.uniform1f(OP.u.uRpx, Rp);
      gl.uniform3f(OP.u.uCol, 0.55, 0.62, 0.72);
      for (const o of moons) { gl.uniform1f(OP.u.uExt, o.m.orbit * 1.04); gl.uniform3fv(OP.u.uM, o.n); gl.uniform1f(OP.u.uRo, o.m.orbit); draw(); }
      gl.useProgram(BP.p); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    for (const o of moons) if (o.p[2] >= 0) drawBody(o.m, cx + o.p[0] * Rp, cy + o.p[1] * Rp, o.m.size * Rp, o.axis, t, null);
  }
  function setCommon(prog) {
    const u = prog.u, f = frameCtx;
    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform3fv(u.uSun, f.sv); gl.uniform3fv(u.uSunCol, f.sunCol); gl.uniform3fv(u.uAmb, f.amb);
  }
  function systemExtent(sys) {
    let e = sys.rings.on ? Math.max(1.3, sys.rings.outer) : 1.3;
    for (const m of sys.moons) e = Math.max(e, (m.orbit + m.size) * 0.8);
    return e;
  }
  function frame(now) {
    const t = (now - t0) / 1000;
    const star = STARS[state.star], sv = sunVec(), sl = Math.hypot(sv[0], sv[1]) || 1;
    frameCtx = { sv, sunCol: lin(star.col), amb: star.amb };
    const RW = canvas.width, RH = canvas.height;
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.f); gl.viewport(0, 0, RW, RH);
    gl.disable(gl.BLEND);
    gl.useProgram(P.bg.p);
    gl.uniform2f(P.bg.u.uRes, RW, RH); gl.uniform1f(P.bg.u.uTime, t);
    gl.uniform3fv(P.bg.u.uStar, star.col); gl.uniform3fv(P.bg.u.uNeb, star.neb);
    gl.uniform2f(P.bg.u.uSunDir, sv[0] / sl, sv[1] / sl); gl.uniform2f(P.bg.u.uOff, 0, 0);
    draw();
    gl.enable(gl.BLEND);
    for (const c of cells) {
      const sys = systems[c.planet]; if (!sys) continue;
      const fill = state.planetFocus >= 0 ? 0.5 : 0.47;
      const Rp = c.cell * fill / systemExtent(sys) * dpr;
      drawSystem(sys, c.cx * dpr, (H - c.cy) * dpr, Rp, t + c.planet * 13.7);
    }
    gl.disable(gl.BLEND);
    postProcess();
  }

  // ---------- builder panel ----------
  const pct = v => Math.round(v * 100) + '%', deg = v => Math.round(v) + '°', x2 = v => v.toFixed(2) + '×';
  const SL = [
    ['sea', 'Sea level', 0, 0.8, 0.01, v => v < 0.02 ? 'None' : pct(v), 'rock'],
    ['cloud', 'Clouds', 0, 1, 0.01, pct], ['ice', 'Ice caps', 0, 1, 0.01, pct, 'rock'], ['crater', 'Craters', 0, 1, 0.01, pct, 'rock'],
    ['lava', 'Molten', 0, 1, 0.01, pct], ['city', 'City lights', 0, 1, 0.01, pct, 'rock'], ['storm', 'Storm', 0, 1, 0.01, pct, 'gas'],
    ['atm', 'Atmosphere', 0, 1.5, 0.01, pct], ['freq', 'Terrain scale', 1, 5, 0.05, v => v.toFixed(1), 'rock'], ['spin', 'Spin', 0, 1, 0.01, pct],
    ['tilt', 'Axial tilt', 0, 88, 1, deg], ['axisAngle', 'Axis angle', -180, 180, 1, deg]
  ];
  const RSL = [['inner', 'Inner edge', 1.1, 2.6, 0.01, x2], ['outer', 'Outer edge', 1.3, 3.6, 0.01, x2], ['density', 'Density', 0, 1, 0.01, pct]];
  function sliderRow(id, label, lo, hi, step) {
    return `<label class="slider" for="${id}" data-row="${id}">${label} <input id="${id}" type="range" min="${lo}" max="${hi}" step="${step}"><output id="${id}-v"></output></label>`;
  }
  $('pl-sliders').innerHTML = SL.map(s => sliderRow('pl-' + s[0], s[1], s[2], s[3], s[4])).join('');
  $('pl-ring-sliders').innerHTML = RSL.map(s => sliderRow('pl-r' + s[0], s[1], s[2], s[3], s[4])).join('');
  $('pl-palette').innerHTML = Object.keys(PAL).map(k => `<option value="${k}">${PAL[k].label}</option>`).join('');
  $('pl-ringstyle').innerHTML = Object.keys(RINGS).map(k => `<option value="${k}">${k[0].toUpperCase() + k.slice(1)}</option>`).join('');
  const cur = () => systems[state.planetFocus];
  function syncPanel() {
    const sys = cur();
    $('pl-editor').hidden = !sys; $('pl-gridnote').hidden = !!sys;
    if (!sys) return;
    const gas = PAL[sys.palette].gas;
    $('pl-name').textContent = sys.name;
    $('pl-kind').textContent = PAL[sys.palette].label + (sys.rings.on ? ' · ringed' : '') + (sys.moons.length ? ` · ${sys.moons.length} moon${sys.moons.length > 1 ? 's' : ''}` : '');
    $('pl-palette').value = sys.palette;
    for (const s of SL) {
      const el = $('pl-' + s[0]); el.value = sys[s[0]] || 0; $('pl-' + s[0] + '-v').textContent = s[5](+el.value);
      el.closest('[data-row]').hidden = (s[6] === 'rock' && gas) || (s[6] === 'gas' && !gas);
    }
    $('pl-rings').checked = sys.rings.on; $('pl-ringstyle').value = sys.rings.style; $('pl-ring-body').hidden = !sys.rings.on;
    for (const s of RSL) { const el = $('pl-r' + s[0]); el.value = sys.rings[s[0]]; $('pl-r' + s[0] + '-v').textContent = s[5](+el.value); }
    $('pl-moons').value = sys.moons.length; $('pl-moons-v').textContent = String(sys.moons.length);
    $('pl-orbits').checked = sys.showOrbits;
    $('pl-json').textContent = JSON.stringify(sys, (k, v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v, 1);
  }
  const touch = () => { const sys = cur(); if (sys) $('pl-json').textContent = JSON.stringify(sys, (k, v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v, 1); };
  for (const s of SL) $('pl-' + s[0]).addEventListener('input', e => { const sys = cur(); if (!sys) return; sys[s[0]] = +e.target.value; $('pl-' + s[0] + '-v').textContent = s[5](+e.target.value); touch(); });
  for (const s of RSL) $('pl-r' + s[0]).addEventListener('input', e => {
    const sys = cur(); if (!sys) return; sys.rings[s[0]] = +e.target.value;
    if (sys.rings.outer < sys.rings.inner + 0.12) { if (s[0] === 'inner') sys.rings.outer = sys.rings.inner + 0.12; else sys.rings.inner = Math.max(1.1, sys.rings.outer - 0.12); }
    pushMoonsOut(sys); syncPanel();
  });
  function pushMoonsOut(sys) { const base = sys.rings.on ? sys.rings.outer + 0.45 : 1.7; sys.moons.forEach((m, k) => { m.orbit = Math.max(m.orbit, base + k * 0.5); }); fixMoonSpeeds(sys); }
  $('pl-palette').addEventListener('change', e => { const sys = cur(); if (!sys) return; applyPalette(sys, e.target.value); syncPanel(); });
  $('pl-rings').addEventListener('change', e => { const sys = cur(); if (!sys) return; sys.rings.on = e.target.checked; pushMoonsOut(sys); syncPanel(); });
  $('pl-ringstyle').addEventListener('change', e => { const sys = cur(); if (!sys) return; sys.rings.style = e.target.value; touch(); });
  $('pl-moons').addEventListener('input', e => {
    const sys = cur(); if (!sys) return; const n = +e.target.value, r = rngOf(sys.name + n + Math.random());
    while (sys.moons.length > n) sys.moons.pop();
    while (sys.moons.length < n) { const m = makeMoon(r, sys.moons.length, sys); m.dir = 1; sys.moons.push(m); }
    pushMoonsOut(sys); syncPanel();
  });
  $('pl-orbits').addEventListener('change', e => { const sys = cur(); if (sys) { sys.showOrbits = e.target.checked; touch(); } });
  $('pl-random').addEventListener('click', () => { if (state.planetFocus < 0) return; systems[state.planetFocus] = generate(state.planetSeed + ':' + state.planetFocus + ':' + Math.random()); syncPanel(); layout(); });
  $('pl-newset').addEventListener('click', () => { state.planetSeed = 'set-' + Math.floor(Math.random() * 1e6); newSet(); state.planetFocus = -1; syncPanel(); layout(); });
  $('pl-back').addEventListener('click', () => { state.planetFocus = -1; syncPanel(); layout(); });

  return {
    frame, systems: () => systems,
    focus: k => { state.planetFocus = k; syncPanel(); layout(); },
    sync: syncPanel,
    label: k => { const s = systems[k]; return s ? { name: s.name, kind: PAL[s.palette].label } : null; }
  };
})(); } catch (e) { PLAN_ERR = String(e.message || e); console.error(e); }
