//! Fuel, hull and hazards, and the port services that put them right (M1).
//!
//! Fuel: the player's tank (`game.fuel`, tons; a hull type's `fuel` when full). The burner burns it (the Book's
//! Physics: "burns fuel"), a full tank lasting `burn_secs` of burn; an empty tank leaves the burner dead (player.rs).
//! M4's jumps will spend it too.
//!
//! Hull: every ship's points (`ships.hull`; a type's `hull` when sound). In M1 only radiation wears it down: the
//! hazard zones round the exotic stars (the Book's System contents: pulsars and black holes "create hazard zones";
//! Radiation: "above a threshold, unshielded hulls take damage"). Inside a zone `hazard` metres round a body, a hull
//! loses up to `rad` of its sound points a second, scaled by (1 - d / hazard)^2, so the edge is safe enough to cross
//! and the middle is not. Shields, which would soak it first, come with M2. A traffic ship that loses its hull is
//! gone; the player's ship lost is the game's MODE_DEAD, and the page reloads the last landing's save (the Book's
//! death rule).
//!
//! The port's services (body `svc` bits, from the system file's port services): refuelling fills the tank at the
//! port's fuel price (`fuel_price`, credits a ton), repair restores the hull at `repair_cost` credits a point. Each
//! does as much as the player can pay for. Both are commands, so they replay.

use crate::market::NO_CREDITS;
use crate::port::{MODE_DEAD, MODE_LANDED, OK, WRONG_MODE};
use crate::world::{World, DT, P};

/// Port services, bits of `bodies.svc`.
pub const SVC_REFUEL: u8 = 1;
pub const SVC_REPAIR: u8 = 2;

/// Fill the tank at the port the player is landed at (as far as the credits go).
pub const CMD_REFUEL: u32 = 11;
/// Repair the hull at the port the player is landed at (as far as the credits go).
pub const CMD_REPAIR: u32 = 12;

/// The port does not offer that service.
pub const NO_SERVICE: i32 = 13;
/// The tank is full, or the hull sound.
pub const NOTHING_TO_DO: i32 = 14;

impl World {
    /// The player's tank now and full, tons.
    pub fn fuel(&self) -> f64 { self.game.fuel[0] }
    pub fn fuel_cap(&self) -> f64 { self.player_type().map_or(0.0, |k| self.types.fuel[k]) }
    /// The player's hull now and sound, points.
    pub fn hull(&self) -> f64 { usize::try_from(self.game.player[0]).ok().filter(|&i| i < self.count).map_or(0.0, |i| self.ships.hull[i]) }
    pub fn hull_cap(&self) -> f64 { self.player_type().map_or(0.0, |k| self.types.hull[k]) }
    fn player_type(&self) -> Option<usize> { usize::try_from(self.game.player[0]).ok().filter(|&i| i < self.count).map(|i| self.ships.kind[i] as usize) }

    /// What a full tank and a full repair would cost here, in credits (0 if there is nothing to do).
    pub fn refuel_cost(&self, at: usize) -> u32 { ((self.fuel_cap() - self.fuel()).max(0.0) * self.bodies.fuel_price[at] as f64).ceil() as u32 }
    pub fn repair_cost(&self) -> u32 { ((self.hull_cap() - self.hull()).max(0.0) * self.p(P::repair_cost)).ceil() as u32 }

    /// Radiation at (x, y): the share of a sound hull lost a second, summed over every hazard zone.
    pub fn radiation(&self, x: f64, y: f64) -> f64 {
        let b = &self.bodies;
        let mut dose = 0.0;
        for j in 0..self.n_bodies {
            if b.hazard[j] <= 0.0 || b.rad[j] <= 0.0 { continue; }
            let d = (x - b.x[j]).hypot(y - b.y[j]);
            if d < b.hazard[j] { let q = 1.0 - d / b.hazard[j]; dose += b.rad[j] * q * q; }
        }
        dose
    }

