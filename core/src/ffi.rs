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
pub unsafe extern "C" fn dw_set_player(w: *mut World, slot: i32) { unsafe { world(w) }.player.slot = slot }

/// Buttons held for the coming ticks (bits in `player.rs`).
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_set_input(w: *mut World, input: u32) { unsafe { world(w) }.player.input = input }

/// The player's assist set speed, m/s.
/// # Safety
/// See `world`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dw_player_set(w: *mut World) -> f64 { unsafe { world(w) }.player.set }

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
