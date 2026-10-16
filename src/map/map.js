// ======================= STAR MAP =======================
// The 3D chart of the stars round Sol (src/galaxy/stars.json, from tools/hyg.py): each star a glow in its class's
// colour, sized by how bright it really is; the galactic plane as a floor of range rings; a line dropped from every
// star near the focus to the floor, so its height reads; and names drawn on a 2D canvas over it. The camera orbits a
// focus point. With the game's systems (galaxy.game, from tools/galaxy.py) it shows those over the faint catalogue:
// inhabited systems in full, dead ones dimmed, and the jump lanes coloured by who holds their ends. Shared by the map
// page and, later, the game and the intro, so it takes its canvas, the graphics kit (makeGfx) and the catalogue, and
// drives nothing else. Needs shaders.js and stars.js in scope.
// the factions' colours (galaxy.json's faction keys), linear RGB: the Federation blue, the Ironhulls rust, Prism
// violet, Freeflag gold, the Blackhull havens brown, the Independents slate
const FACTION_COLOURS = { fed: [.3, .5, 1], iron: [1, .45, .15], prism: [.7, .4, 1], free: [1, .8, .2], black: [.6, .38, .28], indep: [.55, .62, .7] };
// how each star class looks on the map: its colour (saturated, so a red dwarf is red), brightness, size in pixels and
// shape (the star shader's aShape: 0 a star, 1 a giant's wide halo, 2 a white dwarf's hard point, 3 a pulsar's
// beams, 4 a black hole)
const STAR_LOOKS = {
  yellow:        { col: [1, .85, .45], k: 1, size: 13, shape: 0 },
  orange:        { col: [1, .55, .2], k: 1, size: 12, shape: 0 },
  'red-dwarf':   { col: [1, .22, .1], k: .9, size: 10, shape: 0 },
  'brown-dwarf': { col: [.65, .22, .15], k: .55, size: 8, shape: 0 },
  'red-giant':   { col: [1, .35, .12], k: 1.1, size: 19, shape: 1 },
  white:         { col: [.8, .88, 1], k: 1.1, size: 14, shape: 0 },
  'blue-giant':  { col: [.45, .65, 1], k: 1.3, size: 20, shape: 1 },
  'wolf-rayet':  { col: [.55, .7, 1], k: 1.3, size: 17, shape: 1 },
  'white-dwarf': { col: [.85, .92, 1], k: 1.2, size: 9, shape: 2 },
  pulsar:        { col: [.6, .8, 1], k: 1.2, size: 16, shape: 3 },
  'black-hole':  { col: [1, .55, .2], k: 1, size: 18, shape: 4 },
  quasar:        { col: [.8, .7, 1], k: 1.4, size: 22, shape: 4 },
};
function makeStarMap(G, canvas, labels, galaxy) {
  const { gl } = G;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  // the catalogue's stars, and the Drift's generated ones (galaxy.json's generated: the deep Drift, past the catalogue)
  const game = galaxy.game || { systems: [], lanes: [] };
  const stars = galaxy.stars.concat(game.generated || []), N = stars.length;
  const P = { star: G.compile(MAP_STAR_VS, MAP_STAR_FS, { aCenter: 1, aCol: 2, aSize: 3, aFlag: 4, aMark: 5, aShape: 6 }), line: G.compile(MAP_LINE_VS, MAP_LINE_FS, { aCol: 1, aFade: 2 }),
    zone: G.compile(MAP_ZONE_VS, MAP_ZONE_FS, { aCenter: 1, aCol: 2, aSize: 3 }) };
  const RING = 10, OUTER = Math.max(galaxy.range || 80, Math.ceil(Math.max(0, ...(game.generated || []).map(s => s.ly)) / RING) * RING);
  // the game's systems by star index (null for a star that is not one), and its lanes by star index
  const index = new Map(stars.map((s, i) => [s.id, i]));
  const sys = new Array(N).fill(null), lanes = game.lanes.map(l => ({ a: index.get(l.a), b: index.get(l.b), ly: l.ly, days: l.days, drift: !!l.drift, border: !!l.border }));
  game.systems.forEach(c => { sys[index.get(c.star)] = c; });
  const lanesOf = i => lanes.filter(l => l.a === i || l.b === i).map(l => ({ to: l.a === i ? l.b : l.a, ly: l.ly, days: l.days }));
  // when each system is known (its .known, for the map's year): a settled one from its settling, a Bloom world from
  // its charting, the Shadow's from when it was seen, Sol always; any other (dead, the Drift) from its nearest known
  // neighbour along the lanes, a few years a jump, the Drift's slower. A lane shows once both its ends are known
  {
    const known = sys.map((c, i) => !c ? null : stars[i].name === 'Sol' ? 2076 : c.settled || c.charted || c.seen || null);
    const fixed = known.map(v => v != null);
    for (let pass = 0, changed = true; changed && pass < 200; pass++) {
      changed = false;
      for (const l of lanes) for (const [a, b] of [[l.a, l.b], [l.b, l.a]]) {
        if (known[a] == null || fixed[b]) continue;
        const v = known[a] + (sys[b].group === 'drift' ? 12 : 5);
        if (known[b] == null || v < known[b]) { known[b] = v; changed = true; }
      }
    }
    sys.forEach((c, i) => { if (c) c.known = known[i]; });
  }
  const nameOf = i => (sys[i] && sys[i].name) || stars[i].name;

  // a star's look: its class's template (colour, size, shape), its size nudged by how bright it really is (absolute
  // magnitude; Sol is 4.83). A game system on a catalogue star draws as the class the galaxy set for it
  const look = s => {
    const T = STAR_LOOKS[s.class] || STAR_LOOKS['red-dwarf'];
    const lum = Math.log10(Math.pow(10, -0.4 * ((s.absmag == null ? 12 : s.absmag) - 4.83)));
    return { col: T.col.map(v => v * T.k), size: T.size * Math.max(.8, Math.min(1.35, 1 + .06 * lum)), shape: T.shape };
  };
  const looks = stars.map((s, i) => look(sys[i] && sys[i].class ? sys[i] : s));
  // who a system counts toward (its faction, or the Bloom, the Shadow or the Glass), and its colour
  const REGION_COLOURS = { bloom: [.2, 1, .35], shadow: [1, .15, .1], glass: [.6, .9, 1] };
  const regionOf = c => c && (c.faction || (REGION_COLOURS[c.group] ? c.group : null));
  const regionCol = k => FACTION_COLOURS[k] || REGION_COLOURS[k];
  // occupied: lived in (a settled human system, a living Bloom world, one the Shadow holds, one gone glass)
  const occupied = c => c && c.status !== 'dead';

  // instanced stars: centre, colour, size static; flags (hover, selected, dimmed, dead) rewritten when they change
  const starVao = gl.createVertexArray(); gl.bindVertexArray(starVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, G.quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const inst = new Float32Array(N * 7);
  stars.forEach((s, i) => { inst.set(s.pos, i * 7); inst.set(looks[i].col, i * 7 + 3); inst[i * 7 + 6] = looks[i].size; });
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ib); gl.bufferData(gl.ARRAY_BUFFER, inst, gl.STATIC_DRAW);
  [[1, 3, 0], [2, 3, 12], [3, 1, 24]].forEach(([loc, n, off]) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 28, off); gl.vertexAttribDivisor(loc, 1); });
  // an occupied system's ring, in its owner's colour, and the star's shape
  const marks = new Float32Array(N * 5);
  stars.forEach((s, i) => {
    const c = sys[i], k = regionOf(c);
    if (occupied(c)) marks.set([...(k ? regionCol(k) : [.85, .85, .9]).map(v => Math.min(1, v * .9 + .1)), 1], i * 5);
    marks[i * 5 + 4] = looks[i].shape;
  });
  const mb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, mb); gl.bufferData(gl.ARRAY_BUFFER, marks, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 20, 0); gl.vertexAttribDivisor(5, 1);
  gl.enableVertexAttribArray(6); gl.vertexAttribPointer(6, 1, gl.FLOAT, false, 20, 16); gl.vertexAttribDivisor(6, 1);
  const flags = new Float32Array(N * 4), fb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fb); gl.bufferData(gl.ARRAY_BUFFER, flags, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(4, 1);

  // lines: position, colour (rgb, alpha), and fade by focus (a flag, and the height of the line's star); 9 floats a vertex
  function lineVao(data, usage) {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 36, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 36, 28);
    return { vao, b, n: data.length / 9 };
  }
  const seg = (out, a, b, col, alpha, z) => { const f = z == null ? [0, 0] : [1, z]; out.push(...a, ...col, alpha, ...f, ...b, ...col, alpha, ...f); };
  // the floor: a ring every 10 ly, brighter every 50, and spokes every 30 degrees, the one toward the galactic core brightest
  const grid = [];
  for (let r = RING; r <= OUTER; r += RING) for (let i = 0; i < 128; i++) {
    const a0 = i / 128 * Math.PI * 2, a1 = (i + 1) / 128 * Math.PI * 2;
    seg(grid, [r * Math.cos(a0), r * Math.sin(a0), 0], [r * Math.cos(a1), r * Math.sin(a1), 0], [.28, .5, .8], r % 50 ? .22 : .4);
  }
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; seg(grid, [Math.cos(a) * 2, Math.sin(a) * 2, 0], [OUTER * Math.cos(a), OUTER * Math.sin(a), 0], [.28, .5, .8], i ? .1 : .3); }
  // drop lines, each to a small cross on the floor, faded out away from the focus: the game's systems' first
  const gridN = grid.length / 9; // the floor's vertices, ahead of the drop lines
  const drop = i => {
    const s = stars[i]; if (!s.pos[2] && !s.pos[0]) return;
    const [x, y, z] = s.pos, c = looks[i].col.map(v => Math.min(1, v) * .6 + .15), f = [x, y, 0], d = .35;
    seg(grid, s.pos, f, c, .5, z);
    seg(grid, [x - d, y, 0], [x + d, y, 0], c, .6, z); seg(grid, [x, y - d, 0], [x, y + d, 0], c, .6, z);
  };
  for (let i = 0; i < N; i++) if (sys[i]) drop(i);
  const gameDropN = grid.length / 9 - gridN;
  for (let i = 0; i < N; i++) if (!sys[i]) drop(i);
  const statics = lineVao(new Float32Array(grid), gl.STATIC_DRAW);
  // the lanes, coloured by their ends: the Shadow red, the Glass a cold white, the Bloom green, into the Drift grey;
  // within a faction's territory its colour, brighter between inhabited systems than through dead ones; across a
  // border a warm white (the choke points); otherwise, through nobody's space, a dim blue
  const laneCol = l => {
    const A = sys[l.a], B = sys[l.b], g = [A.group, B.group];
    if (g.includes('shadow')) return [[.95, .25, .2], .5];
    if (g.includes('glass')) return [[.7, .95, 1], .5];
    if (g[0] === 'bloom' && g[1] === 'bloom') return [[.35, 1, .5], .38];
    if (g.includes('bloom')) return [[.4, .8, .7], .3];
    // into the Drift: grey, fading with depth toward the black
    if (g.includes('drift')) return [[.55, .6, .7], (g[0] === g[1] ? .22 : .3) * (1 - .1 * Math.max(A.depth || 1, B.depth || 1))];
    if (l.border) return [[1, .85, .6], .5]; // a choke point: a lane across a border, out of a faction's territory
    const live = (A.status === 'inhabited') + (B.status === 'inhabited');
    if (A.faction && A.faction === B.faction) return [FACTION_COLOURS[A.faction], [.2, .32, .5][live]];
    return [[.42, .62, 1], [.1, .16, .26][live]];
  };
  // the lanes and the territory clouds follow what is shown (the range, the filters, the year): rebuilt when it changes
  const laneVao = lineVao(new Float32Array(9), gl.DYNAMIC_DRAW);
  const live = lineVao(new Float32Array(9 * 256), gl.DYNAMIC_DRAW); // the selection's highlights, lanes and the ruler

  // ---------- regions: territory clouds round systems and along their lanes, and each territory's pieces ----------
  // who a system counts toward: its faction, or the Bloom, the Shadow or the Glass
  const zoneVao = gl.createVertexArray(); gl.bindVertexArray(zoneVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, G.quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const zoneBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, zoneBuf);
  [[1, 3, 0], [2, 3, 12], [3, 1, 24]].forEach(([loc, n, off]) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 28, off); gl.vertexAttribDivisor(loc, 1); });
  let zoneN = 0;
  // the selection's lanes glow amber, so where it goes reads at a glance (lines are a pixel wide): a trail of small
  // clouds along each, rebuilt when the selection changes
  const selVao = gl.createVertexArray(); gl.bindVertexArray(selVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, G.quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const selBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, selBuf);
  [[1, 3, 0], [2, 3, 12], [3, 1, 24]].forEach(([loc, n, off]) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 28, off); gl.vertexAttribDivisor(loc, 1); });
  let selN = 0, selFor = -2;
  function selTrail() {
    if (selFor === st.sel + (st.game && st.lanes ? 0 : .5)) return;
    selFor = st.sel + (st.game && st.lanes ? 0 : .5);
    const Z = [];
    if (st.sel >= 0 && st.game && st.lanes) lanesOf(st.sel).forEach(l => {
      const A = stars[st.sel].pos, B = stars[l.to].pos, n = Math.max(2, Math.round(l.ly / .3));
      for (let j = 1; j < n; j++) { const f = j / n; Z.push(...A.map((v, d) => v + (B[d] - v) * f), .5, .31, .12, .45); }
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, selBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(Z.length ? Z : [0, 0, 0, 0, 0, 0, 0]), gl.DYNAMIC_DRAW);
    selN = Z.length / 7;
  }
  // the lanes between shown systems; a cloud round each shown system a region holds, and along each lane inside a
  // territory, so the field follows its lanes (a smaller cloud every 2 ly between the ends)
  function rebuild(on) {
    const L = [], zones = [];
    lanes.forEach(l => { if (on(l.a) && on(l.b)) { const [c, a] = laneCol(l); seg(L, stars[l.a].pos, stars[l.b].pos, c, a); } });
    gl.bindBuffer(gl.ARRAY_BUFFER, laneVao.b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(L.length ? L : [0, 0, 0, 0, 0, 0, 0, 0, 0]), gl.DYNAMIC_DRAW);
    laneVao.n = L.length / 9;
    sys.forEach((c, i) => { const k = regionOf(c); if (k && on(i)) zones.push(...stars[i].pos, ...regionCol(k), c.status === 'dead' ? 3.5 : 5); });
    lanes.forEach(l => {
      const k = regionOf(sys[l.a]); if (!k || k !== regionOf(sys[l.b]) || !on(l.a) || !on(l.b)) return;
      const A = stars[l.a].pos, B = stars[l.b].pos, n = Math.floor(l.ly / 2);
      for (let j = 1; j <= n; j++) { const f = j / (n + 1); zones.push(...A.map((v, d) => v + (B[d] - v) * f), ...regionCol(k).map(v => v * .8), 3); }
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, zoneBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(zones.length ? zones : [0, 0, 0, 0, 0, 0, 0]), gl.DYNAMIC_DRAW);
    zoneN = zones.length / 7;
  }
  // pieces: a region's systems joined by lanes between its own systems; each gets its name at the middle of its
  // inhabited systems (all of them, if it has none), the biggest piece the largest
  const pieces = [];
  {
    const nb = new Map();
    lanes.forEach(l => { if (regionOf(sys[l.a]) && regionOf(sys[l.a]) === regionOf(sys[l.b])) { (nb.get(l.a) || nb.set(l.a, []).get(l.a)).push(l.b); (nb.get(l.b) || nb.set(l.b, []).get(l.b)).push(l.a); } });
    const seen = new Set();
    sys.forEach((c, i) => {
      const k = regionOf(c); if (!k || seen.has(i)) return;
      const members = [], stack = [i]; seen.add(i);
      while (stack.length) { const a = stack.pop(); members.push(a); for (const b of nb.get(a) || []) if (!seen.has(b)) { seen.add(b); stack.push(b); } }
      const core = members.filter(j => sys[j].status !== 'dead'), use = core.length ? core : members, mid = [0, 0, 0];
      use.forEach(j => stars[j].pos.forEach((v, d) => { mid[d] += v / use.length; }));
      pieces.push({ region: k, size: core.length, members, mid });
    });
    pieces.sort((a, b) => b.size - a.size);
  }
  const REGION_NAMES = { ...(game.factions || {}), bloom: 'The Bloom', shadow: 'The Shadow', glass: 'The Glass' };

  // ---------- camera: orbit a focus point; yaw round galactic north, pitch above the plane ----------
  const cam = { focus: [0, 0, 0], yaw: -2.2, pitch: .5, dist: 38, fov: 50 * Math.PI / 180 };
  const goal = { focus: null, dist: null };
  const view = { vp: new Float32Array(16), eye: [0, 0, 0], w: 1, h: 1 };
  function updateView() {
    const { focus: f, yaw, pitch, dist } = cam, cp = Math.cos(pitch);
    const e = [f[0] + dist * cp * Math.cos(yaw), f[1] + dist * cp * Math.sin(yaw), f[2] + dist * Math.sin(pitch)];
    const zf = norm(sub(e, f)), xs = norm(cross([0, 0, 1], zf)), ys = cross(zf, xs);
    const V = [xs[0], ys[0], zf[0], 0, xs[1], ys[1], zf[1], 0, xs[2], ys[2], zf[2], 0, -dot(xs, e), -dot(ys, e), -dot(zf, e), 1];
    const asp = view.w / view.h, t = 1 / Math.tan(cam.fov / 2), n = .1, fr = 2000;
    const Pm = [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (fr + n) / (n - fr), -1, 0, 0, 2 * fr * n / (n - fr), 0];
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += Pm[k * 4 + r] * V[c * 4 + k]; view.vp[c * 4 + r] = s; }
    view.eye = e; view.right = xs; view.up = ys;
  }
  // world point -> CSS pixels on the canvas and its depth, or null behind the camera
  function project(p) {
    const m = view.vp, x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w < .1) return null;
    return [(x / w * .5 + .5) * view.w, (1 - (y / w * .5 + .5)) * view.h, w];
  }

  // ---------- state the page drives ----------
  // game: show the game's systems over the faint catalogue (with lanes), or every star alike
  const st = { hover: -1, sel: -1, prev: -1, range: OUTER, labels: true, drops: false, grid: true, lanes: true, regions: true, areas: true, game: lanes.length > 0, focusR: 22, filter: null };
  const shown = i => !(stars[i].ly > st.range || (st.filter && !st.filter(stars[i], sys[i])) || (st.game && !sys[i]));
  function setFlags() {
    for (let i = 0; i < N; i++) {
      flags[i * 4] = i === st.hover ? 1 : 0; flags[i * 4 + 1] = i === st.sel ? 1 : 0; flags[i * 4 + 2] = shown(i) ? 0 : 1;
      flags[i * 4 + 3] = st.game && sys[i] && sys[i].status === 'dead' ? 1 : 0;
    }
    rebuild(i => !flags[i * 4 + 2]); placeRegions(i => !flags[i * 4 + 2]);
    gl.bindBuffer(gl.ARRAY_BUFFER, fb); gl.bufferSubData(gl.ARRAY_BUFFER, 0, flags);
  }
  // the star under a CSS pixel (within 12 px of its centre, nearest the camera on ties), or -1
  // the star under a CSS pixel of the canvas: within its drawn size (at least 10 px), the nearest by how far inside
  // that it is, nearer the camera on ties; -1 for none
  function pick(px, py) {
    let best = -1, bd = 1;
    for (let i = 0; i < N; i++) {
      if (flags[i * 4 + 2]) continue;
      const q = project(stars[i].pos); if (!q) continue;
      const near = Math.min(2.2, Math.max(.6, 30 / Math.max(q[2], 1))), r = Math.max(10, looks[i].size * near * .6 * (flags[i * 4 + 3] ? .6 : 1));
      const d = ((q[0] - px) ** 2 + (q[1] - py) ** 2) / (r * r) + q[2] * .0005;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  const distLy = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // ---------- drawing ----------
  function liveLines() {
    const L = [];
    const s = stars[st.sel];
    if (s) { // the selection's drop line, bright, and a ring on the floor under it
      const [x, y] = s.pos;
      seg(L, s.pos, [x, y, 0], [1, .82, .45], .9);
      for (let i = 0; i < 24; i++) { const a0 = i / 24 * Math.PI * 2, a1 = (i + 1) / 24 * Math.PI * 2; seg(L, [x + Math.cos(a0), y + Math.sin(a0), 0], [x + Math.cos(a1), y + Math.sin(a1), 0], [1, .82, .45], .7); }
      if (st.game && st.lanes) lanesOf(st.sel).slice(0, 100).forEach(l => seg(L, s.pos, stars[l.to].pos, [1, .9, .6], 1)); // its lanes
      const p = stars[st.prev];
      if (p) seg(L, p.pos, s.pos, [.55, .85, 1], .8); // the ruler from the last selection
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, live.b); gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(L));
    return L.length / 9;
  }
  function draw(bloom) {
    view.w = canvas.clientWidth; view.h = canvas.clientHeight;
    updateView();
    const sc = G.targets.scene;
    gl.bindFramebuffer(gl.FRAMEBUFFER, sc.f); gl.viewport(0, 0, sc.w, sc.h);
    gl.clearColor(.0006, .0008, .0016, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(P.line.p);
    gl.uniformMatrix4fv(P.line.u.uVP, false, view.vp); gl.uniform3fv(P.line.u.uEye, view.eye);
    gl.uniform3fv(P.line.u.uFocus, cam.focus); gl.uniform1f(P.line.u.uFocusR, st.focusR); gl.uniform1f(P.line.u.uFar, Math.max(160, cam.dist * 4));
    gl.bindVertexArray(statics.vao);
    if (st.grid) gl.drawArrays(gl.LINES, 0, gridN);
    if (st.drops) gl.drawArrays(gl.LINES, gridN, st.game ? gameDropN : statics.n - gridN);
    if (st.game && st.lanes && lanes.length) { gl.bindVertexArray(laneVao.vao); gl.drawArrays(gl.LINES, 0, laneVao.n); }
    const ln = liveLines(); gl.bindVertexArray(live.vao); if (ln) gl.drawArrays(gl.LINES, 0, ln);
    if (st.game && st.regions && zoneN) {
      gl.useProgram(P.zone.p);
      gl.uniformMatrix4fv(P.zone.u.uVP, false, view.vp); gl.uniform3fv(P.zone.u.uEye, view.eye);
      gl.uniform3fv(P.zone.u.uRight, view.right); gl.uniform3fv(P.zone.u.uUp, view.up); gl.uniform1f(P.zone.u.uK, .07);
      gl.bindVertexArray(zoneVao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, zoneN);
    }
    selTrail();
    if (selN) {
      gl.useProgram(P.zone.p);
      gl.uniformMatrix4fv(P.zone.u.uVP, false, view.vp); gl.uniform3fv(P.zone.u.uEye, view.eye);
      gl.uniform3fv(P.zone.u.uRight, view.right); gl.uniform3fv(P.zone.u.uUp, view.up); gl.uniform1f(P.zone.u.uK, .22);
      gl.bindVertexArray(selVao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, selN);
    }
    gl.useProgram(P.star.p);
    gl.uniformMatrix4fv(P.star.u.uVP, false, view.vp); gl.uniform3fv(P.star.u.uEye, view.eye);
    gl.uniform2f(P.star.u.uRes, view.w, view.h); gl.uniform1f(P.star.u.uPx, 1); gl.uniform1f(P.star.u.uTime, performance.now() / 1000);
    gl.bindVertexArray(starVao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, N);
    gl.disable(gl.BLEND); gl.bindVertexArray(null);
    G.postProcess(bloom == null ? .8 : bloom);
    drawLabels();
  }

  // the named regions (galaxy.json's regions: each system's .region), each named at the middle of its shown systems in
  // the colour of who holds most of it; worked out again when what is shown changes
  const REGION_TITLES = game.regions || {};
  let regionLabels = [];
  function placeRegions(on) {
    // each region's shown systems, in the pieces its lanes join (a scattered region, like the Margins or the Drift,
    // is named on its pieces, not once in the middle of everything)
    const nb = new Map();
    lanes.forEach(l => {
      if (sys[l.a].region && sys[l.a].region === sys[l.b].region && on(l.a) && on(l.b))
        for (const [a, b] of [[l.a, l.b], [l.b, l.a]]) (nb.get(a) || nb.set(a, []).get(a)).push(b);
    });
    const seen = new Set();
    regionLabels = [];
    sys.forEach((c, i) => {
      if (!c || !c.region || !on(i) || seen.has(i)) return;
      const part = [], stack = [i]; seen.add(i);
      while (stack.length) { const a = stack.pop(); part.push(a); for (const b of nb.get(a) || []) if (!seen.has(b)) { seen.add(b); stack.push(b); } }
      if (part.length < 3) return;
      const mid = [0, 0, 0], who = {};
      part.forEach(j => { stars[j].pos.forEach((v, d) => { mid[d] += v / part.length; }); const k = regionOf(sys[j]) || 'drift'; who[k] = (who[k] || 0) + 1; });
      const k = Object.entries(who).sort((x, y) => y[1] - x[1])[0][0], col = regionCol(k) || [.75, .8, .9];
      regionLabels.push({ key: c.region, text: (REGION_TITLES[c.region] || c.region).toUpperCase(), mid, n: part.length,
        col: `rgba(${col.map(v => Math.round(150 + 105 * Math.pow(v, 1 / 2.2))).join(',')},.9)` });
    });
    // each region once, on its biggest piece, and again on any other piece of eight or more; the Drift where its
    // sectors have no name of their own, not at all
    regionLabels.sort((x, y) => y.n - x.n);
    const named = new Set();
    regionLabels = regionLabels.filter(r => r.key !== 'drift' && (!named.has(r.key) ? named.add(r.key) : r.n >= 8));
  }
  setFlags(); // the first: what is shown, the lanes and clouds, the region names
  // names: the selection and the hovered star always; then named stars near the focus, brightest first, then the
  // ring distances, each skipped where it would overlap one already placed
  function drawLabels() {
    const ctx = labels.getContext('2d'), dpr = labels.width / Math.max(1, view.w);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, view.w, view.h);
    if (!st.labels) return;
    const placed = [], fits = (x, y, w, h) => !placed.some(b => x < b[0] + b[2] && b[0] < x + w && y < b[1] + b[3] && b[1] < y + h) && (placed.push([x, y, w, h]), true);
    const put = (text, p, font, color, dx, dy, force) => {
      const q = project(p); if (!q || q[0] < -50 || q[1] < -20 || q[0] > view.w + 50 || q[1] > view.h + 20) return;
      ctx.font = font; const w = ctx.measureText(text).width, x = q[0] + dx, y = q[1] + dy;
      if (!fits(x - 2, y - 11, w + 4, 15) && !force) return;
      ctx.fillStyle = 'rgba(4,6,9,.55)'; ctx.fillText(text, x + 1, y + 1); ctx.fillStyle = color; ctx.fillText(text, x, y);
    };
    if (st.sel >= 0) put(nameOf(st.sel), stars[st.sel].pos, '600 15px "Saira Semi Condensed", sans-serif', '#ffe2a6', 16, 5, true);
    // the systems one jump from the selection, always named
    if (st.sel >= 0 && st.game && st.lanes) for (const l of lanesOf(st.sel)) if (!flags[l.to * 4 + 2]) put(nameOf(l.to), stars[l.to].pos, '500 12px "Saira Semi Condensed", sans-serif', '#f3d9a8', 9, 4, true);
    if (st.hover >= 0 && st.hover !== st.sel) put(nameOf(st.hover), stars[st.hover].pos, '500 12px "Saira Semi Condensed", sans-serif', '#e8edf4', 10, 4, true);
    // the regions' names (biggest first); without them, with territories shown, each territory piece's
    if (st.game && st.areas) for (const r of regionLabels)
      put(r.text, r.mid, `600 ${r.n >= 30 ? 14 : r.n >= 12 ? 12.5 : 11}px "Saira Semi Condensed", sans-serif`, r.col, -30, 0, false);
    else if (st.game && st.regions) for (const pc of pieces) {
      if ((pc.size < 2 && pc.members.length < 4) || pc.members.every(i => flags[i * 4 + 2])) continue;
      const c = regionCol(pc.region).map(v => Math.round(140 + 115 * Math.pow(v, 1 / 2.2)));
      put(REGION_NAMES[pc.region].toUpperCase(), pc.mid, `600 ${pc.size >= 8 ? 13 : 11}px "Saira Semi Condensed", sans-serif`, `rgba(${c},.8)`, -30, 0, false);
    }
    const cand = [];
    for (let i = 0; i < N; i++) {
      const s = stars[i]; if (flags[i * 4 + 2] || i === st.sel || i === st.hover) continue;
      // minor: a catalogue number, or in the game's view a dead system; a game system named in the setting leads
      const minor = st.game ? sys[i].status === 'dead' || (s.catalog && sys[i].name === s.name) : s.catalog;
      const d = distLy(s.pos, cam.focus); if (d > st.focusR * (minor ? .45 : 1.2)) continue;
      cand.push([i, (minor ? 3 : 0) - (sys[i] && sys[i].name !== s.name ? 4 : 0) - (s.absmag == null ? -12 : -s.absmag) * .15 + d / st.focusR * 2, minor]);
    }
    cand.sort((a, b) => a[1] - b[1]);
    for (const [i, , minor] of cand.slice(0, 70)) {
      const fc = st.game && sys[i].faction && sys[i].status === 'inhabited' && FACTION_COLOURS[sys[i].faction];
      const col = fc ? `rgba(${fc.map(v => Math.round(160 + 95 * Math.pow(v, 1 / 2.2))).join(',')},.95)` : minor ? 'rgba(150,165,185,.75)' : 'rgba(205,215,228,.92)';
      put(nameOf(i), stars[i].pos, (minor ? '400 10.5px' : '500 11.5px') + ' "IBM Plex Sans", sans-serif', col, 9, 4, false);
    }
    if (st.grid) for (let r = RING; r <= OUTER; r += RING) {
      const a = cam.yaw - Math.PI / 2; // the rings' distances along the left of the view
      put(r + ' ly', [r * Math.cos(a), r * Math.sin(a), 0], '400 10px "IBM Plex Mono", monospace', 'rgba(110,150,200,.7)', 3, -3, false);
    }
    if (st.grid) put('to the galactic core', [OUTER + 2, 0, 0], '400 10px "IBM Plex Mono", monospace', 'rgba(110,150,200,.8)', 4, 4, false);
  }

  // ---------- motion: glide the focus and zoom toward their goals ----------
  function tick(dt) {
    const k = 1 - Math.exp(-dt * 6);
    if (goal.focus) { for (let j = 0; j < 3; j++) cam.focus[j] += (goal.focus[j] - cam.focus[j]) * k; if (distLy(cam.focus, goal.focus) < .01) goal.focus = null; }
    if (goal.dist) { cam.dist += (goal.dist - cam.dist) * k; if (Math.abs(goal.dist - cam.dist) < .01) goal.dist = null; }
  }
  function select(i) { if (i === st.sel) return; if (st.sel >= 0) st.prev = st.sel; st.sel = i; setFlags(); }
  function hover(i) { if (i !== st.hover) { st.hover = i; setFlags(); } }
  function focusOn(p, dist) { goal.focus = p.slice(); if (dist) goal.dist = dist; }
  // orbit by pixels dragged; pan the focus along the floor; zoom by a factor
  function orbit(dx, dy) { cam.yaw -= dx * .006; cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch + dy * .006)); }
  function pan(dx, dy) {
    // a drag moves the floor under the pointer: right on screen is (-sin, cos) of the yaw, forward (-cos, -sin)
    const s = cam.dist * Math.tan(cam.fov / 2) * 2 / view.h, c = Math.cos(cam.yaw), n = Math.sin(cam.yaw);
    goal.focus = null; cam.focus[0] += (dx * n - dy * c) * s; cam.focus[1] += (-dx * c - dy * n) * s;
  }
  function zoom(f) { goal.dist = Math.max(2, Math.min(260, (goal.dist || cam.dist) * f)); }
  function set(k, v) { st[k] = v; if (k === 'range' || k === 'filter' || k === 'game') { if (st.game && st.sel >= 0 && !sys[st.sel]) st.sel = -1; setFlags(); } }

  return { canvas, stars, sys, lanes, pieces, outer: OUTER, lanesOf, nameOf, cam, st, draw, tick, pick, project, select, hover, focusOn, orbit, pan, zoom, set, distLy };
}
