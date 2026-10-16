// ======================= STARS =======================
// The twelve star classes (the schema's star.class, the Book's "one of 12 classes"), shared by the game, its debug
// screen's Suns tab and the tools: each class's look (the lab's old Suns presets), its light, and its game numbers
// (radius, well, and for the exotics a hazard zone); a star's full look from its system file entry; and the kit
// that draws one. Stars are analytic spheres with limb darkening, Worley granulation, spots, corona streamers,
// chromosphere and prominences; pulsars add beams from a tilted magnetic axis; black holes are ray-marched through
// Schwarzschild bending, with a Doppler-beamed accretion disk and a lensed copy of the sky behind. The lens flare is a
// screen pass (the Suns tab draws it; the game does not).
//
// A class's game numbers: `radius` (m: a black hole's is its horizon), `gravity` (the well's strength, 40 a full
// one), `reach` (how many radii the well reaches; 0 the core's usual 3), `hazard` (m: the zone where radiation wears
// a hull down, core/src/service.rs; 0 none) and `rad` (the share of a sound hull lost a second at its middle). A
// system file can set radius, gravity and hazard per star, and override any look parameter.
const STAR_CLASSES = {
  yellow:        { label: 'Yellow dwarf', cls: 'G', kind: 'star', temp: 5800, radius: 1, bright: 6, gran: 1, cell: 7, spots: .35, corona: 1, streamers: .8, prom: .6, limb: .6, flare: 1, spikes: 6, anam: .2,
                   game: { radius: 2400, gravity: 55 }, light: () => STARS.sol },
  orange:        { label: 'Orange dwarf', cls: 'K', kind: 'star', temp: 4400, radius: .85, bright: 5, gran: 1, cell: 7, spots: .45, corona: .8, streamers: .7, prom: .5, limb: .65, flare: .8, spikes: 6, anam: .15,
                   game: { radius: 2100, gravity: 55 }, light: () => STARS.orange },
  'red-dwarf':   { label: 'Red dwarf', cls: 'M', kind: 'star', temp: 3100, radius: .55, bright: 4, gran: .8, cell: 6, spots: .7, corona: .6, streamers: .5, prom: .9, limb: .7, flare: .55, spikes: 4, anam: .1,
                   game: { radius: 1400, gravity: 40 }, light: () => STARS.red },
  'brown-dwarf': { label: 'Brown dwarf', cls: 'L/T', kind: 'star', temp: 1500, radius: .5, bright: 1.6, gran: .3, cell: 4, spots: 0, corona: .25, streamers: .1, prom: 0, limb: .4, bands: .8, flare: .15, spikes: 4, anam: 0,
                   game: { radius: 1100, gravity: 35 }, light: { name: 'Brown dwarf', col: [0.78, 0.40, 0.28], amb: [0.036, 0.022, 0.024], neb: [0.16, 0.06, 0.06] } },
  'red-giant':   { label: 'Red giant', cls: 'K/M III', kind: 'star', temp: 3500, radius: 2.6, bright: 4.5, gran: 1, cell: 2.2, spots: .2, corona: .9, streamers: .4, prom: .3, limb: .8, flare: .9, spikes: 6, anam: .15,
                   game: { radius: 5800, gravity: 50 }, light: { name: 'Red giant', col: [1.0, 0.64, 0.44], amb: [0.042, 0.028, 0.030], neb: [0.20, 0.09, 0.07] } },
  white:         { label: 'White giant', cls: 'A', kind: 'star', temp: 9200, radius: 1.8, bright: 7, gran: .5, cell: 5, spots: 0, corona: 1.2, streamers: .6, prom: .2, limb: .45, flare: 1.3, spikes: 8, anam: .35,
                   game: { radius: 3000, gravity: 60 }, light: () => STARS.white },
  'blue-giant':  { label: 'Blue supergiant', cls: 'O/B I', kind: 'star', temp: 26000, radius: 2.2, bright: 9, gran: .4, cell: 4, spots: 0, corona: 1.5, streamers: .9, prom: .2, limb: .4, flare: 1.7, spikes: 8, anam: .5,
                   game: { radius: 5200, gravity: 65 }, light: () => STARS.blue },
  'wolf-rayet':  { label: 'Wolf-Rayet', cls: 'WR', kind: 'star', temp: 38000, radius: .7, bright: 10, gran: .3, cell: 4, spots: 0, corona: 1.6, streamers: 1, prom: 0, limb: .35, shell: 1, flare: 1.5, spikes: 6, anam: .4,
                   game: { radius: 1800, gravity: 65 }, light: { name: 'Wolf-Rayet', col: [0.68, 0.80, 1.0], amb: [0.024, 0.034, 0.058], neb: [0.18, 0.08, 0.16] } },
  'white-dwarf': { label: 'White dwarf', cls: 'D', kind: 'star', temp: 18000, radius: .12, bright: 12, gran: 0, cell: 4, spots: 0, corona: 1.4, streamers: .2, prom: 0, limb: .3, flare: 1.2, spikes: 6, anam: .3,
                   game: { radius: 360, gravity: 70, reach: 12 }, light: { name: 'White dwarf', col: [0.84, 0.89, 1.0], amb: [0.022, 0.026, 0.040], neb: [0.06, 0.09, 0.16] } },
  pulsar:        { label: 'Pulsar', cls: 'NS', kind: 'pulsar', temp: 40000, radius: .07, bright: 14, gran: 0, cell: 4, spots: 0, corona: 1, streamers: 0, prom: 0, limb: .2, beamTilt: 55, beamRate: 1.6, beamW: .35, nebula: .8, flare: 1.1, spikes: 4, anam: .5,
                   game: { radius: 200, gravity: 80, reach: 24, hazard: 9000, rad: 0.08 }, light: { name: 'Pulsar', col: [0.72, 0.80, 1.0], amb: [0.020, 0.026, 0.044], neb: [0.08, 0.12, 0.26] } },
  'black-hole':  { label: 'Black hole', cls: 'BH', kind: 'hole', diskTilt: 78, diskAngle: 12, diskIn: 3, diskOut: 11, diskTemp: 7000, diskB: 1.4, jets: 0, flare: .25, spikes: 4, anam: .3,
                   game: { radius: 500, gravity: 120, reach: 28, hazard: 7500, rad: 0.12 }, light: { name: 'Black hole', col: [1.0, 0.82, 0.64], amb: [0.024, 0.020, 0.022], neb: [0.12, 0.07, 0.05] } },
  quasar:        { label: 'Quasar', cls: 'AGN', kind: 'hole', diskTilt: 70, diskAngle: -25, diskIn: 3, diskOut: 13, diskTemp: 16000, diskB: 2.6, jets: 1.2, flare: 1.8, spikes: 8, anam: .7,
                   game: { radius: 600, gravity: 120, reach: 28, hazard: 11000, rad: 0.15 }, light: { name: 'Quasar', col: [0.80, 0.86, 1.0], amb: [0.026, 0.030, 0.050], neb: [0.10, 0.12, 0.26] } }
};
const STAR_ORDER = Object.keys(STAR_CLASSES);
// every look parameter: [min, max, step, format, the kinds it applies to] (the schema's star.look bounds)
const starPct = v => Math.round(v * 100) + '%';
const STAR_RANGES = {
  temp: [1000, 40000, 50, v => Math.round(v) + ' K', 'star pulsar'], radius: [.05, 3, .01, v => v.toFixed(2) + '×', 'star'],
  bright: [.5, 16, .1, v => v.toFixed(1), 'star pulsar'], gran: [0, 1, .01, starPct, 'star'], cell: [1.5, 10, .1, v => v.toFixed(1), 'star'],
  spots: [0, 1, .01, starPct, 'star'], corona: [0, 2, .01, starPct, 'star pulsar'], streamers: [0, 1, .01, starPct, 'star'], prom: [0, 1.2, .01, starPct, 'star'],
  limb: [0, 1, .01, starPct, 'star'], bands: [0, 1, .01, starPct, 'star'], shell: [0, 1.5, .01, starPct, 'star'],
  beamTilt: [5, 90, 1, v => Math.round(v) + '°', 'pulsar'], beamRate: [.1, 6, .05, v => v.toFixed(2) + ' Hz', 'pulsar'], beamW: [.1, 1, .01, v => v.toFixed(2), 'pulsar'], nebula: [0, 1.5, .01, starPct, 'pulsar'],
  diskTilt: [0, 89, 1, v => Math.round(v) + '°', 'hole'], diskAngle: [-90, 90, 1, v => Math.round(v) + '°', 'hole'], diskIn: [1.6, 6, .05, v => v.toFixed(1) + ' Rs', 'hole'],
  diskOut: [5, 18, .1, v => v.toFixed(1) + ' Rs', 'hole'], diskTemp: [2500, 30000, 100, v => Math.round(v) + ' K', 'hole'], diskB: [0, 4, .01, v => v.toFixed(2), 'hole'], jets: [0, 2, .01, starPct, 'hole'],
  flare: [0, 2.5, .01, starPct, 'star pulsar hole'], spikes: [4, 10, 2, v => String(v), 'star pulsar hole'], anam: [0, 1, .01, starPct, 'star pulsar hole']
};
const STAR_LABELS = { temp: 'Temperature', radius: 'Drawn size', bright: 'Brightness', gran: 'Granulation', cell: 'Cell scale', spots: 'Spots', corona: 'Corona', streamers: 'Streamers', prom: 'Prominences', limb: 'Limb darkening', bands: 'Bands', shell: 'Ejecta shell', beamTilt: 'Beam tilt', beamRate: 'Spin rate', beamW: 'Beam width', nebula: 'Wind nebula', diskTilt: 'Disk tilt', diskAngle: 'Disk angle', diskIn: 'Disk inner', diskOut: 'Disk outer', diskTemp: 'Disk temperature', diskB: 'Disk brightness', jets: 'Jets', flare: 'Lens flare', spikes: 'Diffraction spikes', anam: 'Anamorphic streak' };
// whether look parameter k applies to class c (bands and the shell only where the class has them)
const starApplies = (k, c) => { const T = STAR_CLASSES[c], R = STAR_RANGES[k]; return R[4].split(' ').includes(T.kind) && (!(k === 'bands' || k === 'shell') || T[k] != null); };

