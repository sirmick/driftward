//! Jumping between systems along the lanes (the Book's Jumping chapter, M4; the design as built is docs/jumping.md).
//!
//! Gates: a system's lanes, as content (written by the page from the universe index, stored in the atlas with the rest
//! of the system). Round every system are 16 zones, one every 22.5 degrees at `jump_radius` from the star; each lane
//! takes the zone nearest its bearing toward its destination (the page assigns them), so a lane's zone works both
//! ways: you leave Brannock from its Calder zone and arrive at Calder's Brannock zone. A zone is a runway along its
//! bearing, `zone_len` long and `zone_width` wide, centred on the jump radius. A system without gates keeps the four
//! compass zones traffic used before (traffic.rs `jump_point`).
//!
//! The jump (`CMD_HYPER` with a = -1), in phases on the game row (`game.jump`):
//! - TORCH: in a gate's zone, moving outward along it (within `jump_align` degrees) at `jump_min` of top speed or more,
//!   with the lane's fuel aboard, the drive takes the ship (on rails: the flight stages skip it) and accelerates it
//!   along the bearing at `torch_accel` top speeds a second, burning half the lane's fuel on the way, to `jump_speed`
//!   times top speed;
//! - TRANSIT: then it blinks out: the rest of the fuel goes, the clock advances by the lane's days, and the core
//!   switches to the destination system (its traffic and boards, as the debug jump does); the ship is out of the sim
//!   for `transit_secs` while the page plays the trip on the galaxy map. In the last `chain_window` seconds a J
//!   (`CMD_HYPER` with a = the next lane's gate in the destination) chains; a J before the window wastes the chance;
//! - ARRIVE: unchained, the ship appears in the destination's zone for the lane it came by, at jump speed, heading in,
//!   and slows to top speed over `arrive_secs`, then the pilot has it back;
//! - chained, it appears instead in the zone of the next lane, already lined up at jump speed: TORCH again (coasting
//!   `chain_coast` seconds first), so it blinks straight out, the next lane's fuel times `chain_cost` spent at once.
//!
//! The destination must be in the atlas when the jump blinks (the page stores it before the command, logged for
//! replays). Everything here is core state on the game row, so saves and replays follow jumps exactly.

use crate::atlas::NO_SYSTEM;
use crate::cols::soa;
use crate::math::{atan2, hypot, sin_cos, PI};
use crate::port::{MODE_FLYING, NO_SUCH_BODY, OK, WRONG_MODE};
use crate::world::{World, DT, P};

/// Zones round a system, and so the most lanes one can have.
pub const MAX_GATES: usize = 16;

/// Jump: from the zone the player is in (a = -1), or during a transit's window, chain on by gate `a` of the
/// destination.
pub const CMD_HYPER: u32 = 13;
/// Debug control plane: put the flying player in gate `a`'s zone, lined up and moving outward at top speed.
pub const CMD_ZONE: u32 = 102;

pub const NOT_IN_ZONE: i32 = 15;
pub const NOT_LINED_UP: i32 = 16;
pub const TOO_SLOW: i32 = 17;
pub const NO_FUEL: i32 = 18;
/// The destination is not in the atlas (the page stores it first) or the gate does not exist.
pub const NO_CHART: i32 = 19;
/// A chain J outside its window (too early, or after a miss).
pub const MISSED: i32 = 20;

pub const J_NONE: u8 = 0;
pub const J_TORCH: u8 = 1;
pub const J_TRANSIT: u8 = 2;
pub const J_ARRIVE: u8 = 3;

/// game.jchain while in transit: no chain asked for; a J came too early (the chance is gone)
const CHAIN_NONE: i16 = -1;
const CHAIN_MISSED: i16 = -2;

soa! {
    /// A system's lanes (MAX_GATES rows, NO_SYSTEM past the last): the star id each leads to, its zone (0..16, zone k on
    /// the bearing k * 22.5 degrees counter-clockwise from +x), and its length in light years and days.
    pub struct Gates { dest: u32, zone: u8, ly: f64, days: f64 }
}

impl World {
    /// The live system's gates.
    pub fn n_gates(&self) -> usize { (0..MAX_GATES).take_while(|&g| self.gates.dest[g] != NO_SYSTEM).count() }

    /// Gate `g`'s bearing, as a unit vector.
    pub fn gate_dir(&self, g: usize) -> (f64, f64) { let (s, c) = sin_cos(self.gates.zone[g] as f64 * PI / 8.0); (c, s) }

