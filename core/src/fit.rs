//! Outfitting (the Book's Outfitting, Energy and heat, and Shields chapters, M2; docs/outfitting.md): a ship as a
//! frame and the components bought for it by the tonne, and the power, heat and shield they make.
//!
//! The frame is the hull's (content, on its type: `frame` tonnes, the bay's pressurised and unpressurised tonnes, its
//! plumes, its structure, its minimum crew). The fit is tonnes per component slot (F_*): a torch per plume and a jet
//! cluster per corner (each half a tonne, then by the tonne; the plumes take `torch_room` times the stock fit's
//! torches in all, however they are split), and the rest by the tonne in steps (the reactor 5 t, the deflector 2 t,
//! most 1 t; bunks by the bunk; the bulkhead, signed, moves pressurised space into the unpressurised bay or back, by
//! up to `bulkhead_max` of it). Every component has the same rating per tonne on every frame
//! (params, Ironhull gear). Pressurised: bunks, sensors, reactor, jump drive, battery, shield banks, the climate hold.
//! Unpressurised: hoppers, container racks, the fuel tank, deflector, fins, heat sinks. Torches, jets and armour sit
//! outside the bay.
//!
//! The player's ship is fitted: its type is the last row (`player_kind`), written each tick from the fit, the cargo
//! and fuel aboard (mass is everything, cargo included: acceleration is thrust over mass, turning likewise from the
//! jets) and last tick's power. Its catalog type (`game.base`) is kept for the hull's looks, top speed and the jump's
//! fuel. A new game fits it with the stock fit, made here from its catalog stats (`stock_fit`): the fit that gives
//! the catalog's acceleration, turn, hull, shield, hold and fuel, so flight is the same until someone refits.
//!
//! Power, each tick: the reactor (`furnace_mw` a tonne) and the battery feed the helm and drive first (life support,
//! sensors, the torches by their thrust, the jets as they fire, the burner), then the deflector's regen. Short of
//! power the helm and drive brown out (`game.drive`: their thrust and turn scale with the share met), and the shield
//! regenerates slower or not at all. With no reactor the battery runs everything until it is flat.
//!
//! Heat, in MJ: capacity `heat_mj` a tonne of ship plus heat sinks; the reactor's waste, the torches and the burner
//! add it; the hull's skin and the fins shed it in proportion to how hot the ship is (faster in gas). `game.heat` is
//! the share of capacity: at full the burner locks until it is down to `heat_unlock`.
//!
//! Shields: banks give the points, the deflector the regen (drawing power while it regenerates). Radiation drains the
//! shield first (`shield_rad` times faster than it would wear the hull), and while the shield holds, the hull takes
//! none of it and only `shield_heat` of its heat. A shield drained to nothing collapses and restarts after
//! `shield_restart` seconds; running cold drops it (the Book: running cold drops shields).
//!
//! Cargo: each commodity has a hold class (`goods.class`): bulk goes in any hold, general cargo in racks or the
//! climate hold, climate cargo (food, medicine) only in a climate hold. Buying and accepting a delivery check it.
//!
//! The outfitter (a port service): the page edits the draft (CMD_DRAFT, logged, so replays follow it), the core shows
//! what it would make (`view_fit`, into `fitview`), and CMD_REFIT puts it on the ship at once, for the difference in
//! price (components taken out are bought back at `resale`; a torch changed is a new torch).

use crate::market::{MAX_GOODS, NO_CREDITS, NO_ROOM, BAD_AMOUNT};
use crate::mission::{MAX_MISSIONS, M_ACTIVE};
use crate::port::{MODE_LANDED, OK, WRONG_MODE};
use crate::service::NO_SERVICE;
use crate::world::{World, DT, P};

/// Fit slots: components by the tonne (bunks a count; the bulkhead signed tonnes moved into pressure).
pub const F_FURNACE: usize = 0;
pub const F_BATTERY: usize = 1;
pub const F_DEFLECTOR: usize = 2;
pub const F_BANKS: usize = 3;
pub const F_FINS: usize = 4;
pub const F_SINKS: usize = 5;
pub const F_ARMOUR: usize = 6;
pub const F_JUMP: usize = 7;
pub const F_SENSORS: usize = 8;
pub const F_BUNKS: usize = 9;
pub const F_TANK: usize = 10;
pub const F_HOPPER: usize = 11;
pub const F_RACK: usize = 12;
pub const F_CLIMATE: usize = 13;
pub const F_BULKHEAD: usize = 14;
/// A torch per plume, MAX_PLUMES slots from here; a jet cluster per corner, 4 from F_CORNER.
pub const F_PLUME: usize = 16;
pub const MAX_PLUMES: usize = 8;
pub const F_CORNER: usize = 24;
pub const CORNERS: usize = 4;
pub const MAX_FIT: usize = 32;
/// The slots' names, for the manifest (the page's outfitter keys its rows by them); "" unused.
pub const SLOT_NAMES: [&str; MAX_FIT] = ["furnace", "battery", "deflector", "banks", "fins", "sinks", "armour", "jump", "sensors", "bunks", "tank",
    "hopper", "rack", "climate", "bulkhead", "", "plume0", "plume1", "plume2", "plume3", "plume4", "plume5", "plume6", "plume7",
    "corner0", "corner1", "corner2", "corner3", "", "", "", ""];

/// Hold classes (`goods.class`).
pub const CLASS_BULK: u8 = 0;
pub const CLASS_GENERAL: u8 = 1;
pub const CLASS_CLIMATE: u8 = 2;

/// Set draft slot `a` to `b` half-tonnes (bunks: half-bunks, so b = 2 x count), at an outfitter.
pub const CMD_DRAFT: u32 = 17;
/// Start the draft over: a = 0 from the ship's fit, 1 from the stock fit.
pub const CMD_DRAFT_FROM: u32 = 18;
/// Put the draft on the ship, paying the difference.
pub const CMD_REFIT: u32 = 19;

/// The jump drive can't move this much ship (its rating is under the laden mass), or there is none.
pub const NO_DRIVE: i32 = 23;
/// Fewer bunks than the frame's minimum crew: the ship can't launch.
pub const NO_CREW: i32 = 24;
/// The fit needs more pressurised or unpressurised space than the bay has.
pub const NO_BAY_ROOM: i32 = 25;
/// Past the hull's limits: more plumes or more torch than it takes, more armour than it holds, the bulkhead too far.
pub const OVER_LIMIT: i32 = 26;
/// The cargo aboard would not fit the holds.
pub const CARGO_WONT_FIT: i32 = 27;
/// Food and medicine travel only in a climate hold.
pub const NEEDS_CLIMATE: i32 = 28;

