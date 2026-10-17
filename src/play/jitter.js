// ======================= JITTER =======================
// A per-frame probe for how smoothly things move on screen. Each recorded frame keeps its time step, the ticks it
// ran, the interpolation alpha, the player's drawn position, the camera and the view scale; each other ship's drawn
// position is followed too. Jitter is a change of acceleration (jerk) from four frames' positions, scaled so a pose
// that lands one frame off by d pixels scores about d: smooth motion, steady or accelerating (thrust, a well's pull),
// scores 0 at any frame rate and any pattern of ticks per frame. Pixels are of a view 1080 device pixels tall (so
// numbers compare across screens and window sizes: a 4K screen sees twice these). Read for: the player's ship in the
// world, the camera (the background's motion), the ship on screen (relative to the camera: what the eye tracks), and
// the worst other ship each frame. Frame pacing is separate: frame times, hitches (frames over 1.5 x the median),
// the GPU's own time per frame where the browser can time it (EXT_disjoint_timer_query_webgl2), and the page's own
// (CPU) time per frame by section: the sim, the render calls, the HUD (with the location list) and the map. For each
// hitch, the frame before it is split into its CPU time and the rest (GPU, browser, garbage collection), so a hitch
// with little CPU before it is the GPU or the browser. Long main-thread tasks (over 50 ms; Chrome only) count too.
// Shift+J toggles an overlay: frame times as bars (the line is 60 Hz; bars go amber or red as jitter or a hitch grows)
// and the numbers. window.__play.jitter() reports.
function makeJitter(maxShips, N = 1200) {
  const dt = new Float64Array(N), ticks = new Uint8Array(N), alpha = new Float64Array(N), gpu = new Float64Array(N);
  // the page's CPU time per frame, ms, by section (the order of `CPU`)
  const CPU = ['total', 'sim', 'render', 'hud', 'map'], cpu = CPU.map(() => new Float64Array(N)); let lastK = -1;
  // long main-thread tasks: when, and how long
  const longs = [];
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) { longs.push([e.startTime, e.duration]); if (longs.length > 200) longs.shift(); } }).observe({ type: 'longtask' }); } catch (e) { /* not in this browser */ }
  const jShip = new Float64Array(N), jCam = new Float64Array(N), jScreen = new Float64Array(N), jOther = new Float64Array(N), oSlot = new Int16Array(N), oState = new Uint8Array(N);
  let n = 0, head = 0;
  // the last three frames of the player and camera (world m), their steps, and every ship slot's last three positions
  const P = new Float64Array(16), D = new Float64Array(3); let pN = 0;
  const S = new Float64Array(maxShips * 6), sN = new Uint8Array(maxShips), sGen = new Uint32Array(maxShips), sState = new Uint8Array(maxShips);
  // jerk along one axis from positions a..d at steps D[0..2] (d the newest), as a one-frame displacement
  const j1 = (a, b, c, d) => {
    const v1 = (b - a) / D[0], v2 = (c - b) / D[1], v3 = (d - c) / D[2];
    return ((v3 - v2) / ((D[1] + D[2]) / 2) - (v2 - v1) / ((D[0] + D[1]) / 2)) * D[2] * D[2] / 3;
  };
  const j2 = (ax, ay, bx, by, cx, cy, dx, dy) => Math.hypot(j1(ax, bx, cx, dx), j1(ay, by, cy, dy));
  // forget the history (a pause, the port, a teleport): the next frames start fresh
  function reset() { pN = 0; sN.fill(0); }
  let gpuNow = NaN; // the GPU's time for a recent frame, ms (NaN when the browser can't time it)
  // one frame: f = { dt, ticks, alpha, px, py, cx, cy, scale, h } (scale in device px per m; h the view's height in
  // device px), and the ship columns. state(i) is a ship's motion state (the page's: for traffic, its phase and rail
  // flag), 0 while it is drawn from something other than its core pose (a landing or launch sequence): a ship's
  // history restarts when its state changes, and the worst frame keeps the state it was in.
  function record(f, SH, count, state) {
    const k1080 = f.scale * 1080 / f.h; // pixels per metre on the 1080-tall reference view
    // shift the history: four frames of [x y cx cy], oldest first, and the three steps between them
    P.copyWithin(0, 4); P[12] = f.px; P[13] = f.py; P[14] = f.cx; P[15] = f.cy;
    D.copyWithin(0, 1); D[2] = f.dt;
    const ready = pN >= 3 && D[0] > 0 && D[1] > 0 && D[2] > 0; pN = Math.min(pN + 1, 4);
    let worst = 0, wSlot = -1, wState = 0;
    for (let i = 1; i < count; i++) {
      const st = state ? state(i) : 1;
      if (!SH.alive[i] || SH.generation[i] !== sGen[i] || st !== sState[i]) { sN[i] = 0; sGen[i] = SH.generation[i]; sState[i] = st; }
      if (!SH.alive[i] || !st) continue;
      const o = i * 6, x = SH.rx[i], y = SH.ry[i];
      if (sN[i] >= 3 && ready) { const j = j2(S[o], S[o + 1], S[o + 2], S[o + 3], S[o + 4], S[o + 5], x, y) * k1080; if (j > worst) { worst = j; wSlot = i; wState = st; } }
      S.copyWithin(o, o + 2, o + 6); S[o + 4] = x; S[o + 5] = y; sN[i] = Math.min(sN[i] + 1, 3);
    }
    if (ready) {
      const k = head;
      dt[k] = f.dt; ticks[k] = f.ticks; alpha[k] = f.alpha; gpu[k] = gpuNow; lastK = k; for (const a of cpu) a[k] = NaN;
      jShip[k] = j2(P[0], P[1], P[4], P[5], P[8], P[9], P[12], P[13]) * k1080;
      jCam[k] = j2(P[2], P[3], P[6], P[7], P[10], P[11], P[14], P[15]) * k1080;
      jScreen[k] = j2(P[0] - P[2], P[1] - P[3], P[4] - P[6], P[5] - P[7], P[8] - P[10], P[9] - P[11], P[12] - P[14], P[13] - P[15]) * k1080;
      jOther[k] = worst; oSlot[k] = wSlot; oState[k] = wState;
      head = (head + 1) % N; n = Math.min(n + 1, N);
    } else lastK = -1;
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
    let gn = 0; const gv = new Float64Array(n); for (let k = 0; k < n; k++) { const g = gpu[idx(k)]; if (g === g) gv[gn++] = g; }
    const gs = gn ? (() => { const v = Array.from(gv.subarray(0, gn)).sort((a, b) => a - b), r = x => Math.round(x * 100) / 100; return { p50: r(v[gn >> 1]), p99: r(v[Math.min(gn - 1, Math.floor(gn * 0.99))]), max: r(v[gn - 1]) }; })() : null;
    for (let k = 0; k < n; k++) { const t = ticks[idx(k)]; tk[t] = (tk[t] || 0) + 1; }
    let hitches = 0; for (let k = 0; k < n; k++) if (dt[idx(k)] * 1000 > ms.p50 * 1.5) hitches++;
    let wk = -1; for (let k = 0; k < n; k++) if (wk < 0 || jOther[idx(k)] > jOther[idx(wk)]) wk = k;
    // CPU by section, and each hitch's preceding frame split into its CPU and the rest
    const cpuStats = {}; CPU.forEach((name, c) => { const v = []; for (let k = 0; k < n; k++) { const x = cpu[c][idx(k)]; if (x === x) v.push(x); } v.sort((a, b) => a - b); const r = x => Math.round(x * 100) / 100; cpuStats[name] = v.length ? { p50: r(v[v.length >> 1]), p99: r(v[Math.min(v.length - 1, Math.floor(v.length * 0.99))]), max: r(v[v.length - 1]) } : null; });
    let hn = 0; const hs = { frameMs: 0, prevCpu: 0, rest: 0 }; CPU.slice(1).forEach(s => { hs[s] = 0; });
    for (let k = 1; k < n; k++) {
      const i = idx(k), p = idx(k - 1), ms2 = dt[i] * 1000, pc = cpu[0][p];
      if (!(ms2 > ms.p50 * 1.5) || !(pc === pc)) continue;
      hn++; hs.frameMs += ms2; hs.prevCpu += pc; hs.rest += ms2 - pc; CPU.slice(1).forEach((s, c) => { hs[s] += cpu[c + 1][p]; });
    }
    if (hn) for (const key in hs) hs[key] = Math.round(hs[key] / hn * 100) / 100;
    const now = performance.now(), recentLongs = longs.filter(([t]) => now - t < (n * (ms.mean || 16.7)));
    return {
      frames: n, frameMs: ms, gpuMs: gs, hitches, ticksPerFrame: tk, cpuMs: cpuStats, hitchCause: hn ? Object.assign({ hitches: hn }, hs) : null,
      longTasks: { count: recentLongs.length, maxMs: recentLongs.length ? Math.round(Math.max(...recentLongs.map(l => l[1]))) : 0 },
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
    const bars = Math.min(n, Math.floor(w / 2)), sy = (h - 106) / 50;
    for (let k = 0; k < bars; k++) {
      const i = idx(n - bars + k), ms = dt[i] * 1000, j = Math.max(jScreen[i], jCam[i], jOther[i] * 0.25), hitch = ms > (sum.frameMs.p50 || 16.7) * 1.5;
      c.fillStyle = j > 2 || hitch ? '#e05a4a' : j > 0.5 ? '#e0b04a' : '#5fae74';
      c.fillRect(x + k * 2, y + h - Math.min(h - 106, ms * sy), 1.5, Math.min(h - 106, ms * sy));
    }
    c.strokeStyle = 'rgba(255,255,255,.35)'; c.beginPath(); c.moveTo(x, y + h - 16.7 * sy); c.lineTo(x + w, y + h - 16.7 * sy); c.stroke();
    c.fillStyle = '#dbe0e7'; c.font = '500 11px ui-monospace, monospace';
    const s = sum, f = v => v.toFixed(2);
    [`frame ${f(s.frameMs.mean)} ms  p99 ${f(s.frameMs.p99)}  max ${f(s.frameMs.max)}  hitches ${s.hitches}/${s.frames}  gpu ${s.gpuMs ? `${f(s.gpuMs.p50)} ms, p99 ${f(s.gpuMs.p99)}` : 'not timed by this browser'}`,
      `ticks/frame ${Object.entries(s.ticksPerFrame).map(([t, c]) => `${t}:${c}`).join(' ')}`,
      `jitter px at 1080p (p99/max)  ship ${f(s.ship.p99)}/${f(s.ship.max)}  camera ${f(s.camera.p99)}/${f(s.camera.max)}  on screen ${f(s.onScreen.p99)}/${f(s.onScreen.max)}`,
      `others ${f(s.others.p99)}/${f(s.others.max)}${s.worstOther && s.worstOther.slot >= 0 ? ` (worst slot ${s.worstOther.slot})` : ''}`,
      s.cpuMs.total ? `cpu ms p50/p99  frame ${f(s.cpuMs.total.p50)}/${f(s.cpuMs.total.p99)}  sim ${f(s.cpuMs.sim.p50)}/${f(s.cpuMs.sim.p99)}  render ${f(s.cpuMs.render.p50)}/${f(s.cpuMs.render.p99)}  hud ${f(s.cpuMs.hud.p50)}/${f(s.cpuMs.hud.p99)}  map ${f(s.cpuMs.map.p50)}/${f(s.cpuMs.map.p99)}` : 'cpu: no frames yet',
      s.hitchCause ? `hitches: ${f(s.hitchCause.frameMs)} ms on average; the frame before used ${f(s.hitchCause.prevCpu)} ms CPU (sim ${f(s.hitchCause.sim)} render ${f(s.hitchCause.render)} hud ${f(s.hitchCause.hud)}), ${f(s.hitchCause.rest)} ms elsewhere` : 'hitches: none',
      `long tasks (over 50 ms, Chrome only): ${s.longTasks.count}${s.longTasks.count ? `, longest ${s.longTasks.maxMs} ms` : ''}`]
      .forEach((t, k) => c.fillText(t, x + 8, y + 15 + k * 14));
    c.restore();
  }
  // the frame's CPU time by section, after its record (ignored when the frame wasn't recorded)
  function cpuTime(sections) { if (lastK >= 0) CPU.forEach((name, c) => { cpu[c][lastK] = sections[name]; }); lastK = -1; }
  return { record, reset, report, draw, cpuTime, gpu: ms => { gpuNow = ms; }, get shown() { return shown; }, toggle: () => { shown = !shown; return shown; }, clear: () => { n = 0; head = 0; reset(); } };
}
