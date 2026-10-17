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
  const VIEW = { f64: Float64Array, f32: Float32Array, u32: Uint32Array, i32: Int32Array, u16: Uint16Array, i16: Int16Array, u8: Uint8Array };

  // cfg: { maxShips, maxTypes, maxBodies, envN, envW, seed }
  function world(cfg) {
    const w = X.dw_world_new(cfg.maxShips, cfg.maxTypes, cfg.maxBodies, cfg.envN, cfg.envW, (cfg.seed >>> 0) || 1);
    const json = new TextDecoder().decode(new Uint8Array(mem.buffer, X.dw_manifest_ptr(w), X.dw_manifest_len(w)));
    const M = JSON.parse(json);
    // the views, made again by rebind() should WASM memory grow (making another world grows it: rebind the ones
    // made before it, before anything holds on to their views)
    let buffer, groups;
    const bind = () => { buffer = mem.buffer; groups = {}; for (const c of M.columns) (groups[c.group] ||= {})[c.name] = new VIEW[c.kind](buffer, c.ptr, c.len); };
    bind();
    const P = {};
    M.params.forEach((name, k) => { P[name] = k; });
    const o = {
      manifest: M, DT: M.dt,
      ship: groups.ship, type: groups.type, body: groups.body, env: groups.env, game: groups.game,
      // the player's hold (tons per commodity) and every market's prices (body * maxGoods + commodity; 0 not traded)
      hold: groups.hold, market: groups.market, maxGoods: M.maxGoods,
      // mission boards (body * maxOffers + slot) and the player's missions (core/src/mission.rs)
      offer: groups.offer, mission: groups.mission, maxOffers: M.maxOffers, maxMissions: M.maxMissions,
      postBoards: () => X.dw_post_boards(w), // fresh boards at every port, for a new game
      // the traffic mix's rows, and the landing and launch sequences' seconds (core/src/traffic.rs, port.rs)
      maxMix: M.maxMix, launchS: M.launchS, descentS: M.descentS,
      // ambient traffic (core/src/traffic.rs): per-ship state, the ship type per role, and the lanes
      traffic: groups.traffic, route: groups.route, mix: groups.mix, lane: groups.lane, jlane: groups.jlane,
      startTraffic: () => X.dw_start_traffic(w), // plan the lanes and seed the steady state, for a new game
      // the atlas (core/src/atlas.rs), the systems this game has been to, a slot each by star id: store the live system
      // as system id in slot k; load slot k as the live one; empty it; the slot holding id (-1: none) and the slot id
      // would go in (-1: every slot needed); how many are in use and slot k's id
      atlasStore: (k, id) => X.dw_atlas_store(w, k, id >>> 0), atlasLoad: k => X.dw_atlas_load(w, k), atlasReset: () => X.dw_atlas_reset(w),
      atlasFind: id => X.dw_atlas_find(w, id >>> 0), atlasSlotFor: id => X.dw_atlas_slot_for(w, id >>> 0),
      atlasCount: () => groups.atlas.n[0], atlasId: k => groups.atlas_sys.id[k],
      // slot k's row as bytes (a copy), and a row put back into slot k: what a replay log carries for a store mid-session
      atlasRow: k => X.dw_atlas_row_save(w, k) ? new Uint8Array(mem.buffer, X.dw_atlas_row_ptr(w), X.dw_atlas_row_len(w)).slice() : null,
      // the live system's lanes (core/src/jump.rs: dest star id, zone 0..15, ly, days; dest 2^32-1 past the last), the
      // gate whose jump zone holds (x, y) or -1, and the fuel a lane of ly light years costs a ship type
      gate: groups.gate, zoneAt: (x, y) => X.dw_zone_at(w, x, y), laneFuel: (kind, ly) => X.dw_lane_fuel(w, kind, ly),
      atlasPut: (k, row) => { new Uint8Array(mem.buffer, X.dw_atlas_row_ptr(w), X.dw_atlas_row_len(w)).set(row); return X.dw_atlas_row_load(w, k); },
      trafficCount: () => X.dw_traffic_count(w),
      // tuning: core.param('damper') / core.param('damper', 0.6); names in core/src/world.rs
      param: (name, v) => { if (!(name in P)) throw new Error('unknown core param ' + name); const params = groups.world.params; if (v !== undefined) params[P[name]] = v; return params[P[name]]; },
      paramNames: M.params,
      clear: () => X.dw_clear(w), // zero every ship, tick back to 0
      setCount: n => X.dw_set_count(w, n),
      count: () => X.dw_count(w),
      setBodies: n => X.dw_set_bodies(w, n),
      placeBody: (j, parent, radius, angleDeg) => X.dw_place_body(w, j, parent, radius, angleDeg), // x, y by the core's trig
      // set a placed body turning on its orbit, a turn every period seconds (negative: clockwise); core/src/motion.rs
      bodyMotion: (j, period) => X.dw_body_motion(w, j, period),
      due: realDt => X.dw_due(w, realDt), // fixed ticks owed for this much real time
      step: () => X.dw_step(w),
      interpolate: () => X.dw_interpolate(w), // writes ship.rx/ry/ra for this frame
      alpha: () => X.dw_alpha(w),
      tick: () => X.dw_tick(w),
      slotReset: (i, respawn) => X.dw_slot_reset(w, i, respawn ? 1 : 0),
      handle: i => X.dw_handle(w, i) >>> 0, // (unsigned: the core's u32 comes back signed)
      resolve: h => X.dw_resolve(w, h),
      rand: () => X.dw_rand(w),
      reseed: seed => X.dw_reseed(w, seed >>> 0),
      // player: the core flies this slot from one input bitmask per tick (bits as in core/src/player.rs)
      setPlayer: slot => X.dw_set_player(w, slot),
      // game commands (codes and results in core/src/port.rs): apply between ticks; the page logs them for replays
      command: (code, a, b) => X.dw_command(w, code, a | 0, b | 0),
      placeLanded: body => X.dw_place_landed(w, body),
      portBelow: () => { const v = X.dw_port_below(w); return v < 0 ? null : { body: v % 1000, slow: v >= 1000 }; },
      mode: () => groups.game.mode[0], day: () => groups.game.day[0],
      credits: () => groups.game.credits[0], debt: () => groups.game.debt[0],
      price: (body, g) => groups.market.price[body * M.maxGoods + g],
      holdUsed: () => X.dw_hold_used(w), // trade and mission cargo, tons
      // fuel and hull (core/src/service.rs): what refuelling or repair would cost in full where the player is landed,
      // and the radiation at a point (the share of a sound hull lost a second)
      serviceCost: code => X.dw_service_cost(w, code), radiation: (x, y) => X.dw_radiation(w, x, y),
      // a ship type's top speed at a point, before the well's bend by direction (raised in open space)
      topSpeed: (kind, x, y) => X.dw_top_speed(w, kind, x, y),
      // stellar radiation at a point (sensors.rs: 1 a yellow dwarf's light in the open; a flare's many times that)
      stellar: (x, y) => X.dw_stellar(w, x, y),
      setInput: bits => X.dw_set_input(w, bits >>> 0),
      playerSet: () => groups.game.set[0], // assist set speed, m/s (the player is on the game row)
      // save: a copy of the whole world as bytes; load(bytes): 0 ok, else an error code (see snapshot.rs)
      save: () => groups.world.snapshot.slice(0, X.dw_save(w)),
      load: bytes => { if (bytes.length !== groups.world.snapshot.length) return 4; groups.world.snapshot.set(bytes); return X.dw_load(w); },
      hash: () => BigInt.asUintN(64, X.dw_hash(w)).toString(16).padStart(16, '0'),
      // views die if WASM memory ever grows; nothing allocates after creation, so this should never fire
      // orbiting debris and traffic (core/src/orbit.rs): looks only, outside the snapshot. orbitAdd(body, kind 0 debris
      // or 1 traffic, count, seed); orbitEval(t, star x, y, view centre x, y, half width, half height, smallest size m)
      // fills orbitOut with that many visible instances, 8 floats each (see orbit.rs OUT_STRIDE)
      orbitOut: groups.orbit.out,
      orbitClear: () => X.dw_orbit_clear(w),
      orbitAdd: (body, kind, count, seed) => X.dw_orbit_add(w, body, kind, count, seed >>> 0),
      // ferries: specks shuttling between two points near a body (a world's surface and its stations, where they are at
      // time 0), for looks; each end turns about the body with its station, at spinA and spinB rad/s
      orbitFerries: (body, ax, ay, bx, by, spreadA, spreadB, spinA, spinB, count, seed) => X.dw_orbit_ferries(w, body, ax, ay, bx, by, spreadA, spreadB, spinA, spinB, count, seed >>> 0),
      orbitEval: (t, sx, sy, cx, cy, hw, hh, minM) => X.dw_orbit_eval(w, t, sx, sy, cx, cy, hw, hh, minM),
      checkViews: () => { if (mem.buffer !== buffer) throw new Error('sim core memory grew; column views are stale'); },
      free: () => X.dw_world_free(w)
    };
    // the column groups as properties (the views' holders), set again on a rebind
    const views = () => Object.assign(o, {
      ship: groups.ship, type: groups.type, body: groups.body, env: groups.env, game: groups.game, hold: groups.hold, market: groups.market,
      offer: groups.offer, mission: groups.mission, traffic: groups.traffic, route: groups.route, mix: groups.mix, lane: groups.lane, jlane: groups.jlane,
      gate: groups.gate, orbitOut: groups.orbit.out });
    views();
    o.rebind = () => { if (mem.buffer !== buffer) { bind(); views(); } };
    return o;
  }
  // input bits, mirrored from core/src/player.rs
  // game commands, modes and results, mirrored from core/src/port.rs, market.rs, mission.rs and service.rs
  const CMD = { land: 1, launch: 2, wait: 3, skip: 4, buy: 5, sell: 6, repay: 7, accept: 8, abandon: 9, autopilot: 10, refuel: 11, repair: 12, hyper: 13, cold: 14, ping: 15, target: 16, teleport: 100, jump: 101, zone: 102, flare: 103 };
  // a jump's phases (core/src/jump.rs, game.jump)
  const JUMP = { none: 0, torch: 1, transit: 2, arrive: 3 };
  const MISSION = { empty: 0, active: 1, delivered: 2, failed: 3 };
  // traffic.rs: phases; streams (traffic.role; environ: to or from an environmental station); mix row streams; the
  // jump zones, north, east, south, west
  const TRAFFIC = { launch: 1, cruise: 2, land: 3, torch: 4, arriving: 5, streams: ['local', 'arrive', 'depart', 'loiter', 'environ'], mix: { local: 1, through: 2, loiter: 3, env: 4 }, zones: ['north', 'east', 'south', 'west'] };
  const MODE = { flying: 0, descending: 1, landed: 2, launching: 3, dead: 4 };
  const RESULT = { 0: 'ok', 1: 'not over a port', 2: 'too fast', 3: 'not now', 4: 'unknown command', 5: 'not enough credits', 6: 'no room in the hold', 7: 'not traded here', 8: 'not that much aboard', 9: 'bad amount', 10: 'no such offer or mission', 11: 'carrying too many missions', 12: 'no such body', 13: 'not offered here', 14: 'nothing to do',
    15: 'not in a jump zone', 16: 'not lined up with the zone', 17: 'too slow to jump', 18: 'not enough fuel', 19: 'no chart of that system', 20: 'missed',
    21: 'the ping is recharging', 22: 'not on your sensors' };
  const IN = { thrust: 1, reverse: 2, left: 4, right: 8, strafeL: 16, strafeR: 32, burn: 64, fire: 128, retro: 256, assist: 512, torque: 1024 };
  return { world, IN, CMD, JUMP, MODE, MISSION, TRAFFIC, RESULT, scenario: (seed, ticks) => BigInt.asUintN(64, X.dw_scenario(seed, ticks)).toString(16).padStart(16, '0'), exports: X };
})();
