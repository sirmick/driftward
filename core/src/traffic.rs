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
use crate::math::{atan2, cos, exp, hypot, sin, TAU};
use crate::port::{BODY_STAR, BODY_STATION, DESCENT_S, DONE, LAUNCH_S};
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

/// Mix row streams.
pub const MIX_LOCAL: u8 = 1;
pub const MIX_THROUGH: u8 = 2;
pub const MIX_LOITER: u8 = 3;
pub const MAX_MIX: usize = 48;

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

    /// The mix rows of a stream, and their summed weight.
    fn mix_rows(&self, stream: u8) -> (Vec<usize>, f64) {
        let rows: Vec<usize> = (0..MAX_MIX).filter(|&m| self.mix.stream[m] == stream && self.mix.weight[m] > 0.0).collect();
        let total = rows.iter().map(|&m| self.mix.weight[m]).sum();
        (rows, total)
    }
    /// A stream's cruising speed for planning dwell times: the weighted harmonic mean, since a route's mean time is
    /// its length times the mean of 1 / speed (slow hulls spend longer on it, so they count for more).
    fn mean_cruise(&self, stream: u8) -> f64 {
        let (rows, total) = self.mix_rows(stream);
        if total <= 0.0 { return 1.0; }
        let slowness: f64 = rows.iter().map(|&m| self.mix.weight[m] / self.types.vmax[self.mix.kind[m] as usize].max(1.0)).sum::<f64>() / total;
        self.p(P::traffic_cruise) / slowness
    }
    /// Draw a mix row of a stream by weight.
    fn pick_mix(&mut self, stream: u8) -> Option<usize> {
        let (rows, total) = self.mix_rows(stream);
        if rows.is_empty() { return None; }
        let mut x = self.rng.next_f64() * total;
        for &m in &rows { x -= self.mix.weight[m]; if x <= 0.0 { return Some(m); } }
        rows.last().copied()
    }
    fn route_len(pts: &[(f64, f64); 3]) -> f64 { hypot(pts[1].0 - pts[0].0, pts[1].1 - pts[0].1) + hypot(pts[2].0 - pts[1].0, pts[2].1 - pts[1].1) }

    /// Plan the traffic: every local lane's and through lane's rate (ships a second) and dwell (seconds a ship
    /// spends on it, launch and landing included), and each loiter row's. Call after the bodies, markets,
    /// populations and the mix are written (a new game); rates are saved with the world.
    pub fn plan_traffic(&mut self) {
        self.lanes.clear();
        self.jlanes.clear();
        let nb = self.n_bodies;
        let ports: Vec<usize> = (0..nb).filter(|&j| self.bodies.port[j] != 0).collect();
        let (local_ships, through_ships) = (self.p(P::traffic_ships) * (1.0 - self.p(P::share_through)), self.p(P::traffic_ships) * self.p(P::share_through));
        // local: per role, a gravity model over the routes, scaled to the role's share of the local ships
        if self.mix_rows(MIX_LOCAL).1 > 0.0 {
            let cruise = self.mean_cruise(MIX_LOCAL);
            let shares = [self.p(P::share_shuttle), self.p(P::share_hauler), self.p(P::share_liner)];
            for (role, share) in shares.into_iter().enumerate() {
                let mut total = 0.0; // sum of weight x dwell, to scale the rates
                for &i in &ports {
                    for &j in &ports {
                        if i == j { continue; }
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
                for &i in &ports { for &j in &ports { if i != j { let l = self.lane(i, j, role); self.lanes.rate[l] *= k; } } }
            }
        }
        // through: arrivals at each zone bound for each port, and departures, both by the port's population
        if self.mix_rows(MIX_THROUGH).1 > 0.0 {
            let cruise = self.mean_cruise(MIX_THROUGH);
            let mut total = 0.0;
            for dir in 0..2 {
                for z in 0..N_JUMP {
                    for &j in &ports {
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

    /// Traffic in flight now.
    pub fn traffic_count(&self) -> usize { (0..self.count).filter(|&i| self.traffic.role[i] != 0).count() }

    /// Seed the steady state for a new game: on every lane and loiter row, a Poisson number of ships (mean rate x
    /// dwell), spread along their routes, already cruising. Call after `plan_traffic` and after the player's slot.
    pub fn seed_traffic(&mut self) {
        let nb = self.n_bodies;
        let mut want: Vec<(u8, End, End, f64, Option<usize>)> = Vec::new(); // stream, from, to, mean, loiter row
        for i in 0..nb { for j in 0..nb { for role in 0..N_ROLES {
            let l = self.lane(i, j, role);
            want.push((LOCAL, End::Body(i), End::Body(j), self.lanes.rate[l] * self.lanes.dwell[l], None));
        } } }
        for z in 0..N_JUMP { for j in 0..nb {
            let (a, d) = (self.jlane(0, z, j), self.jlane(1, z, j));
            want.push((ARRIVE, End::Jump(z), End::Body(j), self.jlanes.rate[a] * self.jlanes.dwell[a], None));
            want.push((DEPART, End::Body(j), End::Jump(z), self.jlanes.rate[d] * self.jlanes.dwell[d], None));
        } }
        for m in 0..MAX_MIX {
            if self.mix.stream[m] == MIX_LOITER && self.mix.body[m] >= 0 {
                let j = End::Body(self.mix.body[m] as usize);
                want.push((LOITER, j, j, self.mix.weight[m], Some(m)));
            }
        }
        for (stream, from, to, mean, row) in want {
            if mean <= 0.0 { continue; }
            for _ in 0..self.poisson(mean) {
                let Some(k) = self.spawn(stream, from, to, row) else { return };
                let t = &mut self.traffic;
                t.phase[k] = T_CRUISE;
                t.s[k] = self.rng.range(0.0, t.len[k]);
                self.place_on_route(k);
                self.slot_reset(k, false);
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

    /// Write slot k's route: from `from` to `to` (a loiter when they are the same body); returns the point count.
    fn build_route(&mut self, k: usize, from: End, to: End) -> usize {
        let base = k * crate::traffic::MAX_PTS;
        let mut pts: Vec<(f64, f64)> = Vec::with_capacity(MAX_PTS);
        if let (End::Body(j), true) = (from, from == to) {
            // a loiter: out to the orbit, round it, back in
            let (cx, cy, r) = (self.bodies.x[j], self.bodies.y[j], self.bodies.r[j]);
            let orbit = r * self.p(P::loiter_orbit) * self.rng.range(0.85, 1.15);
            let (a0, dir) = (self.rng.range(0.0, TAU), if self.rng.next_f64() < 0.5 { 1.0 } else { -1.0 });
            let sweep = TAU * self.p(P::loiter_turns) * self.rng.range(0.6, 1.4);
            let n = MAX_PTS - 2;
            let ring: Vec<(f64, f64)> = (0..n).map(|i| { let a = a0 + dir * sweep * i as f64 / (n - 1) as f64; (cx + cos(a) * orbit, cy + sin(a) * orbit) }).collect();
            pts.push(self.end_point(from, ring[0]));
            pts.extend(ring.iter().copied());
            pts.push(self.end_point(to, ring[n - 1]));
        } else {
            let [mut a, w, mut e] = self.route_ends(from, to);
            // jump zones are wide: arrive and leave anywhere in them
            let spread = self.p(P::jump_spread);
            if let End::Jump(_) = from { let (r, t) = (spread * self.rng.next_f64().sqrt(), self.rng.range(0.0, TAU)); a = (a.0 + cos(t) * r, a.1 + sin(t) * r); }
            if let End::Jump(_) = to { let (r, t) = (spread * self.rng.next_f64().sqrt(), self.rng.range(0.0, TAU)); e = (e.0 + cos(t) * r, e.1 + sin(t) * r); }
            pts.extend([a, w, e]);
        }
        let mut len = 0.0;
        for (i, p) in pts.iter().enumerate() {
            self.route.x[base + i] = p.0; self.route.y[base + i] = p.1;
            if i > 0 { len += hypot(p.0 - pts[i - 1].0, p.1 - pts[i - 1].1); }
        }
        self.traffic.len[k] = len;
        self.traffic.npts[k] = pts.len() as u8;
        pts.len()
    }
    fn pt(&self, k: usize, i: usize) -> (f64, f64) { let b = k * MAX_PTS + i; (self.route.x[b], self.route.y[b]) }

    /// A new ship of a stream from `from` to `to`, its type drawn from the stream's mix (or the loiter row given).
    /// From a port it lifts off (T_LAUNCH); from a jump zone it arrives already cruising.
    fn spawn(&mut self, stream: u8, from: End, to: End, row: Option<usize>) -> Option<usize> {
        let m = match row { Some(m) => m, None => self.pick_mix(if stream == LOCAL { MIX_LOCAL } else { MIX_THROUGH })? };
        let k = self.free_slot()?;
        let kind = self.mix.kind[m];
        let cruise = self.types.vmax[kind as usize] * if stream == LOITER { self.p(P::loiter_cruise) } else { self.p(P::traffic_cruise) };
        self.build_route(k, from, to);
        let (a, b) = (self.pt(k, 0), self.pt(k, 1));
        let s = &mut self.ships;
        s.alive[k] = 1; s.rail[k] = 1; s.kind[k] = kind;
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

    /// Put a railed ship at its route position `s`, facing along the route, moving at cruise.
    fn place_on_route(&mut self, k: usize) {
        let n = self.traffic.npts[k] as usize;
        let mut s = self.traffic.s[k];
        let mut leg = 0;
        let (mut p0, mut p1) = (self.pt(k, 0), self.pt(k, 1));
        while leg + 2 < n {
            let l = hypot(p1.0 - p0.0, p1.1 - p0.1);
            if s <= l { break; }
            s -= l; leg += 1; p0 = p1; p1 = self.pt(k, leg + 1);
        }
        let (dx, dy) = (p1.0 - p0.0, p1.1 - p0.1);
        let d = hypot(dx, dy).max(1e-6);
        let f = (s / d).min(1.0);
        let cruise = self.traffic.cruise[k];
        self.traffic.leg[k] = leg as u8;
        let sh = &mut self.ships;
        sh.x[k] = p0.0 + dx * f;
        sh.y[k] = p0.1 + dy * f;
        sh.vx[k] = dx / d * cruise;
        sh.vy[k] = dy / d * cruise;
        sh.ang[k] = atan2(-dx, dy);
        sh.av[k] = 0.0;
        sh.thr[k] = 0.5;
    }

    /// The traffic stage, once per tick before the flight stages: arrivals, launches and landings, the rails, the
    /// switch between rails and physics by distance to the player, and the AI that flies the near ones.
    pub(crate) fn step_traffic(&mut self) {
        let nb = self.n_bodies;
        // local: each lane launches ships as a Poisson process
        for i in 0..nb {
            if self.bodies.port[i] == 0 { continue; }
            for j in 0..nb {
                for role in 0..N_ROLES {
                    let rate = self.lanes.rate[self.lane(i, j, role)];
                    if rate > 0.0 && self.rng.next_f64() < rate * DT { self.spawn(LOCAL, End::Body(i), End::Body(j), None); }
                }
            }
        }
        // through: arrivals at the jump zones, departures from the ports
        for z in 0..N_JUMP {
            for j in 0..nb {
                let (a, d) = (self.jlanes.rate[self.jlane(0, z, j)], self.jlanes.rate[self.jlane(1, z, j)]);
                if a > 0.0 && self.rng.next_f64() < a * DT { self.spawn(ARRIVE, End::Jump(z), End::Body(j), None); }
                if d > 0.0 && self.rng.next_f64() < d * DT { self.spawn(DEPART, End::Body(j), End::Jump(z), None); }
            }
        }
        // loiter: each row launches at its rate
        for m in 0..MAX_MIX {
            if self.mix.stream[m] == MIX_LOITER && self.mix.body[m] >= 0 && self.mix.rate[m] > 0.0 && self.rng.next_f64() < self.mix.rate[m] * DT {
                let j = End::Body(self.mix.body[m] as usize);
                self.spawn(LOITER, j, j, Some(m));
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
            let mut base = 0.0;
            for i in 0..leg { let (a, b) = (self.pt(k, i), self.pt(k, i + 1)); base += hypot(b.0 - a.0, b.1 - a.1); }
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
        w.player.slot = 0;
        w.ships.alive[0] = 1;
        w.ships.x[0] = 0.0; w.ships.y[0] = -60_000.0;
        w.game.mode[0] = MODE_FLYING;
        w.plan_traffic();
        w
    }
    fn count(w: &World, role: u8) -> usize { (0..w.count).filter(|&k| w.traffic.role[k] == role).count() }

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
