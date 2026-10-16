//! Ambient traffic (M1): ships flying between the system's ports, in from and out to its jump zones, and loitering
//! round their ports.
//!
//! From the Book (Traffic; The M1 system): ships arrive as a Poisson process at jump points and from station
//! undocking; on entry the system starts mid-flow, with N = rate x dwell ships per route placed along it; a cap bounds
//! the ships in flight. Ships land, dock and launch by the player's rules and with the same animation. Far from the
//! player a ship runs on rails along its route; near, it flies the full physics under the assist controller.
//!
//! Four streams (a ship's `traffic.role`):
//! - LOCAL: port to port, on a gravity model per local role (shuttle: pop x pop / km^2; hauler: pop x pop / km x
//!   complement, how much dearer the destination's market is for what both trade; liner: pop x pop / km);
//! - ARRIVE: from one of four jump zones (north, east, south, west, `jump_radius` out) to a port, by population;
//! - DEPART: from a port, by population, to a jump zone, where it leaves (vanishes, for now);
//! - LOITER: launches, circles its port at `loiter_orbit` radii for about `loiter_turns` turns, and lands again.
//!
//! Local and through traffic share `traffic_ships` (`share_through` of it through); each loiter row keeps its own
//! number of ships up. Which ship flies is content: the mix (the system file's traffic, written by the page), whose
//! rows give a ship type and a weight per stream; a new ship draws its row by weight. A route is a polyline: start,
//! waypoints (round any body in the way, or the loop of a loiter), end.

use crate::market::MAX_GOODS;
use crate::math::{atan2, cos, exp, hypot, ln, sin, TAU};
use crate::port::{BODY_BELT, BODY_FIELD, BODY_STAR, BODY_STATION, DESCENT_S, DONE, LAUNCH_S};
use crate::world::{World, DT, P};

/// Local roles (rows of the local lanes; their shares are params).
pub const SHUTTLE: u8 = 1;
pub const HAULER: u8 = 2;
pub const LINER: u8 = 3;
pub const N_ROLES: usize = 3;

/// Traffic streams (`traffic.role`; 0 is not traffic).
pub const LOCAL: u8 = 1;
pub const ARRIVE: u8 = 2;
pub const DEPART: u8 = 3;
pub const LOITER: u8 = 4;
/// To or from an environmental station (a body with no port: forges, container ports, habitats round a world).
pub const ENVIRON: u8 = 5;

/// Mix row streams.
pub const MIX_LOCAL: u8 = 1;
pub const MIX_THROUGH: u8 = 2;
pub const MIX_LOITER: u8 = 3;
/// Environmental station rows: `body` is the station group (bodies.env - 1), `weight` the row's share of its launches.
pub const MIX_ENV: u8 = 4;
pub const MAX_MIX: usize = 128;
/// How far before and after a route's waypoint a railed ship starts and ends its turn, metres (less on short legs).
const CORNER: f64 = 600.0;

/// Jump zones: north, east, south and west of the star.
pub const N_JUMP: usize = 4;
/// Most points on a route (a loiter's loop uses them all).
pub const MAX_PTS: usize = 12;

/// A traffic ship's phase: lifting off its origin, flying its route, landing at its destination.
pub const T_LAUNCH: u8 = 1;
pub const T_CRUISE: u8 = 2;
pub const T_LAND: u8 = 3;

/// How far into its port's disc a route starts and ends, as a fraction of the radius (inside the landing zone).
const SPOT: f64 = 0.3;

/// A route end: a body, or jump zone z (encoded -1 - z in `traffic.from` and `.to`).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum End { Body(usize), Jump(usize) }
impl End {
    fn code(self) -> i16 { match self { End::Body(j) => j as i16, End::Jump(z) => -1 - z as i16 } }
    pub fn of(code: i16) -> End { if code >= 0 { End::Body(code as usize) } else { End::Jump((-1 - code) as usize) } }
}

impl World {
    /// Lane row for a directed local route and role (lanes: body x body x role).
    fn lane(&self, from: usize, to: usize, role: usize) -> usize { (from * self.cfg.max_bodies + to) * N_ROLES + role }
    /// Through lane row: dir 0 arriving (zone to body), 1 departing (body to zone).
    fn jlane(&self, dir: usize, z: usize, body: usize) -> usize { (dir * N_JUMP + z) * self.cfg.max_bodies + body }

    /// The centre of jump zone z: north, east, south, west.
    pub fn jump_point(&self, z: usize) -> (f64, f64) {
        let r = self.p(P::jump_radius);
        [(0.0, r), (r, 0.0), (0.0, -r), (-r, 0.0)][z % N_JUMP]
    }

    /// Where a route touches an end, coming from or going toward `other`: a point on a body's disc facing it, or the
    /// jump zone's centre.
    fn end_point(&self, e: End, other: (f64, f64)) -> (f64, f64) {
        match e {
            End::Jump(z) => self.jump_point(z),
            End::Body(j) => {
                let b = &self.bodies;
                let (dx, dy) = (other.0 - b.x[j], other.1 - b.y[j]);
                let d = hypot(dx, dy).max(1e-6);
                (b.x[j] + dx / d * b.r[j] * SPOT, b.y[j] + dy / d * b.r[j] * SPOT)
            }
        }
    }
    fn centre(&self, e: End) -> (f64, f64) { match e { End::Jump(z) => self.jump_point(z), End::Body(j) => (self.bodies.x[j], self.bodies.y[j]) } }

    /// The route between two ports: start, waypoint and end points.
    pub fn route(&self, from: usize, to: usize) -> [(f64, f64); 3] { self.route_ends(End::Body(from), End::Body(to)) }

    /// A route between two ends: start, waypoint (round any body in the way; else the midpoint) and end.
    fn route_ends(&self, from: End, to: End) -> [(f64, f64); 3] {
        let a = self.end_point(from, self.centre(to));
        let e = self.end_point(to, self.centre(from));
        let skip = |x: End| match x { End::Body(j) => j, End::Jump(_) => usize::MAX };
        let wp = self.detour(a, e, [skip(from), skip(to)]).unwrap_or(((a.0 + e.0) / 2.0, (a.1 + e.1) / 2.0));
        [a, wp, e]
    }