    /// The ships stage, after motion: the player's burner burns fuel; radiation wears hulls down, and a hull at zero
    /// is lost.
    pub(crate) fn step_ships(&mut self) {
        if let Ok(i) = usize::try_from(self.game.player[0])
            && i < self.count && self.ships.alive[i] != 0 && self.ships.burn[i] != 0 && self.ships.main[i] > 0.0 {
            let tank = self.types.fuel[self.ships.kind[i] as usize];
            self.game.fuel[0] = (self.game.fuel[0] - tank / self.p(P::burn_secs).max(1.0) * DT).max(0.0);
        }
        if !(0..self.n_bodies).any(|j| self.bodies.hazard[j] > 0.0) { return; }
        let player = usize::try_from(self.game.player[0]).ok();
        for i in 0..self.count {
            if self.ships.alive[i] == 0 || self.ships.rail[i] != 0 { continue; }
            let dose = self.radiation(self.ships.x[i], self.ships.y[i]);
            if dose <= 0.0 { continue; }
            self.ships.hull[i] -= dose * self.types.hull[self.ships.kind[i] as usize] * DT;
            if self.ships.hull[i] > 0.0 { continue; }
            self.ships.hull[i] = 0.0;
            if Some(i) == player { self.lose_ship(i); } else if self.traffic.role[i] != 0 { self.despawn(i); }
        }
    }

    /// The player's ship is lost: out of the sim, and the game over until the page loads a save.
    fn lose_ship(&mut self, i: usize) {
        let s = &mut self.ships;
        s.alive[i] = 0;
        s.main[i] = 0.0; s.lat[i] = 0.0; s.turn_in[i] = 0.0; s.burn[i] = 0;
        self.game.mode[0] = MODE_DEAD;
        (self.game.auto[0], self.game.set[0]) = (0, 0.0);
    }

