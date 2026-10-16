//! Moving bodies (M1): stations that orbit their parents. From the Book (Docking at stations): ring stations spin
//! and some orbit, so "still" means matched to the station's velocity; assist does the matching (player.rs `frame`),
//! and with assist off it is a skill.
//!
//! A body orbits `orb_r` metres from its parent, at angle `orb_a + orb_w t` (t the game clock, ticks times DT), so its
//! place is a function of the clock alone: a save, a load, a jump and a replay all find it where it should be. Only
//! bodies with `orb_w` set move (the page sets it from a station's `motion` in its system file); planets, moons and
//! the stars hold still, as in EV. Spin is drawn, not simulated: a station docks at its centre.
//!
//! Each tick, what is attached to a moving body moves with it: the player's ship while docked there or in a docking
//! or launch sequence; traffic ships launching from it or docking at it; and traffic routes, whose end at the body (and
//! start, while the ship is still launching) follows it, and a loiter's whole loop round it. A route's waypoints
//! between are left where they were laid.

use crate::math::sin_cos;
use crate::port::{MODE_FLYING, MODE_DEAD};
use crate::traffic::{End, LOITER, MAX_PTS, T_LAUNCH, T_LAND};
use crate::world::{World, DT};

impl World {
    /// Set body j turning on the orbit `place_body` gave it: one turn every `period` seconds, counter-clockwise (a
    /// negative period turns it clockwise; 0 holds it still).
    pub fn body_motion(&mut self, j: usize, period: f64) {
        let b = &mut self.bodies;
        b.orb_w[j] = if period == 0.0 || b.orb_p[j] < 0 { 0.0 } else { crate::math::TAU / period };
        // where it is now, moving (the clock is at 0 when a system is laid out, so it stays where it was placed)
        self.orbit_bodies(self.tick as f64 * DT);
        let b = &mut self.bodies;
        (b.prev_x[j], b.prev_y[j], b.rx[j], b.ry[j]) = (b.x[j], b.y[j], b.x[j], b.y[j]);
    }

    /// Put every moving body where its orbit has it at time t (seconds), with its velocity. Parents come first in
    /// body order, so a body round a moving parent follows it.
    pub fn orbit_bodies(&mut self, t: f64) {
        let b = &mut self.bodies;
        for j in 0..self.n_bodies {
            if b.orb_w[j] == 0.0 || b.orb_p[j] < 0 { continue; }
            let p = b.orb_p[j] as usize;
            let (w, r) = (b.orb_w[j], b.orb_r[j]);
            let (s, c) = sin_cos(b.orb_a[j] + w * t);
            b.x[j] = b.x[p] + c * r;
            b.y[j] = b.y[p] + s * r;
            b.vx[j] = b.vx[p] - s * r * w;
            b.vy[j] = b.vy[p] + c * r * w;
        }
    }

