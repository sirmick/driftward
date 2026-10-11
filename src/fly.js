// ======================= FLIGHT MODE =======================
// Simulation state is structure-of-arrays (typed arrays indexed by entity id).
// Rendering is instanced: one draw per ship type, one each for plumes, shields, bolts and particles.
const DERIVE = {
  ship: [
    ["in vec2 vQ; in vec2 vWorld; out vec4 o;", "in vec2 vQ; in vec2 vWorld; flat in float vAng; flat in float vThr; flat in float vDmg; out vec4 o;"],
    ["uniform float uAngle, uExtent, uHRange, uPxPerM, uTime, uThrottle, uDmax, uS;", "uniform float uExtent, uHRange, uTime, uDmax, uS;\n#define uAngle vAng\n#define uThrottle vThr\n#define uPxPerM 1.0"],
    ["uniform float uGloss, uSpecK, uWrap, uIrid, uRim, uShadow, uHover;", "uniform float uGloss, uSpecK, uWrap, uIrid, uRim, uShadow;\n#define uHover 0.0"],
    ["  o = vec4(col*A.a, A.a);\n}", "  col += vec3(1.,.42,.18)*vDmg*1.6;\n  o = vec4(col*A.a, A.a);\n}"]
  ],
  shield: [
    ["in vec2 vQ; in vec2 vWorld; out vec4 o;", "in vec2 vQ; flat in vec4 vH1; flat in vec4 vH2; flat in float vIdle; flat in float vSeed; out vec4 o;"],
    ["uniform float uExtent, uS, uDmax, uTime, uIdle, uStrength, uSeed;", "uniform float uExtent, uS, uDmax, uTime, uStrength;\n#define uIdle vIdle\n#define uSeed vSeed"],
    ["uniform vec4 uHits[8];", ""],
    ["for (int i=0; i<8; i++) {", "vec4 HH[2]; HH[0]=vH1; HH[1]=vH2;\n  for (int i=0; i<2; i++) {"],
    ["uHits[i]", "HH[i]", 1]
  ],
  plume: [
    ["uniform vec3 uCol, uCore; uniform float uTime, uSeed, uTurb, uDiamonds, uSputter, uPulse, uPower;", "flat in vec3 vCol; flat in vec3 vCore; flat in vec4 vP; flat in float vSeed; flat in float vPow; uniform float uTime;\n#define uCol vCol\n#define uCore vCore\n#define uSeed vSeed\n#define uTurb vP.x\n#define uDiamonds vP.y\n#define uSputter vP.z\n#define uPulse vP.w\n#define uPower vPow"]
  ]
};
function derive(src, list) {
  for (const [a, b, all] of list) { if (!src.includes(a)) throw new Error('shader derive failed: ' + a.slice(0, 50)); src = all ? src.split(a).join(b) : src.replace(a, b); }
  return src;
}
const WORLD_POS = `uniform vec2 uRes, uCam; uniform float uScale;
vec4 clipOf(vec2 w){ return vec4((w-uCam)*uScale/(uRes*.5), 0., 1.); }`;

const FLY_SHIP_VS = `#version 300 es
in vec2 aPos; in vec4 iA; in vec2 iB;
${WORLD_POS}
uniform float uHalfM;
out vec2 vQ; out vec2 vWorld; flat out float vAng; flat out float vThr; flat out float vDmg;
void main(){ vQ=aPos; float c=cos(iA.z), s=sin(iA.z);
  vec2 w = iA.xy + mat2(c,s,-s,c)*(aPos*uHalfM); vWorld=w;
  vAng=iA.z; vThr=iA.w; vDmg=iB.x; gl_Position=clipOf(w); }`;
const FLY_SHIELD_VS = `#version 300 es
in vec2 aPos; in vec4 iA; in vec4 iH1; in vec4 iH2;
${WORLD_POS}
uniform float uHalfM;
out vec2 vQ; flat out vec4 vH1; flat out vec4 vH2; flat out float vIdle; flat out float vSeed;
void main(){ vQ=aPos; float c=cos(iA.z), s=sin(iA.z);
  vec2 w = iA.xy + mat2(c,s,-s,c)*(aPos*uHalfM);
  vH1=iH1; vH2=iH2; vIdle=iA.w; vSeed=fract(iA.x*.0013+iA.y*.0007)*40.; gl_Position=clipOf(w); }`;
const FLY_PLUME_VS = `#version 300 es
in vec2 aPos; in vec4 iN; in vec4 iP; in vec2 iB;
${WORLD_POS}
uniform vec3 uPlCol[4]; uniform vec3 uPlCore[4]; uniform vec4 uPlP[4]; uniform float uPlSpread[4];
out vec2 vST; flat out vec3 vCol; flat out vec3 vCore; flat out vec4 vP; flat out float vSeed; flat out float vPow;
void main(){
  int b = int(iB.x+.5);
  float s = (aPos.y*.5+.5)*1.1-.1; float t = aPos.x;
  vec2 dir = iN.zw, perp = vec2(-dir.y, dir.x);
  float wid = max(iP.y, 2.5/uScale);
  vec2 w = iN.xy + dir*s*iP.x + perp*t*wid*.5*(1.+max(s,0.)*(.6+uPlSpread[b]*2.));
  vST=vec2(s,t); vCol=uPlCol[b]; vCore=mix(uPlCore[b], vec3(1.), clamp(iB.y,0.,1.)*.8); vP=uPlP[b]; vSeed=iP.z; vPow=iP.w;
  gl_Position=clipOf(w);
}`;
const FLY_BOLT_VS = `#version 300 es
in vec2 aPos; in vec4 iA; in vec4 iC;
${WORLD_POS}
out vec2 vQ; flat out vec3 vCol;
void main(){ vec2 v=iA.zw; float sp=max(length(v),1.); vec2 d=v/sp, p=vec2(-d.y,d.x);
  float wid = max(1.4, 2.5/uScale);
  vec2 w = iA.xy + d*aPos.y*iC.w*.5 + p*aPos.x*wid; vQ=aPos; vCol=iC.rgb; gl_Position=clipOf(w); }`;
const FLY_BOLT_FS = `#version 300 es
precision highp float; in vec2 vQ; flat in vec3 vCol; out vec4 o;
void main(){ float core = exp(-vQ.x*vQ.x*6.)*(1.-smoothstep(.55,1.,abs(vQ.y)));
  float head = .5+1.5*smoothstep(-1.,1.,vQ.y);
  o = vec4(mix(vCol, vec3(1.), core*core*.6)*core*head*2.5, 0.); }`;
