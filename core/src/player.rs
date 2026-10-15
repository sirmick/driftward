//! The player's ship, driven by one input bitmask per tick. The bitmask is the whole of the player's
//! influence on the sim, so a recorded log of it replays a session exactly.
//!
//! The Book's three assist levels, on the same thrusters and limits:
//! - full assist (IN_ASSIST): thrust and reverse move a set speed along the nose; the assist controller holds
//!   that velocity, cancelling drift and gravity, with the side thrusters. Strafe does nothing here.
//! - drift off (neither bit): raw main, reverse and lateral thrusters, Newtonian; rotation still rate-controlled.
//! - full off (IN_TORQUE): as drift off, but rotation is torque: a spin persists until countered.
//!
//! In both off modes retro turns the nose against the velocity (rate-controlled while held).
//!
//! The fly-to autopilot (the Book's, from the system map; port.rs CMD_AUTOPILOT) flies under full assist: it heads for
//! the target body, round the star or any planet in the way (traffic.rs `detour`), and brakes to stop slow over it,
//! ready to land. Touching thrust, reverse or turn, or leaving full assist, hands control back.

use crate::flight::{dir_cap, heading};
use crate::port::BODY_STATION;
use crate::math::{atan2, clamp1, hypot, wrap};
use crate::world::{World, DT, P};

pub const IN_THRUST: u32 = 1 << 0;
pub const IN_REVERSE: u32 = 1 << 1;
pub const IN_LEFT: u32 = 1 << 2;
pub const IN_RIGHT: u32 = 1 << 3;
pub const IN_STRAFE_L: u32 = 1 << 4;
pub const IN_STRAFE_R: u32 = 1 << 5;
pub const IN_BURN: u32 = 1 << 6;
pub const IN_FIRE: u32 = 1 << 7;
pub const IN_RETRO: u32 = 1 << 8;
/// Full assist. A level, not an edge: the page owns the mode and sends it every tick.
pub const IN_ASSIST: u32 = 1 << 9;
/// Full off: torque rotation (only read when IN_ASSIST is clear).
pub const IN_TORQUE: u32 = 1 << 10;

/// Turn this tick's input into actuator commands (or assist targets) for the player's ship.
pub fn control(w: &mut World) {
    let (slot, input) = (w.game.player[0], w.game.input[0]);
    if slot < 0 || slot as usize >= w.count { return; }
    let i = slot as usize;
    if w.ships.alive[i] == 0 { return; }
    let held = |bit: u32| input & bit != 0;
    let (up, down, left, right) = (held(IN_THRUST), held(IN_REVERSE), held(IN_LEFT), held(IN_RIGHT));
    if w.game.auto[0] > 0 {
        if held(IN_ASSIST) && !(up || down || left || right) { autopilot(w, i); return; }
        w.game.auto[0] = 0; // the player took the stick: carry on at the speed along the nose
        let (hx, hy) = heading(w.ships.ang[i]);
        w.game.set[0] = (w.ships.vx[i] * hx + w.ships.vy[i] * hy).max(0.0);
    }
    let set0 = w.game.set[0];
    let (b_acc, b_cap, k_turn) = (w.p(P::burn_accel), w.p(P::burn_cap), w.p(P::assist_turn));
    let (k_in, k_out) = (w.p(P::well_in), w.p(P::well_out));
    let (s, t) = (&mut w.ships, &w.types);
    let k = s.kind[i] as usize;
    let (accel, turn, vmax) = (t.accel[k], t.turn[k], t.vmax[k]);
    s.turn_in[i] = (left as i32 - right as i32) as f64;
    let burn = up && held(IN_BURN);
    s.burn[i] = burn as u8;
    let (hx, hy) = heading(s.ang[i]);
    let mut set = set0;
    if held(IN_ASSIST) {
        // the set speed's ceiling is the top speed along the nose, so the well raises it pointing in and lowers it
        // pointing out (from last tick's well, which the forces stage keeps per ship)
        let well_cap = |base: f64| dir_cap(base, s.well[i], s.well_x[i], s.well_y[i], hx, hy, t.well[k], k_in, k_out);
        let (cap, cruise) = (well_cap(vmax * if burn { b_cap } else { 1.0 }), well_cap(vmax));
        if up { set = cap.min(set + accel * if burn { b_acc } else { 1.0 } * DT); }
        if down { set = (set - accel * DT).max(0.0); }
        if !burn && set > cruise { set = cruise.max(set - accel * 0.6 * DT); }
        s.ctl[i] = 3; // assist holds the velocity; the turn command stays the player's
        s.rot[i] = 0;
        s.want_vx[i] = hx * set;
        s.want_vy[i] = hy * set;
    } else {
        s.ctl[i] = 0;
        s.rot[i] = held(IN_TORQUE) as u8;
        s.main[i] = if up { 1.0 } else if down { -1.0 } else { 0.0 };
        s.lat[i] = (held(IN_STRAFE_R) as i32 - held(IN_STRAFE_L) as i32) as f64;
        let (vx, vy) = (s.vx[i], s.vy[i]);
        if held(IN_RETRO) && !left && !right && hypot(vx, vy) > 2.0 {
            s.turn_in[i] = clamp1(wrap(atan2(vx, -vy) - s.ang[i]) * k_turn / turn);
            s.rot[i] = 0; // the retro autopilot steers by rate, in either off mode
        }
        set = (vx * hx + vy * hy).max(0.0);
    }
    w.game.set[0] = set;
}