/// The outfitter's view of a fit (`fitview`), by index (names in STAT_NAMES, for the manifest).
pub const S_MASS: usize = 0; // now: the cargo and fuel aboard
pub const S_MASS_EMPTY: usize = 1; // an empty hold and a full tank
pub const S_MASS_FULL: usize = 2; // a full hold and a full tank
pub const S_THRUST: usize = 3; // MN
pub const S_ACCEL: usize = 4; // empty hold, full tank
pub const S_ACCEL_FULL: usize = 5;
pub const S_TURN: usize = 6; // empty hold, full tank
pub const S_VMAX: usize = 7;
pub const S_P_USED: usize = 8;
pub const S_P_SPACE: usize = 9;
pub const S_U_USED: usize = 10;
pub const S_U_SPACE: usize = 11;
pub const S_BULK_MAX: usize = 12;
pub const S_MW: usize = 13; // reactor output
pub const S_MW_LIFE: usize = 14; // avionics, life support, sensors
pub const S_MW_DRIVE: usize = 15; // torches at full thrust and the jets firing
pub const S_MW_REGEN: usize = 16; // the deflector regenerating
pub const S_MW_BURN: usize = 17; // the burner's extra
pub const S_BATTERY: usize = 18; // MJ
pub const S_SHIELD: usize = 19; // points
pub const S_REGEN: usize = 20; // points a second
pub const S_HULL: usize = 21;
pub const S_ARMOUR_CAP: usize = 22; // tonnes
pub const S_FUEL: usize = 23; // tank, tonnes of fuel
pub const S_HOPPER: usize = 24;
pub const S_RACK: usize = 25;
pub const S_CLIMATE: usize = 26;
pub const S_HEAT_CAP: usize = 27; // MJ
pub const S_SHED: usize = 28; // MW at full heat
pub const S_BURN_SECS: usize = 29; // seconds of burner from cold to lockout (-1: never)
pub const S_JUMP: usize = 30; // tonnes the drive jumps
pub const S_CREW: usize = 31;
pub const S_CREW_MIN: usize = 32;
pub const S_PLUMES: usize = 33;
pub const S_TORCH_CAP: usize = 34; // torch tonnes the plumes take in all
pub const S_VALUE: usize = 35; // what the fit's components cost new, credits
pub const S_COST: usize = 36; // the refit to the draft, credits (negative: money back)
pub const S_PROBLEM: usize = 37; // why the draft can't be fitted (a result code; 0 it can)
pub const S_ROOM: usize = 38; // tonnes of cargo aboard now, all holds
pub const N_STATS: usize = 39;
pub const STAT_NAMES: [&str; N_STATS] = ["mass", "massEmpty", "massFull", "thrust", "accel", "accelFull", "turn", "vmax", "pUsed", "pSpace", "uUsed", "uSpace",
    "bulkMax", "mw", "mwLife", "mwDrive", "mwRegen", "mwBurn", "battery", "shield", "regen", "hull", "armourCap", "fuel", "hopper", "rack", "climate",
    "heatCap", "shed", "burnSecs", "jump", "crew", "crewMin", "plumes", "torchCap", "value", "cost", "problem", "cargo"];

/// A fit's numbers, for a load of cargo and fuel (see `stats`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub mass: f64, pub dry: f64, pub thrust: f64, pub accel: f64, pub turn: f64, pub jets: f64,
    pub p_used: f64, pub p_space: f64, pub u_used: f64, pub u_space: f64,
    pub mw: f64, pub mw_life: f64, pub battery: f64, pub shield: f64, pub regen: f64,
    pub hull: f64, pub fuel: f64, pub hopper: f64, pub rack: f64, pub climate: f64, pub heat_cap: f64, pub shed: f64, pub jump: f64,
}

impl World {
    /// The type row the player's fitted ship flies as: the last.
    pub fn player_kind(&self) -> usize { self.cfg.max_types.saturating_sub(1) }
    /// Whether the player flies a fitted ship (a new game's stock fit, or a save of one).
    pub fn fitted(&self) -> bool { self.game.fitted[0] != 0 }
    /// The catalog type the player's ship is built on.
    fn base(&self) -> usize { (self.game.base[0] as usize).min(self.cfg.max_types.saturating_sub(1)) }
    fn player_slot(&self) -> Option<usize> { usize::try_from(self.game.player[0]).ok().filter(|&i| i < self.count) }

    /// A torch's price: cubed in its tonnes, so the same thrust split unevenly costs more.
    fn torch_price(&self, t: f64) -> f64 { self.p(P::price_torch) * t * t * t }
    /// Credits a tonne (a bunk) of slot `k` (not the plumes; the bulkhead's is labour).
    fn slot_price(&self, k: usize) -> f64 {
        self.p(match k {
            F_FURNACE => P::price_furnace, F_BATTERY => P::price_battery, F_DEFLECTOR => P::price_deflector, F_BANKS => P::price_bank,
            F_FINS => P::price_fin, F_SINKS => P::price_sink, F_ARMOUR => P::price_armour, F_JUMP => P::price_jump, F_SENSORS => P::price_sensor,
            F_BUNKS => P::price_bunk, F_TANK => P::price_tank, F_HOPPER => P::price_hopper, F_RACK => P::price_rack, F_CLIMATE => P::price_climate,
            F_BULKHEAD => P::price_bulkhead,
            k if (F_CORNER..F_CORNER + CORNERS).contains(&k) => P::price_jet,
            _ => return 0.0,
        })
    }
    /// What a fit's components cost new.
    pub fn fit_value(&self, f: &[f64]) -> f64 {
        (0..MAX_FIT).map(|k| if (F_PLUME..F_PLUME + MAX_PLUMES).contains(&k) { self.torch_price(f[k]) } else if k == F_BULKHEAD { 0.0 } else { self.slot_price(k) * f[k] }).sum()
    }
    /// What refitting from `cur` to `new` costs: what goes in, at its price, less what comes out, at `resale` of its
    /// price; a changed torch is a new torch; moving the bulkhead is labour either way. Negative: money back.
    pub fn refit_cost(&self, cur: &[f64], new: &[f64]) -> f64 {
        let back = self.p(P::resale);
        let mut c = 0.0;
        for k in 0..MAX_FIT {
            let (a, b) = (cur[k], new[k]);
            if a == b { continue; }
            if (F_PLUME..F_PLUME + MAX_PLUMES).contains(&k) { c += self.torch_price(b) - back * self.torch_price(a); }
            else if k == F_BULKHEAD { c += self.slot_price(k) * (b - a).abs(); }
            else if b > a { c += self.slot_price(k) * (b - a); }
            else { c -= back * self.slot_price(k) * (a - b); }
        }
        c.round()
    }