    /// The gate whose zone holds (x, y), if any.
    pub fn zone_at(&self, x: f64, y: f64) -> Option<usize> {
        let (r, half_l, half_w) = (self.p(P::jump_radius), self.p(P::zone_len) / 2.0, self.p(P::zone_width) / 2.0);
        (0..self.n_gates()).find(|&g| {
            let (dx, dy) = self.gate_dir(g);
            let along = x * dx + y * dy;
            (along - r).abs() <= half_l && (x * dy - y * dx).abs() <= half_w
        })
    }

    /// Tons of fuel gate `g`'s lane costs a ship of type `kind`: the lane's length times `jump_fuel`, as a share of the
    /// hull's tank (`ly` given, for a gate of another system).
    pub fn lane_fuel(&self, kind: usize, ly: f64) -> f64 { self.types.fuel[kind] * ly * self.p(P::jump_fuel) }

    fn jump_vmax(&self, i: usize) -> f64 { self.types.vmax[self.ships.kind[i] as usize] }

    /// The jump command (see the module comment).
    pub(crate) fn hyper(&mut self, a: i32) -> i32 {
        let Ok(i) = usize::try_from(self.game.player[0]) else { return WRONG_MODE };
        if self.mode() != MODE_FLYING { return WRONG_MODE; }
        match self.game.jump[0] {
            J_NONE => {
                let (x, y, vx, vy) = (self.ships.x[i], self.ships.y[i], self.ships.vx[i], self.ships.vy[i]);
                let Some(g) = self.zone_at(x, y) else { return NOT_IN_ZONE };
                if self.atlas_find(self.gates.dest[g]).is_none() { return NO_CHART; }
                let (dx, dy) = self.gate_dir(g);
                let (v, vmax) = (hypot(vx, vy), self.jump_vmax(i));
                if v < self.p(P::jump_min) * vmax { return TOO_SLOW; }
                if (vx * dx + vy * dy) < v * (self.p(P::jump_align) * PI / 180.0).cos() { return NOT_LINED_UP; }
                let cost = self.lane_fuel(self.ships.kind[i] as usize, self.gates.ly[g]);
                if self.game.fuel[0] < cost { return NO_FUEL; }
                self.start_torch(i, g, cost, 0.0);
                OK
            }
            J_TRANSIT => {
                let t = self.game.jt[0];
                if self.game.jchain[0] != CHAIN_NONE { return MISSED; }
                if t < self.p(P::transit_secs) - self.p(P::chain_window) { self.game.jchain[0] = CHAIN_MISSED; return MISSED; }
                // gate a of the system we are bound for (live now: the switch came at the blink)
                let Some(g) = usize::try_from(a).ok().filter(|&g| g < self.n_gates()) else { return NO_CHART };
                if self.atlas_find(self.gates.dest[g]).is_none() { return NO_CHART; }
                let cost = self.lane_fuel(self.ships.kind[i] as usize, self.gates.ly[g]) * self.p(P::chain_cost);
                if self.game.fuel[0] < cost { return NO_FUEL; }
                self.game.jchain[0] = g as i16;
                OK
            }
            _ => WRONG_MODE,
        }
    }

    /// The drive takes the ship along gate g's bearing; `coast` seconds at the speed it has before accelerating.
    fn start_torch(&mut self, i: usize, g: usize, cost: f64, coast: f64) {
        let (dx, dy) = self.gate_dir(g);
        let v = hypot(self.ships.vx[i], self.ships.vy[i]);
        let gm = &mut self.game;
        (gm.jump[0], gm.jgate[0], gm.jt[0], gm.jv0[0], gm.jcost[0], gm.jburnt[0], gm.jchain[0]) = (J_TORCH, g as i16, -coast, v, cost, 0.0, CHAIN_NONE);
        gm.auto[0] = 0; // the autopilot lets go
        let s = &mut self.ships;
        s.rail[i] = 1;
        s.vx[i] = dx * v; s.vy[i] = dy * v; s.av[i] = 0.0;
        s.ang[i] = atan2(-dx, dy);
    }

