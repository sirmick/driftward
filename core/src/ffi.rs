//! The WASM boundary. Plain C-ABI exports, no bindings generator: JavaScript reads and writes the
//! columns directly through typed-array views (see the manifest) and calls these once per tick or
//! per frame. Nothing here is called per entity in a hot loop.

use crate::world::{Config, World};

/// # Safety
/// `w` must come from `dw_world_new` and not be freed.
unsafe fn world<'a>(w: *mut World) -> &'a mut World { unsafe { &mut *w } }

#[unsafe(no_mangle)]
pub extern "C" fn dw_world_new(max_ships: u32, max_types: u32, max_bodies: u32, env_n: u32, env_w: f64, seed: u32) -> *mut World {
    let cfg = Config { max_ships: max_ships as usize, max_types: max_types as usize, max_bodies: max_bodies as usize, env_n: env_n as usize, env_w };
    Box::into_raw(World::new(cfg, seed as u64))
}

/// # Safety
/// `w` must come from `dw_world_new`; it is invalid afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_world_free(w: *mut World) { drop(unsafe { Box::from_raw(w) }); }

/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_manifest_ptr(w: *mut World) -> *const u8 { unsafe { world(w) }.manifest().as_ptr() }

/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_manifest_len(w: *mut World) -> u32 { unsafe { world(w) }.manifest().len() as u32 }

/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_clear(w: *mut World) { unsafe { world(w) }.clear() }

/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_set_count(w: *mut World, n: u32) {
    let w = unsafe { world(w) };
    w.count = (n as usize).min(w.cfg.max_ships);
}

/// Live ship slots (0..count).
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_count(w: *mut World) -> u32 { unsafe { world(w) }.count as u32 }

/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_set_bodies(w: *mut World, n: u32) {
    let w = unsafe { world(w) };
    w.n_bodies = (n as usize).min(w.cfg.max_bodies);
}

/// # Safety
/// See `world`; `j` and `parent` must be below the body capacity.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_place_body(w: *mut World, j: u32, parent: u32, radius: f64, angle_deg: f64) {
    unsafe { world(w) }.place_body(j as usize, parent as usize, radius, angle_deg);
}

/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_due(w: *mut World, real_dt: f64) -> u32 { unsafe { world(w) }.due(real_dt) }

/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_step(w: *mut World) { unsafe { world(w) }.step() }

/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_interpolate(w: *mut World) { unsafe { world(w) }.interpolate() }

/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_alpha(w: *mut World) -> f64 { unsafe { world(w) }.alpha() }

/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_tick(w: *mut World) -> f64 { unsafe { world(w) }.tick as f64 }

/// # Safety
/// See `world`; `i` must be below the ship capacity.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_slot_reset(w: *mut World, i: u32, respawn: u32) { unsafe { world(w) }.slot_reset(i as usize, respawn != 0) }

/// # Safety
/// See `world`; `i` must be below the ship capacity.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_handle(w: *mut World, i: u32) -> u32 { unsafe { world(w) }.handle(i as usize) }

/// Slot of a live handle, or -1 if it went stale.
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_resolve(w: *mut World, h: u32) -> i32 { unsafe { world(w) }.resolve(h).map_or(-1, |i| i as i32) }

/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_rand(w: *mut World) -> f64 { unsafe { world(w) }.rng.next_f64() }

/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_reseed(w: *mut World, seed: u32) { unsafe { world(w) }.rng = crate::rng::Rng::new(seed as u64) }

/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_hash(w: *mut World) -> u64 { unsafe { world(w) }.hash() }

/// Which ship slot the player flies (-1: none; the JS Fly tab drives its own player).
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_set_player(w: *mut World, slot: i32) { unsafe { world(w) }.game.player[0] = slot }

/// Buttons held for the coming ticks (bits in `player.rs`).
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_set_input(w: *mut World, input: u32) { unsafe { world(w) }.game.input[0] = input }


/// Apply a game command now, between ticks (codes and results in port.rs). The page records it in the replay log.
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_command(w: *mut World, code: u32, a: i32, b: i32) -> i32 { unsafe { world(w) }.command(code, a, b) }

/// Put the player down at a port's body without the landing sequence (new games start landed).
/// # Safety
/// See `world`; `body` must be below the body capacity.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_place_landed(w: *mut World, body: u32) { unsafe { world(w) }.place_landed(body as usize) }

