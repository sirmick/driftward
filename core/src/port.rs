//! Ports and landings: the player's game mode (flying, descending, landed, launching), the strategic day, and the
//! commands that change them. Commands are the page's only influence on the sim besides the input bitmask: the
//! page applies them between ticks and records them in the replay log, so a replay lands where the session did.
//!
//! From the Book (Docking and landing, Time): fly over a port's disc, slow to near-stationary, request landing;
//! a short descent; landed, the player is safe and flight is paused for them; each landing advances the clock by
//! a day, and so does waiting in port, which costs a docking fee. Stations need a slower approach than planets
//! (clamps, not a descent). Landing delivers the missions bound for the port. Trading commands are in market.rs,
//! mission commands in mission.rs.

use crate::market::{CMD_BUY, CMD_REPAY, CMD_SELL, NO_CREDITS};
use crate::mission::{CMD_ABANDON, CMD_ACCEPT};
use crate::world::{World, DT, P};

pub const MODE_FLYING: u8 = 0;
pub const MODE_DESCENDING: u8 = 1;
pub const MODE_LANDED: u8 = 2;
pub const MODE_LAUNCHING: u8 = 3;

pub const BODY_STAR: u8 = 0;
pub const BODY_PLANET: u8 = 1;
pub const BODY_MOON: u8 = 2;
pub const BODY_STATION: u8 = 3;

/// Request landing at the port under the player.
pub const CMD_LAND: u32 = 1;
/// Take off from the port the player is landed at.
pub const CMD_LAUNCH: u32 = 2;
/// Wait a day in port, paying the docking fee.
pub const CMD_WAIT: u32 = 3;
/// Finish a descent or launch now (the sequence is skippable).
pub const CMD_SKIP: u32 = 4;
/// Engage the fly-to autopilot toward body `a` (-1: disengage). It flies under full assist; see player.rs.
pub const CMD_AUTOPILOT: u32 = 10;
/// Debug control plane: put the flying player at rest over body `a` (a dev action, logged so replays still match).
pub const CMD_TELEPORT: u32 = 100;

pub const OK: i32 = 0;
pub const NOT_OVER_PORT: i32 = 1;
pub const TOO_FAST: i32 = 2;
pub const WRONG_MODE: i32 = 3;
pub const UNKNOWN_COMMAND: i32 = 4;
pub const NO_SUCH_BODY: i32 = 12;

/// Seconds the descent and the launch sequences take.
pub const DESCENT_S: f64 = 2.5;
pub const LAUNCH_S: f64 = 2.0;

/// The landing zone around a port body: most of a planet's or moon's disc, the middle of a station.
fn zone(kind: u8, r: f64) -> f64 { if kind == BODY_STATION { r * 0.6 } else { r * 0.95 } }

impl World {
    pub fn mode(&self) -> u8 { self.game.mode[0] }
    pub fn day(&self) -> u32 { self.game.day[0] }

    /// The port the player is over, if any, and whether they are slow enough to land there.
    pub fn port_below(&self) -> Option<(usize, bool)> {
        let i = usize::try_from(self.player.slot).ok().filter(|&i| i < self.count)?;
        let (s, b) = (&self.ships, &self.bodies);
        let mut best: Option<(usize, f64)> = None;
        for j in 0..self.n_bodies {
            if b.port[j] == 0 { continue; }
            let d = (b.x[j] - s.x[i]).hypot(b.y[j] - s.y[i]);
            if d < zone(b.kind[j], b.r[j]) && best.is_none_or(|(_, bd)| d < bd) { best = Some((j, d)); }
        }
        let (j, _) = best?;
        let limit = if b.kind[j] == BODY_STATION { self.p(P::dock_speed) } else { self.p(P::land_speed) };
        Some((j, s.vx[i].hypot(s.vy[i]) <= limit)) // bodies hold still in M1, so this is speed relative to the port
    }