    /// The jump's tick, before the flight stages (which skip the player while the drive has it).
    pub(crate) fn step_jump(&mut self) {
        let Ok(i) = usize::try_from(self.game.player[0]) else { return };
        match self.game.jump[0] {
            J_TORCH => {
                self.game.jt[0] += DT;
                let g = self.game.jgate[0] as usize;
                let (dx, dy) = self.gate_dir(g);
                let vmax = self.jump_vmax(i);
                let vj = self.p(P::jump_speed) * vmax;
                let v = hypot(self.ships.vx[i], self.ships.vy[i]);
                let v = if self.game.jt[0] > 0.0 { (v + self.p(P::torch_accel) * vmax * DT).min(vj) } else { v };
                // half the lane's fuel, burnt as the speed builds (a chained blink spends it all at once)
                let v0 = self.game.jv0[0];
                let target = if vj > v0 { 0.5 * self.game.jcost[0] * ((v - v0) / (vj - v0)).clamp(0.0, 1.0) } else { 0.0 };
                self.game.fuel[0] = (self.game.fuel[0] - (target - self.game.jburnt[0])).max(0.0);
                self.game.jburnt[0] = target;
                let s = &mut self.ships;
                (s.vx[i], s.vy[i]) = (dx * v, dy * v);
                s.x[i] += s.vx[i] * DT; s.y[i] += s.vy[i] * DT;
                s.thr[i] = 1.0; s.burn[i] = 1;
                if v >= vj && self.game.jt[0] >= 0.0 { self.blink(i); }
            }
            J_TRANSIT => {
                self.game.jt[0] += DT;
                if self.game.jt[0] >= self.p(P::transit_secs) { self.jump_arrive(i); }
            }
            J_ARRIVE => {
                self.game.jt[0] += DT;
                let (t, total) = (self.game.jt[0], self.p(P::arrive_secs));
                let vmax = self.jump_vmax(i);
                let vj = self.p(P::jump_speed) * vmax;
                let f = (1.0 - t / total).max(0.0);
                let v = vmax + (vj - vmax) * f * f;
                let s = &mut self.ships;
                let sp = hypot(s.vx[i], s.vy[i]).max(1e-9);
                (s.vx[i], s.vy[i]) = (s.vx[i] / sp * v, s.vy[i] / sp * v);
                s.x[i] += s.vx[i] * DT; s.y[i] += s.vy[i] * DT;
                s.thr[i] = 0.0; s.burn[i] = 0;
                if t >= total {
                    s.rail[i] = 0;
                    self.game.jump[0] = J_NONE;
                    self.hand_speed(vmax); // the assist holds what the drive handed back
                }
            }
            _ => {}
        }
    }

    /// Out of the system: the rest of the fuel, the lane's days, and the switch to the destination; the transit begins.
    fn blink(&mut self, i: usize) {
        let g = self.game.jgate[0] as usize;
        let (dest, days) = (self.gates.dest[g], self.gates.days[g]);
        let Some(k) = self.atlas_find(dest) else { self.end_jump(i); return };
        let from = self.atlas_sys.id[self.game.system[0] as usize];
        self.game.fuel[0] = (self.game.fuel[0] - (self.game.jcost[0] - self.game.jburnt[0])).max(0.0);
        self.game.jburnt[0] = self.game.jcost[0];
        // the clock: the lane's days, carried in fractions
        self.game.day_part[0] += days;
        while self.game.day_part[0] >= 1.0 { self.game.day_part[0] -= 1.0; self.next_day(); }
        // the system left behind: its traffic, lanes and boards go; the new one's start (as the debug jump)
        for s in 0..self.count { if s != i { self.ships.alive[s] = 0; } }
        self.count = self.count.min(i + 1);
        self.traffic.clear();
        self.route.clear();
        self.lanes.clear();
        self.jlanes.clear();
        self.offers.clear();
        self.atlas_load(k);
        self.post_boards();
        self.plan_traffic();
        self.seed_traffic();
        let gm = &mut self.game;
        (gm.jump[0], gm.jt[0], gm.jfrom[0], gm.jchain[0], gm.at[0]) = (J_TRANSIT, 0.0, from, CHAIN_NONE, 0);
        let s = &mut self.ships;
        s.alive[i] = 0; s.thr[i] = 0.0; s.burn[i] = 0;
    }

