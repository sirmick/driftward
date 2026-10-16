// ======================= SHADERS =======================
// GLSL sources shared by the lab (index.html) and the game (play.html). Plain strings, compiled by each page's
// graphics kit (gfx.js). Lab-only shaders for planets and stations live in their own modules; the stars' in stars.js and asteroids' in rocks.js, shared.

// ---------- common: noise, full-screen pass, starfield ----------
const NOISE = `
float h21(vec2 p){ p=fract(p*vec2(443.897,441.423)); p+=dot(p,p.yx+19.19); return fract((p.x+p.y)*p.x); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<5;i++){ s+=a*vn(p); p=p*2.03+1.3; a*=.5; } return s; }`;

// 3D value noise, fbm, ridged noise and Worley cells, for the suns' and the rocks' shaders (rocks.js)
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
const FS_VS = `#version 300 es
in vec2 aPos; out vec2 vUv; void main(){ vUv=aPos*0.5+0.5; gl_Position=vec4(aPos,0.,1.); }`;

// Shared sky: the plain background and the black-hole lens both sample it, so lensed stars match the sky around them.
const SKY = `uniform vec2 uRes; uniform float uTime; uniform vec3 uStar; uniform vec3 uNeb; uniform vec2 uSunDir; uniform vec2 uOff;
${NOISE}
float starK = 1.; // the stars' brightness (the background dims them near worlds, so orbiting debris reads)
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
    c += sc3*b*(.6-.15*float(l))*starK;
  }
  return c;
}`;
const BG_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
${SKY}
// worlds near the view, in screen pixels (centre, radius): stars fade out toward each one's limb, almost gone there
// and back in full by about 2.6 radii, past its orbiting debris
uniform vec4 uDim[4]; uniform int uDimN;
void main(){
  vec2 p = vUv*uRes;
  for (int i = 0; i < 4; i++) { if (i >= uDimN) break; starK *= mix(.05, 1., smoothstep(1., 2.6, length(p - uDim[i].xy)/uDim[i].z)); }
  o = vec4(sky(p + uOff), 1.);
}`;

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
  // the quad carries the shield margin: skip the shadow march and lights where there is no hull (after the
  // fetches above, which need the whole quad for their mip derivatives)
  if (A.a < 1./255.) discard;
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
// The bloom chain's input guard. Each level halves the resolution, so one NaN or infinite scene pixel would
// spread into squares of 2 to 64 pixels (the flashing black squares some GPUs showed): drop non-finite
// samples, and cap very hot ones so a single bright pixel cannot dominate a block either.
vec3 tap(vec2 uv){ vec3 v = texture(uSrc, uv).rgb; return (any(isnan(v)) || any(isinf(v))) ? vec3(0.) : clamp(v, 0., 256.); }
void main(){
  vec3 s = (tap(vUv+uTexel*vec2(-1.,-1.)) + tap(vUv+uTexel*vec2(1.,-1.)) + tap(vUv+uTexel*vec2(-1.,1.)) + tap(vUv+uTexel*vec2(1.,1.)))*.25;
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
uniform sampler2D uScene, uBloom; uniform float uBloomK, uExposure; uniform int uDebug;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.); }
bool bad(vec3 v){ return any(isnan(v)) || any(isinf(v)); }
void main(){
  vec3 sc = texture(uScene, vUv).rgb, bl = texture(uBloom, vUv).rgb;
  // debug view: non-finite scene pixels magenta, non-finite bloom cyan, negative scene values yellow
  if (uDebug == 1) {
    if (bad(sc)) { o = vec4(1.,0.,1.,1.); return; }
    if (bad(bl)) { o = vec4(0.,1.,1.,1.); return; }
    if (min(sc.r, min(sc.g, sc.b)) < 0.) { o = vec4(1.,1.,0.,1.); return; }
  }
  if (bad(bl)) bl = vec3(0.); // belt and braces: a bad bloom texel loses its glow rather than blacking out
  vec3 c = sc + bl*uBloomK;
  c = aces(c*uExposure);
  vec2 q = vUv-.5; c *= 1. - dot(q,q)*.35;
  o = vec4(pow(c, vec3(1./2.2)), 1.);
}`;