    /// Fit `f` on catalog type `k`'s frame, carrying `cargo` and `fuel` tonnes.
    pub fn stats(&self, k: usize, f: &[f64], cargo: f64, fuel: f64) -> Stats {
        let t = &self.types;
        let p = |q: P| self.p(q);
        let thrust = (F_PLUME..F_PLUME + MAX_PLUMES).map(|s| f[s]).sum::<f64>() * p(P::torch_mn);
        let torches: f64 = (F_PLUME..F_PLUME + MAX_PLUMES).map(|s| f[s]).sum();
        let jets: f64 = (F_CORNER..F_CORNER + CORNERS).map(|s| f[s]).sum();
        let bulk = f[F_BULKHEAD];
        let p_used = f[F_BUNKS] * p(P::bunk_t) + f[F_SENSORS] + f[F_FURNACE] + f[F_JUMP] + f[F_BATTERY] + f[F_BANKS] + f[F_CLIMATE];
        let u_used = f[F_HOPPER] + f[F_RACK] + f[F_TANK] + f[F_DEFLECTOR] + f[F_FINS] + f[F_SINKS];
        let dry = t.frame[k] + torches + jets + f[F_FURNACE] + f[F_BATTERY] + f[F_DEFLECTOR] + f[F_BANKS] + f[F_FINS] + f[F_SINKS] + f[F_ARMOUR]
            + f[F_JUMP] + f[F_SENSORS] + f[F_BUNKS] * p(P::bunk_t) + f[F_TANK] * (1.0 - p(P::tank_fuel))
            + f[F_HOPPER] * p(P::hopper_mass) + f[F_RACK] * p(P::rack_mass) + f[F_CLIMATE] * p(P::climate_mass) + bulk.max(0.0) * p(P::bulkhead_mass);
        let mass = (dry + cargo + fuel).max(1.0);
        Stats {
            mass, dry, thrust, jets,
            accel: 1000.0 * thrust / mass,
            turn: p(P::jet_turn) * jets / (mass * t.len[k].max(1.0)),
            p_used, p_space: t.bay_p[k] + bulk, u_used, u_space: t.bay_u[k] - bulk,
            mw: f[F_FURNACE] * p(P::furnace_mw),
            mw_life: p(P::avionics_mw) * t.frame[k] + p(P::bunk_mw) * f[F_BUNKS] + p(P::sensor_mw) * f[F_SENSORS],
            battery: f[F_BATTERY] * p(P::battery_mj),
            shield: f[F_BANKS] * p(P::bank_pts), regen: f[F_DEFLECTOR] * p(P::defl_regen),
            hull: t.structure[k] + f[F_ARMOUR] * p(P::armour_pts),
            fuel: f[F_TANK] * p(P::tank_fuel),
            hopper: f[F_HOPPER], rack: f[F_RACK], climate: f[F_CLIMATE],
            heat_cap: mass * p(P::heat_mj) + f[F_SINKS] * p(P::sink_mj),
            shed: p(P::skin_mw) * t.frame[k] + p(P::fin_mw) * f[F_FINS],
            jump: f[F_JUMP] * p(P::jump_t),
        }
    }

    /// The fit that gives catalog type `k` its catalog stats: torches for its acceleration (split as evenly as the
    /// steps allow, the cheapest way), jets for its turn, armour for its hull over the frame's structure, banks for its
    /// shield (and a deflector to refill it in about 20 s), a tank for its fuel, half its hold in hoppers and half in
    /// racks; the minimum crew and a spare bunk, the frame's sensors; then a reactor for cruising and regenerating, a
    /// battery for 20 s of burner, fins that shed full heat in about 10 s and a jump drive for the laden ship. The mass
    /// these add changes what the torches and jets need, so it goes round until it settles.
    pub fn stock_fit(&self, k: usize) -> [f64; MAX_FIT] {
        let t = &self.types;
        let p = |q: P| self.p(q);
        let up = |x: f64, step: f64| if x <= 0.0 { 0.0 } else { (x / step - 1e-9).ceil() * step };
        let mut f = [0.0; MAX_FIT];
        let cargo = t.cargo[k] as f64;
        f[F_HOPPER] = (cargo / 2.0).floor();
        f[F_RACK] = cargo - f[F_HOPPER];
        f[F_ARMOUR] = up((t.hull[k] - t.structure[k]) / p(P::armour_pts), 1.0);
        f[F_BANKS] = up(t.shield[k] / p(P::bank_pts), 1.0);
        f[F_DEFLECTOR] = if f[F_BANKS] > 0.0 { up(f[F_BANKS] * p(P::bank_pts) / 20.0 / p(P::defl_regen), 2.0).max(2.0) } else { 0.0 };
        f[F_TANK] = up(t.fuel[k] / p(P::tank_fuel), 1.0);
        f[F_BUNKS] = t.crew[k] as f64 + 1.0;
        f[F_SENSORS] = t.sensors[k];
        let n = (t.plumes[k] as usize).clamp(1, MAX_PLUMES);
        for _ in 0..16 {
            let s = self.stats(k, &f, 0.0, f[F_TANK] * p(P::tank_fuel));
            // torches: the thrust for the catalog's acceleration, in whole tonnes split as evenly as they go (the
            // cheapest way: a torch's price is cubed), the extra tonnes on the outer plumes first and an odd one on the
            // centreline where there is one, or half a tonne each if that does it
            let need = t.accel[k] * s.mass / 1000.0 / p(P::torch_mn);
            let each = if need <= 0.5 * n as f64 { [0.5; MAX_PLUMES] } else {
                let total = need.ceil() as usize;
                let (base, extra) = (total / n, total % n);
                let mut e = [base as f64; MAX_PLUMES];
                let order: Vec<usize> = (0..n).map(|q| if q % 2 == 0 { q / 2 } else { n - 1 - q / 2 }).collect(); // outside in, alternating ends
                let centre = n / 2;
                let mut left = extra;
                if extra % 2 == 1 && n % 2 == 1 { e[centre] += 1.0; left -= 1; }
                for &q in order.iter().filter(|&&q| !(n % 2 == 1 && q == centre)) { if left == 0 { break; } e[q] += 1.0; left -= 1; }
                e
            };
            for q in 0..MAX_PLUMES { f[F_PLUME + q] = if q < n { each[q] } else { 0.0 }; }
            // jets: a cluster per corner, the same on each, for the catalog's turn (half a tonne, or whole tonnes)
            let jets = t.turn[k] * s.mass * t.len[k].max(1.0) / p(P::jet_turn) / CORNERS as f64;
            let jets = if jets <= 0.5 { 0.5 } else { up(jets, 1.0) };
            for c in 0..CORNERS { f[F_CORNER + c] = jets; }
            let thrust = s.thrust;
            let drive = p(P::torch_mw) * thrust + p(P::jet_mw) * jets * CORNERS as f64;
            let regen = p(P::defl_mw) * f[F_DEFLECTOR];
            f[F_FURNACE] = up((s.mw_life + drive + regen) / p(P::furnace_mw), 5.0).max(5.0);
            f[F_BATTERY] = up(p(P::burn_mw) * thrust * 20.0 / p(P::battery_mj), 1.0).max(1.0);
            f[F_FINS] = up((s.heat_cap / 10.0 - p(P::skin_mw) * t.frame[k]) / p(P::fin_mw), 1.0).max(1.0);
            f[F_JUMP] = up((s.mass + cargo) * 1.1 / p(P::jump_t), 1.0).max(1.0);
            // pressurised space past the frame's: the bulkhead moves to make it (the Clads' bigger reactor and gunners)
            let s = self.stats(k, &f, 0.0, 0.0);
            f[F_BULKHEAD] = up((s.p_used - t.bay_p[k]).max(0.0), 1.0);
        }
        f
    }