    /// Apply a command now (between ticks). Returns OK or why not.
    pub fn command(&mut self, code: u32, a: i32, b: i32) -> i32 {
        let mode = self.mode();
        match code {
            CMD_LAND => {
                if mode != MODE_FLYING { return WRONG_MODE; }
                let Some((j, slow)) = self.port_below() else { return NOT_OVER_PORT };
                if !slow { return TOO_FAST; }
                let i = self.player.slot as usize;
                let s = &mut self.ships;
                s.alive[i] = 0; // out of the flight sim: the page draws the descent from the game state
                s.vx[i] = 0.0; s.vy[i] = 0.0; s.av[i] = 0.0; s.main[i] = 0.0; s.lat[i] = 0.0; s.turn_in[i] = 0.0;
                self.game.mode[0] = MODE_DESCENDING;
                self.game.at[0] = j as i16;
                self.game.auto[0] = 0;
                self.game.timer[0] = DESCENT_S;
                self.player.set = 0.0;
                OK
            }
            CMD_LAUNCH => {
                if mode != MODE_LANDED { return WRONG_MODE; }
                self.game.mode[0] = MODE_LAUNCHING;
                self.game.timer[0] = LAUNCH_S;
                OK
            }
            CMD_WAIT => {
                if mode != MODE_LANDED { return WRONG_MODE; }
                let fee = self.dock_fee();
                if self.credits() < fee { return NO_CREDITS; }
                self.game.credits[0] -= fee;
                self.next_day();
                OK
            }
            CMD_SKIP => {
                if mode != MODE_DESCENDING && mode != MODE_LAUNCHING { return WRONG_MODE; }
                self.game.timer[0] = 0.0;
                OK
            }
            CMD_BUY | CMD_SELL | CMD_REPAY => self.trade(code, a, b),
            CMD_ACCEPT | CMD_ABANDON => self.mission_command(code, a),
            CMD_AUTOPILOT => {
                if mode != MODE_FLYING { return WRONG_MODE; }
                if a < -1 || a >= self.n_bodies as i32 { return NO_SUCH_BODY; }
                self.game.auto[0] = (a + 1) as i16;
                OK
            }
            CMD_TELEPORT => {
                if mode != MODE_FLYING { return WRONG_MODE; }
                let (Some(j), Ok(i)) = (usize::try_from(a).ok().filter(|&j| j < self.n_bodies), usize::try_from(self.player.slot)) else { return NO_SUCH_BODY };
                let s = &mut self.ships;
                s.x[i] = self.bodies.x[j];
                s.y[i] = self.bodies.y[j] - self.bodies.r[j] * 0.3;
                s.vx[i] = 0.0; s.vy[i] = 0.0; s.av[i] = 0.0;
                self.player.set = 0.0;
                self.slot_reset(i, false);
                OK
            }
            _ => UNKNOWN_COMMAND,
        }
    }

    /// Put the player down at a port without the sequence (a new game starts landed).
    pub fn place_landed(&mut self, body: usize) {
        if let Ok(i) = usize::try_from(self.player.slot) {
            let s = &mut self.ships;
            s.alive[i] = 0;
            s.x[i] = self.bodies.x[body];
            s.y[i] = self.bodies.y[body] - self.bodies.r[body] * 0.3;
            s.vx[i] = 0.0; s.vy[i] = 0.0; s.av[i] = 0.0;
            self.slot_reset(i, false);
        }
        self.game.mode[0] = MODE_LANDED;
        self.game.at[0] = body as i16;
        self.game.timer[0] = 0.0;
    }

