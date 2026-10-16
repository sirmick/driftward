//! The atlas: the layouts of the systems this game has been to, held in the core so a jump between systems is the
//! core's own business and a replay across one reruns natively. Each slot holds one system, by its star id (the
//! universe index's, src/galaxy/universe.json). The page lays a system out the first time the game needs it (a new
//! game's start system; a jump's destination), exactly as it lays out the system being played (bodies placed with the
//! core's trig, populations, environmental stations, market prices, the traffic mix and the system's traffic params),
//! and stores that into a slot (`atlas_store`); `atlas_load` puts one back as the live system. It is content: never
//! changed by play, saved with the world. When every slot is full, a new system takes the slot of one the player is
//! not in and has no active mission to (`atlas_slot_for`).
//!
//! Replays: a slot stored during a session must reach a replay too, and a native replay has no page to lay it out, so
//! the page logs the slot's bytes (`atlas_row_get`; replay.rs `LogEntry::Atlas`) and the replay puts them back
//! (`atlas_row_put`) on the same tick.
//!
//! The debug jump (port.rs CMD_JUMP) loads a system and puts the player at rest over one of its bodies: the system
//! left behind loses its traffic and boards, the new one gets fresh ones, and the player keeps everything else
//! (credits, hold, missions; a mission is delivered only in the system it was taken for).

use crate::cols::{soa, ColumnDesc};
use crate::market::MAX_GOODS;
use crate::mission::{MAX_MISSIONS, M_ACTIVE};
use crate::port::{BODY_BELT, MODE_DEAD, MODE_DESCENDING, MODE_FLYING, MODE_LAUNCHING, NO_SUCH_BODY, OK, WRONG_MODE};
use crate::traffic::MAX_MIX;
use crate::world::{World, DT, P};

/// Systems the atlas holds.
pub const MAX_SYSTEMS: usize = 8;
/// A slot's id before anything is stored there (star ids start at 0).
pub const NO_SYSTEM: u32 = u32::MAX;

soa! {
    /// The atlas's one row: how many systems it holds.
    pub struct AtlasHead { n: u8 }
}

soa! {
    /// Per system: its star id (the universe index's), its body count, and its traffic params (jump_radius,
    /// traffic_ships, share_through).
    pub struct AtlasSys { id: u32, bodies: u16, jump_radius: f64, traffic_ships: f64, share_through: f64 }
}

soa! {
    /// Per system and body (system * max_bodies + body): the live body columns that are content (world.rs Bodies).
    pub struct AtlasBodies {
        x: f64, y: f64, r: f64, g: f64, pop: f64, kind: u8, port: u8, env: u8, env_rate: f64, env_jump: f64,
        reach: f64, hazard: f64, rad: f64, svc: u8, fuel_price: u32, orb_p: i16, orb_r: f64, orb_a: f64, orb_w: f64,
    }
}

soa! {
    /// Per system, body and commodity: the market price (world.rs Market).
    pub struct AtlasMarket { price: u32 }
}

soa! {
    /// Per system and mix row (system * MAX_MIX + row): the traffic mix as the page wrote it (world.rs Mix).
    pub struct AtlasMix { stream: u8, body: i16, kind: u16, weight: f64 }
}

impl World {
    /// Systems in the atlas.
    pub fn atlas_count(&self) -> usize { self.atlas_head.n[0] as usize }

    /// Empty the atlas (a new game starts with only its start system).
    pub fn atlas_reset(&mut self) {
        self.atlas_head.n[0] = 0;
        self.atlas_sys.id.fill(NO_SYSTEM);
    }

    /// The slot holding system `id`, if one does.
    pub fn atlas_find(&self, id: u32) -> Option<usize> { (0..self.atlas_count()).find(|&k| self.atlas_sys.id[k] == id) }