    /// The torch tonnes catalog type `k`'s plumes take in all: `torch_room` times its stock fit's, to the tonne.
    pub fn torch_cap(&self, k: usize) -> f64 {
        let f = self.stock_fit(k);
        (self.p(P::torch_room) * (F_PLUME..F_PLUME + MAX_PLUMES).map(|s| f[s]).sum::<f64>() - 1e-9).ceil()
    }

    /// The tonnes aboard in each hold class (trade cargo and mission cargo).
    pub fn cargo_by_class(&self) -> [f64; 3] {
        let mut c = [0.0; 3];
        for g in 0..MAX_GOODS { c[(self.goods.class[g] as usize).min(2)] += self.hold.tons[g] as f64; }
        for m in 0..MAX_MISSIONS {
            if self.missions.state[m] == M_ACTIVE { c[(self.goods.class[(self.missions.good[m] as usize).min(MAX_GOODS - 1)] as usize).min(2)] += self.missions.tons[m] as f64; }
        }
        c
    }
    /// Whether `c` (tonnes in each class) fits holds of hopper `h`, rack `r` and climate `cl` tonnes: climate cargo in
    /// the climate hold, general in it or the racks, bulk anywhere.
    fn holds_take(c: [f64; 3], h: f64, r: f64, cl: f64) -> bool {
        let e = 1e-9;
        c[2] <= cl + e && c[1] + c[2] <= cl + r + e && c[0] + c[1] + c[2] <= h + r + cl + e
    }
    /// The most tonnes of commodity `g` that would still fit aboard (the hold's free room, for an unfitted ship).
    pub fn room_for(&self, g: usize) -> u32 {
        if !self.fitted() { return self.hold_cap().saturating_sub(self.hold_used()); }
        let c = self.cargo_by_class();
        let (h, r, cl) = (self.fit.t[F_HOPPER], self.fit.t[F_RACK], self.fit.t[F_CLIMATE]);
        let all = h + r + cl - c[0] - c[1] - c[2];
        let room = match self.goods.class[g.min(MAX_GOODS - 1)] {
            CLASS_CLIMATE => (cl - c[2]).min(cl + r - c[1] - c[2]).min(all),
            CLASS_GENERAL => (cl + r - c[1] - c[2]).min(all),
            _ => all,
        };
        (room + 1e-9).floor().max(0.0) as u32
    }
    /// Whether `tons` more of commodity `g` fit aboard: OK, NEEDS_CLIMATE (food or medicine, and no climate hold) or
    /// NO_ROOM.
    pub fn cargo_fits(&self, g: usize, tons: u32) -> i32 {
        if !self.fitted() { return if self.hold_used() as u64 + tons as u64 > self.hold_cap() as u64 { NO_ROOM } else { OK }; }
        if tons <= self.room_for(g) { return OK; }
        if self.goods.class[g.min(MAX_GOODS - 1)] == CLASS_CLIMATE && self.fit.t[F_CLIMATE] <= 0.0 { NEEDS_CLIMATE } else { NO_ROOM }
    }

    /// Fit the player's ship (the slot flown, its kind the catalog type it is built on) with that type's stock fit: a
    /// new game. Sound, fuelled, charged and cool.
    pub fn fit_stock(&mut self) {
        let Some(i) = self.player_slot() else { return };
        let base = (self.ships.kind[i] as usize).min(self.player_kind());
        let f = self.stock_fit(base);
        self.fit.t.copy_from_slice(&f);
        self.draft.t.copy_from_slice(&f);
        (self.game.fitted[0], self.game.base[0]) = (1, base as u16);
        self.ships.kind[i] = self.player_kind() as u16;
        let s = self.stats(base, &f, 0.0, 0.0);
        self.ships.hull[i] = s.hull;
        self.game.fuel[0] = s.fuel;
        self.charge_up();
        self.fit_tick();
    }

    /// In port the ship is on the port's power: the battery and shield full, the heat gone.
    pub(crate) fn charge_up(&mut self) {
        if !self.fitted() { return; }
        let s = self.stats(self.base(), &self.fit.t, 0.0, 0.0);
        (self.game.energy[0], self.game.shield[0], self.game.shield_t[0], self.game.heat[0], self.game.hot[0], self.game.drive[0]) = (s.battery, s.shield, 0.0, 0.0, 0, 1.0);
    }

    /// Each tick, before the player flies: the fitted type from the fit, the load aboard and last tick's power (the
    /// helm and drive's share met scales thrust and turn). Top speed, well sensitivity and length are the hull's own.
    pub(crate) fn fit_tick(&mut self) {
        if !self.fitted() { return; }
        let (base, pk) = (self.base(), self.player_kind());
        let c = self.cargo_by_class();
        let s = self.stats(base, &self.fit.t, c[0] + c[1] + c[2], self.game.fuel[0]);
        let k = self.game.drive[0].clamp(0.0, 1.0);
        let t = &mut self.types;
        t.accel[pk] = s.accel * k;
        t.turn[pk] = (s.turn * k).max(1e-3);
        (t.vmax[pk], t.well[pk], t.len[pk]) = (t.vmax[base], t.well[base], t.len[base]);
        t.cargo[pk] = (s.hopper + s.rack + s.climate + 1e-9).floor() as u32;
        (t.hull[pk], t.fuel[pk]) = (s.hull, s.fuel);
    }

