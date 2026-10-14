//! Ambient traffic (M1): shuttles, haulers and liners flying between the system's ports.
//!
//! From the Book (Traffic; The M1 system): flows between ports come from a gravity model, population times
//! population over distance, weighted by how well the ports' roles complement each other; each role's ships arrive
//! as a Poisson process (here: undocking from a port) at rate flow over capacity; on entry the system starts with
//! N = rate x dwell ships per route, placed along their routes, so traffic looks mid-flow; a cap bounds the ships in
//! flight. Ships land, dock and launch by the player's rules and with the same animation, and are forgotten when
//! they land. Far from the player a ship runs on rails along its route; near, it flies the full physics under the
//! assist controller, along the same route.
//!
//! Per role, a route's weight is
//! - shuttle: pop x pop / km^2 (short local hops),
//! - hauler: pop x pop / km x complement, where complement is how much dearer the destination's market is for what
//!   both trade (from the market columns, so M5's moving prices move the flows),
//! - liner: pop x pop / km,
//!
//! and each role's rates are scaled so that, in steady state, its share of `traffic_ships` is in flight.
//! A route runs from a point on the origin's disc to one on the destination's, bent through a waypoint around any
//! other body in the way (the star above all). Ship types per role are content: the page writes `roles.kind`.

use crate::market::MAX_GOODS;
use crate::math::{atan2, exp, hypot};
use crate::port::{BODY_STAR, BODY_STATION, DESCENT_S, DONE, LAUNCH_S};
use crate::world::{World, DT, P};

/// Traffic roles (rows of the roles group); 0 in a ship's `traffic.role` means not traffic.
pub const SHUTTLE: u8 = 1;
pub const HAULER: u8 = 2;
pub const LINER: u8 = 3;
pub const N_ROLES: usize = 3;

/// A traffic ship's phase: lifting off its origin, flying its route, landing at its destination.
pub const T_LAUNCH: u8 = 1;
pub const T_CRUISE: u8 = 2;
pub const T_LAND: u8 = 3;

/// How far into its port's disc a route starts and ends, as a fraction of the radius (inside the landing zone).
const SPOT: f64 = 0.3;

impl World {
    /// Lane row for a directed route and role (lanes: body x body x role).
    fn lane(&self, from: usize, to: usize, role: usize) -> usize { (from * self.cfg.max_bodies + to) * N_ROLES + role }

    /// The route between two ports: start, waypoint and end points.
    pub fn route(&self, from: usize, to: usize) -> [(f64, f64); 3] {
        let b = &self.bodies;
        let (dx, dy) = (b.x[to] - b.x[from], b.y[to] - b.y[from]);
        let d = hypot(dx, dy).max(1e-6);
        let (ux, uy) = (dx / d, dy / d);
        let a = (b.x[from] + ux * b.r[from] * SPOT, b.y[from] + uy * b.r[from] * SPOT);
        let e = (b.x[to] - ux * b.r[to] * SPOT, b.y[to] - uy * b.r[to] * SPOT);
        let wp = self.detour(a, e, [from, to]).unwrap_or(((a.0 + e.0) / 2.0, (a.1 + e.1) / 2.0));
        [a, wp, e]
    }

