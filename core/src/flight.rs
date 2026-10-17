//! Flight physics: one Newtonian model for every ship, with flight assist as a controller on top.
//! Ported from the M0 flight lab (src/fly.js), stage by stage. Every loop is over the live slots,
//! skipping dead ones by the `alive` mask and ships on rails (traffic.rs moves those) by the `rail` mask.
//!
//! Gravity wells are game physics, not Newton's. Inside a body's reach (`well_reach` radii) a well field points
//! inward, with a strength that is the body's (g / g_ref) at and below its surface and fades to zero at the edge.
//! It does two things, both scaled by the hull's well sensitivity (`type.well`: fighters little, capitals a lot):
//! - pull: an acceleration into the well, a share of the ship's own thrust (`pull`), so every hull can climb out;
//! - top speed by direction: each speed cap (the engines' taper, and the dampers) rises heading in (`well_in`)
//!   and falls heading out (`well_out`). Ships fall in fast and crawl out.
//!
//! A fast pass through a well still carries momentum out the far side; the dampers then bleed it down.
//!
//! Open space is fast. Outside every well, a hull's top speed rises with the distance to the nearest well's edge, up to
//! `cruise_max` times its top speed: the speed from which its own thrust (times `cruise_brake`) brings it back down to
//! top speed by that edge, so the faster stretches are the longer gaps and any hull can slow in time. There the
//! dampers bleed faster (`cruise_bleed`), so speed follows the ceiling down as a well nears. Every ship flies by it: the
//! player, the autopilot, and traffic on rails or under physics. It is what keeps a visit to a system a few minutes.

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
        if s.alive[i] == 0 || s.rail[i] != 0 || s.ctl[i] == 0 { continue; }
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
        if s.alive[i] == 0 || s.rail[i] != 0 { continue; }
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

/// Angular motion. Rate-controlled (the default): the turn command sets a target turn rate, approached at a
/// bounded angular acceleration, so releasing the stick stops the turn. Torque (full assist off): the turn
/// command is the angular acceleration itself, so a spin persists until countered. Both share one acceleration
/// and the same top turn rate.
pub fn steer(w: &mut World) {
    let slew = w.p(P::turn_slew);
    let (s, t) = (&mut w.ships, &w.types);
    for i in 0..w.count {
        if s.alive[i] == 0 || s.rail[i] != 0 { continue; }
        let turn = t.turn[s.kind[i] as usize];
        let step = turn * slew * DT;
        if s.rot[i] == 1 {
            s.av[i] = (s.av[i] + s.turn_in[i].clamp(-1.0, 1.0) * step).clamp(-turn, turn);
        } else {
            s.av[i] += (s.turn_in[i] * turn - s.av[i]).clamp(-step, step);
        }
        s.ang[i] = wrap(s.ang[i] + s.av[i] * DT);
    }
}

/// The well field at (x, y): a vector pointing into the wells, its length the strength there. Each body adds its
/// strength (g / g_ref) times an influence that is 1 at and below the surface and eases to 0 at `reach` radii (or the
/// body's own reach, if it has one: a compact star's well reaches many of its radii), faded out near the very centre
/// (where "inward" stops meaning anything).
pub(crate) fn well_field(b: &crate::world::Bodies, nb: usize, x: f64, y: f64, reach: f64, g_ref: f64) -> (f64, f64) {
    let (mut wx, mut wy) = (0.0, 0.0);
    for j in 0..nb {
        let (dx, dy) = (b.x[j] - x, b.y[j] - y);
        let (d, r) = (hypot(dx, dy), b.r[j]);
        let edge = r * if b.reach[j] > 0.0 { b.reach[j] } else { reach };
        if d >= edge || d < 1e-6 { continue; }
        let q = if d <= r { 1.0 } else { 1.0 - (d - r) / (edge - r) };
        let k = q * q * (3.0 - 2.0 * q) * (d / (0.3 * r)).min(1.0) * b.g[j] / g_ref;
        wx += dx / d * k;
        wy += dy / d * k;
    }
    (wx, wy)
}

/// How far (x, y) is outside the nearest well's edge (each body with gravity, at `reach` radii or its own), metres; 0
/// inside one, and unbounded where nothing has a well.
pub(crate) fn open_gap(b: &crate::world::Bodies, nb: usize, x: f64, y: f64, reach: f64) -> f64 {
    let mut gap = f64::INFINITY;
    for j in 0..nb {
        if b.g[j] <= 0.0 { continue; }
        let edge = b.r[j] * if b.reach[j] > 0.0 { b.reach[j] } else { reach };
        gap = gap.min(hypot(b.x[j] - x, b.y[j] - y) - edge);
    }
    gap.max(0.0)
}