    /// Back in the sim: in the zone of the lane come by (heading in, slowing), or chained, the next lane's (on out).
    fn jump_arrive(&mut self, i: usize) {
        let vj = self.p(P::jump_speed) * self.jump_vmax(i);
        let (r, w) = (self.p(P::jump_radius), self.p(P::zone_width));
        let chain = usize::try_from(self.game.jchain[0]).ok().filter(|&g| g < self.n_gates() && self.atlas_find(self.gates.dest[g]).is_some());
        let lateral = self.rng.range(-0.3, 0.3) * w;
        if let Some(g) = chain {
            // the next lane's zone, at its inner end, already at speed along it
            let (dx, dy) = self.gate_dir(g);
            let at = r - self.p(P::zone_len) * 0.25;
            let cost = self.lane_fuel(self.ships.kind[i] as usize, self.gates.ly[g]) * self.p(P::chain_cost);
            let s = &mut self.ships;
            s.alive[i] = 1;
            s.x[i] = dx * at - dy * lateral; s.y[i] = dy * at + dx * lateral;
            s.vx[i] = dx * vj; s.vy[i] = dy * vj;
            self.slot_reset(i, false);
            self.start_torch(i, g, cost, self.p(P::chain_coast));
            self.game.jburnt[0] = 0.0; self.game.jv0[0] = vj; // all of it at the blink
            return;
        }
        // the zone of the lane come by (the four compass zones' north if the system has none for it)
        let from = self.game.jfrom[0];
        let (dx, dy) = match (0..self.n_gates()).find(|&g| self.gates.dest[g] == from) { Some(g) => self.gate_dir(g), None => (0.0, 1.0) };
        let s = &mut self.ships;
        s.alive[i] = 1; s.rail[i] = 1;
        s.x[i] = dx * r - dy * lateral; s.y[i] = dy * r + dx * lateral;
        s.vx[i] = -dx * vj; s.vy[i] = -dy * vj; s.av[i] = 0.0;
        s.ang[i] = atan2(dx, -dy);
        self.slot_reset(i, false);
        let gm = &mut self.game;
        (gm.jump[0], gm.jt[0], gm.mode[0], gm.auto[0]) = (J_ARRIVE, 0.0, MODE_FLYING, 0);
    }

    /// Give the ship back where it is (a jump that cannot go on).
    fn end_jump(&mut self, i: usize) {
        self.ships.rail[i] = 0;
        self.game.jump[0] = J_NONE;
    }

