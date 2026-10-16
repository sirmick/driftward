// Dev server: serves the lab (index.html) and the game (play.html), rebuilds when src/ or core/ changes (the Rust core only when core/ changed),
// and live-reloads open pages. Usage: npm run dev   (PORT=8000 and HOST=0.0.0.0, all interfaces, by default)
// Each page it serves gets tools/dev-client.js, which also:
// - sends the page's console and uncaught errors here (POST /__log), kept in .dev/frontend.log (errors echo below);
// - sends a state report (POST /__report) from its Send state button or F8, kept in .dev/reports/<time>-<page>/:
//   report.json, screen.png, and for the game save.bin and inputs.txt (a replay: node core replay, see README);
// - answers GET /__ask (curl localhost:8000/__ask), which asks every open page for a report, waits for them (up to
//   ?wait= seconds, default 20) and replies with where they landed.
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const root = path.join(__dirname, '..');
const PORT = +process.env.PORT || 8000, HOST = process.env.HOST || '0.0.0.0';
const clients = new Set();
const DEV = path.join(root, '.dev'), REPORTS = path.join(DEV, 'reports'), FELOG = path.join(DEV, 'frontend.log');
fs.mkdirSync(REPORTS, { recursive: true });
// the client goes first in the page (after a doctype), so it hears the page's own console from the start
const snippet = () => `<script>${fs.readFileSync(path.join(__dirname, 'dev-client.js'), 'utf8')}</script>`;
const inject = html => { const m = html.match(/^\s*<!doctype html>/i); return m ? m[0] + snippet() + html.slice(m[0].length) : snippet() + html; };

function send(event, data) { for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

let building = false, again = null;
function build(withCore) {
  if (building) { again = again || withCore; return; } // coalesce changes made during a build
  building = true;
  const t0 = Date.now(), args = [path.join(root, 'tools', 'build.py')].concat(withCore ? [] : ['--skip-core']);
  const p = spawn('python3', args, { cwd: root });
  let out = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  p.on('close', code => {
    building = false;
    if (code === 0) { console.log(`[dev] built in ${Date.now() - t0} ms${withCore ? ' (with core)' : ''}; reloading ${clients.size} page(s)`); send('reload', Date.now()); }
    else { console.error(`[dev] build failed:\n${out}`); send('fail', out); }
    if (again !== null) { const c = again; again = null; build(c); }
  });
}

let timer = null, pendingCore = false;
function changed(isCore) {
  pendingCore = pendingCore || isCore;
  clearTimeout(timer);
  timer = setTimeout(() => { const c = pendingCore; pendingCore = false; build(c); }, 120);
}
fs.watch(path.join(root, 'src'), { recursive: true }, () => changed(false));
fs.watch(path.join(root, 'core', 'src'), { recursive: true }, () => changed(true));
fs.watch(path.join(root, 'core', 'Cargo.toml'), () => changed(true));
fs.watch(path.join(root, 'tools', 'build.py'), () => changed(false));
// the build lists the art it finds and inlines its log, so new or redone images rebuild too
fs.mkdirSync(path.join(root, 'art'), { recursive: true });
fs.watch(path.join(root, 'art'), { recursive: true }, (ev, f) => { if (f && (f.endsWith('.webp') || f.endsWith('log.json')) && !f.includes('raw')) changed(false); });

// a request body as JSON (reports carry a screenshot, so allow plenty)
function body(req, done) {
  const parts = []; let n = 0;
  req.on('data', d => { n += d.length; if (n < 200e6) parts.push(d); });
  req.on('end', () => { try { done(null, JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { done(e); } });
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj, null, 1) + '\n'); };
// reports the server asked for, by request id: who answered, and the replies waiting on them
const asks = new Map();
function saveReport(r) {
  const dir = path.join(REPORTS, `${stamp()}-${String(r.page).replace(/[^a-z0-9-]/gi, '')}`);
  fs.mkdirSync(dir, { recursive: true });
  const { screenshot, save, inputs, ...rest } = r;
  if (screenshot) fs.writeFileSync(path.join(dir, 'screen.png'), Buffer.from(screenshot.split(',')[1], 'base64'));
  if (save) fs.writeFileSync(path.join(dir, 'save.bin'), Buffer.from(save, 'base64'));
  if (inputs) fs.writeFileSync(path.join(dir, 'inputs.txt'), inputs);
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(rest, null, 1));
  return path.relative(root, dir);
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0], query = new URLSearchParams(req.url.split('?')[1] || '');
  if (url === '/__events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\nevent: hello\ndata: {}\n\n');
    clients.add(res); req.on('close', () => clients.delete(res));
    return;
  }
  if (url === '/__log' && req.method === 'POST') {
    body(req, (err, b) => {
      if (err) return json(res, 400, { error: String(err) });
      const lines = (b.entries || []).map(e => `${new Date(e.t).toISOString()} ${String(e.level).padEnd(5)} [${b.page}] ${e.msg}`);
      fs.appendFile(FELOG, lines.join('\n') + '\n', () => {});
      for (const l of lines) if (/ (error|warn) /.test(l)) console.log('[page] ' + l);
      json(res, 200, { ok: true });
    });
    return;
  }
  if (url === '/__report' && req.method === 'POST') {
    body(req, (err, r) => {
      if (err) return json(res, 400, { error: String(err) });
      const dir = saveReport(r);
      console.log(`[dev] state report from ${r.page} (${r.reason}): ${dir}`);
      const a = r.ask && asks.get(r.ask.id);
      if (a) { a.got.push(dir); if (a.got.length >= a.want) a.finish(); }
      json(res, 200, { dir });
    });
    return;
  }
  if (url === '/__ask') {
    // ask every open page for a state report, and reply once they have all sent one (or the wait runs out)
    const id = Math.random().toString(36).slice(2, 10), want = clients.size, wait = Math.min(120, +query.get('wait') || 20);
    if (!want) return json(res, 200, { asked: 0, reports: [], note: 'no pages open' });
    const a = { want, got: [], finish: () => { clearTimeout(a.timer); asks.delete(id); json(res, 200, { asked: want, reports: a.got.map(d => ({ dir: d, files: fs.readdirSync(path.join(root, d)) })) }); } };
    a.timer = setTimeout(a.finish, wait * 1000);
    asks.set(id, a);
    send('snapshot', { id, note: query.get('note') || '' });
    return;
  }
  // any built page in the repo root: / is the lab, /play or /play.html the game (new pages need no route here)
  const name = url === '/' ? 'index' : url.slice(1).replace(/\.html$/, '');
  const pageFile = /^[a-z0-9-]+$/.test(name) && fs.existsSync(path.join(root, name + '.html')) ? name + '.html' : null;
  if (pageFile) {
    fs.readFile(path.join(root, pageFile), 'utf8', (err, html) => {
      if (err) { res.writeHead(500); res.end(String(err)); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(inject(html));
    });
    return;
  }
  // the ports' vistas and portraits (tools/gen-content.js), which the game loads from art/ beside it
  const art = url.match(/^\/art\/([a-z0-9-]+)\/([a-z0-9-]+\.webp)$/);
  if (art) {
    fs.readFile(path.join(root, 'art', art[1], art[2]), (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, HOST, () => {
  const hosts = HOST !== '0.0.0.0' ? [HOST] : [require('os').hostname()].concat(
    Object.values(require('os').networkInterfaces()).flat().filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address));
  console.log(`[dev] serving on ${hosts.map(h => `http://${h}:${PORT}/`).join('  ')}  (lab at /, game at /play.html; watching src/ and core/)`);
});

build(true);