// Blackbody colour (Tanner Helland's fit), linear RGB normalised to its largest channel
function blackbody(T) {
  T = Math.max(1000, Math.min(40000, T)) / 100;
  const r = T <= 66 ? 255 : 329.698727446 * Math.pow(T - 60, -0.1332047592);
  const g = T <= 66 ? 99.4708025861 * Math.log(T) - 161.1195681661 : 288.1221695283 * Math.pow(T - 60, -0.0755148492);
  const b = T >= 66 ? 255 : T <= 19 ? 0 : 138.5177312231 * Math.log(T - 10) - 305.0447927307;
  const c = [r, g, b].map(v => Math.pow(Math.max(0, Math.min(255, v)) / 255, 2.2));
  const m = Math.max(...c, 1e-4); return c.map(v => v / m);
}
function starRng(s) { let a = 0; for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 2654435761) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// A star's full look from its system file entry ({ class, seed, look }, every field filled by the schema clamp): the
// class's preset, varied a little by the seed (temperature, size, spots, streamers, tilts), then the entry's own
// look values on top. The result is what the kit draws.
function starLook(entry) {
  const c = STAR_CLASSES[entry.class] ? entry.class : 'yellow', T = STAR_CLASSES[c], seed = entry.seed == null ? 1 : entry.seed, r = starRng(c + ':' + seed);
  const s = { class: c, seed: Math.round(r() * 1000) / 10, rot: .2 + r() * .3 };
  for (const k in STAR_RANGES) if (T[k] != null) s[k] = T[k];
  const j = (k, a) => { if (s[k] != null) { const R = STAR_RANGES[k]; s[k] = Math.max(R[0], Math.min(R[1], s[k] * (1 + (r() * 2 - 1) * a))); } };
  j('temp', .08); j('radius', .1); j('spots', .3); j('streamers', .2); j('diskTilt', .06); j('beamTilt', .2);
  if (s.diskAngle != null) s.diskAngle += (r() * 2 - 1) * 15;
  for (const [k, v] of Object.entries(entry.look || {})) if (STAR_RANGES[k] && starApplies(k, c)) s[k] = v;
  return s;
}
// A star's light: the colour it lights worlds and ships with, the ambient fill and the sky's nebula tint.
const starLight = c => { const L = (STAR_CLASSES[c] || STAR_CLASSES.yellow).light; return typeof L === 'function' ? L() : L; };
// A star's game numbers, the class's with the entry's own radius, gravity and hazard on top.
function starGame(entry) {
  const G = (STAR_CLASSES[entry.class] || STAR_CLASSES.yellow).game;
  return { radius: entry.radius ?? G.radius, gravity: entry.gravity ?? G.gravity, reach: G.reach || 0, hazard: entry.hazard ?? (G.hazard || 0), rad: G.rad || 0 };
}
// How a star of game radius r (m) is framed at ss pixels a metre: its corona's reach in radii (glowR; a compact star's
// glow is far larger than its disc), and the quad's extent in radii (ext: a pulsar's beams reach its hazard zone's
// edge, a black hole's disk and jets their own size).
function starFrame(s, r, hazard) {
  const T = STAR_CLASSES[s.class], glowR = Math.max(0.6, 500 / r);
  const ext = T.kind === 'pulsar' ? Math.max(4, (hazard || 9000) / r) : T.kind === 'hole' ? (s.jets > 0.01 ? 26 : 16) : Math.min(40, Math.max(4, s.shell > 0.01 ? 3.6 : 1 + glowR * 4.5));
  return { glowR, ext };
}

