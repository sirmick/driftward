//! The player's ship, driven by one input bitmask per tick. The bitmask is the whole of the player's
//! influence on the sim, so a recorded log of it replays a session exactly.
//!
//! The Book's three assist levels, on the same thrusters and limits:
//! - full assist (IN_ASSIST; the page's ASSIST): thrust and reverse move a throttle, 0 to 1 of the top speed where the
//!   ship is (raised in open space, bent by a well; flight.rs), sweeping the whole range in `throttle_secs`; retro is
//!   all stop. The set speed is the throttle times that top speed, so it falls as a well nears and comes back after,
//!   at the same throttle. The assist controller holds that velocity along the nose, cancelling drift and gravity,
//!   with the side thrusters; the burner (held alone) gets it there faster. Strafe does nothing here.
//! - drift off (neither bit): raw main, reverse and lateral thrusters, Newtonian; rotation still rate-controlled.
//! - full off (IN_TORQUE): as drift off, but rotation is torque: a spin persists until countered.
//!
//! In both off modes retro turns the nose against the velocity (rate-controlled while held).
//!
//! The fly-to autopilot (the Book's, from the system map; port.rs CMD_AUTOPILOT) flies under full assist: it heads for
//! the target body, round the star or any planet in the way (traffic.rs `detour`), and brakes to stop slow over it,
//! ready to land. A belt's target is the nearest point of its ring. Touching thrust, reverse or turn, or leaving full
//! assist, hands control back.
//!
//! Near a moving port (motion.rs) full assist holds its set speed relative to the port, so a set speed of zero holds
//! still over it; the autopilot flies relative to its target the same way. With assist off, matching is the pilot's
//! job, and the set speed shown is the speed along the nose relative to the port.

use crate::flight::{dir_cap, heading};
use crate::port::{BODY_BELT, BODY_STATION};
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
/// Launch missiles (missile.rs): a volley at the target whenever the bays are loaded, while held.
pub const IN_MISSILE: u32 = 1 << 11;

/// Turn this tick's input into actuator commands (or assist targets) for the player's ship.
pub fn control(w: &mut World) {
    let (slot, input) = (w.game.player[0], w.game.input[0]);
    if slot < 0 || slot as usize >= w.count { return; }
    let i = slot as usize;
    if w.ships.alive[i] == 0 { return; }
    let (fx, fy) = w.frame(w.ships.x[i], w.ships.y[i]); // the frame the assist holds still in: a moving port's, near it
    (w.game.fvx[0], w.game.fvy[0]) = (fx, fy);
    let held = |bit: u32| input & bit != 0;
    let (up, down, left, right) = (held(IN_THRUST), held(IN_REVERSE), held(IN_LEFT), held(IN_RIGHT));
    if w.game.auto[0] != 0 {
        if held(IN_ASSIST) && !(up || down || left || right) {
            if w.game.auto[0] < 0 { zone_pilot(w, i, (-1 - w.game.auto[0]) as usize); } else { autopilot(w, i); }
            return;
        }
        w.game.auto[0] = 0; // the player took the stick: carry on at the speed along the nose
        let (hx, hy) = heading(w.ships.ang[i]);
        w.hand_speed(((w.ships.vx[i] - fx) * hx + (w.ships.vy[i] - fy) * hy).max(0.0));
    }
    let top = w.top_speed(w.ships.kind[i] as usize, w.ships.x[i], w.ships.y[i]); // raised in open space (flight.rs)
    let (b_cap, k_turn, sweep) = (w.p(P::burn_cap), w.p(P::assist_turn), DT / w.p(P::throttle_secs).max(DT));
    let (k_in, k_out) = (w.p(P::well_in), w.p(P::well_out));
    let (s, t) = (&mut w.ships, &w.types);
    let k = s.kind[i] as usize;
    let turn = t.turn[k];
    s.turn_in[i] = (left as i32 - right as i32) as f64;
    // the burner: with the throttle in assist (it gets the ship to its set speed faster), with thrust off it; locked
    // while overheated, until it cools (service.rs)
    let burn = (up || held(IN_ASSIST)) && held(IN_BURN) && w.game.hot[0] == 0;
    s.burn[i] = burn as u8;
    let (hx, hy) = heading(s.ang[i]);
    // the top speed along the nose: open space raises it, and the well raises it pointing in and lowers it pointing out
    // (from last tick's well, which the forces stage keeps per ship)
    let cap = dir_cap(top * if burn { b_cap } else { 1.0 }, s.well[i], s.well_x[i], s.well_y[i], hx, hy, t.well[k], k_in, k_out);
    let set;
    if held(IN_ASSIST) {
        let mut thr = w.game.throttle[0];
        if up { thr += sweep; }
        if down { thr -= sweep; }
        if held(IN_RETRO) { thr = 0.0; } // all stop
        thr = thr.clamp(0.0, 1.0);
        w.game.throttle[0] = thr;
        set = thr * cap;
        s.ctl[i] = 3; // assist holds the velocity; the turn command stays the player's
        s.rot[i] = 0;
        s.want_vx[i] = fx + hx * set;
        s.want_vy[i] = fy + hy * set;
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
        set = ((vx - fx) * hx + (vy - fy) * hy).max(0.0);
        w.game.throttle[0] = if cap > 0.0 { (set / cap).min(1.0) } else { 0.0 }; // so assist, back on, holds this speed
    }
    w.game.set[0] = set;
}