    /// The bodies stage, first in the tick: last tick's positions kept for the render, the moving bodies placed for
    /// the end of this tick, and what is attached to each carried along by as much as it moved.
    pub(crate) fn move_bodies(&mut self) {
        let nb = self.n_bodies;
        {
            let b = &mut self.bodies;
            b.prev_x[..nb].copy_from_slice(&b.x[..nb]);
            b.prev_y[..nb].copy_from_slice(&b.y[..nb]);
        }
        if !(0..nb).any(|j| self.bodies.orb_w[j] != 0.0) { return; }
        self.orbit_bodies((self.tick + 1) as f64 * DT);
        for j in 0..nb {
            let (dx, dy) = (self.bodies.x[j] - self.bodies.prev_x[j], self.bodies.y[j] - self.bodies.prev_y[j]);
            if dx == 0.0 && dy == 0.0 { continue; }
            // the player, docked or in a sequence here
            let mode = self.game.mode[0];
            if mode != MODE_FLYING && mode != MODE_DEAD && self.game.at[0] as usize == j
                && let Ok(i) = usize::try_from(self.game.player[0]) && i < self.count { self.ships.x[i] += dx; self.ships.y[i] += dy; }
            // traffic: ships launching from or docking at it, and the ends of routes there
            for k in 0..self.count {
                if self.traffic.role[k] == 0 { continue; }
                let (from, to, phase) = (End::of(self.traffic.from[k]), End::of(self.traffic.to[k]), self.traffic.phase[k]);
                let (at_from, at_to) = (from == End::Body(j), to == End::Body(j));
                if !at_from && !at_to { continue; }
                if (at_from && phase == T_LAUNCH) || (at_to && phase == T_LAND) { self.ships.x[k] += dx; self.ships.y[k] += dy; }
                let n = self.traffic.npts[k] as usize;
                let base = k * MAX_PTS;
                let r = &mut self.route;
                if self.traffic.role[k] == LOITER && at_from && at_to {
                    for p in 0..n { r.x[base + p] += dx; r.y[base + p] += dy; }
                } else {
                    if at_from && phase == T_LAUNCH { r.x[base] += dx; r.y[base] += dy; }
                    if at_to && n > 0 { r.x[base + n - 1] += dx; r.y[base + n - 1] += dy; }
                }
                self.route_lengths(k);
            }
        }
    }

    /// Recompute slot k's route distances after its points moved.
    fn route_lengths(&mut self, k: usize) {
        let (n, base) = (self.traffic.npts[k] as usize, k * MAX_PTS);
        let r = &mut self.route;
        let mut len = 0.0;
        for p in 0..n {
            if p > 0 { len += (r.x[base + p] - r.x[base + p - 1]).hypot(r.y[base + p] - r.y[base + p - 1]); }
            r.s[base + p] = len;
        }
        self.traffic.len[k] = len;
    }

    /// The velocity of the frame a ship at (x, y) should hold still in near moving body j: the body's own, fading
    /// in from `match_reach` of its radii to half as near (0 for a body that holds still).
    pub fn frame_of(&self, j: usize, x: f64, y: f64) -> (f64, f64) {
        let b = &self.bodies;
        if b.orb_w[j] == 0.0 { return (0.0, 0.0); }
        let reach = b.r[j] * self.p(crate::world::P::match_reach);
        let d = (x - b.x[j]).hypot(y - b.y[j]);
        let q = ((reach - d) / (reach * 0.5)).clamp(0.0, 1.0);
        let k = q * q * (3.0 - 2.0 * q);
        (b.vx[j] * k, b.vy[j] * k)
    }

    /// The frame for a ship at (x, y): the moving port it is nearest (by distance over radius) within reach, if any.
    pub fn frame(&self, x: f64, y: f64) -> (f64, f64) {
        let (b, reach) = (&self.bodies, self.p(crate::world::P::match_reach));
        let mut best: Option<(usize, f64)> = None;
        for j in 0..self.n_bodies {
            if b.orb_w[j] == 0.0 || b.port[j] == 0 { continue; }
            let q = (x - b.x[j]).hypot(y - b.y[j]) / b.r[j].max(1.0);
            if q < reach && best.is_none_or(|(_, bq)| q < bq) { best = Some((j, q)); }
        }
        best.map_or((0.0, 0.0), |(j, _)| self.frame_of(j, x, y))
    }
}

#[cfg(test)]
mod tests {
    use crate::player::IN_ASSIST;
    use crate::port::{BODY_PLANET, BODY_STAR, BODY_STATION, CMD_AUTOPILOT, CMD_LAND, CMD_LAUNCH, CMD_SKIP, MODE_FLYING, MODE_LANDED, OK};
    use crate::traffic::{End, LOCAL, LOITER, MIX_LOCAL, T_LAND};
    use crate::world::{Config, World, DT, P};
    use crate::math::hypot;