// ---------- flight: instanced ships, shields, plumes, bolts, particles; planets and nebula in world space ----------
// The instanced ship, shield and plume shaders are derived from the single-ship ones above by text patches.
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
  float sc = iB.y > 0. ? iB.y : 1.; // per-instance scale (0 means 1): ships shrink into a landing
  vec2 w = iA.xy + mat2(c,s,-s,c)*(aPos*uHalfM*sc); vWorld=w;
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
uniform vec3 uPlCol[17]; uniform vec3 uPlCore[17]; uniform vec4 uPlP[17]; uniform float uPlSpread[17]; uniform vec3 uPlBurn[17]; // up to 16 brands (faction lines) + thruster gas
out vec2 vST; flat out vec3 vCol; flat out vec3 vCore; flat out vec4 vP; flat out float vSeed; flat out float vPow;
void main(){
  int b = int(iB.x+.5);
  float s = (aPos.y*.5+.5)*1.1-.1; float t = aPos.x;
  vec2 dir = iN.zw, perp = vec2(-dir.y, dir.x);
  float wid = max(iP.y, 2.5/uScale);
  vec2 w = iN.xy + dir*s*iP.x + perp*t*wid*.5*(1.+max(s,0.)*(.6+uPlSpread[b]*2.));
  float burn = clamp(iB.y,0.,1.); // 0 cruise .. 1 full burner: the body takes the brand's burner tint
  vST=vec2(s,t); vCol=mix(uPlCol[b], uPlBurn[b], burn); vCore=mix(uPlCore[b], uPlBurn[b]*.5 + .5, burn*.6); vP=uPlP[b]; vSeed=iP.z; vPow=iP.w;
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
uniform vec2 uC; uniform float uR, uExt;
out vec2 vQ;
void main(){ float e = max(uExt, 1.3); vQ=aPos*e; gl_Position=clipOf(uC + aPos*uR*e); }`;
// Planets, drawn analytically on a quad 1.3 radii wide. Detail follows the zoom: noise layers are added until the
// finest is about two pixels across (uPx is one pixel in planet radii), up to 12, the last fading in, so there is
// no popping and no shimmer; 12 is about what the closest view needs (a fighter at full zoom, 175 m across).
// Noise is 3D value noise on an integer hash, sampled on the sphere itself: seamless, and stable at fine scales.
// Each layer is zero-mean, so coastlines stay put as layers arrive. Layers also return their gradient, which bends
// the surface normal: relief lighting with no extra samples. Relief and albedo detail weight the same layers more
// heavily as they get finer, so a close view keeps its slopes and mottling instead of going smooth.
// The atmosphere is real single scattering through an exponential shell (uAir thick, scattering the uAtm colour),
// marched along the view ray, with sunlight through it from an analytic optical depth (Schuler's Chapman
// approximation). So the limb is a thin bright line, the terminator is soft and takes the complement of the sky's
// colour (a blue sky gives orange dusk), high clouds catch the light after the ground goes dark, and the night
// side sits under its planet's shadow.
// Kinds: 0 terran (oceans with shelves, surf and wave glint; biomes by latitude, height and moisture; snow and
// rock by slope; clouds in climate belts with cyclones, lit and shadowing; city lights resolving into points as
// you close in, when uCity > 0; lightning in the clouds, uStorm of it), 1 banded giant (irregular belts, shear
// eddies, a great storm and white ovals, lightning in the belts),
// 2 cratered rock (craters at five scales as the zoom allows, maria; settlements' sodium lights on the night side when
// uCity > 0). uC1..3 are the palette.
// Rings (uRing: density, inner and outer radius in planet radii, 0 for none; colours uRingA to uRingB across them)
// lie in the equator, whose pole is uAxis (view space; unset, the screen's up, edge-on, so no ring shows): the
// planet spins about it, the ring casts its shadow on the planet and takes the planet's, and shows in front of the
// disc or is hidden behind it. The quad grows to uExt radii to hold them (1.3 at least). Unset ring and axis
// uniforms draw exactly the ringless planet, so a caller that knows nothing of rings needn't set them.
const PLANET_FS = `#version 300 es
precision highp float; in vec2 vQ; out vec4 o;
uniform vec3 uSun, uSunCol, uAmb, uC1, uC2, uC3, uAtm; uniform float uSeed, uTime, uPx, uCity, uAir, uStorm; uniform int uKind;
uniform vec3 uAxis, uRing, uRingA, uRingB;
// the spin and the clouds' drift as (cos, sin), worked out on the CPU in doubles (look.js planetClock): GPU trig on a
// growing time loses precision, which shows as the surface shimmering at close zoom. Unset, computed here as before.
uniform vec2 uSpin, uDrift;
uvec3 pcg3(uvec3 v){ v = v*1664525u + 1013904223u; v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y; v ^= v >> 16u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y; return v; }
float h3(ivec3 i){ return float(pcg3(uvec3(i)).x) * (1./4294967295.); }
// value noise in [0,1] and its gradient
vec4 vnd(vec3 x){
  vec3 i = floor(x), f = x - i, u = f*f*(3.-2.*f), du = 6.*f*(1.-f);
  ivec3 p = ivec3(i);
  float a = h3(p), b = h3(p+ivec3(1,0,0)), c = h3(p+ivec3(0,1,0)), d = h3(p+ivec3(1,1,0));
  float e = h3(p+ivec3(0,0,1)), g = h3(p+ivec3(1,0,1)), h = h3(p+ivec3(0,1,1)), k = h3(p+ivec3(1,1,1));
  float k1 = b-a, k2 = c-a, k3 = e-a, k4 = a-b-c+d, k5 = a-c-e+h, k6 = a-b-e+g, k7 = -a+b+c-d+e-g-h+k;
  float v = a + k1*u.x + k2*u.y + k3*u.z + k4*u.x*u.y + k5*u.y*u.z + k6*u.z*u.x + k7*u.x*u.y*u.z;
  return vec4(v, du*vec3(k1 + k4*u.y + k6*u.z + k7*u.y*u.z, k2 + k5*u.z + k4*u.x + k7*u.z*u.x, k3 + k6*u.x + k5*u.y + k7*u.x*u.y));
}
// noise layers for features down to about two pixels, for a base frequency f0 (per radius)
float lod(float f0){ return clamp(log2(1./(2.*uPx*f0)), 1., 12.); }
// 0 until cells of frequency f are 4 pixels across, 1 by 8: for features that only exist up close
float near(float f){ return clamp(log2(1./(2.*uPx*f)) - 1., 0., 1.); }
// zero-mean fractal sum with gradient; oct may be fractional (the last layer fades in)
vec4 fbmd(vec3 p, float f0, float gain, float oct){
  vec4 s = vec4(0.); float a = .5, f = f0;
  for (int k = 0; k < 12; k++) {
    float w = clamp(oct - float(k), 0., 1.); if (w <= 0.) break;
    vec4 n = vnd(p*f + float(k)*17.31);
    s += a*w*vec4(n.x - .5, n.yzw*f);
    a *= gain; f *= 2.03;
  }
  return s;
}
// the same layers weighted three ways: x the height (gain g) and gt its gradient; yzw the gradient of a rougher
// sum (gain gr), for relief that keeps its slopes as layers arrive, each layer damped where the layers above it
// are already steep (so valleys stay smooth and ridges take the detail, like eroded ground); pt a patchiness whose
// layers all keep their contrast, for albedo detail at any zoom
vec4 fbmr(vec3 p, float f0, float g, float gr, float oct, out float pt, out vec3 gt){
  vec4 s = vec4(0.); float a = .5, ar = .5, f = f0, n2 = 0.; pt = 0.; gt = vec3(0.); vec3 dd = vec3(0.);
  for (int k = 0; k < 12; k++) {
    float w = clamp(oct - float(k), 0., 1.); if (w <= 0.) break;
    vec4 n = vnd(p*f + float(k)*17.31);
    s.x += a*w*(n.x - .5); gt += a*w*n.yzw*f;
    dd += n.yzw; float damp = 1./(1. + .35*dot(dd, dd));    // steep ground carries the fine detail
    s.yzw += ar*w*n.yzw*f*damp;
    if (k > 1) { pt += w*(n.x - .5)*(.4 + .6*damp); n2 += w*w; }
    a *= g; ar *= gr; f *= 2.03;
  }
  pt /= sqrt(max(n2, 1.));
  return s;
}
// ridged layers (sharp crests), for mountains
vec4 ridged(vec3 p, float f0, float oct){
  vec4 s = vec4(0.); float a = .5, f = f0;
  for (int k = 0; k < 8; k++) {
    float w = clamp(oct - float(k), 0., 1.); if (w <= 0.) break;
    vec4 n = vnd(p*f + float(k)*9.73);
    float q = 2.*n.x - 1., r = 1. - abs(q);
    s += a*w*vec4(r*r, 2.*r*(-sign(q))*2.*n.yzw*f);
    a *= .5; f *= 2.03;
  }
  return s;
}
float crB = 0.; // crater brightness: rims and ejecta, fresh craters most
// craters: one per cell at most, radius under half a cell, so the 8 cells around the point are enough.
// Returns height change and its gradient.
vec4 craters(vec3 p, float F, float depth){
  vec3 q = p*F; vec3 base = floor(q - .5); vec4 s = vec4(0.);
  if (depth <= 0.) return s;
  for (int z = 0; z < 2; z++) for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
    ivec3 c = ivec3(base) + ivec3(x, y, z);
    uvec3 hv = pcg3(uvec3(c) + 7u); vec3 j = vec3(hv & 1023u)/1023.;
    if (j.x > .55) continue; // not every cell has one
    vec3 ctr = vec3(c) + .5 + (j - .5)*.3; float rad = .18 + .22*j.y;
    vec3 dv = q - ctr; float d = length(dv) + 1e-5;
    if (d > rad*1.6) continue;
    float t = d/rad, u = clamp((t - .35)/.65, 0., 1.), h, dh, fade = 1. - smoothstep(1.3, 1.6, t); // the blanket ends inside the cell
    if (t < 1.) { h = -1. + 1.35*u*u*(3. - 2.*u); dh = 1.35*6.*u*(1. - u)/.65; }
    else { float e = exp(-(t - 1.)*5.); h = .35*e; dh = -1.75*e; }
    crB += (j.z < .15 ? .35 : .04)*exp(-max(t - .9, 0.)*6.)*(t < 1. ? .5 : 1.)*fade*depth*F*3.;
    s += depth*fade*vec4(h, dh/rad*(dv/d)*F);
  }
  return s;
}
// city lights: at most one light per cell of frequency F, present with probability D, at least most of a pixel
// wide, dimmed as it widens so a blurred light keeps its total brightness
float lights(vec3 p, float F, float D){
  vec3 q = p*F; vec3 c = floor(q); uvec3 hv = pcg3(uvec3(ivec3(c)) + 101u);
  if (float(hv.y & 1023u)/1023. > D) return 0.;
  vec3 ctr = c + .3 + .4*vec3(hv.x & 1023u, (hv.x >> 10) & 1023u, (hv.x >> 20) & 1023u)/1023.;
  float sg = max(.07, uPx*F*.7), d = length(q - ctr);
  vec3 e = min(fract(q), 1. - fract(q)); float edge = smoothstep(0., .08, min(e.x, min(e.y, e.z))); // never clipped square
  return (.35 + .65*float(hv.z & 255u)/255.)*exp(-d*d/(sg*sg))*(.07*.07)/(sg*sg)*12.*edge;
}
// lightning: storm cells of frequency F, a fraction prob of them live; each flashes every few seconds, three or four
// strokes in a quarter second, as a glow in the cloud round it and the bolt's bright core
float lightning(vec3 p, float F, float prob){
  vec3 q = p*F, c = floor(q); uvec3 hv = pcg3(uvec3(ivec3(c)) + 211u);
  if (float(hv.x & 1023u)/1023. > prob) return 0.;
  float h1 = float(hv.y & 1023u)/1023., h2 = float((hv.y >> 10) & 1023u)/1023.;
  float ph = fract(uTime*(.15 + .25*h1) + h2);
  if (ph > .06) return 0.;
  float strokes = step(.4, fract(ph*60. + h1*3.))*(1. - ph*8.);
  vec3 ctr = c + .3 + .4*vec3(hv.z & 1023u, (hv.z >> 10) & 1023u, (hv.z >> 20) & 1023u)/1023.;
  float d = length(q - ctr);
  vec3 e = min(fract(q), 1. - fract(q));
  return strokes*(exp(-d*d*18.)*1.2 + exp(-d*d*500.)*5.)*smoothstep(0., .1, min(e.x, min(e.y, e.z)));
}
// tilt the sphere normal R by a height gradient g (both in planet space): relief
vec3 bump(vec3 R, vec3 g, float k){ return normalize(R - k*(g - dot(g, R)*R)); }
// a vortex: turn p about the axis c by up to w radians, fading with distance; k > 0 squashes it into an oval
// stretched along the latitude lines
vec3 swirl(vec3 p, vec3 c, float w, float s, float k){
  vec3 v = p - c; float a = w*exp(-(dot(v, v) + k*v.y*v.y)/s), ca = cos(a), sa = sin(a);
  return p*ca + cross(c, p)*sa + c*dot(c, p)*(1. - ca);
}
float bell(float x, float c, float w){ x = (x - c)/w; return exp(-x*x); }