    /// The landing state machine, once per tick, before the flight stages.
    pub(crate) fn step_game(&mut self) {
        match self.mode() {
            MODE_DESCENDING => {
                self.game.timer[0] -= DT;
                if self.game.timer[0] <= 0.0 {
                    self.game.timer[0] = 0.0;
                    self.game.mode[0] = MODE_LANDED;
                    self.next_day();
                    self.deliver(self.game.at[0] as usize);
                }
            }
            MODE_LAUNCHING => {
                self.game.timer[0] -= DT;
                if self.game.timer[0] <= 0.0 {
                    self.game.timer[0] = 0.0;
                    self.game.mode[0] = MODE_FLYING;
                    let (j, orbit) = (self.game.at[0] as usize, self.p(P::launch_speed));
                    if let Ok(i) = usize::try_from(self.player.slot) {
                        let s = &mut self.ships;
                        s.alive[i] = 1;
                        // a small orbital velocity: across the line to the port's centre, counter-clockwise
                        let (dx, dy) = (s.x[i] - self.bodies.x[j], s.y[i] - self.bodies.y[j]);
                        let d = dx.hypot(dy);
                        let (tx, ty) = if d > 1e-6 { (-dy / d, dx / d) } else { (1.0, 0.0) };
                        s.vx[i] = tx * orbit;
                        s.vy[i] = ty * orbit;
                        s.prev_x[i] = s.x[i];
                        s.prev_y[i] = s.y[i];
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::Config;

    /// A planet port of radius 500 at the origin, a station port of radius 300 at (5000, 0), and the player's
    /// ship (accel 60, vmax 200) at (x, y).
    fn world(x: f64, y: f64) -> Box<World> {
        let mut w = World::new(Config { max_ships: 2, max_types: 1, max_bodies: 2, env_n: 8, env_w: 1000.0 }, 1);
        w.types.accel[0] = 60.0; w.types.turn[0] = 1.0; w.types.vmax[0] = 200.0;
        w.n_bodies = 2;
        for (j, (bx, r, kind)) in [(0.0, 500.0, BODY_PLANET), (5000.0, 300.0, BODY_STATION)].into_iter().enumerate() {
            w.bodies.x[j] = bx; w.bodies.r[j] = r; w.bodies.kind[j] = kind; w.bodies.port[j] = 1;
        }
        w.count = 1;
        w.ships.alive[0] = 1;
        w.ships.x[0] = x;
        w.ships.y[0] = y;
        w.player.slot = 0;
        w.game.credits[0] = 1000;
        w
    }
    fn run(w: &mut World, secs: f64) { for _ in 0..(secs / DT).round() as usize { w.step(); } }

    #[test]
    fn land_wait_and_launch() {
        let mut w = world(100.0, 0.0);
        assert_eq!(w.command(CMD_LAND, 0, 0), OK);
        assert_eq!(w.mode(), MODE_DESCENDING);
        assert_eq!(w.ships.alive[0], 0);
        run(&mut w, DESCENT_S - 0.1);
        assert_eq!(w.mode(), MODE_DESCENDING);
        run(&mut w, 0.2);
        assert_eq!((w.mode(), w.day(), w.game.at[0]), (MODE_LANDED, 1, 0)); // a landing costs a day
        let (x, y) = (w.ships.x[0], w.ships.y[0]);
        run(&mut w, 10.0);
        assert_eq!((w.ships.x[0], w.ships.y[0]), (x, y)); // landed: the ship is out of the flight sim
        assert_eq!(w.command(CMD_WAIT, 0, 0), OK);
        assert_eq!((w.day(), w.credits()), (2, 1000 - w.dock_fee())); // and costs a docking fee
        assert_eq!(w.command(CMD_LAUNCH, 0, 0), OK);
        run(&mut w, LAUNCH_S + 0.1);
        assert_eq!(w.mode(), MODE_FLYING);
        assert_eq!(w.ships.alive[0], 1);
        let v = w.ships.vx[0].hypot(w.ships.vy[0]);
        assert!(v > 5.0 && v < 40.0, "{v}"); // control returns with a small orbital velocity
    }

    #[test]
    fn landing_needs_a_port_below_and_a_slow_ship() {
        let mut w = world(2500.0, 0.0);
        assert_eq!(w.command(CMD_LAND, 0, 0), NOT_OVER_PORT);
        let mut w = world(100.0, 0.0);
        w.ships.vx[0] = w.p(P::land_speed) + 1.0;
        assert_eq!(w.command(CMD_LAND, 0, 0), TOO_FAST);
        // a station wants a slower approach than a planet
        let mut w = world(5000.0, 50.0);
        w.ships.vx[0] = (w.p(P::dock_speed) + w.p(P::land_speed)) / 2.0;
        assert_eq!(w.command(CMD_LAND, 0, 0), TOO_FAST);
        w.ships.vx[0] = w.p(P::dock_speed) - 1.0;
        assert_eq!(w.command(CMD_LAND, 0, 0), OK);
        assert_eq!(w.game.at[0], 1);
        assert_eq!(w.command(CMD_LAND, 0, 0), WRONG_MODE);
        assert_eq!(w.command(CMD_WAIT, 0, 0), WRONG_MODE);
        assert_eq!(w.command(99, 0, 0), UNKNOWN_COMMAND);
    }

    #[test]
    fn teleport_puts_the_player_over_a_body() {
        let mut w = world(2500.0, 0.0);
        w.ships.vx[0] = 150.0;
        assert_eq!(w.command(CMD_TELEPORT, 1, 0), OK);
        assert_eq!(w.port_below(), Some((1, true)));
        assert_eq!(w.command(CMD_TELEPORT, 2, 0), NO_SUCH_BODY);
        assert_eq!(w.command(CMD_LAND, 0, 0), OK);
        assert_eq!(w.command(CMD_TELEPORT, 0, 0), WRONG_MODE);
    }

    #[test]
    fn skip_finishes_the_sequence() {
        let mut w = world(100.0, 0.0);
        w.command(CMD_LAND, 0, 0);
        assert_eq!(w.command(CMD_SKIP, 0, 0), OK);
        w.step();
        assert_eq!(w.mode(), MODE_LANDED);
        w.command(CMD_LAUNCH, 0, 0);
        w.command(CMD_SKIP, 0, 0);
        w.step();
        assert_eq!(w.mode(), MODE_FLYING);
    }

    #[test]
    fn a_new_game_can_start_landed() {
        let mut w = world(9000.0, 0.0);
        w.place_landed(0);
        assert_eq!((w.mode(), w.ships.alive[0], w.day()), (MODE_LANDED, 0, 0));
        assert_eq!(w.command(CMD_LAUNCH, 0, 0), OK);
    }
}
