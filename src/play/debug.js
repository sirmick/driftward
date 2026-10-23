// ======================= DEBUG =======================
// The debug screen (backquote): a full-window view over the game, with the clock stopped while it is open.
//   Content  how this system's content was made, each thing shown once: a header with the run's models and costs;
//            the pipeline's shared parts (the system-level facts, the lore prompt with its facts and schema left
//            out, the art bible and the parts every image prompt shares); one card per port with its body, its
//            lore and its art, each image showing only its own part of the prompt; then the raw files.
//   Player   the live state: ship and its stats, flight, money, the hold priced at every port, missions.
//   Traffic  the traffic mix (local, through, loiter) against what is flying now, by stream and by row.
//   Ships    every faction line's hulls in every class, drawn behind the tab by the shipyard (src/play/shipyard.js)
//            with plumes and shields: click a hull for a new seed, shift-click for the one before.
//   Suns     this system's stars and one of each of the twelve classes, drawn behind the tab by the game's star kit
//            (src/stars.js, src/play/suns.js); click one to open it in the builder, whose sliders edit the system
//            file's star entry (the JSON to copy into it). The lab's old Suns tab.
//   Regions  the galaxy's named regions (the universe index): each one's facts, trade and summary, its hand-written
//            notes (src/lore/regions/), and its systems, each a link to the Planets tab.
//   Planets  every system, region by region: its people, ports, wealth, security and unrest, and its backstory
//            bullets; a system's name opens it on the Map tab.
//   Map      the galaxy in 3D (src/map/map.js, as map.html shows it): the real stars round Sol, the game's systems,
//            lanes and faction territories, drawn behind the tab with the map's panel (src/map/panel.js).
// The header's jump box takes the player to any planet, moon, station, belt or field in any system: place@system. The
// Labs row beside it jumps to the test worlds (docs/weapons.md) and back to the start system.
// tools/gen-content.js records how content was made. The universe index is there from the start; what only this
// screen reads (how a system's content was made, the real stars, the setting and the stories' log) is read through
// src/data.js when a tab first needs it. Everything here is read-only.
function makeDebug(ctx) {
  // the system being played: { id, raw, loaded, lore, art, entry (its index entry), log (once read) }
  const { el, econ, data, universe: U } = ctx, current = ctx.system;
  const e = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const json = v => `<pre class="dbg-json">${e(JSON.stringify(v, null, 2))}</pre>`;
  const text = s => `<pre class="dbg-text">${e(s)}</pre>`;
  const kv = rows => `<table class="dbg-kv">${rows.filter(r => r && r[1] !== undefined && r[1] !== '').map(([k, v]) => `<tr><th>${e(k)}</th><td>${v}</td></tr>`).join('')}</table>`;
  const sw = hex => hex ? `<span class="dbg-sw" style="background:${e(hex)}" title="${e(hex)}"></span>` : '';
  const money = n => n == null ? '' : `$${(+n).toFixed(3)}`;
  const fold = (title, body, open) => `<details class="dbg-fold"${open ? ' open' : ''}><summary>${title}</summary>${body}</details>`;
  const notesHtml = notes => notes.map(n => `${n.fatal ? 'FATAL' : 'clamped'} <code>${e(n.path)}</code> ${e(n.msg)}`).join('<br>');
  const sections = (list, top) => `<nav class="dbg-nav">${list.map(s => `<a href="#dbg-${s.id}">${e(s.title)}</a>`).join('')}</nav>`
    + `<div class="dbg-body">${top || ''}${list.map(s => `<section id="dbg-${s.id}"><h3>${e(s.title)}</h3>${s.body}</section>`).join('')}</div>`;

  // A tab whose file isn't read yet (src/data.js) says so, and draws again when it arrives; null once it is there.
  function waitFor(file, id) {
    if (data.has(file)) return null;
    data.file(file).then(() => { cache.clear(); if (!el.hidden && tab === id) show(id); }, err => { console.error(err); });
    return `<p class="dbg-note">Reading <code>${e(file)}</code>…</p>`;
  }

  // ---------- Content ----------
  function content() {
    const rec = current(), wait = waitFor(`logs/${rec.id}.json`, 'content');
    if (wait) return wait;
    const { raw, loaded, lore, art, entry: me } = rec, log = data.peek(`logs/${rec.id}.json`);
    const SYS = loaded.system, BODIES = loaded.bodies, L = lore.lore, LL = log.lore || null, AL = log.art || {};
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
    const artMeta = f => `<small>seed ${e(f.rec.seed)} · ${money(f.rec.cost)}${f.rec.seconds ? ` · ${f.rec.seconds} s` : ''}${f.rec.date !== artDate ? ` · ${e(f.rec.date)}` : ''} · ${f.rec.reference ? `reference ${e(f.rec.reference)}` : 'no reference'}${f.rec.model !== artModel ? ` · ${e(f.rec.model)}` : ''}${f.rec.size ? ` · ${e(f.rec.size)}` : ''}${f.rec.provider ? ` · via ${e(f.rec.provider)}` : ''}</small>`;
    const artModels = [...new Set(artFiles.map(f => f.rec.model).filter(Boolean))], artModel = artModels[0];
    const artDates = [...new Set(artFiles.map(f => f.rec.date).filter(Boolean))].sort(), artDate = artDates.length === 1 ? artDates[0] : null;
    const artCost = artFiles.reduce((n, f) => n + (f.rec.cost || 0), 0);
    const imageBlock = f => `<img src="${e(f.src)}" alt="${e(f.name)}" loading="lazy">${artMeta(f)}`
      + (f.rec.prompt ? fold('Own prompt part', text(ownPart(f)), true) + fold('Full prompt', text(f.rec.prompt), false) : '<small class="warn">no log entry</small>');

    const S = [], add = (id, title, body) => S.push({ id, title, body });
    const facts = LL && LL.facts, factOf = id => facts && facts.bodies.find(b => b.id === id);
    const header = `<div class="dbg-head-line">`
      + `<span><b>${e(SYS.name)}</b> <code>${e(SYS.id)}</code></span>`
      + `<span>lore ${LL ? `${e(LL.model)}${LL.provider ? ` via ${e(LL.provider)}` : ''} · ${LL.sent ? e(LL.date) : `prompt recorded ${e(LL.date)}`} · ${money(LL.cost)}` : '<span class="warn">none</span>'}</span>`
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
        ['look', b.station ? `${e(b.station.archetype)} · ${e(b.station.brand)} · seed ${e(b.station.seed)}` : `${e(lk.surface)} · seed ${e(lk.seed)}${lk.cityLights ? ` · city lights ${e(lk.cityLights)}` : ''} · ${(lk.palette || []).map(sw).join('')} ${lk.atmosphere ? `atmosphere ${sw(lk.atmosphere)} air ${e(lk.air)}` : ''}${lk.lightning ? ` · lightning ${e(lk.lightning)}` : ''}${lk.rings && lk.rings.density > 0 ? ` · rings ${(lk.rings.colours || []).map(sw).join('')} ${e(lk.rings.inner)}–${e(lk.rings.outer)} r, density ${e(lk.rings.density)}, tilt ${e(lk.rings.tilt)}°` : ''} · debris ×${e(lk.debris)}`],
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
        // the portrait beside who they are; how it was made (its record and prompts) under both, full width
        return `<div class="dbg-person">${f ? `<div><img src="${e(f.src)}" alt="${e(f.name)}" loading="lazy"></div>` : '<div class="dbg-note">no portrait</div>'}<div><b>${e(q.name)}</b> <code>${e(q.id)}</code><br><small>${e(q.role)}</small><p>${e(q.text)}</p><p><i>“${e(q.line)}”</i></p><p><small>Look: ${e(q.look)}</small></p></div>`
          + (f ? `<div class="dbg-person-art">${artMeta(f)}${f.rec.prompt ? fold('Own prompt part', text(ownPart(f)), false) + fold('Full prompt', text(f.rec.prompt), false) : '<small class="warn">no log entry</small>'}</div>` : '') + `</div>`;
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

    // this system in the universe index: its region, its world (people, ports, wealth) and its story
    if (me) {
      const w = me.world;
      add('galaxy', 'Galaxy', kv([['Region', e((U.regions[me.region] || {}).name || me.region)], ['Held by', e(ownerName(me))],
        ['People', w ? `${e(people(w.population))}, ${e(w.tier)}` : ''], ['Ports', w ? e(w.roles.join(', ')) : ''],
        ['Wealth, security, unrest', w ? `${w.wealth}, ${w.security}, ${w.unrest}` : ''], ['Settled', e(me.settled || '')], ['Jumps from Sol', e(me.jumps)]])
        + (me.story ? `<p class="dbg-sub">Story</p><ul>${me.story.map(b => `<li>${e(b)}</li>`).join('')}</ul>` : '')
        + `<p><button type="button" class="dbg-link" data-planet="${me.id}">Open on the Planets tab</button> · <button type="button" class="dbg-link" data-star="${me.id}">on the Map</button></p>`);
    }
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
      ['gravity well', `${d.ship.well} <small>(how hard wells pull it and bend its top speed)</small>`], ['hold', `${d.ship.cargo} t`],
      ['hull', `${Math.round(d.ship.hull)} of ${Math.round(d.ship.hullCap)} points${d.ship.radiation > 0 ? ` <small class="warn">losing ${(d.ship.radiation * 100).toFixed(1)}% a second to radiation</small>` : ''}`],
      ['fuel', `${d.ship.fuel.toFixed(2)} of ${d.ship.fuelCap.toFixed(1)} t <small>(for jumps)</small>`],
      ['heat', `${Math.round(d.ship.heat * 100)}%${d.ship.hot ? ' <span class="warn">burner locked until half cooled</span>' : ''} <small>(the burner's: full in ${d.ship.heatBurn} s of burn, cold again in ${d.ship.heatCool})</small>`]]));
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

  // ---------- Suns: cells the gallery draws stars behind; one open in the builder ----------
  let gallery = null, sunCells = [], sunEdit = null; // sunEdit: { entry, name, from } while the builder is open
  const sunOpts = { flares: true, clipTop: 0 };
  const fmtM = m => m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
  const sunSub = entry => { const G = starGame(entry), T = STAR_CLASSES[entry.class]; return `${e(T.cls)} · r ${fmtM(G.radius)} · well ${G.gravity}${G.hazard ? ` · hazard ${fmtM(G.hazard)}` : ''}`; };
  // a star entry as a system file would write it: class and seed, and only the look values that differ from what the
  // class and seed give
  function sunJson(entry) {
    const base = starLook({ class: entry.class, seed: entry.seed }), look = {};
    for (const [k, v] of Object.entries(entry.look || {})) if (starApplies(k, entry.class) && Math.abs(v - base[k]) > 1e-6) look[k] = Math.round(v * 1000) / 1000;
    const out = Object.assign({}, entry.name ? { name: entry.name } : {}, { class: entry.class, seed: entry.seed });
    for (const k of ['radius', 'gravity', 'hazard', 'orbit']) if (entry[k] !== undefined) out[k] = entry[k];
    if (Object.keys(look).length) out.look = look;
    return out;
  }
  const sunCell = (k, name, entry) => `<div class="dbg-ship dbg-sun" data-k="${k}" title="${e(name)}: open in the builder"><div class="lbl"><b>${e(name)}</b><small>${sunSub(entry)}</small></div></div>`;
  function sunsTab() {
    if (!gallery) return '<p class="dbg-note">The star kit starts with the game.</p>';
    const SYS = current().loaded.system;
    sunCells = [];
    const add = (name, entry, from) => { sunCells.push({ name, entry, from, look: starLook(entry) }); return sunCells.length - 1; };
    if (sunEdit) {
      const { entry } = sunEdit, k = add(sunEdit.name, entry, sunEdit.from), T = STAR_CLASSES[entry.class], L = sunCells[k].look;
      return `<div class="dbg-yard dbg-sun-edit"><div class="dbg-yard-bar"><button type="button" id="sn-back">← All stars</button>`
        + `<label><input type="checkbox" id="sn-flares"${sunOpts.flares ? ' checked' : ''}> Lens flare</label>`
        + `<span class="hint">${e(sunEdit.from)} · edits stay here: copy the JSON into the system file's star</span></div>`
        + `<div class="dbg-sun-cols"><div class="dbg-sun-big" data-k="${k}"></div><div class="dbg-sun-panel">`
        + `<h4>${e(sunEdit.name)}</h4><p class="dbg-note">${e(T.label)} · ${sunSub(entry)}</p>`
        + `<label class="dbg-sun-row">Class <select id="sn-class">${STAR_ORDER.map(c => `<option value="${c}"${c === entry.class ? ' selected' : ''}>${e(STAR_CLASSES[c].label)} (${e(STAR_CLASSES[c].cls)})</option>`).join('')}</select></label>`
        + `<label class="dbg-sun-row">Seed <input type="range" id="sn-seed" min="0" max="100" step="1" value="${entry.seed}"><output>${entry.seed}</output></label>`
        + Object.keys(STAR_RANGES).filter(k => k !== 'radius' && starApplies(k, entry.class)).map(k => { const R = STAR_RANGES[k];
          return `<label class="dbg-sun-row">${e(STAR_LABELS[k])} <input type="range" data-p="${k}" min="${R[0]}" max="${R[1]}" step="${R[2]}" value="${L[k]}"><output>${e(R[3](L[k]))}</output></label>`; }).join('')
        + `<div class="dbg-sun-acts"><button type="button" id="sn-reset">Class look</button><button type="button" id="sn-copy">Copy JSON</button></div>`
        + `<pre class="dbg-json" id="sn-json">${e(JSON.stringify(sunJson(entry), null, 1))}</pre></div></div></div>`;
    }
    const own = [['', SYS.star], [' (companion)', SYS.star.companion]].filter(([, st]) => st).map(([tag, st]) => sunCell(add(st.name + tag, JSON.parse(JSON.stringify(st)), `${SYS.name}'s star`), st.name + tag, st)).join('');
    const every = STAR_ORDER.map(c => { const entry = { class: c, seed: 1, look: {} }; return sunCell(add(STAR_CLASSES[c].label, entry, 'a class preset'), STAR_CLASSES[c].label, entry); }).join('');
    return `<div class="dbg-yard"><div class="dbg-yard-bar"><label><input type="checkbox" id="sn-flares"${sunOpts.flares ? ' checked' : ''}> Lens flares</label>`
      + `<span class="hint">Click a star to open it in the builder · the twelve classes are the system file's star.class (src/stars.js)</span></div>`
      + `<p class="dbg-sub">The ${e(SYS.name)} system</p><div class="dbg-sun-grid">${own}</div>`
      + `<p class="dbg-sub">Every class</p><div class="dbg-sun-grid">${every}</div></div>`;
  }
  function mountSuns(pane) {
    const fl = pane.querySelector('#sn-flares'); if (fl) fl.onchange = ev => { sunOpts.flares = ev.target.checked; };
    pane.querySelectorAll('.dbg-sun').forEach(el => { el.onclick = () => { const c = sunCells[+el.dataset.k]; sunEdit = { name: c.name, from: c.from, entry: JSON.parse(JSON.stringify(Object.assign({ seed: 1, look: {} }, c.entry))) }; show('suns'); }; });
    if (!sunEdit) return;
    const E = sunEdit.entry, cell = () => sunCells[0], json = () => { pane.querySelector('#sn-json').textContent = JSON.stringify(sunJson(E), null, 1); };
    pane.querySelector('#sn-back').onclick = () => { sunEdit = null; show('suns'); };
    pane.querySelector('#sn-class').onchange = ev => { E.class = ev.target.value; E.look = {}; delete E.radius; delete E.gravity; delete E.hazard; show('suns'); };
    // the seed varies the class's look under any values set here: drawn as it moves, the sliders caught up on release
    const seed = pane.querySelector('#sn-seed');
    seed.oninput = ev => { E.seed = +ev.target.value; cell().look = starLook(E); seed.nextElementSibling.textContent = E.seed; json(); };
    seed.onchange = () => show('suns');
    pane.querySelector('#sn-reset').onclick = () => { E.look = {}; show('suns'); };
    pane.querySelectorAll('input[data-p]').forEach(inp => { inp.oninput = ev => {
      const k = inp.dataset.p; E.look = E.look || {}; E.look[k] = +ev.target.value; cell().look = starLook(E);
      inp.nextElementSibling.textContent = STAR_RANGES[k][3](+ev.target.value); json(); }; });
    pane.querySelector('#sn-copy').onclick = ev => {
      const txt = JSON.stringify(sunJson(E), null, 1);
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { ev.target.textContent = 'Copied'; }, () => { window.prompt('The star entry, for the system file:', txt); });
      setTimeout(() => { ev.target.textContent = 'Copy JSON'; }, 1500);
    };
  }
  // the cells on show and their looks, for the game's frame to draw (null unless the Suns tab is up)
  function sunView() {
    if (el.hidden || tab !== 'suns' || !gallery) return null;
    const cells = [...el.querySelectorAll('.dbg-sun, .dbg-sun-big')].map(c => ({ el: c, look: sunCells[+c.dataset.k].look, big: c.classList.contains('dbg-sun-big') }));
    const bar = el.querySelector('.dbg-yard-bar');
    sunOpts.clipTop = bar ? bar.getBoundingClientRect().bottom : 0;
    return { cells, opts: sunOpts };
  }

  // ---------- Traffic: live, rebuilt each time the tab shows ----------
  function trafficTab() {
    const d = live && live();
    if (!d) return '<p class="dbg-note">The game has not started yet.</p>';
    const T = d.traffic, pct = x => `${(x * 100).toFixed(0)}%`, S = [];
    const [local, arrive, depart, loiter] = T.byStream, flying = local + arrive + depart + loiter;
    S.push({ id: 'tr-now', title: 'Now', body: kv([
      ['in flight', `<b>${flying}</b> of a ${T.cap} cap <small>(target ${T.ships} local and through, plus ${T.loiter.toFixed(1)} loitering)</small>`],
      ['local', `${local} <small>port to port (target ${(T.ships * (1 - T.through)).toFixed(1)})</small>`],
      ['through', `${arrive} arriving, ${depart} leaving <small>(target ${(T.ships * T.through).toFixed(1)}; jump zones ${(T.jump / 1000).toFixed(0)} km out, north, east, south and west)</small>`],
      ['loitering', `${loiter} <small>(target ${T.loiter.toFixed(1)})</small>`]]) });
    for (const st of ['local', 'through', 'loiter']) {
      const rows = T.rows.filter(r => r.stream === st);
      S.push({ id: 'tr-' + st, title: { local: 'Local mix', through: 'Through mix', loiter: 'Loiter' }[st], body: rows.length
        ? `<table class="dbg-grid"><thead><tr>${st === 'loiter' ? '<th>Port</th>' : ''}<th>Ship</th><th>Line</th><th>Class</th><th class="n">${st === 'loiter' ? 'Keeps up' : 'Share'}</th><th class="n">Flying</th></tr></thead><tbody>`
          + rows.map(r => `<tr>${st === 'loiter' ? `<td>${e(r.at)}</td>` : ''}<td><b>${e(r.name)}</b></td><td><code>${e(r.line)}</code></td><td>${e(r.cls)}</td><td class="n">${st === 'loiter' ? r.share.toFixed(2) : pct(r.share)}</td><td class="n">${r.live || ''}</td></tr>`).join('') + '</tbody></table>'
        : '<p class="dbg-note">None in this system.</p>' });
    }
    return sections(S);
  }

  // ---------- Regions: every named region, its facts, notes, and systems with their stories ----------
  let pendingStar = null;
  // who holds a system: a faction's (or an alien power's) name, else what it is
  const ownerName = c => c.owner !== 'none' && U.factions[c.owner] ? U.factions[c.owner].name : STATUS_NAME[c.status] || c.status;
  // a little markdown, for the regions' notes: headings, tables, lists, bold, paragraphs
  function md(src) {
    const inline = s => e(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
    return src.split(/\n\s*\n/).map(block => {
      const lines = block.trim().split('\n');
      if (/^#{1,4} /.test(lines[0])) return lines.map(l => { const m = l.match(/^(#+) (.*)/); return m ? `<p class="dbg-sub">${inline(m[2])}</p>` : `<p>${inline(l)}</p>`; }).join('');
      if (lines.every(l => l.trim().startsWith('|'))) {
        const rows = lines.filter(l => !/^\|\s*:?-/.test(l.trim())).map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
        return `<table class="dbg-grid"><thead><tr>${rows[0].map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      }
      if (lines.every(l => /^\s*[-*] /.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`;
      return `<p>${inline(lines.join(' '))}</p>`;
    }).join('');
  }
  const STATUS_NAME = { inhabited: 'settled', dead: 'dead', living: 'a living Bloom world', held: 'held by the Shadow', glass: 'gone glass', emptied: 'emptied by the Shadow' };
  // the galaxy's regions, biggest first, each with its systems (most people first, the dead after)
  const people = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)} billion` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} million` : n >= 1e3 ? `${Math.round(n / 1e3)} thousand` : String(n);
  const pop = c => (c.world || {}).population || 0;
  function regionData() {
    const by = {};
    U.systems.forEach(c => { (by[c.region] = by[c.region] || []).push(c); });
    const tradePop = k => ((U.regions[k] || {}).trade || {}).population || 0;
    const order = Object.keys(U.regions).filter(k => by[k]).sort((a, b) => tradePop(b) - tradePop(a) || by[b].length - by[a].length);
    for (const k of order) by[k].sort((a, b) => pop(b) - pop(a) || (a.status === 'dead') - (b.status === 'dead'));
    return { by, order };
  }
  function regionsTab() {
    const wait = waitFor('galaxy-log.json', 'regions');
    if (wait) return wait;
    const { by, order } = regionData(), GL = data.peek('galaxy-log.json');
    const told = k => by[k].filter(c => c.story).length;
    const LOG = GL.stories || [];
    const list = order.map(k => {
      const sys = by[k], settled = sys.filter(c => c.status === 'inhabited'), R = U.regions[k], tr = R.trade || {};
      const calls = LOG.filter(r => r.region === k);
      const written = calls.length ? fold(`How its stories were written: ${calls.length} call${calls.length > 1 ? 's' : ''}, ${money(calls.reduce((n, r) => n + (r.cost || 0), 0))}`,
        calls.map(r => `<p><small>${e(r.date)} · attempt ${r.attempt} · ${e(r.served || r.model)} · ${money(r.cost)}${r.problems.length ? ` · <span class="warn">${r.problems.length} problem(s): ${e(r.problems.slice(0, 3).join('; '))}</span>` : ' · passed'}</small></p>`
          + r.messages.map(m => fold(e(m.role === 'system' ? 'The rules' : 'The facts sent'), text(m.content), false)).join('')).join(''), false) : '';
      const owners = {}; settled.forEach(c => { owners[c.owner] = (owners[c.owner] || 0) + 1; });
      const facts = kv([
        ['Systems', `${sys.length} (${settled.length} settled${sys.length - settled.length ? `, ${sys.length - settled.length} other` : ''})`],
        ['People', tr.population ? people(tr.population) : ''],
        ['Held by', Object.entries(owners).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${e((U.factions[f] || {}).name || f)} ${n}`).join(', ')],
        ['Exports', (tr.exports || []).map(e).join(', ')], ['Imports', (tr.imports || []).map(e).join(', ')],
        ['Stories', `${told(k)} of ${sys.length} systems${R.told ? ` · ${e(R.told.model)} · ${e(R.told.date)}` : ''}`]]);
      const summary = R.summary && R.summary.length ? `<p class="dbg-sub">Summary</p><ul>${R.summary.map(b => `<li>${e(b)}</li>`).join('')}</ul>` : '<p class="dbg-note">No summary yet (tools/stories.py).</p>';
      const authored = R.notes ? fold('Hand-written notes (src/lore/regions/' + e(k) + '.md)', md(R.notes), true) : '';
      const links = `<p class="dbg-sub">Systems (${sys.length})</p><ul class="dbg-syslist">${sys.map(c => `<li><button type="button" class="dbg-link${c.status === 'dead' ? ' dead' : ''}" data-planet="${c.id}" title="Open on the Planets tab">${e(c.name)}</button>`
        + ` <small>${e(ownerName(c))}${c.status === 'dead' && c.owner !== 'none' ? ', dead' : ''}</small></li>`).join('')}</ul>`;
      return { id: 'rg-' + k, title: R.name, body: facts + summary + authored + written + links };
    });
    if (GL.setting) list.unshift({ id: 'rg-setting', title: 'The setting', body: `<p class="dbg-note">src/lore/setting.md: canon for every system's lore and every region's stories.</p>` + fold('The setting', md(GL.setting), false)
      + (GL.earlier || []).map((s, i) => fold(`An earlier setting (${i + 1}), that some stories were told from`, md(s), true)).join('') });
    const total = Object.values(U.regions).reduce((n, r) => n + ((r.trade || {}).population || 0), 0);
    const top = `<div class="dbg-head-line"><span><b>Regions</b></span><span>${order.length} regions · ${U.systems.length} systems · ${people(total)} people in the regions with trade</span>`
      + `<span>stories for ${U.systems.filter(c => c.story).length} systems in ${Object.values(U.regions).filter(r => r.summary).length} regions</span><span>tools/galaxy.py, worlds.py, stories.py, universe.py; docs/galaxy.md, docs/data.md</span></div>`;
    return sections(list, top);
  }
  // links to a system: on the Planets tab (data-planet) or the Map (data-star)
  function mountLinks(pane) {
    pane.querySelectorAll('.dbg-link[data-planet]').forEach(b => { b.onclick = () => { pendingPlanet = +b.dataset.planet; show('planets'); }; });
    pane.querySelectorAll('.dbg-link[data-star]').forEach(b => { b.onclick = () => { pendingStar = +b.dataset.star; show('map'); }; });
  }
  function mountRegions(pane) {
    pane.querySelectorAll('.dbg-link[data-planet]').forEach(b => { b.onclick = () => { pendingPlanet = +b.dataset.planet; show('planets'); }; });
  }

  // ---------- Planets: every system, region by region, with its content ----------
  let pendingPlanet = null;
  const hexOf = c => '#' + c.map(v => Math.round(Math.pow(Math.min(1, v), 1 / 2.2) * 255).toString(16).padStart(2, '0')).join('');
  const comName = id => ((econ.commodities || []).find(c => c.id === id) || { name: id }).name.toLowerCase();
  function roleTip(r) {  // a port role: what it makes and what it needs (src/economy.json)
    const R = (econ.roles || {})[r] || {}, of = t => Object.keys(R).filter(k => R[k] === t).map(comName);
    return `${r}: makes ${of('low').join(', ') || 'nothing to sell'}${of('high').length ? `; needs ${of('high').join(', ')}` : ''}`;
  }
  function planetsTab() {
    const { by, order } = regionData();
    const list = order.map(k => {
      const rows = by[k].map(c => {
        const w = c.world, s = c.story;
        const tags = [[c.hazard, 'hazard', 'A hazard star: radiation and a deep well'], [c.front, 'front', 'Faces the Shadow: the front the navy holds'],
          [c.exclave, c.exclave, `Cut off from ${ownerName(c)}'s main territory`], [c.gateway, 'gateway', 'Has a lane into the open Drift'],
          [w && w.builtworld, 'Builtworld', 'A whole planet built over into one city: one of six in human space'],
          [c.provisional, 'provisional', 'An invented name: the lore pass may rename it']].filter(x => x[0]);
        const year = c.settled ? [c.settled, 'Settled'] : c.charted ? [c.charted, 'Charted by human surveyors (Bloom contact 2376)'] : c.emptied ? [c.emptied, 'Emptied by the Shadow'] : c.lost ? [c.lost, 'Went glass'] : c.seen ? [c.seen, 'The Shadow seen here from'] : null;
        const who = ownerName(c), F = U.factions[c.owner], col = F && !F.alien && F.colour;
        const sysTip = [`${c.status}${c.ring ? `, ${c.ring} ring` : ''}`, `a ${c.class} star`, c.jumps != null && `${c.jumps} jumps from Sol`, c.depth && `Drift depth ${c.depth}`].filter(Boolean).join(' · ');
        return `<tr id="dbg-pl-${c.id}"><td><button type="button" class="dbg-link${c.status === 'dead' ? ' dead' : ''}" data-star="${c.id}" title="${e(sysTip)} · click: open on the Map">${e(c.name)}</button>`
          + `${tags.length ? `<div class="dbg-chips">${tags.map(([, n, tip]) => `<span class="dbg-chip tag" title="${e(tip)}">${e(n)}</span>`).join('')}</div>` : ''}</td>`
          + `<td title="${e(who)}">${col ? `<span class="dbg-dot" style="background:${hexOf(col)}"></span>` : ''}${e(who)}</td>`
          + `<td class="n" title="${w ? e(`${w.population.toLocaleString()} people: ${w.tier}`) : ''}">${w ? `${e(people(w.population))}<br><small>${e(w.tier)}</small>` : ''}</td>`
          + `<td>${w ? `<div class="dbg-chips">${w.roles.map(r => `<span class="dbg-chip" title="${e(roleTip(r))}">${e(r)}</span>`).join('')}</div>` : ''}</td>`
          + (w ? [['wealth', w.wealth], ['security', w.security], ['unrest', w.unrest]].map(([n, v]) => `<td class="n"><span class="dbg-meter ${n}" style="--v:${v}%" title="${e(`${n[0].toUpperCase() + n.slice(1)} ${v} of 100`)}">${v}</span></td>`).join('') : '<td></td><td></td><td></td>')
          + `<td class="n"${year ? ` title="${e(year[1])}"` : ''}>${year ? e(year[0]) : ''}</td>`
          + `<td>${s ? `<ul class="dbg-bullets">${s.map(b => `<li>${e(b)}</li>`).join('')}</ul>` : ''}</td></tr>`;
      }).join('');
      const head = [['System', 'Its name: hover for its star and place, click to open it on the Map'], ['Held by', 'The faction that holds it, or what it is'],
        ['People', 'Its people and settlement tier (tools/worlds.py)'], ['Ports', 'Its ports\' economic roles: hover one for what it makes and needs'],
        ['Wealth', 'Wealth, 0 to 100'], ['Security', 'Security, 0 to 100: patrols and law'], ['Unrest', 'Unrest, 0 to 100: how close it is to trouble'],
        ['Year', 'When it was settled (or charted, emptied, lost)'], ['Story', 'Its backstory (tools/stories.py)']];
      const table = `<table class="dbg-grid dbg-planets"><colgroup><col class="c-sys"><col class="c-who"><col class="c-pop"><col class="c-ports"><col class="c-m"><col class="c-m"><col class="c-m"><col class="c-year"><col class="c-story"></colgroup>`
        + `<thead><tr>${head.map(([h, tip], n) => `<th${n === 2 || (n >= 4 && n <= 7) ? ' class="n"' : ''} title="${e(tip)}">${e(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
      const sum = U.regions[k].summary;
      return { id: 'pl-' + k, title: U.regions[k].name, body: (sum && sum.length ? `<ul class="dbg-summary">${sum.map(b => `<li>${e(b)}</li>`).join('')}</ul>` : '') + table };
    });
    const top = `<div class="dbg-head-line"><span><b>Planets</b></span><span>${U.systems.length} systems in ${order.length} regions · ${U.systems.filter(c => c.world).length} settled</span>`
      + `<span>people, ports and wealth from tools/worlds.py · stories from tools/stories.py · a name opens the system on the Map</span></div>`;
    return sections(list, top);
  }
  function mountPlanets(pane) {
    pane.querySelectorAll('.dbg-link[data-star]').forEach(b => { b.onclick = () => { pendingStar = +b.dataset.star; show('map'); }; });
    if (pendingPlanet != null) { // a system picked on the Regions tab
      const row = pane.querySelector(`#dbg-pl-${pendingPlanet}`); pendingPlanet = null;
      if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('dbg-hit'); }
    }
  }

  // ---------- Map: the star map, drawn in the game's canvas behind the tab; its names on a canvas of the tab's own ----------
  let makeMap = null, starMap = null, mapPanel = null;
  const mapLabels = document.createElement('canvas');
  mapLabels.className = 'dbg-map-labels'; mapLabels.hidden = true; el.prepend(mapLabels);
  function mapTab() {
    if (!makeMap) return '<p class="dbg-note">The star map starts with the game.</p>';
    const wait = waitFor('stars.json', 'map');
    if (wait) return wait;
    return `<div class="dbg-map"><div class="dbg-map-surface"></div><aside class="dbg-map-panel sm-panel">${starMapPanelHtml()}</aside></div>`;
  }
  function mountMap(pane) {
    if (!makeMap || !data.has('stars.json')) return;
    if (!starMap) { // built the first time the tab opens: its buffers and shaders are no cost to a game that never looks
      starMap = makeMap(mapLabels, { catalogue: data.peek('stars.json'), universe: U });
      const style = document.createElement('style'); style.textContent = STAR_MAP_PANEL_CSS; document.head.appendChild(style);
    }
    mapPanel = mountStarMapPanel(pane.querySelector('.dbg-map-panel'), starMap, pane.querySelector('.dbg-map-surface'));
    if (pendingStar != null) { // a system picked on the Regions tab
      const i = starMap.stars.findIndex(s => s.id === pendingStar); pendingStar = null;
      if (i >= 0) mapPanel.choose(i, true);
    }
  }
  // the map, for the game's frame to draw (null unless the Map tab is up)
  function mapView() {
    const on = !el.hidden && tab === 'map' && !!starMap;
    mapLabels.hidden = !on;
    if (!on) return null;
    const v = document.getElementById('view');
    if (mapLabels.width !== v.width || mapLabels.height !== v.height) { mapLabels.width = v.width; mapLabels.height = v.height; }
    return starMap;
  }

  const TABS = [{ id: 'content', name: 'Content', render: content, mount: mountLinks, fixed: true }, { id: 'player', name: 'Player', render: player }, { id: 'traffic', name: 'Traffic', render: trafficTab }, { id: 'ships', name: 'Ships', render: ships, mount: mountShips, clear: true }, { id: 'suns', name: 'Suns', render: sunsTab, mount: mountSuns, clear: true }, { id: 'regions', name: 'Regions', render: regionsTab, mount: mountRegions, fixed: true }, { id: 'planets', name: 'Planets', render: planetsTab, mount: mountPlanets, fixed: true }, { id: 'map', name: 'Map', render: mapTab, mount: mountMap, clear: true }];
  let tab = TABS[0].id;
  const cache = new Map();
  function show(id) {
    tab = id;
    el.querySelector('.dbg-tabs').innerHTML = TABS.map(t => `<button type="button" data-tab="${t.id}" aria-pressed="${t.id === tab}">${e(t.name)}</button>`).join('');
    const T = TABS.find(t => t.id === id), pane = el.querySelector('.dbg-pane');
    const key = T.fixed ? `${id}:${current().id}` : id; // content is static: rendered once per system; live tabs every time
    if (!T.fixed || !cache.has(key)) cache.set(key, T.render());
    pane.innerHTML = cache.get(key);
    document.body.classList.toggle('dbg-clear', !!T.clear); // see-through: the game's canvas draws behind this tab, the rest of the page hides
    if (T.mount) T.mount(pane);
    // section links scroll the pane, not the page's hash
    pane.querySelectorAll('.dbg-nav a').forEach(a => { a.onclick = ev => { ev.preventDefault(); pane.querySelector(a.getAttribute('href')).scrollIntoView({ block: 'start' }); }; });
  }
  el.querySelector('.dbg-tabs').onclick = ev => { const b = ev.target.closest('button[data-tab]'); if (b) show(b.dataset.tab); };

  // ---------- the jump box: place@system, either side completing (Tab completes the side the cursor is in; arrows
  // pick, Enter or a click jumps). A side matches a name's start, a word's start, or anywhere in it; a place matches
  // its body's name, its port's name or its id, a system its name or id. With no @, places in the current system
  // come first. A left side of * (or nothing, before an @) lists the systems themselves: one each, arriving over its
  // start port. Places come from the systems the page has read; focusing the box reads every flyable one (jump.prepare).
  let jump = null, jsel = 0, jmatches = [], jlistAsked = false;
  const jin = el.querySelector('#dbg-jump'), jlist = el.querySelector('.dbg-jump-list');
  const norm = v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const score = (q, ...names) => {
    if (!q) return 1;
    let best = 0;
    for (const n of names.map(norm).filter(Boolean)) best = Math.max(best, n.startsWith(q) ? 3 : n.split(/[\s-]/).some(w => w.startsWith(q)) ? 2 : n.includes(q) ? 1 : 0);
    return best;
  };
  function jumpMatches() {
    const [lq, sq] = jin.value.split('@').map(norm), cur = jump.current();
    if (lq === '*' || (lq === '' && sq !== undefined))
      return jump.systems().map(p => ({ p, b: score(sq, p.system, p.sysId) })).filter(m => m.b)
        .sort((x, y) => y.b - x.b || x.p.n - y.p.n).map(m => Object.assign({ any: true }, m.p));
    return jump.places().map(p => ({ p, a: score(lq, p.place, p.port, p.id), b: sq === undefined ? 1 : score(sq, p.system, p.sysId) }))
      .filter(m => m.a && m.b).sort((x, y) => (y.a * 10 + y.b * 2 + (y.p.sysId === cur)) - (x.a * 10 + x.b * 2 + (x.p.sysId === cur)) || x.p.n - y.p.n || x.p.j - y.p.j)
      .slice(0, 12).map(m => m.p);
  }
  function jumpRender() {
    if (!jump) return;
    jmatches = jumpMatches(); jsel = Math.min(jsel, Math.max(0, jmatches.length - 1));
    jlist.innerHTML = jmatches.map((p, i) => `<button type="button" data-i="${i}" class="${i === jsel ? 'sel' : ''}">${p.any
        ? `<b>*</b><span>@${e(p.system)}</span><small class="k">arrive over ${e(p.port || p.place)}</small>`
        : `<b>${e(p.place)}</b>${p.port && p.port !== p.place ? ` <small>${e(p.port)}</small>` : ''}<span>@${e(p.system)}</span><small class="k">${e(p.kind)}</small>`}</button>`).join('')
      || '<p class="dbg-note">Nothing matches</p>';
    jlist.hidden = document.activeElement !== jin || (!jin.value && !jlistAsked); // the list once something is typed, or asked for (down)
  }
  function jumpGo(p) { if (!p) return; Promise.resolve(jump.go(p.sysId, p.j)).then(r => { if (r === 0) { jin.value = ''; jlist.hidden = true; } }); }
  function close() { el.hidden = true; document.body.classList.remove('dbg-clear'); jin.blur(); }
  jin.addEventListener('input', () => { jsel = 0; jumpRender(); });
  jin.addEventListener('focus', () => { jumpRender(); if (jump) jump.prepare().then(() => { if (document.activeElement === jin) jumpRender(); }); });
  jin.addEventListener('blur', () => setTimeout(() => { jlist.hidden = true; jlistAsked = false; }, 150));
  jin.addEventListener('keydown', ev => {
    if (ev.code === 'Backquote' || (ev.key === 'Escape' && !jin.value)) { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { if (jlist.hidden) { jlistAsked = true; jumpRender(); ev.preventDefault(); return; } jsel = (jsel + (ev.key === 'ArrowDown' ? 1 : jmatches.length - 1)) % Math.max(1, jmatches.length); jumpRender(); ev.preventDefault(); }
    else if (ev.key === 'Enter') { jumpGo(jmatches[jsel]); ev.preventDefault(); }
    else if (ev.key === 'Tab') {
      const p = jmatches[jsel]; if (!p) return;
      ev.preventDefault();
      const at = jin.value.indexOf('@');
      jin.value = at < 0 || jin.selectionStart <= at ? `${p.any ? '*' : p.place}@${at < 0 ? '' : jin.value.slice(at + 1)}` : jin.value.slice(0, at + 1) + p.system;
      jsel = 0; jumpRender();
    }
  });
  // the Labs row: one click to a test world (docs/weapons.md), or back to the start system, over its start port; and
  // the side the player fights on in a lab's fight (none, the first or the second: core/src/combat.rs CMD_SIDE)
  el.querySelector('.dbg-labs').addEventListener('click', ev => {
    const sb = ev.target.closest('button[data-side]');
    if (sb && jump) { jump.side(+sb.dataset.side); return; }
    const b = ev.target.closest('button[data-lab]');
    if (!b || !jump) return;
    const id = b.dataset.lab === 'start' ? jump.start() : b.dataset.lab;
    jump.prepare().then(() => { const p = jump.systems().find(s => s.sysId === id); if (p) jumpGo(p); });
  });
  jlist.addEventListener('mousedown', ev => { const b = ev.target.closest('button[data-i]'); if (b) { ev.preventDefault(); jumpGo(jmatches[+b.dataset.i]); } });
  return {
    isOpen: () => !el.hidden,
    open() { show(tab); el.hidden = false; jin.focus(); },
    close,
    setJump(j) { jump = j; }, // { places(), systems(), current(), start(), go(system id, j), prepare(), side(s) }, bound once the core has loaded
    setLive(fn) { live = fn; }, // the Player tab's source, bound once the core has loaded
    setYard(y) { yard = y; },
    yardView,
    setSuns(g) { gallery = g; }, // the Suns tab's gallery (src/play/suns.js), bound once the game's GL is up
    sunView,
    setStarMap(f) { makeMap = f; }, // labels canvas -> the star map (makeStarMap), bound once the game's GL is up
    mapView
  };
}
