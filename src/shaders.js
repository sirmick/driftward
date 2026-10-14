// ======================= SHADERS =======================
// GLSL sources shared by the lab (index.html) and the game (play.html). Plain strings, compiled by each page's
// graphics kit (gfx.js). Lab-only shaders for planets, suns, stations and asteroids live in their own modules.

// ---------- common: noise, full-screen pass, starfield ----------
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
uniform vec3 uPlCol[5]; uniform vec3 uPlCore[5]; uniform vec4 uPlP[5]; uniform float uPlSpread[5]; uniform vec3 uPlBurn[5]; // 4 brands + thruster gas
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
uniform vec2 uC; uniform float uR;
out vec2 vQ;
void main(){ vQ=aPos*1.3; gl_Position=clipOf(uC + aPos*uR*1.3); }`;
// Planets, drawn analytically on a quad 1.3 radii wide. Detail follows the zoom: noise layers are added until the
// finest is about two pixels across (uPx is one pixel in planet radii), up to 12, the last fading in, so there is
// no popping and no shimmer. Noise is 3D value noise on an integer hash, sampled on the sphere itself: seamless,
// and stable at fine scales. Each layer is zero-mean, so coastlines stay put as layers arrive. Layers also return
// their gradient, which bends the surface normal: relief lighting with no extra samples.
// Kinds: 0 terran (ocean, land, mountains, ice, clouds and their shadows, sun glint, city lights at night when
// uCity > 0), 1 banded giant, 2 cratered rock. uC1..3 are the palette; uAtm the atmosphere tint.
const PLANET_FS = `#version 300 es
precision highp float; in vec2 vQ; out vec4 o;
uniform vec3 uSun, uSunCol, uAmb, uC1, uC2, uC3, uAtm; uniform float uSeed, uTime, uPx, uCity; uniform int uKind;
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
// craters: one per cell at most, radius under half a cell, so the 8 cells around the point are enough.
// Returns height change and its gradient.
vec4 craters(vec3 p, float F, float depth){
  vec3 q = p*F; vec3 base = floor(q - .5); vec4 s = vec4(0.);
  for (int z = 0; z < 2; z++) for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
    ivec3 c = ivec3(base) + ivec3(x, y, z);
    uvec3 hv = pcg3(uvec3(c) + 7u); vec3 j = vec3(hv & 1023u)/1023.;
    if (j.x > .55) continue; // not every cell has one
    vec3 ctr = vec3(c) + .5 + (j - .5)*.3; float rad = .18 + .22*j.y;
    vec3 dv = q - ctr; float d = length(dv) + 1e-5;
    if (d > rad*1.6) continue;
    float t = d/rad, bowl = t < 1. ? -(1. - t*t) : 0., rim = .35*exp(-(t - 1.)*(t - 1.)*18.);
    float dbowl = t < 1. ? 2.*t : 0., drim = .35*exp(-(t - 1.)*(t - 1.)*18.)*(-36.)*(t - 1.);
    s += depth*vec4(bowl + rim, (dbowl + drim)/rad*(dv/d)*F);
  }
  return s;
}
// tilt the sphere normal R by a height gradient g (both in planet space): relief
vec3 bump(vec3 R, vec3 g, float k){ return normalize(R - k*(g - dot(g, R)*R)); }
void main(){
  float r = length(vQ);
  vec3 L = normalize(uSun);
  vec2 ld = normalize(L.xy+1e-5);
  if (r > 1.) { // atmosphere halo
    float a = exp(-(r-1.)*9.)*(1.-smoothstep(1.25,1.3,r));
    float lit = clamp(dot(normalize(vQ), ld)*.6+.45, 0., 1.);
    o = vec4(uAtm*uSunCol*a*lit*.8, 0.); return;
  }
  float z = sqrt(1.-r*r); vec3 N = vec3(vQ, z);
  // planet space: the view-space sphere point, spun about the polar axis
  float ca = cos(uTime*.004+uSeed), sa = sin(uTime*.004+uSeed);
  vec3 R = vec3(N.x*ca+N.z*sa, N.y, -N.x*sa+N.z*ca);
  vec3 Lp = vec3(L.x*ca+L.z*sa, L.y, -L.x*sa+L.z*ca); // the sun, in planet space
  vec3 S = vec3(uSeed*3.7, uSeed*1.3, -uSeed*2.1);    // per-planet noise offset
  vec3 alb, Np = R, em = vec3(0.); float spec = 0., wrap = 0.;
  if (uKind == 1) {
    // banded giant: latitude bands, bent by turbulence that gains detail with zoom
    vec4 w = fbmd(R + S, 2., .55, lod(2.));
    float lat = R.y + w.x*.09;
    float b = sin(lat*14. + w.x*2.6);
    alb = mix(uC1, uC2, smoothstep(-.6, .6, b));
    vec4 st = fbmd(vec3(R.x*1.5, R.y*9., R.z*1.5) + S*1.7, 2., .5, lod(9.));
    alb = mix(alb, uC3, smoothstep(.05, .3, st.x)*.85);
    wrap = .25;
  } else if (uKind == 2) {
    // cratered rock: rolling ground plus two crater sizes, a third when close
    vec4 hgt = fbmd(R + S, 3., .5, lod(3.));
    vec4 cr = craters(R + S, 7., .045) + craters(R + S*1.3, 19., .02) + craters(R + S*.7, 55., .009)*clamp(lod(55.) - 1., 0., 1.);
    float h = hgt.x + cr.x*4.;
    alb = mix(uC1, uC2, smoothstep(-.2, .25, h));
    alb = mix(alb, uC3, smoothstep(.18, .4, hgt.x + .5*cr.x));
    alb *= (.85 + .3*vnd((R + S)*40.).x)*clamp(1. + cr.x*5., .6, 1.25); // darker floors, brighter rims
    Np = bump(R, hgt.yzw*.6 + cr.yzw, .035);
  } else {
    // terran: warped continents with ridged mountains, beaches, snow, ice, clouds
    vec3 Rw = R + vnd(R*1.8 + S).yzw*.07;            // warp: coastlines that wander
    vec4 hgt = fbmd(Rw + S, 2.2, .47, lod(2.2));
    float land = smoothstep(0., .02, hgt.x);
    vec4 mt = ridged(Rw + S*1.9, 6., lod(6.) - 1.);
    float mtn = smoothstep(.03, .2, hgt.x);            // mountains rise inland, not at the coast
    float h = hgt.x + mt.x*.22*mtn;
    vec3 grad = hgt.yzw + mt.yzw*.22*mtn;
    float polar = smoothstep(.78, .9, abs(R.y) + hgt.x*.4);
    vec3 deep = uC1*.45, shallow = mix(uC1, vec3(.25, .6, .65), .35);
    vec3 ocean = mix(deep, shallow, smoothstep(-.12, 0., hgt.x));
    vec3 ground = mix(uC2, uC3, smoothstep(.06, .22, h));
    ground = mix(ground, mix(uC3, vec3(.95, .9, .78), .5), smoothstep(.006, 0., hgt.x)*land); // beaches
    ground = mix(ground, vec3(.92, .94, .97), smoothstep(.2, .28, h));                         // snow on peaks
    alb = mix(ocean, ground, land);
    alb = mix(alb, vec3(.9, .93, .97), polar);
    Np = land > .5 ? bump(R, grad, .028) : R;
    spec = (1. - land)*(1. - polar);
    // clouds, drifting faster than the ground, and the shadow they cast (sampled toward the sun)
    vec3 Rc = vec3(R.x*cos(uTime*.002) - R.z*sin(uTime*.002), R.y, R.x*sin(uTime*.002) + R.z*cos(uTime*.002));
    float cOct = min(lod(3.), 10.);
    float cl = smoothstep(.02, .2, fbmd(Rc*vec3(1., 1.6, 1.) + S*2.3, 3., .55, cOct).x);
    float clS = smoothstep(.02, .2, fbmd((Rc + Lp*.012)*vec3(1., 1.6, 1.) + S*2.3, 3., .55, min(cOct, 5.)).x);
    alb *= 1. - .5*clS;
    // city lights, on the night side of inhabited land near the coast
    if (uCity > 0.) {
      float coast = smoothstep(.12, .0, hgt.x)*land;
      float town = smoothstep(.6, .85, vnd((R + S)*38.).x) * smoothstep(.0, .25, fbmd(R + S*.5, 7., .5, 2.).x + .1);
      em = vec3(1., .66, .32)*town*coast*uCity*(1. - .8*cl)*1.6;
    }
    alb = mix(alb, vec3(.92), cl*.85);
    spec *= 1. - cl;
    Np = normalize(mix(Np, R, cl));
  }
  // back to view space, then light it
  vec3 Nv = vec3(Np.x*ca - Np.z*sa, Np.y, Np.x*sa + Np.z*ca);
  alb = pow(alb, vec3(2.2));
  float dif = max((dot(Nv, L) + wrap)/(1. + wrap), 0.);
  float day = smoothstep(-.08, .12, dot(N, L));     // the sphere's own day side, for lights and glint
  vec3 col = alb*uSunCol*dif*2.2 + alb*uAmb*1.5;
  vec3 Hh = normalize(L + vec3(0., 0., 1.));
  col += uSunCol*spec*(pow(max(dot(N, Hh), 0.), 90.)*1.6 + pow(max(dot(N, Hh), 0.), 12.)*.08)*day; // sun glint on water
  col += em*(1. - day);
  float rim = pow(1.-z, 3.);
  col += uAtm*uSunCol*rim*(.25+max(dot(N, L), 0.))*1.2;
  float aa = 1.-smoothstep(1.-uPx*1.5, 1., r);
  o = vec4(col*aa, aa);
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