    /// Where system `id` goes: its own slot if it has one, else the next empty one, else the first the player can
    /// spare (not the system being played, and no active mission bound there). None if every slot is needed.
    pub fn atlas_slot_for(&self, id: u32) -> Option<usize> {
        if let Some(k) = self.atlas_find(id) { return Some(k); }
        let n = self.atlas_count();
        if n < MAX_SYSTEMS { return Some(n); }
        let m = &self.missions;
        (0..n).find(|&k| k != self.game.system[0] as usize && !(0..MAX_MISSIONS).any(|q| m.state[q] == M_ACTIVE && m.sys[q] as usize == k))
    }

    /// Store the live system as system `id` in slot `k` of the atlas: a slot already in use (its system is replaced),
    /// or the next empty one (k the current count, so slots fill in order).
    pub fn atlas_store(&mut self, k: usize, id: u32) -> bool {
        if k >= MAX_SYSTEMS || k > self.atlas_count() { return false; }
        let (nb, mb) = (self.n_bodies, self.cfg.max_bodies);
        let (b, a) = (&self.bodies, &mut self.atlas_bodies);
        for j in 0..mb {
            let o = k * mb + j;
            let j = if j < nb { j } else { usize::MAX }; // past the system's bodies: zeros
            let f = |c: &[f64]| if j == usize::MAX { 0.0 } else { c[j] };
            (a.x[o], a.y[o], a.r[o], a.g[o], a.pop[o], a.env_rate[o], a.env_jump[o]) = (f(&b.x), f(&b.y), f(&b.r), f(&b.g), f(&b.pop), f(&b.env_rate), f(&b.env_jump));
            (a.reach[o], a.hazard[o], a.rad[o], a.orb_r[o], a.orb_a[o], a.orb_w[o]) = (f(&b.reach), f(&b.hazard), f(&b.rad), f(&b.orb_r), f(&b.orb_a), f(&b.orb_w));
            if j == usize::MAX {
                (a.kind[o], a.port[o], a.env[o], a.svc[o], a.fuel_price[o], a.orb_p[o]) = (0, 0, 0, 0, 0, -1);
            } else {
                (a.kind[o], a.port[o], a.env[o], a.svc[o], a.fuel_price[o], a.orb_p[o]) = (b.kind[j], b.port[j], b.env[j], b.svc[j], b.fuel_price[j], b.orb_p[j]);
            }
        }
        let n = mb * MAX_GOODS;
        self.atlas_market.price[k * n..(k + 1) * n].copy_from_slice(&self.market.price[..n]);
        for m in 0..MAX_MIX {
            let o = k * MAX_MIX + m;
            let (x, mx) = (&mut self.atlas_mix, &self.mix);
            (x.stream[o], x.body[o], x.kind[o], x.weight[o]) = (mx.stream[m], mx.body[m], mx.kind[m], mx.weight[m]);
        }
        let (jr, ts, st) = (self.p(P::jump_radius), self.p(P::traffic_ships), self.p(P::share_through));
        let s = &mut self.atlas_sys;
        (s.id[k], s.bodies[k]) = (id, nb as u16);
        (s.jump_radius[k], s.traffic_ships[k], s.share_through[k]) = (jr, ts, st);
        if k == self.atlas_count() { self.atlas_head.n[0] = (k + 1) as u8; }
        true
    }