// ---- the atmosphere: scale height HS (radii); scattering BR (the sky's colour) and BM (haze), extinction BE
vec3 L, BR, BE; float HS, BM;
// column density toward the sun, in units of HS times the density at the ground (Schuler 2012); X = 1/HS,
// h the height in scale heights, mu the cosine of the sun's zenith angle
float chap(float X, float h, float mu){
  float c = sqrt(X + h);
  if (mu >= 0.) return c/(c*mu + 1.)*exp(-h);
  float x0 = sqrt(1. - mu*mu)*(X + h), c0 = sqrt(x0);
  return 2.*c0*exp(min(X - x0, 30.)) - c/(1. - c*mu)*exp(-h);
}
// sunlight reaching p (|p| >= 1): through the air, and nothing once the planet is in the way (a soft edge for the
// sun's disc)
vec3 sunT(vec3 p){
  float rp = length(p), mu = dot(p, L)/rp, hor = -sqrt(max(1. - 1./(rp*rp), 0.));
  float vis = smoothstep(hor - .012, hor + .012, mu);
  if (vis <= 0.) return vec3(0.);
  return vis*exp(-BE*HS*chap(1./HS, max(rp - 1., 0.)/HS, max(mu, hor)));
}
// march the view ray (straight down -z at q) through the shell: light scattered toward the eye, and the
// transmittance to the ground. Samples crowd toward the densest point (the ground, or the ray's lowest point).
void air(vec2 q, float r, bool hit, float zs, out vec3 ins, out vec3 Tv){
  ins = vec3(0.); Tv = vec3(1.);
  float Ra = 1. + 8.*HS;
  if (uAir <= 0. || r >= Ra) return;
  float zt = sqrt(Ra*Ra - r*r), c = -L.z;
  float PR = .0597*(1. + c*c), PM = .0796*(1. - .49)/pow(1.49 - 1.4*c, 1.5); // Rayleigh; Henyey-Greenstein g .7
  for (int k = 0; k < 16; k++) {
    if (hit && k >= 8) break;
    float u, z, dz;
    if (hit) { u = 1. - (float(k) + .5)/8.; z = zs + (zt - zs)*u*u; dz = (zt - zs)*2.*u/8.; }
    else if (k < 8) { u = 1. - (float(k) + .5)/8.; z = zt*u*u; dz = zt*2.*u/8.; }
    else { u = (float(k - 8) + .5)/8.; z = -zt*u*u; dz = zt*2.*u/8.; }
    vec3 p = vec3(q, z); float rho = exp(-max(length(p) - 1., 0.)/HS);
    vec3 e = BE*rho*dz;
    ins += Tv*exp(-.5*e)*sunT(p)*(BR*PR + BM*PM)*rho*dz;
    Tv *= exp(-e);
  }
}
// the planet's frame: U, A (the pole), V; the screen's up gives the identity
vec3 PU, PA, PV;
// a planet-space direction back to view space: unspun, then out of the planet's frame
vec3 toView(vec3 p, float ca, float sa){ vec3 f = vec3(p.x*ca - p.z*sa, p.y, p.x*sa + p.z*ca); return f.x*PU + f.y*PA + f.z*PV; }
// ring density at distance d (planet radii) from the centre: fine ringlets, a broad and a narrow gap, soft edges
float ringDen(float d){
  float t = (d - uRing.y)/max(uRing.z - uRing.y, 1e-3); if (t < 0. || t > 1.) return 0.;
  float b = .5 + .5*(vnd(vec3(d*42., uSeed, 1.)).x); b *= .55 + .45*vnd(vec3(d*9., uSeed*1.7, 3.)).x;
  float gap = smoothstep(.012, .03, abs(t - .62)), gap2 = smoothstep(.004, .012, abs(t - .86));
  return uRing.x*b*gap*mix(1., gap2, .85)*smoothstep(0., .05, t)*smoothstep(1., .92, t);
}
// the ring at view point q, over what is behind it (premultiplied): in front of the disc (zs its surface's
// height there) or clear of it
vec4 ringOver(vec4 under, vec2 q, float r, float zs){
  if (uRing.x <= 0. || abs(PA.z) < 1e-3) return under;
  float zr = -(PA.x*q.x + PA.y*q.y)/PA.z;
  if (r < 1. && zr < zs) return under;
  vec3 Q = vec3(q, zr); float d = length(Q), den = ringDen(d);
  if (den < .001) return under;
  float b = dot(Q, L), c = dot(Q, Q) - 1.;
  float sh = (b < 0. && b*b - c > 0.) ? .06 : 1.;              // in the planet's shadow
  vec3 rc = pow(mix(uRingA, uRingB, vnd(vec3(d*14., uSeed, 7.)).x), vec3(2.2));
  vec3 col = rc*(uSunCol*2.2*(.3 + .7*abs(dot(PA, L)))*sh*.8 + uAmb*1.6);
  float a = clamp(den, 0., .95);
  return vec4(col*a + under.rgb*(1. - a), a + under.a*(1. - a));
}
void main(){
  float r = length(vQ);
  L = normalize(uSun);
  PA = dot(uAxis, uAxis) > .5 ? normalize(uAxis) : vec3(0., 1., 0.);
  PU = normalize(cross(PA, abs(PA.z) < .95 ? vec3(0., 0., 1.) : vec3(1., 0., 0.))); PV = cross(PU, PA);
  HS = uKind == 1 ? .008 : uKind == 2 ? .006 : .008;
  vec3 tint = uAtm/max(max(uAtm.r, uAtm.g), max(uAtm.b, 1e-3));
  BR = tint*(.2*uAir/HS); BM = .03*uAir/HS;                     // vertical optical depth .2 x uAir in the tint
  BE = mix(vec3(dot(tint, vec3(1./3.))), tint, .6)*(.2*uAir/HS) + BM*1.1; // a gentler complement in what gets through
  vec3 E = uSunCol*2.2;                                          // sunlight, as the surface sees it
  float aa = 1. - smoothstep(1. - uPx*1.5, 1., r);
  vec3 insOut = vec3(0.), Tv;
  if (aa < 1.) air(vQ, r, false, 0., insOut, Tv);                // the ray that misses: the limb and halo
  insOut *= E*3.14159;
  if (r >= 1.) { o = ringOver(vec4(insOut, 0.), vQ, r, 0.); return; }

  float z = sqrt(1.-r*r); vec3 N = vec3(vQ, z);
  vec3 ins; air(vQ, r, true, z, ins, Tv);
  ins *= E*3.14159;
  // planet space: the view-space sphere point in the planet's frame, spun about the pole
  vec2 sc = dot(uSpin, uSpin) > .5 ? uSpin : vec2(cos(uTime*.004+uSeed), sin(uTime*.004+uSeed));
  float ca = sc.x, sa = sc.y;
  vec3 Nf = vec3(dot(PU, N), dot(PA, N), dot(PV, N)), Lf = vec3(dot(PU, L), dot(PA, L), dot(PV, L));
  vec3 R = vec3(Nf.x*ca+Nf.z*sa, Nf.y, -Nf.x*sa+Nf.z*ca);
  vec3 Lp = vec3(Lf.x*ca+Lf.z*sa, Lf.y, -Lf.x*sa+Lf.z*ca); // the sun, in planet space
  vec3 S = vec3(uSeed*3.7, uSeed*1.3, -uSeed*2.1);    // per-planet noise offset
  vec3 alb, Np = R, em = vec3(0.); float wrap = 0., water = 0., cl = 0., cloudPt = 0.; vec3 Nc = R, Ww = R;
  float mu = dot(N, L);
  if (uKind == 1) {
    // banded giant. Storms first: the bands curl round them.
    vec3 P = R;
    vec3 gsC = normalize(vec3(cos(uSeed*3.1), -.36, sin(uSeed*3.1)));
    P = swirl(P, gsC, 2.6, .012, 3.);
    for (int i = 0; i < 3; i++) {
      float a = uSeed*1.7 + float(i)*2.1;
      P = swirl(P, normalize(vec3(cos(a), (i == 1 ? .55 : -.6) + .04*float(i), sin(a))), 3., .0012, 2.);
    }
    // turbulence, stretched along the bands
    vec4 w = fbmd(P*vec3(1., 3., 1.) + S, 2., .5, 5.);
    float lat = P.y + w.x*.05;
    // irregular belts and zones: noise in latitude at two scales; where neighbours differ most, shear eddies
    vec4 b1 = vnd(vec3(lat*9., uSeed*7.1, .5)), b2 = vnd(vec3(lat*23., uSeed*3.3, 2.5));
    float shear = clamp(abs(b1.y*9.*.7 + b2.y*23.*.3)*.12, 0., 1.);
    vec4 ed = fbmd(P*vec3(5., 9., 5.) + S*1.3, 1., .5, 4.);
    lat += ed.x*.035*shear;
    float band = vnd(vec3(lat*9., uSeed*7.1, .5)).x*.7 + vnd(vec3(lat*23., uSeed*3.3, 2.5)).x*.3;
    // fine streaks, gaining detail with zoom
    float pt; vec3 gt;
    vec4 d = fbmr(P*vec3(1., 4., 1.) + vec3(w.x, ed.x*shear, 0.)*.6 + S*1.7, 7., .55, .62, lod(14.), pt, gt);
    float t = band + d.x*.45 + w.x*.18 + pt*.1;            // fine layers move the belt edges: crisp at any zoom
    alb = mix(uC2, uC1, smoothstep(.3, .48, t));
    alb = mix(alb, uC3, smoothstep(.52, .7, t));
    alb *= 1. + pt*.3;
    alb = mix(alb, uC2*.75, smoothstep(.72, .95, abs(R.y))*.55);      // duskier poles
    vec3 gv = R - gsC; float gs = exp(-(dot(gv, gv) + 3.*gv.y*gv.y)/.004);
    alb = mix(alb, mix(uC1, vec3(.78, .34, .2), .55), gs*(.7 + .3*d.x));   // the great storm's reddened eye
    if (uStorm > 0.) em = vec3(.75, .82, 1.)*(lightning(P*vec3(1., 2., 1.) + S, 12., uStorm*.45)
                        + lightning(P*vec3(1., 2., 1.) + S*1.4, 40., uStorm*.35)*near(40.)*.7)*(.4 + .6*shear)
                        *clamp(.5 + pt*3. + d.x*2., .1, 2.)*(.12 + .88*(1. - smoothstep(-.1, .15, mu)))*2.5;
    Np = bump(R, d.yzw*.5 + w.yzw, .0035);
    wrap = .2;
  } else if (uKind == 2) {
    // cratered rock: rolling ground, dark maria, craters at five sizes (the smaller ones only up close)
    float pt; vec3 gt;
    vec4 hgt = fbmr(R + S, 3., .5, .6, lod(3.), pt, gt);
    vec4 cr = craters(R + S, 7., .045) + craters(R + S*1.3, 19., .02) + craters(R + S*.7, 55., .009*near(55.))
            + craters(R + S*.4, 150., .0035*near(150.)) + craters(R + S*.2, 420., .0013*near(420.));
    float mare = smoothstep(.0, .14, vnd((R + S)*1.4 + 3.).x - .52 - hgt.x*.3);
    float h = hgt.x + cr.x*4.;
    alb = mix(uC1, uC2, smoothstep(-.2, .25, h));
    alb = mix(alb, uC3, smoothstep(.18, .4, hgt.x + .5*cr.x));
    alb = mix(alb, uC1*.75, mare*.55);
    alb *= (.9 + .3*pt)*clamp(1. + cr.x*5., .7, 1.2)*(1. + min(crB, 1.)*.55);   // darker floors; bright rims and ejecta
    Np = bump(R, hgt.yzw*.35 + cr.yzw, .035);
    // where people live on bare rock: domes, tunnel towns and works on the low ground (crater floors, the maria),
    // gathered in clusters; sodium orange, seen only on the night side, resolving into points as the terran lights do
    if (uCity > 0.) {
      float town = clamp(smoothstep(.66, .82, vnd((R + S)*6.).x + mare*.15 - h*.6 + pt*.15), 0., 1.)*uCity;
      float night = 1. - smoothstep(-.1, .02, mu);
      if (night*town > 0.) {
        float g1 = near(240.), g2 = near(960.), g3 = near(3800.);
        float k1 = smoothstep(.45, .75, vnd((R + S)*30.).x), k2 = smoothstep(.35, .7, vnd((R + S)*120.).x), k3 = smoothstep(.3, .65, vnd((R + S)*480.).x);
        float lt = mix(.05*town*k1, lights(R + S, 120., town*k1), g1);       // sparse: a faint glow, then points
        lt += g1*mix(.015*town*k1*k2, lights(R + S*1.1, 480., town*k1*k2), g2);
        lt += g2*mix(.015*town*k2*k3, lights(R + S*1.2, 1900., town*k2*k3)*1.2, g3);
        em = mix(vec3(1., .5, .16), vec3(1., .7, .4), pt + .5)*lt*night*2.2;
      }
    }
  } else {
    // terran: warped continents with ridged mountains inland
    vec3 Rw = R + vnd(R*1.8 + S).yzw*.07;            // warp: coastlines that wander
    float pt; vec3 gt;
    vec4 hgt = fbmr(Rw + S, 2.2, .47, .58, lod(2.2), pt, gt);
    float mtn = smoothstep(.03, .2, hgt.x);
    vec4 mt = ridged(Rw + S*1.9, 6., lod(6.) - 1.);
    float h = hgt.x + mt.x*.22*mtn;
    vec3 rel = hgt.yzw*.6 + mt.yzw*.22*mtn;            // relief gradient
    float wpx = length(gt - dot(gt, R)*R)*uPx*1.2 + 1e-6; // the height change across a pixel, for crisp coasts
    float land = smoothstep(-wpx, wpx, hgt.x);
    float slope = length(rel - dot(rel, R)*R)*.03;
    // climate: cold toward the poles and with height; dry belts in the subtropics, wet at the equator
    float lat = abs(R.y);
    vec4 cn = vnd((R + S)*1.3 + 5.);
    float moist = .55 + (vnd((R + S)*2.6 + 9.).x - .5)*.8 + (cn.x - .5)*.4 - .5*bell(lat, .42, .13) + .25*bell(lat, 0., .12)
                - smoothstep(0., .35, hgt.x)*.15 + pt*.12;
    float temp = 1. - 1.15*pow(lat, 1.4) - 1.8*max(h, 0.) + (cn.x - .5)*.25;
    vec3 forest = uC2*vec3(.55, .72, .55), savanna = mix(uC2, uC3, .55), desert = mix(uC3, vec3(.86, .74, .55), .35);
    vec3 tundra = mix(uC2, vec3(.52, .5, .44), .6), rock = mix(uC3, vec3(.42, .4, .38), .55);
    vec3 ground = mix(desert, savanna, smoothstep(.12, .32, moist));
    ground = mix(ground, uC2, smoothstep(.32, .52, moist));
    ground = mix(ground, forest, smoothstep(.55, .8, moist));
    ground = mix(tundra, ground, smoothstep(.12, .38, temp));
    ground *= 1. + pt*.4;                                                           // patchy at every zoom
    ground = mix(ground, rock, smoothstep(.3, .65, slope + mt.x*.25*mtn));        // bare rock on the steeps
    float snow = smoothstep(.05, -.05, temp + pt*.06)*(1. - smoothstep(.5, .8, slope));
    ground = mix(ground, vec3(.92, .94, .97), snow);
    ground = mix(ground, mix(uC3, vec3(.95, .9, .78), .5), smoothstep(.006 + wpx*2., 0., hgt.x)*smoothstep(.2, .4, temp)*.8); // beaches
    // seas: dark deeps, pale shelves, surf on the shore once it's resolvable, ice where it's cold
    float dep = -hgt.x;
    vec3 ocean = mix(uC1, uC1*.3, smoothstep(0., .16, dep));
    ocean = mix(ocean, mix(uC1, vec3(.2, .62, .62), .5), smoothstep(.035, 0., dep)*.8);
    ocean *= 1. + pt*.06;
    ocean = mix(ocean, vec3(.85, .9, .92), smoothstep(wpx*3. + .0012, 0., dep)*near(400.)*.7);
    float seaIce = smoothstep(.04, -.04, 1. - 1.15*pow(lat, 1.4) + pt*.08 + (cn.x - .5)*.2);
    ocean = mix(ocean, vec3(.86, .9, .95), seaIce);
    alb = mix(ocean, ground, land);
    water = (1. - land)*(1. - seaIce);
    Np = bump(R, rel*(1. - water), .03);
    // waves near the pixel scale: the glint breaks into sparkle
    float fw = .3/uPx;
    vec4 wv = vnd(R*fw + vec3(0., uTime*.6, 0.)) + .5*vnd(R*fw*2.03 + vec3(uTime*.4, 0., 3.));
    Ww = bump(R, wv.yzw/fw, .15);
    // where people live: temperate lowlands near the coast
    float town = 0.;
    if (uCity > 0.) {
      float hab = land*smoothstep(.16, .0, hgt.x)*smoothstep(.2, .45, temp)*smoothstep(.1, .3, moist)*(1. - snow)*(1. - slope*1.5);
      town = clamp(hab*smoothstep(.42, .62, vnd((R + S)*9.).x + pt*.3), 0., 1.)*uCity;
      alb = mix(alb, vec3(.42, .41, .4), town*.3*smoothstep(.35, .7, vnd((R + S)*120.).x + pt*.4));
      float night = 1. - smoothstep(-.1, .02, mu);
      if (night*town > 0.) {
        // unresolved, the lights are a glow; closer, each scale resolves into points, gathered into clusters a
        // few cells across (towns, then districts, then streets)
        float g1 = near(240.), g2 = near(960.), g3 = near(3800.);  // a scale resolves once its cells are 8 px
        float k1 = smoothstep(.4, .7, vnd((R + S)*30.).x), k2 = smoothstep(.35, .7, vnd((R + S)*120.).x), k3 = smoothstep(.3, .65, vnd((R + S)*480.).x);
        float lt = mix(.15*town, lights(R + S, 120., town*k1), g1);            // a glow is about the points' average
        lt += g1*mix(.04*town*k1*k2, lights(R + S*1.1, 480., town*k1*k2), g2);
        lt += g2*mix(.04*town*k2*k3, lights(R + S*1.2, 1900., town*k2*k3)*1.2, g3);
        em = mix(vec3(1., .62, .28), vec3(1., .85, .65), pt + .5)*lt*night*2.2;
      }
    }
    // clouds in climate belts, two cyclones (turning opposite ways either side of the equator), drifting faster
    // than the ground
    vec2 dr = dot(uDrift, uDrift) > .5 ? uDrift : vec2(cos(uTime*.002), sin(uTime*.002));
    vec3 Rc = vec3(R.x*dr.x - R.z*dr.y, R.y, R.x*dr.y + R.z*dr.x);
    Rc = swirl(Rc, normalize(vec3(cos(uSeed*5.), .5 + .15*sin(uSeed*2.), sin(uSeed*5.))), 3.2, .03, 0.);
    Rc = swirl(Rc, normalize(vec3(cos(uSeed*2.3 + 2.), -.62, sin(uSeed*2.3 + 2.))), -2.8, .025, 0.);
    float cOct = min(lod(3.), 11.), cp; vec3 cg;
    vec4 cn2 = fbmr(Rc*vec3(1., 1.7, 1.) + S*2.3, 3., .6, .62, cOct, cp, cg);
    float th = .05 + .12*bell(lat, .38, .13) - .07*bell(lat, 0., .1) - .06*bell(lat, .68, .1);
    float ramp = mix(.025, .09, clamp(uPx*600., 0., 1.));      // a far view softens the edges; a near one doesn't
    // a crisp edge, then thickening inward, so a cloud's body keeps its texture
    cl = smoothstep(th - length(cg)*uPx*1.5, th + ramp, cn2.x)*(.5 + .45*smoothstep(th, th + .16, cn2.x));
    float clS = smoothstep(th, th + ramp, fbmd((Rc + Lp*.012)*vec3(1., 1.7, 1.) + S*2.3, 3., .6, min(cOct, 6.)).x);
    alb *= 1. - .55*clS*(1. - cl);
    em *= 1. - .85*cl;
    if (uStorm > 0.) em += vec3(.75, .82, 1.)*(lightning(Rc + S, 18., uStorm*.5)*(.25 + .75*cl)
                         + lightning(Rc + S*1.3, 55., uStorm*.4)*near(55.)*.6*cl)
                         *clamp(.5 + cp*3., .1, 2.)*(.12 + .88*(1. - smoothstep(-.1, .15, mu)))*2.5;
    Nc = bump(R, cn2.yzw, .05); cloudPt = cp;
  }
  // back to view space, then light it: sunlight through the air (reddened, then gone, across the terminator),
  // skylight (the sky's colour, on the day side), the star system's ambient
  vec3 Nv = toView(Np, ca, sa);
  alb = pow(alb, vec3(2.2));
  // the ring's shadow: where the line to the sun crosses the ring plane
  float rs = 1.;
  if (uRing.x > 0.) { float dn = dot(PA, L); if (abs(dn) > 1e-3) { float t = -dot(PA, N)/dn; if (t > 0.) rs = 1. - ringDen(length(N + L*t))*.85; } }
  vec3 Ts = sunT(N)*rs;
  vec3 sky = E*(1. - exp(-BR*HS*1.5))*.6*smoothstep(-.25, .5, mu);
  float dif = max((dot(Nv, L) + wrap)/(1. + wrap), 0.);
  vec3 col = alb*(E*dif*Ts + sky + uAmb*1.5);
  if (water > 0.) {
    // the sea mirrors the sky at grazing angles, and the sun off the waves
    vec3 Wv = toView(Ww, ca, sa), H = normalize(L + vec3(0., 0., 1.));
    float F = .02 + .98*pow(1. - z, 5.);
    col = mix(col, uAtm*E*.12*smoothstep(-.1, .3, mu), F*water*min(uAir, 1.));
    float nh = max(dot(Wv, H), 0.), nh0 = max(dot(N, H), 0.);
    col += E*Ts*water*(pow(nh, 500.)*.8 + pow(nh0, 80.)*.025)*(1. - cl);
  }
  if (cl > 0.) {
    // clouds sit higher, so they keep the sun a little past the ground's terminator
    vec3 Ncv = toView(Nc, ca, sa);
    vec3 cc = vec3(.72)*(E*max(dot(Ncv, L)*.85 + .15, 0.)*sunT(N*(1. + 2.*HS))*rs + sky*.7 + uAmb*1.5);
    col = mix(col, cc*(.82 + .4*cloudPt), cl);
  }
  col += em;
  o = ringOver(vec4((col*Tv + ins)*aa + insOut*(1. - aa), aa), vQ, r, z);
}`;
// Orbiters (core/src/orbit.rs): one instanced sprite each, drawn additively over the planets. iA: x, y (world m),
// size (m), kind (0 debris, 1 traffic, 2 a lens ghost); iB: light (sunlit and facing; a ghost's strength), glint,
// seed, depth. Everything is a speck of light about a pixel wide at any zoom; one smaller than a pixel is dimmer,
// not smaller. Debris flecks are mostly dull rock, some bright metal and a few gold foil, sunlit. Traffic is beacons:
// red, green, amber, white or cyan, each slowly pulsing, double-flashing or steady, with a faint sunlit glint of its
// own. A glint flares: a hot point for a tumbling fleck's twinkle; for a real flare, four spikes and a long
// horizontal streak too, bright enough to bloom. A ghost is a soft tinted disc with a brighter rim, laid along the
// line from a flare through the middle of the screen.
const ORBITER_VS = `#version 300 es
in vec2 aPos; in vec4 iA; in vec4 iB;
${WORLD_POS}
out vec2 vQ; flat out vec4 vA; flat out vec4 vB;
void main(){
  float px = 1./uScale, g = min(iB.y, 6.), base = max(iA.z, px*3.);
  vec2 hs = iA.w > 1.5 ? vec2(iA.z) : g > .2 ? vec2(base + px*(10. + 45.*sqrt(g)), base + px*(8. + 14.*sqrt(g))) : vec2(base);
  vQ = aPos*hs; vA = iA; vB = iB;
  gl_Position = clipOf(iA.xy + vQ);
}`;
const ORBITER_FS = `#version 300 es
precision highp float; in vec2 vQ; flat in vec4 vA; flat in vec4 vB; out vec4 o;
uniform float uScale, uTime; uniform vec3 uSunCol;
void main(){
  float px = 1./uScale, size = vA.z, lit = vB.x, g = min(vB.y, 6.), seed = vB.z;
  vec2 q = vQ; float d2 = dot(q, q);
  if (vA.w > 1.5) {
    float r = sqrt(d2)/size, a = (1. - smoothstep(.85, 1., r))*(.55 + .45*smoothstep(.55, .97, r));
    o = vec4(mix(vec3(.35, .65, 1.), vec3(1., .55, .3), seed)*uSunCol*a*lit*.035, 0.); return;
  }
  float pt = exp(-d2/(px*px*.5)), halo = exp(-d2/(px*px*4.))*.12, k = clamp(size/px, .35, 1.);
  vec3 col, tint;
  if (vA.w < .5) {
    // a fleck: what it's made of, by its seed
    float m = fract(seed*5.13);
    tint = m < .72 ? mix(vec3(.55, .52, .48), vec3(.72, .67, .6), fract(seed*11.7)) : m < .92 ? vec3(.86, .9, .96) : vec3(1., .76, .36);
    col = tint*uSunCol*lit*(pt + halo)*k*(m < .72 ? 1.8 : 3.);
  } else {
    // a beacon: its colour and blink, by its seed
    float c = fract(seed*7.31), b = fract(seed*3.71), ph = fract(uTime/(1.1 + 1.3*fract(seed*17.3)) + seed*13.);
    vec3 lc = c < .3 ? vec3(1., .14, .08) : c < .55 ? vec3(.15, 1., .35) : c < .75 ? vec3(1., .62, .16) : c < .9 ? vec3(1.) : vec3(.35, .8, 1.);
    float blink = b < .45 ? .15 + .85*pow(.5 + .5*sin(ph*6.2832), 6.)            // a slow pulse
                : b < .8 ? .08 + 1.4*(step(ph, .05) + step(abs(ph - .14), .025))  // a double flash
                : .55;                                                            // steady
    tint = vec3(.8, .84, .9);
    col = lc*(pt + halo*2.)*blink*2.6 + tint*uSunCol*lit*pt*k*.8;
  }
  if (g > .002) {
    vec2 a = abs(q)/px; float sg = sqrt(g), big = smoothstep(.2, 1., g);
    float sp = (exp(-a.y*2.2)*exp(-a.x/(1.5 + 3.*sg)) + exp(-a.x*2.2)*exp(-a.y/(1.5 + 3.*sg)))*.7;
    float st = exp(-a.y*3.)*exp(-a.x/(4. + 10.*sg))*.2;
    col += mix(vec3(1.), tint, .6)*uSunCol*g*(exp(-d2/(px*px*.6))*(1.5 + 2.5*big) + (sp + st)*big);  // a twinkle stays a point; a flare blooms
  }
  o = vec4(col, 0.);
}`;
// The plasma sheath a ship wears on descent and launch (the Book's landing sequence): a glow that hugs the hull's
// silhouette, read from the bake's distance field, so it fits every generated shape. Red-hot, white at the nose,
// which leads the descent; uFade blends it toward the atmosphere's tint as the ship sinks into it.
const SHEATH_VS = `#version 300 es
in vec2 aPos;
${WORLD_POS}
uniform vec2 uC; uniform float uHalfM, uAng, uSc, uPad;
out vec2 vQ;
// the quad is uPad times the hull's, for the halo; vQ stays in the hull's own frame (-1..1 over its bake), so the
// sheath's silhouette lines up with the hull drawn under it
void main(){ vQ = aPos*uPad; float c = cos(uAng), s = sin(uAng); gl_Position = clipOf(uC + mat2(c,s,-s,c)*(aPos*uPad*uHalfM*uSc)); }`;
const SHEATH_FS = `#version 300 es
precision highp float; in vec2 vQ; out vec4 o;
uniform sampler2D uX; uniform float uS, uDmax, uHeat, uFade, uTime; uniform vec3 uAtm;
${NOISE}
void main(){
  vec2 uv = vec2(vQ.x*.5+.5, .5-vQ.y*.5);
  // the bake's distance field only reaches a little past the hull; its blurrier mips spread that into a halo
  // several metres deep, which is what a sheath needs at flight zoom
  float inside = 1. - textureLod(uX, uv, 1.).r;
  float near = 1. - .5*(textureLod(uX, uv, 4.5).r + textureLod(uX, uv, 6.).r);
  float shell = clamp((near - .2)*2.2 - inside*.7, 0., 1.);  // strong nearness only: faint blur adds nothing
  shell *= shell;
  shell *= (1. - smoothstep(.6, 1.05, abs(vQ.x)))*(1. - smoothstep(.6, 1.05, abs(vQ.y))); // nothing at the quad's edges
  float lead = clamp(vQ.y*.6 + .45, 0., 1.);             // the nose leads the descent
  float n = fbm(vQ*5. + vec2(vQ.x*2., -uTime*5.));
  vec3 hot = mix(vec3(1., .16, .04), vec3(1., .9, .72)*2.4, pow(lead, 2.));
  vec3 col = mix(hot, uAtm*1.6, uFade)*shell*(.55 + .9*n)*uHeat;
  o = vec4(col*3.2, 0.);
}`;
// Nebula gas and flare radiation, drawn twice: a full back layer under the ships and a thin haze over them.
const NEB_VS = `#version 300 es
in vec2 aPos; out vec2 vP; void main(){ vP=aPos; gl_Position=vec4(aPos,0.,1.); }`;
const NEB_FS = `#version 300 es
precision highp float; in vec2 vP; out vec4 o;
uniform vec2 uRes, uCam, uLdir; uniform float uScale, uTime, uFront, uFlare, uWorld;
uniform vec3 uPl[3]; uniform sampler2D uGas;
${NOISE}
void main(){
  vec2 w = uCam + vP*uRes*.5/uScale;
  vec2 uv = w/uWorld + .5;
  vec3 g = (uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.) ? vec3(0.) : texture(uGas, uv).rgb;
  float n1 = fbm(w*.0011 + 3.1), n2 = fbm(w*.0047 - 1.7);
  float det = .15 + 1.9*pow(clamp(n1*n2*2.2, 0., 1.5), 1.6);
  vec3 d = g*g*clamp(det, 0., 1.8);
  float flick = .6 + .8*vn(vec2(uTime*2.7, w.x*.0009 + w.y*.0006));
  float k = uFront > .5 ? .35 : 1.;
  vec3 emis = (vec3(.11,.012,.03)*d.r + vec3(.018,.011,.007)*d.g + vec3(.008,.05,.11)*d.b*flick)*k;
  float absorb = clamp(d.g*.9 + d.r*.06 + d.b*.04, 0., .9)*k;
  if (uFlare > 0. && uFront < .5) {
    float lit = 1.;
    for (int i = 0; i < 3; i++) {
      vec2 q = w - uPl[i].xy; float al = dot(q, uLdir);
      if (al < 0.) lit = min(lit, smoothstep(uPl[i].z*.92, uPl[i].z*1.04, length(q - al*uLdir)));
    }
    emis += vec3(1.,.8,.55)*uFlare*.06*lit*(.6 + .4*n1);
  }
  o = vec4(emis, absorb);
}`;

// ---------- the star map (src/map/map.js): stars as camera-facing glows, and the chart's lines ----------
// Each star is an instanced quad of a fixed size in pixels (scaled a little by nearness), so a far star stays a point
// and a near one a bead, drawn from its class's template (map.js STAR_LOOKS): its colour, and its shape (aShape: 0 a
// star, 1 a giant's wide halo, 2 a white dwarf's hard point, 3 a pulsar's beams, 4 a black hole's dark core in its
// disk). aMark: an occupied system's halo, a soft glow in its owner's colour (alpha 0: none). Flags: x hover, y selected, z dimmed
// (outside the shown range, filtered out, or not yet known in the year shown), w a dead system (smaller, greyed).
const MAP_STAR_VS = `#version 300 es
in vec2 aPos; in vec3 aCenter; in vec3 aCol; in float aSize; in vec4 aFlag; in vec4 aMark; in float aShape;
uniform mat4 uVP; uniform vec2 uRes; uniform vec3 uEye; uniform float uPx;
out vec2 vQ; out vec3 vCol; out vec4 vFlag; out float vPx; out float vGrow; out vec4 vMark; flat out int vShape;
void main(){
  vec4 c = uVP*vec4(aCenter,1.);
  float near = clamp(30./max(distance(uEye, aCenter), 1.), .6, 2.2);
  float px = aSize*uPx*near*(aFlag.z > .5 ? .6 : 1.)*(aFlag.w > .5 ? .6 : 1.)*(1. + aFlag.x*.4);
  // a quad grown to hold the rings round it (the star itself drawn tighter inside, to keep its size)
  float grow = aFlag.y > .5 ? max(2.4, 52./px) : aMark.a > .5 && aFlag.z < .5 ? max(1.5, 20./px) : 1.;
  px *= grow;
  vQ = aPos; vCol = aCol; vFlag = aFlag; vPx = px; vGrow = grow; vMark = aMark; vShape = int(aShape + .5);
  gl_Position = c + vec4(aPos*px/uRes*2.*c.w, 0., 0.);
}`;
const MAP_STAR_FS = `#version 300 es
precision highp float; in vec2 vQ; in vec3 vCol; in vec4 vFlag; in float vPx; in float vGrow; in vec4 vMark; flat in int vShape;
out vec4 o; uniform float uTime;
void main(){
  float r = length(vQ), q = r*vGrow; // q: the star's own radius, whatever the quad holds round it
  vec3 col = vCol;
  // the star: a core whitening only at its heart, so its colour shows, and a halo of its colour
  float core = exp(-q*q*22.), halo = exp(-q*5.5)*.6;
  if (vShape == 1) halo = exp(-q*3.5)*.85;                      // a giant: wide and soft
  if (vShape == 2) { core = exp(-q*q*70.); halo = exp(-q*10.)*.4; } // a white dwarf: hard and small
  vec3 c = col*(core*2. + halo) + vec3(1.)*pow(core, 3.)*.9;
  if (vShape == 3) { // a pulsar: two crossed beams
    float b = exp(-abs(vQ.x*vGrow)*40.)*exp(-abs(vQ.y*vGrow)*2.5) + exp(-abs(vQ.y*vGrow)*40.)*exp(-abs(vQ.x*vGrow)*2.5);
    c += col*b*1.2;
  }
  if (vShape == 4) { // a black hole: dark at the middle, its disk a hot ring
    float disk = exp(-pow((q - .2)/.06, 2.))*2.2;
    c = vec3(1., .55, .2)*disk + vec3(.9, .4, .15)*exp(-q*7.)*.25*(1. - exp(-q*q*400.));
  }
  float k = vFlag.z > .5 ? .12 : 1.;
  if (vFlag.w > .5) c = mix(vec3(dot(c, vec3(.3,.5,.2))), c, .75)*.45; // dead: dim, a little greyed, its colour kept
  c *= k;
  float w = 1.4/max(vPx, 1.);
  // an occupied system: a crisp ring in its owner's colour
  if (vMark.a > .5 && vFlag.z < .5) c += vMark.rgb*exp(-pow((r - .3)/.28, 2.))*.42; // a soft halo of its owner's colour
  // the selection: a solid ring and one pulsing outward; hovering: a faint ring
  if (vFlag.y > .5) c += vec3(1.,.82,.45)*(smoothstep(w*2., 0., abs(r - .42))*2.2
      + smoothstep(w*2., 0., abs(r - mix(.45, .95, fract(uTime*.6))))*1.6*(1. - fract(uTime*.6)));
  else c += vec3(1.,.82,.45)*vFlag.x*.8*smoothstep(w*2., 0., abs(r - .9));
  o = vec4(c*(1. - smoothstep(.88, 1., r)), 0.);
}`;
// Lines (the galactic-plane grid, drop lines, routes) with per-vertex colour; the far ones fade, and a line whose
// aFade.x is set fades by the distance of its star (the floor point under it at aFade.y's height) from the focus.
const MAP_LINE_VS = `#version 300 es
in vec3 aPos; in vec4 aCol; in vec2 aFade;
uniform mat4 uVP; uniform vec3 uEye, uFocus; uniform float uFocusR, uFar;
out vec4 vCol;
void main(){
  float a = aCol.a*(1. - smoothstep(uFar*.45, uFar, distance(uEye, aPos)));
  if (aFade.x > .5) a *= 1. - smoothstep(uFocusR*.6, uFocusR, distance(uFocus, vec3(aPos.xy, aFade.y)));
  vCol = vec4(aCol.rgb*a, 0.);
  gl_Position = uVP*vec4(aPos,1.);
}`;
const MAP_LINE_FS = `#version 300 es
precision highp float; in vec4 vCol; out vec4 o; void main(){ o = vCol; }`;
// Territory clouds: a soft sphere of a faction's colour round each system it holds, a camera-facing quad sized in
// light years (uRight, uUp: the view's axes), so overlapping clouds make one region; faded near the eye, so flying
// through one does not wash out the view.
const MAP_ZONE_VS = `#version 300 es
in vec2 aPos; in vec3 aCenter; in vec3 aCol; in float aSize;
uniform mat4 uVP; uniform vec3 uRight, uUp, uEye;
out vec2 vQ; out vec3 vCol;
void main(){
  vQ = aPos;
  float near = smoothstep(aSize*.6, aSize*2.5, distance(uEye, aCenter));
  vCol = aCol*near;
  gl_Position = uVP*vec4(aCenter + (uRight*aPos.x + uUp*aPos.y)*aSize, 1.);
}`;
const MAP_ZONE_FS = `#version 300 es
precision highp float; in vec2 vQ; in vec3 vCol; out vec4 o; uniform float uK;
void main(){ float r2 = dot(vQ, vQ); o = vec4(vCol*exp(-r2*3.)*(1. - smoothstep(.8, 1., r2))*uK, 0.); }`;
