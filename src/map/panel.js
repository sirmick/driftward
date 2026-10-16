// ======================= STAR MAP PANEL =======================
// The star map's side panel and controls, shared by the map page (map.html) and the game's debug screen (its Map
// tab): find a star, the selection (its class, distance from Sol and from the last star selected, and as a game
// system who holds it, its lanes and its jumps from Sol), the view's toggles and the legends; and the mouse on the
// map's surface (drag to orbit, right- or shift-drag to pan, wheel to zoom, click to select, double-click to centre).
// starMapPanelHtml() is the panel's markup; mountStarMapPanel(root, M, surface) wires it, root holding that
// markup and surface the element the mouse drives the map from. Needs map.js (and stars.js) in scope.
function starMapPanelHtml() {
  return `<h2>Find</h2>
  <input data-m="search" class="sm-search" type="search" placeholder="Star or system, e.g. Tau Ceti" autocomplete="off">
  <h2>Selected</h2>
  <p data-m="sel-name" class="sm-sel-name">Sol</p>
  <p data-m="sel-desig" class="sm-sel-desig"></p>
  <dl data-m="sel-stats" class="sm-stats"></dl>
  <h2>View</h2>
  <div class="sm-row"><label>Out to</label><input data-m="range" type="range" min="10" max="100" step="1" value="100"><output>100 ly</output></div>
  <div class="sm-row"><label>Year</label><input data-m="year" type="range" min="2076" max="2526" step="1" value="2526"><output>2526</output></div>
  <div class="sm-row"><label>Focus</label><input data-m="focusR" type="range" min="6" max="80" step="1" value="22"><output>22 ly</output></div>
  <div class="sm-checks">
    <label><input type="checkbox" data-t="game" checked> Game systems</label>
    <label><input type="checkbox" data-t="lanes" checked> Lanes</label>
    <label><input type="checkbox" data-t="regions" checked> Territories</label>
    <label><input type="checkbox" data-t="areas" checked> Regions</label>
    <label><input type="checkbox" data-t="labels" checked> Names</label>
    <label><input type="checkbox" data-t="drops"> Drop lines</label>
    <label><input type="checkbox" data-t="grid" checked> Plane</label>
    <label><input type="checkbox" data-m="named"> Named only</label>
  </div>
  <h2>Systems</h2>
  <div class="sm-legend" data-m="groups"></div>
  <h2>Classes</h2>
  <div class="sm-legend" data-m="classes"></div>
  <p class="sm-keys">Drag: orbit · right-drag or shift-drag: pan<br>Wheel: zoom · click: select · double-click: its detail</p>
  <p class="sm-credit">Star data: HYG database v4.1, David Nash (astronexus), CC BY-SA 4.0.</p>`;
}