/// The autopilot's tick: a desired velocity toward the next point (a waypoint round an obstacle, or the target),
/// capped by the hull's top speed and by a braking curve that reaches half the landing limit at `stop` metres out;
/// there, slow, it disengages, holding still over the port.
fn autopilot(w: &mut World, i: usize) {
    let j = (w.game.auto[0] - 1) as usize;
    let (x, y) = (w.ships.x[i], w.ships.y[i]);
    let (bx, by) = (w.bodies.x[j], w.bodies.y[j]);
    let (tx, ty) = w.detour((x, y), (bx, by), [j, j]).unwrap_or((bx, by));
    (w.game.aim_x[0], w.game.aim_y[0]) = (tx, ty);
    let k = w.ships.kind[i] as usize;
    let (accel, vmax) = (w.types.accel[k], w.types.vmax[k]);
    let limit = if w.bodies.kind[j] == BODY_STATION { w.p(P::dock_speed) } else { w.p(P::land_speed) };
    let stop = (w.bodies.r[j] * 0.25).max(80.0);
    let d_end = hypot(bx - x, by - y);
    let sp = hypot(w.ships.vx[i], w.ships.vy[i]);
    let s = &mut w.ships;
    if d_end < stop && sp < limit * 0.6 {
        w.game.auto[0] = 0;
        w.game.set[0] = 0.0;
        s.ctl[i] = 3; s.want_vx[i] = 0.0; s.want_vy[i] = 0.0;
        return;
    }
    let (dx, dy) = (tx - x, ty - y);
    let d = hypot(dx, dy).max(1e-6);
    // brake for the target only on the last leg (a waypoint is passed at speed)
    let v = if (tx, ty) == (bx, by) { vmax.min((2.0 * accel * 0.5 * (d - stop).max(0.0)).sqrt() * 0.8).max(limit * 0.4) } else { vmax };
    s.ctl[i] = 1; // assist faces the velocity it wants
    s.rot[i] = 0;
    s.burn[i] = 0;
    s.turn_in[i] = 0.0;
    s.want_vx[i] = dx / d * v;
    s.want_vy[i] = dy / d * v;
    w.game.set[0] = v;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{Config, World};

    fn world() -> Box<World> {
        let mut w = World::new(Config { max_ships: 2, max_types: 1, max_bodies: 1, env_n: 8, env_w: 1000.0 }, 1);
        w.types.accel[0] = 60.0;
        w.types.turn[0] = 1.0;
        w.types.vmax[0] = 200.0;
        w.count = 1;
        w.ships.alive[0] = 1;
        w.game.player[0] = 0;
        w
    }
    fn hold(w: &mut World, input: u32, secs: f64) {
        w.game.input[0] = input;
        for _ in 0..(secs / DT).round() as usize { w.step(); }
    }
    fn speed(w: &World) -> f64 { w.ships.vx[0].hypot(w.ships.vy[0]) }

    #[test]
    fn assist_set_speed_rises_holds_and_falls() {
        let mut w = world();
        hold(&mut w, IN_ASSIST | IN_THRUST, 2.0);
        assert!((w.game.set[0] - 120.0).abs() < 1.5, "set {}", w.game.set[0]);
        hold(&mut w, IN_ASSIST, 8.0);
        assert!((speed(&w) - w.game.set[0]).abs() < 2.0, "speed {} set {}", speed(&w), w.game.set[0]);
        hold(&mut w, IN_ASSIST | IN_REVERSE, 3.0);
        assert_eq!(w.game.set[0], 0.0);
        hold(&mut w, IN_ASSIST, 6.0);
        assert!(speed(&w) < 2.0, "{}", speed(&w));
    }

    #[test]
    fn burner_raises_set_speed_past_vmax_and_it_decays_after() {
        let mut w = world();
        hold(&mut w, IN_ASSIST | IN_THRUST | IN_BURN, 6.0);
        assert!(w.game.set[0] > 200.0 && w.game.set[0] <= 260.0, "{}", w.game.set[0]);
        hold(&mut w, IN_ASSIST, 4.0);
        assert!((w.game.set[0] - 200.0).abs() < 1e-9, "{}", w.game.set[0]);
    }

    #[test]
    fn manual_thrust_and_retro() {
        let mut w = world();
        hold(&mut w, IN_THRUST, 2.0);
        assert!(w.ships.vy[0] > 100.0);
        hold(&mut w, IN_RETRO, 6.0); // nose swings to face against the velocity (+y travel: face -y, angle pi)
        assert!(wrap(w.ships.ang[0] - std::f64::consts::PI).abs() < 0.1, "{}", w.ships.ang[0]);
        hold(&mut w, IN_THRUST, 3.0); // and the main engine now brakes
        assert!(w.ships.vy[0] < 20.0, "{}", w.ships.vy[0]);
    }

    #[test]
    fn strafe_slides_in_drift_off_and_does_nothing_in_full_assist() {
        let mut w = world();
        hold(&mut w, IN_STRAFE_R, 1.0);
        assert!(w.ships.vx[0] > 15.0, "{}", w.ships.vx[0]); // right is +x at angle 0
        let vx = w.ships.vx[0];
        hold(&mut w, 0, 1.0);
        assert!((w.ships.vx[0] - vx).abs() < 1e-9); // Newtonian: the slide persists
        hold(&mut w, IN_ASSIST | IN_STRAFE_R, 3.0);
        assert!(w.ships.vx[0].abs() < 1.0, "{}", w.ships.vx[0]); // full assist cancels the drift, strafe or not
    }

    #[test]
    fn full_off_spin_persists_drift_off_stops() {
        let mut w = world();
        hold(&mut w, IN_TORQUE | IN_LEFT, 0.5);
        hold(&mut w, IN_TORQUE, 1.0);
        assert!(w.ships.av[0] > 0.9, "{}", w.ships.av[0]);
        hold(&mut w, 0, 0.5);
        assert_eq!(w.ships.av[0], 0.0);
    }

    #[test]
    fn autopilot_flies_round_a_body_and_stops_over_the_target() {
        use crate::port::{BODY_PLANET, CMD_AUTOPILOT, OK};
        let mut w = World::new(Config { max_ships: 2, max_types: 1, max_bodies: 2, env_n: 8, env_w: 1000.0 }, 1);
        (w.types.accel[0], w.types.turn[0], w.types.vmax[0], w.types.well[0]) = (60.0, 1.5, 200.0, 0.35);
        w.n_bodies = 2;
        // an obstacle planet halfway along, and the target port beyond it
        for (j, x) in [10_000.0, 20_000.0].into_iter().enumerate() {
            (w.bodies.x[j], w.bodies.r[j], w.bodies.g[j], w.bodies.kind[j]) = (x, 1000.0, 30.0, BODY_PLANET);
        }
        w.bodies.port[1] = 1;
        (w.count, w.ships.alive[0], w.game.player[0]) = (1, 1, 0);
        assert_eq!(w.command(CMD_AUTOPILOT, 1, 0), OK);
        w.game.input[0] = IN_ASSIST;
        let mut closest = f64::MAX;
        for _ in 0..(400.0 / DT) as usize {
            w.step();
            closest = closest.min(hypot(w.ships.x[0] - 10_000.0, w.ships.y[0]));
            if w.game.auto[0] == 0 { break; }
        }
        assert_eq!(w.game.auto[0], 0, "never arrived: at {} {}", w.ships.x[0], w.ships.y[0]);
        assert!(closest > 1000.0, "flew through the obstacle ({closest} m from its centre)");
        assert_eq!(w.port_below().map(|(j, _)| j), Some(1));
        hold(&mut w, IN_ASSIST, 3.0);
        assert_eq!(w.port_below(), Some((1, true))); // and it holds still there: clear to land
        // the stick takes over
        w.command(CMD_AUTOPILOT, 0, 0);
        hold(&mut w, IN_ASSIST | IN_LEFT, 0.1);
        assert_eq!(w.game.auto[0], 0);
    }

    #[test]
    fn no_player_slot_means_no_control() {
        let mut w = world();
        w.game.player[0] = -1;
        hold(&mut w, IN_ASSIST | IN_THRUST, 1.0);
        assert_eq!(speed(&w), 0.0);
    }
}