    /// A waypoint round the body that intrudes deepest into its clearance circle (the star's 2 radii, others' 1.6)
    /// along the straight line from `a` to `e`, if any. Bodies in `skip`, and any whose clearance holds `a` (the one
    /// being left), are ignored. Traffic routes and the player's autopilot both steer by it.
    pub fn detour(&self, a: (f64, f64), e: (f64, f64), skip: [usize; 2]) -> Option<(f64, f64)> {
        let b = &self.bodies;
        let (sx, sy) = (e.0 - a.0, e.1 - a.1);
        let len2 = (sx * sx + sy * sy).max(1e-6);
        let mut worst: Option<(f64, f64, f64, f64, f64, f64)> = None; // intrusion, closest point x, y, centre x, y, clearance
        for j in 0..self.n_bodies {
            if skip.contains(&j) { continue; }
            let clear = b.r[j] * if b.kind[j] == BODY_STAR { 2.0 } else { 1.6 };
            if hypot(a.0 - b.x[j], a.1 - b.y[j]) < clear { continue; }
            let t = (((b.x[j] - a.0) * sx + (b.y[j] - a.1) * sy) / len2).clamp(0.0, 1.0);
            let (px, py) = (a.0 + sx * t, a.1 + sy * t);
            let dist = hypot(px - b.x[j], py - b.y[j]);
            if dist < clear && worst.is_none_or(|w| clear - dist > w.0) { worst = Some((clear - dist, px, py, b.x[j], b.y[j], clear)); }
        }
        let (_, px, py, cx, cy, clear) = worst?;
        let (mut nx, mut ny) = (px - cx, py - cy);
        if hypot(nx, ny) < 1e-3 { nx = -sy; ny = sx; } // dead centre: go round either side
        let l = hypot(nx, ny);
        Some((cx + nx / l * clear * 1.15, cy + ny / l * clear * 1.15))
    }

    /// Plan the lanes: each directed route's arrival rate (ships a second) and dwell (seconds a ship spends on it,
    /// launch and landing included), per role. Call after the bodies, markets, populations and role ship types are
    /// written (a new game); rates are saved with the world.
    pub fn plan_traffic(&mut self) {
        self.lanes.clear();
        let nb = self.n_bodies;
        let ports: Vec<usize> = (0..nb).filter(|&j| self.bodies.port[j] != 0).collect();
        let shares = [self.p(P::share_shuttle), self.p(P::share_hauler), self.p(P::share_liner)];
        for (role, share) in shares.into_iter().enumerate() {
            let cruise = self.cruise(role);
            let mut total = 0.0; // sum of weight x dwell, to scale the rates
            for &i in &ports {
                for &j in &ports {
                    if i == j { continue; }
                    let [a, w, e] = self.route(i, j);
                    let len = hypot(w.0 - a.0, w.1 - a.1) + hypot(e.0 - w.0, e.1 - w.1);
                    let km = (hypot(self.bodies.x[j] - self.bodies.x[i], self.bodies.y[j] - self.bodies.y[i]) / 1000.0).max(0.1);
                    let pp = self.bodies.pop[i] * self.bodies.pop[j];
                    let weight = match role as u8 + 1 {
                        SHUTTLE => pp / (km * km),
                        HAULER => pp / km * self.complement(i, j),
                        _ => pp / km,
                    };
                    let dwell = len / cruise.max(1.0) + LAUNCH_S + DESCENT_S;
                    let l = self.lane(i, j, role);
                    self.lanes.rate[l] = weight;
                    self.lanes.dwell[l] = dwell;
                    total += weight * dwell;
                }
            }
            // scale: in steady state this role has its share of the target ships in flight
            let k = if total > 0.0 { self.p(P::traffic_ships) * share / total } else { 0.0 };
            for &i in &ports { for &j in &ports { if i != j { let l = self.lane(i, j, role); self.lanes.rate[l] *= k; } } }
        }
    }

    /// How well a destination's market complements an origin's: the summed relative markup, for every commodity both
    /// trade, of selling at the destination what was bought at the origin; floored so every route sees some freight.
    fn complement(&self, from: usize, to: usize) -> f64 {
        let mut c = 0.0;
        for g in 0..MAX_GOODS {
            let (pa, pb) = (self.price(from, g) as f64, self.price(to, g) as f64);
            if pa > 0.0 && pb > pa { c += (pb - pa) / pa; }
        }
        c.max(0.1)
    }

    /// A role's cruising speed: a share of its hull's top speed.
    fn cruise(&self, role: usize) -> f64 { self.types.vmax[self.roles.kind[role] as usize] * self.p(P::traffic_cruise) }

    /// Traffic in flight now.
    pub fn traffic_count(&self) -> usize { (0..self.count).filter(|&i| self.traffic.role[i] != 0).count() }