// The kit's shaders, built when asked (they need the shared noise and sky chunks, shaders.js, which Node's tools lack)
const STAR_SHADERS = () => ({
  vs: `#version 300 es
in vec2 aPos; uniform vec2 uRes, uCenter; uniform float uRpx, uExt; out vec2 vQ;
void main(){ vQ = aPos*uExt; vec2 w = uCenter + aPos*uExt*uRpx; gl_Position = vec4(w/uRes*2.-1., 0., 1.); }`,

  fs: `#version 300 es
precision highp float;
in vec2 vQ; out vec4 o;
uniform vec3 uCol, uChrom, uBeam, uShellCol;
uniform float uBright, uGran, uCell, uSpots, uCorona, uStreamers, uProm, uLimb, uRot, uSeed, uTime, uPx, uBands, uGlowR, uShell, uBeamOn, uBeamW, uPulse, uNeb, uGain;
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
  o = vec4((col*a + glow*(1. - a*.9))*uGain, a);
}`,

  hole: `#version 300 es
precision highp float;
in vec2 vQ; out vec4 o;
${SKY}
uniform vec3 uN, uHot, uCool, uJetCol;
uniform float uIn, uOut, uDiskB, uJets, uExt, uPxPerRs, uBHSeed, uGain;
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
  vec3 col = acc*uGain + T*bg;
  if (uJets > .01) {
    vec2 j2 = N.xy; float jl = length(j2); vec2 jd = jl > 1e-3 ? j2/jl : vec2(0., 1.);
    float al = dot(q, jd); vec2 pq = q - jd*al;
    float w = .45 + abs(al)*.06;
    float knots = .6 + .8*fbm(vec2(abs(al)*.5 - uTime*2.*sign(al), uBHSeed));
    float jet = exp(-dot(pq,pq)/(w*w))*exp(-abs(al)/(uExt*.45))*knots*smoothstep(1.2, 3., abs(al));
    float side = al*sign(N.z + 1e-4) > 0. ? 1.7 : .6;
    col += (uJetCol*jet*uJets*side*(jl*.8 + .2)*3. + uJetCol*uJets*exp(-rq/1.5)*2.*(1. - jl))*uGain;
  }
  float fade = 1. - smoothstep(uExt*.8, uExt*.98, rq);
  o = vec4(col*fade, fade);
}`,

  flare: `#version 300 es
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
}`
});

