// Boots index.html's app script against a stub WebGL2 context, captures every shader it compiles, adds the star kit's
// (src/stars.js: the game and its debug screen draw stars, the lab no longer does), and validates each with
// glslangValidator. Usage: npm run check (after npm run build)
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process'), os = require('os');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const grab = id => html.split(`<script id="${id}"`)[1].split('>').slice(1).join('>').split('</script>')[0];
const catalogTxt = grab('catalog'), genTxt = grab('gen'), coreTxt = grab('core-wasm'), schemaTxt = grab('system-schema');
const app = html.split('<script>').pop().split('</script>')[0];
const U = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : k === 'length' ? 0 : U, apply: () => U, construct: () => U, set: () => true });
const shaders = [], consts = {}; let n = 0;
const gl = new Proxy({}, { get: (t, k) => {
  if (k === 'getExtension') return () => ({});
  if (k === 'createShader') return type => ({ type });
  if (k === 'shaderSource') return (sh, src) => { sh.src = src; };
  if (k === 'compileShader') return sh => { shaders.push(sh); };
  if (k === 'getShaderParameter') return () => true;
  if (k === 'getProgramParameter') return (p, pn) => pn === consts.ACTIVE_UNIFORMS ? 0 : true;
  if (k === 'checkFramebufferStatus') return () => consts.FRAMEBUFFER_COMPLETE;
  if (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k)) return consts[k] || (consts[k] = ++n + 1000);
  return () => U;
} });
const canvasEl = new Proxy({}, { get: (t, k) => k === 'getContext' ? () => gl : k === 'getBoundingClientRect' ? () => ({ width: 800, height: 600, left: 0, top: 0 }) : U, set: () => true });
global.document = { getElementById: id => id === 'catalog' ? { textContent: catalogTxt } : id === 'gen' ? { textContent: genTxt } : id === 'core-wasm' ? { textContent: coreTxt } : id === 'system-schema' ? { textContent: schemaTxt } : id === 'view' ? canvasEl : U, querySelectorAll: () => [], createElement: () => U };
global.window = { addEventListener() {}, devicePixelRatio: 1 };
global.navigator = { hardwareConcurrency: 2 };
global.ResizeObserver = function () { return { observe() {} }; };
global.Worker = function () { return { postMessage() {} }; };
global.Blob = function () {}; global.URL = { createObjectURL: () => 'blob:x' };
global.requestAnimationFrame = () => {}; global.performance = { now: () => 0 };
global.self = global;
const errs = []; console.error = e => errs.push(String((e && e.message) || e));
eval(genTxt); global.ShipGen = global.ShipGen || require('../src/gen.js'); // in Node, gen.js exports rather than setting ShipGen
eval(app);
(async () => {
await window.__flyReady; // flight mode compiles its shaders once the sim core has loaded
if (!window.__fly) errs.push('flight mode did not start');
{ // the star kit's shaders, built from the shared chunks as the pages build them
  const src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  const S = new Function(src('shaders.js') + src('stars.js').replace(/\nif \(typeof module[\s\S]*$/, '') + '\nreturn STAR_SHADERS();')();
  shaders.push({ type: consts.VERTEX_SHADER, src: S.vs }, { type: 0, src: S.fs }, { type: 0, src: S.hole }, { type: 0, src: S.flare });
}
const bin = path.join(__dirname, '..', 'node_modules', 'glslang-validator-prebuilt-predownloaded', 'bin', 'glslangValidator.' + (process.platform === 'win32' ? 'exe' : process.platform));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driftward-'));
let bad = 0;
shaders.forEach((s, i) => {
  const f = path.join(dir, `s${i}.${s.type === consts.VERTEX_SHADER ? 'vert' : 'frag'}`);
  fs.writeFileSync(f, s.src);
  try { execFileSync(bin, [f], { stdio: 'pipe' }); } catch (e) { bad++; console.log(`shader ${i} failed:\n${e.stdout}`); }
});
console.log(`${shaders.length} shaders, ${bad} invalid, ${errs.length} init errors${errs.length ? ': ' + errs.join('; ') : ''}`);
process.exit(bad || errs.length ? 1 : 0);
})();
