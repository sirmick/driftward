(function () {
'use strict';
const $ = id => document.getElementById(id);
const CATALOG0 = JSON.parse($('catalog').textContent);
let catalog = JSON.parse(JSON.stringify(CATALOG0));
const GEN_TEXT = $('gen').textContent;
const hexRGB = h => { h = String(h).replace('#', ''); return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]; };
const lin = c => c.map(v => Math.pow(v, 2.2));

const STARS = {
  sol:  { name: 'Yellow', col: [1.0, 0.95, 0.86], amb: [0.030, 0.034, 0.046], neb: [0.10, 0.12, 0.20] },
  red:  { name: 'Red dwarf', col: [1.0, 0.58, 0.38], amb: [0.040, 0.026, 0.030], neb: [0.20, 0.08, 0.07] },
  blue: { name: 'Blue giant', col: [0.72, 0.84, 1.0], amb: [0.024, 0.034, 0.055], neb: [0.06, 0.12, 0.24] }
};
const DRIFT_COLS = ['#ff5a4a', '#4ab8ff', '#ffd25a', '#b46bff', '#4dffa8', '#ff8ad8', '#ffffff', '#ff9a3d', '#6af0ff', '#c8ff5a'].map(h => lin(hexRGB(h)));
const PATTERNS = { hex: 0, grid: 1, flow: 2, ragged: 3 };
const state = {
  view: 'grid', brand: catalog.brands[0].id, size: catalog.sizes[2].id,
  map: 0, spin: true, trueScale: false, shadow: true, pl: true,
  sunAz: 135, sunEl: 35, star: 'sol', seed: 'kestrel-7',
  planetSeed: 'set-1', planetFocus: -1, sunSeed: 's1', sunFocus: -1, stSeed: 'stations-1', stFocus: -1, hvSeed: 'heavies-1', hvFocus: -1, astSeed: 'rocks-1', astFocus: -1, hoverItem: -1, sunOff: [-0.17, 0.12], flares: true,
  flyBrand: 'halcyon', flySize: 'fighter', traffic: 60, zoom: 1, flightModel: 'assist', pirates: false,
  throttle: 0.6, bloom: 0.9, lightsN: 4, shields: true, shieldIdle: 0.3, barrage: false, click: 'inspect',
  mouse: null, hoverKey: null, editBrand: catalog.brands[0].id
};

// ---------------- WebGL setup ----------------
const canvas = $('view');
const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: false });
if (!gl) { $('glerr').hidden = false; return; }
let HDR = !!gl.getExtension('EXT_color_buffer_float');

