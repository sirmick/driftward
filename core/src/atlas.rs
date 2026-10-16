//! The atlas: every system's layout, held in the core so a jump between systems is the core's own business and a
//! replay across one reruns natively. The page lays each system out once at startup, exactly as it lays out the
//! system being played (bodies placed with the core's trig, populations, environmental stations, market prices, the
//! traffic mix and the system's traffic params), and stores that into the atlas (`atlas_store`); `atlas_load` puts
//! one back as the live system. It is content: written at startup, saved with the world, never changed by play.
//!
//! The debug jump (port.rs CMD_JUMP) loads a system and puts the player at rest over one of its bodies: the system
//! left behind loses its traffic and boards, the new one gets fresh ones, and the player keeps everything else
//! (credits, hold, missions; a mission is delivered only in the system it was taken for).

use crate::cols::soa;
use crate::market::MAX_GOODS;
use crate::port::{MODE_DESCENDING, MODE_FLYING, MODE_LAUNCHING, NO_SUCH_BODY, OK, WRONG_MODE};
use crate::traffic::MAX_MIX;
use crate::world::{World, P};

/// Systems the atlas holds.
pub const MAX_SYSTEMS: usize = 8;

soa! {
    /// The atlas's one row: how many systems it holds.
    pub struct AtlasHead { n: u8 }
}

soa! {
    /// Per system: its body count, and its traffic params (jump_radius, traffic_ships, share_through).
    pub struct AtlasSys { bodies: u16, jump_radius: f64, traffic_ships: f64, share_through: f64 }
}

soa! {
    /// Per system and body (system * max_bodies + body): the live body columns that are content (world.rs Bodies).
    pub struct AtlasBodies { x: f64, y: f64, r: f64, g: f64, pop: f64, kind: u8, port: u8, env: u8, env_rate: f64, env_jump: f64 }
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

    /// Store the live system as system `k` of the atlas (k at most the current count, so systems go in order).
    pub fn atlas_store(&mut self, k: usize) -> bool {
        if k >= MAX_SYSTEMS || k > self.atlas_count() { return false; }
        let (nb, mb) = (self.n_bodies, self.cfg.max_bodies);
        let (b, a) = (&self.bodies, &mut self.atlas_bodies);
        for j in 0..mb {
            let o = k * mb + j;
            if j < nb {
                (a.x[o], a.y[o], a.r[o], a.g[o], a.pop[o]) = (b.x[j], b.y[j], b.r[j], b.g[j], b.pop[j]);
                (a.kind[o], a.port[o], a.env[o], a.env_rate[o], a.env_jump[o]) = (b.kind[j], b.port[j], b.env[j], b.env_rate[j], b.env_jump[j]);
            } else {
                (a.x[o], a.y[o], a.r[o], a.g[o], a.pop[o], a.kind[o], a.port[o], a.env[o], a.env_rate[o], a.env_jump[o]) = (0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 0, 0.0, 0.0);
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
        s.bodies[k] = nb as u16;
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
            b.env_next[j] = 0.0;
        }
        self.n_bodies = nb;
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

    /// The debug jump: to system `k`, at rest over its body `b`, flying. Not during a landing or launch.
    pub fn jump_to(&mut self, k: i32, b: i32) -> i32 {
        let mode = self.mode();
        if mode == MODE_DESCENDING || mode == MODE_LAUNCHING { return WRONG_MODE; }
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
        let s = &mut self.ships;
        s.alive[i] = 1;
        s.x[i] = self.bodies.x[b];
        s.y[i] = self.bodies.y[b] - self.bodies.r[b] * 0.3;
        s.vx[i] = 0.0; s.vy[i] = 0.0; s.av[i] = 0.0;
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
    use crate::mission::{CMD_ACCEPT, MAX_OFFERS, M_ACTIVE, M_DELIVERED};
    use crate::replay::{run, LogEntry};
    use crate::world::Config;

    /// Two systems: a star and two port planets each, at different places, with different prices.
    fn two_systems() -> Box<World> {
        let mut w = World::new(Config { max_ships: 32, max_types: 1, max_bodies: 4, env_n: 4, env_w: 1000.0 }, 5);
        (w.types.accel[0], w.types.turn[0], w.types.vmax[0], w.types.cargo[0]) = (60.0, 1.0, 200.0, 50);
        for k in 0..2 {
            w.n_bodies = 3;
            for (j, (x, r, kind, port)) in [(0.0, 2000.0, BODY_STAR, 0), (10_000.0 + 5000.0 * k as f64, 800.0, BODY_PLANET, 1), (-14_000.0, 600.0, BODY_PLANET, 1)].into_iter().enumerate() {
                (w.bodies.x[j], w.bodies.y[j], w.bodies.r[j], w.bodies.kind[j], w.bodies.port[j], w.bodies.pop[j]) = (x, 0.0, r, kind, port, port as f64 * 5.0);
            }
            w.market.price.fill(0);
            w.market.price[MAX_GOODS] = 30 + k as u32 * 10;
            assert!(w.atlas_store(k));
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
        assert_eq!(w.command(CMD_JUMP, 1, 3), NO_SUCH_BODY);
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
}