const FLY_PART_VS = `#version 300 es
in vec2 aPos; in vec4 iA; in vec4 iC;
${WORLD_POS}
out vec2 vQ; flat out vec3 vCol; flat out float vLife;
void main(){ vQ=aPos; vCol=iC.rgb; vLife=iA.w; vec2 w = iA.xy + aPos*max(iA.z, 1.6/uScale); gl_Position=clipOf(w); }`;
const FLY_PART_FS = `#version 300 es
precision highp float; in vec2 vQ; flat in vec3 vCol; flat in float vLife; out vec4 o;
void main(){ float r=length(vQ); float g=(exp(-r*r*7.)*1.4 + exp(-r*3.)*.25)*(1.-smoothstep(.85,1.,r)); o=vec4(vCol*g*vLife, 0.); }`;
const PLANET_VS = `#version 300 es
in vec2 aPos;
${WORLD_POS}
uniform vec2 uC; uniform float uR;
out vec2 vQ;
void main(){ vQ=aPos*1.3; gl_Position=clipOf(uC + aPos*uR*1.3); }`;
const PLANET_FS = `#version 300 es
precision highp float; in vec2 vQ; out vec4 o;
uniform vec3 uSun, uSunCol, uAmb, uC1, uC2, uC3, uAtm; uniform float uSeed, uTime, uPx; uniform int uKind;
${NOISE}
void main(){
  float r = length(vQ);
  vec3 L = normalize(uSun);
  vec2 ld = normalize(L.xy+1e-5);
  if (r > 1.) {
    float a = exp(-(r-1.)*9.)*(1.-smoothstep(1.25,1.3,r));
    float lit = clamp(dot(normalize(vQ), ld)*.6+.45, 0., 1.);
    o = vec4(uAtm*uSunCol*a*lit*.8, 0.); return;
  }
  float z = sqrt(1.-r*r); vec3 N = vec3(vQ, z);
  float ca = cos(uTime*.004+uSeed), sa = sin(uTime*.004+uSeed);
  vec3 R = vec3(N.x*ca+N.z*sa, N.y, -N.x*sa+N.z*ca);
  vec3 alb;
  if (uKind == 1) {
    float w = fbm(vec2(R.x*2.+R.z, R.y*6.)+uSeed)*2.;
    float b = sin(R.y*14. + w*2.2);
    alb = mix(uC1, uC2, smoothstep(-.6,.6,b)); alb = mix(alb, uC3, smoothstep(.55,.95,fbm(vec2(R.x*4.+R.z*2., R.y*20.)+uSeed*2.)));
  } else {
    float h = fbm(vec2(R.x*2.6+R.z*1.7, R.y*2.6-R.z*.6)+uSeed);
    float land = smoothstep(.5,.54,h);
    alb = mix(uC1, mix(uC2, uC3, smoothstep(.6,.75,h)), land);
    if (uKind == 0) { float cl = smoothstep(.55,.75,fbm(vec2(R.x*3.+R.z*2.+uTime*.002, R.y*4.)+uSeed*3.)); alb = mix(alb, vec3(.9), cl*.8); }
    else alb *= .7+.6*fbm(vec2(R.x*9., R.y*9.)+R.z);
  }
  alb = pow(alb, vec3(2.2));
  float dif = max(dot(N, L), 0.);
  vec3 col = alb*uSunCol*dif*2.2 + alb*uAmb*1.5;
  float rim = pow(1.-z, 3.);
  col += uAtm*uSunCol*rim*(.25+dif)*1.2;
  float aa = 1.-smoothstep(1.-uPx*1.5, 1., r);
  o = vec4(col*aa, aa);
}`;