    /// The player's power, heat and shield for this tick (from the ships stage, flying, off rails; `rad_heat` is
    /// radiation's heat, a share of capacity a second, of which a shielded hull takes `shield_heat`): see the module
    /// comment.
    pub(crate) fn fit_power(&mut self, i: usize, rad_heat: f64) {
        let (base, f) = (self.base(), self.fit.t.clone());
        let c = self.cargo_by_class();
        let s = self.stats(base, &f, c[0] + c[1] + c[2], self.game.fuel[0]);
        let p = |q: P| self.p(q);
        let sh = &self.ships;
        let burning = sh.burn[i] != 0 && sh.main[i] > 0.0;
        let main = sh.main[i].abs();
        let jets = sh.turn_in[i].abs().max(sh.lat[i].abs()).min(1.0);
        let gas = sh.gas_h[i] + sh.gas_d[i] + sh.gas_i[i];
        let g = &self.game;
        let cold = g.cold[0] != 0;
        // what each wants this tick, MJ: the helm and drive first, then the deflector
        let drive = (s.mw_life + p(P::torch_mw) * s.thrust * main + if burning { p(P::burn_mw) * s.thrust } else { 0.0 } + p(P::jet_mw) * s.jets * jets) * DT;
        let regenerating = !cold && g.shield_t[0] <= 0.0 && g.shield[0] < s.shield;
        let defl = if cold { 0.0 } else if regenerating { p(P::defl_mw) } else { p(P::defl_hold) } * f[F_DEFLECTOR] * DT;
        let mut avail = s.mw * DT + g.energy[0];
        let k1 = if drive <= avail || drive <= 0.0 { 1.0 } else { avail / drive };
        avail -= drive * k1;
        let k2 = if defl <= avail || defl <= 0.0 { 1.0 } else { (avail / defl).max(0.0) };
        let used = drive * k1 + defl * k2;
        // the reactor makes what is used and tops the battery up; what it makes heats the ship
        let made = (s.mw * DT).min(used + (s.battery - g.energy[0]).max(0.0));
        let energy = (g.energy[0] + made - used).clamp(0.0, s.battery);
        // heat, MJ: the reactor's waste, the torches and the burner (as much as their power ran), radiation; shed by
        // the skin and the fins in proportion to the heat, faster in gas
        let h0 = g.heat[0];
        let shielded = g.shield[0] > 0.0;
        let q = p(P::furnace_waste) * made + (p(P::torch_heat) * s.thrust * main + if burning { p(P::burn_heat) * s.thrust } else { 0.0 }) * k1 * DT;
        let shed = s.shed * h0 * (1.0 + p(P::heat_gas) * gas) * DT;
        let h = (h0 + (q - shed) / s.heat_cap.max(1.0) + rad_heat * if shielded { p(P::shield_heat) } else { 1.0 } * DT).clamp(0.0, 1.0);
        // the shield: regen as its power allows; a restart counts down; running cold drops it
        let (mut shield, mut st) = (g.shield[0].min(s.shield), g.shield_t[0]);
        if cold { shield = 0.0; st = p(P::shield_restart); }
        else if st > 0.0 { st = (st - DT).max(0.0); }
        else if shield < s.shield { shield = (shield + s.regen * k2 * DT).min(s.shield); }
        let g = &mut self.game;
        (g.energy[0], g.drive[0], g.mw_use[0], g.heat[0], g.shield[0], g.shield_t[0]) = (energy, k1, used / DT, h, shield, st);
        if h >= 1.0 { g.hot[0] = 1; } else if h <= self.params[P::heat_unlock as usize] { g.hot[0] = 0; }
    }

    /// Radiation's dose on the fitted player (a share of the sound hull a second, `dose`): the shield takes it first,
    /// `shield_rad` times over; true while the shield holds (the hull is spared), collapsing it if it runs out.
    pub(crate) fn shield_soak(&mut self, dose: f64) -> bool {
        if self.game.shield[0] <= 0.0 { return false; }
        let pts = dose * self.types.hull[self.player_kind()] * self.p(P::shield_rad) * DT;
        self.game.shield[0] -= pts;
        if self.game.shield[0] <= 0.0 { (self.game.shield[0], self.game.shield_t[0]) = (0.0, self.p(P::shield_restart)); }
        true
    }

    /// Why fit `f` can't go on the player's ship now (a result code), or OK: the hull's limits, the bay's space, the
    /// cargo aboard.
    pub fn fit_problem(&self, f: &[f64]) -> i32 {
        let (k, t) = (self.base(), &self.types);
        let n = t.plumes[k] as usize;
        if (n..MAX_PLUMES).any(|q| f[F_PLUME + q] > 0.0) { return OVER_LIMIT; }
        if (F_PLUME..F_PLUME + n).map(|s| f[s]).sum::<f64>() > self.torch_cap(k) + 1e-9 { return OVER_LIMIT; }
        if f[F_ARMOUR] * self.p(P::armour_pts) > t.structure[k] + 1e-9 { return OVER_LIMIT; }
        if f[F_BULKHEAD].abs() > self.p(P::bulkhead_max) * (t.bay_p[k] + t.bay_u[k]) + 1e-9 { return OVER_LIMIT; }
        let s = self.stats(k, f, 0.0, 0.0);
        if s.p_used > s.p_space + 1e-9 || s.u_used > s.u_space + 1e-9 { return NO_BAY_ROOM; }
        if !Self::holds_take(self.cargo_by_class(), f[F_HOPPER], f[F_RACK], f[F_CLIMATE]) { return CARGO_WONT_FIT; }
        OK
    }

    /// Whether the player's ship may launch: its crew (CMD_LAUNCH).
    pub(crate) fn crew_ok(&self) -> bool { !self.fitted() || self.fit.t[F_BUNKS] >= self.types.crew[self.base()] as f64 }
    /// The jump drive's say on a jump: OK, or NO_DRIVE if it can't move the laden ship.
    pub(crate) fn drive_ok(&self) -> i32 {
        if !self.fitted() { return OK; }
        let c = self.cargo_by_class();
        let s = self.stats(self.base(), &self.fit.t, c[0] + c[1] + c[2], self.game.fuel[0]);
        if s.jump + 1e-9 < s.mass { NO_DRIVE } else { OK }
    }
    /// The type whose tank sets a lane's fuel: the hull's own for the player's fitted ship (the jump drive's fuel is
    /// the hull's, whatever its tank holds).
    pub(crate) fn fuel_kind(&self, kind: usize) -> usize { if self.fitted() && kind == self.player_kind() { self.base() } else { kind } }