    /// A star, a planet at (20 km, 0), and a station port of radius 300 orbiting it 4 km out, once every 600 s; the
    /// player's ship (accel 60, vmax 200) flying far off.
    fn world() -> Box<World> {
        let mut w = World::new(Config { max_ships: 16, max_types: 1, max_bodies: 3, env_n: 4, env_w: 1000.0 }, 2);
        (w.types.accel[0], w.types.turn[0], w.types.vmax[0], w.types.well[0], w.types.hull[0]) = (60.0, 1.5, 200.0, 0.35, 100.0);
        w.n_bodies = 3;
        for (j, (r, kind, port, g)) in [(2000.0, BODY_STAR, 0, 40.0), (1500.0, BODY_PLANET, 1, 30.0), (300.0, BODY_STATION, 1, 0.0)].into_iter().enumerate() {
            (w.bodies.r[j], w.bodies.kind[j], w.bodies.port[j], w.bodies.g[j], w.bodies.pop[j]) = (r, kind, port, g, port as f64 * 5.0);
        }
        w.place_body(0, 0, 0.0, 0.0);
        w.place_body(1, 0, 20_000.0, 0.0);
        w.place_body(2, 1, 4000.0, 90.0);
        w.body_motion(2, 600.0);
        w.count = 1;
        w.ships.alive[0] = 1;
        w.game.player[0] = 0;
        (w.ships.x[0], w.ships.y[0]) = (0.0, -30_000.0);
        w
    }
    fn run(w: &mut World, secs: f64) { for _ in 0..(secs / DT).round() as usize { w.step(); } }
    fn rel_speed(w: &World, j: usize) -> f64 { hypot(w.ships.vx[0] - w.bodies.vx[j], w.ships.vy[0] - w.bodies.vy[j]) }

    #[test]
    fn a_station_orbits_on_the_clock_and_a_load_finds_it_there() {
        let mut w = world();
        assert!((w.bodies.x[2] - 20_000.0).abs() < 1e-6 && (w.bodies.y[2] - 4000.0).abs() < 1e-6);
        run(&mut w, 150.0); // a quarter turn: from straight above the planet to its -x side
        assert!((w.bodies.x[2] - 16_000.0).abs() < 1.0 && w.bodies.y[2].abs() < 1.0, "{} {}", w.bodies.x[2], w.bodies.y[2]);
        let v = hypot(w.bodies.vx[2], w.bodies.vy[2]);
        assert!((v - crate::math::TAU * 4000.0 / 600.0).abs() < 1e-6 && w.bodies.vy[2] < 0.0, "{v}");
        assert_eq!((w.bodies.x[1], w.bodies.y[1]), (20_000.0, 0.0)); // the planet holds still
        w.save();
        let mut again = World::from_snapshot(w.snapshot()).unwrap();
        run(&mut w, 10.0);
        run(&mut again, 10.0);
        assert_eq!(w.hash(), again.hash());
    }

    #[test]
    fn docked_at_a_moving_station_the_ship_rides_along_and_launches_moving_with_it() {
        let mut w = world();
        w.place_landed(2);
        let off = (w.ships.x[0] - w.bodies.x[2], w.ships.y[0] - w.bodies.y[2]);
        run(&mut w, 40.0);
        let now = (w.ships.x[0] - w.bodies.x[2], w.ships.y[0] - w.bodies.y[2]);
        assert!((now.0 - off.0).abs() < 1e-6 && (now.1 - off.1).abs() < 1e-6, "{off:?} -> {now:?}");
        assert_eq!(w.command(CMD_LAUNCH, 0, 0), OK);
        assert_eq!(w.command(CMD_SKIP, 0, 0), OK);
        w.step();
        assert_eq!(w.mode(), MODE_FLYING);
        // out of the clamps at the launch speed relative to the station, which itself moves at about 42 m/s
        let rel = rel_speed(&w, 2);
        assert!((rel - w.p(P::launch_speed)).abs() < 1.5, "{rel}");
        assert!((w.game.set[0] - w.p(P::launch_speed)).abs() < 0.05, "{}", w.game.set[0]);
    }

