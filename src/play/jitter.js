// ======================= JITTER =======================
// A per-frame probe for how smoothly things move on screen. Each recorded frame keeps its time step, the ticks it
// ran, the interpolation alpha, the player's drawn position, the camera and the view scale; each other ship's drawn
// position is followed too. Jitter is measured as a change of apparent speed: with positions p0, p1, p2 at frame
// steps dt1 and dt2, (p2 - p1)/dt2 - (p1 - p0)/dt1, times dt2, in pixels of a view 1080 device pixels tall (so numbers
// compare across screens and window sizes: a 4K screen sees twice these). Steady motion scores 0 at any frame
// rate and any pattern of ticks per frame; an uneven step (a pose that lands early or late, a hitch, a snap) scores
// how far it is off, in pixels. Read for: the player's ship in the world, the camera (the background's motion), the
// ship on screen (relative to the camera: what the eye tracks), and the worst other ship each frame.
// J toggles an overlay: frame times as bars (the line is 60 Hz) and the numbers. window.__play.jitter() reports.
function makeJitter(maxShips, N = 1200) {
  const dt = new Float64Array(N), ticks = new Uint8Array(N), alpha = new Float64Array(N);
  const jShip = new Float64Array(N), jCam = new Float64Array(N), jScreen = new Float64Array(N), jOther = new Float64Array(N), oSlot = new Int16Array(N), oState = new Uint8Array(N);
  let n = 0, head = 0;
  // the last two frames of the player and camera (world m), and of every ship slot
  const P = new Float64Array(12); let pN = 0, lastDt = 0;
  const S = new Float64Array(maxShips * 4), sN = new Uint8Array(maxShips), sGen = new Uint32Array(maxShips), sState = new Uint8Array(maxShips);
  const d2 = (x0, y0, x1, y1, x2, y2, dt1, dt2) => Math.hypot((x2 - x1) / dt2 - (x1 - x0) / dt1, (y2 - y1) / dt2 - (y1 - y0) / dt1) * dt2;
  // forget the history (a pause, the port, a teleport): the next frames start fresh
  function reset() { pN = 0; sN.fill(0); }
  // one frame: f = { dt, ticks, alpha, px, py, cx, cy, scale, h } (scale in device px per m; h the view's height in
  // device px), and the ship columns. state(i) is a ship's motion state (the page's: for traffic, its phase and rail
  // flag), 0 while it is drawn from something other than its core pose (a landing or launch sequence): a ship's
  // history restarts when its state changes, and the worst frame keeps the state it was in.
  function record(f, SH, count, state) {
    const k1080 = f.scale * 1080 / f.h; // pixels per metre on the 1080-tall reference view
    // shift the player and camera history: [x0 y0 cx0 cy0 | x1 y1 cx1 cy1 | x2 y2 cx2 cy2]
    P.copyWithin(0, 4); P[8] = f.px; P[9] = f.py; P[10] = f.cx; P[11] = f.cy;
    const ready = pN >= 2 && lastDt > 0 && f.dt > 0; pN = Math.min(pN + 1, 3);
    let worst = 0, wSlot = -1, wState = 0;
    for (let i = 1; i < count; i++) {
      const st = state ? state(i) : 1;
      if (!SH.alive[i] || SH.generation[i] !== sGen[i] || st !== sState[i]) { sN[i] = 0; sGen[i] = SH.generation[i]; sState[i] = st; }
      if (!SH.alive[i] || !st) continue;
      const o = i * 4, x = SH.rx[i], y = SH.ry[i];
      if (sN[i] >= 2 && ready) { const j = d2(S[o], S[o + 1], S[o + 2], S[o + 3], x, y, lastDt, f.dt) * k1080; if (j > worst) { worst = j; wSlot = i; wState = st; } }
      S[o] = S[o + 2]; S[o + 1] = S[o + 3]; S[o + 2] = x; S[o + 3] = y; sN[i] = Math.min(sN[i] + 1, 2);
    }
    if (ready) {
      const k = head;
      dt[k] = f.dt; ticks[k] = f.ticks; alpha[k] = f.alpha;
      jShip[k] = d2(P[0], P[1], P[4], P[5], P[8], P[9], lastDt, f.dt) * k1080;
      jCam[k] = d2(P[2], P[3], P[6], P[7], P[10], P[11], lastDt, f.dt) * k1080;
      jScreen[k] = d2(P[0] - P[2], P[1] - P[3], P[4] - P[6], P[5] - P[7], P[8] - P[10], P[9] - P[11], lastDt, f.dt) * k1080;
      jOther[k] = worst; oSlot[k] = wSlot; oState[k] = wState;
      head = (head + 1) % N; n = Math.min(n + 1, N);
    }
    lastDt = f.dt;
  }
  const idx = k => (head - n + k + N) % N;
  function stats(arr) {
    if (!n) return { mean: 0, rms: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const v = Array.from({ length: n }, (_, k) => arr[idx(k)]).sort((a, b) => a - b), q = p => v[Math.min(n - 1, Math.floor(p * n))];
    const mean = v.reduce((s, x) => s + x, 0) / n, rms = Math.sqrt(v.reduce((s, x) => s + x * x, 0) / n);
    const r = x => Math.round(x * 1000) / 1000;
    return { mean: r(mean), rms: r(rms), p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(v[n - 1]) };
  }
  function report() {
    const ms = stats(dt.map(x => x * 1000)), tk = {};
    for (let k = 0; k < n; k++) { const t = ticks[idx(k)]; tk[t] = (tk[t] || 0) + 1; }
    let hitches = 0; for (let k = 0; k < n; k++) if (dt[idx(k)] * 1000 > ms.p50 * 1.5) hitches++;
    let wk = -1; for (let k = 0; k < n; k++) if (wk < 0 || jOther[idx(k)] > jOther[idx(wk)]) wk = k;
    return {
      frames: n, frameMs: ms, hitches, ticksPerFrame: tk,
      ship: stats(jShip), camera: stats(jCam), onScreen: stats(jScreen), others: stats(jOther),
      worstOther: wk >= 0 ? { slot: oSlot[idx(wk)], state: oState[idx(wk)], px: Math.round(jOther[idx(wk)] * 1000) / 1000, framesAgo: n - 1 - wk } : null
    };
  }
  // the overlay: the last frames' times as bars (taller is slower; the line is 16.7 ms), and the summary
  let shown = false, sum = null, sumAt = 0;
  function draw(c, x, y, w, h, now) {
    if (!shown) return;
    if (!sum || now - sumAt > 500) { sum = report(); sumAt = now; }
    c.save();
    c.fillStyle = 'rgba(7,9,12,.8)'; c.fillRect(x, y, w, h);
    const bars = Math.min(n, Math.floor(w / 2)), sy = (h - 64) / 50;
    for (let k = 0; k < bars; k++) {
      const i = idx(n - bars + k), ms = dt[i] * 1000, j = Math.max(jScreen[i], jOther[i] * 0.25);
      c.fillStyle = j > 2 ? '#e05a4a' : j > 0.5 ? '#e0b04a' : '#5fae74';
      c.fillRect(x + k * 2, y + h - Math.min(h - 64, ms * sy), 1.5, Math.min(h - 64, ms * sy));
    }
    c.strokeStyle = 'rgba(255,255,255,.35)'; c.beginPath(); c.moveTo(x, y + h - 16.7 * sy); c.lineTo(x + w, y + h - 16.7 * sy); c.stroke();
    c.fillStyle = '#dbe0e7'; c.font = '500 11px ui-monospace, monospace';
    const s = sum, f = v => v.toFixed(2);
    [`frame ${f(s.frameMs.mean)} ms  p99 ${f(s.frameMs.p99)}  max ${f(s.frameMs.max)}  hitches ${s.hitches}/${s.frames}`,
      `ticks/frame ${Object.entries(s.ticksPerFrame).map(([t, c]) => `${t}:${c}`).join(' ')}`,
      `jitter px at 1080p (p99/max)  ship ${f(s.ship.p99)}/${f(s.ship.max)}  camera ${f(s.camera.p99)}/${f(s.camera.max)}  on screen ${f(s.onScreen.p99)}/${f(s.onScreen.max)}`,
      `others ${f(s.others.p99)}/${f(s.others.max)}${s.worstOther && s.worstOther.slot >= 0 ? ` (worst slot ${s.worstOther.slot})` : ''}`]
      .forEach((t, k) => c.fillText(t, x + 8, y + 15 + k * 14));
    c.restore();
  }
  return { record, reset, report, draw, toggle: () => { shown = !shown; return shown; }, clear: () => { n = 0; head = 0; reset(); } };
}
