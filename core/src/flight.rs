//! Flight physics: one Newtonian model for every ship, with flight assist as a controller on top.
//! Ported from the M0 flight lab (src/fly.js), stage by stage. Every loop is over the live slots,
//! skipping dead ones by the `alive` mask.

use crate::math::{atan2, clamp1, hypot, sin_cos, wrap};
use crate::world::{World, DT, P};

/// Heading unit vector. Angle 0 points +y; positive angles turn counter-clockwise.
#[inline]
pub(crate) fn heading(ang: f64) -> (f64, f64) {
    let (s, c) = sin_cos(ang);
    (-s, c)
}

/// Drive taper: an engine cannot push its own ship past `cap` along its thrust axis.
#[inline]
fn taper(u: f64, cap: f64) -> f64 {
    if u <= 0.0 { 1.0 } else if u >= cap { 0.0 } else {
        let q = u / cap;
        let q2 = q * q;
        1.0 - q2 * q2
    }
}

/// Assist controller: desired velocity (and facing) -> turn, main and lateral commands.
/// NPCs always fly through it; the player does when assist is on.
pub fn control(w: &mut World) {
    let (gain, rcs, k_turn) = (w.p(P::assist_gain), w.p(P::rcs), w.p(P::assist_turn));
    let (face_dv, face_v) = (w.p(P::assist_face_dv), w.p(P::assist_face_v));
    let (s, t) = (&mut w.ships, &w.types);
    for i in 0..w.count {
        if s.alive[i] == 0 || s.ctl[i] == 0 { continue; }
        let k = s.kind[i] as usize;
        let (accel, turn, vmax) = (t.accel[k], t.turn[k], t.vmax[k]);
        let (hx, hy) = heading(s.ang[i]);
        let (tvx, tvy) = (s.want_vx[i], s.want_vy[i]);
        let (dvx, dvy) = (tvx - s.vx[i], tvy - s.vy[i]);
        let face = match s.ctl[i] {
            1 => {
                if hypot(dvx, dvy) > accel * face_dv { Some(atan2(-dvx, dvy)) }
                else if hypot(tvx, tvy) > vmax * face_v { Some(atan2(-tvx, tvy)) }
                else { Some(s.ang[i]) }
            }
            2 => Some(s.want_face[i]),
            _ => None,
        };
        if let Some(f) = face { s.turn_in[i] = clamp1(wrap(f - s.ang[i]) * k_turn / turn); }
        let g = accel * gain;
        s.main[i] = clamp1((dvx * hx + dvy * hy) / g);
        s.lat[i] = clamp1((dvx * hy - dvy * hx) / (g * rcs));
    }
}

/// Gather the gas density at every ship (bilinear; zero off the grid).
pub fn fields(w: &mut World) {
    let n = w.cfg.env_n;
    let half = w.cfg.env_w / 2.0;
    let cell = w.cfg.env_w / n as f64;
    let (s, e) = (&mut w.ships, &w.env);
    for i in 0..w.count {
        if s.alive[i] == 0 { continue; }
        let fx = (s.x[i] + half) / cell - 0.5;
        let fy = (s.y[i] + half) / cell - 0.5;
        let (i0, j0) = (fx.floor(), fy.floor());
        if i0 < 0.0 || j0 < 0.0 || i0 >= (n - 1) as f64 || j0 >= (n - 1) as f64 {
            s.gas_h[i] = 0.0; s.gas_d[i] = 0.0; s.gas_i[i] = 0.0;
            continue;
        }
        let (tx, ty) = (fx - i0, fy - j0);
        let k = j0 as usize * n + i0 as usize;
        let (w00, w10, w01, w11) = ((1.0 - tx) * (1.0 - ty), tx * (1.0 - ty), (1.0 - tx) * ty, tx * ty);
        let sample = |g: &[f32]| g[k] as f64 * w00 + g[k + 1] as f64 * w10 + g[k + n] as f64 * w01 + g[k + n + 1] as f64 * w11;
        s.gas_h[i] = sample(&e.h);
        s.gas_d[i] = sample(&e.d);
        s.gas_i[i] = sample(&e.i);
    }
}