    /// Make system `k` of the atlas the live one: its bodies, prices, traffic mix and traffic params. Boards, traffic
    /// and the player are left alone (see `jump_to`, and the page's new game).
    pub fn atlas_load(&mut self, k: usize) -> bool {
        if k >= self.atlas_count() { return false; }
        let mb = self.cfg.max_bodies;
        let nb = self.atlas_sys.bodies[k] as usize;
        let (b, a) = (&mut self.bodies, &self.atlas_bodies);
        for j in 0..mb {
            let o = k * mb + j;
            (b.x[j], b.y[j], b.r[j], b.g[j], b.pop[j]) = (a.x[o], a.y[o], a.r[o], a.g[o], a.pop[o]);
            (b.kind[j], b.port[j], b.env[j], b.env_rate[j], b.env_jump[j]) = (a.kind[o], a.port[o], a.env[o], a.env_rate[o], a.env_jump[o]);
            (b.reach[j], b.hazard[j], b.rad[j], b.svc[j], b.fuel_price[j]) = (a.reach[o], a.hazard[o], a.rad[o], a.svc[o], a.fuel_price[o]);
            (b.orb_p[j], b.orb_r[j], b.orb_a[j], b.orb_w[j]) = (a.orb_p[o], a.orb_r[o], a.orb_a[o], a.orb_w[o]);
            (b.vx[j], b.vy[j]) = (0.0, 0.0); // still, unless its orbit moves it (below): none of the last system's motion stays
            b.env_next[j] = 0.0;
        }
        self.n_bodies = nb;
        // moving bodies to where they are now, at rest in the render history (a jump or a new game snaps the view)
        self.orbit_bodies(self.tick as f64 * DT);
        let b = &mut self.bodies;
        for j in 0..mb { (b.prev_x[j], b.prev_y[j], b.rx[j], b.ry[j]) = (b.x[j], b.y[j], b.x[j], b.y[j]); }
        let n = mb * MAX_GOODS;
        self.market.price[..n].copy_from_slice(&self.atlas_market.price[k * n..(k + 1) * n]);
        for m in 0..MAX_MIX {
            let o = k * MAX_MIX + m;
            let (x, mx) = (&self.atlas_mix, &mut self.mix);
            (mx.stream[m], mx.body[m], mx.kind[m], mx.weight[m]) = (x.stream[o], x.body[o], x.kind[o], x.weight[o]);
            (mx.rate[m], mx.dwell[m], mx.next[m]) = (0.0, 0.0, 0.0);
        }
        let s = &self.atlas_sys;
        let (jr, ts, st) = (s.jump_radius[k], s.traffic_ships[k], s.share_through[k]);
        self.params[P::jump_radius as usize] = jr;
        self.params[P::traffic_ships as usize] = ts;
        self.params[P::share_through as usize] = st;
        self.game.system[0] = k as u8;
        true
    }

    /// Bytes in one slot's row: its part of every atlas column, in the columns' order.
    pub fn atlas_row_len(&self) -> usize { self.atlas_row_cols().map(|c| c.len / MAX_SYSTEMS * c.size).sum() }

    /// The per-slot atlas columns (every one holds MAX_SYSTEMS slots' worth, a slot's part contiguous), from the cached
    /// column list: nothing here allocates, so WASM memory never grows under the page's views.
    fn atlas_row_cols(&self) -> impl Iterator<Item = &ColumnDesc> {
        self.cols.iter().filter(|c| matches!(c.group, "atlas_sys" | "atlas_body" | "atlas_market" | "atlas_mix"))
    }

    /// Slot `k`'s row as bytes, into `out` (atlas_row_len long): what the page logs for a replay when it stores a
    /// system mid-session.
    pub fn atlas_row_get(&self, k: usize, out: &mut [u8]) -> bool {
        if k >= self.atlas_count() || out.len() != self.atlas_row_len() { return false; }
        let mut at = 0;
        for c in self.atlas_row_cols() {
            let n = c.len / MAX_SYSTEMS * c.size;
            // SAFETY: the descriptor covers a live column of this world, never resized after creation
            let col = unsafe { std::slice::from_raw_parts(c.ptr as *const u8, c.len * c.size) };
            out[at..at + n].copy_from_slice(&col[k * n..(k + 1) * n]);
            at += n;
        }
        true
    }