    /// The dev command: in gate g's zone at its inner end, lined up and moving outward at top speed.
    pub(crate) fn to_zone(&mut self, a: i32) -> i32 {
        if self.mode() != MODE_FLYING || self.game.jump[0] != J_NONE { return WRONG_MODE; }
        let (Some(g), Ok(i)) = (usize::try_from(a).ok().filter(|&g| g < self.n_gates()), usize::try_from(self.game.player[0])) else { return NO_SUCH_BODY };
        let (dx, dy) = self.gate_dir(g);
        let (at, v) = (self.p(P::jump_radius) - self.p(P::zone_len) * 0.35, self.jump_vmax(i));
        let s = &mut self.ships;
        (s.x[i], s.y[i], s.vx[i], s.vy[i], s.av[i]) = (dx * at, dy * at, dx * v, dy * v, 0.0);
        s.ang[i] = atan2(-dx, dy);
        self.game.auto[0] = 0;
        self.slot_reset(i, false);
        self.hand_speed(v);
        OK
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::{BODY_PLANET, BODY_STAR, CMD_LAND, CMD_LAUNCH};
    use crate::replay::{run, LogEntry};
    use crate::world::Config;

    /// Three systems in a row, A (star 100) - B (101) - C (102), each a star and a port planet; A's lane to B leaves
    /// east (zone 0), B's to A west (zone 8) and to C east, C's to B west. The player flies in A, a 4 t tank full.
    fn three_systems() -> Box<World> {
        let mut w = World::new(Config { max_ships: 32, max_types: 1, max_bodies: 4, env_n: 4, env_w: 1000.0 }, 7);
        (w.types.accel[0], w.types.turn[0], w.types.vmax[0], w.types.cargo[0], w.types.fuel[0], w.types.hull[0]) = (60.0, 1.0, 300.0, 50, 4.0, 100.0);
        let lanes: [&[(u32, u8)]; 3] = [&[(101, 0)], &[(100, 8), (102, 0)], &[(101, 8)]];
        for k in 0..3 {
            w.n_bodies = 2;
            for (j, (x, r, kind, port)) in [(0.0, 2000.0, BODY_STAR, 0), (12_000.0 + 3000.0 * k as f64, 800.0, BODY_PLANET, 1)].into_iter().enumerate() {
                (w.bodies.x[j], w.bodies.y[j], w.bodies.r[j], w.bodies.kind[j], w.bodies.port[j], w.bodies.pop[j]) = (x, 0.0, r, kind, port, port as f64 * 5.0);
            }
            w.gates.dest.fill(NO_SYSTEM);
            for (g, &(dest, zone)) in lanes[k].iter().enumerate() { (w.gates.dest[g], w.gates.zone[g], w.gates.ly[g], w.gates.days[g]) = (dest, zone, 4.5, 1.5); }
            assert!(w.atlas_store(k, 100 + k as u32));
        }
        w.clear();
        w.atlas_load(0);
        w.count = 1;
        w.ships.alive[0] = 1;
        w.game.player[0] = 0;
        (w.game.credits[0], w.game.day[0], w.game.fuel[0]) = (1000, 1, 4.0);
        w.ships.hull[0] = 100.0;
        w
    }

    fn steps(w: &mut World, secs: f64) { for _ in 0..(secs / DT).round() as usize { w.step(); } }

    #[test]
    fn gates_take_their_zones_and_the_jump_wants_zone_line_speed_and_fuel() {
        let mut w = three_systems();
        assert_eq!((w.n_gates(), w.n_zones()), (1, 1));
        let r = w.p(P::jump_radius);
        assert_eq!((w.zone_at(r, 0.0), w.zone_at(r + 5000.0, 2900.0), w.zone_at(r, 3500.0), w.zone_at(0.0, r)), (Some(0), Some(0), None, None));
        assert_eq!(w.jump_point(0), (r, 0.0));
        let vmax = w.types.vmax[0];
        let at = |w: &mut World, x: f64, y: f64, vx: f64, vy: f64| { (w.ships.x[0], w.ships.y[0], w.ships.vx[0], w.ships.vy[0]) = (x, y, vx, vy); };
        at(&mut w, 0.0, r, vmax, 0.0);
        assert_eq!(w.command(CMD_HYPER, -1, 0), NOT_IN_ZONE);
        at(&mut w, r, 0.0, 0.4 * vmax, 0.0);
        assert_eq!(w.command(CMD_HYPER, -1, 0), TOO_SLOW);
        at(&mut w, r, 0.0, 0.0, vmax);
        assert_eq!(w.command(CMD_HYPER, -1, 0), NOT_LINED_UP);
        at(&mut w, r, 0.0, vmax * 0.95, vmax * 0.3); // 17.5 degrees off: lined up
        w.game.fuel[0] = 0.5;
        assert_eq!(w.command(CMD_HYPER, -1, 0), NO_FUEL); // 4 t x 4.5 ly x 0.05 = 0.9 t
        w.game.fuel[0] = 4.0;
        w.atlas_reset();
        w.gates.dest[0] = 101;
        assert_eq!(w.command(CMD_HYPER, -1, 0), NO_CHART); // the destination is not in the atlas
    }

    #[test]
    fn a_jump_torches_blinks_crosses_and_arrives_in_the_zone_facing_where_it_left() {
        let mut w = three_systems();
        assert_eq!(w.command(CMD_ZONE, 0, 0), OK);
        let vmax = w.types.vmax[0];
        assert_eq!(w.command(CMD_HYPER, -1, 0), OK);
        assert_eq!((w.game.jump[0], w.ships.rail[0]), (J_TORCH, 1));
        assert_eq!(w.command(CMD_LAND, 0, 0), WRONG_MODE, "the drive has the ship");
        steps(&mut w, 1.0);
        let v = hypot(w.ships.vx[0], w.ships.vy[0]);
        assert!(v > 2.5 * vmax && w.ships.vy[0].abs() < 1e-9, "accelerating along the bearing: {v}");
        assert!(w.game.fuel[0] < 4.0 && w.game.fuel[0] > 4.0 - 0.9 / 2.0 - 1e-9, "half the lane's fuel on the way: {}", w.game.fuel[0]);
        steps(&mut w, 2.0); // 1 to 6 top speeds at 2 a second: blinked at 2.5 s
        assert_eq!((w.game.jump[0], w.game.system[0], w.ships.alive[0], w.day()), (J_TRANSIT, 1, 0, 2));
        assert!((w.game.fuel[0] - (4.0 - 0.9)).abs() < 1e-9 && (w.game.day_part[0] - 0.5).abs() < 1e-9);
        { let s_ = w.p(P::transit_secs); steps(&mut w, s_); }
        // B's gate back to A is its zone 8: west, so the ship comes in from the west, heading east at jump speed
        assert_eq!((w.game.jump[0], w.ships.alive[0]), (J_ARRIVE, 1));
        let r = w.p(P::jump_radius);
        assert!(w.ships.x[0] < -r + 2000.0 && w.ships.vx[0] > 4.0 * vmax, "at {} moving {}", w.ships.x[0], w.ships.vx[0]);
        { let s_ = w.p(P::arrive_secs) + 0.1; steps(&mut w, s_); }
        assert_eq!((w.game.jump[0], w.ships.rail[0]), (J_NONE, 0));
        assert!((hypot(w.ships.vx[0], w.ships.vy[0]) - vmax).abs() < 30.0 && w.ships.vx[0] > 0.0, "slowed to top speed, heading in");
        // the next jump's days carry the half day over
        assert_eq!(w.command(CMD_ZONE, 1, 0), OK);
        assert_eq!(w.command(CMD_HYPER, -1, 0), OK);
        steps(&mut w, 3.0);
        assert_eq!((w.game.system[0], w.day(), w.game.day_part[0]), (2, 4, 0.0));
    }

    #[test]
    fn a_j_in_the_window_chains_on_and_an_early_one_misses() {
        // chained: B's lane to C is gate 1; in the window the ship comes out in that zone at speed and blinks again
        let mut w = three_systems();
        w.command(CMD_ZONE, 0, 0);
        w.command(CMD_HYPER, -1, 0);
        steps(&mut w, 2.6);
        assert_eq!(w.game.jump[0], J_TRANSIT);
        let window = w.p(P::transit_secs) - w.p(P::chain_window);
        steps(&mut w, window + 0.1);
        assert_eq!(w.command(CMD_HYPER, 1, 0), OK);
        assert_eq!(w.command(CMD_HYPER, 1, 0), MISSED, "once");
        let fuel = w.game.fuel[0];
        { let s_ = w.p(P::chain_window); steps(&mut w, s_); }
        assert_eq!((w.game.jump[0], w.game.system[0], w.ships.alive[0]), (J_TORCH, 1, 1));
        let r = w.p(P::jump_radius);
        assert!(w.ships.x[0] > r - w.p(P::zone_len) / 2.0 && w.ships.vx[0] > 5.9 * w.types.vmax[0], "in B's zone to C, at speed");
        { let s_ = w.p(P::chain_coast) + 0.1; steps(&mut w, s_); }
        assert_eq!((w.game.jump[0], w.game.system[0]), (J_TRANSIT, 2));
        assert!((fuel - w.game.fuel[0] - 0.9).abs() < 1e-9, "the next lane's fuel, at the blink");
        // early: a J before the window wastes the chance, and the arrival is the normal one
        let mut w = three_systems();
        w.command(CMD_ZONE, 0, 0);
        w.command(CMD_HYPER, -1, 0);
        steps(&mut w, 2.6 + 0.5);
        assert_eq!(w.command(CMD_HYPER, 1, 0), MISSED);
        { let s_ = w.p(P::transit_secs) - 0.6; steps(&mut w, s_); }
        assert_eq!(w.command(CMD_HYPER, 1, 0), MISSED, "the window opened, but the chance is gone");
        steps(&mut w, 0.2);
        assert_eq!((w.game.jump[0], w.game.system[0]), (J_ARRIVE, 1));
    }

    #[test]
    fn a_session_with_a_chained_jump_replays() {
        let mut live = three_systems();
        live.save();
        let start = live.snapshot().to_vec();
        let t_chain = ((2.6 + 4.0 - 0.3) / DT) as u64;
        let log = vec![LogEntry::Command { tick: 0, code: CMD_ZONE, a: 0, b: 0 }, LogEntry::Command { tick: 0, code: CMD_HYPER, a: -1, b: 0 },
            LogEntry::Command { tick: t_chain, code: CMD_HYPER, a: 1, b: 0 }];
        run(&mut live, &log, 1200);
        assert_eq!(live.game.system[0], 2);
        let mut again = World::from_snapshot(&start).unwrap();
        run(&mut again, &log, 1200);
        assert_eq!(live.hash(), again.hash());
    }

    #[test]
    fn traffic_comes_and_goes_by_the_gates() {
        let mut w = three_systems();
        w.atlas_load(1); // B: gates west and east
        let r = w.p(P::jump_radius);
        assert_eq!((w.n_zones(), w.jump_point(0), w.jump_point(1)), (2, (-r, crate::math::sin_cos(PI).0 * r), (r, 0.0)));
        let _ = CMD_LAUNCH;
    }
}