    /// A waypoint round the body that intrudes deepest into its clearance circle (the star's 2 radii, others' 1.6, or
    /// a little past its hazard zone if it has one: service.rs) along the straight line from `a` to `e`, if any. Bodies in `skip`, any whose clearance holds `a` (the one being
    /// left), and belts and fields (ships fly through them), are ignored. Traffic routes and the player's autopilot
    /// both steer by it.
    pub fn detour(&self, a: (f64, f64), e: (f64, f64), skip: [usize; 2]) -> Option<(f64, f64)> {
        let b = &self.bodies;
        let (sx, sy) = (e.0 - a.0, e.1 - a.1);
        let len2 = (sx * sx + sy * sy).max(1e-6);
        let mut worst: Option<(f64, f64, f64, f64, f64, f64)> = None; // intrusion, closest point x, y, centre x, y, clearance
        for j in 0..self.n_bodies {
            if skip.contains(&j) || b.kind[j] == BODY_BELT || b.kind[j] == BODY_FIELD { continue; }
            let clear = (b.r[j] * if b.kind[j] == BODY_STAR { 2.0 } else { 1.6 }).max(b.hazard[j] * 1.1);
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

    /// The mix rows of a stream (those with weight), in row order. Iterates in place: the tick never allocates.
    fn mix_rows(&self, stream: u8) -> impl Iterator<Item = usize> + '_ {
        (0..MAX_MIX).filter(move |&m| self.mix.stream[m] == stream && self.mix.weight[m] > 0.0)
    }
    /// A stream's summed mix weight.
    fn mix_total(&self, stream: u8) -> f64 { self.mix_rows(stream).map(|m| self.mix.weight[m]).sum() }
    /// A stream's cruising speed for planning dwell times: the weighted harmonic mean, since a route's mean time is
    /// its length times the mean of 1 / speed (slow hulls spend longer on it, so they count for more).
    fn mean_cruise(&self, stream: u8) -> f64 {
        let total = self.mix_total(stream);
        if total <= 0.0 { return 1.0; }
        let slowness: f64 = self.mix_rows(stream).map(|m| self.mix.weight[m] / self.types.vmax[self.mix.kind[m] as usize].max(1.0)).sum::<f64>() / total;
        self.p(P::traffic_cruise) / slowness
    }
    /// Draw a mix row of a stream by weight.
    fn pick_mix(&mut self, stream: u8) -> Option<usize> {
        let total = self.mix_total(stream);
        if total <= 0.0 { return None; }
        let mut x = self.rng.next_f64() * total;
        let mut last = None;
        for m in self.mix_rows(stream) { x -= self.mix.weight[m]; last = Some(m); if x <= 0.0 { break; } }
        last
    }
    fn route_len(pts: &[(f64, f64); 3]) -> f64 { hypot(pts[1].0 - pts[0].0, pts[1].1 - pts[0].1) + hypot(pts[2].0 - pts[1].0, pts[2].1 - pts[1].1) }

    /// Plan the traffic: every local lane's and through lane's rate (ships a second) and dwell (seconds a ship
    /// spends on it, launch and landing included), and each loiter row's. Call after the bodies, markets,
    /// populations and the mix are written (a new game); rates are saved with the world.
    pub fn plan_traffic(&mut self) {
        self.lanes.clear();
        self.jlanes.clear();
        let nb = self.n_bodies;
        let (local_ships, through_ships) = (self.p(P::traffic_ships) * (1.0 - self.p(P::share_through)), self.p(P::traffic_ships) * self.p(P::share_through));
        // local: per role, a gravity model over the routes, scaled to the role's share of the local ships
        if self.mix_total(MIX_LOCAL) > 0.0 {
            let cruise = self.mean_cruise(MIX_LOCAL);
            let shares = [self.p(P::share_shuttle), self.p(P::share_hauler), self.p(P::share_liner)];
            for (role, share) in shares.into_iter().enumerate() {
                let mut total = 0.0; // sum of weight x dwell, to scale the rates
                for i in 0..nb {
                    for j in 0..nb {
                        if i == j || self.bodies.port[i] == 0 || self.bodies.port[j] == 0 { continue; }
                        let len = Self::route_len(&self.route(i, j));
                        let km = (hypot(self.bodies.x[j] - self.bodies.x[i], self.bodies.y[j] - self.bodies.y[i]) / 1000.0).max(0.1);
                        let pp = self.bodies.pop[i] * self.bodies.pop[j];
                        let weight = match role as u8 + 1 {
                            SHUTTLE => pp / (km * km),
                            HAULER => pp / km * self.complement(i, j),
                            _ => pp / km,
                        };
                        let l = self.lane(i, j, role);
                        self.lanes.rate[l] = weight;
                        self.lanes.dwell[l] = len / cruise.max(1.0) + LAUNCH_S + DESCENT_S;
                        total += weight * self.lanes.dwell[l];
                    }
                }
                let k = if total > 0.0 { local_ships * share / total } else { 0.0 };
                for i in 0..nb { for j in 0..nb { if i != j && self.bodies.port[i] != 0 && self.bodies.port[j] != 0 { let l = self.lane(i, j, role); self.lanes.rate[l] *= k; } } }
            }
        }
        // through: arrivals at each zone bound for each port, and departures, both by the port's population
        if self.mix_total(MIX_THROUGH) > 0.0 {
            let cruise = self.mean_cruise(MIX_THROUGH);
            let mut total = 0.0;
            for dir in 0..2 {
                for z in 0..N_JUMP {
                    for j in (0..nb).filter(|&j| self.bodies.port[j] != 0) {
                        let pts = if dir == 0 { self.route_ends(End::Jump(z), End::Body(j)) } else { self.route_ends(End::Body(j), End::Jump(z)) };
                        let l = self.jlane(dir, z, j);
                        self.jlanes.rate[l] = self.bodies.pop[j];
                        self.jlanes.dwell[l] = Self::route_len(&pts) / cruise.max(1.0) + if dir == 0 { DESCENT_S } else { LAUNCH_S };
                        total += self.jlanes.rate[l] * self.jlanes.dwell[l];
                    }
                }
            }
            let k = if total > 0.0 { through_ships / total } else { 0.0 };
            for l in 0..self.jlanes.cap { self.jlanes.rate[l] *= k; }
        }
        // loiter: each row launches at the rate that keeps its ships up (weight = ships in flight)
        for m in 0..MAX_MIX {
            if self.mix.stream[m] != MIX_LOITER || self.mix.body[m] < 0 { self.mix.rate[m] = 0.0; continue; }
            let j = self.mix.body[m] as usize;
            let r = self.bodies.r[j];
            let orbit = r * self.p(P::loiter_orbit);
            let len = 2.0 * (orbit - r * SPOT) + orbit * TAU * self.p(P::loiter_turns);
            let cruise = self.types.vmax[self.mix.kind[m] as usize] * self.p(P::loiter_cruise);
            self.mix.dwell[m] = len / cruise.max(1.0) + LAUNCH_S + DESCENT_S;
            self.mix.rate[m] = self.mix.weight[m] / self.mix.dwell[m];
        }
        // each lane's first launch, an exponential gap from now
        let now = self.tick as f64 * DT;
        for l in 0..self.lanes.cap { self.lanes.next[l] = if self.lanes.rate[l] > 0.0 { now + self.gap(self.lanes.rate[l]) } else { f64::INFINITY }; }
        for l in 0..self.jlanes.cap { self.jlanes.next[l] = if self.jlanes.rate[l] > 0.0 { now + self.gap(self.jlanes.rate[l]) } else { f64::INFINITY }; }
        for m in 0..MAX_MIX { self.mix.next[m] = if self.mix.rate[m] > 0.0 { now + self.gap(self.mix.rate[m]) } else { f64::INFINITY }; }
        for j in 0..self.n_bodies { self.bodies.env_next[j] = if self.bodies.env[j] != 0 && self.bodies.env_rate[j] > 0.0 { now + self.gap(self.bodies.env_rate[j]) } else { f64::INFINITY }; }
    }

    /// A ship to or from environmental station j: its type drawn from the station group's mix rows by weight; out
    /// to, or in from, a jump zone (the station's env_jump share of trips) or a port (by population). None if the
    /// group has no rows, there is no port to pair with, or there is no free slot.
    /// The mix rows of environmental station group g, with weight, in row order.
    fn env_rows(&self, g: i16) -> impl Iterator<Item = usize> + '_ {
        (0..MAX_MIX).filter(move |&m| self.mix.stream[m] == MIX_ENV && self.mix.body[m] == g && self.mix.weight[m] > 0.0)
    }
    fn spawn_env(&mut self, j: usize) -> Option<usize> {
        let g = self.bodies.env[j] as i16 - 1;
        let total: f64 = self.env_rows(g).map(|m| self.mix.weight[m]).sum();
        if total <= 0.0 { return None; }
        let mut x = self.rng.next_f64() * total;
        let mut row = None;
        for m in self.env_rows(g) { x -= self.mix.weight[m]; row = Some(m); if x <= 0.0 { break; } }
        let outbound = self.rng.next_f64() < 0.5;
        let other = if self.rng.next_f64() < self.bodies.env_jump[j] {
            End::Jump(((self.rng.next_f64() * N_JUMP as f64) as usize).min(N_JUMP - 1))
        } else {
            let pops: f64 = (0..self.n_bodies).filter(|&p| self.bodies.port[p] != 0).map(|p| self.bodies.pop[p]).sum();
            if pops <= 0.0 { return None; }
            let mut y = self.rng.next_f64() * pops;
            let mut port = None;
            for p in (0..self.n_bodies).filter(|&p| self.bodies.port[p] != 0) { y -= self.bodies.pop[p]; port = Some(p); if y <= 0.0 { break; } }
            End::Body(port?)
        };
        let me = End::Body(j);
        if outbound { self.spawn(ENVIRON, me, other, row) } else { self.spawn(ENVIRON, other, me, row) }
    }

