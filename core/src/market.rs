//! Cargo, credits and markets (M1): the player's hold and money, each port's market at fixed prices, and the
//! lender the player starts in debt to. Prices are content (src/economy.json: a base price per commodity, scaled
//! by the port's role); the page writes them into the market columns at a new game, and they save with the world,
//! so a save keeps the prices it was played with (and M5's moving prices slot into the same columns).
//!
//! Buying, selling and repaying are game commands like landing (port.rs), so a session's trades replay exactly.
//! Each day costs the player: waiting in port pays a docking fee, and the debt gathers interest.

use crate::port::{MODE_LANDED, OK, WRONG_MODE};
use crate::world::{World, P};

/// Rows per market and in the hold: the most commodities content may define.
pub const MAX_GOODS: usize = 16;

/// Buy `b` tons of commodity `a` at the port the player is landed at.
pub const CMD_BUY: u32 = 5;
/// Sell `b` tons of commodity `a` there.
pub const CMD_SELL: u32 = 6;
/// Pay `a` credits off the debt (capped at what is owed).
pub const CMD_REPAY: u32 = 7;

pub const NO_CREDITS: i32 = 5;
pub const NO_ROOM: i32 = 6;
pub const NOT_TRADED: i32 = 7;
pub const NO_CARGO: i32 = 8;
pub const BAD_AMOUNT: i32 = 9;

impl World {
    pub fn credits(&self) -> u32 { self.game.credits[0] }
    pub fn debt(&self) -> u32 { self.game.debt[0] }

    /// Price per ton of commodity `g` at `body`'s market; 0 if it does not trade it.
    pub fn price(&self, body: usize, g: usize) -> u32 { self.market.price[body * MAX_GOODS + g] }

    /// Tons in the player's hold, and what it holds at most.
    pub fn hold_used(&self) -> u32 { self.hold.tons.iter().sum() }
    pub fn hold_cap(&self) -> u32 {
        usize::try_from(self.player.slot).ok().filter(|&i| i < self.count).map_or(0, |i| self.types.cargo[self.ships.kind[i] as usize])
    }

    /// The trading commands (CMD_BUY, CMD_SELL, CMD_REPAY); landed only.
    pub(crate) fn trade(&mut self, code: u32, a: i32, b: i32) -> i32 {
        if self.mode() != MODE_LANDED { return WRONG_MODE; }
        let at = self.game.at[0] as usize;
        if code == CMD_REPAY {
            let owed = self.debt();
            if a <= 0 || owed == 0 { return BAD_AMOUNT; }
            let pay = (a as u32).min(owed);
            if self.credits() < pay { return NO_CREDITS; }
            self.game.credits[0] -= pay;
            self.game.debt[0] -= pay;
            return OK;
        }
        let Ok(g) = usize::try_from(a) else { return NOT_TRADED };
        if g >= MAX_GOODS || self.price(at, g) == 0 { return NOT_TRADED; }
        if b <= 0 { return BAD_AMOUNT; }
        let (tons, total) = (b as u32, self.price(at, g) as u64 * b as u64);
        if code == CMD_BUY {
            if self.hold_used() as u64 + tons as u64 > self.hold_cap() as u64 { return NO_ROOM; }
            if total > self.credits() as u64 { return NO_CREDITS; }
            self.game.credits[0] -= total as u32;
            self.hold.tons[g] += tons;
        } else {
            if self.hold.tons[g] < tons { return NO_CARGO; }
            self.hold.tons[g] -= tons;
            self.game.credits[0] = (self.credits() as u64 + total).min(u32::MAX as u64) as u32;
        }
        OK
    }

    /// The docking fee for a day in port, in credits.
    pub fn dock_fee(&self) -> u32 { self.p(P::dock_fee).max(0.0) as u32 }