    /// The outfitter's commands (CMD_DRAFT, CMD_DRAFT_FROM, CMD_REFIT): landed at a port with an outfitter.
    pub(crate) fn fit_command(&mut self, code: u32, a: i32, b: i32) -> i32 {
        if self.mode() != MODE_LANDED || !self.fitted() { return WRONG_MODE; }
        let at = self.game.at[0] as usize;
        if self.bodies.svc[at] & crate::service::SVC_OUTFIT == 0 { return NO_SERVICE; }
        match code {
            CMD_DRAFT => {
                let Some(k) = usize::try_from(a).ok().filter(|&k| k < MAX_FIT && !SLOT_NAMES[k].is_empty()) else { return BAD_AMOUNT };
                let v = b as f64 / 2.0;
                let plume = (F_PLUME..F_PLUME + MAX_PLUMES).contains(&k) || (F_CORNER..F_CORNER + CORNERS).contains(&k); // (half a tonne, then tonnes)
                let step = match k { F_FURNACE => 5.0, F_DEFLECTOR => 2.0, _ => 1.0 };
                let ok = if k == F_BULKHEAD { v.fract() == 0.0 } else if plume { v == 0.0 || v == 0.5 || (v >= 1.0 && v.fract() == 0.0) } else { v >= 0.0 && (v / step).fract() == 0.0 };
                if !ok { return BAD_AMOUNT; }
                self.draft.t[k] = v;
                OK
            }
            CMD_DRAFT_FROM => {
                let f = if a == 1 { self.stock_fit(self.base()) } else { let mut f = [0.0; MAX_FIT]; f.copy_from_slice(&self.fit.t); f };
                self.draft.t.copy_from_slice(&f);
                OK
            }
            _ => {
                let d = self.draft.t.clone();
                let r = self.fit_problem(&d);
                if r != OK { return r; }
                let cost = self.refit_cost(&self.fit.t, &d);
                if cost > self.credits() as f64 { return NO_CREDITS; }
                let (old, base) = (self.stats(self.base(), &self.fit.t, 0.0, 0.0), self.base());
                let new = self.stats(base, &d, 0.0, 0.0);
                self.game.credits[0] = (self.credits() as f64 - cost).clamp(0.0, u32::MAX as f64) as u32;
                // fuel past the new tank is bought back at the port's price; armour added comes sound
                if self.game.fuel[0] > new.fuel {
                    let back = (self.game.fuel[0] - new.fuel) * self.bodies.fuel_price[at] as f64;
                    self.game.fuel[0] = new.fuel;
                    self.game.credits[0] = self.credits().saturating_add(back.floor() as u32);
                }
                if let Some(i) = self.player_slot() { self.ships.hull[i] = (self.ships.hull[i] + (new.hull - old.hull).max(0.0)).min(new.hull); }
                self.fit.t.copy_from_slice(&d);
                self.charge_up();
                self.fit_tick();
                OK
            }
        }
    }