    /// A Poisson process's gap to its next event at `rate` a second: exponential, -ln(u) / rate, u in (0, 1].
    fn gap(&mut self, rate: f64) -> f64 { -ln(1.0 - self.rng.next_f64()) / rate }

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

    /// Traffic in flight now.
    pub fn traffic_count(&self) -> usize { (0..self.count).filter(|&i| self.traffic.role[i] != 0).count() }

    /// Seed the steady state for a new game: on every lane and loiter row, a Poisson number of ships (mean rate x
    /// dwell), spread along their routes, already cruising. Call after `plan_traffic` and after the player's slot.
    pub fn seed_traffic(&mut self) {
        let nb = self.n_bodies;
        for i in 0..nb { for j in 0..nb { for role in 0..N_ROLES {
            let l = self.lane(i, j, role);
            if !self.seed_lane(LOCAL, End::Body(i), End::Body(j), self.lanes.rate[l] * self.lanes.dwell[l], None) { return; }
        } } }
        for z in 0..N_JUMP { for j in 0..nb {
            let (a, d) = (self.jlane(0, z, j), self.jlane(1, z, j));
            if !self.seed_lane(ARRIVE, End::Jump(z), End::Body(j), self.jlanes.rate[a] * self.jlanes.dwell[a], None) { return; }
            if !self.seed_lane(DEPART, End::Body(j), End::Jump(z), self.jlanes.rate[d] * self.jlanes.dwell[d], None) { return; }
        } }
        for m in 0..MAX_MIX {
            if self.mix.stream[m] == MIX_LOITER && self.mix.body[m] >= 0 {
                let j = End::Body(self.mix.body[m] as usize);
                if !self.seed_lane(LOITER, j, j, self.mix.weight[m], Some(m)) { return; }
            }
        }
        // environmental stations: their launch rate times a typical trip, already under way
        let trip = self.p(P::env_trip);
        for j in 0..nb {
            if self.bodies.env[j] == 0 || self.bodies.env_rate[j] <= 0.0 { continue; }
            for _ in 0..self.poisson(self.bodies.env_rate[j] * trip) {
                let Some(k) = self.spawn_env(j) else { break };
                let t = &mut self.traffic;
                t.phase[k] = T_CRUISE;
                t.s[k] = self.rng.range(0.0, t.len[k]);
                self.place_on_route(k);
                self.slot_reset(k, false);
            }
        }
    }
    /// Seed one lane or loiter row with a Poisson number of ships about `mean`; false once there is no slot left.
    fn seed_lane(&mut self, stream: u8, from: End, to: End, mean: f64, row: Option<usize>) -> bool {
        if mean <= 0.0 { return true; }
        for _ in 0..self.poisson(mean) {
            let Some(k) = self.spawn(stream, from, to, row) else { return false };
            let t = &mut self.traffic;
            t.phase[k] = T_CRUISE;
            t.s[k] = self.rng.range(0.0, t.len[k]);
            self.place_on_route(k);
            self.slot_reset(k, false);
        }
        true
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
        let player = usize::try_from(self.game.player[0]).ok();
        if let Some(i) = (0..self.count).find(|&i| Some(i) != player && self.ships.alive[i] == 0 && self.traffic.role[i] == 0) { return Some(i); }
        if self.count < self.cfg.max_ships { self.count += 1; return Some(self.count - 1); }
        None
    }

