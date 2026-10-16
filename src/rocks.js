// ======================= ROCKS =======================
// Asteroids, shared by the lab's Asteroids tab and the game's belts and fields: ten compositions, a rock's shape from
// its type and a seed, and one instanced shader that sphere-traces each rock on its own quad. A rock is an ellipsoid
// displaced by low-frequency noise for the silhouette, with craters, grit and ore veins applied as shading-only
// detail, soft self-shadowing, and a tumble about its own axis. The vertex shader works in world space (WORLD_POS);
// the lab draws in device pixels by giving it a camera at the canvas centre and a scale of 1.
const ROCK_TYPES = {
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
const ROCK_ORDER = Object.keys(ROCK_TYPES);
// a seeded generator from a string (the lab's sets and the game's belts both use it)
function rockRng(s) { let a = 0; for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 2654435761) >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// One rock of a type: its diameter (m; 15 m to 3 km, small ones commonest), shape, surface and tumble. `r` draws
// the numbers (a fresh generator from the type and seed if omitted).
function makeRock(type, seed, r) {
  r = r || rockRng(type + ':' + seed);
  const T = ROCK_TYPES[type], L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const size = Math.round(15 * Math.pow(200, Math.pow(r(), 1.3)));
  const ax = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1]; const al = Math.hypot(...ax) || 1;
  return {
    type, name: `${L[Math.floor(r() * L.length)]}${L[Math.floor(r() * L.length)]}-${Math.floor(100 + r() * 9000)}`, seed: Math.round(r() * 1000) / 10, size,
    sx: 0.75 + r() * 0.75, sy: 0.6 + r() * 0.45, sz: 0.55 + r() * 0.4, lump: 0.2 + r() * 0.45, freq: 1.6 + r() * 1.6,
    crater: T.crater * (0.7 + r() * 0.5), ore: T.ore, frost: T.frost, tumble: 0.15 + r() * 0.5,
    axis: ax.map(v => v / al), phase: r() * 6.283
  };
}
// how far a rock's surface can reach, in its own units (radius 1 before scaling and lumps)
const rockExt = a => Math.max(a.sx, a.sy, a.sz) * (1 + a.lump * 0.8) + 0.05;

