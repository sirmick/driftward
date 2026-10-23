//! A self-contained scripted world, run identically by the native build and the WASM build, so
//! their state hashes can be compared: the determinism check behind save, replay and server validation.

use crate::combat::{A_LOITER, COMBAT, G_BAY, MAX_MOUNTS, MAX_OUTLINE};
use crate::math::{cos, sin, TAU};
use crate::world::{Config, World};

pub fn build(seed: u64) -> Box<World> {
    let n = 48;
    let mut w = World::new(Config { max_ships: n, max_types: 3, max_bodies: 2, env_n: 64, env_w: 24_000.0 }, seed);
    for (k, (accel, turn, vmax)) in [(70.0, 1.6, 260.0), (45.0, 0.9, 190.0), (22.0, 0.45, 120.0)].into_iter().enumerate() {
        w.types.accel[k] = accel;
        w.types.turn[k] = turn;
        w.types.vmax[k] = vmax;
        w.types.well[k] = 0.35 + 0.2 * k as f64;
        // armed (combat.rs): a box outline, two light turret sites, a shield
        let (hw, hl) = (4.0 + 6.0 * k as f64, 8.0 + 14.0 * k as f64);
        (w.types.len[k], w.types.hull[k], w.types.shield[k], w.types.guns[k], w.types.outline[k], w.types.rad[k]) = (2.0 * hl, 60.0 + 200.0 * k as f64, 40.0 + 100.0 * k as f64, 2, 4, (hw * hw + hl * hl).sqrt());
        for (v, (x, y)) in [(-hw, -hl), (hw, -hl), (hw, hl), (-hw, hl)].into_iter().enumerate() { (w.outline.x[k * MAX_OUTLINE + v], w.outline.y[k * MAX_OUTLINE + v]) = (x, y); }
        for (m, x) in [-hw * 0.5, hw * 0.5].into_iter().enumerate() { (w.mounts.x[k * MAX_MOUNTS + m], w.mounts.y[k * MAX_MOUNTS + m], w.mounts.size[k * MAX_MOUNTS + m]) = (x, 0.0, 1); }
    }
    // the biggest type has two forward bays and sixteen missiles (missile.rs): waves, guidance, point defence
    for (m, x) in [(2, -5.0), (3, 5.0)] { (w.mounts.x[2 * MAX_MOUNTS + m], w.mounts.y[2 * MAX_MOUNTS + m], w.mounts.size[2 * MAX_MOUNTS + m]) = (x, 30.0, G_BAY); }
    (w.types.guns[2], w.types.missiles[2]) = (4, 16);
    for (j, (x, y, r)) in [(-3200.0, 2600.0, 1300.0), (6800.0, -4400.0, 2700.0)].into_iter().enumerate() {
        w.bodies.x[j] = x;
        w.bodies.y[j] = y;
        w.bodies.r[j] = r;
        w.bodies.g[j] = 0.004 * r;
        w.bodies.kind[j] = crate::port::BODY_PLANET;
        w.bodies.port[j] = 1;
    }
    w.n_bodies = 2;
    let (ph, pd, pi) = (w.rng.range(0.0, TAU), w.rng.range(0.0, TAU), w.rng.range(0.0, TAU));
    let m = w.cfg.env_n;
    for j in 0..m {
        for i in 0..m {
            let (u, v) = (i as f64 * 0.21, j as f64 * 0.17);
            let k = j * m + i;
            w.env.h[k] = (0.5 + 0.5 * sin(u + ph) * cos(v - ph)).max(0.0) as f32;
            w.env.d[k] = (sin(u * 1.7 + pd) * sin(v * 1.3) - 0.3).max(0.0) as f32;
            w.env.i[k] = (cos(u * 0.6 - v * 0.9 + pi) - 0.5).max(0.0) as f32;
        }
    }
    w.count = n;
    for i in 0..n {
        let s = &mut w.ships;
        s.alive[i] = 1;
        s.kind[i] = (i % 3) as u16;
        let (a, r) = (w.rng.range(0.0, TAU), w.rng.range(500.0, 9000.0));
        s.x[i] = cos(a) * r;
        s.y[i] = sin(a) * r;
        s.ang[i] = w.rng.range(-3.0, 3.0);
        // cruising on assist until the first re-plan, so a world that is only stepped still has traffic
        let (a, sp) = (w.rng.range(0.0, TAU), w.rng.range(20.0, 150.0));
        s.ctl[i] = 1;
        s.want_vx[i] = cos(a) * sp;
        s.want_vy[i] = sin(a) * sp;
        s.hull[i] = w.types.hull[i % 3];
        w.slot_reset(i, true);
        // every fourth ship a fighter, on one of two sides fighting over the first planet: shells, hits and the AI
        if i % 4 == 0 {
            w.arm(i, 1 + (i / 4 % 2) as u8);
            (w.traffic.role[i], w.traffic.phase[i]) = (COMBAT, A_LOITER);
        } else { w.arm(i, 0); }
    }
    w.sides.contested.fill(0);
    // both sides in the fight (already at strength, so no arrivals), so their waves come
    (w.sides.count[0], w.sides.count[1]) = (1, 1);
    w
}

/// Re-plan every half second: pick a control mode, a target velocity or raw commands, and the burner.
fn decide(w: &mut World) {
    for i in 0..w.count {
        if w.traffic.role[i] == COMBAT { continue; } // the combat AI flies these
        let mode = w.rng.below(4) as u8;
        let vmax = w.types.vmax[w.ships.kind[i] as usize];
        let (a, sp) = (w.rng.range(0.0, TAU), w.rng.range(0.0, vmax * 1.2));
        let s = &mut w.ships;
        s.ctl[i] = mode;
        s.want_vx[i] = cos(a) * sp;
        s.want_vy[i] = sin(a) * sp;
        s.want_face[i] = a;
        s.burn[i] = (w.rng.next_f64() < 0.2) as u8;
        if mode == 0 {
            s.main[i] = w.rng.range(-1.0, 1.0);
            s.lat[i] = w.rng.range(-1.0, 1.0);
            s.turn_in[i] = w.rng.range(-1.0, 1.0);
        }
    }
}

pub fn run(seed: u64, ticks: u64) -> u64 {
    let mut w = build(seed);
    for t in 0..ticks {
        if t % 30 == 0 { decide(&mut w); }
        w.step();
    }
    w.hash()
}

#[cfg(test)]
mod tests {
    #[test]
    fn same_seed_same_world() {
        assert_eq!(super::run(42, 600), super::run(42, 600));
        assert_ne!(super::run(42, 600), super::run(43, 600));
        assert_ne!(super::run(42, 600), super::run(42, 601));
    }

    #[test]
    fn the_fighters_fight() {
        let mut w = super::build(7);
        for t in 0..1800 { if t % 30 == 0 { super::decide(&mut w); } w.step(); }
        let fired = (0..w.count).filter(|&i| w.arms.guns[i] > 0 && w.arms.ammo[i] < 2.0).count();
        assert!(fired >= 4, "fighters fired: {fired}");
    }

    #[test]
    fn the_missiles_fly() {
        let mut w = super::build(7);
        let mut seen = 0;
        for t in 0..3600 { if t % 30 == 0 { super::decide(&mut w); } w.step(); seen = seen.max((0..crate::missile::MAX_MISSILES).filter(|&n| w.missiles.live[n] != 0).count()); }
        assert!(seen > 0, "a wave flew");
    }
}