    /// Write slot k's route: from `from` to `to` (a loiter when they are the same body); returns the point count.
    fn build_route(&mut self, k: usize, from: End, to: End) -> usize {
        let base = k * crate::traffic::MAX_PTS;
        let mut pts = [(0.0, 0.0); MAX_PTS];
        let n_pts;
        if let (End::Body(j), true) = (from, from == to) {
            // a loiter: out to the orbit, round it, back in
            let (cx, cy, r) = (self.bodies.x[j], self.bodies.y[j], self.bodies.r[j]);
            let orbit = r * self.p(P::loiter_orbit) * self.rng.range(0.85, 1.15);
            let (a0, dir) = (self.rng.range(0.0, TAU), if self.rng.next_f64() < 0.5 { 1.0 } else { -1.0 });
            let sweep = TAU * self.p(P::loiter_turns) * self.rng.range(0.6, 1.4);
            let n = MAX_PTS - 2;
            for i in 0..n { let a = a0 + dir * sweep * i as f64 / (n - 1) as f64; pts[i + 1] = (cx + cos(a) * orbit, cy + sin(a) * orbit); }
            pts[0] = self.end_point(from, pts[1]);
            pts[n + 1] = self.end_point(to, pts[n]);
            n_pts = MAX_PTS;
        } else {
            let [mut a, w, mut e] = self.route_ends(from, to);
            // jump zones are wide: arrive and leave anywhere in them; a port's disc too, so ships lift off and set down
            // all over it rather than at the one spot facing the other end
            let spread = self.p(P::jump_spread);
            if let End::Jump(_) = from { let (r, t) = (spread * self.rng.next_f64().sqrt(), self.rng.range(0.0, TAU)); a = (a.0 + cos(t) * r, a.1 + sin(t) * r); }
            if let End::Jump(_) = to { let (r, t) = (spread * self.rng.next_f64().sqrt(), self.rng.range(0.0, TAU)); e = (e.0 + cos(t) * r, e.1 + sin(t) * r); }
            if let End::Body(j) = from { a = self.spot(j, a); }
            if let End::Body(j) = to { e = self.spot(j, e); }
            // the path: bowed sideways into an arc or an S through two waypoints, a ship's own, unless a body is in the
            // way (then the detour's waypoint, as before) or the bow would bring one too close
            let skip = |x: End| match x { End::Body(j) => j, End::Jump(_) => usize::MAX };
            let ends = [skip(from), skip(to)];
            let straight = self.detour(a, e, ends).is_none();
            let (dx, dy) = (e.0 - a.0, e.1 - a.1);
            let len = hypot(dx, dy).max(1.0);
            let (nx, ny) = (-dy / len, dx / len);
            let (b1, b2) = (self.rng.range(-0.3, 0.3), if self.rng.next_f64() < 0.5 { self.rng.range(-0.3, 0.3) } else { 0.0 });
            let (t1, t2) = (self.rng.range(0.25, 0.4), self.rng.range(0.6, 0.75));
            let b2 = if b2 == 0.0 { b1 * self.rng.range(0.5, 1.0) } else { b2 }; // same side: an arc; either side: an S
            let w1 = (a.0 + dx * t1 + nx * len * b1, a.1 + dy * t1 + ny * len * b1);
            let w2 = (a.0 + dx * t2 + nx * len * b2, a.1 + dy * t2 + ny * len * b2);
            let clear = |p: (f64, f64), q: (f64, f64)| self.detour(p, q, ends).is_none();
            if straight && clear(a, w1) && clear(w1, w2) && clear(w2, e) {
                pts[..4].copy_from_slice(&[a, w1, w2, e]);
                n_pts = 4;
            } else {
                let w = if straight { ((a.0 + e.0) / 2.0, (a.1 + e.1) / 2.0) } else { w };
                pts[..3].copy_from_slice(&[a, w, e]);
                n_pts = 3;
            }
        }
        let pts = &pts[..n_pts];
        let mut len = 0.0;
        for (i, p) in pts.iter().enumerate() {
            if i > 0 { len += hypot(p.0 - pts[i - 1].0, p.1 - pts[i - 1].1); }
            self.route.x[base + i] = p.0; self.route.y[base + i] = p.1; self.route.s[base + i] = len;
        }
        self.traffic.len[k] = len;
        self.traffic.npts[k] = pts.len() as u8;
        pts.len()
    }
    fn pt(&self, k: usize, i: usize) -> (f64, f64) { let b = k * MAX_PTS + i; (self.route.x[b], self.route.y[b]) }
    /// A ship's own spot on body j's disc near `p` (the point facing the route's other end): turned up to 50 degrees
    /// round the body and from a tenth to over half its radius in, so still inside its landing zone.
    fn spot(&mut self, j: usize, p: (f64, f64)) -> (f64, f64) {
        let (cx, cy, r) = (self.bodies.x[j], self.bodies.y[j], self.bodies.r[j]);
        let a = atan2(p.1 - cy, p.0 - cx) + self.rng.range(-0.87, 0.87);
        let d = r * self.rng.range(0.1, 0.55);
        (cx + cos(a) * d, cy + sin(a) * d)
    }

