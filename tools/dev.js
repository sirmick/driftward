// Dev server: serves the lab (index.html) and the game (play.html), rebuilds when src/ or core/ changes (the Rust core only when core/ changed),
// and live-reloads open pages. Usage: npm run dev   (PORT=8000 and HOST=0.0.0.0, all interfaces, by default)
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const root = path.join(__dirname, '..');
const PORT = +process.env.PORT || 8000, HOST = process.env.HOST || '0.0.0.0';
const clients = new Set();
const SNIPPET = `<script>(() => { const es = new EventSource('/__events');
  es.addEventListener('reload', () => location.reload());
  es.addEventListener('fail', e => console.error('driftward build failed:\\n' + JSON.parse(e.data))); })();</script>`;

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

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res); req.on('close', () => clients.delete(res));
    return;
  }
  // any built page in the repo root: / is the lab, /play or /play.html the game (new pages need no route here)
  const name = url === '/' ? 'index' : url.slice(1).replace(/\.html$/, '');
  const pageFile = /^[a-z0-9-]+$/.test(name) && fs.existsSync(path.join(root, name + '.html')) ? name + '.html' : null;
  if (pageFile) {
    fs.readFile(path.join(root, pageFile), 'utf8', (err, html) => {
      if (err) { res.writeHead(500); res.end(String(err)); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html + SNIPPET);
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