    /// A day passes (landing, waiting): the debt gathers interest.
    pub(crate) fn next_day(&mut self) {
        self.game.day[0] += 1;
        let debt = self.debt() as f64;
        self.game.debt[0] = (debt + (debt * self.p(P::interest)).round()).min(u32::MAX as f64) as u32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::{BODY_PLANET, CMD_LAUNCH, CMD_WAIT, MODE_LAUNCHING};
    use crate::world::Config;

    const ORE: usize = 2;

    /// The player landed at a port (body 0) that trades ore at 50 a ton, in a ship with a 10-ton hold.
    fn landed(credits: u32) -> Box<World> {
        let mut w = World::new(Config { max_ships: 1, max_types: 1, max_bodies: 1, env_n: 4, env_w: 1000.0 }, 1);
        w.types.cargo[0] = 10;
        w.n_bodies = 1;
        w.bodies.r[0] = 500.0; w.bodies.kind[0] = BODY_PLANET; w.bodies.port[0] = 1;
        w.market.price[ORE] = 50;
        w.count = 1;
        w.player.slot = 0;
        w.place_landed(0);
        w.game.credits[0] = credits;
        w
    }

    #[test]
    fn buy_and_sell() {
        let mut w = landed(1000);
        let h = w.hash();
        assert_eq!(w.command(CMD_BUY, ORE as i32, 4), OK);
        assert_ne!(w.hash(), h); // the economy is part of the state
        assert_eq!((w.credits(), w.hold.tons[ORE], w.hold_used()), (800, 4, 4));
        assert_eq!(w.command(CMD_BUY, ORE as i32, 7), NO_ROOM);
        assert_eq!(w.command(CMD_SELL, ORE as i32, 5), NO_CARGO);
        assert_eq!(w.command(CMD_SELL, ORE as i32, 4), OK);
        assert_eq!((w.credits(), w.hold_used()), (1000, 0));
        assert_eq!(w.command(CMD_BUY, ORE as i32 + 1, 1), NOT_TRADED);
        assert_eq!(w.command(CMD_BUY, MAX_GOODS as i32, 1), NOT_TRADED);
        assert_eq!(w.command(CMD_BUY, -1, 1), NOT_TRADED);
        assert_eq!(w.command(CMD_BUY, ORE as i32, 0), BAD_AMOUNT);
        assert_eq!(w.command(CMD_BUY, ORE as i32, -3), BAD_AMOUNT);
        let mut poor = landed(120);
        assert_eq!(poor.command(CMD_BUY, ORE as i32, 3), NO_CREDITS);
        assert_eq!(poor.command(CMD_BUY, ORE as i32, 2), OK);
        assert_eq!(poor.credits(), 20);
    }

    #[test]
    fn trading_needs_a_port() {
        let mut w = landed(1000);
        assert_eq!(w.command(CMD_LAUNCH, 0, 0), OK);
        assert_eq!(w.mode(), MODE_LAUNCHING);
        assert_eq!(w.command(CMD_BUY, ORE as i32, 1), WRONG_MODE);
        assert_eq!(w.command(CMD_REPAY, 100, 0), WRONG_MODE);
    }

    #[test]
    fn days_cost_a_fee_and_interest() {
        let mut w = landed(1000);
        w.game.debt[0] = 10_000;
        let fee = w.dock_fee();
        assert!(fee > 0);
        assert_eq!(w.command(CMD_WAIT, 0, 0), OK);
        let interest = (10_000.0 * w.p(P::interest)).round() as u32;
        assert_eq!((w.credits(), w.debt(), w.day()), (1000 - fee, 10_000 + interest, 1));
        w.game.credits[0] = fee - 1;
        assert_eq!(w.command(CMD_WAIT, 0, 0), NO_CREDITS);
        assert_eq!(w.day(), 1);
    }

    #[test]
    fn repaying_the_lender() {
        let mut w = landed(1000);
        w.game.debt[0] = 1500;
        assert_eq!(w.command(CMD_REPAY, 2000, 0), NO_CREDITS); // capped at the debt, 1500, still more than we have
        assert_eq!(w.command(CMD_REPAY, 600, 0), OK);
        assert_eq!((w.credits(), w.debt()), (400, 900));
        w.game.credits[0] = 5000;
        assert_eq!(w.command(CMD_REPAY, 2000, 0), OK); // pays only what is owed
        assert_eq!((w.credits(), w.debt()), (4100, 0));
        assert_eq!(w.command(CMD_REPAY, 1, 0), BAD_AMOUNT);
        assert_eq!(w.command(CMD_REPAY, 0, 0), BAD_AMOUNT);
    }
}