    /// Write fit `which` (0 the ship's, 1 the draft) into `fitview` for the page: its stats, its price, the refit's
    /// cost from the ship's fit and what stands in its way.
    pub fn view_fit(&mut self, which: u32) {
        if !self.fitted() { self.fitview.fill(0.0); return; }
        let f = if which == 1 { self.draft.t.clone() } else { self.fit.t.clone() };
        let (k, t) = (self.base(), &self.types);
        let c = self.cargo_by_class();
        let aboard = c[0] + c[1] + c[2];
        let s0 = self.stats(k, &f, 0.0, f[F_TANK] * self.p(P::tank_fuel));
        let now = self.stats(k, &f, aboard, self.game.fuel[0].min(s0.fuel));
        let full = self.stats(k, &f, s0.hopper + s0.rack + s0.climate, s0.fuel);
        let p = |q: P| self.p(q);
        let q = p(P::furnace_waste) * s0.mw + (p(P::torch_heat) + p(P::burn_heat)) * s0.thrust;
        let burn_secs = if s0.shed <= 0.0 { if q > 0.0 { s0.heat_cap / q } else { -1.0 } } else if q <= s0.shed { -1.0 } else { s0.heat_cap / s0.shed * (q / (q - s0.shed)).ln() };
        let mut v = [0.0; N_STATS];
        v[S_MASS] = now.mass; v[S_MASS_EMPTY] = s0.mass; v[S_MASS_FULL] = full.mass; v[S_THRUST] = s0.thrust;
        v[S_ACCEL] = s0.accel; v[S_ACCEL_FULL] = full.accel; v[S_TURN] = s0.turn; v[S_VMAX] = t.vmax[k];
        v[S_P_USED] = s0.p_used; v[S_P_SPACE] = s0.p_space; v[S_U_USED] = s0.u_used; v[S_U_SPACE] = s0.u_space;
        v[S_BULK_MAX] = (p(P::bulkhead_max) * (t.bay_p[k] + t.bay_u[k])).floor();
        v[S_MW] = s0.mw; v[S_MW_LIFE] = s0.mw_life;
        v[S_MW_DRIVE] = p(P::torch_mw) * s0.thrust + p(P::jet_mw) * s0.jets;
        v[S_MW_REGEN] = p(P::defl_mw) * f[F_DEFLECTOR]; v[S_MW_BURN] = p(P::burn_mw) * s0.thrust;
        v[S_BATTERY] = s0.battery; v[S_SHIELD] = s0.shield; v[S_REGEN] = s0.regen; v[S_HULL] = s0.hull;
        v[S_ARMOUR_CAP] = (t.structure[k] / p(P::armour_pts)).floor(); v[S_FUEL] = s0.fuel;
        v[S_HOPPER] = s0.hopper; v[S_RACK] = s0.rack; v[S_CLIMATE] = s0.climate;
        v[S_HEAT_CAP] = s0.heat_cap; v[S_SHED] = s0.shed; v[S_BURN_SECS] = burn_secs; v[S_JUMP] = s0.jump;
        v[S_CREW] = f[F_BUNKS]; v[S_CREW_MIN] = t.crew[k] as f64; v[S_PLUMES] = t.plumes[k] as f64; v[S_TORCH_CAP] = self.torch_cap(k);
        v[S_VALUE] = self.fit_value(&f); v[S_COST] = self.refit_cost(&self.fit.t, &f);
        v[S_PROBLEM] = self.fit_problem(&f) as f64; v[S_ROOM] = aboard;
        self.fitview.copy_from_slice(&v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::CMD_BUY;
    use crate::player::{IN_ASSIST, IN_BURN, IN_THRUST};
    use crate::port::{BODY_PLANET, CMD_LAUNCH, MODE_FLYING};
    use crate::service::{SVC_OUTFIT, SVC_REFUEL};
    use crate::world::Config;

    const FOOD: usize = 0;
    const ORE: usize = 2;
    const GOODS: usize = 8;

    /// The Ironhull Copperhaul as the catalog makes it (class II x the Ironhulls' style x their civilian line), on
    /// the class II frame, as type 0 (type 1, the last, is the player's fitted ship); a port at the origin with an
    /// outfitter, trading food, ore and consumer goods; the player landed there in it, stock-fitted.
    fn copperhaul() -> Box<World> {
        let mut w = World::new(Config { max_ships: 2, max_types: 2, max_bodies: 1, env_n: 4, env_w: 1000.0 }, 1);
        let (st, civ) = ((0.8, 0.8, 0.85, 1.4, 0.6), (0.85, 0.85, 0.9, 0.9, 0.6));
        let t = &mut w.types;
        (t.accel[0], t.turn[0], t.vmax[0], t.well[0], t.len[0]) = (85.0 * st.0 * civ.0, 2.3 * st.1 * civ.1, 488.0 * st.2 * civ.2, 0.45, 34.0);
        (t.hull[0], t.structure[0], t.shield[0], t.cargo[0], t.fuel[0]) = (170.0 * st.3 * civ.3, 170.0 * st.3 * civ.3, 220.0 * st.4 * civ.4, 30, 4.0);
        (t.frame[0], t.bay_p[0], t.bay_u[0], t.plumes[0], t.crew[0], t.sensors[0]) = (170.0, 39.0, 52.0, 2, 2, 2.0);
        w.goods.class[FOOD] = CLASS_CLIMATE; w.goods.class[GOODS] = CLASS_GENERAL;
        w.n_bodies = 1;
        (w.bodies.r[0], w.bodies.kind[0], w.bodies.port[0], w.bodies.svc[0], w.bodies.fuel_price[0]) = (500.0, BODY_PLANET, 1, SVC_OUTFIT | SVC_REFUEL, 50);
        for (g, price) in [(FOOD, 30), (ORE, 40), (GOODS, 100)] { w.market.price[g] = price; }
        (w.count, w.ships.alive[0], w.game.player[0], w.game.credits[0]) = (1, 1, 0, 100_000);
        w.fit_stock();
        w.place_landed(0);
        w
    }
    fn run(w: &mut World, secs: f64) { for _ in 0..(secs / DT).round() as usize { w.step(); } }
    fn draft(w: &mut World, k: usize, t: f64) -> i32 { w.command(CMD_DRAFT, k as i32, (t * 2.0) as i32) }

    #[test]
    fn the_stock_copperhaul_is_the_catalogs() {
        let w = copperhaul();
        let f = &w.fit.t;
        assert_eq!((f[F_PLUME], f[F_PLUME + 1], f[F_PLUME + 2]), (7.0, 7.0, 0.0), "two 7 t torches");
        assert_eq!((f[F_FURNACE], f[F_BUNKS], f[F_SENSORS], f[F_HOPPER], f[F_RACK], f[F_CLIMATE]), (10.0, 3.0, 2.0, 15.0, 15.0, 0.0));
        assert_eq!((f[F_BANKS], f[F_TANK], f[F_ARMOUR], f[F_BULKHEAD]), (3.0, 5.0, 0.0, 0.0));
        let pk = w.player_kind();
        assert_eq!(w.ships.kind[0] as usize, pk);
        let t = &w.types;
        assert!((t.accel[pk] / t.accel[0] - 1.0).abs() < 0.06, "accel {} vs the catalog's {}", t.accel[pk], t.accel[0]);
        assert!(t.turn[pk] >= t.turn[0] && t.turn[pk] < t.turn[0] * 1.2, "turn {} vs {}", t.turn[pk], t.turn[0]);
        assert_eq!((t.cargo[pk], t.hull[pk], t.fuel[pk], t.vmax[pk]), (30, t.hull[0], 4.0, t.vmax[0]));
        let s = w.stats(0, f, 0.0, 4.0);
        assert!(s.p_used <= s.p_space && s.u_used <= s.u_space, "it fits its bay: {s:?}");
        assert!(s.mass > 220.0 && s.mass < 250.0, "{}", s.mass);
        assert_eq!((w.game.shield[0], w.game.energy[0], w.fuel(), w.hull()), (90.0, 120.0, 4.0, t.hull[0]));
    }

    #[test]
    fn cargo_weighs() {
        let mut w = copperhaul();
        w.step();
        let empty = w.types.accel[w.player_kind()];
        assert_eq!(w.command(CMD_BUY, ORE as i32, 30), OK);
        w.step();
        let full = w.types.accel[w.player_kind()];
        assert!(full < empty * 0.92 && full > empty * 0.85, "{full} vs {empty}");
    }

    #[test]
    fn food_needs_a_climate_hold_and_goods_a_rack() {
        let mut w = copperhaul();
        assert_eq!(w.command(CMD_BUY, FOOD as i32, 1), NEEDS_CLIMATE);
        assert_eq!(w.room_for(GOODS), 15);
        assert_eq!(w.command(CMD_BUY, GOODS as i32, 16), NO_ROOM); // the racks hold 15
        assert_eq!(w.command(CMD_BUY, ORE as i32, 20), OK); // ore in the hoppers, then the racks
        assert_eq!(w.room_for(GOODS), 10);
        // refit: the racks out for a climate hold (pressurised: the bulkhead moves to make room), then food fits
        assert_eq!(draft(&mut w, F_RACK, 0.0), OK);
        assert_eq!(w.fit_problem(&w.draft.t.clone()), CARGO_WONT_FIT, "20 t of ore won't fit 15 t of hoppers");
        assert_eq!(draft(&mut w, F_RACK, 5.0), OK);
        assert_eq!(draft(&mut w, F_CLIMATE, 10.0), OK);
        assert_eq!(w.fit_problem(&w.draft.t.clone()), NO_BAY_ROOM, "the pressurised bay is too small");
        assert_eq!(draft(&mut w, F_BULKHEAD, 4.0), OK);
        assert_eq!(w.command(CMD_REFIT, 0, 0), OK);
        assert_eq!(w.command(CMD_BUY, FOOD as i32, 10), OK);
        assert_eq!(w.command(CMD_BUY, FOOD as i32, 1), NO_ROOM);
    }

    #[test]
    fn refits_cost_and_the_hull_has_limits() {
        let mut w = copperhaul();
        let cr = w.credits();
        // 7 + 7 to 8 + 8: two new torches, the old two bought back at 60%
        assert_eq!(draft(&mut w, F_PLUME, 8.0), OK);
        assert_eq!(draft(&mut w, F_PLUME + 1, 8.0), OK);
        let expect = (2.0f64 * 12.0 * (512.0 - 0.6 * 343.0)).round() as u32;
        assert_eq!(w.command(CMD_REFIT, 0, 0), OK);
        assert_eq!(cr - w.credits(), expect);
        assert_eq!(w.torch_cap(0), 20.0, "1.4 times the stock 14 t");
        assert_eq!(draft(&mut w, F_PLUME, 13.0), OK);
        assert_eq!(w.command(CMD_REFIT, 0, 0), OVER_LIMIT, "13 + 8 t: past the Copperhaul's 20 t");
        assert_eq!(draft(&mut w, F_PLUME, 12.0), OK);
        assert_eq!(w.view_fit(1), ());
        assert_eq!(w.fitview[S_PROBLEM], 0.0, "12 + 8: mixed, and within it");
        assert_eq!(draft(&mut w, F_PLUME, 8.0), OK);
        assert_eq!(draft(&mut w, F_PLUME + 2, 1.0), OK);
        assert_eq!(w.command(CMD_REFIT, 0, 0), OVER_LIMIT, "it has two plumes");
        assert_eq!(draft(&mut w, F_PLUME + 2, 0.0), OK);
        assert_eq!(draft(&mut w, F_FURNACE, 7.0), BAD_AMOUNT, "reactors come in 5 t");
        assert_eq!(draft(&mut w, F_FURNACE, 25.0), OK);
        assert_eq!(w.command(CMD_REFIT, 0, 0), NO_BAY_ROOM);
        assert_eq!(w.command(CMD_DRAFT_FROM, 1, 0), OK);
        assert_eq!(w.draft.t[F_PLUME], 7.0, "the stock fit again");
        w.game.credits[0] = 0;
        assert_eq!(w.command(CMD_REFIT, 0, 0), NO_CREDITS, "a torch changed is a new torch: 7 t back from 8 t costs");
        // a smaller hold, though, is money back
        assert_eq!(w.command(CMD_DRAFT_FROM, 0, 0), OK);
        assert_eq!(draft(&mut w, F_HOPPER, 5.0), OK);
        assert_eq!(w.command(CMD_REFIT, 0, 0), OK);
        assert_eq!(w.credits(), 240);
    }

    #[test]
    fn armour_adds_hull_and_mass() {
        let mut w = copperhaul();
        let (hull0, accel0) = (w.hull(), { w.step(); w.types.accel[w.player_kind()] });
        assert_eq!(draft(&mut w, F_ARMOUR, 20.0), OK);
        assert_eq!(w.command(CMD_REFIT, 0, 0), OK);
        w.step();
        assert_eq!(w.hull(), hull0 + 100.0);
        assert!(w.types.accel[w.player_kind()] < accel0 * 0.93);
        assert_eq!(draft(&mut w, F_ARMOUR, 50.0), OK);
        assert_eq!(w.command(CMD_REFIT, 0, 0), OVER_LIMIT, "armour up to the structure's worth");
    }

    #[test]
    fn the_outfitter_is_a_port_service() {
        let mut w = copperhaul();
        w.bodies.svc[0] = SVC_REFUEL;
        assert_eq!(draft(&mut w, F_FINS, 6.0), NO_SERVICE);
        assert_eq!(w.command(CMD_REFIT, 0, 0), NO_SERVICE);
    }

    #[test]
    fn crew_and_the_jump_drive() {
        let mut w = copperhaul();
        assert_eq!(w.drive_ok(), OK);
        assert_eq!(draft(&mut w, F_BUNKS, 1.0), OK);
        assert_eq!(draft(&mut w, F_JUMP, 3.0), OK);
        assert_eq!(w.command(CMD_REFIT, 0, 0), OK);
        assert_eq!(w.command(CMD_LAUNCH, 0, 0), NO_CREW, "the Copperhaul needs two crew");
        assert_eq!(w.drive_ok(), NO_DRIVE, "3 t of drive jumps 120 t");
    }

    #[test]
    fn no_reactor_runs_on_the_battery_then_browns_out() {
        let mut w = copperhaul();
        assert_eq!(draft(&mut w, F_FURNACE, 0.0), OK);
        assert_eq!(w.command(CMD_REFIT, 0, 0), OK);
        assert_eq!(w.command(CMD_LAUNCH, 0, 0), OK, "it may launch with no reactor");
        run(&mut w, 4.0);
        assert_eq!(w.mode(), MODE_FLYING);
        w.game.input[0] = IN_ASSIST | IN_THRUST;
        run(&mut w, 10.0);
        assert!(w.game.energy[0] < 120.0 && w.game.drive[0] == 1.0, "on the battery: {} MJ", w.game.energy[0]);
        run(&mut w, 120.0);
        assert!(w.game.energy[0] < 1e-6 && w.game.drive[0] < 0.01, "flat: {} MJ, drive {}", w.game.energy[0], w.game.drive[0]);
        assert!(w.types.accel[w.player_kind()] < 1.0);
    }

    #[test]
    fn the_burner_heats_the_ship_to_lockout() {
        let mut w = copperhaul();
        w.command(CMD_LAUNCH, 0, 0);
        run(&mut w, 4.0);
        w.ships.x[0] = -50_000.0; // clear space
        w.game.input[0] = IN_ASSIST | IN_THRUST | IN_BURN;
        let mut t = 0.0;
        while w.game.hot[0] == 0 && t < 60.0 { w.step(); t += DT; }
        assert!(t > 9.0 && t < 20.0, "locked after {t} s of burner");
        assert!(w.game.energy[0] < 120.0, "the burner ran the battery down: {}", w.game.energy[0]);
        w.game.input[0] = IN_ASSIST;
        let mut t = 0.0;
        while w.game.hot[0] == 1 && t < 60.0 { w.step(); t += DT; }
        assert!(t > 4.0 && t < 15.0, "unlocked after {t} s");
    }

    #[test]
    fn shields_soak_radiation_and_collapse() {
        let mut w = copperhaul();
        w.command(CMD_LAUNCH, 0, 0);
        run(&mut w, 4.0);
        // a hazard zone round the port: 2% of the hull a second at the middle
        (w.bodies.hazard[0], w.bodies.rad[0]) = (6000.0, 0.02);
        (w.ships.x[0], w.ships.y[0], w.ships.vx[0], w.ships.vy[0]) = (0.0, 0.0, 0.0, 0.0);
        let hull = w.hull();
        run(&mut w, 1.0);
        assert_eq!(w.hull(), hull, "the shield takes it");
        assert!(w.game.shield[0] < 90.0);
        run(&mut w, 30.0);
        assert!(w.hull() < hull, "collapsed, the hull takes it: {} {}", w.hull(), w.game.shield[0]);
        assert!(w.game.shield_t[0] > 0.0 || w.game.shield[0] < 90.0);
        // out of it: the shield restarts and fills
        (w.bodies.hazard[0], w.bodies.rad[0]) = (0.0, 0.0);
        run(&mut w, 30.0);
        assert!((w.game.shield[0] - 90.0).abs() < 1e-6, "{}", w.game.shield[0]);
    }

    #[test]
    fn running_cold_drops_the_shield() {
        let mut w = copperhaul();
        w.command(CMD_LAUNCH, 0, 0);
        run(&mut w, 4.0);
        w.game.cold[0] = 1;
        w.step();
        assert_eq!(w.game.shield[0], 0.0);
        w.game.cold[0] = 0;
        run(&mut w, 3.0);
        assert_eq!(w.game.shield[0], 0.0, "restarting");
        run(&mut w, 30.0);
        assert_eq!(w.game.shield[0], 90.0);
    }

    #[test]
    fn the_view_shows_the_draft() {
        let mut w = copperhaul();
        w.view_fit(0);
        assert_eq!((w.fitview[S_SHIELD], w.fitview[S_HOPPER], w.fitview[S_COST], w.fitview[S_PROBLEM]), (90.0, 15.0, 0.0, 0.0));
        assert!(w.fitview[S_BURN_SECS] > 9.0 && w.fitview[S_BURN_SECS] < 20.0, "{}", w.fitview[S_BURN_SECS]);
        draft(&mut w, F_BANKS, 5.0);
        w.view_fit(1);
        assert_eq!((w.fitview[S_SHIELD], w.fitview[S_COST]), (150.0, 700.0));
    }

    #[test]
    fn saves_keep_the_fit() {
        let mut w = copperhaul();
        draft(&mut w, F_FINS, 6.0);
        w.command(CMD_REFIT, 0, 0);
        w.save();
        let bytes = w.snapshot().to_vec();
        let b = World::from_snapshot(&bytes).unwrap();
        assert_eq!((b.fit.t[F_FINS], b.fitted(), b.hash()), (6.0, true, w.hash()));
    }
}
