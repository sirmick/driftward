// ======================= GALAXY MAP =======================
// The player's galaxy map (M in flight; G or the Galaxy map button in port): the star map (src/map/map.js) over the
// whole window with the clock stopped, opened on the system the player is in, looking down on its neighbourhood.
// Click a system and its outbound lanes light up with where they go and how long they take; the course from here to it
// is plotted along the lanes (fewest days, or fewest jumps) and drawn in green; and the card beside the map shows what
// the universe index knows of it: who holds it, its people, its economy (its ports' roles and what they make and need,
// its region's trade, wealth, security and unrest), its flags and its story. Set course (Enter) keeps a destination,
// which the HUD shows with the next jump. Systems the player holds a mission for wear a diamond in the HUD's mission
// blue, and their cards list the missions. Jumping itself is not here (docs/data.md, step 5). What it shows is the
// index's, exact: the Book's intel snapshots, aged and noisy with distance, are M4.

// The course from star id `from` to `to` along the lanes: { ids (from first), jumps, days, ly }, or null when no lanes
// join them. by 'days' (the clock a trip costs, the default) or 'jumps' (fewest jumps, the shorter in days on a tie).
const galaxyGraph = new WeakMap();
function galaxyRoute(U, from, to, by = 'days') {
  if (from === to) return { ids: [from], jumps: 0, days: 0, ly: 0 };
  let adj = galaxyGraph.get(U);
  if (!adj) {
    adj = new Map();
    for (const l of U.lanes) for (const [a, b] of [[l.a, l.b], [l.b, l.a]]) { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, l }); }
    galaxyGraph.set(U, adj);
  }
  if (!adj.has(from) || !adj.has(to)) return null;
  const cost = l => by === 'jumps' ? 1 + l.days * 1e-3 : l.days, dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
  // Dijkstra over a binary heap of [cost, id]
  const heap = [[0, from]];
  const push = e => { heap.push(e); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { const a = 2 * i + 1, b = a + 1; let m = i; if (a < heap.length && heap[a][0] < heap[m][0]) m = a; if (b < heap.length && heap[b][0] < heap[m][0]) m = b; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
    return top;
  };
  while (heap.length) {
    const [d, a] = pop();
    if (done.has(a)) continue;
    done.add(a);
    if (a === to) break;
    for (const { to: b, l } of adj.get(a)) {
      const nd = d + cost(l);
      if (!dist.has(b) || nd < dist.get(b)) { dist.set(b, nd); prev.set(b, { from: a, l }); push([nd, b]); }
    }
  }
  if (!prev.has(to)) return null;
  const ids = [to], hops = [];
  for (let at = to; at !== from;) { const p = prev.get(at); hops.unshift(p.l); at = p.from; ids.unshift(at); }
  return { ids, jumps: hops.length, days: hops.reduce((n, l) => n + l.days, 0), ly: hops.reduce((n, l) => n + l.ly, 0) };
}