let FLY = null, FLY_ERR = '';
try { FLY = (function () {
  const FP = {
    ship: compile(FLY_SHIP_VS, derive(SHIP_FS, DERIVE.ship), { iA: 1, iB: 2 }),
    shield: compile(FLY_SHIELD_VS, derive(SHIELD_FS, DERIVE.shield), { iA: 1, iH1: 2, iH2: 3 }),
    plume: compile(FLY_PLUME_VS, derive(PLUME_FS, DERIVE.plume), { iN: 1, iP: 2, iB: 3 }),
    bolt: compile(FLY_BOLT_VS, FLY_BOLT_FS, { iA: 1, iC: 2 }),
    part: compile(FLY_PART_VS, FLY_PART_FS, { iA: 1, iC: 2 }),
    planet: compile(PLANET_VS, PLANET_FS)
  };
  function instVAO(sizes) {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const per = sizes.reduce((a, b) => a + b, 0), stride = per * 4;
    let off = 0;
    sizes.forEach((sz, k) => { gl.enableVertexAttribArray(k + 1); gl.vertexAttribPointer(k + 1, sz, gl.FLOAT, false, stride, off); gl.vertexAttribDivisor(k + 1, 1); off += sz * 4; });
    gl.bindVertexArray(null);
    return { vao, buf, sizes, per, stride };
  }
  function upload(V, data, count) { gl.bindBuffer(gl.ARRAY_BUFFER, V.buf); gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, Math.max(1, count) * V.per), gl.DYNAMIC_DRAW); }
  function pointAt(V, first) { // VAO bound: re-point instance attributes at instance `first`
    gl.bindBuffer(gl.ARRAY_BUFFER, V.buf);
    let off = first * V.stride;
    V.sizes.forEach((sz, k) => { gl.vertexAttribPointer(k + 1, sz, gl.FLOAT, false, V.stride, off); off += sz * 4; });
  }
  const VS = { ship: instVAO([4, 2]), shield: instVAO([4, 4, 4]), plume: instVAO([4, 4, 2]), bolt: instVAO([4, 4]), part: instVAO([4, 4]) };

  // ---------- entity storage (structure of arrays) ----------
  const MAXS = 320, MAXB = 4096, MAXP = 8192, MAXL = 64, BOLT_V = 1100, HIT_LIFE = 2.6;
  const sType = new Int16Array(MAXS), sBrand = new Uint8Array(MAXS), sSize = new Uint8Array(MAXS);
  const sAlive = new Uint8Array(MAXS), sRole = new Uint8Array(MAXS), sMode = new Uint8Array(MAXS), sMount = new Uint8Array(MAXS), sBurn = new Uint8Array(MAXS);
  const sx = new Float32Array(MAXS), sy = new Float32Array(MAXS), svx = new Float32Array(MAXS), svy = new Float32Array(MAXS);
  const sAng = new Float32Array(MAXS), sAv = new Float32Array(MAXS), sThr = new Float32Array(MAXS);
  const sHp = new Float32Array(MAXS), sSh = new Float32Array(MAXS), sSince = new Float32Array(MAXS), sDmg = new Float32Array(MAXS);
  const sCd = new Float32Array(MAXS), sAi = new Float32Array(MAXS), sTx = new Float32Array(MAXS), sTy = new Float32Array(MAXS), sResp = new Float32Array(MAXS);
  const sTurnIn = new Float32Array(MAXS), sThrIn = new Uint8Array(MAXS), sBrkIn = new Uint8Array(MAXS), sFireIn = new Uint8Array(MAXS);
  const hAx = new Float32Array(MAXS), hAy = new Float32Array(MAXS), hAt = new Float32Array(MAXS), hAs = new Float32Array(MAXS);
  const hBx = new Float32Array(MAXS), hBy = new Float32Array(MAXS), hBt = new Float32Array(MAXS), hBs = new Float32Array(MAXS);
  let nS = 0;
  const bx = new Float32Array(MAXB), by = new Float32Array(MAXB), bvx = new Float32Array(MAXB), bvy = new Float32Array(MAXB), bLife = new Float32Array(MAXB), bDmg = new Float32Array(MAXB);
  const bOwn = new Int16Array(MAXB), bBrand = new Uint8Array(MAXB);
  let nB = 0;
  const px = new Float32Array(MAXP), py = new Float32Array(MAXP), pvx = new Float32Array(MAXP), pvy = new Float32Array(MAXP);
  const pLife = new Float32Array(MAXP), pMax = new Float32Array(MAXP), pSz = new Float32Array(MAXP), pGrow = new Float32Array(MAXP);
  const pr = new Float32Array(MAXP), pg = new Float32Array(MAXP), pb = new Float32Array(MAXP);
  let nP = 0;
  const lX = new Float32Array(MAXL), lY = new Float32Array(MAXL), lZ = new Float32Array(MAXL), lR = new Float32Array(MAXL), lT = new Float32Array(MAXL), lLife = new Float32Array(MAXL);
  const lCr = new Float32Array(MAXL), lCg = new Float32Array(MAXL), lCb = new Float32Array(MAXL);
  let nL = 0;
  const hostile = new Uint8Array(8);

  // instance scratch buffers
  const shipInst = new Float32Array(MAXS * 6), shieldInst = new Float32Array(MAXS * 12), plumeInst = new Float32Array(MAXS * 12 * 10);
  const boltInst = new Float32Array(MAXB * 8), partInst = new Float32Array(MAXP * 8);
  const typeCount = new Int32Array(64), typeStart = new Int32Array(64), typeFill = new Int32Array(64);
  const shieldCount = new Int32Array(64), shieldStart = new Int32Array(64), shieldFill = new Int32Array(64);

  const PLANETS = [
    { x: -3200, y: 2600, r: 1300, kind: 0, c1: '#1d4f7a', c2: '#5d7a3c', c3: '#d8cba8', atm: '#6fb3ff', seed: 1.3, name: 'Tessaly' },
    { x: 6800, y: -4400, r: 2700, kind: 1, c1: '#c9925c', c2: '#7d4e33', c3: '#ecd9b0', atm: '#ffc98a', seed: 4.1, name: 'Orrin' },
    { x: -8200, y: -6400, r: 820, kind: 2, c1: '#5e5953', c2: '#8a8178', c3: '#c9c0b4', atm: '#b0a8a0', seed: 7.7, name: 'Kell' }
  ].map(p => Object.assign(p, { L1: hexRGB(p.c1), L2: hexRGB(p.c2), L3: hexRGB(p.c3), LA: lin(hexRGB(p.atm)) }));

  // ---------- ship types (one per baked brand x size) ----------
  let types = [];
  const nSizes = () => catalog.sizes.length;
  function buildTypes() {
    types = [];
    catalog.brands.forEach((b, bi) => catalog.sizes.forEach((z, zi) => {
      const s = ships.get(keyOf(b.id, z.id));
      const fz = z.flight || {}, fb = b.style.flight || {};
      const T = {
        bi, zi, s, ready: !!(s && s.ready && s.tex), texRef: s && s.tex, name: b.name + ' ' + z.name, brand: b, L: z.length,
        accel: (fz.accel || 60) * (fb.accel || 1), turn: (fz.turn || 1) * (fb.turn || 1), vmax: (fz.vmax || 200) * (fb.vmax || 1),
        hull: (fz.hull || 100) * (fb.hull || 1), shield: (fz.shield || 100) * (fb.shield || 1), rate: fz.rate || 4, dmg: fz.dmg || 8, br: brandRender(b)
      };
      if (T.ready) {
        const m = s.maps;
        T.half = m.extent / 2; T.extent = m.extent; T.S = m.shieldS; T.Dmax = m.Dmax;
        T.eng = m.engines.map(e => ({ lx: (e.u - 0.5) * m.extent, ly: (0.5 - e.v) * m.extent, w: e.w * m.extent, dx: e.dx, dy: e.dy }));
        let ax = 0, ay = 0; T.eng.forEach(e => { ax += e.lx; ay += e.ly; });
        T.engX = T.eng.length ? ax / T.eng.length : 0; T.engY = T.eng.length ? ay / T.eng.length : -T.half * 0.6;
        T.mounts = s.spec.parts.filter(p => p.role === 'weapon').map(p => [p.x, p.y]);
        if (!T.mounts.length) T.mounts = [[0, T.half * 0.3]];
        T.hullEps = T.Dmax / 255 * 1.5;
      }
      types.push(T);
    }));
  }
  function typesStale() { return types.length !== catalog.brands.length * nSizes() || types.some(T => { const s = ships.get(keyOf(T.brand.id, catalog.sizes[T.zi].id)); return !s || s.tex !== T.texRef || T.brand !== catalog.brands[T.bi]; }); }
  const allReady = () => types.length && types.every(T => T.ready);

  // ---------- spawning ----------
  const SIZE_W = [0.36, 0.3, 0.2, 0.1, 0.04];
  function randomType() {
    let x = Math.random(), zi = 0; for (; zi < SIZE_W.length - 1; zi++) { x -= SIZE_W[zi]; if (x <= 0) break; }
    const bi = Math.floor(Math.random() * catalog.brands.length);
    return bi * nSizes() + Math.min(zi, nSizes() - 1);
  }
  function pickWaypoint(i) {
    if (sRole[i] === 0) { const p = PLANETS[Math.floor(Math.random() * PLANETS.length)]; const a = Math.random() * 6.283; sTx[i] = p.x + Math.cos(a) * p.r * 1.35; sTy[i] = p.y + Math.sin(a) * p.r * 1.35; }
    else { const a = Math.random() * 6.283, r = 1500 + Math.random() * 6000; sTx[i] = Math.cos(a) * r; sTy[i] = Math.sin(a) * r; }
  }
  function spawn(i, ti, x, y, role) {
    const T = types[ti];
    sType[i] = ti; sBrand[i] = T.bi; sSize[i] = T.zi; sAlive[i] = 1; sRole[i] = role; sMode[i] = 0; sMount[i] = 0; sBurn[i] = 0;
    sx[i] = x; sy[i] = y; sAng[i] = Math.random() * 6.283; sAv[i] = 0; sThr[i] = 0;
    const v0 = i === 0 ? 0 : T.vmax * (0.2 + Math.random() * 0.3);
    svx[i] = -Math.sin(sAng[i]) * v0; svy[i] = Math.cos(sAng[i]) * v0;
    sHp[i] = T.hull; sSh[i] = T.shield; sSince[i] = 99; sDmg[i] = 0; sCd[i] = Math.random(); sAi[i] = Math.random() * 0.5; sResp[i] = 0;
    sTurnIn[i] = 0; sThrIn[i] = 0; sBrkIn[i] = 0; sFireIn[i] = 0;
    hAt[i] = -1e9; hBt[i] = -1e9;
    if (i !== 0) pickWaypoint(i);
  }
  function playerType() {
    const bi = Math.max(0, catalog.brands.findIndex(b => b.id === state.flyBrand)), zi = Math.max(0, catalog.sizes.findIndex(z => z.id === state.flySize));
    return bi * nSizes() + zi;
  }
  function resetWorld() {
    nB = 0; nP = 0; nL = 0; hostile.fill(0);
    nS = Math.min(MAXS, 1 + state.traffic);
    spawn(0, playerType(), 0, 0, 1); sAng[0] = 0;
    for (let i = 1; i < nS; i++) {
      const a = Math.random() * 6.283, r = 1200 + Math.random() * 9000;
      spawn(i, randomType(), Math.cos(a) * r, Math.sin(a) * r, Math.random() < 0.55 ? 0 : 1);
    }
    applyPirates();
    camX = 0; camY = 0; target = -1; simT = 0;
  }
  function applyPirates() { const ri = catalog.brands.findIndex(b => b.id === 'rustline'); if (ri >= 0 && state.pirates) hostile[ri] = 1; }
  function respawnNPC(i) {
    const a = Math.random() * 6.283, r = 4000 + Math.random() * 5000;
    spawn(i, randomType(), sx[0] + Math.cos(a) * r, sy[0] + Math.sin(a) * r, Math.random() < 0.55 ? 0 : 1);
  }

  // ---------- effects ----------
  function addParticle(x, y, vx, vy, life, size, grow, r, g, b) {
    if (nP >= MAXP) return;
    const k = nP++; px[k] = x; py[k] = y; pvx[k] = vx; pvy[k] = vy; pLife[k] = life; pMax[k] = life; pSz[k] = size; pGrow[k] = grow; pr[k] = r; pg[k] = g; pb[k] = b;
  }
  function addLight(x, y, z, r, life, c, k) {
    if (nL >= MAXL) return;
    const j = nL++; lX[j] = x; lY[j] = y; lZ[j] = z; lR[j] = r; lT[j] = 0; lLife[j] = life; lCr[j] = c[0] * k; lCg[j] = c[1] * k; lCb[j] = c[2] * k;
  }
  function sparks(x, y, vx, vy, n, col, speed, size, life) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.283, s = speed * (0.3 + Math.random());
      addParticle(x, y, vx + Math.cos(a) * s, vy + Math.sin(a) * s, life * (0.5 + Math.random()), size * (0.6 + Math.random() * 0.8), -0.4, col[0] * 3, col[1] * 3, col[2] * 3);
    }
  }
  let shake = 0;
  function explode(i) {
    const T = types[sType[i]], L = T.L;
    sAlive[i] = 0; sResp[i] = i === 0 ? 3 : 5 + Math.random() * 6;
    const hot = [1.0, 0.75, 0.45], col = T.br.plCol;
    addParticle(sx[i], sy[i], svx[i] * 0.5, svy[i] * 0.5, 0.6, L * 0.9, 1.6, 6, 4.5, 3);
    addParticle(sx[i], sy[i], svx[i] * 0.5, svy[i] * 0.5, 1.4, L * 0.6, 0.9, col[0] * 2, col[1] * 2, col[2] * 2);
    const n = 40 + sSize[i] * 45;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.283, s = (40 + L * 1.5) * Math.pow(Math.random(), 0.6);
      const c = Math.random() < 0.7 ? hot : col;
      addParticle(sx[i] + Math.cos(a) * L * 0.2 * Math.random(), sy[i] + Math.sin(a) * L * 0.2 * Math.random(), svx[i] + Math.cos(a) * s, svy[i] + Math.sin(a) * s, 0.6 + Math.random() * 1.4, L * (0.04 + Math.random() * 0.1), 0.6, c[0] * 4, c[1] * 4, c[2] * 4);
    }
    addLight(sx[i], sy[i], L * 0.4, L * 7, 1.1, [1.0, 0.7, 0.4], 9);
    const d = Math.hypot(sx[i] - sx[0], sy[i] - sy[0]);
    shake = Math.max(shake, Math.min(1, (L / 40) * Math.max(0, 1 - d / (L * 30 + 1500))));
    if (target === i) target = -1;
  }
  function hit(i, qx, qy, wx, wy, dmg, owner) {
    const T = types[sType[i]];
    sSince[i] = 0;
    if (owner === 0 && i !== 0) { hostile[sBrand[i]] = 1; }
    if (sSh[i] > 0) {
      sSh[i] -= dmg;
      hBx[i] = hAx[i]; hBy[i] = hAy[i]; hBt[i] = hAt[i]; hBs[i] = hAs[i];
      hAx[i] = qx; hAy[i] = qy; hAt[i] = simT; hAs[i] = Math.min(1.6, 0.6 + dmg / 12);
      sparks(wx, wy, svx[i], svy[i], 5, T.br.shCol, 90, 1.2 + T.L * 0.01, 0.35);
      addLight(wx, wy, T.L * 0.15 + 4, 40 + T.L * 1.2, 0.35, T.br.shCol, 4);
    } else {
      sHp[i] -= dmg; sDmg[i] = 1;
      sparks(wx, wy, svx[i], svy[i], 9, [1, 0.62, 0.3], 140, 1.0 + T.L * 0.008, 0.55);
      addLight(wx, wy, T.L * 0.1 + 3, 30 + T.L, 0.25, [1, 0.6, 0.3], 4);
      if (sHp[i] <= 0) explode(i);
    }
  }
  function fire(i, aimX, aimY) {
    const T = types[sType[i]]; if (nB >= MAXB) return;
    const volley = sSize[i] >= 3 ? 2 : 1;
    for (let v = 0; v < volley; v++) {
      const m = T.mounts[sMount[i]++ % T.mounts.length];
      const c = Math.cos(sAng[i]), s = Math.sin(sAng[i]);
      const wx = sx[i] + c * m[0] - s * m[1], wy = sy[i] + s * m[0] + c * m[1];
      let dx = -s, dy = c;
      if (aimX !== undefined) { const ax = aimX - wx, ay = aimY - wy, al = Math.hypot(ax, ay) || 1; dx = ax / al; dy = ay / al; }
      const k = nB++;
      bx[k] = wx; by[k] = wy; bvx[k] = svx[i] + dx * BOLT_V; bvy[k] = svy[i] + dy * BOLT_V;
      bLife[k] = 1.15 + sSize[i] * 0.15; bDmg[k] = T.dmg; bOwn[k] = i; bBrand[k] = sBrand[i];
      addParticle(wx, wy, svx[i], svy[i], 0.08, 2 + T.L * 0.02, 2, T.br.plCol[0] * 4, T.br.plCol[1] * 4, T.br.plCol[2] * 4);
    }
  }

  // ---------- AI ----------
  const wrap = a => { a = (a + Math.PI) % 6.283185307; if (a < 0) a += 6.283185307; return a - Math.PI; };
  function steerVel(i, dvx, dvy) {
    const T = types[sType[i]], m = Math.hypot(dvx, dvy);
    if (m < T.accel * 0.08) { sTurnIn[i] = 0; sThrIn[i] = 0; return; }
    const d = wrap(Math.atan2(-dvx, dvy) - sAng[i]);
    sTurnIn[i] = Math.max(-1, Math.min(1, d * 3 / T.turn));
    sThrIn[i] = Math.abs(d) < 0.35 ? 1 : 0;
  }
  function seek(i, tx, ty, arrive) {
    const T = types[sType[i]], dx = tx - sx[i], dy = ty - sy[i], d = Math.hypot(dx, dy) || 1;
    const vd = arrive ? Math.min(T.vmax, Math.sqrt(2 * T.accel * 0.5 * d)) : T.vmax;
    steerVel(i, dx / d * vd - svx[i], dy / d * vd - svy[i]);
    return d;
  }
  function ai(i, dt) {
    const T = types[sType[i]];
    sFireIn[i] = 0; sBrkIn[i] = 0; sBurn[i] = 0;
    const pdx = sx[0] - sx[i], pdy = sy[0] - sy[i], pd = Math.hypot(pdx, pdy) || 1;
    sAi[i] -= dt;
    if (sAi[i] <= 0) {
      sAi[i] = 0.35 + Math.random() * 0.35;
      if (hostile[sBrand[i]] && sAlive[0] && pd < 4500 + T.L * 4) sMode[i] = sRole[i] === 0 && sSize[i] < 3 ? 2 : 1;
      else sMode[i] = 0;
    }
    if (sMode[i] === 1) {
      const range = 900 + T.L * 3, t = pd / BOLT_V;
      const ax = sx[0] + (svx[0] - svx[i]) * t, ay = sy[0] + (svy[0] - svy[i]) * t;
      if (pd > range * 0.85) { seek(i, ax, ay, false); sBurn[i] = pd > range * 2 ? 1 : 0; }
      else {
        const d = wrap(Math.atan2(-(ax - sx[i]), ay - sy[i]) - sAng[i]);
        sTurnIn[i] = Math.max(-1, Math.min(1, d * 3 / T.turn));
        const hx = -Math.sin(sAng[i]), hy = Math.cos(sAng[i]);
        sThrIn[i] = ((svx[0] - svx[i]) * hx + (svy[0] - svy[i]) * hy) > T.accel * 0.3 ? 1 : 0;
        if (Math.abs(d) < 0.12 + 25 / pd) sFireIn[i] = 1;
      }
      if (sSize[i] >= 3 && pd < range) { sFireIn[i] = 2; sTx[i] = ax; sTy[i] = ay; }
    } else if (sMode[i] === 2) {
      seek(i, sx[i] - pdx / pd * 5000, sy[i] - pdy / pd * 5000, false); sBurn[i] = 1;
    } else {
      const d = seek(i, sTx[i], sTy[i], true);
      if (d < 180 + T.L * 1.5) pickWaypoint(i);
    }
  }

  // ---------- simulation step ----------
  const keys = new Set();
  let simT = 0, camX = 0, camY = 0, target = -1, last = 0;
  function playerInput() {
    const T = types[sType[0]];
    const left = keys.has('ArrowLeft') || keys.has('KeyA'), right = keys.has('ArrowRight') || keys.has('KeyD');
    sTurnIn[0] = (left ? 1 : 0) - (right ? 1 : 0);
    sThrIn[0] = keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0;
    sBrkIn[0] = keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0;
    sBurn[0] = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0;
    sFireIn[0] = keys.has('Space') ? 1 : 0;
    if (sBrkIn[0] && state.flightModel === 'newton' && !left && !right) { // turn to face retrograde
      const sp = Math.hypot(svx[0], svy[0]);
      if (sp > 2) { const d = wrap(Math.atan2(svx[0], -svy[0]) - sAng[0]); sTurnIn[0] = Math.max(-1, Math.min(1, d * 3 / T.turn)); }
    }
  }
  function step(dt) {
    simT += dt;
    if (sAlive[0]) playerInput();
    const assisted = state.flightModel === 'assist';
    for (let i = 0; i < nS; i++) {
      if (!sAlive[i]) {
        sResp[i] -= dt;
        if (sResp[i] <= 0) { if (i === 0) { spawn(0, playerType(), sx[0], sy[0], 1); svx[0] = 0; svy[0] = 0; } else respawnNPC(i); }
        continue;
      }
      if (i !== 0) ai(i, dt);
      const T = types[sType[i]];
      // rotation: angular velocity chases the commanded rate
      const tav = sTurnIn[i] * T.turn, ta = T.turn * 8 * dt;
      sAv[i] += Math.max(-ta, Math.min(ta, tav - sAv[i]));
      sAng[i] += sAv[i] * dt;
      const hx = -Math.sin(sAng[i]), hy = Math.cos(sAng[i]);
      const burn = sBurn[i] && sThrIn[i];
      const acc = T.accel * (burn ? 1.7 : 1);
      if (sThrIn[i]) { svx[i] += hx * acc * dt; svy[i] += hy * acc * dt; }
      if (i === 0 && assisted) {
        if (sBrkIn[i]) { const sp = Math.hypot(svx[i], svy[i]); if (sp > 0) { const k = Math.min(sp, T.accel * 0.8 * dt) / sp; svx[i] -= svx[i] * k; svy[i] -= svy[i] * k; } }
        const along = svx[i] * hx + svy[i] * hy, lx = svx[i] - along * hx, ly = svy[i] - along * hy;
        const k = Math.min(1, 1.4 * dt); svx[i] -= lx * k; svy[i] -= ly * k;
      }
      // soft speed cap, EV style
      const cap = T.vmax * (burn ? 1.3 : 1), sp = Math.hypot(svx[i], svy[i]);
      if (sp > cap) { const k = Math.max(cap / sp, 1 - 1.5 * dt); svx[i] *= k; svy[i] *= k; }
      sx[i] += svx[i] * dt; sy[i] += svy[i] * dt;
      const tt = sThrIn[i] ? (burn ? 1 : 0.72) : (sBrkIn[i] && i === 0 && assisted ? 0.3 : 0.06);
      sThr[i] += (tt - sThr[i]) * Math.min(1, dt * 6);
      sCd[i] -= dt;
      if (sFireIn[i] && sCd[i] <= 0) { sCd[i] = 1 / T.rate * (i === 0 ? 1 : 1.6); if (sFireIn[i] === 2) fire(i, sTx[i], sTy[i]); else fire(i); }
      sSince[i] += dt;
      if (sSince[i] > 2.5 && sSh[i] < T.shield) sSh[i] = Math.min(T.shield, Math.max(sSh[i], 0) + T.shield * 0.07 * dt);
      sDmg[i] = Math.max(0, sDmg[i] - dt * 5);
    }
    // bolts: integrate, then test against ships (broadphase box, then the baked shield/hull field)
    for (let k = 0; k < nB; k++) {
      bLife[k] -= dt;
      const ox = bx[k], oy = by[k];
      bx[k] += bvx[k] * dt; by[k] += bvy[k] * dt;
      let dead = bLife[k] <= 0;
      if (!dead) {
        const own = bOwn[k];
        for (let i = 0; i < nS; i++) {
          if (!sAlive[i] || i === own) continue;
          if (own !== 0 && i !== 0) continue; // NPC fire only threatens the player
          const T = types[sType[i]], h = T.half;
          if (Math.abs(bx[k] - sx[i]) > h + 40 || Math.abs(by[k] - sy[i]) > h + 40) continue;
          const c = Math.cos(sAng[i]), s = Math.sin(sAng[i]), thr = sSh[i] > 0 ? T.S : T.hullEps;
          for (let j = 1; j <= 6; j++) {
            const wx = ox + (bx[k] - ox) * j / 6, wy = oy + (by[k] - oy) * j / 6;
            const dx = wx - sx[i], dy = wy - sy[i];
            const qx = (c * dx + s * dy) / h, qy = (-s * dx + c * dy) / h;
            if (qx < -1 || qx > 1 || qy < -1 || qy > 1) continue;
            if (fieldAt(T.s, qx, qy) <= thr) { hit(i, qx, qy, wx, wy, bDmg[k], own); dead = true; break; }
          }
          if (dead) break;
        }
      }
      if (dead) { const e = --nB; bx[k] = bx[e]; by[k] = by[e]; bvx[k] = bvx[e]; bvy[k] = bvy[e]; bLife[k] = bLife[e]; bDmg[k] = bDmg[e]; bOwn[k] = bOwn[e]; bBrand[k] = bBrand[e]; k--; }
    }
    for (let k = 0; k < nP; k++) {
      pLife[k] -= dt;
      if (pLife[k] <= 0) { const e = --nP; px[k] = px[e]; py[k] = py[e]; pvx[k] = pvx[e]; pvy[k] = pvy[e]; pLife[k] = pLife[e]; pMax[k] = pMax[e]; pSz[k] = pSz[e]; pGrow[k] = pGrow[e]; pr[k] = pr[e]; pg[k] = pg[e]; pb[k] = pb[e]; k--; continue; }
      const dr = Math.max(0, 1 - dt * 0.8);
      pvx[k] *= dr; pvy[k] *= dr; px[k] += pvx[k] * dt; py[k] += pvy[k] * dt; pSz[k] *= 1 + pGrow[k] * dt;
    }
    for (let j = 0; j < nL; j++) {
      lT[j] += dt;
      if (lT[j] >= lLife[j]) { const e = --nL; lX[j] = lX[e]; lY[j] = lY[e]; lZ[j] = lZ[e]; lR[j] = lR[e]; lT[j] = lT[e]; lLife[j] = lLife[e]; lCr[j] = lCr[e]; lCg[j] = lCg[e]; lCb[j] = lCb[e]; j--; }
    }
    shake = Math.max(0, shake - dt * 1.8);
  }

  // ---------- rendering ----------
  let scale = 1;
  const LP = new Float32Array(64), LC = new Float32Array(64);
  const candW = new Float32Array(512), candD = new Float32Array(512 * 7);
  function gatherLights(viewR) {
    let n = 0;
    const push = (x, y, z, r, cr, cg, cb) => {
      if (n >= 512) return;
      const d = Math.hypot(x - camX, y - camY); if (d > viewR + r * 4) return;
      candW[n] = (cr + cg + cb) * r / (d + r);
      candD.set([x, y, z, r, cr, cg, cb], n * 7); n++;
    };
    for (let i = 0; i < nS; i++) {
      if (!sAlive[i] || sThr[i] < 0.05) continue;
      const T = types[sType[i]], c = Math.cos(sAng[i]), s = Math.sin(sAng[i]);
      const ex = T.engX, ey = T.engY - T.L * 0.12, pw = plumePower(sThr[i]) * 1.5;
      push(sx[i] + c * ex - s * ey, sy[i] + s * ex + c * ey, T.L * 0.05 + 1.5, T.L * 1.6 + 8, T.br.plCol[0] * pw, T.br.plCol[1] * pw, T.br.plCol[2] * pw);
    }
    for (let j = 0; j < nL; j++) { const f = 1 - lT[j] / lLife[j], k = f * f; push(lX[j], lY[j], lZ[j], lR[j], lCr[j] * k, lCg[j] * k, lCb[j] * k); }
    for (let k = 0; k < Math.min(nB, 48); k++) { const c = types[bBrand[k] * nSizes()].br.plCol; push(bx[k], by[k], 6, 70, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6); }
    // pick the strongest 16
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => candW[b] - candW[a]).slice(0, 16);
    idx.forEach((ci, k) => { LP.set(candD.subarray(ci * 7, ci * 7 + 4), k * 4); LC.set([candD[ci * 7 + 4], candD[ci * 7 + 5], candD[ci * 7 + 6], 0], k * 4); });
    return idx.length;
  }
  function setView(prog, RW, RH) {
    gl.useProgram(prog.p);
    gl.uniform2f(prog.u.uRes, RW, RH); gl.uniform2f(prog.u.uCam, camX, camY); gl.uniform1f(prog.u.uScale, scale);
  }
  function render(t) {
    const RW = canvas.width, RH = canvas.height;
    const T0 = types[sType[0]];
    const viewW = Math.max(700, T0.L * 16) / state.zoom;
    scale = RW / viewW;
    const halfW = RW / scale / 2, halfH = RH / scale / 2, viewR = Math.hypot(halfW, halfH);
    const visible = i => Math.abs(sx[i] - camX) < halfW + types[sType[i]].half * 1.2 + types[sType[i]].L * 2 && Math.abs(sy[i] - camY) < halfH + types[sType[i]].half * 1.2 + types[sType[i]].L * 2;
    const star = STARS[state.star], sunCol = lin(star.col), sv = sunVec(), sl = Math.hypot(sv[0], sv[1]) || 1;

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.f); gl.viewport(0, 0, RW, RH);
    gl.disable(gl.BLEND);
    gl.useProgram(P.bg.p);
    gl.uniform2f(P.bg.u.uRes, RW, RH); gl.uniform1f(P.bg.u.uTime, t);
    gl.uniform3fv(P.bg.u.uStar, star.col); gl.uniform3fv(P.bg.u.uNeb, star.neb);
    gl.uniform2f(P.bg.u.uSunDir, sv[0] / sl, sv[1] / sl);
    gl.uniform2f(P.bg.u.uOff, camX * scale * 0.04, camY * scale * 0.04);
    draw();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // planets
    setView(FP.planet, RW, RH);
    { const u = FP.planet.u;
      gl.uniform3fv(u.uSun, sv); gl.uniform3fv(u.uSunCol, sunCol); gl.uniform3fv(u.uAmb, star.amb); gl.uniform1f(u.uTime, t);
      for (const p of PLANETS) {
        if (Math.abs(p.x - camX) > halfW + p.r * 1.3 || Math.abs(p.y - camY) > halfH + p.r * 1.3) continue;
        gl.uniform2f(u.uC, p.x, p.y); gl.uniform1f(u.uR, p.r); gl.uniform1f(u.uPx, 1 / (p.r * scale));
        gl.uniform3fv(u.uC1, p.L1); gl.uniform3fv(u.uC2, p.L2); gl.uniform3fv(u.uC3, p.L3); gl.uniform3fv(u.uAtm, p.LA);
        gl.uniform1f(u.uSeed, p.seed); gl.uniform1i(u.uKind, p.kind);
        draw();
      } }

    const nLights = gatherLights(viewR);

    // plumes: one instanced draw for every engine on screen
    let nPl = 0;
    if (state.map === 0) {
      for (let i = 0; i < nS && nPl < MAXS * 12; i++) {
        if (!sAlive[i] || sThr[i] < 0.03 || !visible(i)) continue;
        const T = types[sType[i]], br = T.br, c = Math.cos(sAng[i]), s = Math.sin(sAng[i]);
        const th = sThr[i], burn = sBurn[i] && sThrIn[i] ? 1 : 0, pw = plumePower(th) * (burn ? 1.3 : 1);
        for (let e = 0; e < T.eng.length; e++) {
          const E = T.eng[e], o = nPl * 10;
          plumeInst[o] = sx[i] + c * E.lx - s * E.ly; plumeInst[o + 1] = sy[i] + s * E.lx + c * E.ly;
          plumeInst[o + 2] = c * E.dx - s * E.dy; plumeInst[o + 3] = s * E.dx + c * E.dy;
          plumeInst[o + 4] = E.w * br.plLen * (0.3 + 1.7 * th) * (burn ? 1.6 : 1); plumeInst[o + 5] = E.w * br.plWid * 1.1;
          plumeInst[o + 6] = i * 7.3 + e * 1.37; plumeInst[o + 7] = pw;
          plumeInst[o + 8] = T.bi; plumeInst[o + 9] = burn;
          nPl++;
        }
      }
    }
    if (nPl) {
      gl.blendFunc(gl.ONE, gl.ONE);
      setView(FP.plume, RW, RH);
      const u = FP.plume.u; gl.uniform1f(u.uTime, t);
      const col = new Float32Array(12), core = new Float32Array(12), pp = new Float32Array(16), spr = new Float32Array(4);
      catalog.brands.slice(0, 4).forEach((b, k) => { const br = brandRender(b); col.set(br.plCol, k * 3); core.set(br.plCore, k * 3); pp.set([br.plTurb, br.plDia, br.plSput, br.plPulse], k * 4); spr[k] = br.plSpread; });
      gl.uniform3fv(u.uPlCol, col); gl.uniform3fv(u.uPlCore, core); gl.uniform4fv(u.uPlP, pp); gl.uniform1fv(u.uPlSpread, spr);
      gl.bindVertexArray(VS.plume.vao); upload(VS.plume, plumeInst, nPl);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nPl);
      gl.bindVertexArray(null);
    }

    // hulls: bucket visible ships by type, draw largest classes first
    const NT = types.length;
    typeCount.fill(0); shieldCount.fill(0);
    for (let i = 0; i < nS; i++) {
      if (!sAlive[i] || !visible(i)) continue;
      typeCount[sType[i]]++;
      if (state.map === 0 && (simT - hAt[i] < HIT_LIFE || (state.shields && state.shieldIdle > 0 && sSh[i] > 0))) shieldCount[sType[i]]++;
    }
    const order = Array.from({ length: NT }, (_, k) => k).sort((a, b) => types[b].zi - types[a].zi);
    let acc = 0, accS = 0;
    for (const k of order) { typeStart[k] = acc; acc += typeCount[k]; typeFill[k] = typeStart[k]; shieldStart[k] = accS; accS += shieldCount[k]; shieldFill[k] = shieldStart[k]; }
    for (let i = 0; i < nS; i++) {
      if (!sAlive[i] || !visible(i)) continue;
      const ti = sType[i], o = typeFill[ti]++ * 6;
      shipInst[o] = sx[i]; shipInst[o + 1] = sy[i]; shipInst[o + 2] = sAng[i]; shipInst[o + 3] = sThr[i]; shipInst[o + 4] = sDmg[i]; shipInst[o + 5] = 0;
      if (state.map === 0 && (simT - hAt[i] < HIT_LIFE || (state.shields && state.shieldIdle > 0 && sSh[i] > 0))) {
        const q = shieldFill[ti]++ * 12, a1 = simT - hAt[i], a2 = simT - hBt[i];
        shieldInst.set([sx[i], sy[i], sAng[i], state.shields && sSh[i] > 0 ? state.shieldIdle * 0.6 : 0,
          hAx[i], hAy[i], a1 < HIT_LIFE ? a1 : -1, hAs[i], hBx[i], hBy[i], a2 < HIT_LIFE ? a2 : -1, hBs[i]], q);
      }
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    setView(FP.ship, RW, RH);
    { const u = FP.ship.u;
      gl.uniform3fv(u.uSun, sv); gl.uniform3fv(u.uSunCol, sunCol); gl.uniform3fv(u.uAmb, star.amb);
      gl.uniform1f(u.uTime, t); gl.uniform1i(u.uMode, state.map); gl.uniform1f(u.uShadow, state.shadow ? 1 : 0);
      gl.uniform4fv(u.uLP, LP); gl.uniform4fv(u.uLC, LC); gl.uniform1i(u.uLN, nLights);
      gl.uniform1i(u.uA, 0); gl.uniform1i(u.uN, 1); gl.uniform1i(u.uE, 2); gl.uniform1i(u.uX, 3);
      gl.bindVertexArray(VS.ship.vao); upload(VS.ship, shipInst, acc);
      for (const k of order) {
        if (!typeCount[k]) continue;
        const T = types[k], m = T.brand.style.material;
        gl.uniform1f(u.uHalfM, T.half); gl.uniform1f(u.uExtent, T.extent); gl.uniform1f(u.uHRange, T.s.maps.hRange);
        gl.uniform1f(u.uDmax, T.Dmax); gl.uniform1f(u.uS, T.S);
        gl.uniform1f(u.uGloss, m.gloss); gl.uniform1f(u.uSpecK, 0.6 + m.spec * 1.4); gl.uniform1f(u.uWrap, m.wrap); gl.uniform1f(u.uIrid, m.irid); gl.uniform1f(u.uRim, m.rim);
        for (let q = 0; q < 4; q++) { gl.activeTexture(gl.TEXTURE0 + q); gl.bindTexture(gl.TEXTURE_2D, T.s.tex[q]); }
        pointAt(VS.ship, typeStart[k]);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, typeCount[k]);
      }
      gl.bindVertexArray(null); }

    // shields
    gl.blendFunc(gl.ONE, gl.ONE);
    if (accS) {
      setView(FP.shield, RW, RH);
      const u = FP.shield.u; gl.uniform1f(u.uTime, t); gl.uniform1i(u.uX, 0);
      gl.bindVertexArray(VS.shield.vao); upload(VS.shield, shieldInst, accS);
      for (const k of order) {
        if (!shieldCount[k]) continue;
        const T = types[k];
        gl.uniform1f(u.uHalfM, T.half); gl.uniform1f(u.uExtent, T.extent); gl.uniform1f(u.uS, T.S); gl.uniform1f(u.uDmax, T.Dmax);
        gl.uniform1f(u.uStrength, T.br.shStr); gl.uniform3fv(u.uCol, T.br.shCol); gl.uniform1i(u.uPat, T.br.shPat);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.s.tex[3]);
        pointAt(VS.shield, shieldStart[k]);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, shieldCount[k]);
      }
      gl.bindVertexArray(null);
    }
    // bolts
    let nb = 0;
    for (let k = 0; k < nB; k++) {
      if (Math.abs(bx[k] - camX) > halfW + 80 || Math.abs(by[k] - camY) > halfH + 80) continue;
      const c = types[bBrand[k] * nSizes()].br.plCol, o = nb * 8;
      boltInst[o] = bx[k]; boltInst[o + 1] = by[k]; boltInst[o + 2] = bvx[k] - 0; boltInst[o + 3] = bvy[k];
      boltInst[o + 4] = c[0] * 3; boltInst[o + 5] = c[1] * 3; boltInst[o + 6] = c[2] * 3; boltInst[o + 7] = 22 + Math.min(40, bDmg[k] * 1.2);
      nb++;
    }
    if (nb) { setView(FP.bolt, RW, RH); gl.bindVertexArray(VS.bolt.vao); upload(VS.bolt, boltInst, nb); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nb); gl.bindVertexArray(null); }
    // particles
    let np = 0;
    for (let k = 0; k < nP; k++) {
      if (Math.abs(px[k] - camX) > halfW + pSz[k] || Math.abs(py[k] - camY) > halfH + pSz[k]) continue;
      const o = np * 8, f = pLife[k] / pMax[k];
      partInst[o] = px[k]; partInst[o + 1] = py[k]; partInst[o + 2] = pSz[k]; partInst[o + 3] = f * f;
      partInst[o + 4] = pr[k]; partInst[o + 5] = pg[k]; partInst[o + 6] = pb[k]; partInst[o + 7] = 0;
      np++;
    }
    if (np) { setView(FP.part, RW, RH); gl.bindVertexArray(VS.part.vao); upload(VS.part, partInst, np); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, np); gl.bindVertexArray(null); }
    gl.disable(gl.BLEND);
    postProcess();
    drawHUD(T0, viewW);
    stats.ships = nS; stats.bolts = nB; stats.parts = nP; stats.lights = nLights; stats.drawn = acc;
  }

  // ---------- HUD (2D canvas over the GL view) ----------
  const hud = $('hud'), hx = hud.getContext('2d');
  const stats = { ships: 0, bolts: 0, parts: 0, lights: 0, drawn: 0, fps: 60 };
  function toScreen(x, y) { return [(x - camX) * scale / dpr + W / 2, H / 2 - (y - camY) * scale / dpr]; }
  function drawHUD(T0, viewW) {
    if (hud.width !== Math.round(W * dpr) || hud.height !== Math.round(H * dpr)) { hud.width = Math.round(W * dpr); hud.height = Math.round(H * dpr); }
    hx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hx.clearRect(0, 0, W, H);
    const amber = '#e2b866', mono = '500 11.5px "IBM Plex Mono", ui-monospace, monospace';
    hx.font = mono; hx.textBaseline = 'middle';
    if (sAlive[0]) {
      const [cx, cy] = toScreen(sx[0], sy[0]);
      const sp = Math.hypot(svx[0], svy[0]);
      if (sp > 1) {
        const len = 30 + 60 * Math.min(1.3, sp / T0.vmax), ux = svx[0] / sp, uy = -svy[0] / sp;
        const r0 = Math.max(18, T0.half * scale / dpr * 0.75);
        hx.strokeStyle = 'rgba(226,184,102,.75)'; hx.lineWidth = 1.5;
        hx.beginPath(); hx.moveTo(cx + ux * r0, cy + uy * r0); hx.lineTo(cx + ux * (r0 + len), cy + uy * (r0 + len)); hx.stroke();
        hx.beginPath(); hx.arc(cx + ux * (r0 + len), cy + uy * (r0 + len), 4, 0, 6.283); hx.stroke();
      }
    }
    // target bracket
    if (target >= 0 && sAlive[target]) {
      const T = types[sType[target]], [tx, ty] = toScreen(sx[target], sy[target]);
      const on = tx > 0 && ty > 0 && tx < W && ty < H;
      const col = hostile[sBrand[target]] ? '#ff7a62' : '#9fb4c8';
      hx.strokeStyle = col; hx.fillStyle = col; hx.lineWidth = 1.5;
      if (on) {
        const r = Math.max(14, T.half * scale / dpr * 0.7), k = r * 0.35;
        for (const [sxn, syn] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          hx.beginPath(); hx.moveTo(tx + sxn * r, ty + syn * (r - k)); hx.lineTo(tx + sxn * r, ty + syn * r); hx.lineTo(tx + sxn * (r - k), ty + syn * r); hx.stroke();
        }
      } else {
        const a = Math.atan2(ty - H / 2, tx - W / 2), rx = W / 2 - 30, ry = H / 2 - 30;
        const t = Math.min(rx / Math.abs(Math.cos(a) || 1e-6), ry / Math.abs(Math.sin(a) || 1e-6));
        const ax = W / 2 + Math.cos(a) * t, ay = H / 2 + Math.sin(a) * t;
        hx.beginPath(); hx.moveTo(ax + Math.cos(a) * 10, ay + Math.sin(a) * 10); hx.lineTo(ax + Math.cos(a + 2.5) * 9, ay + Math.sin(a + 2.5) * 9); hx.lineTo(ax + Math.cos(a - 2.5) * 9, ay + Math.sin(a - 2.5) * 9); hx.closePath(); hx.fill();
      }
    }
    // readout panel
    const lines = [];
    if (sAlive[0]) {
      const sp = Math.hypot(svx[0], svy[0]), hd = ((-sAng[0] * 180 / Math.PI) % 360 + 360) % 360;
      lines.push([T0.name, '#dbe0e7']);
      lines.push([`SPD ${sp.toFixed(0).padStart(4)} / ${T0.vmax.toFixed(0)} m/s`, '#dbe0e7']);
      lines.push([`HDG ${hd.toFixed(0).padStart(3, '0')}°  ${state.flightModel === 'assist' ? 'ASSIST' : 'NEWTONIAN'}${sBurn[0] && sThrIn[0] ? '  BURN' : ''}`, sBurn[0] && sThrIn[0] ? amber : '#8a95a4']);
    } else lines.push(['Hull breached. Respawning…', '#ff7a62']);
    if (target >= 0 && sAlive[target]) {
      const T = types[sType[target]], d = Math.hypot(sx[target] - sx[0], sy[target] - sy[0]);
      const rv = ((svx[target] - svx[0]) * (sx[target] - sx[0]) + (svy[target] - svy[0]) * (sy[target] - sy[0])) / (d || 1);
      lines.push(['', '']);
      lines.push([`TGT ${T.name}${hostile[sBrand[target]] ? '  HOSTILE' : ''}`, hostile[sBrand[target]] ? '#ff7a62' : '#9fb4c8']);
      lines.push([`RNG ${(d / 1000).toFixed(2)} km  ${rv < 0 ? 'CLOSING' : 'OPENING'} ${Math.abs(rv).toFixed(0)} m/s`, '#8a95a4']);
    }
    const bx0 = 14, by0 = 14;
    hx.fillStyle = 'rgba(7,9,12,.55)'; hx.fillRect(bx0 - 8, by0 - 8, 268, lines.length * 17 + 42);
    lines.forEach(([s, c], k) => { hx.fillStyle = c; hx.fillText(s, bx0, by0 + 6 + k * 17); });
    if (sAlive[0]) {
      const yb = by0 + lines.length * 17 + 6, T = T0;
      const bar = (y, f, col, label) => { hx.fillStyle = '#1e2630'; hx.fillRect(bx0 + 28, y - 3, 200, 6); hx.fillStyle = col; hx.fillRect(bx0 + 28, y - 3, 200 * Math.max(0, Math.min(1, f)), 6); hx.fillStyle = '#8a95a4'; hx.fillText(label, bx0, y); };
      bar(yb, sSh[0] / T.shield, 'rgb(' + T.br.shCol.map(v => Math.round(Math.pow(v, 1 / 2.2) * 255)).join(',') + ')', 'SHD');
      bar(yb + 14, sHp[0] / T.hull, amber, 'HUL');
    }
    // radar
    const R = Math.min(84, Math.min(W, H) * 0.16), rcx = W - R - 16, rcy = H - R - 16, range = Math.max(9000, T0.L * 60);
    hx.fillStyle = 'rgba(7,9,12,.6)'; hx.beginPath(); hx.arc(rcx, rcy, R, 0, 6.283); hx.fill();
    hx.strokeStyle = 'rgba(138,149,164,.35)'; hx.lineWidth = 1; hx.beginPath(); hx.arc(rcx, rcy, R, 0, 6.283); hx.stroke();
    hx.beginPath(); hx.arc(rcx, rcy, R * 0.5, 0, 6.283); hx.stroke();
    const cxw = sx[0], cyw = sy[0];
    for (const p of PLANETS) {
      const dx = (p.x - cxw) / range * R, dy = -(p.y - cyw) / range * R; if (Math.hypot(dx, dy) > R + p.r / range * R) continue;
      hx.strokeStyle = 'rgba(159,180,200,.45)'; hx.beginPath(); hx.arc(rcx + dx, rcy + dy, Math.max(2, p.r / range * R), 0, 6.283); hx.stroke();
    }
    for (let i = 1; i < nS; i++) {
      if (!sAlive[i]) continue;
      const dx = (sx[i] - cxw) / range * R, dy = -(sy[i] - cyw) / range * R; if (dx * dx + dy * dy > R * R) continue;
      hx.fillStyle = hostile[sBrand[i]] ? '#ff7a62' : types[sType[i]].brand.style.palette.emissive;
      const s = 1.5 + sSize[i] * 0.6; hx.fillRect(rcx + dx - s / 2, rcy + dy - s / 2, s, s);
      if (i === target) { hx.strokeStyle = '#dbe0e7'; hx.strokeRect(rcx + dx - 4, rcy + dy - 4, 8, 8); }
    }
    hx.fillStyle = '#dbe0e7'; hx.save(); hx.translate(rcx, rcy); hx.rotate(-sAng[0]); hx.beginPath(); hx.moveTo(0, -5); hx.lineTo(3.5, 4); hx.lineTo(-3.5, 4); hx.closePath(); hx.fill(); hx.restore();
    hx.fillStyle = '#8a95a4'; hx.textAlign = 'right';
    hx.fillText(`${(range / 1000).toFixed(0)} km`, rcx + R, rcy - R - 8);
    hx.fillText(`${stats.ships} ships · ${stats.bolts} bolts · ${stats.parts} particles · ${stats.fps.toFixed(0)} fps`, W - 16, 16);
    hx.textAlign = 'left';
  }

  // ---------- public ----------
  let needsReset = true, fpsAcc = 0, fpsN = 0;
  function frame(now) {
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016); last = now;
    fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { stats.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    if (typesStale()) buildTypes();
    const t = (now - t0) / 1000;
    if (!allReady()) {
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.f); gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.BLEND); gl.useProgram(P.bg.p); gl.uniform2f(P.bg.u.uRes, canvas.width, canvas.height); gl.uniform1f(P.bg.u.uTime, t); gl.uniform2f(P.bg.u.uOff, 0, 0); draw();
      postProcess();
      hx.setTransform(dpr, 0, 0, dpr, 0, 0); hx.clearRect(0, 0, W, H); hx.fillStyle = '#e2b866'; hx.font = '500 13px "IBM Plex Mono", monospace'; hx.fillText('Baking the fleet…', 20, 30);
      return;
    }
    if (needsReset) { resetWorld(); needsReset = false; }
    step(dt);
    if (sAlive[0] || true) {
      const lead = 0.35, tx = sx[0] + svx[0] * lead, ty = sy[0] + svy[0] * lead;
      const k = Math.min(1, dt * 3.5); camX += (tx - camX) * k; camY += (ty - camY) * k;
    }
    const shx = shake * shake * 14 / scale, a = Math.random() * 6.283;
    camX += Math.cos(a) * shx; camY += Math.sin(a) * shx;
    render(t);
  }
  function cycleTarget() {
    const list = [];
    for (let i = 1; i < nS; i++) if (sAlive[i]) list.push([Math.hypot(sx[i] - sx[0], sy[i] - sy[0]), i]);
    list.sort((a, b) => a[0] - b[0]);
    if (!list.length) { target = -1; return; }
    const at = list.findIndex(e => e[1] === target);
    target = list[(at + 1) % Math.min(list.length, 8)][1];
  }
  function key(code, down, e) {
    if (down) {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(code) && e) e.preventDefault();
      if (code === 'Tab' || code === 'KeyT') { if (!keys.has(code)) cycleTarget(); }
      if (code === 'KeyF' && !keys.has(code)) { state.flightModel = state.flightModel === 'assist' ? 'newton' : 'assist'; syncFlightModel(); }
      if ((code === 'Equal' || code === 'NumpadAdd') && !keys.has(code)) setZoom(state.zoom * 1.25);
      if ((code === 'Minus' || code === 'NumpadSubtract') && !keys.has(code)) setZoom(state.zoom / 1.25);
      keys.add(code);
    } else keys.delete(code);
  }
  return {
    frame, key, clearKeys: () => keys.clear(),
    reset: () => { needsReset = true; },
    pirates: () => { applyPirates(); },
    calm: () => { hostile.fill(0); applyPirates(); },
    swapPlayer: () => { if (!allReady()) { needsReset = true; return; } const ti = playerType(); const x = sx[0], y = sy[0], a = sAng[0]; spawn(0, ti, x, y, 1); sAng[0] = a; }
  };
})(); } catch (e) { FLY_ERR = String(e.message || e); console.error(e); }
