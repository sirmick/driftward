// ======================= SIM CORE (Rust -> WASM) =======================
// The simulation core is the Rust crate in core/, compiled to WASM and inlined into the page as base64
// (tools/build.py). Columns live in WASM memory; the manifest says where, and this wraps each one in a
// typed-array view, so JS reads and writes them like any other array with no copying and no per-entity calls.
// Columns never move (allocated once at full capacity), so the views stay valid for the life of a world.
const CORE_READY = (async () => {
  const b64 = document.getElementById('core-wasm').textContent.trim();
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const X = instance.exports, mem = X.memory;
  const VIEW = { f64: Float64Array, f32: Float32Array, u32: Uint32Array, u16: Uint16Array, u8: Uint8Array };

  // cfg: { maxShips, maxTypes, maxBodies, envN, envW, seed }
  function world(cfg) {
    const w = X.dw_world_new(cfg.maxShips, cfg.maxTypes, cfg.maxBodies, cfg.envN, cfg.envW, (cfg.seed >>> 0) || 1);
    const json = new TextDecoder().decode(new Uint8Array(mem.buffer, X.dw_manifest_ptr(w), X.dw_manifest_len(w)));
    const M = JSON.parse(json), buffer = mem.buffer;
    const groups = {};
    for (const c of M.columns) (groups[c.group] ||= {})[c.name] = new VIEW[c.kind](buffer, c.ptr, c.len);
    const params = groups.world.params, P = {};
    M.params.forEach((name, k) => { P[name] = k; });
    return {
      manifest: M, DT: M.dt,
      ship: groups.ship, type: groups.type, body: groups.body, env: groups.env,
      // tuning: core.param('damper') / core.param('damper', 0.6); names in core/src/world.rs
      param: (name, v) => { if (!(name in P)) throw new Error('unknown core param ' + name); if (v !== undefined) params[P[name]] = v; return params[P[name]]; },
      paramNames: M.params,
      clear: () => X.dw_clear(w), // zero every ship, tick back to 0
      setCount: n => X.dw_set_count(w, n),
      count: () => X.dw_count(w),
      setBodies: n => X.dw_set_bodies(w, n),
      due: realDt => X.dw_due(w, realDt), // fixed ticks owed for this much real time
      step: () => X.dw_step(w),
      interpolate: () => X.dw_interpolate(w), // writes ship.rx/ry/ra for this frame
      alpha: () => X.dw_alpha(w),
      tick: () => X.dw_tick(w),
      slotReset: (i, respawn) => X.dw_slot_reset(w, i, respawn ? 1 : 0),
      handle: i => X.dw_handle(w, i),
      resolve: h => X.dw_resolve(w, h),
      rand: () => X.dw_rand(w),
      reseed: seed => X.dw_reseed(w, seed >>> 0),
      // player: the core flies this slot from one input bitmask per tick (bits as in core/src/player.rs)
      setPlayer: slot => X.dw_set_player(w, slot),
      setInput: bits => X.dw_set_input(w, bits >>> 0),
      playerSet: () => X.dw_player_set(w), // assist set speed, m/s
      // save: a copy of the whole world as bytes; load(bytes): 0 ok, else an error code (see snapshot.rs)
      save: () => groups.world.snapshot.slice(0, X.dw_save(w)),
      load: bytes => { if (bytes.length !== groups.world.snapshot.length) return 4; groups.world.snapshot.set(bytes); return X.dw_load(w); },
      hash: () => BigInt.asUintN(64, X.dw_hash(w)).toString(16).padStart(16, '0'),
      // views die if WASM memory ever grows; nothing allocates after creation, so this should never fire
      checkViews: () => { if (mem.buffer !== buffer) throw new Error('sim core memory grew; column views are stale'); },
      free: () => X.dw_world_free(w)
    };
  }
  // input bits, mirrored from core/src/player.rs
  const IN = { thrust: 1, reverse: 2, left: 4, right: 8, strafeL: 16, strafeR: 32, burn: 64, fire: 128, retro: 256, assist: 512 };
  return { world, IN, scenario: (seed, ticks) => BigInt.asUintN(64, X.dw_scenario(seed, ticks)).toString(16).padStart(16, '0'), exports: X };
})();