/// A hull's top speed `gap` metres out into open space: the speed from which `brake` times its thrust brings it back to
/// `vmax` by the well's edge, at most `max` times `vmax`.
#[inline]
pub(crate) fn open_top(vmax: f64, accel: f64, gap: f64, max: f64, brake: f64) -> f64 {
    if gap <= 0.0 { return vmax; }
    (vmax * vmax + 2.0 * brake * accel * gap.min(1e12)).sqrt().min(vmax * max.max(1.0))
}

impl World {
    /// Ship type k's top speed at (x, y), before the well's bend by direction: raised in open space (`open_top`).
    pub fn top_speed(&self, k: usize, x: f64, y: f64) -> f64 {
        let gap = open_gap(&self.bodies, self.n_bodies, x, y, self.p(P::well_reach));
        open_top(self.types.vmax[k], self.types.accel[k], gap, self.p(P::cruise_max), self.p(P::cruise_brake))
    }
}

/// The well's effect on a speed cap along the unit direction (dx, dy): raised heading into the well (k_in), lowered
/// heading out (k_out), by strength `sw` (unit direction (ux, uy)) times the hull's sensitivity. Never below 15%.
#[inline]
#[allow(clippy::too_many_arguments)]
pub(crate) fn dir_cap(base: f64, sw: f64, ux: f64, uy: f64, dx: f64, dy: f64, sens: f64, k_in: f64, k_out: f64) -> f64 {
    let c = dx * ux + dy * uy;
    (base * (1.0 + sw * sens * (k_in * c.max(0.0) - k_out * (-c).max(0.0)))).max(base * 0.15)
}

/// Thrust (main, reverse, lateral; each tapered at its cap, set by the well and the thrust direction), gas drag,
/// and the well's pull.
pub fn forces(w: &mut World) {
    let (rev, rcs, b_acc, b_cap, lat_cap) = (w.p(P::rev), w.p(P::rcs), w.p(P::burn_accel), w.p(P::burn_cap), w.p(P::lat_cap));
    let (reach, g_ref, pull, k_in, k_out) = (w.p(P::well_reach), w.p(P::g_ref), w.p(P::pull), w.p(P::well_in), w.p(P::well_out));
    let (dh, dd, di) = (w.p(P::drag_h), w.p(P::drag_d), w.p(P::drag_i));
    let (c_max, c_brake) = (w.p(P::cruise_max), w.p(P::cruise_brake));
    let (s, t, b, nb) = (&mut w.ships, &w.types, &w.bodies, w.n_bodies);
    for i in 0..w.count {
        if s.alive[i] == 0 || s.rail[i] != 0 { continue; }
        let k = s.kind[i] as usize;
        let (accel, vmax, sens) = (t.accel[k], t.vmax[k], t.well[k]);
        let (hx, hy) = heading(s.ang[i]);
        let (rx, ry) = (hy, -hx);
        let burn = s.burn[i] != 0 && s.main[i] > 0.0;
        let acc = accel * if burn { b_acc } else { 1.0 };
        // the well here: strength (capped) and inward direction, kept for the dampers, the player's assist and the HUD
        let (wx, wy) = well_field(b, nb, s.x[i], s.y[i], reach, g_ref);
        let wl = hypot(wx, wy);
        let (ux, uy) = if wl > 0.0 { (wx / wl, wy / wl) } else { (0.0, 0.0) };
        let sw = wl.min(1.5);
        s.well[i] = sw; s.well_x[i] = ux; s.well_y[i] = uy;
        let cap = |base: f64, dx: f64, dy: f64| dir_cap(base, sw, ux, uy, dx, dy, sens, k_in, k_out);
        let top = open_top(vmax, accel, open_gap(b, nb, s.x[i], s.y[i], reach), c_max, c_brake);
        let base = top * if burn { b_cap } else { 1.0 };
        let (vx, vy) = (s.vx[i], s.vy[i]);
        let along = vx * hx + vy * hy;
        let side = vx * rx + vy * ry;
        let (mut ax, mut ay) = (0.0, 0.0);
        let m = s.main[i];
        if m > 0.0 {
            let f = acc * m * taper(along, cap(base, hx, hy));
            ax += hx * f; ay += hy * f;
        } else if m < 0.0 {
            let f = accel * rev * m * taper(-along, cap(base, -hx, -hy));
            ax += hx * f; ay += hy * f;
        }
        let l = s.lat[i];
        if l != 0.0 {
            let c = if l > 0.0 { cap(base * lat_cap, rx, ry) } else { cap(base * lat_cap, -rx, -ry) };
            let f = accel * rcs * l * taper(if l > 0.0 { side } else { -side }, c);
            ax += rx * f; ay += ry * f;
        }
        // drag: density x v^2, per species
        let sp = hypot(vx, vy);
        let cd = dh * s.gas_h[i] + dd * s.gas_d[i] + di * s.gas_i[i];
        ax -= cd * sp * vx;
        ay -= cd * sp * vy;
        // the well's pull: a share of the ship's own thrust, so every hull can climb out
        let g = sw * sens * pull * accel;
        ax += ux * g;
        ay += uy * g;
        s.ax[i] = ax;
        s.ay[i] = ay;
    }
}