/// Post a fresh offer board at every port (a new game; later days top boards up themselves).
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_post_boards(w: *mut World) { unsafe { world(w) }.post_boards() }

/// Store the live system as atlas system `k` (atlas.rs); 1 if stored.
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_atlas_store(w: *mut World, k: u32) -> u32 { unsafe { world(w) }.atlas_store(k as usize) as u32 }

/// Make atlas system `k` the live one (bodies, prices, traffic mix and params); 1 if loaded.
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_atlas_load(w: *mut World, k: u32) -> u32 { unsafe { world(w) }.atlas_load(k as usize) as u32 }

/// Start ambient traffic for a new game: plan the lanes from the bodies, markets, populations and the traffic mix,
/// then seed the steady state. Call after the player's slot is set up.
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_start_traffic(w: *mut World) { let w = unsafe { world(w) }; w.plan_traffic(); w.seed_traffic(); }

/// Ambient ships in flight (launching and landing included).
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_traffic_count(w: *mut World) -> u32 { unsafe { world(w) }.traffic_count() as u32 }

/// Tons in the player's hold, trade and mission cargo together.
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_hold_used(w: *mut World) -> u32 { unsafe { world(w) }.hold_used() }

/// The port body under the player: index, plus 1000 if slow enough to land now; -1 if not over a port.
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_port_below(w: *mut World) -> i32 {
    unsafe { world(w) }.port_below().map_or(-1, |(j, slow)| j as i32 + if slow { 1000 } else { 0 })
}

/// Write the world into the "world/snapshot" column; returns its length in bytes.
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_save(w: *mut World) -> u32 { unsafe { world(w) }.save() as u32 }

/// Restore the world from the "world/snapshot" column: 0 ok, 1 bad magic, 2 bad version, 3 different config, 4 truncated.
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_load(w: *mut World) -> i32 { unsafe { world(w) }.load().map_or_else(|e| e.code(), |_| 0) }

/// A new world holding the shared scripted scenario (for cross-target tests).
#[unsafe(no_mangle)]
pub extern "C" fn dw_scenario_world(seed: u32) -> *mut World { Box::into_raw(crate::scenario::build(seed as u64)) }

/// Run the shared scripted scenario and return its final state hash (compare with the native build).
#[unsafe(no_mangle)]
pub extern "C" fn dw_scenario(seed: u32, ticks: u32) -> u64 { crate::scenario::run(seed as u64, ticks as u64) }

/// Drop every orbiter swarm (orbit.rs).
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_orbit_clear(w: *mut World) { unsafe { world(w) }.orbit.clear() }

/// Add a swarm of `count` orbiters (kind 0 debris, 1 traffic) round a body; returns how many fit.
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_orbit_add(w: *mut World, body: u32, kind: u32, count: u32, seed: u32) -> u32 {
    let w = unsafe { world(w) };
    let b = body as usize;
    if b >= w.n_bodies { return 0; }
    let r = w.bodies.r[b];
    w.orbit.add(b, r, kind as u8, count as usize, seed) as u32
}

/// Add `count` ferries (orbit.rs: specks shuttling back and forth, for looks) on a route near body `body` between
/// (ax, ay) and (bx, by), each end spread by up to spread_a and spread_b metres; returns how many fit.
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn dw_orbit_ferries(w: *mut World, body: u32, ax: f64, ay: f64, bx: f64, by: f64, spread_a: f64, spread_b: f64, count: u32, seed: u32) -> u32 {
    let w = unsafe { world(w) };
    if body as usize >= w.n_bodies { return 0; }
    w.orbit.add_ferries(body as usize, ax, ay, bx, by, spread_a, spread_b, count as usize, seed) as u32
}

/// Place the orbiters near the view at time `t` and write the visible ones to the "orbit/out" column; returns the count.
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn dw_orbit_eval(w: *mut World, t: f64, sx: f64, sy: f64, cx: f64, cy: f64, hw: f64, hh: f64, min_m: f64) -> u32 {
    let w = unsafe { world(w) };
    let n = w.n_bodies;
    let (bx, by, br) = (&w.bodies.x[..n], &w.bodies.y[..n], &w.bodies.r[..n]);
    w.orbit.eval(bx, by, br, t, sx, sy, cx, cy, hw, hh, min_m) as u32
}