function makeGalaxyMap(ctx) {
  // ctx: { el, universe, econ, makeMap(labels) -> a star map (null until it can be made), here() -> the player's star
  // id, course() -> { dest, by } or null, onCourse(course or null), onClose(), missions() -> the active missions, each
  // { star, port, tons, good, pay, left (days) } }
  const { el, universe: U, econ } = ctx;
  const e = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const people = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)} billion` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} million` : n >= 1e3 ? `${Math.round(n / 1e3)} thousand` : String(n);
  const days = d => `${d.toFixed(1)} day${d === 1 ? '' : 's'}`;
  const hex = c => '#' + c.map(v => Math.round(Math.pow(Math.min(1, v), 1 / 2.2) * 255).toString(16).padStart(2, '0')).join('');
  const STATUS = { inhabited: 'Inhabited', dead: 'Dead: no one lives there', living: 'A living Bloom world', held: 'Held by the Shadow', glass: 'Gone glass', emptied: 'Emptied by the Shadow' };
  const TIERS = { outwatch: 'an outwatch', outpost: 'an outpost', colony: 'a colony', complex: 'a complex', world: 'a world' };
  const GOOD = Object.fromEntries((econ.commodities || []).map(c => [c.id, c.name]));
  const goodName = id => (GOOD[id] || id).toLowerCase();
  const roleOf = r => { const R = (econ.roles || {})[r] || {}, of = t => Object.keys(R).filter(k => R[k] === t); return { makes: of('low'), needs: of('high') }; };
  let biggest = 0; // the most people in any system, for the population bar (the index is read after this is made)

  el.innerHTML = `<div class="gx-surface"></div><canvas class="gx-labels"></canvas>
    <header class="gx-bar"><h2>Galaxy map</h2>
      <input class="gx-search" type="search" placeholder="Find a system" autocomplete="off" list="gx-names"><datalist id="gx-names"></datalist>
      <div class="gx-by" role="group" aria-label="Plot by"><button type="button" data-by="days">Fewest days</button><button type="button" data-by="jumps">Fewest jumps</button></div>
      <button type="button" data-act="home" title="H">Here</button><button type="button" data-act="down" title="V">Look down</button>
      <span class="gx-keys">drag turn · right-drag pan · wheel zoom</span>
      <button type="button" data-act="close" class="gx-close" title="M or Esc">Close <span>M</span></button></header>
    <aside class="gx-card"></aside>`;
  const q = s => el.querySelector(s), surface = q('.gx-surface'), labels = q('.gx-labels'), card = q('.gx-card'), search = q('.gx-search');
  let M = null, idx = null, open = false, by = 'days', sel = -1;

  // the map, made the first time it can be (it needs the real stars, read when first asked for)
  function build() {
    if (M) return true;
    M = ctx.makeMap(labels);
    if (!M) return false;
    idx = new Map(M.stars.map((s, i) => [s.id, i]));
    Object.assign(M.st, { ruler: false, drops: false, focusR: 30 });
    starMapMouse(M, surface, { click: i => { if (i >= 0) choose(i, false); }, double: i => { if (i >= 0) choose(i, true); } });
    q('#gx-names').innerHTML = [...new Set(U.systems.map(c => c.name))].sort().map(n => `<option value="${e(n)}">`).join('');
    return true;
  }
  const hereI = () => idx.get(ctx.here());
  // look down on a point from high above, as the flat maps of old did (the drag still turns it)
  function lookDown(p, dist) { M.focusOn(p, dist || 46); M.cam.pitch = 1.32; }

  // ---------- the selection and its card ----------
  // centre: frame it (picked from a list or a search, not clicked on the map): the whole course from here when there is
  // one, else the system
  function choose(i, centre) {
    if (!M.sys[i]) return; // a catalogue star the game doesn't use
    sel = i; M.select(i);
    plot(); render();
    if (!centre) return;
    const pts = (M.st.route || [i]).map(k => M.stars[k].pos), mid = [0, 1, 2].map(d => pts.reduce((n, p) => n + p[d], 0) / pts.length);
    const reach = Math.max(...pts.map(p => M.distLy(p, mid)));
    M.focusOn(mid, Math.max(M.cam.dist, Math.min(220, reach * 2.6 + 12)));
  }
  function routeTo(i) { const r = galaxyRoute(U, ctx.here(), M.sys[i].id, by); return r && Object.assign(r, { idx: r.ids.map(id => idx.get(id)) }); }
  function plot() { const r = sel >= 0 ? routeTo(sel) : null; M.st.route = r && r.jumps ? r.idx : null; }
  const meter = (name, v, tip) => `<div class="gx-meter ${name}" title="${e(tip)}"><span>${e(name)}</span><b style="--v:${v}%"></b><i>${v}</i></div>`;
  const chip = (t, tip, cls) => `<span class="gx-chip${cls ? ' ' + cls : ''}"${tip ? ` title="${e(tip)}"` : ''}>${e(t)}</span>`;
  // the systems the player holds a mission for, marked on the map
  const missions = () => (ctx.missions ? ctx.missions() : []).filter(m => idx.has(m.star));
  function mark() { const ms = missions(); M.st.marks = ms.length ? [...new Set(ms.map(m => idx.get(m.star)))] : null; }
  function render() {
    const c = M.sys[sel]; if (!c) { card.innerHTML = ''; return; }
    mark();
    const F = U.factions[c.owner], here = sel === hereI(), R = U.regions[c.region] || {}, w = c.world, course = ctx.course();
    const owner = F ? `<span class="gx-dot" style="background:${hex(F.colour)}"></span>${e(F.name)}` : e(STATUS[c.status] || c.status);
    const sub = [c.catalog, R.name, c.ring && `${c.ring} ring`, `${(STAR_CLASSES[c.class] || {}).label || c.class}`].filter(Boolean).map(e).join(' · ');
    let h = `<p class="gx-name">${e(c.name)}</p><p class="gx-sub">${sub}</p><p class="gx-owner">${owner}${c.status !== 'inhabited' && F ? ` <small>· ${e(STATUS[c.status] || c.status)}</small>` : ''}</p>`;
    // the course from here
    const r = here ? null : routeTo(sel), onCourse = course && course.dest === c.id;
    h += '<h3>Course</h3>';
    if (here) h += `<p class="gx-here">You are here.${course ? ` Course set for ${e((U.systems.find(s => s.id === course.dest) || {}).name)}.` : ''}</p>`;
    else if (!r) h += '<p class="gx-warn">No lane reaches it from here.</p>';
    else {
      const hops = r.idx.slice(1).map(i => M.sys[i]), risky = hops.filter(s => s.group === 'shadow' || s.group === 'glass' || s.hazard || s.front);
      h += `<p class="gx-route"><b>${r.jumps} jump${r.jumps === 1 ? '' : 's'}</b> · ${days(r.days)} · ${r.ly.toFixed(1)} ly</p>`
        + `<ol class="gx-hops">${r.idx.slice(1).map(i => `<li><button type="button" data-pick="${i}">${e(M.sys[i].name)}</button></li>`).join('')}</ol>`
        + (hops.some(s => s.group === 'drift') ? '<p class="gx-warn">Through the Drift: its lanes shift.</p>' : '')
        + (risky.length ? `<p class="gx-warn">Danger on the way: ${risky.map(s => e(s.name)).join(', ')}.</p>` : '')
        + `<p><button type="button" class="gx-set${onCourse ? ' on' : ''}" data-act="${onCourse ? 'clear' : 'set'}">${onCourse ? 'Course set · clear it' : 'Set course'} <span>Enter</span></button></p>`;
    }
    // the missions bound here
    const mine = missions().filter(m => m.star === c.id);
    if (mine.length) h += `<h3 class="gx-mis-h">Missions (${mine.length})</h3><ul class="gx-mis">${mine.map(m => `<li><b>${e(m.port)}</b> · ${e(m.tons)} t ${e(goodName(m.good))} · ${e(m.pay.toLocaleString('en-US'))} cr`
      + ` · <span class="${m.left <= 1 ? 'gx-hot' : ''}">${m.left <= 0 ? 'due today' : m.left === 1 ? '1 day left' : `${m.left} days left`}</span></li>`).join('')}</ul>`;
    // where its lanes go
    const out = M.lanesOf(sel).sort((a, b) => a.days - b.days);
    h += `<h3>Lanes out (${out.length})</h3><ul class="gx-lanes">${out.map(l => { const d = M.sys[l.to], DF = U.factions[d.owner];
      return `<li><button type="button" data-pick="${l.to}"><span class="gx-dot" style="background:${DF ? hex(DF.colour) : '#55606e'}"></span>${e(d.name)}</button><span>${days(l.days)} · ${l.ly.toFixed(1)} ly</span></li>`; }).join('')}</ul>`;
    // its people
    h += '<h3>People</h3>';
    if (w) {
      biggest = biggest || Math.max(10, ...U.systems.map(s => (s.world || {}).population || 0));
      const share = Math.max(2, 100 * Math.log10(Math.max(10, w.population)) / Math.log10(biggest));
      h += `<p class="gx-pop"><b>${e(people(w.population))}</b> · ${e(TIERS[w.tier] || w.tier)}${w.builtworld ? ' ' + chip('Builtworld', 'A whole planet built over into one city: one of six in human space', 'tag') : ''}</p>`
        + `<div class="gx-popbar" title="Against the most populous system (${e(people(biggest))}), on a log scale"><b style="--v:${share.toFixed(0)}%"></b></div>`;
    } else h += `<p class="gx-muted">${c.status === 'inhabited' ? 'Unknown.' : 'Nobody lives there.'}</p>`;
    // its economy
    if (w) {
      const made = new Set(), needed = new Set();
      w.roles.forEach(role => { const o = roleOf(role); o.makes.forEach(g => made.add(g)); o.needs.forEach(g => needed.add(g)); });
      made.forEach(g => needed.delete(g));
      h += `<h3>Economy</h3><div class="gx-chips">${w.roles.map(role => { const o = roleOf(role); return chip(role.replace('-', ' '), `Makes ${o.makes.map(goodName).join(', ') || 'nothing to sell'}${o.needs.length ? `; needs ${o.needs.map(goodName).join(', ')}` : ''}`); }).join('')}</div>`
        + (made.size ? `<p class="gx-trade"><span>Cheap here</span>${[...made].map(goodName).map(e).join(', ')}</p>` : '')
        + (needed.size ? `<p class="gx-trade"><span>Pays well for</span>${[...needed].map(goodName).map(e).join(', ')}</p>` : '')
        + meter('wealth', w.wealth, 'Wealth, 0 to 100') + meter('security', w.security, 'Security, 0 to 100: patrols and law') + meter('unrest', w.unrest, 'Unrest, 0 to 100: how close it is to trouble');
    }
    // its region
    if (R.name) {
      const T = R.trade;
      // (folded: the system's own trade, above, is what a trader needs)
      const trade = T ? `<p class="gx-trade"><span>Exports</span>${T.exports.map(goodName).map(e).join(', ') || 'nothing'}</p><p class="gx-trade"><span>Imports</span>${T.imports.map(goodName).map(e).join(', ') || 'nothing'}</p>` : '';
      if (trade || (R.summary && R.summary.length)) h += `<details class="gx-fold"><summary>${e(R.name)}</summary>${trade}<ul>${(R.summary || []).map(b => `<li>${e(b)}</li>`).join('')}</ul></details>`;
    }
    // its flags and story
    const flags = [[c.hazard, 'hazard star', 'Radiation and a deep well'], [c.front, 'the front', 'Faces the Shadow'], [c.gateway, 'gateway', 'A lane into the open Drift'],
      [c.exclave, c.exclave, `Cut off from ${F ? F.name : 'its owner'}'s main territory`], [c.depth, `Drift depth ${c.depth}`, 'Jumps out from human space'],
      [c.provisional, 'provisional name', 'An invented name: it may change'], [c.settled, `settled ${c.settled}`, '']].filter(x => x[0]);
    if (flags.length) h += `<div class="gx-chips gx-flags">${flags.map(([, t, tip]) => chip(t, tip, 'tag')).join('')}</div>`;
    if (c.story) h += `<details class="gx-fold"${here || onCourse ? '' : ' open'}><summary>Story</summary><ul>${c.story.map(b => `<li>${e(b)}</li>`).join('')}</ul></details>`;
    card.innerHTML = h;
  }
  card.addEventListener('click', ev => {
    const p = ev.target.closest('[data-pick]'); if (p) { choose(+p.dataset.pick, true); return; }
    const a = ev.target.closest('[data-act]'); if (a) act(a.dataset.act);
  });
  el.querySelector('.gx-bar').addEventListener('click', ev => {
    const b = ev.target.closest('[data-by]'); if (b) { setBy(b.dataset.by); return; }
    const a = ev.target.closest('[data-act]'); if (a) act(a.dataset.act);
  });
  search.addEventListener('change', () => {
    const v = search.value.trim().toLowerCase(); if (!v || !M) return;
    const c = U.systems.find(s => s.name.toLowerCase() === v) || U.systems.find(s => s.name.toLowerCase().includes(v) || (s.catalog || '').toLowerCase().includes(v));
    if (c && idx.has(c.id)) { choose(idx.get(c.id), true); search.value = ''; search.blur(); }
  });
  function setBy(b) {
    by = b; el.querySelectorAll('[data-by]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.by === by)));
    const c = ctx.course(); if (c) ctx.onCourse({ dest: c.dest, by });
    if (M && sel >= 0) { plot(); render(); }
  }
  function act(a) {
    if (a === 'close') close();
    else if (a === 'home') { choose(hereI(), false); lookDown(M.stars[hereI()].pos); }
    else if (a === 'down') lookDown(M.stars[sel >= 0 ? sel : hereI()].pos, M.cam.dist);
    else if (a === 'set' && sel >= 0 && sel !== hereI() && routeTo(sel)) { ctx.onCourse({ dest: M.sys[sel].id, by }); render(); }
    else if (a === 'clear') { ctx.onCourse(null); render(); }
  }

  // ---------- a transit: the trip between systems, played on the map (src/play/play.js draws the prompt over it) ----------
  // T: { from, to, next (the course's lane after, a star id, or null), f (0..1 of the way), window (the chain window is
  // open), chain (-1 none, -2 missed, else chained) }. The map alone, framed on the lane; the ship a streak along it.
  let transitKey = '';
  function transit(T) {
    if (!build()) return null;
    const a = idx.get(T.from), b = idx.get(T.to), n = T.next != null ? idx.get(T.next) : undefined;
    if (a == null || b == null) return null;
    const pa = M.stars[a].pos, pb = M.stars[b].pos;
    if (transitKey !== `${T.from}|${T.to}`) { // a new leg: frame it from above, its far system and the one after in view
      transitKey = `${T.from}|${T.to}`;
      el.hidden = false; el.classList.add('gx-transit');
      sel = -1; M.select(-1); M.st.here = -1;
      const pts = [pa, pb, ...(n != null ? [M.stars[n].pos] : [])], mid = [0, 1, 2].map(d => pts.reduce((s, p) => s + p[d], 0) / pts.length);
      M.focusOn(mid, Math.max(24, Math.min(160, Math.max(...pts.map(p => M.distLy(p, mid))) * 3.4 + 8))); M.cam.pitch = 1.2;
    }
    mark();
    M.st.route = n != null ? [a, b, n] : [a, b];
    const f = T.f < 0.5 ? 2 * T.f * T.f : 1 - Math.pow(-2 * T.f + 2, 2) / 2;
    M.st.ship = { from: pa, pos: [0, 1, 2].map(d => pa[d] + (pb[d] - pa[d]) * f), window: T.window && T.chain === -1 && n != null, chained: T.chain >= 0, missed: T.chain === -2 };
    const v = document.getElementById('view');
    if (labels.width !== v.width || labels.height !== v.height) { labels.width = v.width; labels.height = v.height; }
    return M;
  }
  function endTransit() {
    if (!transitKey) return;
    transitKey = ''; el.classList.remove('gx-transit');
    if (M) M.st.ship = null;
    if (!open) el.hidden = true;
  }

  // ---------- open and close ----------
  function show() {
    if (!build()) return false;
    const h = hereI(), c = ctx.course();
    M.st.here = h; M.st.ship = null;
    if (c) by = c.by || by;
    setBy(by);
    const start = c && idx.has(c.dest) ? idx.get(c.dest) : h;
    choose(start, false);
    lookDown(M.stars[h].pos);
    return true;
  }
  function openMap() {
    open = true; el.hidden = false; document.body.classList.add('gx-open');
    if (!show()) card.innerHTML = '<p class="gx-muted">Reading the stars…</p>';
  }
  function close() {
    if (!open) return;
    open = false; el.hidden = true; document.body.classList.remove('gx-open'); search.blur();
    if (ctx.onClose) ctx.onClose();
  }
  // a key while it is open (the page sends them all here): Esc or M closes, Enter sets the course to the selection,
  // H goes back to here, V looks down again, D and J plot by days or jumps
  function key(ev) {
    if (ev.code === 'Escape' || ev.code === 'KeyM') close();
    else if (!M) return;
    else if (ev.code === 'Enter' || ev.code === 'NumpadEnter') act(ctx.course() && sel >= 0 && ctx.course().dest === M.sys[sel].id ? 'clear' : 'set');
    else if (ev.code === 'KeyH') act('home');
    else if (ev.code === 'KeyV') act('down');
    else if (ev.code === 'KeyD') setBy('days');
    else if (ev.code === 'KeyJ') setBy('jumps');
  }
  // the map, for the game's frame to draw (null unless open); it is made here once the stars can be read
  function view() {
    if (!open) return null;
    if (!M && !show()) return null;
    const v = document.getElementById('view');
    if (labels.width !== v.width || labels.height !== v.height) { labels.width = v.width; labels.height = v.height; }
    return M;
  }
  return {
    open: openMap, close, isOpen: () => open, key, view, transit, endTransit,
    // the selection, the plotted course and the marked systems (tests)
    selected: () => (M && sel >= 0 ? M.sys[sel].id : null), route: () => (M && M.st.route ? M.st.route.map(i => M.sys[i].id) : null),
    marked: () => (M && M.st.marks ? M.st.marks.map(i => M.sys[i].id) : []),
    choose: id => { if (M && idx.has(id)) choose(idx.get(id), true); }, setBy, act,
  };
}