    /// Seed the steady state for a new game: on every lane, a Poisson number of ships (mean rate x dwell), spread
    /// along the route, already cruising. Call after `plan_traffic` and after the player's slot is set up.
    pub fn seed_traffic(&mut self) {
        let nb = self.n_bodies;
        for i in 0..nb {
            for j in 0..nb {
                for role in 0..N_ROLES {
                    let l = self.lane(i, j, role);
                    let mean = self.lanes.rate[l] * self.lanes.dwell[l];
                    if mean <= 0.0 { continue; }
                    let n = self.poisson(mean);
                    for _ in 0..n {
                        let Some(k) = self.spawn(i, j, role) else { return };
                        let t = &mut self.traffic;
                        t.phase[k] = T_CRUISE;
                        t.s[k] = self.rng.range(0.0, t.len[k]);
                        self.place_on_route(k);
                        self.slot_reset(k, false);
                    }
                }
            }
        }
    }

    fn poisson(&mut self, mean: f64) -> u32 {
        let (lim, mut p, mut k) = (exp(-mean), 1.0, 0u32);
        loop {
            p *= self.rng.next_f64();
            if p <= lim || k >= 64 { return k; }
            k += 1;
        }
    }

    /// A free slot for a new traffic ship (never the player's), growing the live range if needed, within the cap.
    fn free_slot(&mut self) -> Option<usize> {
        if self.traffic_count() as f64 >= self.p(P::traffic_cap) { return None; }
        let player = usize::try_from(self.player.slot).ok();
        if let Some(i) = (0..self.count).find(|&i| Some(i) != player && self.ships.alive[i] == 0 && self.traffic.role[i] == 0) { return Some(i); }
        if self.count < self.cfg.max_ships { self.count += 1; return Some(self.count - 1); }
        None
    }

    /// A new ship of `role` on the route from `from` to `to`, lifting off (T_LAUNCH) at the route's start.
    fn spawn(&mut self, from: usize, to: usize, role: usize) -> Option<usize> {
        let k = self.free_slot()?;
        let [a, w, e] = self.route(from, to);
        let cruise = self.cruise(role);
        let s = &mut self.ships;
        s.alive[k] = 1; s.rail[k] = 1; s.kind[k] = self.roles.kind[role];
        s.x[k] = a.0; s.y[k] = a.1; s.vx[k] = 0.0; s.vy[k] = 0.0; s.av[k] = 0.0;
        s.ang[k] = atan2(-(w.0 - a.0), w.1 - a.1);
        s.turn_in[k] = 0.0; s.main[k] = 0.0; s.lat[k] = 0.0; s.thr[k] = 0.0; s.burn[k] = 0; s.rot[k] = 0; s.ctl[k] = 1;
        s.want_vx[k] = 0.0; s.want_vy[k] = 0.0;
        let t = &mut self.traffic;
        t.role[k] = role as u8 + 1; t.phase[k] = T_LAUNCH; t.timer[k] = LAUNCH_S; t.leg[k] = 0;
        t.from[k] = from as i16; t.to[k] = to as i16;
        t.ax[k] = a.0; t.ay[k] = a.1; t.wx[k] = w.0; t.wy[k] = w.1; t.bx[k] = e.0; t.by[k] = e.1;
        t.len[k] = hypot(w.0 - a.0, w.1 - a.1) + hypot(e.0 - w.0, e.1 - w.1);
        t.s[k] = 0.0; t.cruise[k] = cruise; t.age[k] = 0.0;
        self.slot_reset(k, true);
        Some(k)
    }

    /// Put a railed ship at its route position `s`, facing along the route, moving at cruise.
    fn place_on_route(&mut self, k: usize) {
        let t = &self.traffic;
        let l0 = hypot(t.wx[k] - t.ax[k], t.wy[k] - t.ay[k]);
        let (p0, p1, f) = if t.s[k] < l0 { ((t.ax[k], t.ay[k]), (t.wx[k], t.wy[k]), t.s[k] / l0.max(1e-6)) }
            else { ((t.wx[k], t.wy[k]), (t.bx[k], t.by[k]), (t.s[k] - l0) / (t.len[k] - l0).max(1e-6)) };
        let (dx, dy) = (p1.0 - p0.0, p1.1 - p0.1);
        let d = hypot(dx, dy).max(1e-6);
        let leg = (t.s[k] >= l0) as u8;
        let cruise = t.cruise[k];
        self.traffic.leg[k] = leg;
        let s = &mut self.ships;
        s.x[k] = p0.0 + dx * f.min(1.0);
        s.y[k] = p0.1 + dy * f.min(1.0);
        s.vx[k] = dx / d * cruise;
        s.vy[k] = dy / d * cruise;
        s.ang[k] = atan2(-dx, dy);
        s.av[k] = 0.0;
        s.thr[k] = 0.5;
    }