/// Semi-implicit Euler, with inertial dampers between the velocity and position updates. They bleed speed above
/// the cap along the direction of travel (set by the well, see the module notes), so momentum from a fall or a
/// slingshot outlasts the cap for a while; in open space they bleed faster (`cruise_bleed`), so a ship slows as the
/// open-space top speed falls toward a well.
pub fn integrate(w: &mut World) {
    let (b_cap, damper, k_in, k_out) = (w.p(P::burn_cap), w.p(P::damper), w.p(P::well_in), w.p(P::well_out));
    let (reach, c_max, c_brake) = (w.p(P::well_reach), w.p(P::cruise_max), w.p(P::cruise_brake));
    let (bleed_well, bleed_open) = ((damper * DT).min(1.0), (w.p(P::cruise_bleed) * DT).min(1.0));
    let (s, t, b, nb) = (&mut w.ships, &w.types, &w.bodies, w.n_bodies);
    for i in 0..w.count {
        if s.alive[i] == 0 || s.rail[i] != 0 { continue; }
        s.vx[i] += s.ax[i] * DT;
        s.vy[i] += s.ay[i] * DT;
        let burn = s.burn[i] != 0 && s.main[i] > 0.0;
        let k = s.kind[i] as usize;
        let sp = hypot(s.vx[i], s.vy[i]);
        if sp > 0.0 {
            let gap = open_gap(b, nb, s.x[i], s.y[i], reach);
            let top = open_top(t.vmax[k], t.accel[k], gap, c_max, c_brake);
            let lim = dir_cap(top * if burn { b_cap } else { 1.0 }, s.well[i], s.well_x[i], s.well_y[i],
                s.vx[i] / sp, s.vy[i] / sp, t.well[k], k_in, k_out);
            let bleed = if gap > 0.0 { bleed_open } else { bleed_well };
            if sp > lim {
                let f = 1.0 - bleed * (sp - lim) / sp;
                s.vx[i] *= f;
                s.vy[i] *= f;
            }
        }
        s.x[i] += s.vx[i] * DT;
        s.y[i] += s.vy[i] * DT;
    }
}

/// Engine glow follows the throttle: dark at rest (no thrust: no glow, so the plume and the engine light go out), cruise
/// or burner.
pub fn engines(w: &mut World) {
    let rate = (w.p(P::thr_rate) * DT).min(1.0);
    let s = &mut w.ships;
    for i in 0..w.count {
        if s.alive[i] == 0 || s.rail[i] != 0 { continue; }
        let m = s.main[i];
        let burn = s.burn[i] != 0 && m > 0.0;
        let target = if m > 0.05 { if burn { 1.0 } else { 0.3 + 0.42 * m } } else { 0.0 };
        s.thr[i] += (target - s.thr[i]) * rate;
    }
}

#[cfg(test)]
mod tests {
    use crate::world::{Config, World, DT, P};

