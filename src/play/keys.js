// ======================= KEYS =======================
// The game's key bindings: every action a key can do, where it applies, and its default keys; the player's own, kept
// in this browser, exported and imported as JSON; and the Keys dialog (Settings) that rebinds them.
//
// A binding is a KeyboardEvent code ('KeyT', 'ArrowUp', 'F6', 'ShiftLeft'), or 'Shift+' and a code for the shifted
// key. An action applies in a context: 'held' (flight controls read every tick while down), 'flight' (flying),
// 'space' (anywhere but in port), 'port' (landed), or 'any'. A press matches a shifted binding first; failing that a
// plain one matches with Shift up or down (so J jumps while Shift holds the burner). Escape (back, pause), 1 to 9 (the
// location list) and backquote (the debug screen) are fixed.
const KEY_ACTIONS = [
  // flight controls, read every tick while held
  { id: 'thrust', group: 'Flight controls', ctx: 'held', label: 'Throttle up (assist) / thrust', keys: ['KeyW', 'ArrowUp'] },
  { id: 'reverse', group: 'Flight controls', ctx: 'held', label: 'Throttle down (assist) / reverse', keys: ['KeyS', 'ArrowDown'] },
  { id: 'left', group: 'Flight controls', ctx: 'held', label: 'Turn left', keys: ['KeyA', 'ArrowLeft'] },
  { id: 'right', group: 'Flight controls', ctx: 'held', label: 'Turn right', keys: ['KeyD', 'ArrowRight'] },
  { id: 'strafeL', group: 'Flight controls', ctx: 'held', label: 'Strafe left (drift, free)', keys: ['KeyQ'] },
  { id: 'strafeR', group: 'Flight controls', ctx: 'held', label: 'Strafe right (drift, free)', keys: ['KeyE'] },
  { id: 'burn', group: 'Flight controls', ctx: 'held', label: 'Burner', keys: ['ShiftLeft', 'ShiftRight'] },
  { id: 'retro', group: 'Flight controls', ctx: 'held', label: 'All stop (assist) / face backward', keys: ['KeyX'] },
  { id: 'fire', group: 'Flight controls', ctx: 'held', label: 'Fire', keys: ['Space'] },
  { id: 'missile', group: 'Flight controls', ctx: 'held', label: 'Launch missiles at the target', keys: ['KeyZ'] },
  // flight
  { id: 'mode', group: 'Flight', ctx: 'space', label: 'Next flight mode', keys: ['KeyF'] },
  { id: 'screenNext', group: 'Targets', ctx: 'flight', label: 'Next ship on screen', keys: ['Tab'] },
  { id: 'screenPrev', group: 'Targets', ctx: 'flight', label: 'Previous ship on screen', keys: ['Shift+Tab'] },
  { id: 'targetNext', group: 'Targets', ctx: 'flight', label: 'Next identified ship', keys: ['KeyT'] },
  { id: 'targetPrev', group: 'Targets', ctx: 'flight', label: 'Previous identified ship', keys: ['Shift+KeyT'] },
  { id: 'unknownNext', group: 'Targets', ctx: 'flight', label: 'Next unknown contact', keys: ['KeyY'] },
  { id: 'unknownPrev', group: 'Targets', ctx: 'flight', label: 'Previous unknown contact', keys: ['Shift+KeyY'] },
  { id: 'hostile', group: 'Targets', ctx: 'flight', label: 'Nearest hostile (for now: tracking you)', keys: ['KeyH'] },
  { id: 'placeNext', group: 'Targets', ctx: 'flight', label: 'Next destination (planet, station, jump zone)', keys: ['KeyR'] },
  { id: 'placePrev', group: 'Targets', ctx: 'flight', label: 'Previous destination', keys: ['Shift+KeyR'] },
  { id: 'zoneNext', group: 'Targets', ctx: 'flight', label: 'The course\u2019s next jump zone', keys: ['KeyK'] },
  { id: 'autopilot', group: 'Flight', ctx: 'flight', label: 'Autopilot to the destination', keys: ['KeyG'] },
  { id: 'land', group: 'Flight', ctx: 'any', label: 'Land, dock or launch', keys: ['KeyL'] },
  { id: 'jump', group: 'Flight', ctx: 'any', label: 'Jump (in a lane’s zone); chain', keys: ['KeyJ'] },
  { id: 'skip', group: 'Flight', ctx: 'any', label: 'Skip a landing or launch', keys: ['Enter'] },
  { id: 'cold', group: 'Flight', ctx: 'flight', label: 'Run cold', keys: ['KeyC'] },
  { id: 'ping', group: 'Flight', ctx: 'flight', label: 'Sensor ping', keys: ['KeyV'] },
  { id: 'galaxy', group: 'Flight', ctx: 'flight', label: 'Galaxy map', keys: ['KeyM'] },
  { id: 'systemMap', group: 'Flight', ctx: 'flight', label: 'System map', keys: ['Shift+KeyM'] },
  { id: 'nav', group: 'Flight', ctx: 'space', label: 'Navigation overlay', keys: ['KeyI'] },
  // in port
  { id: 'trade', group: 'In port', ctx: 'port', label: 'Market', keys: ['KeyT'] },
  { id: 'missions', group: 'In port', ctx: 'port', label: 'Missions', keys: ['KeyM'] },
  { id: 'bar', group: 'In port', ctx: 'port', label: 'Bar', keys: ['KeyB'] },
  { id: 'about', group: 'In port', ctx: 'port', label: 'About the port', keys: ['KeyI'] },
  { id: 'outfit', group: 'In port', ctx: 'port', label: 'Outfitter', keys: ['KeyO'] },
  { id: 'refuel', group: 'In port', ctx: 'port', label: 'Refuel', keys: ['KeyF'] },
  { id: 'repair', group: 'In port', ctx: 'port', label: 'Repair', keys: ['KeyR'] },
  { id: 'wait', group: 'In port', ctx: 'port', label: 'Wait a day', keys: ['KeyW'] },
  { id: 'portMap', group: 'In port', ctx: 'port', label: 'Galaxy map', keys: ['KeyG'] },
  // anywhere
  { id: 'pause', group: 'General', ctx: 'any', label: 'Pause', keys: ['KeyP'] },
  { id: 'save', group: 'General', ctx: 'any', label: 'Save', keys: ['F6'] },
  { id: 'load', group: 'General', ctx: 'any', label: 'Load', keys: ['F9'] },
  { id: 'zoomIn', group: 'General', ctx: 'any', label: 'Zoom in', keys: ['Equal', 'NumpadAdd'] },
  { id: 'zoomOut', group: 'General', ctx: 'any', label: 'Zoom out', keys: ['Minus', 'NumpadSubtract'] },
  // debugging
  { id: 'bloom', group: 'Debugging', ctx: 'space', label: 'Bloom on or off', keys: ['KeyB'] },
  { id: 'nanView', group: 'Debugging', ctx: 'any', label: 'Bad-pixel view', keys: ['KeyN'] },
  { id: 'jitter', group: 'Debugging', ctx: 'any', label: 'Jitter probe', keys: ['Shift+KeyJ'] }
];
const KEY_FIXED = [['Esc', 'Back, then pause'], ['1 to 9', 'Pick from the location list'], ['`', 'Debug screen']];
const KEY_RESERVED = new Set(['Escape', 'Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9']);
const KEY_STORE = 'driftward.keys', KEY_FORMAT = 'driftward-keys';
const KEY_NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ShiftLeft: 'Shift', ShiftRight: 'Right Shift', ControlLeft: 'Ctrl',
  ControlRight: 'Right Ctrl', AltLeft: 'Alt', AltRight: 'Right Alt', Equal: '=', Minus: '-', NumpadAdd: 'Num +', NumpadSubtract: 'Num -', Backquote: '`', BracketLeft: '[',
  BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace' };

