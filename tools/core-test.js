// Sim core tests: the crate's native unit tests, then the cross-target determinism check. The WASM inlined in
// index.html and a native build each run the shared scripted scenario; their state hashes must match bit for bit.
// Usage: npm test (after npm run build)
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const root = path.join(__dirname, '..'), core = path.join(root, 'core');
// prefer rustup's cargo over a distro one earlier on PATH (see tools/build.py)
const rustupCargo = path.join(require('os').homedir(), '.cargo', 'bin', 'cargo');
const CARGO = fs.existsSync(rustupCargo) ? rustupCargo : 'cargo';
// cargo's own directory first on PATH, so it runs rustup's rustc, not a distro one; and honour
// core/rust-toolchain.toml over a RUSTUP_TOOLCHAIN left in the shell (see tools/build.py)
const env = { ...process.env, PATH: path.dirname(CARGO) + path.delimiter + (process.env.PATH || '') }; delete env.RUSTUP_TOOLCHAIN;
const run = (args, opts = {}) => execFileSync(CARGO, args, { cwd: core, encoding: 'utf8', env, ...opts });

run(['test', '--quiet'], { stdio: 'inherit' });

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const b64 = html.split('<script id="core-wasm"')[1].split('>').slice(1).join('>').split('</script>')[0].trim();
(async () => {
  const { instance } = await WebAssembly.instantiate(Buffer.from(b64, 'base64'), {});
  const wasmHash = (seed, ticks) => BigInt.asUintN(64, instance.exports.dw_scenario(seed, ticks)).toString(16).padStart(16, '0');
  run(['build', '--release', '--quiet', '--bin', 'scenario'], { stdio: 'inherit' });
  let bad = 0;
  for (const [seed, ticks] of [[1, 600], [7, 3600], [99, 7200], [123456, 1800]]) {
    const native = run(['run', '--release', '--quiet', '--bin', 'scenario', '--', String(seed), String(ticks)]).trim();
    const wasm = wasmHash(seed, ticks), ok = native === wasm;
    if (!ok) bad++;
    console.log(`scenario seed ${seed}, ${ticks} ticks: native ${native} wasm ${wasm} ${ok ? 'match' : 'MISMATCH'}`);
  }
  // save and replay across targets: play a session in WASM from a snapshot, recording input changes, then have
  // the native replay binary rerun the snapshot and log; both must land on the same state
  const X = instance.exports, os = require('os');
  const w = X.dw_scenario_world(11);
  X.dw_set_player(w, 0);
  const manifest = () => JSON.parse(Buffer.from(X.memory.buffer, X.dw_manifest_ptr(w), X.dw_manifest_len(w)).toString());
  const snapCol = manifest().columns.find(c => c.group === 'world' && c.name === 'snapshot');
  const start = Buffer.from(new Uint8Array(X.memory.buffer, snapCol.ptr, X.dw_save(w)));
  const script = { 0: 512 | 1, 120: 512 | 1 | 64, 300: 512 | 4, 480: 1 | 256, 700: 1, 900: 512 | 2 };
  const log = [], TICKS = 1200;
  for (let t = 0; t < TICKS; t++) {
    if (script[t] !== undefined) { X.dw_set_input(w, script[t]); log.push(`${X.dw_tick(w)} ${script[t]}`); }
    X.dw_step(w);
  }
  const wasmEnd = BigInt.asUintN(64, X.dw_hash(w)).toString(16).padStart(16, '0');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driftward-replay-'));
  fs.writeFileSync(path.join(dir, 'save.bin'), start);
  fs.writeFileSync(path.join(dir, 'inputs.txt'), log.join('\n') + '\n');
  run(['build', '--release', '--quiet', '--bin', 'replay'], { stdio: 'inherit' });
  const out = run(['run', '--release', '--quiet', '--bin', 'replay', '--', path.join(dir, 'save.bin'), path.join(dir, 'inputs.txt'), String(TICKS)]).trim();
  const nativeEnd = out.split(' ').pop(), same = nativeEnd === wasmEnd;
  console.log(`replay of a WASM session (${start.length} byte save, ${log.length} input changes): native ${nativeEnd} wasm ${wasmEnd} ${same ? 'match' : 'MISMATCH'}`);
  fs.rmSync(dir, { recursive: true });
  if (!same) bad++;

  if (bad) { console.log(`${bad} determinism mismatches (is index.html stale? run npm run build)`); process.exit(1); }
  console.log('native and WASM builds agree');
})().catch(e => { console.error(e); process.exit(1); });