function compile(vs, fs, attrs) {
  const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  if (attrs) for (const k in attrs) gl.bindAttribLocation(p, attrs[k], k);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

const NOISE = `
float h21(vec2 p){ p=fract(p*vec2(443.897,441.423)); p+=dot(p,p.yx+19.19); return fract((p.x+p.y)*p.x); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<5;i++){ s+=a*vn(p); p=p*2.03+1.3; a*=.5; } return s; }`;

const FS_VS = `#version 300 es
in vec2 aPos; out vec2 vUv; void main(){ vUv=aPos*0.5+0.5; gl_Position=vec4(aPos,0.,1.); }`;

// Shared sky: the plain background and the black-hole lens both sample it, so lensed stars match the sky around them.
const SKY = `uniform vec2 uRes; uniform float uTime; uniform vec3 uStar; uniform vec3 uNeb; uniform vec2 uSunDir; uniform vec2 uOff;
${NOISE}
vec3 sky(vec2 px){
  vec2 uv = (px - uOff)/uRes;
  vec2 q = (uv-.5)*vec2(uRes.x/uRes.y,1.) + uOff/uRes.y*.5;
  vec3 c = vec3(0.0006,0.0008,0.0014);
  float nb = fbm(q*1.6+vec2(3.1,1.7)), nb2 = fbm(q*3.3-vec2(1.,4.));
  c += pow(uNeb,vec3(2.2))*0.35*smoothstep(.45,.95,nb)*(.6+.4*nb2);
  float sd = max(dot(normalize(q+1e-4), uSunDir),0.);
  c += pow(uStar,vec3(2.2))*0.012*pow(sd,4.)*smoothstep(0.,.9,length(q));
  for(int l=0;l<3;l++){
    float sc = 90.+float(l)*70.; vec2 g = px/sc*(1.+float(l)*.37) + float(l)*13.7; vec2 id=floor(g); vec2 f=fract(g)-.5;
    float r = h21(id+float(l)); if(r>.18) continue;
    vec2 o2 = vec2(h21(id+3.1),h21(id+7.3))-.5; float d=length(f-o2*.7);
    float tw = .75+.25*sin(uTime*(1.+r*9.)+r*40.);
    float b = (1.-smoothstep(0.,.06-.015*float(l),d))*(.35+.65*h21(id+11.))*tw;
    vec3 sc3 = mix(vec3(1.,.8,.6), vec3(.6,.75,1.), h21(id+5.));
    c += sc3*b*(.6-.15*float(l));
  }
  return c;
}`;
const BG_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
${SKY}
void main(){ o = vec4(sky(vUv*uRes + uOff), 1.); }`;

const SHIP_VS = `#version 300 es
in vec2 aPos; uniform vec2 uRes, uCenter; uniform float uHalf, uAngle;
out vec2 vQ; out vec2 vWorld;
void main(){ vQ=aPos; float c=cos(uAngle), s=sin(uAngle);
  vec2 w = uCenter + mat2(c,s,-s,c)*(aPos*uHalf); vWorld=w;
  gl_Position=vec4(w/uRes*2.-1.,0.,1.); }`;

const SHIP_FS = `#version 300 es
precision highp float;
in vec2 vQ; in vec2 vWorld; out vec4 o;
uniform sampler2D uA, uN, uE, uX;
uniform float uAngle, uExtent, uHRange, uPxPerM, uTime, uThrottle, uDmax, uS;
uniform vec3 uSun, uSunCol, uAmb;
uniform vec4 uLP[16]; uniform vec4 uLC[16]; uniform int uLN;
uniform float uGloss, uSpecK, uWrap, uIrid, uRim, uShadow, uHover;
uniform int uMode;
void main(){
  vec2 uv = vec2(vQ.x*.5+.5, .5-vQ.y*.5);
  vec4 A = texture(uA, uv), Nt = texture(uN, uv), Et = texture(uE, uv), X = texture(uX, uv);
  if (uMode != 0) {
    if (uMode == 5) {
      float f = X.r*uDmax/uS;
      vec3 c = mix(vec3(.9,.95,1.), vec3(.02,.05,.12), clamp(f,0.,1.));
      c += vec3(.3,.8,1.)*exp(-pow((f-1.)/.04,2.));
      c += vec3(1.,.5,.2)*X.g;
      float a = max(A.a, step(f,1.1)*.85);
      o = vec4(pow(c,vec3(2.2))*a, a); return;
    }
    vec3 c = uMode==1 ? A.rgb : uMode==2 ? Nt.rgb : uMode==3 ? mix(vec3(.05,.07,.12), vec3(1.,.93,.78), Nt.a) : clamp(Et.rgb*2.,0.,1.);
    o = vec4(pow(c,vec3(2.2))*A.a, A.a); return;
  }
  float c = cos(uAngle), s = sin(uAngle);
  vec3 n = normalize(vec3(Nt.xy*2.-1., Nt.z));
  vec3 N = normalize(vec3(c*n.x - s*n.y, s*n.x + c*n.y, n.z));
  vec3 alb = pow(A.rgb, vec3(2.2));
  float spec = Et.a;
  vec3 V = vec3(0.,0.,1.);
  vec3 L = normalize(uSun), H = normalize(L+V);
  vec3 irid = .55+.55*cos(6.2832*(vec3(0.,.33,.67) + dot(N,H)*1.4 + N.x*.35 + N.y*.2));
  alb *= mix(vec3(1.), irid, uIrid*.6);
  float dif = max((dot(N,L)+uWrap)/(1.+uWrap), 0.);
  float sh = 1.;
  if (uShadow > .5 && L.z < .995) {
    vec2 ll = vec2(c*L.x + s*L.y, -s*L.x + c*L.y);
    float lxy = max(length(ll),1e-4); vec2 dir = vec2(ll.x, -ll.y)/lxy; float tanE = L.z/lxy;
    float h0 = Nt.a*uHRange, occ = 0.;
    for (int i=1; i<=28; i++) {
      float du = float(i)*.004; vec2 u2 = uv + dir*du;
      if (u2.x<0.||u2.y<0.||u2.x>1.||u2.y>1.) break;
      float hs = textureLod(uN, u2, 0.).a*uHRange;
      occ = max(occ, clamp((hs - h0 - du*uExtent*tanE)/(uHRange*.04+1e-4), 0., 1.) * (1.-float(i)/34.));
    }
    sh = 1. - occ*.82;
  }
  float specK = uSpecK*(1.+uGloss*.02);
  float sp = pow(max(dot(N,H),0.), uGloss) * spec * specK;
  vec3 specCol = mix(uSunCol, uSunCol*irid, uIrid);
  vec3 col = (alb*dif + specCol*sp)*uSunCol*sh*2.2;
  vec3 P = vec3(vWorld, Nt.a*uHRange*uPxPerM);
  for (int i=0; i<16; i++) {
    if (i >= uLN) break;
    vec3 d = uLP[i].xyz - P; float dist = length(d); vec3 Lp = d/dist; float R = uLP[i].w;
    float att = R*R/(R*R + dist*dist*1.6) * clamp(1.-dist/(R*4.),0.,1.);
    float pd = max((dot(N,Lp)+uWrap)/(1.+uWrap),0.);
    float ps = pow(max(dot(N,normalize(Lp+V)),0.),uGloss)*spec*specK;
    col += (alb*pd + ps)*uLC[i].rgb*att;
  }
  col += alb*uAmb*(.8+.6*N.z);
  float fr = pow(1.-max(N.z,0.), 2.5);
  col += uRim*fr*(uAmb*3. + uSunCol*max(dot(normalize(N.xy+1e-5), normalize(L.xy+1e-5)),0.)*.5)*(.4+spec);
  float eg = X.g;
  float flick = .92 + .08*sin(uTime*41. + vQ.y*13.);
  vec3 em = pow(Et.rgb*2., vec3(1.6))*2.2;
  em *= mix(1., (.2 + 4.5*uThrottle*uThrottle)*flick, eg);
  col += em;
  col += vec3(.5,.38,.18)*uHover*.025;
  o = vec4(col*A.a, A.a);
}`;

const SHIELD_FS = `#version 300 es
precision highp float;
in vec2 vQ; in vec2 vWorld; out vec4 o;
uniform sampler2D uX;
uniform float uExtent, uS, uDmax, uTime, uIdle, uStrength, uSeed;
uniform vec3 uCol; uniform int uPat;
uniform vec4 uHits[8];
${NOISE}
float hexd(vec2 p){ p.x *= 1.1547; p.y += mod(floor(p.x),2.)*.5; p = abs(fract(p)-.5); return abs(max(p.x*1.5+p.y, p.y*2.)-1.); }
void main(){
  vec2 uv = vec2(vQ.x*.5+.5, .5-vQ.y*.5);
  float d = textureLod(uX, uv, 2.).r*uDmax;
  float f = d/uS;
  if (f > 1.2) discard;
  float fe = clamp(f,0.,1.);
  float bubble = sqrt(max(0.,1.-fe*fe));
  float fres = pow(1.-bubble, 2.2);
  float edge = 1.-smoothstep(.97,1.1,f);
  vec2 m = vQ*uExtent*.5;
  float PS = max(uS*.42, .8);
  vec2 pp = m/PS;
  float pat;
  if (uPat == 0) pat = 1.-smoothstep(0.,.12,hexd(pp));
  else if (uPat == 1) { vec2 g = abs(fract(pp*.8)-.5); pat = smoothstep(.42,.5,max(g.x,g.y)); }
  else if (uPat == 2) { float n = fbm(pp*.55 + vec2(uSeed, uTime*.35)); pat = pow(1.-abs(n*2.-1.), 5.); }
  else { float n = vn(pp*.8 + vec2(uSeed, uTime*1.3)); pat = step(.58,n)*(.6+.4*vn(pp*3.+uTime*6.)); }
  float scan = .5+.5*sin(m.y/PS*.5 - uTime*2.4 + uSeed);
  float idle = uIdle*(fres*.55 + fres*pat*(.35+.65*scan)*.9);
  if (uPat == 3) idle *= .6+.4*step(.35, vn(vec2(uTime*7., uSeed)));
  float hit = 0.;
  for (int i=0; i<8; i++) {
    float age = uHits[i].z; if (age < 0.) continue;
    float hd = length(m - uHits[i].xy*uExtent*.5);
    float w = uS*.55;
    float rd = (hd - age*uS*10.)/w;
    float ring = exp(-rd*rd)*exp(-age*2.4);
    float flash = exp(-hd/(uS*.9))*exp(-age*6.);
    float glowA = exp(-hd/(uS*3.))*exp(-age*3.);
    hit += (ring*(.5+pat*1.5) + flash*4. + glowA*pat*.8)*uHits[i].w;
  }
  float I = edge*(idle + hit*(.3+.7*fres+.3*pat))*uStrength;
  o = vec4(uCol*I*1.8, 0.);
}`;

const PLUME_VS = `#version 300 es
in vec2 aPos; uniform vec2 uRes, uNoz, uDir; uniform float uLen, uWid, uSpread;
out vec2 vST;
void main(){
  float s = (aPos.y*.5+.5)*1.1 - .1; float t = aPos.x;
  vec2 perp = vec2(-uDir.y, uDir.x);
  vec2 w = uNoz + uDir*s*uLen + perp*t*uWid*.5*(1. + max(s,0.)*(.6+uSpread*2.));
  vST = vec2(s,t); gl_Position = vec4(w/uRes*2.-1.,0.,1.);
}`;
const PLUME_FS = `#version 300 es
precision highp float; in vec2 vST; out vec4 o;
uniform vec3 uCol, uCore; uniform float uTime, uSeed, uTurb, uDiamonds, uSputter, uPulse, uPower;
${NOISE}
void main(){
  float s = vST.x, t = vST.y, sp = max(s,0.);
  float n = vn(vec2(sp*7. - uTime*11., t*1.5 + uSeed)) - .5;
  float tt = t + n*uTurb*.9*sp;
  float core = exp(-tt*tt*(10. + 26.*sp));
  float body = exp(-tt*tt*3.4);
  float len = pow(clamp(1.-sp,0.,1.), 1.5);
  float start = smoothstep(-.1, .03, s);
  float diam = 1. + uDiamonds*1.4*pow(abs(cos(sp*34.)),8.)*(1.-sp)*core;
  float flick = 1. - uSputter*.75*step(.64, vn(vec2(uTime*6., uSeed*1.7)));
  flick *= 1. - uSputter*.3*vn(vec2(uTime*33., uSeed*3.1));
  float pulse = 1. + uPulse*.55*sin(uTime*4.2 + uSeed*6. - sp*10.);
  float wisp = 1. + uTurb*.9*(vn(vec2(sp*9. - uTime*15., t*3. + uSeed*2.)) - .5);
  vec3 c = uCore*core*3.2*(1.-sp*.75) + uCol*body*1.4*(.35+.65*len);
  c *= len*start*diam*flick*pulse*wisp*uPower;
  o = vec4(c, 0.);
}`;

const MARK_VS = `#version 300 es
in vec2 aPos; uniform vec2 uRes, uC; uniform float uSz; out vec2 vQ;
void main(){ vQ=aPos; vec2 w = uC + aPos*uSz; gl_Position = vec4(w/uRes*2.-1.,0.,1.); }`;
const MARK_FS = `#version 300 es
precision highp float; in vec2 vQ; out vec4 o; uniform vec3 uCol;
void main(){ float r = length(vQ); float g = exp(-r*r*40.)*6. + exp(-r*6.)*.35; o = vec4(uCol*g*(1.-smoothstep(.8,1.,r)), 0.); }`;

const BRIGHT_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uThresh;
void main(){
  vec3 s = (texture(uSrc, vUv+uTexel*vec2(-1.,-1.)).rgb + texture(uSrc, vUv+uTexel*vec2(1.,-1.)).rgb
          + texture(uSrc, vUv+uTexel*vec2(-1.,1.)).rgb + texture(uSrc, vUv+uTexel*vec2(1.,1.)).rgb)*.25;
  float br = max(s.r, max(s.g, s.b)), k = .5;
  float soft = clamp(br - uThresh + k, 0., 2.*k); soft = soft*soft/(4.*k + 1e-4);
  o = vec4(s*max(soft, br - uThresh)/max(br, 1e-4), 1.);
}`;
const DOWN_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform vec2 uTexel;
void main(){
  vec3 s = texture(uSrc, vUv).rgb*4.;
  s += texture(uSrc, vUv+uTexel*vec2(-1.,-1.)).rgb + texture(uSrc, vUv+uTexel*vec2(1.,-1.)).rgb;
  s += texture(uSrc, vUv+uTexel*vec2(-1.,1.)).rgb + texture(uSrc, vUv+uTexel*vec2(1.,1.)).rgb;
  o = vec4(s/8., 1.);
}`;
const UP_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform vec2 uTexel;
void main(){
  vec3 s = texture(uSrc, vUv).rgb*4.;
  s += (texture(uSrc, vUv+uTexel*vec2(-1.,0.)).rgb + texture(uSrc, vUv+uTexel*vec2(1.,0.)).rgb
      + texture(uSrc, vUv+uTexel*vec2(0.,-1.)).rgb + texture(uSrc, vUv+uTexel*vec2(0.,1.)).rgb)*2.;
  s += texture(uSrc, vUv+uTexel*vec2(-1.,-1.)).rgb + texture(uSrc, vUv+uTexel*vec2(1.,-1.)).rgb
     + texture(uSrc, vUv+uTexel*vec2(-1.,1.)).rgb + texture(uSrc, vUv+uTexel*vec2(1.,1.)).rgb;
  o = vec4(s/16., 1.);
}`;
const COMP_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uScene, uBloom; uniform float uBloomK, uExposure;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.); }
void main(){
  vec3 c = texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb*uBloomK;
  c = aces(c*uExposure);
  vec2 q = vUv-.5; c *= 1. - dot(q,q)*.35;
  o = vec4(pow(c, vec3(1./2.2)), 1.);
}`;

const P = {
  bg: compile(FS_VS, BG_FS), ship: compile(SHIP_VS, SHIP_FS), shield: compile(SHIP_VS, SHIELD_FS),
  plume: compile(PLUME_VS, PLUME_FS), mark: compile(MARK_VS, MARK_FS),
  bright: compile(FS_VS, BRIGHT_FS), down: compile(FS_VS, DOWN_FS), up: compile(FS_VS, UP_FS), comp: compile(FS_VS, COMP_FS)
};
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
const draw = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

function tex(data, res) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, res, res, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function makeRT(w, h) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  if (HDR) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { t, f, w, h, ok };
}
let scene = null, chain = [];
function freeRT(r) { if (r) { gl.deleteTexture(r.t); gl.deleteFramebuffer(r.f); } }
function buildTargets() {
  freeRT(scene); chain.forEach(freeRT); chain = [];
  scene = makeRT(canvas.width, canvas.height);
  if (!scene.ok && HDR) { HDR = false; freeRT(scene); scene = makeRT(canvas.width, canvas.height); }
  let w = canvas.width, h = canvas.height;
  for (let i = 0; i < 6; i++) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); chain.push(makeRT(w, h)); }
  $('hdr-note').textContent = HDR ? 'HDR float target' : '8-bit target (float render targets unavailable)';
}

// ---------------- baking (workers) ----------------
const ships = new Map();
const keyOf = (b, s) => b + '|' + s;
let jobCounter = 0;
const queue = [];
let workers = [];
const busy = new Set();
function makeWorker() {
  const src = GEN_TEXT + `
