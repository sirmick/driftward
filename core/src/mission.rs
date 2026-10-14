//! The mission board and delivery missions (M1): the Book's one mission type, haulage to a named port in the
//! system. Each port's board holds up to MAX_OFFERS offers; each day expired offers drop and new ones are posted
//! from the world's generator, so boards replay like everything else. The player accepts an offer (a command),
//! carries its cargo in the hold, and is paid on landing at the destination. Missing the deadline fails the
//! mission softly: the cargo is reclaimed by its owner and nothing is paid.
//!
//! Offers bind live state: the origin port's market picks the cargo, the route picks the deadline (route length in
//! days times a slack) and the pay (a base plus tons times kilometres, times an urgency that rises as slack falls).
//! The Book's risk and faction-wealth factors are 1 in M1.

use crate::market::{MAX_GOODS, NO_ROOM};
use crate::math::hypot;
use crate::port::{MODE_LANDED, OK, WRONG_MODE};
use crate::world::{World, P};

/// Offers a board holds at most, and keeps at least (the Book: 3 to 8 per board).
pub const MAX_OFFERS: usize = 8;
pub const MIN_OFFERS: usize = 3;
/// Missions the player can carry at once.
pub const MAX_MISSIONS: usize = 4;

/// Mission slot states. Delivered and failed slots are free for reuse; the page watches for them to report.
pub const M_EMPTY: u8 = 0;
pub const M_ACTIVE: u8 = 1;
pub const M_DELIVERED: u8 = 2;
pub const M_FAILED: u8 = 3;

/// Accept offer `a` from the board of the port the player is landed at.
pub const CMD_ACCEPT: u32 = 8;
/// Abandon mission slot `a` (its cargo goes back to its owner; nothing is paid).
pub const CMD_ABANDON: u32 = 9;

pub const NO_OFFER: i32 = 10;
pub const TOO_MANY_MISSIONS: i32 = 11;

impl World {
    /// Tons the player carries for missions (they take hold space but are not for sale).
    pub fn mission_tons(&self) -> u32 {
        (0..MAX_MISSIONS).filter(|&k| self.missions.state[k] == M_ACTIVE).map(|k| self.missions.tons[k]).sum()
    }

    /// Fill every port's board for a new game (later days top them up in `missions_day`).
    pub fn post_boards(&mut self) {
        for j in 0..self.n_bodies {
            for k in 0..MAX_OFFERS { self.offers.live[j * MAX_OFFERS + k] = 0; }
            if self.bodies.port[j] != 0 { self.top_up(j, true); }
        }
    }

    /// Post offers on body `j`'s board: up to MIN_OFFERS for sure, then each free slot by chance (or every free
    /// slot with `full`, for a new game).
    fn top_up(&mut self, j: usize, full: bool) {
        let mut n = (0..MAX_OFFERS).filter(|&k| self.offers.live[j * MAX_OFFERS + k] != 0).count();
        for k in 0..MAX_OFFERS {
            let o = j * MAX_OFFERS + k;
            if self.offers.live[o] != 0 { continue; }
            if n >= MIN_OFFERS && !full && self.rng.next_f64() >= self.p(P::offer_chance) { continue; }
            if !self.make_offer(j, o) { return; }
            n += 1;
        }
    }

    /// A haulage offer from port `j` into slot `o`; false if there is nowhere to deliver to.
    fn make_offer(&mut self, j: usize, o: usize) -> bool {
        let dests: u32 = (0..self.n_bodies).filter(|&k| k != j && self.bodies.port[k] != 0).count() as u32;
        if dests == 0 { return false; }
        let pick = self.rng.below(dests) as usize;
        let dest = (0..self.n_bodies).filter(|&k| k != j && self.bodies.port[k] != 0).nth(pick).unwrap_or(j);
        // the cargo: something the origin's market trades (any commodity if it has none)
        let traded: u32 = (0..MAX_GOODS).filter(|&g| self.price(j, g) > 0).count() as u32;
        let good = if traded > 0 {
            let pick = self.rng.below(traded) as usize;
            (0..MAX_GOODS).filter(|&g| self.price(j, g) > 0).nth(pick).unwrap_or(0)
        } else { 0 };
        let tons = 1 + self.rng.below(12);
        let km = hypot(self.bodies.x[dest] - self.bodies.x[j], self.bodies.y[dest] - self.bodies.y[j]) / 1000.0;
        let (lo, hi) = (self.p(P::slack_min), self.p(P::slack_max));
        let slack = self.rng.range(lo, hi);
        let days = 1 + (km * 1000.0 / self.p(P::route_day) * slack).floor() as u32;
        let urgency = 1.0 + 0.5 * (hi - slack) / (hi - lo).max(1e-9);
        let pay = ((self.p(P::mission_base) + tons as f64 * km * self.p(P::mission_rate)) * urgency / 10.0).round() * 10.0;
        let f = &mut self.offers;
        f.live[o] = 1;
        f.dest[o] = dest as i16;
        f.good[o] = good as u8;
        f.tons[o] = tons;
        f.pay[o] = pay as u32;
        f.days[o] = days;
        f.expires[o] = self.game.day[0] + 2 + self.rng.below(4);
        true
    }

