// ======================= DEBUG =======================
// The debug screen (backquote): a full-window view over the game, with the clock stopped while it is open.
//   Content  how this system's content was made, each thing shown once: a header with the run's models and costs;
//            the pipeline's shared parts (the system-level facts, the lore prompt with its facts and schema left
//            out, the art bible and the parts every image prompt shares); one card per port with its body, its
//            lore and its art, each image showing only its own part of the prompt; then the raw files.
//   Player   the live state: ship and its stats, flight, money, the hold priced at every port, missions.
//   Ships    every faction line's hulls in every class, drawn behind the tab by the shipyard (src/play/shipyard.js)
//            with plumes and shields: click a hull for a new seed, shift-click for the one before.
// tools/gen-content.js records how content was made; the build inlines the records. Everything here is read-only.
function makeDebug(ctx) {
  const { el, raw, loaded, econ, lore, art, log } = ctx;
  const e = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const json = v => `<pre class="dbg-json">${e(JSON.stringify(v, null, 2))}</pre>`;
  const text = s => `<pre class="dbg-text">${e(s)}</pre>`;
  const kv = rows => `<table class="dbg-kv">${rows.filter(r => r && r[1] !== undefined && r[1] !== '').map(([k, v]) => `<tr><th>${e(k)}</th><td>${v}</td></tr>`).join('')}</table>`;
  const sw = hex => hex ? `<span class="dbg-sw" style="background:${e(hex)}" title="${e(hex)}"></span>` : '';
  const money = n => n == null ? '' : `$${(+n).toFixed(3)}`;
  const fold = (title, body, open) => `<details class="dbg-fold"${open ? ' open' : ''}><summary>${title}</summary>${body}</details>`;
  const notesHtml = notes => notes.map(n => `${n.fatal ? 'FATAL' : 'clamped'} <code>${e(n.path)}</code> ${e(n.msg)}`).join('<br>');
  const SYS = loaded.system, BODIES = loaded.bodies, L = lore.lore, LL = log.lore, AL = log.art || {};
  const sections = (list, top) => `<nav class="dbg-nav">${list.map(s => `<a href="#dbg-${s.id}">${e(s.title)}</a>`).join('')}</nav>`
    + `<div class="dbg-body">${top || ''}${list.map(s => `<section id="dbg-${s.id}"><h3>${e(s.title)}</h3>${s.body}</section>`).join('')}</div>`;

  // ---------- the image prompts, factored: a paragraph two or more prompts of a kind share is template; the rest is
  // the image's own part. The art bible's paragraph is shown once, as the bible.
  const artFiles = [...Object.entries(art.vistas).map(([id, src]) => ({ kind: 'vista', id, src })), ...Object.entries(art.portraits).map(([id, src]) => ({ kind: 'portrait', id, src }))]
    .map(f => Object.assign(f, { name: f.src.split('/').pop() }, { rec: AL[f.src.split('/').pop()] || {} }));
  const paras = p => (p || '').split('\n\n');
  const isBible = p => /^Art bible for /.test(p);
  const shared = {};
  for (const kind of ['vista', 'portrait']) {
    const count = new Map();
    artFiles.filter(f => f.kind === kind).forEach(f => new Set(paras(f.rec.prompt)).forEach(p => count.set(p, (count.get(p) || 0) + 1)));
    shared[kind] = { n: artFiles.filter(f => f.kind === kind && f.rec.prompt).length, paras: [...count].filter(([p, c]) => c > 1 && !isBible(p)) };
  }
  const ownPart = f => paras(f.rec.prompt).filter(p => !isBible(p) && !shared[f.kind].paras.some(([q]) => q === p)).join('\n\n');
  const artMeta = f => `<small>seed ${e(f.rec.seed)} · ${money(f.rec.cost)}${f.rec.seconds ? ` · ${f.rec.seconds} s` : ''}${f.rec.date !== artDate ? ` · ${e(f.rec.date)}` : ''} · ${f.rec.reference ? `reference ${e(f.rec.reference)}` : 'no reference'}${f.rec.model !== artModel ? ` · ${e(f.rec.model)}` : ''}</small>`;
  const artModels = [...new Set(artFiles.map(f => f.rec.model).filter(Boolean))], artModel = artModels[0];
  const artDates = [...new Set(artFiles.map(f => f.rec.date).filter(Boolean))].sort(), artDate = artDates.length === 1 ? artDates[0] : null;
  const artCost = artFiles.reduce((n, f) => n + (f.rec.cost || 0), 0);
  const imageBlock = f => `<img src="${e(f.src)}" alt="${e(f.name)}" loading="lazy">${artMeta(f)}`
    + (f.rec.prompt ? fold('Own prompt part', text(ownPart(f)), true) + fold('Full prompt', text(f.rec.prompt), false) : '<small class="warn">no log entry</small>');

  // ---------- Content ----------
  function content() {
    const S = [], add = (id, title, body) => S.push({ id, title, body });
    const facts = LL && LL.facts, factOf = id => facts && facts.bodies.find(b => b.id === id);
    const header = `<div class="dbg-head-line">`
      + `<span><b>${e(SYS.name)}</b> <code>${e(SYS.id)}</code></span>`
      + `<span>lore ${LL ? `${e(LL.model)} · ${LL.sent ? e(LL.date) : `prompt recorded ${e(LL.date)}`} · ${money(LL.cost)}` : '<span class="warn">none</span>'}</span>`
      + `<span>art ${artFiles.length ? `${e(artModels.join(', '))} · ${artFiles.length} images · ${artDates.map(e).join(' to ')} · ${money(artCost)}` : '<span class="warn">none</span>'}</span>`
      + `<span>total ${money((LL ? LL.cost || 0 : 0) + artCost)}</span></div>`
      + (LL && !LL.sent ? `<p class="dbg-note warn">${e(LL.note || 'The lore prompt below was recorded after the fact, not as sent.')}</p>` : '')
      + (lore.notes.length ? `<p class="dbg-note warn">Lore: ${notesHtml(lore.notes)}</p>` : '')
      + (loaded.notes.length ? `<p class="dbg-note warn">System file: ${notesHtml(loaded.notes)}</p>` : '');

    // the pipeline's shared parts
    const sysFacts = facts ? kv([['era', e(facts.era)], ['system', `${e(facts.system.name)} · ${e(facts.system.ring)} · ${e(facts.system.star)}`], ['description', e(facts.system.description)],
      ['owner', `${e(facts.owner.name)}: ${e(facts.owner.what)}<br><small>design: ${e(facts.owner.designLanguage)}</small>`], ['other factions', e(facts.otherFactions.join('; '))]]) : '<p class="dbg-note">No lore record, so no facts.</p>';
    const strip = m => m.content.replace(/\{"\$schema"[\s\S]*$/, '‹lore.schema.json, in Raw›').replace(/The facts:\n\{[\s\S]*?\n\}\n/, 'The facts: ‹the system above, and each port card\'s body›\n');
    const loreStep = LL ? kv([['model', `${e(LL.model)} · seed ${e(LL.seed)} · temperature ${e(LL.temperature)} · max ${e(LL.max_tokens)} tokens`],
      ['run', `${e(LL.date)} · ${money(LL.cost)}${LL.seconds ? ` · ${LL.seconds} s` : ''}${LL.attempts ? ` · ${LL.attempts.length} attempt(s)` : ''}`]])
      + (LL.attempts || []).filter(a => a.problems.length).map((a, i) => fold(`Attempt ${i + 1}: ${a.problems.length} problem(s)`, text(a.problems.join('\n')))).join('')
      + LL.messages.map(m => fold(`${e(m.role)} message`, text(strip(m)), true)).join('') : '<p class="dbg-note">No lore record (<code>src/lore/&lt;id&gt;.log.json</code>).</p>';
    const artStep = (L ? kv([['palette', L.artBible.palette.map(h => `${sw(h)}<code>${e(h)}</code>`).join(' &nbsp; ')], ['lighting', e(L.artBible.lighting)], ['architecture', e(L.artBible.architecture)],
      ['materials', e(L.artBible.materials)], ['mood', e(L.artBible.mood)], ['design', e(L.artBible.design)]]) : '')
      + ['vista', 'portrait'].map(kind => shared[kind].n ? fold(`Shared by the ${kind} prompts (${shared[kind].n} images), besides the art bible`,
        shared[kind].paras.map(([p, c]) => `${c < shared[kind].n ? `<small>in ${c} of ${shared[kind].n}</small>` : ''}${text(p)}`).join(''), false) : '').join('');
    add('pipeline', 'Pipeline', `<p class="dbg-sub">1 · Facts</p>${sysFacts}<p class="dbg-sub">2 · Lore</p>${loreStep}<p class="dbg-sub">3 · Art bible and prompt templates</p>${artStep}`);

    // a card per port: the body (the system file's look and the facts' words for it), its lore, its art
    const ports = BODIES.filter(b => b.port);
    const bodyCol = b => {
      const lk = b.look || {}, f = factOf(b.id), P0 = b.port;
      return kv([['kind', `${e(b.kind)}${b.parent && b.parent !== 'star' ? ` of ${e(b.parent)}` : ''}${f ? ` · ${e(f.position)} · ${e(f.size)}` : ''}`],
        ['place', `${Math.round(b.x)}, ${Math.round(b.y)} m · radius ${e(b.r)} · gravity ${e(b.g)}`],
        ['look', b.station ? `${e(b.station.archetype)} · ${e(b.station.brand)} · seed ${e(b.station.seed)}` : `${e(lk.surface)} · seed ${e(lk.seed)}${lk.cityLights ? ' · city lights' : ''} · ${(lk.palette || []).map(sw).join('')} ${lk.atmosphere ? `atmosphere ${sw(lk.atmosphere)}` : ''}`],
        ['in words', f && f.looks ? e(f.looks) : undefined],
        ['port', P0 ? `${e(P0.role)} · ${e(P0.population)} · ${e((P0.services || []).join(', '))}` : undefined],
        ['market', f && f.port ? `cheap: ${e(f.port.market.cheapHere.join(', ') || 'nothing')}<br>dear: ${e(f.port.market.dearHere.join(', ') || 'nothing')}` : undefined],
        ['routes', f && f.port ? e(Object.entries(f.port.routes).map(([k, v]) => `${k} ${v}`).join(' · ')) : undefined],
        ['authored', P0 && P0.description ? `<small>${e(P0.description)}</small>` : undefined]]);
    };
    add('ports', 'Ports', ports.map(b => {
      const p = L && L.ports.find(q => q.body === b.id), vista = artFiles.find(f => f.kind === 'vista' && f.id === b.id);
      const loreCol = p ? p.description.map(t => `<p>${e(t)}</p>`).join('') + `<p class="dbg-sub">Vista brief</p><p>${e(p.vista)}</p>`
        + `<p class="dbg-sub">Places</p>${p.places.map(q => `<p><b>${e(q.name)}</b> · ${e(q.text)}</p>`).join('')}`
        + `<p class="dbg-sub">Rumors</p>${p.rumors.map(r => `<p>${e(r)}</p>`).join('')}` : '<p class="dbg-note">No lore for this port.</p>';
      const people = p ? p.people.map(q => {
        const f = artFiles.find(a => a.kind === 'portrait' && a.id === q.id);
        return `<div class="dbg-person">${f ? `<div>${imageBlock(f)}</div>` : '<div class="dbg-note">no portrait</div>'}<div><b>${e(q.name)}</b> <code>${e(q.id)}</code><br><small>${e(q.role)}</small><p>${e(q.text)}</p><p><i>“${e(q.line)}”</i></p><p><small>Look: ${e(q.look)}</small></p></div></div>`;
      }).join('') : '';
      return `<div class="dbg-port"><h4>${e(b.port.name)} <small>${e(b.name)} · <code>${e(b.id)}</code></small></h4>`
        + `<div class="dbg-cols"><div>${bodyCol(b)}</div><div>${loreCol}</div><div class="dbg-vista">${vista ? imageBlock(vista) : '<p class="dbg-note">No vista: the port shows the procedural view.</p>'}</div></div>`
        + (people ? `<p class="dbg-sub">People</p><div class="dbg-people">${people}</div>` : '') + '</div>';
    }).join('')
      + `<p class="dbg-sub">Bodies without ports</p><table class="dbg-grid"><tbody>${BODIES.filter(b => !b.port).map(b => {
        const lk = b.look || {}, f = factOf(b.id);
        return `<tr><td><b>${e(b.name)}</b><br><code>${e(b.id)}</code></td><td>${e(b.kind)}${b.starClass ? ` · ${e(b.starClass)}` : ''}</td><td class="n">${Math.round(b.x)}, ${Math.round(b.y)}</td><td class="n">r ${e(b.r)} · g ${e(b.g)}</td>`
          + `<td>${(lk.palette || []).map(sw).join('')}${lk.atmosphere ? ` ${sw(lk.atmosphere)}` : ''}</td><td>${f ? e(`${f.position} · ${f.size}${f.looks ? ` · ${f.looks}` : ''}`) : ''}</td></tr>`;
      }).join('')}</tbody></table>`);

    // the files, the only place raw JSON appears
    add('raw', 'Raw', fold('System file <code>src/systems/</code>, as written', json(raw))
      + (L ? fold(`Lore <code>src/lore/${e(SYS.id)}.json</code>`, json(L)) : '')
      + (LL ? fold(`Lore record <code>src/lore/${e(SYS.id)}.log.json</code>: facts, messages, run`, json(LL)) : '')
      + (Object.keys(AL).length ? fold(`Art log <code>art/${e(SYS.id)}/log.json</code>`, json(AL)) : ''));
    return sections(S, header);
  }

  // ---------- Player: live, rebuilt each time the tab shows ----------
  let live = null;
  function player() {
    const d = live && live();
    if (!d) return '<p class="dbg-note">The game has not started yet.</p>';
    const S = [], add = (id, title, body) => S.push({ id, title, body }), fmt = n => Math.round(n).toLocaleString('en-US');
    add('ship', 'Ship', kv([['type', `<b>${e(d.ship.name)}</b> <small>slot 0 · type ${d.ship.kind}</small>`], ['length', `${d.ship.length} m`],
      ['acceleration', `${d.ship.accel.toFixed(1)} m/s²`], ['turn', `${d.ship.turn.toFixed(2)} rad/s`], ['top speed', `${d.ship.vmax.toFixed(0)} m/s`],
      ['gravity well', `${d.ship.well} <small>(how hard wells pull it and bend its top speed)</small>`], ['hold', `${d.ship.cargo} t`]]));
    add('flight', 'Flight', kv([['mode', e(d.mode)], ['assist', e(d.assist)], ['at', e(d.at || '')], ['below', e(d.below || 'no port')],
      ['position', `${fmt(d.x)}, ${fmt(d.y)} m`], ['velocity', `${d.v.toFixed(1)} m/s <small>(${d.vx.toFixed(1)}, ${d.vy.toFixed(1)})</small>`],
      ['heading', `${d.heading.toFixed(1)}° <small>spin ${d.av.toFixed(3)} rad/s</small>`], ['set speed', `${d.set.toFixed(0)} m/s`], ['autopilot', e(d.auto || 'off')]]));
    add('money', 'Money', kv([['credits', `${fmt(d.credits)} cr`], ['debt', `${fmt(d.debt)} cr at ${(d.interest * 100).toFixed(1)}% a day <small>(${fmt(d.debt * d.interest)} cr a day)</small>`],
      ['docking fee', `${d.dockFee} cr a day in port`], ['cargo value', d.here ? `${fmt(d.cargoHere)} cr here at ${e(d.here)}; ${fmt(d.cargoBest)} cr at the best port for each` : `${fmt(d.cargoBest)} cr at the best port for each`],
      ['net worth', `${fmt(d.credits + d.cargoBest - d.debt)} cr <small>(credits, plus cargo at its best prices, less the debt; mission cargo excluded)</small>`]]));
    add('hold', 'Hold and prices', `<p class="dbg-note">${d.holdUsed} of ${d.ship.cargo} t used: ${d.tradeTons} t of trade cargo, ${d.missionTons} t of mission cargo. Prices per ton (green under base, amber over); a box marks the best price for cargo aboard${d.here ? `; the column you are at is lit` : ''}.</p>`
      + `<table class="dbg-grid"><thead><tr><th>Commodity</th><th class="n">Aboard</th><th class="n">Base</th>${d.ports.map(p => `<th class="n${p.here ? ' here' : ''}">${e(p.name)}<br><small>${e(p.role)}</small></th>`).join('')}</tr></thead><tbody>`
      + d.goods.map(g => {
        const best = g.aboard ? Math.max(...g.prices) : 0;
        return `<tr><td>${e(g.name)}</td><td class="n">${g.aboard || ''}</td><td class="n">${g.base}</td>${g.prices.map((pr, k) => `<td class="n${d.ports[k].here ? ' here' : ''}${pr ? (pr < g.base ? ' low' : pr > g.base ? ' high' : '') : ' none'}${g.aboard && pr === best && pr ? ' best' : ''}">${pr || '·'}</td>`).join('')}</tr>`;
      }).join('') + '</tbody></table>');
    add('missions', 'Missions', d.missions.length ? `<table class="dbg-grid"><thead><tr><th>Slot</th><th>Deliver to</th><th>Cargo</th><th class="n">Pay</th><th class="n">Due</th></tr></thead><tbody>${d.missions.map(m => `<tr><td>${m.k}</td><td>${e(m.dest)}</td><td>${m.tons} t ${e(m.good)}</td><td class="n">${fmt(m.pay)}</td><td class="n${m.left <= 1 ? ' high' : ''}">day ${m.due} (${m.left <= 0 ? 'today' : `${m.left} left`})</td></tr>`).join('')}</tbody></table>` : '<p class="dbg-note">No active missions.</p>');
    add('session', 'Session', kv([['day', d.day], ['tick', `${d.tick} <small>(${(d.tick / 60 / 60).toFixed(1)} min of game time)</small>`], ['state hash', `<code>${d.hash}</code>`], ['seed', d.seed]]));
    return sections(S);
  }

  // ---------- Ships: a grid of cells the shipyard draws hulls behind; the pane is see-through ----------
  let yard = null;
  const yardOpts = { throttle: 0.7, shields: true, trueScale: false, hover: null };
  const cargoOf = (B, z) => Math.round(((z.flight || {}).cargo || 0) * (B.style.flight.cargo == null ? 1 : B.style.flight.cargo));
  const shipLabel = (B, z, i) => `<b>${e(B.series[i])}</b><small>${e(z.name)} · ${z.length} m · ${cargoOf(B, z)} t</small><small class="seed">seed ${e(yard.seedOf(B.id, z.id))}${yard.picked(B.id, z.id) ? ' · picked' : ''}<span class="st"></span></small>`;
  function ships() {
    if (!yard) return '<p class="dbg-note">The shipyard starts with the game.</p>';
    const C = yard.catalog;
    return `<div class="dbg-yard"><div class="dbg-yard-bar">`
      + `<label>Throttle <input type="range" id="yd-thr" min="0" max="1" step="0.05" value="${yardOpts.throttle}"></label>`
      + `<label><input type="checkbox" id="yd-sh"${yardOpts.shields ? ' checked' : ''}> Shields</label>`
      + `<label><input type="checkbox" id="yd-ts"${yardOpts.trueScale ? ' checked' : ''}> True scale</label>`
      + `<button type="button" id="yd-copy">Copy picks</button><button type="button" id="yd-reset">Reset picks</button>`
      + `<span class="hint">Click a hull for a new seed · shift-click for the one before · picks are kept in this browser and used by the game's ships</span></div>`
      + `<div class="dbg-yard-grid" style="grid-template-columns: 220px repeat(${C.sizes.length}, minmax(0, 1fr))"><div></div>`
      + C.sizes.map(z => `<div class="dbg-yard-col"><b>${e(z.name)}</b><small>${z.length} m</small></div>`).join('')
      + C.brands.map(B => `<div class="dbg-yard-row"><b>${e(B.factionName)}</b><span>${e(B.lineName)}${B.unique ? ' · unnamed' : ''}</span><small>${e(B.blurb)}</small></div>`
        + C.sizes.map((z, i) => B.classes && !B.classes.includes(z.id) ? '<div></div>' : `<div class="dbg-ship" data-b="${e(B.id)}" data-z="${e(z.id)}" title="${e(B.series[i])}: click for a new seed, shift-click for the one before"><div class="lbl">${shipLabel(B, z, i)}</div></div>`).join('')).join('')
      + `</div></div>`;
  }
  function mountShips(pane) {
    if (!yard) return;
    yard.bakeAll();
    const relabel = el => { const B = yard.catalog.brands.find(x => x.id === el.dataset.b), i = yard.catalog.sizes.findIndex(z => z.id === el.dataset.z); el.querySelector('.lbl').innerHTML = shipLabel(B, yard.catalog.sizes[i], i); };
    pane.querySelectorAll('.dbg-ship').forEach(el => {
      el.onclick = ev => { if (ev.shiftKey) yard.back(el.dataset.b, el.dataset.z); else yard.reroll(el.dataset.b, el.dataset.z); pane.querySelectorAll('.dbg-ship').forEach(relabel); }; // a shared hull's other line changes too
      el.onmouseenter = () => { yardOpts.hover = el; }; el.onmouseleave = () => { if (yardOpts.hover === el) yardOpts.hover = null; };
    });
    pane.querySelector('#yd-thr').oninput = ev => { yardOpts.throttle = +ev.target.value; };
    pane.querySelector('#yd-sh').onchange = ev => { yardOpts.shields = ev.target.checked; };
    pane.querySelector('#yd-ts').onchange = ev => { yardOpts.trueScale = ev.target.checked; };
    pane.querySelector('#yd-copy').onclick = ev => {
      const txt = JSON.stringify(yard.exportPicks(), null, 1);
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { ev.target.textContent = 'Copied'; }, () => { window.prompt('Picks (a line\'s seeds, for the catalog):', txt); });
      setTimeout(() => { ev.target.textContent = 'Copy picks'; }, 1500);
    };
    pane.querySelector('#yd-reset').onclick = () => { if (confirm('Forget every picked seed in this browser?')) { yard.reset(); pane.querySelectorAll('.dbg-ship').forEach(relabel); } };
  }
  // the cells on show and their options, for the game's frame to draw (null unless the Ships tab is up)
  function yardView() {
    if (el.hidden || tab !== 'ships' || !yard) return null;
    const cells = [...el.querySelectorAll('.dbg-ship')].map(c => ({ el: c, b: c.dataset.b, z: c.dataset.z }));
    for (const c of cells) { const st = c.el.querySelector('.st'), s = yard.status(c.b, c.z); if (st) st.textContent = s === 'ready' ? '' : ' · ' + s; }
    const bar = el.querySelector('.dbg-yard-bar');
    yardOpts.clipTop = bar ? bar.getBoundingClientRect().bottom : 0;
    return { cells, opts: yardOpts };
  }

  const TABS = [{ id: 'content', name: 'Content', render: content, fixed: true }, { id: 'player', name: 'Player', render: player }, { id: 'ships', name: 'Ships', render: ships, mount: mountShips, clear: true }];
  let tab = TABS[0].id;
  const cache = new Map();
  function show(id) {
    tab = id;
    el.querySelector('.dbg-tabs').innerHTML = TABS.map(t => `<button type="button" data-tab="${t.id}" aria-pressed="${t.id === tab}">${e(t.name)}</button>`).join('');
    const T = TABS.find(t => t.id === id), pane = el.querySelector('.dbg-pane');
    if (!T.fixed || !cache.has(id)) cache.set(id, T.render()); // content is static: rendered once; live tabs every time
    pane.innerHTML = cache.get(id);
    document.body.classList.toggle('dbg-clear', !!T.clear); // see-through: the game's canvas draws behind this tab, the rest of the page hides
    if (T.mount) T.mount(pane);
    // section links scroll the pane, not the page's hash
    pane.querySelectorAll('.dbg-nav a').forEach(a => { a.onclick = ev => { ev.preventDefault(); pane.querySelector(a.getAttribute('href')).scrollIntoView({ block: 'start' }); }; });
  }
  el.querySelector('.dbg-tabs').onclick = ev => { const b = ev.target.closest('button[data-tab]'); if (b) show(b.dataset.tab); };
  return {
    isOpen: () => !el.hidden,
    open() { show(tab); el.hidden = false; },
    close() { el.hidden = true; document.body.classList.remove('dbg-clear'); },
    setLive(fn) { live = fn; }, // the Player tab's source, bound once the core has loaded
    setYard(y) { yard = y; },
    yardView
  };
}