    /// CMD_REFUEL and CMD_REPAIR: landed, at a port with the service, with something to do; as much as the credits pay for.
    pub(crate) fn service(&mut self, code: u32) -> i32 {
        if self.mode() != MODE_LANDED { return WRONG_MODE; }
        let at = self.game.at[0] as usize;
        let (bit, need, price) = if code == CMD_REFUEL {
            (SVC_REFUEL, (self.fuel_cap() - self.fuel()).max(0.0), self.bodies.fuel_price[at] as f64)
        } else {
            (SVC_REPAIR, (self.hull_cap() - self.hull()).max(0.0), self.p(P::repair_cost))
        };
        if self.bodies.svc[at] & bit == 0 || price <= 0.0 { return NO_SERVICE; }
        if need <= 1e-9 { return NOTHING_TO_DO; }
        let cr = self.credits() as f64;
        let full = (need * price).ceil();
        let (amount, cost) = if cr >= full { (need, full) } else { (cr / price, cr) };
        if amount <= 0.0 || cost <= 0.0 { return NO_CREDITS; }
        self.game.credits[0] -= cost as u32;
        if code == CMD_REFUEL { self.game.fuel[0] = if amount >= need { self.fuel_cap() } else { self.game.fuel[0] + amount }; }
        else {
            let i = self.game.player[0] as usize;
            self.ships.hull[i] = if amount >= need { self.hull_cap() } else { self.ships.hull[i] + amount };
        }
        OK
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::{IN_ASSIST, IN_BURN, IN_THRUST};
    use crate::port::{BODY_PLANET, BODY_STAR, CMD_LAND, CMD_LAUNCH, MODE_FLYING};
    use crate::world::Config;

    /// A port planet at (20 km, 0) and a black hole at the origin with a 6 km hazard zone; the player's ship (hull
    /// 100, a 4 t tank) flying at (x, 0), with 1000 credits.
    fn world(x: f64) -> Box<World> {
        let mut w = World::new(Config { max_ships: 4, max_types: 1, max_bodies: 2, env_n: 4, env_w: 1000.0 }, 3);
        (w.types.accel[0], w.types.turn[0], w.types.vmax[0], w.types.hull[0], w.types.fuel[0]) = (60.0, 1.0, 200.0, 100.0, 4.0);
        w.n_bodies = 2;
        (w.bodies.r[0], w.bodies.kind[0], w.bodies.hazard[0], w.bodies.rad[0]) = (500.0, BODY_STAR, 6000.0, 0.1);
        (w.bodies.x[1], w.bodies.r[1], w.bodies.kind[1], w.bodies.port[1], w.bodies.svc[1], w.bodies.fuel_price[1]) = (20_000.0, 800.0, BODY_PLANET, 1, SVC_REFUEL | SVC_REPAIR, 50);
        (w.count, w.ships.alive[0], w.game.player[0]) = (1, 1, 0);
        (w.ships.x[0], w.ships.hull[0], w.game.fuel[0], w.game.credits[0]) = (x, 100.0, 4.0, 1000);
        w
    }
    fn run(w: &mut World, secs: f64) { for _ in 0..(secs / DT).round() as usize { w.step(); } }

    #[test]
    fn the_burner_burns_fuel_and_an_empty_tank_kills_it() {
        let mut w = world(-50_000.0);
        w.game.input[0] = IN_ASSIST | IN_THRUST | IN_BURN;
        run(&mut w, 30.0);
        assert!((w.fuel() - 3.6).abs() < 0.01, "{}", w.fuel()); // a tenth of the 300 s a tank lasts
        w.game.input[0] = IN_ASSIST | IN_THRUST;
        run(&mut w, 10.0);
        assert!((w.fuel() - 3.6).abs() < 0.01, "cruise burns nothing: {}", w.fuel());
        w.game.fuel[0] = 0.0;
        w.game.input[0] = IN_ASSIST | IN_THRUST | IN_BURN;
        w.step();
        assert_eq!(w.ships.burn[0], 0);
        assert!(w.game.set[0] <= w.types.vmax[0] + 1e-9);
    }

    #[test]
    fn radiation_is_strongest_at_the_middle_and_kills() {
        let mut w = world(4500.0); // a quarter of the way in: (1 - .75)^2 = 1/16 of 10% a second
        run(&mut w, 10.0);
        assert!((w.hull() - (100.0 - 100.0 * 0.1 / 16.0 * 10.0)).abs() < 1.0, "{}", w.hull());
        let mut w = world(7000.0);
        run(&mut w, 10.0);
        assert_eq!(w.hull(), 100.0); // outside the zone: nothing
        let mut w = world(600.0);
        run(&mut w, 20.0);
        assert_eq!((w.mode(), w.ships.alive[0], w.hull()), (MODE_DEAD, 0, 0.0));
        assert_eq!(w.command(CMD_LAND, 0, 0), WRONG_MODE);
        assert_eq!(w.command(crate::port::CMD_JUMP, 0, 1), WRONG_MODE);
    }

    #[test]
    fn refuel_and_repair_in_port() {
        let mut w = world(20_000.0);
        (w.ships.hull[0], w.game.fuel[0]) = (40.0, 1.0);
        assert_eq!(w.command(CMD_REFUEL, 0, 0), WRONG_MODE); // flying
        assert_eq!(w.command(CMD_LAND, 0, 0), OK);
        run(&mut w, 4.0);
        assert_eq!((w.refuel_cost(1), w.repair_cost()), (150, 120));
        assert_eq!(w.command(CMD_REFUEL, 0, 0), OK);
        assert_eq!((w.fuel(), w.credits()), (4.0, 850));
        assert_eq!(w.command(CMD_REFUEL, 0, 0), NOTHING_TO_DO);
        w.game.credits[0] = 60; // half the repair
        assert_eq!(w.command(CMD_REPAIR, 0, 0), OK);
        assert_eq!((w.hull(), w.credits()), (70.0, 0));
        assert_eq!(w.command(CMD_REPAIR, 0, 0), NO_CREDITS);
        w.bodies.svc[1] = SVC_REFUEL;
        w.game.credits[0] = 500;
        assert_eq!(w.command(CMD_REPAIR, 0, 0), NO_SERVICE);
        assert_eq!(w.command(CMD_LAUNCH, 0, 0), OK);
        run(&mut w, 4.0);
        assert_eq!(w.mode(), MODE_FLYING);
    }

    #[test]
    fn traffic_lost_to_radiation_is_gone() {
        let mut w = world(-5900.0); // near enough that the traffic flies physics, at the zone's edge
        w.count = 2;
        // a traffic ship crawling out of the middle toward the port, far too slowly
        (w.ships.alive[1], w.ships.x[1], w.ships.hull[1], w.ships.ctl[1]) = (1, 300.0, 100.0, 1);
        let (t, r, base) = (&mut w.traffic, &mut w.route, crate::traffic::MAX_PTS);
        (t.role[1], t.phase[1], t.to[1], t.npts[1], t.cruise[1], t.len[1]) = (crate::traffic::LOCAL, crate::traffic::T_CRUISE, 1, 2, 1.0, 100_000.0);
        (r.x[base], r.x[base + 1], r.y[base + 1], r.s[base + 1]) = (300.0, 300.0, 100_000.0, 100_000.0);
        run(&mut w, 20.0);
        assert_eq!((w.ships.alive[1], w.traffic.role[1], w.mode()), (0, 0, MODE_FLYING));
    }
}
