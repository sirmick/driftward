//! A self-contained scripted world, run identically by the native build and the WASM build, so
//! their state hashes can be compared: the determinism check behind save, replay and server validation.

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
    }
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
        w.slot_reset(i, true);
    }
    w
}

/// Re-plan every half second: pick a control mode, a target velocity or raw commands, and the burner.
fn decide(w: &mut World) {
    for i in 0..w.count {
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
}