/// Angular motion: the turn command sets a target rate, approached at a bounded angular acceleration.
pub fn steer(w: &mut World) {
    let slew = w.p(P::turn_slew);
    let (s, t) = (&mut w.ships, &w.types);
    for i in 0..w.count {
        if s.alive[i] == 0 { continue; }
        let turn = t.turn[s.kind[i] as usize];
        let (target, step) = (s.turn_in[i] * turn, turn * slew * DT);
        s.av[i] += (target - s.av[i]).clamp(-step, step);
        s.ang[i] = wrap(s.ang[i] + s.av[i] * DT);
    }
}

/// Thrust (main, reverse, lateral; each tapered at the speed cap), gas drag, planet gravity.
pub fn forces(w: &mut World) {
    let (rev, rcs, b_acc, b_cap, lat_cap) = (w.p(P::rev), w.p(P::rcs), w.p(P::burn_accel), w.p(P::burn_cap), w.p(P::lat_cap));
    let (dh, dd, di) = (w.p(P::drag_h), w.p(P::drag_d), w.p(P::drag_i));
    let (s, t, b, nb) = (&mut w.ships, &w.types, &w.bodies, w.n_bodies);
    for i in 0..w.count {
        if s.alive[i] == 0 { continue; }
        let k = s.kind[i] as usize;
        let (accel, vmax) = (t.accel[k], t.vmax[k]);
        let (hx, hy) = heading(s.ang[i]);
        let (rx, ry) = (hy, -hx);
        let burn = s.burn[i] != 0 && s.main[i] > 0.0;
        let acc = accel * if burn { b_acc } else { 1.0 };
        let cap = vmax * if burn { b_cap } else { 1.0 };
        let (vx, vy) = (s.vx[i], s.vy[i]);
        let along = vx * hx + vy * hy;
        let side = vx * rx + vy * ry;
        let (mut ax, mut ay) = (0.0, 0.0);
        let m = s.main[i];
        if m > 0.0 {
            let f = acc * m * taper(along, cap);
            ax += hx * f; ay += hy * f;
        } else if m < 0.0 {
            let f = accel * rev * m * taper(-along, cap);
            ax += hx * f; ay += hy * f;
        }
        let l = s.lat[i];
        if l != 0.0 {
            let f = accel * rcs * l * taper(if l > 0.0 { side } else { -side }, cap * lat_cap);
            ax += rx * f; ay += ry * f;
        }
        // drag: density x v^2, per species
        let sp = hypot(vx, vy);
        let cd = dh * s.gas_h[i] + dd * s.gas_d[i] + di * s.gas_i[i];
        ax -= cd * sp * vx;
        ay -= cd * sp * vy;
        // gravity, softened inside the body
        for j in 0..nb {
            let (dx, dy) = (b.x[j] - s.x[i], b.y[j] - s.y[i]);
            let d = { let d = hypot(dx, dy); if d == 0.0 { 1.0 } else { d } };
            let r = b.r[j];
            let g = b.g[j] * if d > r { r * r / (d * d) } else { d / r };
            ax += dx / d * g;
            ay += dy / d * g;
        }
        s.ax[i] = ax;
        s.ay[i] = ay;
    }
}

/// Semi-implicit Euler, with inertial dampers between the velocity and position updates: they bleed
/// speed above the hull's limit, so slingshots and recoil can exceed it for a while.
pub fn integrate(w: &mut World) {
    let (b_cap, damper) = (w.p(P::burn_cap), w.p(P::damper));
    let (s, t) = (&mut w.ships, &w.types);
    let bleed = (damper * DT).min(1.0);
    for i in 0..w.count {
        if s.alive[i] == 0 { continue; }
        s.vx[i] += s.ax[i] * DT;
        s.vy[i] += s.ay[i] * DT;
        let burn = s.burn[i] != 0 && s.main[i] > 0.0;
        let lim = t.vmax[s.kind[i] as usize] * if burn { b_cap } else { 1.0 };
        let sp = hypot(s.vx[i], s.vy[i]);
        if sp > lim {
            let k = 1.0 - bleed * (sp - lim) / sp;
            s.vx[i] *= k;
            s.vy[i] *= k;
        }
        s.x[i] += s.vx[i] * DT;
        s.y[i] += s.vy[i] * DT;
    }
}

/// Engine glow follows the throttle: idle, cruise or burner.
pub fn engines(w: &mut World) {
    let rate = (w.p(P::thr_rate) * DT).min(1.0);
    let s = &mut w.ships;
    for i in 0..w.count {
        if s.alive[i] == 0 { continue; }
        let m = s.main[i];
        let burn = s.burn[i] != 0 && m > 0.0;
        let target = if m > 0.05 { if burn { 1.0 } else { 0.3 + 0.42 * m } } else { 0.06 };
        s.thr[i] += (target - s.thr[i]) * rate;
    }
}