// the panel's styles, for a page to put in its stylesheet (the panel's own look; the page places it)
const STAR_MAP_PANEL_CSS = `
.sm-panel h2 { margin: 14px 0 6px; font: 600 12px var(--f-display); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.sm-sel-name { margin: 0; font: 600 19px/1.15 var(--f-display); color: #ffe2a6; }
.sm-sel-desig { margin: 2px 0 8px; color: var(--muted); font: 11.5px/1.4 var(--f-mono); }
.sm-stats { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 0; font-size: 13px; }
.sm-stats dt { color: var(--muted); }
.sm-stats dd { margin: 0; font-family: var(--f-mono); font-size: 12.5px; }
.sm-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; font-size: 13px; }
.sm-row label { flex: none; width: 60px; color: var(--muted); }
.sm-row input[type=range] { flex: 1; min-width: 0; accent-color: var(--amber); }
.sm-row output { flex: none; width: 46px; text-align: right; font: 12px var(--f-mono); }
.sm-checks { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; }
.sm-checks input { accent-color: var(--amber); }
.sm-legend { display: grid; grid-template-columns: 14px 1fr auto; gap: 3px 8px; align-items: center; font-size: 12.5px; }
.sm-legend i { width: 9px; height: 9px; border-radius: 50%; box-shadow: 0 0 6px currentColor; background: currentColor; }
.sm-legend span:last-child { color: var(--muted); font: 11.5px var(--f-mono); }
.sm-legend label { display: contents; cursor: pointer; }
.sm-legend small { color: var(--muted); }
.sm-keys { margin: 12px 0 0; color: var(--muted); font: 11.5px/1.6 var(--f-mono); }
.sm-more { color: var(--muted); font: 11.5px var(--f-mono); }
.sm-modal { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; background: rgba(4, 6, 9, .45); }
.sm-modal[hidden] { display: none; }
.sm-modal-box { position: relative; width: min(920px, 92vw); max-height: 86vh; overflow: auto; padding: 18px 22px 20px;
  background: rgba(12, 16, 21, .96); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 16px 48px rgba(0,0,0,.6); }
.sm-modal-box h2 { margin: 0 0 8px; font: 600 12px var(--f-display); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.sm-modal-x { position: absolute; top: 8px; right: 12px; background: none; border: 0; color: var(--muted); font: 22px/1 var(--f-body); cursor: pointer; }
.sm-modal-x:hover { color: var(--amber); }
.sm-modal-cols { display: grid; grid-template-columns: minmax(260px, 1fr) 1.4fr; gap: 22px; margin-top: 10px; }
.sm-modal .sm-story { font-size: 13.5px; padding-left: 18px; }
.sm-modal .sm-story li { margin: 0 0 7px; }
.sm-story { margin: 0; padding-left: 14px; font: 12.5px/1.45 var(--f-body); }
.sm-story li { margin: 0 0 4px; }
.sm-credit { margin: 8px 0 0; color: var(--muted); font-size: 11px; }
.sm-search { width: 100%; background: #0a0d12; border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; color: var(--fg); font: 13px var(--f-body); }
.sm-search:focus { outline: none; border-color: var(--amber); }`;

