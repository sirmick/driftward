// Dev client: injected by tools/dev.js into every page it serves (never into the built pages themselves).
// - Live reload: the server's 'reload' event reloads the page; 'fail' logs the build's errors.
// - Logs: console.log/info/warn/error and uncaught errors go to the server too (POST /__log, batched), which keeps
//   them in .dev/frontend.log with this page's id.
// - State reports: the Send state button (or = or F8), or the server's 'snapshot' event (GET /__ask), sends a report
//   (POST /__report): a screenshot of every canvas (and the vista) on screen as composited (the page's HTML, such as
//   the port card, is not in it: browsers can't draw it without asking), the recent log, the screen and GPU, and
//   whatever the page adds (the game's window.__play.report(): its probe, jitter, traffic, a save and a replay log).
(() => {
  const PAGE = (location.pathname.replace(/^\/|\.html$/g, '') || 'index') + '-' + Math.random().toString(36).slice(2, 6);
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: body.length < 60000 }).catch(() => {});

  // ---------- logs ----------
  const tail = [], queue = [];
  const fmt = a => a instanceof Error ? (a.stack || String(a)) : typeof a === 'object' && a !== null ? (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })() : String(a);
  function log(level, args) {
    const e = { t: Date.now(), level, msg: Array.from(args, fmt).join(' ').slice(0, 4000) };
    tail.push(e); if (tail.length > 300) tail.shift();
    queue.push(e);
  }
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { orig(...args); log(level, args); };
  }
  addEventListener('error', e => log('error', [`uncaught: ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`, e.error || '']));
  addEventListener('unhandledrejection', e => log('error', ['unhandled rejection:', e.reason]));
  setInterval(() => { if (queue.length) post('/__log', { page: PAGE, entries: queue.splice(0) }); }, 1000);

  // ---------- screenshot: every visible canvas, stacked as on screen, read right after the page's own frame ----------
  function capture() {
    return new Promise(done => requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1, out = document.createElement('canvas');
      out.width = Math.round(innerWidth * dpr); out.height = Math.round(innerHeight * dpr);
      const c = out.getContext('2d');
      c.fillStyle = '#000'; c.fillRect(0, 0, out.width, out.height);
      for (const el of document.querySelectorAll('canvas, img#vista')) {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        if (!r.width || !r.height || cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0 || el.closest('[hidden]')) continue;
        try { c.globalAlpha = +cs.opacity || 1; c.drawImage(el, r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr); } catch (e) { /* a tainted or unready image */ }
      }
      c.globalAlpha = 1;
      done(out.toDataURL('image/png'));
    }));
  }
  function gpuInfo() {
    try {
      const gl = document.createElement('canvas').getContext('webgl2'), x = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return gl ? { vendor: gl.getParameter(x ? x.UNMASKED_VENDOR_WEBGL : gl.VENDOR), renderer: gl.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : gl.RENDERER) } : null;
    } catch (e) { return null; }
  }

  // ---------- reports ----------
  let busy = false;
  async function report(reason, ask) {
    if (busy) return; busy = true;
    try {
      flash('Sending state…');
      const r = { page: PAGE, reason, ask: ask || null, url: location.href, time: new Date().toISOString(), userAgent: navigator.userAgent,
        screen: { w: innerWidth, h: innerHeight, dpr: window.devicePixelRatio || 1, screenW: screen.width, screenH: screen.height }, gpu: gpuInfo() };
      try { if (window.__play && window.__play.report) Object.assign(r, await window.__play.report()); } catch (e) { r.pageReportError = String(e && e.stack || e); }
      r.screenshot = await capture();
      r.log = tail.slice();
      const res = await fetch('/__report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) });
      flash(res.ok ? `State sent: ${(await res.json()).dir}` : 'Sending state failed');
    } catch (e) { flash('Sending state failed: ' + e); }
    busy = false;
  }

  // ---------- the button, F8, and the server's requests ----------
  let note = null;
  function flash(text) {
    if (!note) { note = document.createElement('div'); note.style.cssText = 'position:fixed;right:12px;bottom:52px;z-index:99999;padding:6px 10px;border-radius:6px;background:rgba(7,9,12,.9);border:1px solid #2a3340;color:#dbe0e7;font:500 12px ui-monospace,monospace;pointer-events:none;transition:opacity .4s'; document.body.appendChild(note); }
    note.textContent = text; note.style.opacity = 1; clearTimeout(note.t); note.t = setTimeout(() => { note.style.opacity = 0; }, 3500);
  }
  addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('button');
    b.textContent = 'Send state (=)'; b.title = 'Send this page’s state to the dev server: a screenshot, the log, and the game’s state, jitter probe and replay (= or F8)';
    b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;z-index:99999;padding:4px 9px;border-radius:6px;border:1px solid #2a3340;background:rgba(7,9,12,.75);color:#8fd3ff;font:600 11px ui-monospace,monospace;cursor:pointer;opacity:.6';
    b.onmouseenter = () => { b.style.opacity = 1; }; b.onmouseleave = () => { b.style.opacity = .6; };
    b.onclick = e => { e.preventDefault(); b.blur(); report('button'); };
    document.body.appendChild(b);
  });
  // = (or F8) sends a report. Under the dev server = is taken from the game's keyboard zoom-in (the wheel and numpad +
  // still zoom); typing in a field is left alone
  addEventListener('keydown', e => {
    if ((e.code !== 'Equal' && e.code !== 'F8') || e.repeat || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    e.preventDefault(); e.stopImmediatePropagation(); report(e.code === 'F8' ? 'F8' : 'key =');
  }, true);
  const es = new EventSource('/__events');
  es.addEventListener('hello', () => post('/__log', { page: PAGE, entries: [{ t: Date.now(), level: 'info', msg: `page open: ${location.href} ${innerWidth}x${innerHeight} @${window.devicePixelRatio || 1}` }] }));
  es.addEventListener('reload', () => location.reload());
  es.addEventListener('fail', e => console.error('driftward build failed:\n' + JSON.parse(e.data)));
  es.addEventListener('snapshot', e => report('server', JSON.parse(e.data)));
})();