    /// The traffic stage, once per tick before the flight stages: arrivals, launches and landings, the rails, the
    /// switch between rails and physics by distance to the player, and the AI that flies the near ones.
    pub(crate) fn step_traffic(&mut self) {
        // arrivals: each lane undocks ships as a Poisson process
        let nb = self.n_bodies;
        for i in 0..nb {
            if self.bodies.port[i] == 0 { continue; }
            for j in 0..nb {
                for role in 0..N_ROLES {
                    let rate = self.lanes.rate[self.lane(i, j, role)];
                    if rate > 0.0 && self.rng.next_f64() < rate * DT { self.spawn(i, j, role); }
                }
            }
        }
        let (near, far) = (self.p(P::traffic_near), self.p(P::traffic_near) * 1.25);
        let player = usize::try_from(self.player.slot).ok().filter(|&p| p < self.count);
        let (px, py) = player.map_or((f64::MAX, f64::MAX), |p| (self.ships.x[p], self.ships.y[p]));
        for k in 0..self.count {
            if self.traffic.role[k] == 0 { continue; }
            self.traffic.age[k] += DT;
            match self.traffic.phase[k] {
                T_LAUNCH => {
                    self.traffic.timer[k] -= DT;
                    if self.traffic.timer[k] <= DONE { self.traffic.phase[k] = T_CRUISE; self.place_on_route(k); }
                }
                T_LAND => {
                    self.traffic.timer[k] -= DT;
                    if self.traffic.timer[k] <= DONE { self.despawn(k); }
                }
                _ => self.cruise_step(k, px, py, near, far),
            }
        }
    }

    fn despawn(&mut self, k: usize) {
        self.ships.alive[k] = 0;
        self.ships.rail[k] = 0;
        self.traffic.role[k] = 0;
        self.traffic.phase[k] = 0;
        // shrink the live range past trailing dead slots
        while self.count > 0 && self.ships.alive[self.count - 1] == 0 && self.traffic.role[self.count - 1] == 0
            && usize::try_from(self.player.slot).ok() != Some(self.count - 1) { self.count -= 1; }
    }

    /// Begin the landing (or docking) sequence where the ship is.
    fn land(&mut self, k: usize) {
        let s = &mut self.ships;
        s.rail[k] = 1; s.vx[k] = 0.0; s.vy[k] = 0.0; s.av[k] = 0.0; s.thr[k] = 0.0;
        s.main[k] = 0.0; s.lat[k] = 0.0; s.turn_in[k] = 0.0;
        self.traffic.phase[k] = T_LAND;
        self.traffic.timer[k] = DESCENT_S;
    }