// One instance: iA x, y (world), metres per rock unit (half the diameter), tumble phase; iB the shape's scale x, y, z
// and lumpiness; iC roughness scale, craters, seed, tumble rate; iD the tumble axis and the type's index; iE ore
// veins and frost. The type's colours and shine come from uniform tables. Light: uSun, or with uStarLit set, from
// the star at uStar, raised out of the plane (as the game lights everything).
const ROCK_VS = `#version 300 es
in vec2 aPos; in vec4 iA; in vec4 iB; in vec4 iC; in vec4 iD; in vec2 iE;
${WORLD_POS}
uniform float uTime, uStarLit; uniform vec3 uSun; uniform vec2 uStar;
uniform vec3 uCol[30]; uniform vec4 uOreSpec[10];
out vec2 vQ; flat out mat3 vRot; flat out vec4 vS; flat out vec3 vSun; flat out vec4 vP; flat out vec3 vM;
flat out vec3 vC1; flat out vec3 vC2; flat out vec3 vC3; flat out vec3 vOre;
void main(){
  float ext = max(max(iB.x, iB.y), iB.z)*(1. + iB.w*.8) + .05;
  vQ = aPos*ext; vS = vec4(iB.xyz, ext); vP = vec4(iB.w, iC.x, iC.y, iC.z);
  int k = int(iD.w + .5); vC1 = uCol[k*3]; vC2 = uCol[k*3 + 1]; vC3 = uCol[k*3 + 2]; vOre = uOreSpec[k].rgb; vM = vec3(iE, uOreSpec[k].a);
  // the orientation (object to view), as the transpose of the rotation about the axis
  vec3 a = iD.xyz; float an = iA.w + uTime*iC.w*.6, c = cos(an), s = sin(an), C = 1. - c;
  vRot = mat3(c + a.x*a.x*C, a.x*a.y*C - a.z*s, a.x*a.z*C + a.y*s,
              a.y*a.x*C + a.z*s, c + a.y*a.y*C, a.y*a.z*C - a.x*s,
              a.z*a.x*C - a.y*s, a.z*a.y*C + a.x*s, c + a.z*a.z*C);
  vec2 d = uStar - iA.xy; float l = length(d);
  vSun = uStarLit > .5 ? normalize(l > 1. ? vec3(d/l, .45) : vec3(0., 0., 1.)) : uSun;
  gl_Position = clipOf(iA.xy + vQ*iA.z);
}`;
const ROCK_FS = `#version 300 es
precision highp float;
in vec2 vQ; flat in mat3 vRot; flat in vec4 vS; flat in vec3 vSun; flat in vec4 vP; flat in vec3 vM;
flat in vec3 vC1; flat in vec3 vC2; flat in vec3 vC3; flat in vec3 vOre;
out vec4 o;
uniform vec3 uSunCol, uAmb;
${NOISE3}
float n4(vec3 p){ float s=0., a=.5; for(int i=0;i<4;i++){ s+=a*n3(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=.5; } return s/.9375; }
float shape(vec3 p){
  vec3 q = p/vS.xyz;
  float base = (length(q) - 1.)*min(min(vS.x, vS.y), vS.z);
  return base - (n3(p*1.1 + vP.w) - .5)*vP.x*.9 - (n4(p*vP.y + vP.w*1.3) - .5)*vP.x*.45;
}
float detail(vec3 p){
  float h = (fbm3(p*vP.y*3. + vP.w) - .5)*.05;
  if (vP.z > .01) {
    vec2 w = worley3(p*vP.y*1.1 + vP.w);
    h += (smoothstep(.38,.46,w.x)*(1.-smoothstep(.46,.6,w.x))*.05 - (1.-smoothstep(0.,.45,w.x))*.12)*vP.z;
    vec2 w2 = worley3(p*vP.y*3.2 + vP.w*2.);
    h += (smoothstep(.36,.42,w2.x)*(1.-smoothstep(.42,.5,w2.x))*.02 - (1.-smoothstep(0.,.36,w2.x))*.04)*vP.z;
  }
  return h;
}
float field(vec3 p){ return shape(p) - detail(p); }
void main(){
  vec2 q = vQ; float ext = vS.w, seed = vP.w, freq = vP.y;
  if (length(q) > ext) discard;
  vec3 ro = vRot*vec3(q, 4.), rd = vRot*vec3(0., 0., -1.);
  float t = 4. - ext, hit = -1.;
  for (int i = 0; i < 80; i++) {
    float d = shape(ro + rd*t);
    if (d < .002) { hit = t; break; }
    t += d*.75;
    if (t > 4. + ext) break;
  }
  if (hit < 0.) discard;
  vec3 p = ro + rd*hit;
  vec2 e = vec2(.004, 0.);
  float f0 = field(p);
  vec3 nObj = normalize(vec3(field(p+e.xyy) - f0, field(p+e.yxy) - f0, field(p+e.yyx) - f0));
  vec3 N = normalize(transpose(vRot)*nObj);
  float cav = detail(p);
  float m = fbm3(p*freq*.7 + seed*3.);
  vec3 alb = mix(vC1, vC2, smoothstep(.35, .7, m));
  alb = mix(alb, vC3, smoothstep(.62, .85, fbm3(p*freq*2. + seed*5.))*.6);
  alb *= .78 + 3.5*clamp(cav + .04, -.05, .08);
  float frost = vM.y*smoothstep(.45, .65, n3(p*2.5 + seed*4.) + dot(N, vec3(0.,0.,1.))*.15);
  alb = mix(alb, vec3(.9,.95,1.), frost);
  float v = pow(1. - abs(n3(p*freq*2.4 + seed*7.)*2. - 1.), 14.)*vM.x;
  alb = mix(alb, vOre*.6, v*.7);
  alb = pow(alb, vec3(2.2));
  vec3 L = normalize(vSun);
  float dif = max(dot(N, L), 0.);
  float sh = 1.;
  { vec3 ld = vRot*L, lo = p + nObj*.02; float tt = .03;
    for (int i = 0; i < 20; i++) { float d = shape(lo + ld*tt); if (d < .001) { sh = .12; break; } sh = min(sh, .12 + .88*clamp(10.*d/tt, 0., 1.)); tt += max(d, .03); if (tt > ext*2.) break; } }
  vec3 Hh = normalize(L + vec3(0.,0.,1.));
  float spec = pow(max(dot(N, Hh), 0.), mix(10., 70., vM.z))*(vM.z*1.6 + frost*.6);
  vec3 col = alb*uSunCol*dif*sh*2.4 + uSunCol*spec*sh + alb*uAmb*2.2;
  col += vOre*v*2.2*(.6 + .4*sin(seed*3. + p.x*4.));
  col += uAmb*3.*pow(1. - max(N.z, 0.), 3.);
  o = vec4(col, 1.);
}`;
const ROCK_STRIDE = 18; // floats per instance

