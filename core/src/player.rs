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

use crate::flight::{dir_cap, heading};
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

#[derive(Clone, Copy, Debug)]
pub struct Player {
    /// ship slot the player flies, or -1 for none (the Fly tab drives its player from JS)
    pub slot: i32,
    /// assist set speed, m/s
    pub set: f64,
    /// buttons held this tick
    pub input: u32,
}

impl Default for Player {
    fn default() -> Self { Player { slot: -1, set: 0.0, input: 0 } }
}

/// Turn this tick's input into actuator commands (or assist targets) for the player's ship.
pub fn control(w: &mut World) {
    let p = w.player;
    if p.slot < 0 || p.slot as usize >= w.count { return; }
    let i = p.slot as usize;
    if w.ships.alive[i] == 0 { return; }
    let (b_acc, b_cap, k_turn) = (w.p(P::burn_accel), w.p(P::burn_cap), w.p(P::assist_turn));
    let (k_in, k_out) = (w.p(P::well_in), w.p(P::well_out));
    let (s, t) = (&mut w.ships, &w.types);
    let k = s.kind[i] as usize;
    let (accel, turn, vmax) = (t.accel[k], t.turn[k], t.vmax[k]);
    let held = |bit: u32| p.input & bit != 0;
    let (up, down, left, right) = (held(IN_THRUST), held(IN_REVERSE), held(IN_LEFT), held(IN_RIGHT));
    s.turn_in[i] = (left as i32 - right as i32) as f64;
    let burn = up && held(IN_BURN);
    s.burn[i] = burn as u8;
    let (hx, hy) = heading(s.ang[i]);
    let mut set = p.set;
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
    w.player.set = set;
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
        w.player.slot = 0;
        w
    }
    fn hold(w: &mut World, input: u32, secs: f64) {
        w.player.input = input;
        for _ in 0..(secs / DT).round() as usize { w.step(); }
    }
    fn speed(w: &World) -> f64 { w.ships.vx[0].hypot(w.ships.vy[0]) }

    #[test]
    fn assist_set_speed_rises_holds_and_falls() {
        let mut w = world();
        hold(&mut w, IN_ASSIST | IN_THRUST, 2.0);
        assert!((w.player.set - 120.0).abs() < 1.5, "set {}", w.player.set);
        hold(&mut w, IN_ASSIST, 8.0);
        assert!((speed(&w) - w.player.set).abs() < 2.0, "speed {} set {}", speed(&w), w.player.set);
        hold(&mut w, IN_ASSIST | IN_REVERSE, 3.0);
        assert_eq!(w.player.set, 0.0);
        hold(&mut w, IN_ASSIST, 6.0);
        assert!(speed(&w) < 2.0, "{}", speed(&w));
    }

    #[test]
    fn burner_raises_set_speed_past_vmax_and_it_decays_after() {
        let mut w = world();
        hold(&mut w, IN_ASSIST | IN_THRUST | IN_BURN, 6.0);
        assert!(w.player.set > 200.0 && w.player.set <= 260.0, "{}", w.player.set);
        hold(&mut w, IN_ASSIST, 4.0);
        assert!((w.player.set - 200.0).abs() < 1e-9, "{}", w.player.set);
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
    fn no_player_slot_means_no_control() {
        let mut w = world();
        w.player.slot = -1;
        hold(&mut w, IN_ASSIST | IN_THRUST, 1.0);
        assert_eq!(speed(&w), 0.0);
    }
}