    /// One ship of a type with accel 60, turn 1, vmax 200, at rest at the origin facing +y; open space's raised top
    /// speed off (a world without wells is all open space), for the tests of the drive itself.
    fn one_ship() -> Box<World> {
        let mut w = World::new(Config { max_ships: 4, max_types: 1, max_bodies: 1, env_n: 16, env_w: 16_000.0 }, 3);
        w.types.accel[0] = 60.0;
        w.types.turn[0] = 1.0;
        w.types.vmax[0] = 200.0;
        w.count = 1;
        w.ships.alive[0] = 1;
        w.params[P::cruise_max as usize] = 1.0;
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
    fn the_burner_adds_thrust_not_top_speed() {
        let (mut plain, mut burn) = (one_ship(), one_ship());
        plain.ships.main[0] = 1.0;
        (burn.ships.main[0], burn.ships.burn[0]) = (1.0, 1);
        run(&mut plain, 0.25);
        run(&mut burn, 0.25);
        let k = burn.p(P::burn_accel);
        assert!((speed(&burn) / speed(&plain) - k).abs() < 0.1, "{} vs {}", speed(&burn), speed(&plain)); // far below the cap: k times the thrust
        run(&mut burn, 30.0);
        assert!(speed(&burn) < 200.0 && speed(&burn) > 195.0, "{}", speed(&burn)); // and the same cap
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

    /// A body of radius 500 at full strength (g = g_ref) at the origin; the ship at (x, 0), still, with this
    /// thrust, top speed and well sensitivity.
    fn in_a_well(x: f64, accel: f64, vmax: f64, sens: f64) -> Box<World> {
        let mut w = one_ship();
        w.types.accel[0] = accel;
        w.types.vmax[0] = vmax;
        w.types.well[0] = sens;
        w.n_bodies = 1;
        w.bodies.r[0] = 500.0;
        w.bodies.g[0] = w.p(P::g_ref);
        w.ships.x[0] = x;
        w
    }
    const OUT: f64 = -std::f64::consts::FRAC_PI_2; // nose toward +x: away from the body
    const IN: f64 = std::f64::consts::FRAC_PI_2; // nose toward -x: into it

    #[test]
    fn the_well_pulls_with_a_share_of_thrust() {
        let mut w = in_a_well(600.0, 60.0, 200.0, 0.5);
        w.step();
        let expect = -0.5 * w.p(P::pull) * 60.0; // full strength just outside the surface, pulling toward -x
        assert!((w.ships.ax[0] - expect).abs() < 1.5, "{} vs {expect}", w.ships.ax[0]);
        let mut far = in_a_well(1600.0, 60.0, 200.0, 0.5); // beyond 3 radii: nothing
        far.step();
        assert_eq!((far.ships.ax[0], far.ships.well[0]), (0.0, 0.0));
    }

    /// Open space: top speed rises with the gap to the nearest well's edge, to cruise_max times; speed follows the
    /// ceiling down as a well nears (a ship flown in at full open-space speed reaches the edge near its top speed).
    #[test]
    fn open_space_raises_top_speed_and_gives_it_back_by_a_well() {
        let mut w = in_a_well(0.0, 60.0, 200.0, 0.5); // a 500 m body at (0, 0), its well to 1.5 km
        w.params[P::cruise_max as usize] = 3.0;
        assert_eq!(w.top_speed(0, 1000.0, 0.0), 200.0); // inside the well
        let near = w.top_speed(0, 1500.0 + 100.0, 0.0);
        assert!(near > 200.0 && near < 230.0, "{near}"); // just out: barely raised
        assert_eq!(w.top_speed(0, 1.0e6, 0.0), 600.0); // far out: three times
        // full thrust from far out, straight at the body: fast in open space, near top speed by the well's edge
        (w.ships.x[0], w.ships.y[0], w.ships.ang[0]) = (0.0, 30_000.0, std::f64::consts::PI); // facing -y, at the body
        w.ships.main[0] = 1.0;
        let (mut fastest, mut at_edge) = (0.0f64, 0.0);
        for _ in 0..(120.0 / DT) as usize {
            w.step();
            fastest = fastest.max(speed(&w));
            if w.ships.y[0] < 1500.0 { at_edge = speed(&w); break; }
        }
        assert!(fastest > 500.0, "fastest {fastest}");
        // (raw thrust held all the way: the dampers alone bring it down; under assist the reverse thrust helps too)
        assert!(at_edge > 0.0 && at_edge < 200.0 * 1.5, "at the well's edge {at_edge}");
    }

    /// A big body (radius 5 km), so ships reach steady speeds inside the strong part of its well.
    fn in_a_big_well(x: f64, accel: f64, vmax: f64, sens: f64) -> Box<World> {
        let mut w = in_a_well(x, accel, vmax, sens);
        w.bodies.r[0] = 5000.0;
        w
    }
    /// Full thrust out of the well from the surface: returns (fastest speed in the first 1.5 km, where the well is
    /// strong, and seconds to its edge).
    fn climb_out(accel: f64, vmax: f64, sens: f64) -> (f64, f64) {
        let mut w = in_a_big_well(5000.0, accel, vmax, sens);
        w.ships.ang[0] = OUT;
        w.ships.main[0] = 1.0;
        let (mut top, mut t) = (0.0f64, 0.0);
        while w.ships.x[0] < 15000.0 && t < 1200.0 { w.step(); t += DT; if w.ships.x[0] < 6500.0 { top = top.max(speed(&w)); } }
        (top, t)
    }
    /// Full thrust into the well from its edge: the fastest speed reached on the way in.
    fn dive_in(accel: f64, vmax: f64, sens: f64) -> f64 {
        let mut w = in_a_big_well(15000.0, accel, vmax, sens);
        w.ships.ang[0] = IN;
        w.ships.main[0] = 1.0;
        let mut top = 0.0f64;
        while w.ships.x[0] > 0.0 { w.step(); top = top.max(speed(&w)); }
        top
    }

    #[test]
    fn capital_ships_fall_in_fast_and_crawl_out_but_escape() {
        let (crawl, t) = climb_out(11.0, 90.0, 0.75);
        assert!(crawl < 90.0 * 0.6, "climbs at {crawl} m/s"); // well under its 90 m/s top speed
        assert!(t < 1200.0, "never escaped");
        let dive = dive_in(11.0, 90.0, 0.75);
        assert!(dive > 90.0 * 1.4, "dives at {dive} m/s"); // far over it
    }

    #[test]
    fn fighters_feel_the_well_less() {
        let (crawl_f, _) = climb_out(156.0, 380.0, 0.35);
        let (crawl_c, _) = climb_out(11.0, 90.0, 0.75);
        assert!(crawl_f / 380.0 > crawl_c / 90.0 + 0.15, "fighter {crawl_f} of 380, capital {crawl_c} of 90");
        let (dive_f, dive_c) = (dive_in(156.0, 380.0, 0.35), dive_in(11.0, 90.0, 0.75));
        assert!(dive_f > 380.0 * 1.15, "{dive_f}"); // a fighter still dives fast,
        assert!(dive_c / 90.0 > dive_f / 380.0 + 0.15, "fighter {dive_f} of 380, capital {dive_c} of 90"); // a capital more so
    }

    #[test]
    fn momentum_from_a_dive_carries_out_then_bleeds() {
        let mut w = in_a_well(1500.0, 11.0, 90.0, 0.75);
        w.ships.ang[0] = IN;
        w.ships.main[0] = 1.0;
        while w.ships.x[0] > 0.0 { w.step(); }
        w.ships.main[0] = 0.0; // coast on through and out the far side
        while w.ships.x[0] > -500.0 { w.step(); }
        assert!(speed(&w) > 90.0 * 0.6, "still {} m/s at the far surface", speed(&w));
        w.ships.x[0] = -1.0e6; // far from the well: the dampers take it back to the flat cap
        run(&mut w, 30.0);
        assert!(speed(&w) < 92.0, "{}", speed(&w));
    }

    #[test]
    fn a_compact_stars_well_reaches_its_own_radii() {
        let mut w = in_a_well(5000.0, 60.0, 200.0, 0.5); // ten radii out: past the usual three
        w.step();
        assert_eq!(w.ships.well[0], 0.0);
        let mut w = in_a_well(5000.0, 60.0, 200.0, 0.5);
        w.bodies.reach[0] = 20.0;
        w.step();
        assert!(w.ships.well[0] > 0.1 && w.ships.ax[0] < 0.0, "{} {}", w.ships.well[0], w.ships.ax[0]);
    }

    #[test]
    fn torque_rotation_keeps_spinning() {
        let mut w = one_ship();
        w.ships.rot[0] = 1;
        w.ships.turn_in[0] = 1.0;
        run(&mut w, 0.5);
        let spin = w.ships.av[0];
        assert!(spin > 0.9, "{spin}"); // turn 1, slew 8: at the cap within 1/8 s
        w.ships.turn_in[0] = 0.0;
        run(&mut w, 2.0);
        assert_eq!(w.ships.av[0], spin); // released: still spinning
        w.ships.turn_in[0] = -1.0;
        run(&mut w, 0.1); // 6 ticks of counter-torque at 8/60 rad/s each
        assert!((w.ships.av[0] - (spin - 0.8)).abs() < 1e-9, "{}", w.ships.av[0]);
        w.ships.rot[0] = 0; // rate-controlled: release stops the turn
        w.ships.turn_in[0] = 1.0;
        run(&mut w, 0.5);
        w.ships.turn_in[0] = 0.0;
        run(&mut w, 0.2);
        assert_eq!(w.ships.av[0], 0.0);
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