    fn cruise_step(&mut self, k: usize, px: f64, py: f64, near: f64, far: f64) {
        let d_player = hypot(self.ships.x[k] - px, self.ships.y[k] - py);
        // a ship that somehow never arrives (stuck in a well, say) is retired
        if self.traffic.age[k] > 3.0 * self.traffic.len[k] / self.traffic.cruise[k].max(1.0) + 120.0 { self.despawn(k); return; }
        if self.ships.rail[k] != 0 {
            if d_player < near { // close to the player: hand over to the physics, moving as it was
                self.ships.rail[k] = 0;
            } else {
                self.traffic.s[k] += self.traffic.cruise[k] * DT;
                if self.traffic.s[k] >= self.traffic.len[k] {
                    self.traffic.s[k] = self.traffic.len[k];
                    self.place_on_route(k);
                    self.land(k);
                } else { self.place_on_route(k); }
                return;
            }
        } else if d_player > far {
            // far again: back onto the rails, at the nearest point of its current leg
            let t = &self.traffic;
            let (p0, p1, base) = if t.leg[k] == 0 { ((t.ax[k], t.ay[k]), (t.wx[k], t.wy[k]), 0.0) }
                else { ((t.wx[k], t.wy[k]), (t.bx[k], t.by[k]), hypot(t.wx[k] - t.ax[k], t.wy[k] - t.ay[k])) };
            let (dx, dy) = (p1.0 - p0.0, p1.1 - p0.1);
            let l = hypot(dx, dy).max(1e-6);
            let along = (((self.ships.x[k] - p0.0) * dx + (self.ships.y[k] - p0.1) * dy) / l).clamp(0.0, l);
            self.traffic.s[k] = base + along;
            self.ships.rail[k] = 1;
            self.place_on_route(k);
            return;
        }
        // physics: steer for the waypoint, then the end point, arriving slow enough to land
        let t = &self.traffic;
        let (tx, ty) = if t.leg[k] == 0 { (t.wx[k], t.wy[k]) } else { (t.bx[k], t.by[k]) };
        let (dx, dy) = (tx - self.ships.x[k], ty - self.ships.y[k]);
        let d = hypot(dx, dy);
        let (to, cruise) = (t.to[k] as usize, t.cruise[k]);
        if t.leg[k] == 0 {
            if d < 800.0 { self.traffic.leg[k] = 1; }
            let v = cruise / d.max(1e-6);
            self.ships.want_vx[k] = dx * v;
            self.ships.want_vy[k] = dy * v;
            return;
        }
        // brake to half the landing limit by `stop` metres out, then creep in; land once inside 1.5 x stop and slow
        // (always inside the landing zone: stations 0.6 radii, planets 0.95)
        let limit = if self.bodies.kind[to] == BODY_STATION { self.p(P::dock_speed) } else { self.p(P::land_speed) };
        let stop = (self.bodies.r[to] * 0.25).max(80.0);
        let sp = hypot(self.ships.vx[k], self.ships.vy[k]);
        if d < stop * 1.5 && sp < limit { self.land(k); return; }
        let brake = self.types.accel[self.ships.kind[k] as usize] * 0.35;
        let v = cruise.min((2.0 * brake * (d - stop).max(0.0)).sqrt() * 0.8).max(limit * 0.5) / d.max(1e-6);
        self.ships.want_vx[k] = dx * v;
        self.ships.want_vy[k] = dy * v;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::{BODY_PLANET, MODE_FLYING};
    use crate::world::Config;

    /// The star at the origin, two planet ports either side of it (so routes must bend round it), a station port
    /// off to one side; a player ship far away; one ship type for every role.
    fn world(seed: u64) -> Box<World> {
        let mut w = World::new(Config { max_ships: 40, max_types: 1, max_bodies: 4, env_n: 4, env_w: 1000.0 }, seed);
        (w.types.accel[0], w.types.turn[0], w.types.vmax[0], w.types.well[0]) = (40.0, 1.0, 150.0, 0.5);
        w.n_bodies = 4;
        for (j, (x, y, r, kind, port, pop)) in [(0.0, 0.0, 2000.0, BODY_STAR, 0, 0.0), (-15_000.0, 0.0, 800.0, BODY_PLANET, 1, 10.0),
            (15_000.0, 0.0, 800.0, BODY_PLANET, 1, 3.0), (0.0, 12_000.0, 300.0, BODY_STATION, 1, 3.0)].into_iter().enumerate() {
            let b = &mut w.bodies;
            (b.x[j], b.y[j], b.r[j], b.kind[j], b.port[j], b.pop[j], b.g[j]) = (x, y, r, kind, port, pop, 20.0);
        }
        w.market.price[MAX_GOODS] = 10;       // body 1 sells commodity 0 cheap
        w.market.price[2 * MAX_GOODS] = 30;   // body 2 pays well for it
        w.count = 1;
        w.player.slot = 0;
        w.ships.alive[0] = 1;
        w.ships.x[0] = 0.0; w.ships.y[0] = -40_000.0;
        w.game.mode[0] = MODE_FLYING;
        w.plan_traffic();
        w
    }

    #[test]
    fn routes_bend_round_the_star() {
        let w = world(1);
        let [a, wp, e] = w.route(1, 2);
        assert!((a.0 - -14_760.0).abs() < 1.0 && (e.0 - 14_760.0).abs() < 1.0);
        assert!(hypot(wp.0, wp.1) >= 2000.0 * 2.0, "{wp:?}"); // the waypoint clears the star
        let [_, wp, _] = w.route(1, 3);
        let mid = (-7_500.0, 6_000.0);
        assert!(hypot(wp.0 - mid.0, wp.1 - mid.1) < 300.0, "{wp:?}"); // nothing in the way: straight
    }

    #[test]
    fn lanes_follow_the_gravity_model() {
        let w = world(1);
        let rate = |i, j, r| w.lanes.rate[w.lane(i, j, r)];
        // haulers favour the route the prices reward; liners are symmetric; every role has some flow
        assert!(rate(1, 2, 1) > 3.0 * rate(2, 1, 1));
        assert!((rate(1, 2, 2) - rate(2, 1, 2)).abs() < 1e-12);
        // shuttles favour short routes more than liners do
        assert!(rate(1, 3, 0) / rate(1, 2, 0) > rate(1, 3, 2) / rate(1, 2, 2));
        // steady state: each role's share of the target ships
        for role in 0..N_ROLES {
            let n: f64 = (0..4).flat_map(|i| (0..4).map(move |j| (i, j))).map(|(i, j)| { let l = w.lane(i, j, role); w.lanes.rate[l] * w.lanes.dwell[l] }).sum();
            let share = [w.p(P::share_shuttle), w.p(P::share_hauler), w.p(P::share_liner)][role];
            assert!((n - w.p(P::traffic_ships) * share).abs() < 1e-9, "{role}: {n}");
        }
        assert_eq!(rate(0, 1, 0), 0.0); // the star is no port
    }

    #[test]
    fn steady_state_and_turnover() {
        let mut w = world(4);
        w.seed_traffic();
        let n0 = w.traffic_count();
        assert!(n0 > 3 && n0 as f64 <= w.p(P::traffic_cap), "{n0}");
        assert!((1..w.count).all(|k| w.traffic.phase[k] == T_CRUISE && w.ships.rail[k] == 1));
        // ten minutes: ships land and new ones launch; the count stays near the target
        let first: Vec<u32> = (1..w.count).map(|k| w.handle(k)).collect();
        let mut seen = 0.0;
        for t in 0..36_000 { w.step(); if t % 600 == 0 { seen += w.traffic_count() as f64; } }
        assert!(first.iter().all(|&h| w.resolve(h).is_none())); // every ship from the start has landed
        let mean = seen / 60.0;
        assert!(mean > w.p(P::traffic_ships) * 0.5 && mean < w.p(P::traffic_ships) * 1.6, "{mean}");
        assert!(w.count <= w.cfg.max_ships);
    }

    #[test]
    fn near_the_player_ships_fly_and_land_under_physics() {
        let mut w = world(5);
        w.params[P::traffic_ships as usize] = 0.0; w.plan_traffic(); // no arrivals: one ship, by hand
        let k = w.spawn(1, 3, 1).unwrap();
        w.ships.x[0] = w.bodies.x[3]; w.ships.y[0] = w.bodies.y[3] - 3000.0; // the player waits near the station
        let mut physics = false;
        for _ in 0..(600.0 / DT) as usize {
            w.step();
            if w.traffic.role[k] == 0 { break; }
            if w.traffic.phase[k] == T_CRUISE && w.ships.rail[k] == 0 { physics = true; }
            assert!(w.ships.x[k].is_finite());
        }
        assert!(physics, "the ship never came off the rails near the player");
        assert_eq!(w.traffic.role[k], 0, "the ship never docked");
        assert!(w.traffic.age[k] > 0.0);
    }

    #[test]
    fn traffic_replays() {
        let run = || { let mut w = world(9); w.seed_traffic(); w.ships.y[0] = -16_000.0; for _ in 0..7200 { w.step(); } w.hash() };
        assert_eq!(run(), run());
    }
}