// The GL side: the program, the type tables, and an instance buffer for up to `cap` rocks. pack() writes rock `a`
// as instance n of `out` at (x, y) with `mpu` metres (or pixels) per rock unit; draw(out, n) draws n of them, after
// begin() has set the view (res, cam, scale), the time, the light (sun: a direction, or star: a position) and
// the star's colour and ambient.
function makeRockKit(gl, compile, quad, cap) {
  const prog = compile(ROCK_VS, ROCK_FS, { iA: 1, iB: 2, iC: 3, iD: 4, iE: 5 }), u = prog.u;
  const cols = new Float32Array(90), oreSpec = new Float32Array(40);
  ROCK_ORDER.forEach((k, i) => { const T = ROCK_TYPES[k]; T.cols.forEach((c, j) => cols.set(hexRGB(c), (i * 3 + j) * 3)); oreSpec.set([...lin(hexRGB(T.oreCol)), T.spec], i * 4); });
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, cap * ROCK_STRIDE * 4, gl.DYNAMIC_DRAW);
  [4, 4, 4, 4, 2].reduce((off, sz, k) => { gl.enableVertexAttribArray(k + 1); gl.vertexAttribPointer(k + 1, sz, gl.FLOAT, false, ROCK_STRIDE * 4, off * 4); gl.vertexAttribDivisor(k + 1, 1); return off + sz; }, 0);
  gl.bindVertexArray(null);
  const typeIndex = Object.fromEntries(ROCK_ORDER.map((k, i) => [k, i]));
  return {
    cap,
    pack(out, n, a, x, y, mpu) {
      const o = n * ROCK_STRIDE;
      out[o] = x; out[o + 1] = y; out[o + 2] = mpu; out[o + 3] = a.phase;
      out[o + 4] = a.sx; out[o + 5] = a.sy; out[o + 6] = a.sz; out[o + 7] = a.lump;
      out[o + 8] = a.freq; out[o + 9] = a.crater; out[o + 10] = a.seed; out[o + 11] = a.tumble;
      out[o + 12] = a.axis[0]; out[o + 13] = a.axis[1]; out[o + 14] = a.axis[2]; out[o + 15] = typeIndex[a.type];
      out[o + 16] = a.ore; out[o + 17] = a.frost;
    },
    begin(v) {
      gl.useProgram(prog.p);
      gl.uniform2f(u.uRes, v.res[0], v.res[1]); gl.uniform2f(u.uCam, v.cam[0], v.cam[1]); gl.uniform1f(u.uScale, v.scale);
      gl.uniform1f(u.uTime, v.time);
      gl.uniform1f(u.uStarLit, v.star ? 1 : 0);
      if (v.star) gl.uniform2f(u.uStar, v.star[0], v.star[1]); else gl.uniform3fv(u.uSun, v.sun);
      gl.uniform3fv(u.uSunCol, v.sunCol); gl.uniform3fv(u.uAmb, v.amb);
      gl.uniform3fv(u.uCol, cols); gl.uniform4fv(u.uOreSpec, oreSpec);
    },
    draw(out, n) {
      if (!n) return;
      if (n > cap) n = cap;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, out, 0, n * ROCK_STRIDE);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.bindVertexArray(null);
    }
  };
}