function mountStarMapPanel(root, M, surface) {
  const q = k => root.querySelector(`[data-m="${k}"]`);
  const stars = M.stars, byName = new Map();
  stars.forEach((s, i) => { byName.set(s.name.toLowerCase(), i); (s.desig || []).forEach(d => byName.has(d.toLowerCase()) || byName.set(d.toLowerCase(), i)); });
  M.sys.forEach((c, i) => { if (c) byName.set(c.name.toLowerCase(), i); });
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = v => v < 10 ? v.toFixed(2) : v.toFixed(1);
  const GROUPS = { human: 'Human', bloom: 'Bloom', shadow: 'Shadow', glass: 'Glass', drift: 'the Drift' };
  const STATUS = { inhabited: 'inhabited', dead: 'dead (no one lives there)', living: 'a living world', held: 'held by the Shadow', glass: 'gone glass', emptied: 'emptied by the Shadow' };
  const U = M.universe, FACTIONS = U.factions;
  const DEPTHS = ['the fringe', 'the wild', 'the deep', 'the black']; // the Book's depth tiers, two jumps each
  const hex = c => '#' + c.map(v => Math.round(Math.pow(v, 1 / 2.2) * 255).toString(16).padStart(2, '0')).join('');

  // ---------- the selection: the panel's short card, and the full detail a double-click opens ----------
  // a system's rows: where and what it is (the panel), then its people, ports, history and story (the detail too)
  function rowsOf(i, full) {
    const s = stars[i], T = STAR_CLASSES[s.class], c = M.sys[i], rows = [];
    if (c) {
      rows.push(['System', `${GROUPS[c.group]}${c.ring ? ', ' + c.ring + ' ring' : ''}${c.sector != null ? ', sector ' + (c.sector + 1) : ''}`], ['Status', STATUS[c.status] || c.status]);
      if (c.region) rows.push(['Region', (U.regions[c.region] || {}).name || c.region]);
      if (c.hazard) rows.push(['Hazard', `a ${(STAR_CLASSES[c.class] || {}).label || c.class}: radiation and a deep well`]);
      if (M.factionOf(c)) rows.push(['Held by', FACTIONS[c.owner].name]);
    }
    if (full && c) {
      const w = c.world;
      if (w) {
        const n = w.population, people = n >= 1e9 ? (n / 1e9).toFixed(1) + ' billion' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' million' : Math.round(n / 1e3) + ' thousand';
        rows.push(['People', `${people}, ${w.tier}${w.builtworld ? ' with a Builtworld' : ''}`], ['Ports', w.roles.join(', ')],
          ['Wealth, security, unrest', `${w.wealth}, ${w.security}, ${w.unrest}`]);
      }
      if (c.settled) rows.push(['Settled', String(c.settled)]);
      if (c.charted) rows.push(['Charted', `${c.charted} (contact with the Bloom, 2376)`]);
      if (c.emptied) rows.push(['Emptied', String(c.emptied)]);
      if (c.seen) rows.push(['Shadow seen', `from ${c.seen}`]);
      if (c.lost) rows.push(['Went glass', String(c.lost)]);
      if (c.front) rows.push(['The front', 'faces the Shadow']);
      if (c.exclave) rows.push(['Apart', `${/^[aeiou]/.test(c.exclave) ? 'an' : 'a'} ${c.exclave}, cut off from the main body`]);
      if (c.gateway) rows.push(['Gateway', 'a lane into the open Drift']);
      if (c.depth) rows.push(['Drift depth', `${c.depth} (${DEPTHS[Math.min(4, Math.ceil(c.depth / 2)) - 1]})${c.generated ? ', uncharted' : ''}`]);
      if (c.jumps != null) rows.push(['Jumps from Sol', String(c.jumps)]);
      if (c.provisional) rows.push(['Name', 'provisional (invented; the lore pass may rename it)']);
    }
    // the galaxy may set a system's star to another class than the catalogue's
    const reset = c && c.class !== s.class;
    if (reset) rows.push(['Star', (STAR_CLASSES[c.class] || {}).label || c.class]);
    if (!(c && c.generated)) rows.push([reset ? 'Catalogue class' : 'Class', T ? T.label : s.class], ['Type', s.spect || 'unknown']);
    rows.push(['From Sol', fmt(s.ly) + ' ly']);
    const p = stars[M.st.prev];
    if (!full && p && p !== s && p.ly) rows.push([`From ${M.nameOf(M.st.prev)}`, fmt(M.distLy(p.pos, s.pos)) + ' ly']);
    if (full) {
      rows.push(['Above plane', (s.pos[2] >= 0 ? '+' : '') + s.pos[2].toFixed(1) + ' ly']);
      if (s.absmag != null && !(c && c.generated)) rows.push(['Brightness', (Math.pow(10, -0.4 * (s.absmag - 4.83))).toPrecision(2) + ' × Sol']);
      (s.companions || []).forEach((cp, n) => rows.push([n ? '' : 'Companions', `${cp.name} (${(STAR_CLASSES[cp.class] || {}).label || cp.class})`]));
    }
    if (c) M.lanesOf(i).sort((a, b) => a.ly - b.ly).forEach((l, n) => rows.push([n ? '' : 'Lanes', `${M.nameOf(l.to)}: ${fmt(l.ly)} ly, ${l.days} d`]));
    return rows;
  }
  const dl = rows => rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const desig = i => [...new Set([stars[i].name, ...(stars[i].desig || [])])].filter(d => d !== M.nameOf(i)).join(' · ');
  function showSel() {
    if (!stars[M.st.sel]) return;
    q('sel-name').textContent = M.nameOf(M.st.sel);
    q('sel-desig').textContent = desig(M.st.sel);
    q('sel-stats').innerHTML = dl(rowsOf(M.st.sel, false))
      + (M.sys[M.st.sel] ? `<dt></dt><dd class="sm-more">double-click the star for its detail</dd>` : '');
  }
  // the detail: a box over the map with everything about the system and its story; Esc, the close button or a click
  // outside it closes it
  const modal = document.createElement('div');
  modal.className = 'sm-modal'; modal.hidden = true;
  surface.parentElement.appendChild(modal);
  function openDetail(i) {
    const c = M.sys[i]; if (!c) return;
    const story = c.story;
    modal.innerHTML = `<div class="sm-modal-box" role="dialog" aria-label="${esc(M.nameOf(i))}"><button type="button" class="sm-modal-x" aria-label="Close">×</button>`
      + `<p class="sm-sel-name">${esc(M.nameOf(i))}</p><p class="sm-sel-desig">${esc(desig(i))}</p>`
      + `<div class="sm-modal-cols"><dl class="sm-stats">${dl(rowsOf(i, true))}</dl>`
      + `<div><h2>Story</h2>${story ? `<ul class="sm-story">${story.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : '<p class="sm-more">No story yet (tools/stories.py).</p>'}</div></div></div>`;
    modal.hidden = false;
    modal.querySelector('.sm-modal-x').onclick = closeDetail;
  }
  function closeDetail() { modal.hidden = true; }
  modal.addEventListener('pointerdown', e => { if (e.target === modal) closeDetail(); });
  window.addEventListener('keydown', e => { if (!modal.hidden && e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); closeDetail(); } }, true);
  const gameBox = root.querySelector('[data-t="game"]');
  function choose(i, centre) {
    if (i < 0) return;
    if (M.st.game && !M.sys[i]) { gameBox.checked = false; M.set('game', false); }
    M.select(i); showSel(); if (centre) M.focusOn(stars[i].pos);
  }
  choose(M.st.sel >= 0 ? M.st.sel : 0);

  // ---------- legends: the game's systems by kind (factions with their pieces), the catalogue's classes ----------
  const sysList = M.sys.filter(Boolean);
  const kinds = [...Object.entries(FACTIONS).filter(([, f]) => !f.alien).map(([k, f]) => [f.name, c => c.owner === k && c.status === 'inhabited', hex(f.colour), k]),
    ['Human, inhabited', c => c.group === 'human' && c.status === 'inhabited' && !M.factionOf(c), '#7fa6ff'], ['Human, dead', c => c.group === 'human' && c.status === 'dead', '#4a5a78'],
    ['The Drift (dead)', c => c.group === 'drift', '#8a93a6'], ['Bloom', c => c.group === 'bloom', '#5af080'], ['Shadow', c => c.group === 'shadow', '#ff5a46'], ['Glass', c => c.group === 'glass', '#bff0ff']]
    .filter(([, f]) => sysList.some(f));
  // pieces, for the factions that hold together (the galaxy marks their outlying pieces as exclaves); the scattered
  // ones (the Blackhull havens, the Independents) are scattered by nature
  const whole = new Set(sysList.filter(c => c.exclave).map(c => c.owner));
  const piecesOf = k => k && whole.has(k) ? M.pieces.filter(p => p.region === k && p.size).length : 0;
  q('groups').innerHTML = kinds.map(([label, f, col, k]) => { const n = piecesOf(k);
    return `<label><i style="color:${col}"></i><span>${esc(label)}${n > 1 ? ` <small>(${n} pieces)</small>` : ''}</span><span>${sysList.filter(f).length}</span></label>`; }).join('')
    + `<label><i style="color:#2a3a58"></i><span>Lanes</span><span>${M.lanes.length}</span></label>`
    + `<label><i style="color:#ffe0b0"></i><span>Choke points (border lanes)</span><span>${M.lanes.filter(l => l.border).length}</span></label>`;
  const hidden = new Set(), counts = {};
  stars.forEach(s => { counts[s.class] = (counts[s.class] || 0) + 1; });
  q('classes').innerHTML = STAR_ORDER.filter(c => counts[c]).map(c => {
    const col = (STAR_LOOKS[c] || { col: [1, 1, 1] }).col.map(v => Math.round(Math.pow(v, 1 / 2.2) * 255));
    return `<label><input type="checkbox" data-c="${c}" checked hidden><i style="color:rgb(${col})"></i><span>${esc(STAR_CLASSES[c].label)}</span><span>${counts[c]}</span></label>`;
  }).join('');
  // the year: history played back; a system shows once it is known (map.js: settled, charted, seen, or reached)
  const NOW = 2526;
  const seenBy = (c, y) => !c || y >= NOW || (c.known != null && c.known <= y);
  function applyFilter() {
    const named = q('named').checked, y = +q('year').value;
    M.set('filter', hidden.size || named || y < NOW ? (s, c) => !hidden.has(s.class) && (!named || !s.catalog || (c && c.name !== s.name)) && seenBy(c, y) : null);
  }
  q('year').addEventListener('input', () => { q('year').nextElementSibling.textContent = q('year').value; applyFilter(); });
  q('classes').querySelectorAll('input').forEach(el => el.addEventListener('change', () => {
    el.checked ? hidden.delete(el.dataset.c) : hidden.add(el.dataset.c);
    el.parentElement.style.opacity = el.checked ? 1 : .4; applyFilter();
  }));
  q('named').addEventListener('change', applyFilter);

  // ---------- the view's toggles and sliders ----------
  root.querySelectorAll('[data-t]').forEach(el => { el.checked = !!M.st[el.dataset.t]; el.addEventListener('change', () => M.set(el.dataset.t, el.checked)); });
  q('range').max = M.outer;
  ['range', 'focusR'].forEach(k => { const el = q(k); el.value = M.st[k]; el.nextElementSibling.textContent = M.st[k] + ' ly';
    el.addEventListener('input', () => { M.set(k, +el.value); el.nextElementSibling.textContent = el.value + ' ly'; }); });
  const search = q('search'), list = document.createElement('datalist');
  list.id = 'sm-names-' + Math.random().toString(36).slice(2); search.setAttribute('list', list.id); root.appendChild(list);
  list.innerHTML = [...new Set([...M.sys.filter(Boolean).map(c => c.name), ...stars.filter(s => !s.catalog).map(s => s.name)])].map(n => `<option value="${esc(n)}">`).join('');
  search.addEventListener('change', () => {
    const v = search.value.trim().toLowerCase(); if (!v) return;
    const i = byName.has(v) ? byName.get(v) : stars.findIndex(s => s.name.toLowerCase().includes(v));
    if (i >= 0) { choose(i, true); search.value = ''; }
  });

  // ---------- the mouse on the map's surface ----------
  let drag = null;
  // where the pointer is on the map's canvas (stars are drawn there; the surface may sit elsewhere, under a header)
  const at = e => { const r = M.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  surface.addEventListener('contextmenu', e => e.preventDefault());
  surface.addEventListener('pointerdown', e => {
    surface.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan: e.button === 2 || e.shiftKey, moved: false };
  });
  surface.addEventListener('pointermove', e => {
    if (!drag) { M.hover(M.pick(...at(e))); return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 4) { drag.moved = true; surface.style.cursor = 'grabbing'; }
    if (drag.moved) drag.pan ? M.pan(dx, dy) : M.orbit(dx, dy);
  });
  surface.addEventListener('pointerup', e => { if (drag && !drag.moved) choose(M.pick(...at(e))); drag = null; surface.style.cursor = ''; });
  surface.addEventListener('dblclick', e => { const i = M.pick(...at(e)); if (i >= 0) { choose(i); openDetail(i); } });
  surface.addEventListener('wheel', e => { e.preventDefault(); M.zoom(Math.exp(e.deltaY * .0012)); }, { passive: false });
  return { choose, openDetail, closeDetail, home() { choose(0); M.focusOn([0, 0, 0], 38); }, centre() { if (M.st.sel >= 0) M.focusOn(stars[M.st.sel].pos); } };
}