#[cfg(test)]
mod tests {
    use crate::world::{Config, World, DT, P};

    /// One ship of a type with accel 60, turn 1, vmax 200, at rest at the origin facing +y.
    fn one_ship() -> Box<World> {
        let mut w = World::new(Config { max_ships: 4, max_types: 1, max_bodies: 1, env_n: 16, env_w: 16_000.0 }, 3);
        w.types.accel[0] = 60.0;
        w.types.turn[0] = 1.0;
        w.types.vmax[0] = 200.0;
        w.count = 1;
        w.ships.alive[0] = 1;
        w
    }
    fn run(w: &mut World, secs: f64) { for _ in 0..(secs / DT).round() as usize { w.step(); } }
    fn speed(w: &World) -> f64 { w.ships.vx[0].hypot(w.ships.vy[0]) }

    #[test]
    fn full_thrust_tapers_to_the_cap() {
        let mut w = one_ship();
        w.ships.main[0] = 1.0;
        run(&mut w, 1.0);
        assert!((speed(&w) - 60.0).abs() < 1.0, "{}", speed(&w)); // about accel x 1 s while far below the cap
        run(&mut w, 30.0);
        assert!(speed(&w) < 200.0 && speed(&w) > 190.0, "{}", speed(&w));
        assert!(w.ships.vy[0] > 0.0 && w.ships.vx[0].abs() < 1e-9); // straight along the nose
    }

    #[test]
    fn burner_raises_the_cap_and_dampers_bleed_it_back() {
        let mut w = one_ship();
        w.ships.main[0] = 1.0;
        w.ships.burn[0] = 1;
        run(&mut w, 30.0);
        assert!(speed(&w) > 240.0 && speed(&w) < 260.0, "{}", speed(&w));
        w.ships.burn[0] = 0;
        w.ships.main[0] = 0.0;
        run(&mut w, 20.0);
        assert!(speed(&w) < 205.0, "{}", speed(&w));
    }

    #[test]
    fn assist_holds_a_velocity_and_cancels_drift() {
        let mut w = one_ship();
        w.ships.vx[0] = 80.0; // drifting sideways
        w.ships.ctl[0] = 1;
        w.ships.want_vx[0] = 0.0;
        w.ships.want_vy[0] = -150.0;
        run(&mut w, 25.0);
        assert!((w.ships.vy[0] + 150.0).abs() < 2.0, "vy {}", w.ships.vy[0]);
        assert!(w.ships.vx[0].abs() < 2.0, "vx {}", w.ships.vx[0]);
        // facing -y means angle pi
        assert!(crate::math::wrap(w.ships.ang[0] - std::f64::consts::PI).abs() < 0.05, "ang {}", w.ships.ang[0]);
    }

    #[test]
    fn gravity_pulls_and_softens_inside() {
        let mut w = one_ship();
        w.n_bodies = 1;
        w.bodies.x[0] = 1000.0;
        w.bodies.r[0] = 500.0;
        w.bodies.g[0] = 2.0;
        w.step();
        assert!((w.ships.ax[0] - 2.0 * 0.25).abs() < 1e-12); // g r^2 / d^2 at d = 2r
        w.ships.x[0] = 750.0;
        w.ships.y[0] = 0.0;
        w.step();
        assert!((w.ships.ax[0] - 2.0 * 250.0 / 500.0).abs() < 1e-9, "{}", w.ships.ax[0]); // linear inside
    }

    #[test]
    fn gas_drags() {
        let mut w = one_ship();
        w.env.d.fill(1.0);
        w.ships.vy[0] = 150.0;
        w.step();
        assert!((w.ships.gas_d[0] - 1.0).abs() < 1e-12);
        let expected = 150.0 - w.p(P::drag_d) * 150.0 * 150.0 * DT;
        assert!((w.ships.vy[0] - expected).abs() < 1e-9);
        w.ships.x[0] = 9000.0; // off the grid
        w.step();
        assert_eq!(w.ships.gas_d[0], 0.0);
    }

    #[test]
    fn dead_slots_do_not_move() {
        let mut w = one_ship();
        w.ships.alive[0] = 0;
        w.ships.vx[0] = 100.0;
        run(&mut w, 1.0);
        assert_eq!(w.ships.x[0], 0.0);
    }
}
