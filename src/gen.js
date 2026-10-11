/* Shipwright generator: brand catalog + size + seed -> part list -> baked maps.
   Pure JS, no DOM. Runs in the page and in node. Ship forward is +y. Units are meters. */
(function (root) {
'use strict';
const D2R = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const frac = x => x - Math.floor(x);
function hexRGB(h) { h = String(h).replace('#', ''); return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]; }

// ---------- random + noise ----------
function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng32(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function h2(x, y, s) { let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2246822519)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi, s), b = h2(xi + 1, yi, s), c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, s) { let f = 0, a = 0.5; for (let i = 0; i < 4; i++) { f += a * vnoise(x, y, s + i * 17); x = x * 2.03 + 1.7; y = y * 2.03 - 0.9; a *= 0.5; } return f / 0.9375; }

// ---------- signed distance functions (local space, +y forward) ----------
function sdTrap(px, py, r1, r2, he) { // r1 half-width at rear (y=-he), r2 at front (y=+he)
  px = Math.abs(px);
  const k1x = r2, k1y = he, k2x = r2 - r1, k2y = 2 * he;
  const cax = px - Math.min(px, py < 0 ? r1 : r2), cay = Math.abs(py) - he;
  const tt = clamp(((k1x - px) * k2x + (k1y - py) * k2y) / (k2x * k2x + k2y * k2y), 0, 1);
  const cbx = px - k1x + k2x * tt, cby = py - k1y + k2y * tt;
  const s = (cbx < 0 && cay < 0) ? -1 : 1;
  return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
}
function sdUCap(px, py, r1, r2, len) { // rear radius r1, front radius r2, total length len
  const h = Math.max(len - r1 - r2, Math.abs(r1 - r2) + 1e-4);
  py -= -len / 2 + r1; px = Math.abs(px);
  const b = (r1 - r2) / h, a = Math.sqrt(Math.max(0, 1 - b * b));
  const k = -b * px + a * py;
  if (k < 0) return Math.hypot(px, py) - r1;
  if (k > a * h) return Math.hypot(px, py - h) - r2;
  return a * px + b * py - r1;
}
function sdRBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdRing(px, py, R, t, gap) {
  let d = Math.abs(Math.hypot(px, py) - R) - t;
  if (gap > 0) { const gw = R * Math.sin(gap * D2R / 2); const slab = Math.max(Math.abs(px) - gw, -py); d = Math.max(d, -slab); }
  return d;
}
function sdPoly(px, py, v) {
  const N = v.length / 2; let d = (px - v[0]) ** 2 + (py - v[1]) ** 2, s = 1;
  for (let i = 0, j = N - 1; i < N; j = i, i++) {
    const vix = v[2 * i], viy = v[2 * i + 1], vjx = v[2 * j], vjy = v[2 * j + 1];
    const ex = vjx - vix, ey = vjy - viy, wx = px - vix, wy = py - viy;
    const tt = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * tt, by = wy - ey * tt; d = Math.min(d, bx * bx + by * by);
    const c1 = py >= viy, c2 = py < vjy, c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}
function partSDF(p, lx, ly) {
  const a = p.a;
  switch (p.prim) {
    case 'trap': return sdTrap(lx, ly, a.r1, a.r2, a.he);
    case 'ucap': return sdUCap(lx, ly, a.r1, a.r2, a.len);
    case 'rbox': return sdRBox(lx, ly, a.hw, a.hl, a.rad);
    case 'circle': return Math.hypot(lx, ly) - a.r;
    case 'ring': return sdRing(lx, ly, a.R, a.t, a.gap);
    case 'poly': return sdPoly(lx, ly, a.pts);
  }
  return 1e9;
}
// inset radius (max distance to edge) and half-length along local y, per primitive
function partMetrics(p) {
  const a = p.a;
  switch (p.prim) {
    case 'trap': return { inR: Math.min(Math.max(a.r1, a.r2) * 0.95, a.he), hl: a.he, rad: Math.hypot(Math.max(a.r1, a.r2), a.he) };
    case 'ucap': return { inR: Math.max(a.r1, a.r2), hl: a.len / 2, rad: a.len / 2 + Math.max(a.r1, a.r2) };
    case 'rbox': return { inR: Math.min(a.hw, a.hl), hl: a.hl, rad: Math.hypot(a.hw, a.hl) };
    case 'circle': return { inR: a.r, hl: a.r, rad: a.r };
    case 'ring': return { inR: a.t, hl: a.R + a.t, rad: a.R + a.t };
    case 'poly': {
      let m = 0, ymax = 0; for (let i = 0; i < a.pts.length; i += 2) { m = Math.max(m, Math.hypot(a.pts[i], a.pts[i + 1])); ymax = Math.max(ymax, Math.abs(a.pts[i + 1])); }
      return { inR: a.inR, hl: ymax, rad: m };
    }
  }
  return { inR: 1, hl: 1, rad: 1 };
}

const sample = (v, r) => (Array.isArray(v) ? lerp(v[0], v[1], r()) : (v == null ? 0 : v));
const count = (v, r) => (Array.isArray(v) ? v[0] + Math.floor(r() * (v[1] - v[0] + 1)) : (v || 0));

// wing / fin outline: root edge on local x=0, extends to +x
function finOutline(span, root, tip, sweep, curve, rootIn) {
  const pts = [];
  const le0 = [-rootIn, root / 2], le1 = [span, root / 2 - sweep * span];
  const te1 = [span, root / 2 - sweep * span - tip], te0 = [-rootIn, -root / 2];
  const n = curve > 0 ? 6 : 1;
  const bez = (p0, p2, bulge, t) => {
    const cx = (p0[0] + p2[0]) / 2, cy = (p0[1] + p2[1]) / 2 + bulge;
    const u = 1 - t; return [u * u * p0[0] + 2 * u * t * cx + t * t * p2[0], u * u * p0[1] + 2 * u * t * cy + t * t * p2[1]];
  };
  for (let i = 0; i <= n; i++) { const q = bez(le0, le1, curve * span * 0.5, i / n); pts.push(q[0], q[1]); }
  for (let i = n; i >= 0; i--) { if (i === n) { pts.push(te1[0], te1[1]); continue; } const q = bez(te0, te1, curve * span * 0.3, i / n); pts.push(q[0], q[1]); }
  return pts;
}

// ---------- assembly ----------
function assemble(brand, size, seed, sizeIdx) {
  const r = rng32(hashStr(brand.id + '|' + size.id + '|' + seed));
  const st = brand.style, L = size.length;
  const q = st.angleQuant || 0;
  const quant = a => (q ? Math.round(a / q) * q : a);
  const load = brand.loadout[size.id] || {};
  const parts = [];
  let uid = 0;

  function pick(role, ids) {
    const list = brand.parts.filter(p => p.role === role && (!ids || ids.includes(p.id)));
    if (!list.length) return null;
    const tw = list.reduce((s, p) => s + (p.w || 1), 0); let x = r() * tw;
    for (const p of list) { x -= (p.w || 1); if (x <= 0) return p; }
    return list[list.length - 1];
  }
  function mk(tmpl, prim, a, x, y, ang, z, H, extra) {
    return Object.assign({ id: uid++, tmpl: tmpl ? tmpl.id : null, prim, a, x, y, ang, z, H, prof: (tmpl && tmpl.prof) || st.bevel, role: tmpl ? tmpl.role : 'core', flip: false, paint: 0, det: {}, em: null }, extra || {});
  }
  function mirror(p) { return Object.assign({}, p, { id: uid++, x: -p.x, ang: -p.ang, flip: !p.flip, a: Object.assign({}, p.a), det: Object.assign({}, p.det) }); }
  function driftCopy(p) {
    const d = st.drift || 0; if (!d) return p;
    const a = Object.assign({}, p.a);
    for (const k of ['r1', 'r2', 'hw', 'hl', 'he', 'len', 'r']) if (typeof a[k] === 'number') a[k] *= 1 + d * (r() * 2 - 1);
    p.a = a; p.ang += (r() * 2 - 1) * d * 40; return p;
  }
  // build fn(): parts at +x side. Mirrored per brand symmetry; scrap brands may re-roll or drop the second side.
  function addPair(fn) {
    const A = fn(); parts.push(...A);
    const sym = st.symmetry == null ? 1 : st.symmetry;
    if (r() < sym) { A.forEach(p => parts.push(driftCopy(mirror(p)))); return; }
    if (r() < 0.3) return;
    fn().forEach(p => parts.push(mirror(p)));
  }
  const paintOf = (tmpl, role) => {
    const n = st.palette.hull.length;
    if (tmpl && tmpl.paint === 'trim') return -1;
    if (tmpl && tmpl.paint === 'any') return Math.floor(r() * n);
    if (role === 'core') return 0;
    return (st.union === 'smooth') ? Math.floor(r() * n) : (r() < 0.5 ? 0 : Math.min(1, n - 1));
  };

  // --- core ---
  const ct = pick('core', brand.core[size.id]);
  const coreH = ct.H * L;
  const core = { len: sample(ct.len, r) * L };
  core.y0 = -core.len / 2; core.y1 = core.len / 2;
  const tY = y => clamp((y - core.y0) / core.len, 0, 1);
  if (ct.prim === 'trap' || ct.prim === 'ucap') {
    const r1 = sample(ct.rear, r) * L, r2 = sample(ct.nose, r) * L;
    const a = ct.prim === 'trap' ? { r1, r2, he: core.len / 2 } : { r1, r2, len: core.len };
    parts.push(mk(ct, ct.prim, a, 0, 0, 0, 0, coreH, { paint: 0 }));
    core.hwAt = y => lerp(r1, r2, tY(y));
  } else if (ct.prim === 'rbox') {
    const hw = sample(ct.hw, r) * L, hl = core.len / 2;
    parts.push(mk(ct, 'rbox', { hw, hl, rad: (ct.rad || 0) * Math.min(hw, hl) }, 0, 0, 0, 0, coreH, { paint: 0 }));
    core.hwAt = () => hw;
  } else { // spine
    const n = count(ct.segs, r), hw = sample(ct.hw, r) * L, gap = sample(ct.gap, r), taper = sample(ct.taper, r);
    const sl = core.len / n;
    for (let i = 0; i < n; i++) {
      const yc = core.y0 + sl * (i + 0.5), hwi = hw * lerp(1, taper, i / Math.max(1, n - 1));
      const hl = sl * (1 - gap) / 2;
      parts.push(mk(ct, 'rbox', { hw: hwi, hl, rad: (ct.rad || 0) * Math.min(hwi, hl) }, 0, yc, 0, 0, coreH, { paint: 0, seg: i }));
    }
    if (gap > 0) parts.push(mk(ct, 'rbox', { hw: hw * 0.3, hl: core.len / 2, rad: hw * 0.1 }, 0, 0, 0, -0.25 * coreH, coreH * 0.9, { paint: -1, keel: true }));
    core.hwAt = y => hw * lerp(1, taper, tY(y));
  }
  const coreParts = parts.slice();

  const shapeA = (t, prim) => {
    if (prim === 'rbox') { const hw = sample(t.hw, r) * L, hl = sample(t.len, r) * L / 2; return { hw, hl, rad: (t.rad || 0) * Math.min(hw, hl) }; }
    if (prim === 'trap') return { r1: sample(t.rear, r) * L, r2: sample(t.nose, r) * L, he: sample(t.len, r) * L / 2 };
    if (prim === 'ucap') {
      if (t.r != null) { const rr = sample(t.r, r) * L; return { r1: rr, r2: rr, len: Math.max(sample(t.len, r) * L, rr * 2.1) }; }
      return { r1: sample(t.rear, r) * L, r2: sample(t.nose, r) * L, len: sample(t.len, r) * L };
    }
    if (prim === 'circle') return { r: sample(t.r, r) * L };
    return {};
  };

  // --- hull plates / lobes ---
  const nHull = count(load.hull, r);
  for (let i = 0; i < nHull; i++) {
    const t = pick('hull'); if (!t) break;
    addPair(() => {
      const y = sample(t.along, r) * core.len;
      const x = core.hwAt(y) * sample(t.out, r);
      const p = mk(t, t.prim, shapeA(t, t.prim), x, y, quant(sample(t.ang, r)), sample(t.z, r) * coreH, sample(t.H, r) * coreH, { paint: paintOf(t, 'hull') });
      if (t.accent) p.det.accent = true;
      return [p];
    });
  }

  // --- wings ---
  let wing = null;
  const nWing = count(load.wing, r);
  for (let i = 0; i < nWing; i++) {
    const t = pick('wing'); if (!t) break;
    addPair(() => {
      let sw = sample(t.sweep, r); if (q) sw = Math.tan(quant(Math.atan(sw) / D2R) * D2R);
      const span = sample(t.span, r) * L, root = sample(t.root, r) * L, tip = sample(t.tip, r) * L;
      const y = sample(t.at, r) * core.len, x = core.hwAt(y) * 0.75;
      const pts = finOutline(span, root, tip, sw, t.curve || 0, core.hwAt(y) * 0.3);
      const p = mk(t, 'poly', { pts, inR: Math.min(root, span) * 0.22 }, x, y, 0, t.z * coreH, t.H * coreH, { paint: paintOf(t, 'wing') });
      wing = wing || { x, y, span, root, tip, sw };
      return [p];
    });
  }

  // --- fins ---
  const nFin = count(load.fin, r);
  for (let i = 0; i < nFin; i++) {
    const t = pick('fin'); if (!t) break;
    addPair(() => {
      let sw = sample(t.sweep, r); if (q) sw = Math.tan(quant(Math.atan(sw) / D2R) * D2R);
      const span = sample(t.span, r) * L, root = sample(t.root, r) * L, tip = sample(t.tip, r) * L;
      const onWing = wing && (t.at === 'wingtip' || (t.at === 'mixed' && r() < 0.5));
      let x, y;
      if (onWing) { x = wing.x + wing.span * 0.92; y = wing.y + wing.root / 2 - wing.sw * wing.span - wing.tip * 0.3 + root * 0.2; }
      else { y = core.y0 + root * 0.55 + core.len * 0.03; x = core.hwAt(y) * 0.8; }
      const pts = finOutline(span, root, tip, sw, t.curve || 0, root * 0.1);
      const p = mk(t, 'poly', { pts, inR: Math.min(root, span) * 0.2 }, x, y, 0, t.z * coreH, t.H * coreH, { paint: paintOf(t, 'fin') });
      if (t.accent) p.det.accent = true;
      return [p];
    });
  }

  // --- engines ---
  const engT = pick('engine');
  function engineBell(t, x, y, scale) {
    const len = sample(t.len, r) * L * scale, he = len / 2;
    return mk(t, 'trap', { r1: sample(t.rear, r) * L * scale, r2: sample(t.front, r) * L * scale, he }, x, y, 0, t.z * coreH, t.H * coreH, { paint: -1, em: { type: 'exhaust', glow: t.glow || 0.5 } });
  }

  // --- nacelles (with strut and engine bell) ---
  const nNac = count(load.nacelle, r);
  for (let i = 0; i < nNac; i++) {
    const t = pick('nacelle'); if (!t) break;
    addPair(() => {
      const rr = sample(t.r, r) * L, len = Math.max(sample(t.len, r) * L, rr * 3);
      const y = sample(t.at, r) * core.len + i * len * 0.15;
      const x = core.hwAt(y) + rr * (1 + (t.gap || 0)) + i * rr * 2.4;
      const nac = mk(t, 'ucap', { r1: rr, r2: rr * sample(t.nose, r), len }, x, y, 0, t.z * coreH, t.H * coreH, { paint: paintOf(t, 'nacelle') });
      if (t.accent) nac.det.accent = true;
      const x0 = core.hwAt(y) * 0.4;
      const strut = mk({ id: t.id + '.strut', role: 'strut', prof: st.bevel }, 'rbox', { hw: (x - x0) / 2, hl: len * 0.16, rad: len * 0.02 }, (x + x0) / 2, y - len * 0.05, 0, (t.z - 0.15) * coreH, t.H * 0.5 * coreH, { paint: -1 });
      const out = [strut, nac];
      if (engT) { const b = engineBell(engT, x, 0, 0); b.a.r1 = rr * 0.9; b.a.r2 = rr * 0.65; b.a.he = rr * 0.55; b.y = y - len / 2 - b.a.he * 0.4; b.z = nac.z; b.H = nac.H * 0.6; out.push(b); }
      return out;
    });
  }

  // --- core engines ---
  const nEng = count(load.engine, r);
  if (engT && nEng > 0) {
    const sym = st.symmetry == null ? 1 : st.symmetry;
    const rear0 = sample(engT.rear, r) * L, len0 = sample(engT.len, r) * L;
    const spacing = rear0 * 2.15;
    const spread = spacing * (nEng - 1);
    const yR = core.y0;
    for (let i = 0; i < nEng; i++) {
      const xi = (i - (nEng - 1) / 2) * spacing;
      const b = engineBell(engT, xi, 0, 1);
      if (r() < sym) { b.a.r1 = rear0; b.a.he = len0 / 2; b.a.r2 = Math.min(b.a.r2, rear0 * 0.9); }
      b.y = yR - b.a.he * 0.55;
      parts.push(b);
    }
    if (spread / 2 + rear0 > core.hwAt(yR) * 1.05) {
      parts.push(mk({ id: engT.id + '.mount', role: 'strut', prof: st.bevel }, 'rbox', { hw: spread / 2 + rear0 * 0.8, hl: len0 * 0.5, rad: len0 * 0.1 }, 0, yR + len0 * 0.25, 0, -0.1 * coreH, 0.8 * coreH, { paint: -1 }));
    }
  }

  // --- pods ---
  const nPod = count(load.pod, r);
  const podT = pick('pod');
  if (podT && nPod > 0) {
    for (let k = 0; k < nPod; k++) {
      addPair(() => {
        const a = shapeA(podT, podT.prim);
        const y = lerp(podT.at[0], podT.at[1], (k + 0.5) / nPod) * core.len;
        const w = podT.prim === 'rbox' ? a.hw : Math.max(a.r1, a.r2);
        const x = core.hwAt(y) + w * 0.92;
        const p = mk(podT, podT.prim, a, x, y, quant(0), podT.z * coreH, podT.H * coreH, { paint: paintOf(podT, 'pod') });
        return [p];
      });
    }
  }

  // --- rings ---
  const nRing = count(load.ring, r);
  for (let i = 0; i < nRing; i++) {
    const t = pick('ring'); if (!t) break;
    const y = (sample(t.at, r) + i * 0.18) * core.len;
    const R = core.hwAt(y) * sample(t.r, r) * (1 + i * 0.25);
    parts.push(mk(t, 'ring', { R, t: sample(t.t, r) * L, gap: sample(t.gap, r) }, 0, y, r() < 0.5 ? 0 : 180, t.z * coreH, t.H * coreH, { paint: paintOf(t, 'ring') }));
  }

  // --- weapons ---
  const nW = count(load.weapon, r);
  const wt = pick('weapon');
  function weapon(x, y) {
    const out = [];
    const rr = sample(wt.r, r) * L, z = sample(wt.z, r) * coreH, H = sample(wt.H, r) * coreH;
    const base = mk(wt, 'circle', { r: rr }, x, y, 0, z, H, { paint: -1, prof: 'round' });
    if (wt.style === 'blister') base.em = { type: 'core' };
    out.push(base);
    const nb = wt.barrels || 0;
    const blen = sample(wt.blen, r) * L, bw = (wt.bw || 0.004) * L;
    for (let b = 0; b < nb; b++) {
      const bx = x + (b - (nb - 1) / 2) * bw * 2.8;
      const bar = mk({ id: wt.id + '.barrel', role: 'barrel', prof: 'round' }, 'rbox', { hw: bw, hl: blen / 2, rad: bw * 0.9 }, bx, y + blen / 2 + rr * 0.2, 0, z + H * 0.3, H * 0.55, { paint: -1 });
      if (wt.style === 'drill') bar.em = { type: 'tip' };
      out.push(bar);
    }
    return out;
  }
  if (wt && nW > 0) {
    if (sizeIdx <= 1) {
      const pairs = Math.floor(nW / 2);
      for (let k = 0; k < pairs; k++) addPair(() => { const y = lerp(0.05, 0.22, r()) * core.len + k * 0.1 * core.len; return weapon(core.hwAt(y) * 0.9, y); });
      if (nW % 2) parts.push(...weapon(0, 0.3 * core.len));
    } else {
      const c = nW <= 3 ? nW : Math.ceil(nW / 3);
      for (let k = 0; k < c; k++) parts.push(...weapon(0, lerp(-0.25, 0.36, (k + 0.5) / c) * core.len));
      const pairs = Math.floor((nW - c) / 2);
      for (let k = 0; k < pairs; k++) addPair(() => { const y = lerp(-0.2, 0.22, (k + 0.5) / Math.max(1, pairs)) * core.len; return weapon(core.hwAt(y) * 0.62, y); });
    }
  }

  // --- bridge / cockpit ---
  if (count(load.bridge, r) > 0) {
    const t = pick('bridge');
    if (t) {
      const y = sample(t.at, r) * core.len;
      let prim = t.prim, a, glass = !!t.glass;
      if (sizeIdx === 0 && !t.eye && !glass) { glass = true; prim = 'ucap'; }
      if (prim === 'ucap' && t.r == null && t.hw != null) { const rr = sample(t.hw, r) * L; a = { r1: rr, r2: rr, len: Math.max(sample(t.len, r) * L, rr * 2.4) }; }
      else a = shapeA(t, prim);
      const p = mk(t, prim, a, 0, y, 0, t.z * coreH, t.H * coreH, { paint: glass ? -2 : -1, prof: glass || t.eye ? 'round' : (t.prof || st.bevel) });
      if (t.eye) p.em = { type: 'core' };
      if (!glass && !t.eye && sizeIdx >= 1) p.det.windows = true;
      parts.push(p);
    }
  }

  // --- jitter, detail flags ---
  const pj = (st.posJitter || 0) * L, aj = st.angJitter || 0;
  const D = st.detail || {};
  for (const p of parts) {
    if (p.role !== 'core') { p.x += (r() * 2 - 1) * pj; p.y += (r() * 2 - 1) * pj; p.ang += (r() * 2 - 1) * aj; }
    const structural = ['core', 'hull', 'wing', 'pod', 'nacelle', 'fin', 'ring', 'strut', 'bridge'].includes(p.role);
    if (structural && p.paint !== -2) p.det.panel = true;
    if ((p.role === 'core' && !p.keel && sizeIdx >= 2) || (p.role === 'pod' && sizeIdx >= 2)) p.det.windows = (D.windows || 0) > 0;
    if (p.role === 'core' && !p.keel && (D.accentLines || 0) > 0) p.det.accent = true;
    if (p.det.accent && r() > (D.accentLines || 0) && p.role !== 'core') p.det.accent = false;
    if (p.role === 'core' && (D.stripes || 0) > 0 && st.union !== 'smooth' && brand.style.symmetry >= 1) p.det.stripes = true;
    if ((D.rivets || 0) > 0 && structural) p.det.rivets = true;
    if ((D.stripes || 0) > 0 && brand.style.symmetry < 1 && ['pod', 'bridge', 'hull'].includes(p.role) && r() < D.stripes * 0.5) p.det.hazard = true;
    if ((D.veins || 0) > 0 && ['core', 'hull', 'pod', 'nacelle'].includes(p.role)) p.det.veins = true;
    p.seedI = hashStr(brand.id + seed + ':' + p.id) & 0xffff;
  }

  // --- metrics, recenter ---
  let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
  for (const p of parts) {
    const m = partMetrics(p); p.inR = Math.max(m.inR, 1e-3); p.hl = m.hl; p.rad = m.rad;
    const bw = (st.bevelW || 0.3) * p.inR; p.bw = Math.max(bw, 0.02);
    bx0 = Math.min(bx0, p.x - p.rad); bx1 = Math.max(bx1, p.x + p.rad);
    by0 = Math.min(by0, p.y - p.rad); by1 = Math.max(by1, p.y + p.rad);
  }
  // tighter bounds by sampling the actual outline later; center on rough box
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
  for (const p of parts) { p.x -= cx; p.y -= cy; p.ca = Math.cos(p.ang * D2R); p.sa = Math.sin(p.ang * D2R); }
  return { brand: brand.id, size: size.id, seed, L, coreH, coreTemplate: ct.id, parts };
}

// ---------- bake ----------
function prof(p, t) {
  if (t <= 0) return 0;
  switch (p.prof) {
    case 'round': { const u = Math.min(t / p.inR, 1); return Math.sqrt(1 - (1 - u) * (1 - u)); }
    case 'ridge': return Math.min(t / p.inR, 1) * 0.7 + 0.3 * Math.min(t / p.bw, 1);
    case 'chamfer': return Math.min(t / p.bw, 1);
    default: return sstep(0, p.bw, t);
  }
}
function smin(a, b, k) { if (k <= 0) return Math.min(a, b); const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }
function smax(a, b, k) { return -smin(-a, -b, k); }

function bake(ship, brand, size) {
  const st = brand.style, D = st.detail || {}, pal = st.palette;
  const res = size.res, L = ship.L, parts = ship.parts;
  const smooth = st.union === 'smooth';
  const k = smooth ? (st.blend || 0.03) * L : 0;
  const hullCols = pal.hull.map(hexRGB), trim = hexRGB(pal.trim), glass = hexRGB(pal.glass), accent = hexRGB(pal.accent);
  const engine = hexRGB(pal.engine), windowC = hexRGB(pal.window), emissive = hexRGB(pal.emissive), rustC = hexRGB(pal.rust || '#000000');
  for (const p of parts) p.col = p.paint === -1 ? trim : p.paint === -2 ? glass : hullCols[p.paint % hullCols.length];

  // pass 0: exact silhouette bounds on a coarse grid to frame the texture
  let ex0 = 1e9, ey0 = 1e9, ex1 = -1e9, ey1 = -1e9;
  {
    let rx0 = 1e9, ry0 = 1e9, rx1 = -1e9, ry1 = -1e9;
    for (const p of parts) { rx0 = Math.min(rx0, p.x - p.rad); rx1 = Math.max(rx1, p.x + p.rad); ry0 = Math.min(ry0, p.y - p.rad); ry1 = Math.max(ry1, p.y + p.rad); }
    const N = 96, sx = (rx1 - rx0) / N, sy = (ry1 - ry0) / N;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const wx = rx0 + i * sx, wy = ry0 + j * sy;
      for (const p of parts) {
        if (Math.abs(wx - p.x) > p.rad || Math.abs(wy - p.y) > p.rad) continue;
        const dx = wx - p.x, dy = wy - p.y; let lx = dx * p.ca + dy * p.sa; const ly = -dx * p.sa + dy * p.ca; if (p.flip) lx = -lx;
        if (partSDF(p, lx, ly) < Math.max(sx, sy)) { ex0 = Math.min(ex0, wx); ex1 = Math.max(ex1, wx); ey0 = Math.min(ey0, wy); ey1 = Math.max(ey1, wy); break; }
      }
    }
  }
  const ccx = (ex0 + ex1) / 2, ccy = (ey0 + ey1) / 2;
  const shieldS = ((st.shield && st.shield.standoff) || 0.035) * L, Dmax = shieldS * 2.2;
  const extent = Math.max(ex1 - ex0, ey1 - ey0) * 1.08 + k * 2 + shieldS * 2.8;
  const px = extent / res;
  // recenter parts so the ship sits at texture center
  for (const p of parts) { p.x -= ccx; p.y -= ccy; }

  // spatial bins
  const B = 16, binW = extent / B, half = extent / 2;
  const bins = Array.from({ length: B * B }, () => []);
  const margin = Math.max(smooth ? k * 2.5 : px * 2, Dmax);
  parts.forEach((p, idx) => {
    const r0 = p.rad + margin;
    const i0 = clamp(Math.floor((p.x - r0 + half) / binW), 0, B - 1), i1 = clamp(Math.floor((p.x + r0 + half) / binW), 0, B - 1);
    const j0 = clamp(Math.floor((p.y - r0 + half) / binW), 0, B - 1), j1 = clamp(Math.floor((p.y + r0 + half) / binW), 0, B - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) bins[j * B + i].push(idx);
  });

  let hBase = 0, hTop = 0;
  for (const p of parts) { hBase = Math.min(hBase, p.z); hTop = Math.max(hTop, p.z + p.H); }
  hBase -= ship.coreH * 0.15;

  const n = res * res;
  const Hm = new Float32Array(n), A = new Float32Array(n), C = new Float32Array(n * 3), E = new Float32Array(n * 3), SP = new Float32Array(n), AX = new Float32Array(n), EG = new Float32Array(n);
  const fade = S => clamp((S / px - 1.6) / 3, 0, 1);
  const brandSeed = hashStr(brand.id) & 0xffff;

  for (let iy = 0; iy < res; iy++) {
    const wy = half - (iy + 0.5) * px;
    const bj = clamp(Math.floor((wy + half) / binW), 0, B - 1);
    for (let ix = 0; ix < res; ix++) {
      const wx = (ix + 0.5) * px - half;
      const bi = clamp(Math.floor((wx + half) / binW), 0, B - 1);
      const list = bins[bj * B + bi];
      let best = -1e9, bp = null, bt = 0, blx = 0, bly = 0, dmin = 1e9, hs = -1e9, dOut = 1e9;
      for (let q = 0; q < list.length; q++) {
        const p = parts[list[q]];
        const dx = wx - p.x, dy = wy - p.y;
        if (Math.abs(dx) > p.rad + margin || Math.abs(dy) > p.rad + margin) continue;
        let lx = dx * p.ca + dy * p.sa; const ly = -dx * p.sa + dy * p.ca; if (p.flip) lx = -lx;
        const d = partSDF(p, lx, ly);
        if (d < dOut) dOut = d;
        if (smooth) {
          if (d > k * 2.5) continue;
          const t = -d;
          const hp = p.z + p.H * prof(p, t) + Math.min(t, 0) * (p.H / p.inR) * 1.2;
          hs = hs === -1e9 ? hp : smax(hs, hp, k);
          dmin = smin(dmin, d, k);
          if (hp > best) { best = hp; bp = p; bt = t; blx = lx; bly = ly; }
        } else {
          if (d > px) continue;
          const t = -d;
          dmin = Math.min(dmin, d);
          const hp = p.z + p.H * prof(p, t);
          if (hp > best) { best = hp; bp = p; bt = t; blx = lx; bly = ly; }
        }
      }
      const o = iy * res + ix;
      const alpha = clamp(0.5 - dmin / px, 0, 1);
      A[o] = alpha;
      AX[o] = clamp(Math.max(smooth ? Math.min(dmin, dOut) : dOut, 0) / Dmax, 0, 1);
      if (!bp || alpha <= 0) { Hm[o] = hBase; continue; }
      let h = smooth ? hs : best;

      // ---------- surface detail on the winning part ----------
      const p = bp, t = Math.max(bt, 0), lx = blx, ly = bly;
      let cr = p.col[0], cg = p.col[1], cb = p.col[2];
      let spec = p.paint === -2 ? 1.0 : st.material.spec;
      let er = 0, eg = 0, eb = 0, dh = 0;
      const vn = ly / Math.max(p.hl, 1e-3);
      const mixc = (c, m) => { cr += (c[0] - cr) * m; cg += (c[1] - cg) * m; cb += (c[2] - cb) * m; };
      const mulc = m => { cr *= m; cg *= m; cb *= m; };
      const emit = (c, m) => { er += c[0] * m; eg += c[1] * m; eb += c[2] * m; };

      if (smooth) { // organic mottling + edge darkening
        const m = fbm(wx * 0.06 + 3, wy * 0.06, brandSeed);
        const c2 = hullCols[(p.paint + 1) % hullCols.length]; mixc(c2, sstep(0.35, 0.75, m) * 0.6);
        mulc(0.72 + 0.28 * Math.min(t / p.inR, 1));
      }
      if (p.paint === -2) { // glass canopy streak
        const s = sstep(0.15, 0.0, Math.abs(lx / p.inR + 0.35 - vn * 0.2)); cr += 0.12 * s; cg += 0.14 * s; cb += 0.16 * s;
      }
      // panel lines
      if (p.det.panel && (D.panelSpacing || 0) > 0) {
        const S = D.panelSpacing, f = fade(S);
        if (f > 0) {
          const asp = D.panelAspect || 1, S2 = S * asp;
          const yy = ly / S + (p.seedI % 97) * 0.13, row = Math.floor(yy), fy = yy - row;
          const xx = (lx + h2(row, 3, p.seedI) * S2) / S2, col = Math.floor(xx), fx = xx - col;
          const e = Math.min(Math.min(fy, 1 - fy), Math.min(fx, 1 - fx) * asp);
          const lw = Math.max(px * 0.7, S * 0.03) / S;
          if (t > Math.min(S * 0.2, p.inR * 0.4)) {
            if (e < lw) { const g = f * (1 - e / lw); dh -= (D.panelDepth || 0.5) * px * 0.9 * g; mulc(1 - 0.3 * g * (D.panelDark || 0.5)); spec *= 1 - 0.3 * g; }
            const tone = (h2(row, col, p.seedI) - 0.5) * (D.panelTone || 0) * f; mulc(1 + tone);
          }
        }
      }
      // patches (scrap)
      if ((D.patches || 0) > 0 && p.det.panel) {
        const Sx = 3.0, Sy = 2.2, f = fade(Sx);
        if (f > 0) {
          const ux = lx / Sx + (p.seedI % 13) * 0.37, uy = ly / Sy, cx = Math.floor(ux), cy = Math.floor(uy);
          const hh = h2(cx, cy, p.seedI + 5);
          if (hh < D.patches) {
            const fx = ux - cx, fy = uy - cy, inset = 0.12;
            if (fx > inset && fx < 1 - inset && fy > inset && fy < 1 - inset && t > 0.3) {
              const pc = hullCols[Math.floor(h2(cx, cy, 77) * hullCols.length)];
              mixc(pc, 0.85 * f); mulc(0.8 + 0.4 * h2(cx, cy, 9)); dh += px * 0.6 * f;
            }
          }
        }
      }
      // rivets (scrap)
      if (p.det.rivets && (D.rivets || 0) > 0) {
        const S = 0.8, f = fade(S);
        if (f > 0 && Math.abs(t - 0.45) < 0.22) {
          const fx = frac(lx / S) - 0.5, fy = frac(ly / S) - 0.5;
          const rd = Math.hypot(fx, fy) * S;
          if (rd < 0.17) { const g = f * (1 - rd / 0.17); dh += px * 0.9 * g; mulc(1 + 0.15 * g); }
        }
      }
      // ribs (organic)
      if (smooth && (D.ribs || 0) > 0 && ['core', 'hull', 'pod', 'nacelle', 'wing', 'fin'].includes(p.role)) {
        const S = D.ribSpacing || 1.4, f = fade(S);
        if (f > 0) dh += D.ribs * Math.min(p.H * 0.05, px * 1.2) * Math.sin(ly * 2 * Math.PI / S) * sstep(0, p.inR * 0.4, t) * f;
      }
      // grime
      if ((D.grime || 0) > 0) { const g = fbm(wx * 0.3, wy * 0.3, brandSeed + 99); mulc(1 - D.grime * 0.4 * (g - 0.25)); }
      // rust (scrap)
      if ((D.rust || 0) > 0 && p.paint !== -2) {
        let m = sstep(0.56, 0.8, fbm(wx * 0.14, wy * 0.14, brandSeed + 5)) * D.rust;
        m += (1 - sstep(0, 0.6, t)) * D.rust * 0.45 * fbm(wx * 1.1, wy * 1.1, 3);
        m = clamp(m, 0, 1);
        const rv = 0.75 + 0.5 * fbm(wx * 1.7, wy * 1.7, 11);
        mixc([rustC[0] * rv, rustC[1] * rv, rustC[2] * rv], m * 0.85); spec *= 1 - 0.85 * m;
      }
      // military stripes on core
      if (p.det.stripes) {
        const s = D.stripes;
        if ((vn > 0.5 && vn < 0.56) || (vn > 0.6 && vn < 0.625)) mixc(accent, 0.85 * s);
        if (vn > -0.62 && vn < -0.45 && Math.abs(lx) < p.inR * 0.18) mixc(accent, 0.55 * s);
      }
      // hazard stripes (scrap)
      if (p.det.hazard && vn > 0.62) { const hz = frac((lx + ly) / 1.1) < 0.5; mixc(hz ? accent : trim, 0.8 * fade(1.1)); }
      // corporate accent trim line
      if (p.det.accent) {
        const ai = Math.min(p.inR * 0.3, 1.0), aw = Math.max(px * 0.8, 0.12);
        if (Math.abs(t - ai) < aw / 2) { emit(accent, 1.1); mixc(accent, 0.3); }
      }
      // windows
      if (p.det.windows && (D.windows || 0) > 0 && Math.abs(vn) < 0.82) {
        const wi = Math.min(1.2, p.inR * 0.4), ww = 0.45, S = 1.5, f = fade(ww * 2);
        if (f > 0 && Math.abs(t - wi) < Math.max(ww, px) / 2) {
          const cell = Math.floor(ly / S), fy = frac(ly / S);
          if (fy > 0.25 && fy < 0.75 && h2(cell, Math.sign(lx) + 2, p.seedI) < D.windows) emit(windowC, 0.95 * f);
        }
      }
      // lamps
      if ((D.lamps || 0) > 0 && p.paint !== -2) {
        const S = 6, cx = Math.floor(wx / S), cy = Math.floor(wy / S);
        if (h2(cx, cy, brandSeed + 31) < D.lamps) {
          const ox = (h2(cx, cy, 1) * 0.6 + 0.2) * S, oy = (h2(cx, cy, 2) * 0.6 + 0.2) * S;
          const dd = Math.hypot(wx - cx * S - ox, wy - cy * S - oy), rr = Math.max(0.28, px * 0.8);
          if (dd < rr && t > 0.3) emit(emissive, 1.4 * (1 - dd / rr));
        }
      }
      // veins + spots (organic)
      if (p.det.veins) {
        const nv = fbm(wx * 0.11 + 13, wy * 0.11 - 4, brandSeed + 3);
        const v = 1 - sstep(0.0, Math.max(0.012, px * 0.02), Math.abs(nv - 0.5));
        const m = sstep(p.inR * 0.12, p.inR * 0.5, t) * fade(1.2);
        if (v > 0) { emit(emissive, v * D.veins * 0.6 * m); mulc(1 - 0.25 * v * m); }
        if ((D.spots || 0) > 0) {
          const S = 2.2, cx = Math.floor(lx / S), cy = Math.floor(ly / S);
          if (h2(cx, cy, p.seedI + 41) < D.spots) {
            const dd = Math.hypot(lx - (cx + 0.5) * S, ly - (cy + 0.5) * S), rr = Math.max(0.3, px * 0.7);
            if (dd < rr) emit(emissive, 1.2 * (1 - dd / rr) * fade(S));
          }
        }
      }
      // engine exhaust, weapon tips, glowing cores
      if (p.em) {
        if (p.em.type === 'exhaust') {
          const gl = p.em.glow * 2 * p.hl, g = sstep(-p.hl + gl, -p.hl, ly);
          const rim = p.inR * 0.22;
          if (g > 0 && t > rim) { EG[o] = g; emit(engine, (0.35 + 1.9 * g * g) * g); dh -= p.H * 0.55 * g; mulc(0.35); spec *= 0.3; }
          else mulc(0.85);
        } else if (p.em.type === 'tip') {
          const g = sstep(p.hl - p.inR * 4, p.hl, ly); emit(engine, 1.4 * g);
        } else if (p.em.type === 'core') {
          const d0 = Math.hypot(lx, ly) / p.inR, g = 1 - sstep(0, 0.8, d0);
          emit(emissive, 1.5 * g); mixc(glass, 0.6);
        }
      }

      Hm[o] = h + dh;
      C[o * 3] = cr; C[o * 3 + 1] = cg; C[o * 3 + 2] = cb;
      E[o * 3] = er; E[o * 3 + 1] = eg; E[o * 3 + 2] = eb;
      SP[o] = clamp(spec, 0, 1);
    }
  }

  // normals from height (Sobel), exaggerated per brand
  const ex = st.heightScale || 1;
  const albedo = new Uint8ClampedArray(n * 4), nrm = new Uint8ClampedArray(n * 4), emis = new Uint8ClampedArray(n * 4), aux = new Uint8ClampedArray(n * 4);
  const he = (ix, iy) => { ix = clamp(ix, 0, res - 1); iy = clamp(iy, 0, res - 1); const o = iy * res + ix; return hBase + (Hm[o] - hBase) * A[o]; };
  const hRange = Math.max(hTop - hBase, 1e-3);
  for (let iy = 0; iy < res; iy++) for (let ix = 0; ix < res; ix++) {
    const o = iy * res + ix;
    const gx = (he(ix + 1, iy - 1) + 2 * he(ix + 1, iy) + he(ix + 1, iy + 1) - he(ix - 1, iy - 1) - 2 * he(ix - 1, iy) - he(ix - 1, iy + 1)) / (8 * px);
    const gy = (he(ix - 1, iy - 1) + 2 * he(ix, iy - 1) + he(ix + 1, iy - 1) - he(ix - 1, iy + 1) - 2 * he(ix, iy + 1) - he(ix + 1, iy + 1)) / (8 * px);
    let nx = -gx * ex, ny = -gy * ex, nz = 1; const il = 1 / Math.hypot(nx, ny, nz); nx *= il; ny *= il; nz *= il;
    const a = A[o];
    nrm[o * 4] = (nx * 0.5 + 0.5) * 255; nrm[o * 4 + 1] = (ny * 0.5 + 0.5) * 255; nrm[o * 4 + 2] = nz * 255;
    nrm[o * 4 + 3] = clamp((he(ix, iy) - hBase) / hRange, 0, 1) * 255;
    albedo[o * 4] = clamp(C[o * 3], 0, 1) * 255; albedo[o * 4 + 1] = clamp(C[o * 3 + 1], 0, 1) * 255; albedo[o * 4 + 2] = clamp(C[o * 3 + 2], 0, 1) * 255; albedo[o * 4 + 3] = a * 255;
    aux[o * 4] = AX[o] * 255; aux[o * 4 + 1] = EG[o] * 255; aux[o * 4 + 3] = 255;
    emis[o * 4] = clamp(E[o * 3] * 0.5, 0, 1) * 255; emis[o * 4 + 1] = clamp(E[o * 3 + 1] * 0.5, 0, 1) * 255; emis[o * 4 + 2] = clamp(E[o * 3 + 2] * 0.5, 0, 1) * 255; emis[o * 4 + 3] = SP[o] * 255;
  }
  // nozzle positions for exhaust plumes (texture uv, aft direction in ship-local y-up)
  const engines = [];
  for (const p of parts) {
    if (!p.em || p.em.type !== 'exhaust') continue;
    const wx = p.x + p.hl * p.sa, wy = p.y - p.hl * p.ca;
    engines.push({ u: (wx + half) / extent, v: (half - wy) / extent, w: 2 * p.a.r1 / extent, dx: p.sa, dy: -p.ca });
  }
  return { res, extent, px, hRange: hRange * ex, albedo, nrm, emis, aux, engines, shieldS, Dmax, partCount: parts.length };
}

function generate(catalog, brandId, sizeId, seed) {
  const brand = catalog.brands.find(b => b.id === brandId);
  const sizeIdx = catalog.sizes.findIndex(s => s.id === sizeId);
  const size = catalog.sizes[sizeIdx];
  const ship = assemble(brand, size, seed, sizeIdx);
  const maps = bake(ship, brand, size);
  return { ship, maps };
}

// compact human-readable spec of a ship (for the JSON panel)
function describe(ship) {
  const r2 = v => Math.round(v * 100) / 100;
  return {
    brand: ship.brand, size: ship.size, seed: ship.seed, length_m: ship.L, core: ship.coreTemplate,
    parts: ship.parts.map(p => {
      const a = {}; for (const k in p.a) if (k !== 'pts') a[k] = r2(p.a[k]);
      if (p.a.pts) a.vertices = p.a.pts.length / 2;
      return { tmpl: p.tmpl, role: p.role, prim: p.prim, x: r2(p.x), y: r2(p.y), ang: r2(p.ang), mirrored: p.flip, z: r2(p.z), H: r2(p.H), params: a };
    })
  };
}

const api = { generate, assemble, bake, describe, hexRGB };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ShipGen = api;
})(typeof self !== 'undefined' ? self : this);