impl World {
    /// Hand the player's ship to the assist at speed v (a launch, a jump's arrival, the autopilot letting go): the set
    /// speed, and the throttle that gives it where the ship is.
    pub(crate) fn hand_speed(&mut self, v: f64) {
        self.game.set[0] = v;
        let top = match usize::try_from(self.game.player[0]) {
            Ok(i) if i < self.count => self.top_speed(self.ships.kind[i] as usize, self.ships.x[i], self.ships.y[i]),
            _ => 0.0,
        };
        self.game.throttle[0] = if top > 0.0 { (v / top).clamp(0.0, 1.0) } else { 0.0 };
    }
}

/// Where to fly to reach body `j` from (x, y): its centre, or for a belt the nearest point of its ring.
pub fn nav_point(w: &World, j: usize, x: f64, y: f64) -> (f64, f64) {
    let (bx, by) = (w.bodies.x[j], w.bodies.y[j]);
    if w.bodies.kind[j] != BODY_BELT { return (bx, by); }
    let (dx, dy) = (x - bx, y - by);
    let d = hypot(dx, dy);
    if d < 1e-6 { return (bx + w.bodies.r[j], by); }
    (bx + dx / d * w.bodies.r[j], by + dy / d * w.bodies.r[j])
}

/// The autopilot to jump zone g (game.auto -1 - g): to a point just inside its runway's inner end (round anything in
/// the way), at the top speed there; in the runway, out along its bearing at the hull's top speed, lined up for a jump
/// (J, jump.rs), with the runway's length to press it in. It stays on until the jump or the stick takes over.
fn zone_pilot(w: &mut World, i: usize, g: usize) {
    if g >= w.n_gates() { w.game.auto[0] = 0; return; }
    let (dx, dy) = w.gate_dir(g);
    let (r, half, width) = (w.p(P::jump_radius), w.p(P::zone_len) / 2.0, w.p(P::zone_width));
    let (x, y) = (w.ships.x[i], w.ships.y[i]);
    let (along, side) = (x * dx + y * dy, y * dx - x * dy);
    let k = w.ships.kind[i] as usize;
    let inside = along > r - half && along < r + half && side.abs() < width / 2.0 - 300.0;
    let (wx, wy, v, aim) = if inside {
        let vmax = w.types.vmax[k];
        (dx, dy, vmax, (dx * (r + half), dy * (r + half)))
    } else {
        let entry = (dx * (r - half + 1500.0), dy * (r - half + 1500.0));
        let (tx, ty) = w.detour((x, y), entry, [usize::MAX, usize::MAX]).unwrap_or(entry);
        let d = hypot(tx - x, ty - y).max(1e-6);
        ((tx - x) / d, (ty - y) / d, w.top_speed(k, x, y), (tx, ty))
    };
    (w.game.aim_x[0], w.game.aim_y[0]) = aim;
    (w.game.fvx[0], w.game.fvy[0]) = (0.0, 0.0);
    let s = &mut w.ships;
    s.ctl[i] = 1; s.rot[i] = 0; s.burn[i] = 0; s.turn_in[i] = 0.0;
    s.want_vx[i] = wx * v; s.want_vy[i] = wy * v;
    w.game.set[0] = v;
}