    #[test]
    fn full_assist_holds_still_over_a_moving_port_and_landing_is_by_relative_speed() {
        let mut w = world();
        // over the station, moving with it: at rest relative to it
        (w.ships.x[0], w.ships.y[0]) = (w.bodies.x[2], w.bodies.y[2]);
        (w.ships.vx[0], w.ships.vy[0]) = (w.bodies.vx[2], w.bodies.vy[2]);
        w.game.input[0] = IN_ASSIST;
        run(&mut w, 30.0);
        assert_eq!(w.port_below(), Some((2, true)), "drifted off: {} m away, {} m/s relative", hypot(w.ships.x[0] - w.bodies.x[2], w.ships.y[0] - w.bodies.y[2]), rel_speed(&w, 2));
        assert!(hypot(w.ships.vx[0], w.ships.vy[0]) > 30.0); // moving through space all the while
        assert_eq!(w.command(CMD_LAND, 0, 0), OK);
        run(&mut w, 4.0);
        assert_eq!(w.mode(), MODE_LANDED);
        // and absolute stillness over it is too fast once it has moved on a little
        let mut w = world();
        (w.ships.x[0], w.ships.y[0]) = (w.bodies.x[2], w.bodies.y[2]);
        assert_eq!(w.port_below(), Some((2, false)));
    }

    #[test]
    fn the_autopilot_catches_a_moving_station() {
        let mut w = world();
        (w.ships.x[0], w.ships.y[0]) = (14_000.0, -9000.0);
        assert_eq!(w.command(CMD_AUTOPILOT, 2, 0), OK);
        w.game.input[0] = IN_ASSIST;
        for _ in 0..(300.0 / DT) as usize { w.step(); if w.game.auto[0] == 0 { break; } }
        assert_eq!(w.game.auto[0], 0, "never arrived");
        run(&mut w, 3.0);
        assert_eq!(w.port_below(), Some((2, true)), "{} m off, {} m/s relative", hypot(w.ships.x[0] - w.bodies.x[2], w.ships.y[0] - w.bodies.y[2]), rel_speed(&w, 2));
    }

    #[test]
    fn traffic_docks_at_a_moving_station_and_loiters_round_it() {
        let mut w = world();
        let m = 0;
        (w.mix.stream[m], w.mix.kind[m], w.mix.weight[m]) = (MIX_LOCAL, 0, 1.0);
        w.params[P::traffic_ships as usize] = 0.0;
        w.plan_traffic();
        let k = w.spawn(LOCAL, End::Body(1), End::Body(2), None).unwrap();
        let mut docked_at = None;
        for _ in 0..(400.0 / DT) as usize {
            w.step();
            if w.traffic.role[k] == 0 { break; }
            if w.traffic.phase[k] == T_LAND && docked_at.is_none() { docked_at = Some(hypot(w.ships.x[k] - w.bodies.x[2], w.ships.y[k] - w.bodies.y[2])); }
            if docked_at.is_some() { assert!(hypot(w.ships.x[k] - w.bodies.x[2], w.ships.y[k] - w.bodies.y[2]) < 300.0, "left behind while docking"); }
        }
        assert!(docked_at.is_some_and(|d| d < 300.0 * 0.6), "docked {docked_at:?} m out");
        // a loiter's loop goes round where the station is, not where it was
        let m = 1;
        (w.mix.stream[m], w.mix.body[m], w.mix.kind[m], w.mix.weight[m]) = (crate::traffic::MIX_LOITER, 2, 0, 1.0);
        let k = w.spawn(LOITER, End::Body(2), End::Body(2), Some(m)).unwrap();
        let mut far = 0.0f64;
        for _ in 0..(200.0 / DT) as usize { w.step(); if w.traffic.role[k] == 0 { break; } far = far.max(hypot(w.ships.x[k] - w.bodies.x[2], w.ships.y[k] - w.bodies.y[2])); }
        assert!(far < 300.0 * w.p(P::loiter_orbit) * 1.4, "strayed {far} m from the station");
    }
}