// The kit: draws a star's look (starLook) into the bound target, in its pixels (y up). o: { res: [w, h], cx, cy
// (centre), rpx (pixels per star radius: a black hole's horizon), glowR and ext (radii; starFrame), t (seconds),
// gain (brightness; 1 the lab's), sky: { star, neb, sd: [x, y], off: [x, y] } (the background's uniforms, which a
// black hole lenses) }. Returns { col, k } for the lens flare. Blending is the caller's: premultiplied over.
function makeStarKit(gl, compile, draw) {
  const S = STAR_SHADERS(), SP = compile(S.vs, S.fs), BH = compile(S.vs, S.hole), FL = compile(FS_VS, S.flare);
  const vecFromTilt = (tilt, ang) => { const t = tilt * Math.PI / 180, a = (ang + 90) * Math.PI / 180; return [Math.sin(t) * Math.cos(a), Math.sin(t) * Math.sin(a), Math.cos(t)]; };
  function beamDir(s, t) {
    const A = vecFromTilt(20, 30), ref = Math.abs(A[2]) < .95 ? [0, 0, 1] : [1, 0, 0];
    let U = [A[1] * ref[2] - A[2] * ref[1], A[2] * ref[0] - A[0] * ref[2], A[0] * ref[1] - A[1] * ref[0]]; const ul = Math.hypot(...U); U = U.map(v => v / ul);
    const V = [A[1] * U[2] - A[2] * U[1], A[2] * U[0] - A[0] * U[2], A[0] * U[1] - A[1] * U[0]];
    const tl = s.beamTilt * Math.PI / 180, ph = t * s.beamRate * Math.PI * 2;
    return [0, 1, 2].map(k => Math.cos(tl) * A[k] + Math.sin(tl) * (Math.cos(ph) * U[k] + Math.sin(ph) * V[k]));
  }
  const cache = new WeakMap(); // a look's colours, worked out once
  const colours = s => { let c = cache.get(s); if (!c || c.temp !== s.temp || c.diskTemp !== s.diskTemp) cache.set(s, c = { temp: s.temp, diskTemp: s.diskTemp, col: blackbody(s.temp || 5800), hot: blackbody((s.diskTemp || 7000) * 1.6), cool: blackbody((s.diskTemp || 7000) * 0.45).map(v => v * 0.5), disk: blackbody(s.diskTemp || 7000), jet: blackbody(30000), chrom: (s.temp || 5800) < 7000 ? [1, 0.25, 0.3] : blackbody((s.temp || 5800) * 1.3) }); return c; };
  function star(s, o) {
    const T = STAR_CLASSES[s.class], C = colours(s), gain = o.gain ?? 1, [RW, RH] = o.res;
    if (T.kind === 'hole') {
      const u = BH.u; gl.useProgram(BH.p);
      gl.uniform2f(u.uRes, RW, RH); gl.uniform1f(u.uTime, o.t);
      gl.uniform3fv(u.uStar, o.sky.star); gl.uniform3fv(u.uNeb, o.sky.neb); gl.uniform2f(u.uSunDir, o.sky.sd[0], o.sky.sd[1]); gl.uniform2f(u.uOff, o.sky.off[0], o.sky.off[1]);
      gl.uniform2f(u.uCenter, o.cx, o.cy); gl.uniform1f(u.uRpx, o.rpx); gl.uniform1f(u.uExt, o.ext);
      gl.uniform2f(u.uCenterPx, o.cx, o.cy); gl.uniform1f(u.uPxPerRs, o.rpx);
      gl.uniform3fv(u.uN, vecFromTilt(s.diskTilt, s.diskAngle));
      gl.uniform1f(u.uIn, s.diskIn); gl.uniform1f(u.uOut, Math.max(s.diskOut, s.diskIn + 1)); gl.uniform1f(u.uDiskB, s.diskB); gl.uniform1f(u.uJets, s.jets || 0); gl.uniform1f(u.uBHSeed, s.seed);
      gl.uniform3fv(u.uHot, C.hot); gl.uniform3fv(u.uCool, C.cool); gl.uniform3fv(u.uJetCol, C.jet); gl.uniform1f(u.uGain, gain);
      draw();
      return { col: C.disk, k: s.flare * (0.6 + s.diskB * 0.3 + (s.jets || 0) * 0.6) };
    }
    const u = SP.u; gl.useProgram(SP.p);
    let pulse = 0, beam = [0, 0, 0];
    if (T.kind === 'pulsar') { beam = beamDir(s, o.t); pulse = Math.pow(Math.abs(beam[2]), 30); }
    gl.uniform2f(u.uRes, RW, RH); gl.uniform2f(u.uCenter, o.cx, o.cy); gl.uniform1f(u.uRpx, o.rpx); gl.uniform1f(u.uExt, o.ext);
    gl.uniform3fv(u.uCol, C.col); gl.uniform3fv(u.uChrom, C.chrom); gl.uniform3fv(u.uShellCol, [0.9, 0.35, 0.55]);
    gl.uniform1f(u.uBright, s.bright); gl.uniform1f(u.uGran, s.gran || 0); gl.uniform1f(u.uCell, s.cell || 5); gl.uniform1f(u.uSpots, s.spots || 0);
    gl.uniform1f(u.uCorona, s.corona || 0); gl.uniform1f(u.uStreamers, s.streamers || 0); gl.uniform1f(u.uProm, s.prom || 0); gl.uniform1f(u.uLimb, s.limb || 0);
    gl.uniform1f(u.uBands, s.bands || 0); gl.uniform1f(u.uShell, s.shell || 0);
    gl.uniform1f(u.uRot, o.t * (s.rot || 0.2) * 0.15); gl.uniform1f(u.uSeed, s.seed); gl.uniform1f(u.uTime, o.t); gl.uniform1f(u.uPx, 1 / Math.max(o.rpx, 1e-3)); gl.uniform1f(u.uGlowR, o.glowR);
    gl.uniform1f(u.uBeamOn, T.kind === 'pulsar' ? 1 : 0); gl.uniform3fv(u.uBeam, beam); gl.uniform1f(u.uBeamW, (s.beamW || 0.3) * o.glowR); gl.uniform1f(u.uPulse, pulse); gl.uniform1f(u.uNeb, s.nebula || 0);
    gl.uniform1f(u.uGain, gain);
    draw();
    return { col: C.col, k: s.flare * (0.5 + s.bright / 10) * (1 + pulse * 2) };
  }
  // a lens flare for a star drawn at (x, y): info from `star`, scale the flare's size in pixels, ghosts 0..1
  function flare(s, x, y, info, scale, ghosts, t, res) {
    const u = FL.u; gl.useProgram(FL.p);
    gl.uniform2f(u.uRes, res[0], res[1]); gl.uniform2f(u.uS, x, y);
    gl.uniform3fv(u.uCol, info.col); gl.uniform1f(u.uK, info.k);
    gl.uniform1f(u.uSpikes, s.spikes || 6); gl.uniform1f(u.uGhosts, ghosts); gl.uniform1f(u.uAnam, s.anam || 0);
    gl.uniform1f(u.uScale, scale); gl.uniform1f(u.uSeed, s.seed); gl.uniform1f(u.uTime, t);
    draw();
  }
  return { star, flare };
}

if (typeof module !== 'undefined') module.exports = { STAR_CLASSES, STAR_ORDER, STAR_RANGES, starApplies, starLook, starGame };