    /// A new ship of a stream from `from` to `to`, its type drawn from the stream's mix (or the loiter row given).
    /// From a port it lifts off (T_LAUNCH); from a jump zone it arrives already cruising.
    pub(crate) fn spawn(&mut self, stream: u8, from: End, to: End, row: Option<usize>) -> Option<usize> {
        let m = match row { Some(m) => m, None => self.pick_mix(if stream == LOCAL { MIX_LOCAL } else { MIX_THROUGH })? };
        let k = self.free_slot()?;
        let kind = self.mix.kind[m];
        // each ship its own pace, a little under or over the stream's
        let cruise = self.types.vmax[kind as usize] * if stream == LOITER { self.p(P::loiter_cruise) } else { self.p(P::traffic_cruise) } * self.rng.range(0.85, 1.1);
        self.build_route(k, from, to);
        let (a, b) = (self.pt(k, 0), self.pt(k, 1));
        let s = &mut self.ships;
        s.alive[k] = 1; s.rail[k] = 1; s.kind[k] = kind; s.hull[k] = self.types.hull[kind as usize];
        s.x[k] = a.0; s.y[k] = a.1; s.vx[k] = 0.0; s.vy[k] = 0.0; s.av[k] = 0.0;
        s.ang[k] = atan2(-(b.0 - a.0), b.1 - a.1);
        s.turn_in[k] = 0.0; s.main[k] = 0.0; s.lat[k] = 0.0; s.thr[k] = 0.0; s.burn[k] = 0; s.rot[k] = 0; s.ctl[k] = 1;
        s.want_vx[k] = 0.0; s.want_vy[k] = 0.0;
        let t = &mut self.traffic;
        t.role[k] = stream; t.mix[k] = m as u8; t.leg[k] = 0;
        t.from[k] = from.code(); t.to[k] = to.code();
        t.s[k] = 0.0; t.cruise[k] = cruise; t.age[k] = 0.0;
        if let End::Body(_) = from { t.phase[k] = T_LAUNCH; t.timer[k] = LAUNCH_S; self.slot_reset(k, true); }
        else { t.phase[k] = T_CRUISE; t.timer[k] = 0.0; self.place_on_route(k); self.slot_reset(k, true); }
        Some(k)
    }

    /// Put a railed ship at its route position `s`, facing along the route, moving at cruise. Ships move forward
    /// along their routes, so the search starts from the leg it was on (from the start if it is already past `s`).
    fn place_on_route(&mut self, k: usize) {
        let (n, base, s) = (self.traffic.npts[k] as usize, k * MAX_PTS, self.traffic.s[k]);
        let mut leg = self.traffic.leg[k] as usize;
        if leg + 1 >= n || self.route.s[base + leg] > s { leg = 0; }
        while leg + 2 < n && s > self.route.s[base + leg + 1] { leg += 1; }
        self.traffic.leg[k] = leg as u8;
        // corners are rounded: within `c` of an interior point the ship follows a quadratic curve from the point c
        // before it to the point c after it, so its heading turns smoothly instead of snapping at the waypoint
        let (x, y, dx, dy);
        let corner = |j: usize| -> f64 { // the rounding distance at interior point j
            let (a, b) = (self.route.s[base + j] - self.route.s[base + j - 1], self.route.s[base + j + 1] - self.route.s[base + j]);
            CORNER.min(a * 0.45).min(b * 0.45)
        };
        let near = if leg > 0 && s - self.route.s[base + leg] < corner(leg) { Some(leg) }
            else if leg + 2 < n && self.route.s[base + leg + 1] - s < corner(leg + 1) { Some(leg + 1) } else { None };
        if let Some(j) = near {
            let (c, sj) = (corner(j), self.route.s[base + j]);
            let (pa, pj, pb) = (self.pt(k, j - 1), self.pt(k, j), self.pt(k, j + 1));
            let (la, lb) = (hypot(pj.0 - pa.0, pj.1 - pa.1).max(1e-6), hypot(pb.0 - pj.0, pb.1 - pj.1).max(1e-6));
            let a = (pj.0 - (pj.0 - pa.0) / la * c, pj.1 - (pj.1 - pa.1) / la * c);
            let b = (pj.0 + (pb.0 - pj.0) / lb * c, pj.1 + (pb.1 - pj.1) / lb * c);
            let t = ((s - (sj - c)) / (2.0 * c)).clamp(0.0, 1.0);
            let u = 1.0 - t;
            x = u * u * a.0 + 2.0 * u * t * pj.0 + t * t * b.0;
            y = u * u * a.1 + 2.0 * u * t * pj.1 + t * t * b.1;
            dx = u * (pj.0 - a.0) + t * (b.0 - pj.0);
            dy = u * (pj.1 - a.1) + t * (b.1 - pj.1);
        } else {
            let (p0, p1) = (self.pt(k, leg), self.pt(k, leg + 1));
            (dx, dy) = (p1.0 - p0.0, p1.1 - p0.1);
            let f = ((s - self.route.s[base + leg]) / hypot(dx, dy).max(1e-6)).min(1.0);
            (x, y) = (p0.0 + dx * f, p0.1 + dy * f);
        }
        let d = hypot(dx, dy).max(1e-6);
        let cruise = self.traffic.cruise[k];
        // a loiter round a moving station goes round with it (motion.rs carries the loop), so moves with it too
        let (bvx, bvy) = match (self.traffic.role[k], End::of(self.traffic.from[k])) { (LOITER, End::Body(j)) => (self.bodies.vx[j], self.bodies.vy[j]), _ => (0.0, 0.0) };
        let sh = &mut self.ships;
        sh.x[k] = x;
        sh.y[k] = y;
        sh.vx[k] = dx / d * cruise + bvx;
        sh.vy[k] = dy / d * cruise + bvy;
        sh.ang[k] = atan2(-dx, dy);
        sh.av[k] = 0.0;
        sh.thr[k] = 0.5;
    }