    /// Put a row (from `atlas_row_get`) into slot `k`, as `atlas_store` would have: a replay's logged store.
    pub fn atlas_row_put(&mut self, k: usize, row: &[u8]) -> bool {
        if k >= MAX_SYSTEMS || k > self.atlas_count() || row.len() != self.atlas_row_len() { return false; }
        let mut at = 0;
        for c in self.atlas_row_cols() {
            let n = c.len / MAX_SYSTEMS * c.size;
            // SAFETY: as above; the destination is this world's own column, disjoint from `row`
            let col = unsafe { std::slice::from_raw_parts_mut(c.ptr as *mut u8, c.len * c.size) };
            col[k * n..(k + 1) * n].copy_from_slice(&row[at..at + n]);
            at += n;
        }
        if k == self.atlas_count() { self.atlas_head.n[0] = (k + 1) as u8; }
        true
    }

    /// Slot `k`'s row into the world's row buffer (`atlas_row`), for the page to read and log.
    pub fn atlas_row_save(&mut self, k: usize) -> bool {
        let mut row = std::mem::take(&mut self.atlas_row); // no allocation: the buffer moves out and back
        let ok = self.atlas_row_get(k, &mut row);
        self.atlas_row = row;
        ok
    }

    /// The row buffer (as the page filled it from a log) into slot `k`.
    pub fn atlas_row_load(&mut self, k: usize) -> bool {
        let row = std::mem::take(&mut self.atlas_row);
        let ok = self.atlas_row_put(k, &row);
        self.atlas_row = row;
        ok
    }

    /// Where a jump or teleport to body `b` puts the player: over it, a little south of its centre; for a belt, on its
    /// ring, due south of its parent (a belt's centre is its parent's).
    pub fn arrival(&self, b: usize) -> (f64, f64) {
        let (x, y, r) = (self.bodies.x[b], self.bodies.y[b], self.bodies.r[b]);
        if self.bodies.kind[b] == BODY_BELT { (x, y - r) } else { (x, y - r * 0.3) }
    }