// A code or binding as the player reads it: 'Shift+KeyT' is 'Shift+T'
function keyName(b) {
  if (!b) return '';
  const shift = b.startsWith('Shift+'), code = shift ? b.slice(6) : b;
  const n = KEY_NAMES[code] || code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
  return (shift ? 'Shift+' : '') + n;
}

function makeKeys() {
  const byId = new Map(KEY_ACTIONS.map(a => [a.id, a]));
  const defaults = () => Object.fromEntries(KEY_ACTIONS.map(a => [a.id, a.keys.slice()]));
  const valid = b => typeof b === 'string' && /^(Shift\+)?[A-Za-z][A-Za-z0-9]*$/.test(b) && !KEY_RESERVED.has(b.replace(/^Shift\+/, ''));
  // bindings from a parsed file or the store: known actions, valid bindings, at most two each; the rest noted
  function clean(map, notes) {
    const out = defaults();
    for (const [id, list] of Object.entries(map || {})) {
      if (!byId.has(id)) { notes.push(`unknown action ${id}`); continue; }
      if (!Array.isArray(list)) { notes.push(`${id}: not a list`); continue; }
      const ok = list.filter(b => valid(b) || (notes.push(`${id}: ${b} is not a key the game can bind`), false));
      out[id] = [...new Set(ok)].slice(0, 2);
    }
    return out;
  }
  // version 2 moved Tab from the flight mode to the ships on screen: an older map loses Tab from the mode
  function migrate(raw) {
    const b = raw && raw.bindings;
    if (b && (raw.version || 1) < 2 && Array.isArray(b.mode)) b.mode = b.mode.filter(k => k !== 'Tab');
    return b;
  }
  let binds = (() => { try { return clean(migrate(JSON.parse(localStorage.getItem(KEY_STORE) || 'null')), []); } catch (e) { return defaults(); } })();
  const save = () => localStorage.setItem(KEY_STORE, JSON.stringify({ format: KEY_FORMAT, version: 2, bindings: binds }));

  // contexts that can both be live at once (a binding shared between them is a conflict)
  const LIVE = { held: ['held', 'flight', 'space', 'any'], flight: ['held', 'flight', 'space', 'any'], space: ['held', 'flight', 'space', 'any'], port: ['port', 'any'], any: ['held', 'flight', 'space', 'port', 'any'] };
  const overlap = (a, b) => LIVE[a].includes(b);
  function conflicts(id, b) {
    const A = byId.get(id);
    return KEY_ACTIONS.filter(o => o.id !== id && overlap(A.ctx, o.ctx) && binds[o.id].includes(b)).map(o => o.label);
  }

  // the actions a press triggers, given which contexts are live: shifted bindings first, then plain ones
  function pressed(e, live) {
    const code = e.code, cands = KEY_ACTIONS.filter(a => a.ctx !== 'held' && live(a.ctx));
    if (e.shiftKey) { const s = cands.filter(a => binds[a.id].includes('Shift+' + code)); if (s.length) return s.map(a => a.id); }
    return cands.filter(a => binds[a.id].includes(code)).map(a => a.id);
  }
  // whether a held action is down, from the set of codes held
  function held(id, down) {
    const shift = down.has('ShiftLeft') || down.has('ShiftRight');
    return binds[id].some(b => b.startsWith('Shift+') ? shift && down.has(b.slice(6)) : down.has(b));
  }
  const name = id => keyName((binds[id] || [])[0]) || '—';
  const names = id => (binds[id] || []).map(keyName).join(' or ') || 'unbound';

  // export: the whole map, as a file the browser downloads; import: a file the player picks
  function exportFile() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ format: KEY_FORMAT, version: 2, bindings: binds }, null, 2)], { type: 'application/json' }));
    a.download = 'driftward-keys.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function importText(text) {
    let raw; try { raw = JSON.parse(text); } catch (e) { return { ok: false, notes: ['not JSON'] }; }
    if (!raw || raw.format !== KEY_FORMAT || typeof raw.bindings !== 'object') return { ok: false, notes: [`not a ${KEY_FORMAT} file`] };
    const notes = []; binds = clean(migrate(raw), notes); save();
    return { ok: true, notes };
  }

  // ---------- the dialog ----------
  // el: the dialog's section; onChange: after any change (the page re-reads its hints); toast: messages
  let capture = null, el = null, onChange = () => {}, toast = () => {};
  function render() {
    if (!el) return;
    const groups = [...new Set(KEY_ACTIONS.map(a => a.group))];
    const slot = (a, k) => {
      const b = binds[a.id][k], c = b ? conflicts(a.id, b) : [], cap = capture && capture.id === a.id && capture.slot === k;
      return `<button type="button" class="key${c.length ? ' clash' : ''}${cap ? ' cap' : ''}" data-id="${a.id}" data-slot="${k}"${c.length ? ` title="Also: ${c.join(', ')}"` : ''}>${cap ? 'press a key…' : b ? keyName(b) : '—'}</button>`;
    };
    el.querySelector('.keys-list').innerHTML = groups.map(g => `<h4>${g}</h4>` + KEY_ACTIONS.filter(a => a.group === g).map(a =>
      `<div class="key-row"><span>${a.label}</span>${slot(a, 0)}${slot(a, 1)}</div>`).join('')).join('')
      + `<h4>Fixed</h4>` + KEY_FIXED.map(([k, l]) => `<div class="key-row fixed"><span>${l}</span><b>${k}</b></div>`).join('');
  }
  function attach(section, opts) {
    el = section; onChange = opts.onChange || onChange; toast = opts.toast || toast;
    el.querySelector('.keys-list').addEventListener('click', e => {
      const b = e.target.closest('button.key'); if (!b) return;
      capture = { id: b.dataset.id, slot: +b.dataset.slot }; render();
    });
    el.querySelector('[data-act=reset]').onclick = () => { binds = defaults(); save(); capture = null; render(); onChange(); toast('Keys back to their defaults'); };
    el.querySelector('[data-act=export]').onclick = () => exportFile();
    const file = el.querySelector('input[type=file]');
    el.querySelector('[data-act=import]').onclick = () => file.click();
    file.onchange = () => {
      const f = file.files[0]; if (!f) return;
      f.text().then(t => { const r = importText(t); file.value = ''; render(); onChange();
        toast(r.ok ? `Keys imported${r.notes.length ? ` (${r.notes.length} skipped: ${r.notes.slice(0, 3).join('; ')})` : ''}` : `Can't import: ${r.notes[0]}`); });
    };
    // while a slot waits for its key, the key goes to it (before the game sees it): Esc cancels, Backspace or Delete
    // clears; a lone Shift waits for the key it modifies (unless the action is held, where Shift itself can be the key)
    window.addEventListener('keydown', e => {
      if (!capture) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const A = byId.get(capture.id), code = e.code;
      if (code === 'Escape') { capture = null; render(); return; }
      if (code === 'Backspace' || code === 'Delete') { binds[A.id].splice(capture.slot, 1); capture = null; save(); render(); onChange(); return; }
      const mod = /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code);
      if (mod && A.ctx !== 'held') return;
      const b = !mod && e.shiftKey && A.ctx !== 'held' ? 'Shift+' + code : code;
      if (!valid(b)) { toast(`${keyName(code)} is kept for ${KEY_FIXED.map(f => f[0]).join(', ')}`); capture = null; render(); return; }
      const list = binds[A.id].slice(); list[capture.slot] = b; binds[A.id] = [...new Set(list.filter(Boolean))].slice(0, 2);
      capture = null; save(); render(); onChange();
    }, true);
    render();
  }
  const capturing = () => !!capture;
  return { pressed, held, name, names, keyName, attach, render, capturing, exportFile, importText, bindings: () => JSON.parse(JSON.stringify(binds)) };
}