    /// The traffic stage, once per tick before the flight stages: arrivals, launches and landings, the rails, the
    /// switch between rails and physics by distance to the player, and the AI that flies the near ones.
    pub(crate) fn step_traffic(&mut self) {
        let nb = self.n_bodies;
        let now = self.tick as f64 * DT;
        // every lane launches as a Poisson process: each holds the time of its next launch, so a quiet lane costs a
        // compare (at most one launch a lane a tick)
        for i in 0..nb {
            if self.bodies.port[i] == 0 { continue; }
            for j in 0..nb {
                for role in 0..N_ROLES {
                    let l = self.lane(i, j, role);
                    if self.lanes.rate[l] > 0.0 && self.lanes.next[l] <= now {
                        self.lanes.next[l] += self.gap(self.lanes.rate[l]);
                        self.spawn(LOCAL, End::Body(i), End::Body(j), None);
                    }
                }
            }
        }
        // through: arrivals at the jump zones, departures from the ports
        for z in 0..N_JUMP {
            for j in 0..nb {
                for (dir, from, to, stream) in [(0, End::Jump(z), End::Body(j), ARRIVE), (1, End::Body(j), End::Jump(z), DEPART)] {
                    let l = self.jlane(dir, z, j);
                    if self.jlanes.rate[l] > 0.0 && self.jlanes.next[l] <= now {
                        self.jlanes.next[l] += self.gap(self.jlanes.rate[l]);
                        self.spawn(stream, from, to, None);
                    }
                }
            }
        }
        // loiter: each row launches at its rate
        for m in 0..MAX_MIX {
            if self.mix.stream[m] == MIX_LOITER && self.mix.body[m] >= 0 && self.mix.rate[m] > 0.0 && self.mix.next[m] <= now {
                self.mix.next[m] += self.gap(self.mix.rate[m]);
                let j = End::Body(self.mix.body[m] as usize);
                self.spawn(LOITER, j, j, Some(m));
            }
        }
        // environmental stations: each launches at its own rate (half of them are ships arriving to dock instead)
        for j in 0..nb {
            if self.bodies.env[j] != 0 && self.bodies.env_rate[j] > 0.0 && self.bodies.env_next[j] <= now {
                self.bodies.env_next[j] += self.gap(self.bodies.env_rate[j]);
                self.spawn_env(j);
            }
        }
        let (near, far) = (self.p(P::traffic_near), self.p(P::traffic_near) * 1.25);
        let player = usize::try_from(self.game.player[0]).ok().filter(|&p| p < self.count);
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

    pub(crate) fn despawn(&mut self, k: usize) {
        self.ships.alive[k] = 0;
        self.ships.rail[k] = 0;
        self.traffic.role[k] = 0;
        self.traffic.phase[k] = 0;
        // shrink the live range past trailing dead slots
        while self.count > 0 && self.ships.alive[self.count - 1] == 0 && self.traffic.role[self.count - 1] == 0
            && usize::try_from(self.game.player[0]).ok() != Some(self.count - 1) { self.count -= 1; }
    }

    /// Begin the landing (or docking) sequence where the ship is.
    fn land(&mut self, k: usize) {
        let s = &mut self.ships;
        s.rail[k] = 1; s.vx[k] = 0.0; s.vy[k] = 0.0; s.av[k] = 0.0; s.thr[k] = 0.0;
        s.main[k] = 0.0; s.lat[k] = 0.0; s.turn_in[k] = 0.0;
        self.traffic.phase[k] = T_LAND;
        self.traffic.timer[k] = DESCENT_S;
    }

    /// The end of the route reached: land at a body, or leave by a jump zone.
    fn arrive(&mut self, k: usize) {
        match End::of(self.traffic.to[k]) { End::Body(_) => self.land(k), End::Jump(_) => self.despawn(k) }
    }

    fn cruise_step(&mut self, k: usize, px: f64, py: f64, near: f64, far: f64) {
        let d_player = hypot(self.ships.x[k] - px, self.ships.y[k] - py);
        // a ship that somehow never arrives (stuck in a well, say) is retired
        if self.traffic.age[k] > 3.0 * self.traffic.len[k] / self.traffic.cruise[k].max(1.0) + 120.0 { self.despawn(k); return; }
        let n = self.traffic.npts[k] as usize;
        if self.ships.rail[k] != 0 {
            if d_player < near { // close to the player: hand over to the physics, moving as it was
                self.ships.rail[k] = 0;
            } else {
                self.traffic.s[k] += self.traffic.cruise[k] * DT;
                if self.traffic.s[k] >= self.traffic.len[k] {
                    self.traffic.s[k] = self.traffic.len[k];
                    self.place_on_route(k);
                    self.arrive(k);
                } else { self.place_on_route(k); }
                return;
            }
        } else if d_player > far {
            // far again: back onto the rails, at the nearest point of its current leg
            let leg = self.traffic.leg[k] as usize;
            let base = self.route.s[k * MAX_PTS + leg];
            let (p0, p1) = (self.pt(k, leg), self.pt(k, leg + 1));
            let (dx, dy) = (p1.0 - p0.0, p1.1 - p0.1);
            let l = hypot(dx, dy).max(1e-6);
            let along = (((self.ships.x[k] - p0.0) * dx + (self.ships.y[k] - p0.1) * dy) / l).clamp(0.0, l);
            self.traffic.s[k] = base + along;
            self.ships.rail[k] = 1;
            self.place_on_route(k);
            return;
        }
        // physics: steer for the next point; on the last leg, arrive slow enough to land (or fly on out of a zone)
        let leg = self.traffic.leg[k] as usize;
        let (tx, ty) = self.pt(k, leg + 1);
        let (dx, dy) = (tx - self.ships.x[k], ty - self.ships.y[k]);
        let d = hypot(dx, dy);
        let cruise = self.traffic.cruise[k];
        if leg + 2 < n {
            if d < 800.0 { self.traffic.leg[k] = (leg + 1) as u8; }
            let v = cruise / d.max(1e-6);
            self.ships.want_vx[k] = dx * v;
            self.ships.want_vy[k] = dy * v;
            return;
        }
        let End::Body(to) = End::of(self.traffic.to[k]) else {
            if d < 600.0 { self.despawn(k); return; } // left by the jump zone
            let v = cruise / d.max(1e-6);
            self.ships.want_vx[k] = dx * v;
            self.ships.want_vy[k] = dy * v;
            return;
        };
        // brake to half the landing limit by `stop` metres out, then creep in; land once inside 1.5 x stop and slow
        // (always inside the landing zone: stations 0.6 radii, planets 0.95)
        // (relative to the port: a moving station's velocity fades in as the ship nears it, motion.rs)
        let limit = if self.bodies.kind[to] == BODY_STATION { self.p(P::dock_speed) } else { self.p(P::land_speed) };
        let stop = (self.bodies.r[to] * 0.25).max(80.0);
        let (fx, fy) = self.frame_of(to, self.ships.x[k], self.ships.y[k]);
        let sp = hypot(self.ships.vx[k] - self.bodies.vx[to], self.ships.vy[k] - self.bodies.vy[to]);
        if d < stop * 1.5 && sp < limit { self.land(k); return; }
        let brake = self.types.accel[self.ships.kind[k] as usize] * 0.35;
        let v = cruise.min((2.0 * brake * (d - stop).max(0.0)).sqrt() * 0.8).max(limit * 0.5) / d.max(1e-6);
        self.ships.want_vx[k] = fx + dx * v;
        self.ships.want_vy[k] = fy + dy * v;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::{BODY_PLANET, MODE_FLYING};
    use crate::world::Config;

    /// The star at the origin, two planet ports either side of it (so routes must bend round it), a station port
    /// off to one side; a player ship far away; one ship type; a mix of it in every stream, and two loitering round
    /// the first planet.
    fn world(seed: u64) -> Box<World> {
        let mut w = World::new(Config { max_ships: 80, max_types: 1, max_bodies: 4, env_n: 4, env_w: 1000.0 }, seed);
        (w.types.accel[0], w.types.turn[0], w.types.vmax[0], w.types.well[0]) = (40.0, 1.0, 150.0, 0.5);
        w.n_bodies = 4;
        for (j, (x, y, r, kind, port, pop)) in [(0.0, 0.0, 2000.0, BODY_STAR, 0, 0.0), (-15_000.0, 0.0, 800.0, BODY_PLANET, 1, 10.0),
            (15_000.0, 0.0, 800.0, BODY_PLANET, 1, 3.0), (0.0, 12_000.0, 300.0, BODY_STATION, 1, 3.0)].into_iter().enumerate() {
            let b = &mut w.bodies;
            (b.x[j], b.y[j], b.r[j], b.kind[j], b.port[j], b.pop[j], b.g[j]) = (x, y, r, kind, port, pop, 20.0);
        }
        w.params[P::jump_radius as usize] = 30_000.0;
        for (m, (stream, body, weight)) in [(MIX_LOCAL, -1, 1.0), (MIX_THROUGH, -1, 1.0), (MIX_LOITER, 1, 2.0)].into_iter().enumerate() {
            (w.mix.stream[m], w.mix.body[m], w.mix.kind[m], w.mix.weight[m]) = (stream, body, 0, weight);
        }
        w.market.price[MAX_GOODS] = 10;       // body 1 sells commodity 0 cheap
        w.market.price[2 * MAX_GOODS] = 30;   // body 2 pays well for it
        w.count = 1;
        w.game.player[0] = 0;
        w.ships.alive[0] = 1;
        w.ships.x[0] = 0.0; w.ships.y[0] = -60_000.0;
        w.game.mode[0] = MODE_FLYING;
        w.plan_traffic();
        w
    }
    fn count(w: &World, role: u8) -> usize { (0..w.count).filter(|&k| w.traffic.role[k] == role).count() }

    #[test]
    fn environmental_stations_launch_and_take_ships() {
        let mut w = world(5);
        // the station off to one side becomes an environmental station: no port, its own group's mix
        let j = 3;
        (w.bodies.port[j], w.bodies.pop[j], w.bodies.env[j], w.bodies.env_rate[j], w.bodies.env_jump[j]) = (0, 0.0, 1, 0.5, 0.4);
        let m = (0..MAX_MIX).find(|&m| w.mix.stream[m] == 0).unwrap();
        (w.mix.stream[m], w.mix.body[m], w.mix.kind[m], w.mix.weight[m]) = (MIX_ENV, 0, 0, 1.0);
        w.plan_traffic();
        let (mut out, mut inbound, mut jump) = (0, 0, 0);
        for _ in 0..60 * 120 {
            w.step();
            for k in 0..w.count {
                if w.traffic.role[k] != ENVIRON || w.traffic.age[k] > DT * 1.5 { continue; } // count each once, in its first tick
                let (from, to) = (End::of(w.traffic.from[k]), End::of(w.traffic.to[k]));
                if from == End::Body(j) { out += 1 } else if to == End::Body(j) { inbound += 1 } else { panic!("{from:?} -> {to:?}") }
                if matches!(from, End::Jump(_)) || matches!(to, End::Jump(_)) { jump += 1 }
                assert_eq!(w.mix.kind[w.traffic.mix[k] as usize], 0);
            }
        }
        // about 60 launches in two minutes at 0.5 a second, half each way, some through the jump zones
        assert!(out > 10 && inbound > 10 && jump > 5, "out {out} in {inbound} jump {jump}");
    }

    #[test]
    fn ships_on_one_lane_take_their_own_routes() {
        // the station port (3) to planet 2: nothing in the way, so each ship lifts off from its own spot, bows its own
        // way and keeps clear of every body
        let mut w = world(4);
        let (mut starts, mut bowed) = (Vec::new(), 0);
        for _ in 0..12 {
            let k = w.spawn(LOCAL, End::Body(3), End::Body(2), None).expect("a slot");
            let n = w.traffic.npts[k] as usize;
            starts.push(w.pt(k, 0));
            if n == 4 { bowed += 1; }
            for i in 1..n { assert!(w.detour(w.pt(k, i - 1), w.pt(k, i), [3, 2]).is_none(), "leg {i} of ship {k} runs into a body"); }
            let (a, e) = (w.pt(k, 0), w.pt(k, n - 1));
            assert!(hypot(a.0, a.1 - 12_000.0) < 300.0 * 0.6 && hypot(e.0 - 15_000.0, e.1) < 800.0 * 0.6, "ends inside the ports' landing zones");
        }
        starts.sort_by(|p, q| p.0.total_cmp(&q.0));
        starts.dedup_by(|p, q| hypot(p.0 - q.0, p.1 - q.1) < 1.0);
        assert!(starts.len() >= 10 && bowed >= 8, "{} distinct starts, {bowed} of 12 bowed", starts.len());
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
    fn routes_keep_clear_of_a_hazard_zone() {
        let mut w = world(1);
        w.bodies.hazard[0] = 9000.0; // the star at the origin, now an exotic: a 9 km zone, far past its 2 radii
        let [a, wp, e] = w.route(1, 2);
        for (p, q) in [(a, wp), (wp, e)] {
            // the closest each leg comes to the star
            let (dx, dy) = (q.0 - p.0, q.1 - p.1);
            let t = ((-p.0 * dx - p.1 * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
            assert!(hypot(p.0 + dx * t, p.1 + dy * t) > 9000.0, "a leg passes {} m from the star", hypot(p.0 + dx * t, p.1 + dy * t));
        }
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
        // steady state: each role's share of the local ships, and the through lanes the rest
        let local = w.p(P::traffic_ships) * (1.0 - w.p(P::share_through));
        for role in 0..N_ROLES {
            let n: f64 = (0..4).flat_map(|i| (0..4).map(move |j| (i, j))).map(|(i, j)| { let l = w.lane(i, j, role); w.lanes.rate[l] * w.lanes.dwell[l] }).sum();
            let share = [w.p(P::share_shuttle), w.p(P::share_hauler), w.p(P::share_liner)][role];
            assert!((n - local * share).abs() < 1e-9, "{role}: {n}");
        }
        let through: f64 = (0..w.jlanes.cap).map(|l| w.jlanes.rate[l] * w.jlanes.dwell[l]).sum();
        assert!((through - w.p(P::traffic_ships) * w.p(P::share_through)).abs() < 1e-9, "{through}");
        assert!(w.jlanes.rate[w.jlane(0, 0, 1)] > 3.0 * w.jlanes.rate[w.jlane(0, 0, 2)]); // the bigger port draws more
        assert_eq!(rate(0, 1, 0), 0.0); // the star is no port
        assert_eq!(w.jlanes.rate[w.jlane(0, 0, 0)], 0.0);
    }

    #[test]
    fn arrivals_land_and_departures_leave_by_a_jump_zone() {
        let mut w = world(2);
        w.params[P::traffic_ships as usize] = 0.0; w.mix.weight[2] = 0.0; w.plan_traffic(); // nothing else
        let a = w.spawn(ARRIVE, End::Jump(0), End::Body(2), None).unwrap();
        let d = w.spawn(DEPART, End::Body(1), End::Jump(3), None).unwrap();
        // the arrival appears cruising in the north zone; the departure lifts off its port
        let north = w.jump_point(0);
        assert!(hypot(w.ships.x[a] - north.0, w.ships.y[a] - north.1) <= w.p(P::jump_spread) + 1.0);
        assert_eq!((w.traffic.phase[a], w.traffic.phase[d]), (T_CRUISE, T_LAUNCH));
        let (mut landed, mut gone_at) = (false, None);
        for _ in 0..(900.0 / DT) as usize {
            if w.traffic.role[a] == ARRIVE && w.traffic.phase[a] == T_LAND { landed = true; }
            if w.traffic.role[d] == DEPART { let west = w.jump_point(3); gone_at = Some(hypot(w.ships.x[d] - west.0, w.ships.y[d] - west.1)); }
            w.step();
            if w.traffic.role[a] == 0 && w.traffic.role[d] == 0 { break; }
        }
        assert!(landed, "the arrival never landed");
        assert_eq!((w.traffic.role[a], w.traffic.role[d]), (0, 0));
        assert!(gone_at.unwrap() < w.p(P::jump_spread) + 600.0, "left {:?} m from the west zone", gone_at);
    }

    #[test]
    fn loiterers_circle_their_port_and_land_there() {
        let mut w = world(3);
        w.params[P::traffic_ships as usize] = 0.0; w.plan_traffic(); // loiter only
        let k = w.spawn(LOITER, End::Body(1), End::Body(1), Some(2)).unwrap();
        let (cx, r) = (w.bodies.x[1], w.bodies.r[1]);
        let mut far = 0.0f64;
        let mut landed_at = None;
        for _ in 0..(900.0 / DT) as usize {
            w.step();
            if w.traffic.role[k] != LOITER { break; }
            far = far.max(hypot(w.ships.x[k] - cx, w.ships.y[k]));
            if w.traffic.phase[k] == T_LAND { landed_at = Some(hypot(w.ships.x[k] - cx, w.ships.y[k])); }
        }
        assert!(far > r * 2.0 && far < r * w.p(P::loiter_orbit) * 1.3, "circled at {far} m");
        assert!(landed_at.unwrap() < r, "landed {landed_at:?} m out");
    }

    #[test]
    fn steady_state_and_turnover() {
        let mut w = world(4);
        w.seed_traffic();
        let n0 = w.traffic_count();
        assert!(n0 > 8 && n0 as f64 <= w.p(P::traffic_cap), "{n0}");
        assert!((1..w.count).all(|k| w.traffic.phase[k] == T_CRUISE && w.ships.rail[k] == 1));
        // ten minutes: ships land and leave, new ones launch and arrive; the counts stay near their targets
        let first: Vec<u32> = (1..w.count).map(|k| w.handle(k)).collect();
        let (mut seen, mut through, mut loiter) = (0.0, 0.0, 0.0);
        for t in 0..36_000 {
            w.step();
            if t % 600 == 0 { seen += w.traffic_count() as f64; through += (count(&w, ARRIVE) + count(&w, DEPART)) as f64; loiter += count(&w, LOITER) as f64; }
        }
        assert!(first.iter().all(|&h| w.resolve(h).is_none())); // every ship from the start has gone
        let target = w.p(P::traffic_ships) + 2.0;
        let (mean, through, loiter) = (seen / 60.0, through / 60.0, loiter / 60.0);
        assert!(mean > target * 0.6 && mean < target * 1.5, "{mean}");
        assert!(through > w.p(P::traffic_ships) * w.p(P::share_through) * 0.5, "{through}");
        assert!(loiter > 0.8 && loiter < 4.0, "{loiter}");
        assert!(w.count <= w.cfg.max_ships);
    }

    #[test]
    fn near_the_player_ships_fly_and_land_under_physics() {
        let mut w = world(5);
        w.params[P::traffic_ships as usize] = 0.0; w.mix.weight[2] = 0.0; w.plan_traffic(); // no arrivals: one ship, by hand
        let k = w.spawn(LOCAL, End::Body(1), End::Body(3), None).unwrap();
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