;self.onmessage = function (e) {
  const m = e.data;
  try {
    const r = m.station ? self.ShipGen.generateStation(m.catalog, m.station, m.brand, m.seed) : self.ShipGen.generate(m.catalog, m.brand, m.size, m.seed);
    const spec = self.ShipGen.describe(r.ship);
    const mp = r.maps;
    self.postMessage({ ok: true, key: m.key, job: m.job, spec, maps: mp }, [mp.albedo.buffer, mp.nrm.buffer, mp.emis.buffer, mp.aux.buffer]);
  } catch (err) { self.postMessage({ ok: false, key: m.key, job: m.job, error: String((err && err.message) || err) }); }
};`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  w.onmessage = e => { busy.delete(w); onResult(e.data); pump(); };
  w.onerror = () => { busy.delete(w); pump(); };
  return w;
}
try { const n = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)); for (let i = 0; i < n; i++) workers.push(makeWorker()); } catch (e) { workers = []; }

function onResult(m) {
  const s = ships.get(m.key);
  if (!s || s.job !== m.job) return;
  if (!m.ok) { s.error = m.error; s.pending = false; showError(m.key, m.error); updateProgress(); return; }
  if (s.tex) s.tex.forEach(t => gl.deleteTexture(t));
  const mp = m.maps;
  s.maps = { res: mp.res, extent: mp.extent, px: mp.px, hRange: mp.hRange, partCount: mp.partCount, engines: mp.engines, shieldS: mp.shieldS, Dmax: mp.Dmax };
  s.aux = mp.aux;
  s.tex = [tex(mp.albedo, mp.res), tex(mp.nrm, mp.res), tex(mp.emis, mp.res), tex(mp.aux, mp.res)];
  s.spec = m.spec; s.ready = true; s.pending = false; s.error = null;
  s.hits = s.hits || [];
  updateProgress();
  if (state.view === 'detail' && m.key === keyOf(state.brand, state.size)) renderInfo();
  if (STN) STN.onBaked(m.key);
  if (HVY) HVY.onBaked(m.key);
}
function pump() {
  if (!workers.length) {
    if (!queue.length) return;
    const key = queue.shift(), s = ships.get(key); if (!s) return;
    const [b, z] = key.split('|'), q = s.req || { brand: b, size: z, seed: state.seed };
    setTimeout(() => {
      try { const r = q.station ? ShipGen.generateStation(catalog, q.station, q.brand, q.seed) : ShipGen.generate(catalog, q.brand, q.size, q.seed); onResult({ ok: true, key, job: s.job, spec: ShipGen.describe(r.ship), maps: r.maps }); }
      catch (err) { onResult({ ok: false, key, job: s.job, error: String(err.message || err) }); }
      pump();
    }, 0);
    return;
  }
  for (const w of workers) {
    if (busy.has(w) || !queue.length) continue;
    const key = queue.shift(), s = ships.get(key); if (!s) continue;
    const [b, z] = key.split('|'), q = s.req || { brand: b, size: z, seed: state.seed };
    busy.add(w);
    w.postMessage({ key, job: s.job, catalog, brand: q.brand, size: q.size, seed: q.seed, station: q.station });
  }
}
function enqueue(key, front, req) {
  const s = ships.get(key) || {};
  if (req) s.req = req;
  s.job = ++jobCounter; s.pending = true; s.error = null;
  ships.set(key, s);
  const i = queue.indexOf(key); if (i >= 0) queue.splice(i, 1);
  front ? queue.unshift(key) : queue.push(key);
}
function rebakeAll() {
  for (const b of catalog.brands) for (const z of catalog.sizes) enqueue(keyOf(b.id, z.id));
  if (state.view === 'detail') enqueue(keyOf(state.brand, state.size), true);
  updateProgress(); pump();
}
function rebakeBrand(id) {
  for (const z of catalog.sizes) enqueue(keyOf(id, z.id), state.view === 'detail' && state.brand === id && state.size === z.id);
  updateProgress(); pump();
}
function updateProgress() {
  const total = catalog.brands.length * catalog.sizes.length;
  let done = 0; ships.forEach((s, k) => { if (s.ready && !s.pending && !/^(st|hv)\|/.test(k)) done++; });
  const el = $('progress');
  let stPending = 0; ships.forEach((s, k) => { if (/^(st|hv)\|/.test(k) && s.pending) stPending++; });
  el.hidden = done >= total && stPending === 0;
  el.textContent = done < total ? `Baking ${done} of ${total}` : `Baking ${stPending} large asset${stPending === 1 ? '' : 's'}`;
}
function showError(key, msg) { $('json-err').textContent = `Bake failed for ${key.replace('|', ' / ')}: ${msg}`; }

// ---------------- layout ----------------
let W = 0, H = 0, dpr = 1, cells = [];
function resize() {
  const r = canvas.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = r.width; H = r.height;
  canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr));
  buildTargets(); layout();
}
function layout() {
  const ov = $('overlay'); ov.innerHTML = '';
  cells = [];
  if (state.view === 'fly') { /* HUD canvas handles flight overlays */ }
  else if (GENERIC[state.view]) {
    const G = GENERIC[state.view], M = G.mod(), n = M ? M.count() : 0, fk = state[G.focus];
    if (fk >= 0) {
      const cell = Math.min(W, H) * 0.96;
      cells.push({ item: fk, x: (W - cell) / 2, y: (H - cell) / 2, cell, cx: W / 2, cy: H / 2 });
      const info = M && M.label(fk);
      if (info) { const d = document.createElement('div'); d.className = 'detail-cap'; d.innerHTML = `<span>${escapeHtml(info.kind)}</span><b>${escapeHtml(info.name)}</b>`; ov.appendChild(d); }
    } else {
      const cols = W > 1100 ? 4 : W > 640 ? 3 : 2, rows = Math.ceil(n / cols);
      const cell = Math.max(60, Math.min((W - 16) / cols, (H - 16) / rows));
      const gx = (W - cell * cols) / 2, gy = Math.max(8, (H - cell * rows) / 2);
      for (let k = 0; k < n; k++) {
        const c = k % cols, r = Math.floor(k / cols);
        cells.push({ item: k, x: gx + c * cell, y: gy + r * cell, cell, cx: gx + (c + 0.5) * cell, cy: gy + (r + 0.46) * cell });
        const info = M.label(k);
        if (info) { const d = document.createElement('div'); d.className = 'pl-label'; d.style.left = (gx + c * cell) + 'px'; d.style.width = cell + 'px'; d.style.top = (gy + (r + 1) * cell - 24) + 'px'; d.innerHTML = `<b>${escapeHtml(info.name)}</b><small>${escapeHtml(info.kind)}</small>`; ov.appendChild(d); }
      }
      const hv = document.createElement('div'); hv.className = 'hover-box'; hv.id = 'hover-box'; hv.hidden = true; ov.appendChild(hv);
    }
  }
  else if (state.view === 'suns') {
    const n = SUNS ? SUNS.count() : 0;
    if (state.sunFocus >= 0) {
      const cell = Math.min(W, H);
      cells.push({ sun: state.sunFocus, x: 0, y: 0, cell, cx: W / 2, cy: H / 2 });
      const info = SUNS && SUNS.label(state.sunFocus);
      if (info) { const d = document.createElement('div'); d.className = 'detail-cap'; d.innerHTML = `<span>${escapeHtml(info.kind)}</span><b>${escapeHtml(info.name)}</b><small>Drag the star to sweep the lens flare</small>`; ov.appendChild(d); }
    } else {
      const cols = W > 1100 ? 4 : W > 640 ? 3 : 2, rows = Math.ceil(n / cols);
      const cell = Math.max(60, Math.min((W - 16) / cols, (H - 16) / rows));
      const gx = (W - cell * cols) / 2, gy = Math.max(8, (H - cell * rows) / 2);
      for (let k = 0; k < n; k++) {
        const c = k % cols, r = Math.floor(k / cols);
        cells.push({ sun: k, x: gx + c * cell, y: gy + r * cell, cell, cx: gx + (c + 0.5) * cell, cy: gy + (r + 0.46) * cell });
        const info = SUNS.label(k);
        if (info) { const d = document.createElement('div'); d.className = 'pl-label'; d.style.left = (gx + c * cell) + 'px'; d.style.width = cell + 'px'; d.style.top = (gy + (r + 1) * cell - 24) + 'px'; d.innerHTML = `<b>${escapeHtml(info.kind)}</b><small>${escapeHtml(info.name)}</small>`; ov.appendChild(d); }
      }
      const hv = document.createElement('div'); hv.className = 'hover-box'; hv.id = 'hover-box'; hv.hidden = true; ov.appendChild(hv);
    }
  }
  else if (state.view === 'planets') {
    const n = 12;
    if (state.planetFocus >= 0) {
      const cell = Math.min(W, H) * 0.96;
      cells.push({ planet: state.planetFocus, x: (W - cell) / 2, y: (H - cell) / 2, cell, cx: W / 2, cy: H / 2 });
      const info = PLAN && PLAN.label(state.planetFocus);
      if (info) { const d = document.createElement('div'); d.className = 'detail-cap'; d.innerHTML = `<span>${escapeHtml(info.kind)}</span><b>${escapeHtml(info.name)}</b><small>Drag to move the sun</small>`; ov.appendChild(d); }
    } else {
      const cols = W > 1100 ? 4 : W > 640 ? 3 : 2, rows = Math.ceil(n / cols);
      const cell = Math.max(60, Math.min((W - 16) / cols, (H - 16) / rows));
      const gx = (W - cell * cols) / 2, gy = Math.max(8, (H - cell * rows) / 2);
      for (let k = 0; k < n; k++) {
        const c = k % cols, r = Math.floor(k / cols);
        cells.push({ planet: k, x: gx + c * cell, y: gy + r * cell, cell, cx: gx + (c + 0.5) * cell, cy: gy + (r + 0.47) * cell });
        const info = PLAN && PLAN.label(k);
        if (info) { const d = document.createElement('div'); d.className = 'pl-label'; d.style.left = (gx + c * cell) + 'px'; d.style.width = cell + 'px'; d.style.top = (gy + (r + 1) * cell - 24) + 'px'; d.innerHTML = `<b>${escapeHtml(info.name)}</b><small>${escapeHtml(info.kind)}</small>`; ov.appendChild(d); }
      }
      const hv = document.createElement('div'); hv.className = 'hover-box'; hv.id = 'hover-box'; hv.hidden = true; ov.appendChild(hv);
    }
  }
  else if (state.view === 'grid') {
    const cols = catalog.sizes.length, rows = catalog.brands.length;
    const top = 30, side = 8;
    const cell = Math.max(40, Math.min((W - side * 2) / cols, (H - top - 8) / rows));
    const gx = (W - cell * cols) / 2, gy = top + Math.max(0, (H - top - cell * rows) / 2);
    catalog.sizes.forEach((z, c) => {
      const d = document.createElement('div'); d.className = 'col-h';
      d.style.left = (gx + c * cell) + 'px'; d.style.width = cell + 'px'; d.style.top = Math.max(4, gy - 26) + 'px';
      d.innerHTML = `<span>${z.name}</span><small>${z.length} m</small>`; ov.appendChild(d);
    });
    catalog.brands.forEach((b, rI) => {
      const d = document.createElement('div'); d.className = 'row-h';
      d.style.left = (gx + 6) + 'px'; d.style.top = (gy + rI * cell + 6) + 'px';
      d.innerHTML = `<i style="background:${b.style.palette.hull[0]};box-shadow:inset 0 0 0 2px ${b.style.palette.emissive}"></i>${escapeHtml(b.name)}`;
      ov.appendChild(d);
      catalog.sizes.forEach((z, c) => cells.push({ key: keyOf(b.id, z.id), b: b.id, z: z.id, x: gx + c * cell, y: gy + rI * cell, cell, cx: gx + (c + 0.5) * cell, cy: gy + (rI + 0.55) * cell }));
    });
    const hv = document.createElement('div'); hv.className = 'hover-box'; hv.id = 'hover-box'; hv.hidden = true; ov.appendChild(hv);
  } else {
    const b = catalog.brands.find(x => x.id === state.brand), z = catalog.sizes.find(x => x.id === state.size);
    const d = document.createElement('div'); d.className = 'detail-cap';
    d.innerHTML = `<span>${escapeHtml(b.name)}</span><b>${z.name}</b><small>${z.length} m · seed ${escapeHtml(state.seed)}</small>`;
    ov.appendChild(d);
    const cell = Math.min(W, H) * 0.8;
    cells.push({ key: keyOf(b.id, z.id), b: b.id, z: z.id, x: (W - cell) / 2, y: (H - cell) / 2, cell, cx: W / 2, cy: H / 2 + 8 });
  }
  updateHint();
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function updateHint() {
  if (GENERIC[state.view]) { const G = GENERIC[state.view]; $('hint').textContent = state[G.focus] >= 0 ? G.one : G.grid; return; }
  if (state.view === 'suns') { $('hint').textContent = state.sunFocus >= 0 ? 'Drag the star to move it · the lens flare follows' : 'Click a star to open it in the builder'; return; }
  if (state.view === 'planets') { $('hint').textContent = state.planetFocus >= 0 ? 'Drag to move the sun · edit this planet in the side panel' : 'Click a planet to edit it · drag to move the sun'; return; }
  if (state.view === 'fly') { $('hint').textContent = 'W thrust · A D turn · S brake · Shift burn · Space fire · Tab target · F flight model · wheel zoom'; return; }
  const fire = state.view === 'detail' || state.click === 'fire';
  $('hint').textContent = 'Drag to move the sun · hover for a work light · ' + (fire ? 'click a shield to hit it' : 'click a ship to inspect');
}

// ---------------- per-frame helpers ----------------
function sunVec() {
  const az = state.sunAz * Math.PI / 180, el = state.sunEl * Math.PI / 180;
  return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
}
const brandCache = new Map();
function brandRender(b) {
  let c = brandCache.get(b);
  if (!c) {
    const pl = b.style.plume || {}, sh = b.style.shield || {};
    c = {
      plCol: lin(hexRGB(pl.color || b.style.palette.engine)), plCore: lin(hexRGB(pl.core || '#ffffff')),
      plLen: pl.len || 4, plWid: pl.width || 1, plTurb: pl.turb || 0, plDia: pl.diamonds || 0, plSput: pl.sputter || 0, plPulse: pl.pulse || 0, plSpread: pl.spread || 0.3,
      shCol: lin(hexRGB(sh.color || b.style.palette.emissive)), shPat: PATTERNS[sh.pattern] != null ? PATTERNS[sh.pattern] : 0, shStr: sh.strength == null ? 1 : sh.strength
    };
    brandCache.set(b, c);
  }
  return c;
}
const rot = (a, x, y) => [Math.cos(a) * x - Math.sin(a) * y, Math.sin(a) * x + Math.cos(a) * y];
function shipThrottle(i, t) { return Math.min(1, state.throttle * (0.93 + 0.07 * Math.sin(t * 0.7 + i * 1.9))); }
function plumePower(th) { return 0.12 + 1.6 * Math.pow(th, 1.3) + (th > 0.85 ? (th - 0.85) * 4 : 0); }

// shield hits live in ship-local quad space so they ride with the ship
const HIT_LIFE = 2.6;
function addHit(s, qx, qy, now, strength) {
  s.hits = (s.hits || []).filter(h => now - h.t0 < HIT_LIFE);
  if (s.hits.length >= 8) s.hits.shift();
  s.hits.push({ qx, qy, t0: now, str: strength || 1 });
}
function fieldAt(s, qx, qy) { // meters from hull, from the CPU copy of the bake
  const r = s.maps.res, ix = Math.max(0, Math.min(r - 1, Math.floor((qx * 0.5 + 0.5) * r))), iy = Math.max(0, Math.min(r - 1, Math.floor((0.5 - qy * 0.5) * r)));
  return s.aux[(iy * r + ix) * 4] / 255 * s.maps.Dmax;
}
function shellPointToward(s, qx, qy) { // walk from the clicked point toward ship center until inside the shell
  let x = qx, y = qy;
  for (let i = 0; i < 60; i++) { if (fieldAt(s, x, y) <= s.maps.shieldS) return [x, y]; x *= 0.96; y *= 0.96; }
  return [x, y];
}
function shellPointRandom(s) {
  const a = Math.random() * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
  let last = [0, 0];
  for (let r = 0; r < 1; r += 0.01) { if (fieldAt(s, dx * r, dy * r) >= s.maps.shieldS) return last; last = [dx * r, dy * r]; }
  return last;
}

// ---------------- render ----------------
const t0 = performance.now();
let lastBarrage = 0;
function frame(now) {
  if (state.view === 'fly') {
    if (FLY) { try { FLY.frame(now); } catch (e) { console.error(e); FLY_ERR = String(e.message || e); FLY = null; } }
    if (!FLY) $('hint').textContent = 'Flight mode failed to start: ' + FLY_ERR;
    requestAnimationFrame(frame); return;
  }
  if (GENERIC[state.view]) {
    const G = GENERIC[state.view], M = G.mod();
    if (M) { try { M.frame(now); } catch (e) { console.error(e); $('hint').textContent = state.view + ' failed: ' + (e.message || e); } }
    else $('hint').textContent = state.view + ' failed to start: ' + G.err();
    requestAnimationFrame(frame); return;
  }
  if (state.view === 'suns') {
    if (SUNS) { try { SUNS.frame(now); } catch (e) { console.error(e); SUNS_ERR = String(e.message || e); SUNS = null; } }
    if (!SUNS) $('hint').textContent = 'Suns failed to start: ' + SUNS_ERR;
    requestAnimationFrame(frame); return;
  }
  if (state.view === 'planets') {
    if (PLAN) { try { PLAN.frame(now); } catch (e) { console.error(e); PLAN_ERR = String(e.message || e); PLAN = null; } }
    if (!PLAN) $('hint').textContent = 'Planets failed to start: ' + PLAN_ERR;
    requestAnimationFrame(frame); return;
  }
  gl.bindVertexArray(null);
  const t = (now - t0) / 1000;
  const nowS = now / 1000;
  const star = STARS[state.star];
  const sunCol = lin(star.col), amb = star.amb;
  const sv = sunVec(); const sl = Math.hypot(sv[0], sv[1]) || 1;
  const RW = canvas.width, RH = canvas.height;

  let maxExt = 1; ships.forEach((s, k) => { if (s.ready && !/^(st|hv)\|/.test(k)) maxExt = Math.max(maxExt, s.maps.extent); });
  // resolve each visible ship's transform for this frame
  const vis = [];
  cells.forEach((c, i) => {
    const s = ships.get(c.key); if (!s || !s.ready) return;
    const brand = catalog.brands.find(b => b.id === c.b); if (!brand) return;
    let half = (state.view === 'grid' && state.trueScale) ? (s.maps.extent * (c.cell * 0.98 / maxExt)) / 2 : c.cell * 0.5;
    const hd = half * dpr;
    const ang = state.spin ? t * (state.view === 'grid' ? 0.2 : 0.1) + i * 0.9 : 0;
    const cx = c.cx * dpr, cy = (H - c.cy) * dpr;
    c.ang = ang; c.half = half;
    vis.push({ c, s, brand, br: brandRender(brand), hd, ang, cx, cy, i, th: shipThrottle(i, t) });
  });

  // barrage: random hits across visible ships
  if (state.barrage && state.shields && nowS - lastBarrage > (state.view === 'grid' ? 0.18 : 0.35) && vis.length) {
    lastBarrage = nowS;
    const v = vis[Math.floor(Math.random() * vis.length)];
    const p = shellPointRandom(v.s); addHit(v.s, p[0], p[1], nowS, 0.7 + Math.random() * 0.6);
  }

  // ---- light list (device px, y up) ----
  const lights = [];
  if (state.pl && state.mouse) lights.push({ x: state.mouse.x * dpr, y: (H - state.mouse.y) * dpr, z: 110 * dpr, r: 220 * dpr, c: [1.6, 1.25, 0.85] });
  const drift = [];
  for (let k = 0; k < state.lightsN; k++) {
    const ph = k * 2.399;
    const x = RW * (0.5 + 0.44 * Math.cos(t * (0.13 + k * 0.017) + ph)), y = RH * (0.5 + 0.42 * Math.sin(t * (0.11 + k * 0.023) + ph * 1.7));
    const col = DRIFT_COLS[k % DRIFT_COLS.length];
    const L = { x, y, z: 70 * dpr, r: 170 * dpr, c: col.map(v => v * 2.4), col };
    lights.push(L); drift.push(L);
  }
  for (const v of vis) {
    if (state.map !== 0) break;
    const eng = v.s.maps.engines; if (!eng.length) continue;
    let ux = 0, uy = 0; eng.forEach(e => { ux += e.u; uy += e.v; }); ux /= eng.length; uy /= eng.length;
    const q = rot(v.ang, (ux - 0.5) * 2 * v.hd, (0.5 - uy) * 2 * v.hd);
    const d = rot(v.ang, 0, -1);
    const pw = plumePower(v.th);
    lights.push({ x: v.cx + q[0] + d[0] * v.hd * 0.12, y: v.cy + q[1] + d[1] * v.hd * 0.12, z: 14 * dpr, r: v.hd * 0.55, c: v.br.plCol.map(c => c * 1.4 * pw), owner: v });
    if (state.shields) for (const h of v.s.hits || []) {
      const age = nowS - h.t0; if (age > 0.6) continue;
      const hq = rot(v.ang, h.qx * v.hd, h.qy * v.hd);
      lights.push({ x: v.cx + hq[0], y: v.cy + hq[1], z: 24 * dpr, r: v.hd * 0.45, c: v.br.shCol.map(c => c * 5 * Math.exp(-age * 5) * h.str) });
    }
  }

  // ---- scene pass ----
  gl.bindFramebuffer(gl.FRAMEBUFFER, scene.f);
  gl.viewport(0, 0, RW, RH);
  gl.disable(gl.BLEND);
  gl.useProgram(P.bg.p);
  gl.uniform2f(P.bg.u.uRes, RW, RH); gl.uniform1f(P.bg.u.uTime, t);
  gl.uniform3fv(P.bg.u.uStar, star.col); gl.uniform3fv(P.bg.u.uNeb, star.neb);
  gl.uniform2f(P.bg.u.uSunDir, sv[0] / sl, sv[1] / sl);
  gl.uniform2f(P.bg.u.uOff, 0, 0);
  draw();
  gl.enable(gl.BLEND);

  // plumes (additive, under the hulls)
  if (state.map === 0) {
    gl.blendFunc(gl.ONE, gl.ONE);
    const u = P.plume.u; gl.useProgram(P.plume.p);
    gl.uniform2f(u.uRes, RW, RH); gl.uniform1f(u.uTime, t);
    for (const v of vis) {
      const br = v.br, pw = plumePower(v.th), boost = v.th > 0.85 ? 1 + (v.th - 0.85) * 3 : 1;
      gl.uniform3fv(u.uCol, br.plCol);
      const core = br.plCore.map((c, k) => c + (1 - c) * (boost - 1) * 0.8);
      gl.uniform3fv(u.uCore, core);
      gl.uniform1f(u.uTurb, br.plTurb); gl.uniform1f(u.uDiamonds, br.plDia); gl.uniform1f(u.uSputter, br.plSput); gl.uniform1f(u.uPulse, br.plPulse); gl.uniform1f(u.uSpread, br.plSpread);
      gl.uniform1f(u.uPower, pw);
      v.s.maps.engines.forEach((e, k) => {
        const q = rot(v.ang, (e.u - 0.5) * 2 * v.hd, (0.5 - e.v) * 2 * v.hd);
        const d = rot(v.ang, e.dx, e.dy);
        const wid = Math.max(e.w * 2 * v.hd, 1.5 * dpr);
        gl.uniform2f(u.uNoz, v.cx + q[0], v.cy + q[1]); gl.uniform2f(u.uDir, d[0], d[1]);
        gl.uniform1f(u.uWid, wid * br.plWid * 1.1);
        gl.uniform1f(u.uLen, wid * br.plLen * (0.3 + 1.7 * v.th) * boost);
        gl.uniform1f(u.uSeed, v.i * 7.3 + k * 1.37);
        draw();
      });
    }
  }

  // hulls (premultiplied over)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  {
    const u = P.ship.u; gl.useProgram(P.ship.p);
    gl.uniform2f(u.uRes, RW, RH);
    gl.uniform3fv(u.uSun, sv); gl.uniform3fv(u.uSunCol, sunCol); gl.uniform3fv(u.uAmb, amb);
    gl.uniform1f(u.uTime, t); gl.uniform1i(u.uMode, state.map);
    gl.uniform1f(u.uShadow, state.shadow ? 1 : 0);
    gl.uniform1i(u.uA, 0); gl.uniform1i(u.uN, 1); gl.uniform1i(u.uE, 2); gl.uniform1i(u.uX, 3);
    const LP = new Float32Array(64), LC = new Float32Array(64);
    for (const v of vis) {
      const m = v.brand.style.material;
      // pick the 16 most relevant lights for this ship
      const reach = v.hd * 1.5;
      const cand = lights.map(L => { const d = Math.hypot(L.x - v.cx, L.y - v.cy); return { L, d, w: (L.c[0] + L.c[1] + L.c[2]) * L.r / (d + L.r) }; })
        .filter(o => o.d < reach + o.L.r * 4).sort((a, b) => b.w - a.w).slice(0, 16);
      cand.forEach((o, k) => { LP.set([o.L.x, o.L.y, o.L.z, o.L.r], k * 4); LC.set([o.L.c[0], o.L.c[1], o.L.c[2], 0], k * 4); });
      gl.uniform4fv(u.uLP, LP); gl.uniform4fv(u.uLC, LC); gl.uniform1i(u.uLN, cand.length);
      gl.uniform2f(u.uCenter, v.cx, v.cy); gl.uniform1f(u.uHalf, v.hd); gl.uniform1f(u.uAngle, v.ang);
      gl.uniform1f(u.uExtent, v.s.maps.extent); gl.uniform1f(u.uHRange, v.s.maps.hRange);
      gl.uniform1f(u.uPxPerM, 2 * v.hd / v.s.maps.extent);
      gl.uniform1f(u.uDmax, v.s.maps.Dmax); gl.uniform1f(u.uS, v.s.maps.shieldS);
      gl.uniform1f(u.uGloss, m.gloss); gl.uniform1f(u.uSpecK, 0.6 + m.spec * 1.4);
      gl.uniform1f(u.uWrap, m.wrap); gl.uniform1f(u.uIrid, m.irid); gl.uniform1f(u.uRim, m.rim);
      gl.uniform1f(u.uThrottle, v.th);
      gl.uniform1f(u.uHover, state.hoverKey === v.c.key && state.view === 'grid' ? 1 : 0);
      for (let k = 0; k < 4; k++) { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, v.s.tex[k]); }
      draw();
    }
  }

  // shields + light markers (additive)
  gl.blendFunc(gl.ONE, gl.ONE);
  if (state.map === 0 && state.shields) {
    const u = P.shield.u; gl.useProgram(P.shield.p);
    gl.uniform2f(u.uRes, RW, RH); gl.uniform1f(u.uTime, t); gl.uniform1i(u.uX, 0);
    const HU = new Float32Array(32);
    for (const v of vis) {
      v.s.hits = (v.s.hits || []).filter(h => nowS - h.t0 < HIT_LIFE);
      for (let k = 0; k < 8; k++) {
        const h = v.s.hits[k];
        if (h) HU.set([h.qx, h.qy, nowS - h.t0, h.str], k * 4); else HU.set([0, 0, -1, 0], k * 4);
      }
      gl.uniform4fv(u.uHits, HU);
      gl.uniform2f(u.uCenter, v.cx, v.cy); gl.uniform1f(u.uHalf, v.hd); gl.uniform1f(u.uAngle, v.ang);
      gl.uniform1f(u.uExtent, v.s.maps.extent); gl.uniform1f(u.uS, v.s.maps.shieldS); gl.uniform1f(u.uDmax, v.s.maps.Dmax);
      gl.uniform1f(u.uIdle, state.shieldIdle); gl.uniform1f(u.uStrength, v.br.shStr); gl.uniform1f(u.uSeed, v.i * 3.7);
      gl.uniform3fv(u.uCol, v.br.shCol); gl.uniform1i(u.uPat, v.br.shPat);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, v.s.tex[3]);
      draw();
    }
  }
  if (drift.length) {
    const u = P.mark.u; gl.useProgram(P.mark.p);
    gl.uniform2f(u.uRes, RW, RH); gl.uniform1f(u.uSz, 26 * dpr);
    for (const L of drift) { gl.uniform2f(u.uC, L.x, L.y); gl.uniform3fv(u.uCol, L.col.map(c => c * 1.2)); draw(); }
  }
  gl.disable(gl.BLEND);

  postProcess();
  requestAnimationFrame(frame);
}
function postProcess() {
  gl.bindVertexArray(null);
  const RW = canvas.width, RH = canvas.height;
  // ---- bloom ----
  const useBloom = state.bloom > 0.001;
  if (useBloom) {
    gl.useProgram(P.bright.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, chain[0].f); gl.viewport(0, 0, chain[0].w, chain[0].h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, scene.t);
    gl.uniform1i(P.bright.u.uSrc, 0); gl.uniform2f(P.bright.u.uTexel, 1 / RW, 1 / RH); gl.uniform1f(P.bright.u.uThresh, HDR ? 0.9 : 0.7);
    draw();
    gl.useProgram(P.down.p); gl.uniform1i(P.down.u.uSrc, 0);
    for (let i = 1; i < chain.length; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, chain[i].f); gl.viewport(0, 0, chain[i].w, chain[i].h);
      gl.bindTexture(gl.TEXTURE_2D, chain[i - 1].t); gl.uniform2f(P.down.u.uTexel, 1 / chain[i - 1].w, 1 / chain[i - 1].h);
      draw();
    }
    gl.useProgram(P.up.p); gl.uniform1i(P.up.u.uSrc, 0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = chain.length - 1; i > 0; i--) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, chain[i - 1].f); gl.viewport(0, 0, chain[i - 1].w, chain[i - 1].h);
      gl.bindTexture(gl.TEXTURE_2D, chain[i].t); gl.uniform2f(P.up.u.uTexel, 1 / chain[i].w, 1 / chain[i].h);
      draw();
    }
    gl.disable(gl.BLEND);
  }

  // ---- composite ----
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, RW, RH);
  gl.useProgram(P.comp.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, scene.t);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, chain[0].t);
  gl.uniform1i(P.comp.u.uScene, 0); gl.uniform1i(P.comp.u.uBloom, 1);
  gl.uniform1f(P.comp.u.uBloomK, useBloom ? state.bloom * 0.55 : 0);
  gl.uniform1f(P.comp.u.uExposure, 1.15);
  draw();
}

/*FLY*/
/*PLANETS*/
/*SUNS*/
/*STATIONS*/
/*ASTEROIDS*/

// Grid-and-builder tabs that share layout, hover and click handling
const GENERIC = {
  stations: { mod: () => STN, err: () => STN_ERR, focus: 'stFocus', grid: 'Click a station to open it in the builder · drag to move the sun', one: 'Drag to move the sun · hover for a work light' },
  heavies: { mod: () => HVY, err: () => HVY_ERR, focus: 'hvFocus', grid: 'Click a ship to open it in the builder · throttle lives under Drives and effects', one: 'Drag to move the sun · hover for a work light' },
  asteroids: { mod: () => AST, err: () => AST_ERR, focus: 'astFocus', grid: 'Sizes are to scale within the set · click one to open it in the builder', one: 'Drag to move the sun' }
};

// ---------------- interaction ----------------
let drag = null;
function cellAt(x, y) { return cells.find(c => x >= c.x && x < c.x + c.cell && y >= c.y && y < c.y + c.cell); }
function setSunFromPointer(x, y) {
  const dx = x - W / 2, dy = (H / 2) - y;
  state.sunAz = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
  const rr = Math.min(1, Math.hypot(dx, dy) / (Math.min(W, H) * 0.5));
  state.sunEl = Math.round(80 - rr * 72);
  syncSunControls();
}
function fireAt(c, x, y) {
  const s = ships.get(c.key); if (!s || !s.ready || c.half == null) return;
  const dx = x - c.cx, dy = c.cy - y;
  const q = rot(-c.ang, dx / c.half, dy / c.half);
  if (Math.abs(q[0]) > 1 || Math.abs(q[1]) > 1) return;
  const p = shellPointToward(s, q[0], q[1]);
  addHit(s, p[0], p[1], performance.now() / 1000, 1.2);
}
canvas.addEventListener('pointermove', e => {
  if (state.view === 'fly') return;
  const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
  state.mouse = { x, y };
  if (drag) {
    if (Math.hypot(x - drag.x, y - drag.y) > 5) drag.moved = true;
    if (drag.moved) { if (state.view === 'suns' && state.sunFocus >= 0) state.sunOff = [(x - W / 2) / W, (H / 2 - y) / H]; else setSunFromPointer(x, y); }
  }
  if (GENERIC[state.view]) {
    const fk = state[GENERIC[state.view].focus], c = fk < 0 ? cellAt(x, y) : null, hb = $('hover-box');
    state.hoverItem = c ? c.item : -1;
    if (hb) { if (c) { hb.hidden = false; hb.style.left = c.x + 'px'; hb.style.top = c.y + 'px'; hb.style.width = hb.style.height = c.cell + 'px'; } else hb.hidden = true; }
    canvas.style.cursor = drag && drag.moved ? 'grabbing' : c ? 'pointer' : 'crosshair';
  } else if (state.view === 'suns') {
    const c = state.sunFocus < 0 ? cellAt(x, y) : null, hb = $('hover-box');
    if (hb) { if (c) { hb.hidden = false; hb.style.left = c.x + 'px'; hb.style.top = c.y + 'px'; hb.style.width = hb.style.height = c.cell + 'px'; } else hb.hidden = true; }
    canvas.style.cursor = drag && drag.moved ? 'grabbing' : c ? 'pointer' : (state.sunFocus >= 0 ? 'grab' : 'crosshair');
  } else if (state.view === 'planets') {
    const c = state.planetFocus < 0 ? cellAt(x, y) : null, hb = $('hover-box');
    if (hb) { if (c) { hb.hidden = false; hb.style.left = c.x + 'px'; hb.style.top = c.y + 'px'; hb.style.width = hb.style.height = c.cell + 'px'; } else hb.hidden = true; }
    canvas.style.cursor = drag && drag.moved ? 'grabbing' : c ? 'pointer' : 'crosshair';
  } else if (state.view === 'grid') {
    const c = cellAt(x, y); state.hoverKey = c ? c.key : null;
    const hb = $('hover-box');
    if (hb) { if (c && state.click === 'inspect') { hb.hidden = false; hb.style.left = c.x + 'px'; hb.style.top = c.y + 'px'; hb.style.width = hb.style.height = c.cell + 'px'; } else hb.hidden = true; }
    canvas.style.cursor = drag && drag.moved ? 'grabbing' : c ? (state.click === 'fire' ? 'crosshair' : 'pointer') : 'default';
  } else canvas.style.cursor = drag && drag.moved ? 'grabbing' : 'crosshair';
});
canvas.addEventListener('pointerleave', () => { state.mouse = null; state.hoverKey = null; const hb = $('hover-box'); if (hb) hb.hidden = true; });
canvas.addEventListener('pointerdown', e => {
  if (state.view === 'fly') { canvas.focus(); return; }
  const r = canvas.getBoundingClientRect(); drag = { x: e.clientX - r.left, y: e.clientY - r.top, moved: false };
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
});
canvas.addEventListener('pointerup', e => {
  if (state.view === 'fly') return;
  const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
  if (drag && !drag.moved && GENERIC[state.view]) { const G = GENERIC[state.view], M = G.mod(), c = cellAt(x, y); if (c && state[G.focus] < 0 && M) M.focus(c.item); drag = null; return; }
  if (drag && !drag.moved && state.view === 'suns') { const c = cellAt(x, y); if (c && state.sunFocus < 0 && SUNS) SUNS.focus(c.sun); drag = null; return; }
  if (drag && !drag.moved && state.view === 'planets') { const c = cellAt(x, y); if (c && state.planetFocus < 0 && PLAN) PLAN.focus(c.planet); drag = null; return; }
  if (drag && !drag.moved) {
    const c = cellAt(x, y);
    if (c) { if (state.view === 'grid' && state.click === 'inspect') openDetail(c.b, c.z); else fireAt(c, x, y); }
  }
  drag = null;
});

function openDetail(b, z) {
  state.brand = b; state.size = z; state.editBrand = b; setView('detail');
  const key = keyOf(b, z); const s = ships.get(key);
  if (!s || !s.ready) { const i = queue.indexOf(key); if (i > 0) { queue.splice(i, 1); queue.unshift(key); } }
  renderBrandCards(); loadEditor();
}
function setView(v) {
  if (state.view === 'fly' && v !== 'fly' && FLY) FLY.clearKeys();
  state.view = v;
  $('fly-panel').hidden = v !== 'fly';
  $('planet-panel').hidden = v !== 'planets';
  $('sun-panel').hidden = v !== 'suns';
  $('station-panel').hidden = v !== 'stations';
  $('heavy-panel').hidden = v !== 'heavies';
  $('asteroid-panel').hidden = v !== 'asteroids';
  if (GENERIC[v] && GENERIC[v].mod()) GENERIC[v].mod().sync();
  if (v === 'suns' && SUNS) SUNS.sync();
  document.querySelectorAll('[data-hide]').forEach(el => { el.hidden = el.dataset.hide.split(' ').includes(v); });
  if (v === 'planets' && PLAN) PLAN.sync();
  $('touch').hidden = v !== 'fly';
  $('hud').hidden = v !== 'fly';
  if (v === 'fly') { state.mouse = null; canvas.focus(); }
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  $('detail-panel').hidden = v !== 'detail';
  $('opt-truescale').disabled = v !== 'grid';
  layout(); renderInfo();
}

// ---------------- panel ----------------
function seg(containerId, items, get, set) {
  const el = $(containerId); el.innerHTML = '';
  items.forEach(([val, label]) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.setAttribute('aria-pressed', String(get() === val));
    b.addEventListener('click', () => { set(val); el.querySelectorAll('button').forEach((x, i) => x.setAttribute('aria-pressed', String(items[i][0] === get()))); });
    el.appendChild(b);
  });
}
seg('seg-map', [[0, 'Lit'], [1, 'Albedo'], [2, 'Normal'], [3, 'Height'], [4, 'Emissive'], [5, 'Field']], () => state.map, v => { state.map = v; });
seg('seg-star', Object.keys(STARS).map(k => [k, STARS[k].name]), () => state.star, v => { state.star = v; });
seg('seg-click', [['inspect', 'Inspect'], ['fire', 'Fire']], () => state.click, v => { state.click = v; updateHint(); });
function bindToggle(id, key) { const el = $(id); el.checked = state[key]; el.addEventListener('change', () => { state[key] = el.checked; }); }
bindToggle('opt-spin', 'spin'); bindToggle('opt-truescale', 'trueScale'); bindToggle('opt-shadow', 'shadow'); bindToggle('opt-pl', 'pl');
bindToggle('opt-shields', 'shields'); bindToggle('opt-barrage', 'barrage');
function bindRange(id, key, fmt, scale) {
  const el = $(id), out = $(id + '-v'); scale = scale || 1;
  const sync = () => { out.textContent = fmt(state[key]); };
  el.value = state[key] * scale; sync();
  el.addEventListener('input', () => { state[key] = +el.value / scale; sync(); });
}
bindRange('throttle', 'throttle', v => v > 0.85 ? 'Burn' : Math.round(v * 100) + '%', 100);
bindRange('bloom', 'bloom', v => v.toFixed(2), 100);
bindRange('lights', 'lightsN', v => String(v), 1);
bindRange('shield-idle', 'shieldIdle', v => Math.round(v * 100) + '%', 100);
function syncSunControls() { $('sun-az').value = Math.round(state.sunAz); $('sun-el').value = state.sunEl; $('sun-az-v').textContent = Math.round(state.sunAz) + '°'; $('sun-el-v').textContent = state.sunEl + '°'; }
$('sun-az').addEventListener('input', e => { state.sunAz = +e.target.value; syncSunControls(); });
$('sun-el').addEventListener('input', e => { state.sunEl = +e.target.value; syncSunControls(); });
syncSunControls();

document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('seed').value = state.seed;
$('seed').addEventListener('change', e => { state.seed = e.target.value.trim() || 'kestrel-7'; rebakeAll(); layout(); });
const WORDS = ['kestrel', 'ember', 'lattice', 'drift', 'cinder', 'halo', 'marrow', 'vesper', 'quarry', 'tern', 'basalt', 'lumen', 'sable', 'orrery'];
$('reseed').addEventListener('click', () => {
  state.seed = WORDS[Math.floor(Math.random() * WORDS.length)] + '-' + Math.floor(Math.random() * 900 + 100);
  $('seed').value = state.seed; rebakeAll(); layout();
});
$('prev-size').addEventListener('click', () => stepDetail(0, -1));
$('next-size').addEventListener('click', () => stepDetail(0, 1));
$('prev-brand').addEventListener('click', () => stepDetail(-1, 0));
$('next-brand').addEventListener('click', () => stepDetail(1, 0));
function stepDetail(db, dz) {
  const bi = catalog.brands.findIndex(b => b.id === state.brand), zi = catalog.sizes.findIndex(z => z.id === state.size);
  const nb = catalog.brands[(bi + db + catalog.brands.length) % catalog.brands.length].id;
  const nz = catalog.sizes[(zi + dz + catalog.sizes.length) % catalog.sizes.length].id;
  openDetail(nb, nz);
}

function renderBrandCards() {
  const el = $('brands'); el.innerHTML = '';
  catalog.brands.forEach(b => {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'brand';
    card.setAttribute('aria-pressed', String(state.editBrand === b.id));
    const sw = [...b.style.palette.hull, b.style.palette.trim, b.style.palette.emissive].map(c => `<i style="background:${c}"></i>`).join('');
    const pl = b.style.plume || {}, sh = b.style.shield || {};
    card.innerHTML = `<span class="b-top"><b>${escapeHtml(b.name)}</b><small>${escapeHtml(b.kind)}</small></span><span class="b-blurb">${escapeHtml(b.blurb)}</span><span class="b-meta"><span class="sw">${sw}</span><small>${b.parts.length} parts · ${b.style.union} union · ${escapeHtml(sh.pattern || 'hex')} shield</small></span>`;
    card.addEventListener('click', () => { state.editBrand = b.id; renderBrandCards(); loadEditor(); });
    el.appendChild(card);
  });
}
function loadEditor() {
  const b = catalog.brands.find(x => x.id === state.editBrand);
  $('json-title').textContent = b.name;
  $('json').value = JSON.stringify(b, null, 2);
  $('json-err').textContent = '';
}
$('json-apply').addEventListener('click', () => {
  let nb;
  try { nb = JSON.parse($('json').value); } catch (e) { $('json-err').textContent = 'Invalid JSON: ' + e.message; return; }
  const problems = [];
  if (nb.id !== state.editBrand) problems.push(`keep "id" as "${state.editBrand}"`);
  if (!nb.style || !nb.style.palette || !Array.isArray(nb.style.palette.hull)) problems.push('style.palette.hull must be an array of colors');
  if (!Array.isArray(nb.parts)) problems.push('parts must be an array');
  if (!nb.loadout || !nb.core) problems.push('core and loadout are required');
  if (nb.core) for (const z of catalog.sizes) { const ids = nb.core[z.id] || []; if (!ids.some(id => (nb.parts || []).some(p => p.id === id && p.role === 'core'))) problems.push(`core.${z.id} names no core part`); }
  if (problems.length) { $('json-err').textContent = 'Fix: ' + problems.join('; '); return; }
  const i = catalog.brands.findIndex(x => x.id === nb.id); catalog.brands[i] = nb;
  $('json-err').textContent = 'Applied. Rebaking ' + nb.name + '.';
  renderBrandCards(); layout(); rebakeBrand(nb.id);
});
$('json-revert').addEventListener('click', () => {
  const orig = CATALOG0.brands.find(x => x.id === state.editBrand);
  const i = catalog.brands.findIndex(x => x.id === state.editBrand);
  catalog.brands[i] = JSON.parse(JSON.stringify(orig));
  loadEditor(); $('json-err').textContent = 'Reverted to the shipped catalog.'; renderBrandCards(); layout(); rebakeBrand(orig.id);
});

function renderInfo() {
  if (state.view !== 'detail') return;
  const s = ships.get(keyOf(state.brand, state.size));
  const b = catalog.brands.find(x => x.id === state.brand), z = catalog.sizes.find(x => x.id === state.size);
  $('d-title').textContent = `${b.name} ${z.name}`;
  if (!s || !s.ready || s.pending) { $('d-stats').innerHTML = '<dt>Status</dt><dd>Baking…</dd>'; $('d-spec').textContent = ''; $('d-roles').innerHTML = ''; return; }
  const roles = {}; s.spec.parts.forEach(p => { roles[p.role] = (roles[p.role] || 0) + 1; });
  const rows = [['Length', z.length + ' m'], ['Core', s.spec.core], ['Parts', s.maps.partCount], ['Engines', s.maps.engines.length], ['Bake', `${s.maps.res}² px`], ['Resolution', (s.maps.res / s.maps.extent).toFixed(2) + ' px/m'], ['Relief', s.maps.hRange.toFixed(1) + ' m'], ['Shield standoff', s.maps.shieldS.toFixed(1) + ' m']];
  $('d-stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  $('d-roles').innerHTML = Object.entries(roles).map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
  $('d-spec').textContent = JSON.stringify(s.spec, null, 1);
}

// ---------------- flight controls ----------------
function fillSelect(id, items, val) { const el = $(id); el.innerHTML = items.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join(''); el.value = val; }
fillSelect('fly-brand', catalog.brands.map(b => [b.id, b.name]), state.flyBrand);
fillSelect('fly-size', catalog.sizes.map(z => [z.id, z.name]), state.flySize);
$('fly-brand').addEventListener('change', e => { state.flyBrand = e.target.value; if (FLY) FLY.swapPlayer(); canvas.focus(); });
$('fly-size').addEventListener('change', e => { state.flySize = e.target.value; if (FLY) FLY.swapPlayer(); canvas.focus(); });
function syncFlightModel() { $('seg-fm').querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(['assist', 'newton'][i] === state.flightModel))); }
seg('seg-fm', [['assist', 'Assisted'], ['newton', 'Newtonian']], () => state.flightModel, v => { state.flightModel = v; canvas.focus(); });
bindRange('traffic', 'traffic', v => String(v), 1);
$('traffic').addEventListener('change', () => { if (FLY) FLY.reset(); });
bindRange('zoom', 'zoom', v => Math.round(v * 100) + '%', 100);
function setZoom(z) { state.zoom = Math.max(0.25, Math.min(4, z)); $('zoom').value = state.zoom * 100; $('zoom-v').textContent = Math.round(state.zoom * 100) + '%'; }
$('opt-pirates').checked = state.pirates;
$('opt-pirates').addEventListener('change', e => { state.pirates = e.target.checked; if (FLY) FLY.calm(); });
$('fly-reset').addEventListener('click', () => { if (FLY) FLY.reset(); canvas.focus(); });
$('fly-calm').addEventListener('click', () => { if (FLY) FLY.calm(); canvas.focus(); });
canvas.addEventListener('wheel', e => { if (state.view !== 'fly') return; e.preventDefault(); setZoom(state.zoom * Math.exp(-e.deltaY * 0.0012)); }, { passive: false });
const typing = el => el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'range' && el.type !== 'checkbox';
window.addEventListener('keydown', e => { if (state.view !== 'fly' || !FLY || typing(e.target)) return; FLY.key(e.code, true, e); });
window.addEventListener('keyup', e => { if (state.view !== 'fly' || !FLY) return; FLY.key(e.code, false, e); });
window.addEventListener('blur', () => { if (FLY) FLY.clearKeys(); });
document.querySelectorAll('#touch [data-code]').forEach(b => {
  const code = b.dataset.code;
  const on = e => { e.preventDefault(); if (FLY) FLY.key(code, true); b.setAttribute('aria-pressed', 'true'); };
  const off = () => { if (FLY) FLY.key(code, false); b.setAttribute('aria-pressed', 'false'); };
  b.addEventListener('pointerdown', on); ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, off));
});

// ---------------- boot ----------------
new ResizeObserver(resize).observe(canvas);
resize();
renderBrandCards(); loadEditor();
setView('grid');
rebakeAll();
requestAnimationFrame(frame);
})();