/// The autopilot's tick: a desired velocity toward the next point (a waypoint round an obstacle, or the target),
/// capped by the hull's top speed and by a braking curve that reaches half the landing limit at `stop` metres out;
/// there, slow, it disengages, holding still over the port.
fn autopilot(w: &mut World, i: usize) {
    let j = (w.game.auto[0] - 1) as usize;
    let (x, y) = (w.ships.x[i], w.ships.y[i]);
    let (bx, by) = nav_point(w, j, x, y);
    let (tx, ty) = w.detour((x, y), (bx, by), [j, j]).unwrap_or((bx, by));
    (w.game.aim_x[0], w.game.aim_y[0]) = (tx, ty);
    let k = w.ships.kind[i] as usize;
    let (accel, vmax) = (w.types.accel[k], w.top_speed(k, x, y)); // (raised in open space)
    let limit = if w.bodies.kind[j] == BODY_STATION { w.p(P::dock_speed) } else { w.p(P::land_speed) };
    let stop = if w.bodies.kind[j] == BODY_BELT { 300.0 } else { (w.bodies.r[j] * 0.25).max(80.0) };
    let d_end = hypot(bx - x, by - y);
    // relative to the target: a moving station's velocity, fading in as the ship nears it (motion.rs)
    let (fx, fy) = w.frame_of(j, x, y);
    (w.game.fvx[0], w.game.fvy[0]) = (fx, fy);
    let (bvx, bvy) = (w.bodies.vx[j], w.bodies.vy[j]);
    let sp = hypot(w.ships.vx[i] - bvx, w.ships.vy[i] - bvy);
    if d_end < stop && sp < limit * 0.6 {
        w.game.auto[0] = 0;
        w.hand_speed(0.0);
        let s = &mut w.ships;
        s.ctl[i] = 3; s.want_vx[i] = fx; s.want_vy[i] = fy;
        return;
    }
    let s = &mut w.ships;
    let (dx, dy) = (tx - x, ty - y);
    let d = hypot(dx, dy).max(1e-6);
    // brake for the target only on the last leg (a waypoint is passed at speed)
    let v = if (tx, ty) == (bx, by) { vmax.min((2.0 * accel * 0.5 * (d - stop).max(0.0)).sqrt() * 0.8).max(limit * 0.4) } else { vmax };
    s.ctl[i] = 1; // assist faces the velocity it wants
    s.rot[i] = 0;
    s.burn[i] = 0;
    s.turn_in[i] = 0.0;
    s.want_vx[i] = fx + dx / d * v;
    s.want_vy[i] = fy + dy / d * v;
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
        w.types.fuel[0] = 10.0;
        w.game.fuel[0] = 10.0; // a tank, for the burner
        w.params[P::cruise_max as usize] = 1.0; // (no wells: all open space; these test the assist itself)
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

    /// Full assist at its top set speed in open space, flying at a body: the set speed rises with the open-space top
    /// speed and falls with it as the well nears, so the ship reaches the well's edge at about its top speed.
    #[test]
    fn full_assist_cruises_fast_in_open_space_and_slows_for_a_well() {
        let mut w = world();
        w.params[P::cruise_max as usize] = 3.0;
        (w.n_bodies, w.bodies.r[0], w.bodies.g[0]) = (1, 500.0, w.p(P::g_ref)); // a well to 1.5 km round (0, 0)
        (w.ships.y[0], w.ships.ang[0]) = (40_000.0, std::f64::consts::PI); // far out, facing it
        let (mut fastest, mut at_edge) = (0.0f64, 0.0);
        w.game.input[0] = IN_ASSIST | IN_THRUST;
        for _ in 0..(200.0 / DT) as usize {
            w.step();
            fastest = fastest.max(speed(&w));
            if w.ships.y[0] < 1500.0 { at_edge = speed(&w); break; }
        }
        assert!(fastest > 500.0, "fastest {fastest}");
        assert!(at_edge > 150.0 && at_edge < 200.0 * 1.2, "at the well's edge {at_edge}");
    }

    /// The autopilot to a jump zone: from the middle of the system, into the zone's runway and out along its bearing,
    /// fast enough and lined up to jump.
    #[test]
    fn the_zone_pilot_lines_the_ship_up_in_its_zone() {
        let mut w = world();
        w.gates.dest[0] = 7; w.gates.zone[0] = 4; // north (zone 4: 90 degrees)
        let jr = w.p(P::jump_radius);
        w.game.mode[0] = crate::port::MODE_FLYING;
        assert_eq!(w.command(crate::port::CMD_AUTOPILOT, -2, 0), crate::port::OK);
        w.game.input[0] = IN_ASSIST;
        for _ in 0..(400.0 / DT) as usize { w.step(); if w.ships.y[0] > jr { break; } }
        let (vx, vy) = (w.ships.vx[0], w.ships.vy[0]);
        assert!(w.ships.y[0] > jr && w.ships.x[0].abs() < 2000.0, "in the zone: {} {}", w.ships.x[0], w.ships.y[0]);
        assert!(vy > 0.5 * w.types.vmax[0] && vx.abs() < 0.2 * vy, "out along it, fast: {vx} {vy}");
        assert!(w.game.auto[0] < 0, "still on, for the jump");
    }

    #[test]
    fn assist_throttle_sweeps_holds_and_stops() {
        let mut w = world(); // vmax 200, throttle_secs 1
        hold(&mut w, IN_ASSIST | IN_THRUST, 0.5);
        assert!((w.game.throttle[0] - 0.5).abs() < 0.02 && (w.game.set[0] - 100.0).abs() < 4.0, "throttle {} set {}", w.game.throttle[0], w.game.set[0]);
        hold(&mut w, IN_ASSIST, 8.0);
        assert!((speed(&w) - 100.0).abs() < 4.0, "holds it: {}", speed(&w));
        hold(&mut w, IN_ASSIST | IN_THRUST, 1.0);
        assert_eq!(w.game.throttle[0], 1.0); // full, and no further
        hold(&mut w, IN_ASSIST | IN_REVERSE, 0.25);
        assert!((w.game.throttle[0] - 0.75).abs() < 0.02, "{}", w.game.throttle[0]);
        hold(&mut w, IN_ASSIST | IN_RETRO, DT); // X: all stop
        assert_eq!((w.game.throttle[0], w.game.set[0]), (0.0, 0.0));
        hold(&mut w, IN_ASSIST, 8.0);
        assert!(speed(&w) < 2.0, "{}", speed(&w));
    }

    #[test]
    fn the_burner_gets_the_assist_to_its_set_speed_faster() {
        let (mut plain, mut burn) = (world(), world());
        plain.game.throttle[0] = 1.0; burn.game.throttle[0] = 1.0;
        hold(&mut plain, IN_ASSIST, 1.0);
        hold(&mut burn, IN_ASSIST | IN_BURN, 1.0); // the burner alone, the throttle already full
        assert!(speed(&burn) > 1.8 * speed(&plain), "{} vs {}", speed(&burn), speed(&plain));
        assert!(burn.game.set[0] <= 200.0 + 1e-9 && burn.game.heat[0] > 0.0);
        hold(&mut burn, IN_ASSIST | IN_BURN, 4.0);
        assert!(speed(&burn) <= 200.0 + 1.0, "the same top speed: {}", speed(&burn));
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
    fn autopilot_flies_through_a_field_to_the_nearest_point_of_a_belt() {
        use crate::port::{BODY_FIELD, CMD_AUTOPILOT, OK};
        let mut w = World::new(Config { max_ships: 2, max_types: 1, max_bodies: 2, env_n: 8, env_w: 1000.0 }, 1);
        (w.types.accel[0], w.types.turn[0], w.types.vmax[0], w.types.well[0]) = (60.0, 1.5, 200.0, 0.35);
        w.n_bodies = 2;
        // a belt round the origin, 8 km out, and a field in the way, which is no obstacle
        (w.bodies.r[0], w.bodies.kind[0]) = (8000.0, BODY_BELT);
        (w.bodies.x[1], w.bodies.r[1], w.bodies.kind[1]) = (4000.0, 1500.0, BODY_FIELD);
        (w.count, w.ships.alive[0], w.game.player[0]) = (1, 1, 0);
        (w.ships.x[0], w.ships.y[0]) = (500.0, 300.0);
        assert_eq!(nav_point(&w, 0, 500.0, 300.0), (8000.0 * 500.0 / hypot(500.0, 300.0), 8000.0 * 300.0 / hypot(500.0, 300.0)));
        assert_eq!(w.command(CMD_AUTOPILOT, 0, 0), OK);
        w.game.input[0] = IN_ASSIST;
        let mut wide = 0.0f64;
        for _ in 0..(300.0 / DT) as usize {
            w.step();
            wide = wide.max((w.ships.y[0] / w.ships.x[0] - 0.6).abs());
            if w.game.auto[0] == 0 { break; }
        }
        assert_eq!(w.game.auto[0], 0, "never arrived: at {} {}", w.ships.x[0], w.ships.y[0]);
        assert!(wide < 0.05, "it flew straight out through the field (strayed {wide} off the line)");
        let d = hypot(w.ships.x[0], w.ships.y[0]);
        assert!((d - 8000.0).abs() < 300.0 && hypot(w.ships.vx[0], w.ships.vy[0]) < w.p(P::land_speed), "stopped in the belt: {d} m out");
    }

    #[test]
    fn no_player_slot_means_no_control() {
        let mut w = world();
        w.game.player[0] = -1;
        hold(&mut w, IN_ASSIST | IN_THRUST, 1.0);
        assert_eq!(speed(&w), 0.0);
    }
}