    /// The debug jump: to system `k`, at rest over its body `b`, flying. Not during a landing or launch.
    pub fn jump_to(&mut self, k: i32, b: i32) -> i32 {
        let mode = self.mode();
        if mode == MODE_DESCENDING || mode == MODE_LAUNCHING || mode == MODE_DEAD { return WRONG_MODE; }
        let Some(k) = usize::try_from(k).ok().filter(|&k| k < self.atlas_count()) else { return NO_SUCH_BODY };
        let Some(b) = usize::try_from(b).ok().filter(|&b| b < self.atlas_sys.bodies[k] as usize) else { return NO_SUCH_BODY };
        let Ok(i) = usize::try_from(self.game.player[0]) else { return NO_SUCH_BODY };
        // the system left behind: its traffic, lanes and boards go
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
        // the player, flying, at rest over the body (as CMD_TELEPORT puts them)
        let at = self.arrival(b);
        let (bvx, bvy) = (self.bodies.vx[b], self.bodies.vy[b]);
        let s = &mut self.ships;
        s.alive[i] = 1;
        (s.x[i], s.y[i]) = at;
        s.vx[i] = bvx; s.vy[i] = bvy; s.av[i] = 0.0; // at rest over it, moving with it if it moves
        self.slot_reset(i, false);
        self.game.mode[0] = MODE_FLYING;
        self.game.at[0] = b as i16;
        (self.game.timer[0], self.game.auto[0], self.game.set[0]) = (0.0, 0, 0.0);
        OK
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::{BODY_PLANET, BODY_STAR, CMD_JUMP, CMD_LAND, MODE_FLYING};
    use crate::mission::{CMD_ACCEPT, MAX_OFFERS, M_DELIVERED};
    use crate::replay::{run, LogEntry};
    use crate::world::Config;

    /// Lay system `k` of the two out in the live columns, as the page does: a star and two port planets, at places
    /// and prices that differ by system.
    fn lay_out(w: &mut World, k: usize) {
        w.n_bodies = 3;
        for (j, (x, r, kind, port)) in [(0.0, 2000.0, BODY_STAR, 0), (10_000.0 + 5000.0 * k as f64, 800.0, BODY_PLANET, 1), (-14_000.0, 600.0, BODY_PLANET, 1)].into_iter().enumerate() {
            (w.bodies.x[j], w.bodies.y[j], w.bodies.r[j], w.bodies.kind[j], w.bodies.port[j], w.bodies.pop[j]) = (x, 0.0, r, kind, port, port as f64 * 5.0);
        }
        w.market.price.fill(0);
        w.market.price[MAX_GOODS] = 30 + k as u32 * 10;
    }

    /// Two systems (star ids 100 and 101), both in the atlas, the player landed in the first.
    fn two_systems() -> Box<World> {
        let mut w = World::new(Config { max_ships: 32, max_types: 1, max_bodies: 4, env_n: 4, env_w: 1000.0 }, 5);
        (w.types.accel[0], w.types.turn[0], w.types.vmax[0], w.types.cargo[0]) = (60.0, 1.0, 200.0, 50);
        for k in 0..2 {
            lay_out(&mut w, k);
            assert!(w.atlas_store(k, 100 + k as u32));
        }
        w.clear();
        w.atlas_load(0);
        w.count = 1;
        w.ships.alive[0] = 1;
        w.game.player[0] = 0;
        (w.game.credits[0], w.game.day[0]) = (1000, 1);
        w.place_landed(1);
        w.post_boards();
        w
    }

    #[test]
    fn a_jump_loads_the_other_system_and_missions_stay_with_theirs() {
        let mut w = two_systems();
        assert_eq!((w.atlas_count(), w.game.system[0], w.market.price[MAX_GOODS]), (2, 0, 30));
        assert_eq!((w.atlas_find(101), w.atlas_find(102)), (Some(1), None));
        let offer = (0..MAX_OFFERS).find(|&k| w.offers.live[MAX_OFFERS + k] != 0).expect("an offer") as i32;
        assert_eq!(w.command(CMD_ACCEPT, offer, 0), OK);
        let dest = w.missions.dest[0] as usize;
        // to system 1, over the destination's index there: a different place, prices and system
        assert_eq!(w.command(CMD_JUMP, 1, dest as i32), OK);
        assert_eq!((w.game.system[0], w.mode(), w.market.price[MAX_GOODS]), (1, MODE_FLYING, 40));
        assert!((w.ships.x[0] - w.bodies.x[dest]).abs() < 1.0);
        for _ in 0..60 { w.step(); }
        // landing there doesn't deliver: the mission is for system 0
        assert_eq!(w.command(CMD_LAND, 0, 0), OK);
        for _ in 0..600 { w.step(); }
        assert_eq!(w.missions.state[0], M_ACTIVE);
        // back to system 0 and land at the destination: delivered
        assert_eq!(w.command(CMD_JUMP, 0, dest as i32), OK);
        for _ in 0..60 { w.step(); }
        assert_eq!(w.command(CMD_LAND, 0, 0), OK);
        for _ in 0..600 { w.step(); }
        assert_eq!(w.missions.state[0], M_DELIVERED);
        assert_eq!(w.command(CMD_JUMP, 2, 0), NO_SUCH_BODY);
        // a belt's arrival is on its ring
        w.bodies.kind[2] = BODY_BELT;
        assert_eq!(w.arrival(2), (w.bodies.x[2], w.bodies.y[2] - w.bodies.r[2]));
        assert_eq!(w.command(CMD_JUMP, 1, 3), NO_SUCH_BODY);
    }

    #[test]
    fn a_systems_moving_body_leaves_no_motion_behind() {
        let mut w = two_systems();
        // system 1's body 1 orbits; system 0's body 1 holds still
        w.atlas_load(1);
        w.place_body(1, 0, 15_000.0, 0.0);
        w.body_motion(1, 600.0);
        assert!(w.atlas_store(1, 101));
        w.atlas_load(1);
        for _ in 0..10 { w.step(); }
        assert!(w.bodies.vx[1].hypot(w.bodies.vy[1]) > 100.0);
        w.atlas_load(0);
        assert_eq!((w.bodies.vx[1], w.bodies.vy[1]), (0.0, 0.0));
    }

    #[test]
    fn a_replay_follows_a_jump() {
        let mut live = two_systems();
        live.save();
        let start = live.snapshot().to_vec();
        let log = [LogEntry::Command { tick: 0, code: crate::port::CMD_LAUNCH, a: 0, b: 0 }, LogEntry::Command { tick: 400, code: CMD_JUMP, a: 1, b: 2 },
            LogEntry::Input { tick: 410, input: crate::player::IN_ASSIST | crate::player::IN_THRUST }];
        run(&mut live, &log, 900);
        assert_eq!(live.game.system[0], 1);
        let mut again = World::from_snapshot(&start).unwrap();
        run(&mut again, &log, 900);
        assert_eq!(live.hash(), again.hash());
    }

    #[test]
    fn a_full_atlas_reuses_a_slot_the_player_can_spare() {
        let mut w = two_systems();
        for k in 2..MAX_SYSTEMS { lay_out(&mut w, k); assert!(w.atlas_store(k, 100 + k as u32)); }
        w.atlas_load(0);
        assert_eq!((w.atlas_count(), w.atlas_slot_for(100), w.atlas_slot_for(999)), (MAX_SYSTEMS, Some(0), Some(1)));
        // a mission bound for slot 1 keeps it; the live system's slot is never given up
        let offer = (0..MAX_OFFERS).find(|&k| w.offers.live[MAX_OFFERS + k] != 0).expect("an offer") as i32;
        assert_eq!(w.command(CMD_ACCEPT, offer, 0), OK);
        w.missions.sys[0] = 1;
        assert_eq!(w.atlas_slot_for(999), Some(2));
        assert!(!w.atlas_store(MAX_SYSTEMS, 999), "no slot past the last");
        lay_out(&mut w, 1);
        assert!(w.atlas_store(2, 999));
        assert_eq!((w.atlas_find(102), w.atlas_find(999), w.atlas_count()), (None, Some(2), MAX_SYSTEMS));
        w.atlas_reset();
        assert_eq!((w.atlas_count(), w.atlas_find(100), w.atlas_slot_for(100)), (0, None, Some(0)));
    }

    #[test]
    fn a_system_stored_mid_session_reaches_the_replay() {
        // only the first system is in the atlas when the session starts; the second is laid out and stored on the way
        // to the jump, its row logged as the page logs it
        let mut live = two_systems();
        live.atlas_reset();
        lay_out(&mut live, 0);
        assert!(live.atlas_store(0, 100));
        live.atlas_load(0);
        live.save();
        let start = live.snapshot().to_vec();
        let mut log = vec![LogEntry::Command { tick: 0, code: crate::port::CMD_LAUNCH, a: 0, b: 0 }];
        run(&mut live, &log, 400);
        lay_out(&mut live, 1);
        let k = live.atlas_slot_for(101).unwrap();
        assert!(live.atlas_store(k, 101) && live.atlas_row_save(k));
        log.push(LogEntry::Atlas { tick: live.tick, k: k as u32, row: live.atlas_row.clone() });
        assert_eq!(live.command(CMD_JUMP, k as i32, 2), OK);
        log.push(LogEntry::Command { tick: live.tick, code: CMD_JUMP, a: k as i32, b: 2 });
        log.push(LogEntry::Input { tick: live.tick + 10, input: crate::player::IN_ASSIST | crate::player::IN_THRUST });
        run(&mut live, &log[3..], 500);
        assert_eq!((live.game.system[0], live.market.price[MAX_GOODS]), (1, 40));
        let mut again = World::from_snapshot(&start).unwrap();
        assert_eq!(again.atlas_count(), 1);
        run(&mut again, &log, 900);
        assert_eq!((again.atlas_count(), again.atlas_find(101)), (2, Some(1)));
        assert_eq!(live.hash(), again.hash());
    }
}