    /// The day turned (from `next_day`): overdue missions fail, stale offers drop, boards are topped up.
    pub(crate) fn missions_day(&mut self) {
        let day = self.day();
        for k in 0..MAX_MISSIONS {
            if self.missions.state[k] == M_ACTIVE && day > self.missions.due[k] { self.missions.state[k] = M_FAILED; }
        }
        for o in 0..self.n_bodies * MAX_OFFERS {
            if self.offers.live[o] != 0 && day > self.offers.expires[o] { self.offers.live[o] = 0; }
        }
        for j in 0..self.n_bodies {
            if self.bodies.port[j] != 0 { self.top_up(j, false); }
        }
    }

    /// The player landed at `at`: deliver every active mission bound there.
    pub(crate) fn deliver(&mut self, at: usize) {
        for k in 0..MAX_MISSIONS {
            if self.missions.state[k] == M_ACTIVE && self.missions.dest[k] as usize == at {
                self.missions.state[k] = M_DELIVERED;
                self.game.credits[0] = self.credits().saturating_add(self.missions.pay[k]);
            }
        }
    }

    /// CMD_ACCEPT and CMD_ABANDON.
    pub(crate) fn mission_command(&mut self, code: u32, a: i32) -> i32 {
        if code == CMD_ABANDON {
            let Some(k) = usize::try_from(a).ok().filter(|&k| k < MAX_MISSIONS && self.missions.state[k] == M_ACTIVE) else { return NO_OFFER };
            self.missions.state[k] = M_EMPTY;
            return OK;
        }
        if self.mode() != MODE_LANDED { return WRONG_MODE; }
        let at = self.game.at[0] as usize;
        let Some(o) = usize::try_from(a).ok().filter(|&k| k < MAX_OFFERS).map(|k| at * MAX_OFFERS + k).filter(|&o| self.offers.live[o] != 0)
        else { return NO_OFFER };
        let Some(k) = (0..MAX_MISSIONS).find(|&k| self.missions.state[k] != M_ACTIVE) else { return TOO_MANY_MISSIONS };
        if self.hold_used() + self.offers.tons[o] > self.hold_cap() { return NO_ROOM; }
        let (f, m) = (&mut self.offers, &mut self.missions);
        f.live[o] = 0;
        m.state[k] = M_ACTIVE;
        m.from[k] = at as i16;
        m.dest[k] = f.dest[o];
        m.good[k] = f.good[o];
        m.tons[k] = f.tons[o];
        m.pay[k] = f.pay[o];
        m.due[k] = self.game.day[0] + f.days[o];
        OK
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::CMD_BUY;
    use crate::port::{BODY_PLANET, CMD_LAND, CMD_LAUNCH, CMD_SKIP, CMD_WAIT, MODE_FLYING};
    use crate::world::{Config, DT};

    /// Three ports 30 km apart in a line (bodies 0, 1, 2), each trading commodity 0; the player landed at body 0
    /// on day 1 in a ship with a 20-ton hold, with plenty of credits; boards posted.
    fn world(seed: u64) -> Box<World> {
        let mut w = World::new(Config { max_ships: 1, max_types: 1, max_bodies: 3, env_n: 4, env_w: 1000.0 }, seed);
        w.types.cargo[0] = 20;
        w.n_bodies = 3;
        for j in 0..3 {
            w.bodies.x[j] = j as f64 * 30_000.0; w.bodies.r[j] = 500.0; w.bodies.kind[j] = BODY_PLANET; w.bodies.port[j] = 1;
            w.market.price[j * MAX_GOODS] = 20;
        }
        w.count = 1;
        w.player.slot = 0;
        w.place_landed(0);
        w.game.day[0] = 1;
        w.game.credits[0] = 10_000;
        w.post_boards();
        w
    }
    fn board(w: &World, j: usize) -> Vec<usize> { (0..MAX_OFFERS).filter(|&k| w.offers.live[j * MAX_OFFERS + k] != 0).collect() }
    /// Launch, hop over body `j`, and land there (the descent takes its day).
    fn fly_to(w: &mut World, j: usize) {
        assert_eq!(w.command(CMD_LAUNCH, 0, 0), OK);
        w.command(CMD_SKIP, 0, 0);
        w.step();
        assert_eq!(w.mode(), MODE_FLYING);
        w.ships.x[0] = w.bodies.x[j];
        w.ships.y[0] = 0.0;
        w.ships.vx[0] = 0.0; w.ships.vy[0] = 0.0;
        assert_eq!(w.command(CMD_LAND, 0, 0), OK);
        for _ in 0..(3.0 / DT) as usize { w.step(); }
        assert_eq!((w.mode(), w.game.at[0] as usize), (MODE_LANDED, j));
    }

    #[test]
    fn boards_are_full_and_bound_to_the_system() {
        let w = world(3);
        for j in 0..3 {
            assert_eq!(board(&w, j).len(), MAX_OFFERS);
            for k in board(&w, j) {
                let o = j * MAX_OFFERS + k;
                let (d, f) = (w.offers.dest[o] as usize, &w.offers);
                assert!(d != j && d < 3, "offer to {d} from {j}");
                assert!((1..=12).contains(&f.tons[o]) && f.good[o] == 0 && f.pay[o] > 0 && f.days[o] >= 1 && f.expires[o] > 1);
                // farther is longer and better paid, per ton
                if d == 2 && j == 0 { assert!(f.days[o] >= 2); }
            }
        }
        assert_eq!(w.hash(), world(3).hash());
        assert_ne!(w.hash(), world(4).hash());
    }

    #[test]
    fn accept_carry_deliver() {
        let mut w = world(5);
        let k = board(&w, 0)[0];
        let o = k; // body 0
        let (dest, tons, pay, days) = (w.offers.dest[o] as usize, w.offers.tons[o], w.offers.pay[o], w.offers.days[o]);
        assert_eq!(w.command(CMD_ACCEPT, k as i32, 0), OK);
        assert_eq!(w.offers.live[o], 0);
        assert_eq!(w.command(CMD_ACCEPT, k as i32, 0), NO_OFFER);
        assert_eq!((w.missions.state[0], w.missions.due[0], w.mission_tons(), w.hold_used()), (M_ACTIVE, 1 + days, tons, tons));
        // mission cargo takes hold space
        assert_eq!(w.command(CMD_BUY, 0, (20 - tons + 1) as i32), NO_ROOM);
        let credits = w.credits();
        fly_to(&mut w, dest);
        assert_eq!((w.missions.state[0], w.credits(), w.hold_used()), (M_DELIVERED, credits + pay, 0));
    }

    #[test]
    fn deadlines_fail_softly() {
        let mut w = world(6);
        let k = board(&w, 0)[0];
        let days = w.offers.days[k];
        assert_eq!(w.command(CMD_ACCEPT, k as i32, 0), OK);
        for _ in 0..days { assert_eq!(w.command(CMD_WAIT, 0, 0), OK); }
        assert_eq!(w.missions.state[0], M_ACTIVE); // the due day itself is still in time
        assert_eq!(w.command(CMD_WAIT, 0, 0), OK);
        assert_eq!((w.missions.state[0], w.mission_tons()), (M_FAILED, 0));
    }

    #[test]
    fn limits_and_abandoning() {
        let mut w = world(7);
        w.types.cargo[0] = 100;
        for (n, k) in board(&w, 0).into_iter().enumerate() {
            let r = w.command(CMD_ACCEPT, k as i32, 0);
            assert_eq!(r, if n < MAX_MISSIONS { OK } else { TOO_MANY_MISSIONS });
        }
        assert_eq!(w.command(CMD_ABANDON, 1, 0), OK);
        assert_eq!(w.missions.state[1], M_EMPTY);
        assert_eq!(w.command(CMD_ABANDON, 1, 0), NO_OFFER);
        let left = board(&w, 0)[0];
        w.types.cargo[0] = w.hold_used(); // a full hold
        assert_eq!(w.command(CMD_ACCEPT, left as i32, 0), NO_ROOM);
        assert_eq!(w.command(CMD_ACCEPT, MAX_OFFERS as i32, 0), NO_OFFER);
        assert_eq!(w.command(CMD_LAUNCH, 0, 0), OK);
        assert_eq!(w.command(CMD_ACCEPT, left as i32, 0), WRONG_MODE);
    }

    #[test]
    fn boards_turn_over() {
        let mut w = world(8);
        let first: Vec<u32> = (0..MAX_OFFERS).map(|k| w.offers.pay[k]).collect();
        for _ in 0..8 {
            assert_eq!(w.command(CMD_WAIT, 0, 0), OK);
            let n = board(&w, 0).len();
            assert!((MIN_OFFERS..=MAX_OFFERS).contains(&n), "{n}");
        }
        let now: Vec<u32> = (0..MAX_OFFERS).map(|k| w.offers.pay[k]).collect();
        assert_ne!(first, now); // every first-day offer has expired (the longest lasts 5 days)
    }
}
