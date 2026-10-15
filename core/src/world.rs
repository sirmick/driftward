//! The world: every column group, the clock, and the tick pipeline.

use crate::cols::{params, soa, ColumnDesc};
use crate::flight;
use crate::market::MAX_GOODS;
use crate::mission::{MAX_MISSIONS, MAX_OFFERS};
use crate::traffic::{MAX_MIX, MAX_PTS, N_JUMP, N_ROLES};
use crate::player::{self, Player};
use crate::snapshot;
use crate::math::wrap;
use crate::rng::Rng;

/// Fixed simulation step: 60 Hz.
pub const DT: f64 = 1.0 / 60.0;
/// Longest real frame the clock will absorb, so a stalled tab does not fast-forward.
const MAX_FRAME: f64 = 0.25;
/// Most ticks one frame may run; past this the backlog is dropped (the sim slows instead of spiralling).
const MAX_TICKS_PER_FRAME: u32 = 8;

soa! {
    /// Ships. A ship is a slot index; `alive` masks dead slots. Slots are stable (no compaction),
    /// so columns the JS side still owns stay parallel; `generation` makes handles detect reuse.
    pub struct Ships {
        // pose and motion
        x: f64, y: f64, vx: f64, vy: f64, ang: f64, av: f64,
        // actuators, -1..1: turn (+ is counter-clockwise), main (+ forward, - reverse), lat (+ right)
        turn_in: f64, main: f64, lat: f64,
        // assist targets, read when ctl > 0: desired velocity and (ctl 2) facing
        want_vx: f64, want_vy: f64, want_face: f64,
        // forces scratch, written by the forces stage
        ax: f64, ay: f64,
        // the gravity well here, written by the forces stage: strength (0 outside every well) and the unit
        // direction into it (see flight.rs)
        well: f64, well_x: f64, well_y: f64,
        // fields gathered at the ship each tick: hydrogen, dust, ionized gas density
        gas_h: f64, gas_d: f64, gas_i: f64,
        // engine glow 0..1, smoothed toward the throttle
        thr: f64,
        // previous-tick pose, for render interpolation
        prev_x: f64, prev_y: f64, prev_ang: f64,
        // interpolated render pose, f32 for direct GPU upload
        rx: f32, ry: f32, ra: f32,
        alive: u8,
        // 1 while traffic.rs moves the ship along its route (on rails, or held for a launch or landing); the flight
        // stages skip it
        rail: u8,
        burn: u8,
        // control mode: 0 raw actuators, 1 assist (auto facing), 2 assist (facing want_face), 3 assist (turn untouched)
        ctl: u8,
        // rotation: 0 rate-controlled (the turn command sets a turn rate; release stops the turn),
        // 1 torque (the turn command is angular acceleration; spin persists until countered)
        rot: u8,
        kind: u16,
        generation: u32,
    }
}

soa! {
    /// Ship types (one per brand x size): flight stats from the catalog. `well` is how strongly gravity wells
    /// affect the hull (0 not at all; fighters about .35, capital ships about .75); `cargo` is the hold, in tons.
    pub struct Types { accel: f64, turn: f64, vmax: f64, well: f64, cargo: u32 }
}

soa! {
    /// Bodies (the star, planets, moons, stations): position, radius, well strength g (relative to the g_ref param),
    /// population weight (traffic flows: 0 for no one), kind (port.rs BODY_*), and whether it has a port to land at.
    pub struct Bodies { x: f64, y: f64, r: f64, g: f64, pop: f64, kind: u8, port: u8 }
}

soa! {
    /// The player's game state, one row: mode (port.rs MODE_*), the body landed at or heading for, the time left in
    /// a descent or launch sequence, the strategic day, the player's credits and debt to the lender, and the fly-to
    /// autopilot's target body plus one (0: off; player.rs) and the point it is steering for (a waypoint round an
    /// obstacle, or the target).
    /// The landing and launch sequences curl round the port's body: `curl` 0 counter-clockwise, 1 clockwise (port.rs).
    pub struct Game { mode: u8, at: i16, timer: f64, curl: u8, day: u32, credits: u32, debt: u32, auto: i16, aim_x: f64, aim_y: f64 }
}

soa! {
    /// The player's cargo hold: tons of each commodity (market.rs MAX_GOODS rows).
    pub struct Hold { tons: u32 }
}

soa! {
    /// Markets: one row per body and commodity (body * MAX_GOODS + commodity), the price in credits per ton;
    /// 0 where the port does not trade it.
    pub struct Market { price: u32 }
}

soa! {
    /// Mission boards: one row per body and offer slot (body * MAX_OFFERS + slot). A haulage offer: deliver `tons`
    /// of commodity `good` to body `dest` within `days` of accepting, for `pay`; it leaves the board after day
    /// `expires`. See mission.rs.
    pub struct Offers { live: u8, dest: i16, good: u8, tons: u32, pay: u32, days: u32, expires: u32 }
}

soa! {
    /// The player's missions, MAX_MISSIONS rows: state (mission.rs M_*), where from and to, the cargo, the pay, and
    /// the last day it may be delivered.
    pub struct Missions { state: u8, from: i16, dest: i16, good: u8, tons: u32, pay: u32, due: u32 }
}

soa! {
    /// Traffic state per ship slot (traffic.rs): role (0: not traffic; LOCAL, ARRIVE, DEPART, LOITER), phase, time
    /// left in a launch or landing, the mix row it was drawn from, the route (from and to: a body, or -1 - z for jump
    /// zone z; its points in `route`, npts of them; its length; the leg being flown), progress along it, cruise speed,
    /// and age.
    pub struct Traffic {
        role: u8, phase: u8, leg: u8, npts: u8, mix: u8, from: i16, to: i16,
        timer: f64, s: f64, len: f64, cruise: f64, age: f64,
    }
}

soa! {
    /// Each traffic ship's route points, MAX_PTS a slot (slot * MAX_PTS + point): start, waypoints, end.
    pub struct Route { x: f64, y: f64 }
}

soa! {
    /// The traffic mix (content: the system file's traffic, written by the page), MAX_MIX rows: stream (MIX_LOCAL,
    /// MIX_THROUGH, MIX_LOITER; 0 an empty row), the ship type, and a weight (local and through: its share of the
    /// stream; loiter: ships it keeps in flight round `body`). Loiter rows also carry their planned launch rate and
    /// dwell (traffic.rs).
    pub struct Mix { stream: u8, body: i16, kind: u16, weight: f64, rate: f64, dwell: f64 }
}

soa! {
    /// Local traffic lanes, per directed route between ports and role ((from * max_bodies + to) * N_ROLES + role):
    /// launch rate (ships a second) and dwell (seconds a ship spends on the route). Planned at a new game (traffic.rs).
    pub struct Lanes { rate: f64, dwell: f64 }
}

soa! {
    /// Through traffic lanes, per jump zone and port, arriving (zone to port) and departing (port to zone):
    /// ((dir * N_JUMP + zone) * max_bodies + body): rate and dwell, as for Lanes.
    pub struct JLanes { rate: f64, dwell: f64 }
}

soa! {
    /// Nebula gas on a square grid centred on the origin, row-major, three species.
    pub struct Env { h: f32, d: f32, i: f32 }
}

params! {
    rev = 0.5;            "reverse thrust as a fraction of main"
    rcs = 0.3;            "lateral thrust as a fraction of main"
    burn_accel = 1.7;     "burner thrust multiplier"
    burn_cap = 1.3;       "burner speed cap multiplier"
    turn_slew = 8.0;      "angular acceleration, in units of the type's turn rate per second"
    lat_cap = 0.6;        "lateral taper cap as a fraction of the speed cap"
    damper = 0.2;         "inertial damper rate above the speed limit, per second (slow, so a slingshot's boost lasts)"
    drag_h = 6e-4;        "drag coefficient of hydrogen"
    drag_d = 3e-3;        "drag coefficient of dust"
    drag_i = 1.5e-3;      "drag coefficient of ionized gas"
    assist_gain = 0.35;   "assist: velocity error (in units of accel) that gives full thrust"
    assist_turn = 3.0;    "assist: turn command per radian of heading error, times turn rate"
    assist_face_dv = 0.6; "assist: face the velocity error when it exceeds this many accels"
    assist_face_v = 0.08; "assist: else face the target velocity when above this fraction of vmax"
    thr_rate = 6.0;       "engine glow response rate, per second"
    well_reach = 3.0;     "a body's well reaches this many radii"
    g_ref = 40.0;         "a body with g = g_ref has a well of strength 1 at its surface"
    pull = 0.6;           "a well's pull at strength 1, as a share of the ship's thrust, times the hull's sensitivity"
    well_in = 1.0;        "top speed heading into a well: raised by this, times strength and sensitivity"
    well_out = 0.6;       "top speed heading out of a well: lowered by this, times strength and sensitivity"
    land_speed = 30.0;    "fastest a ship may be moving to land on a planet or moon, m/s"
    dock_speed = 12.0;    "fastest a ship may be moving to dock at a station, m/s"
    launch_speed = 20.0;  "speed a ship has when a launch from a station hands back control, m/s"
    launch_frac = 1.4;    "a launch from a planet or moon hands back control at this multiple of the hull's top speed"
    dock_fee = 20.0;      "credits a day in port costs the player"
    interest = 0.002;     "the lender's interest on the player's debt, per day"
    offer_chance = 0.35;  "chance a free board slot gets a new offer each day, once the board has its minimum"
    mission_base = 200.0; "a delivery's pay before distance, credits"
    mission_rate = 2.0;   "a delivery's pay per ton per kilometre of route, credits"
    route_day = 20000.0;  "metres of route counted as a day when setting deadlines"
    slack_min = 1.5;      "tightest deadline, as a multiple of route days (pays the most)"
    slack_max = 3.0;      "loosest deadline, as a multiple of route days"
    traffic_ships = 30.0; "ambient ships in flight at steady state, local and through (loiter adds its own)"
    traffic_cap = 60.0;   "most ambient ships in flight at once"
    share_through = 0.45; "through traffic's share of traffic_ships (arriving at and leaving by the jump zones)"
    share_shuttle = 0.3;  "shuttles' share of the local traffic"
    share_hauler = 0.5;   "haulers' share of the local traffic"
    share_liner = 0.2;    "liners' share of the local traffic"
    traffic_cruise = 0.7; "ambient ships cruise at this fraction of their top speed"
    traffic_near = 8000.0; "within this many metres of the player, ambient ships fly full physics; beyond, rails"
    jump_radius = 45000.0; "distance from the star of the four jump zones (north, east, south, west)"
    jump_spread = 2500.0; "radius of a jump zone: ships arrive and leave anywhere within it"
    loiter_orbit = 3.0;   "loitering ships circle their port at this many body radii"
    loiter_turns = 1.25;  "mean number of turns a loitering ship flies round its port before landing"
    loiter_cruise = 0.45; "loitering ships fly at this fraction of their top speed"
}

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub max_ships: usize,
    pub max_types: usize,
    pub max_bodies: usize,
    /// cells per side of the gas grid
    pub env_n: usize,
    /// world width covered by the gas grid, meters
    pub env_w: f64,
}

pub struct World {
    pub cfg: Config,
    pub ships: Ships,
    pub types: Types,
    pub bodies: Bodies,
    pub env: Env,
    pub game: Game,
    pub hold: Hold,
    pub market: Market,
    pub offers: Offers,
    pub missions: Missions,
    pub traffic: Traffic,
    pub route: Route,
    pub mix: Mix,
    pub lanes: Lanes,
    pub jlanes: JLanes,
    pub params: Vec<f64>,
    /// live ship slots are 0..count
    pub count: usize,
    pub n_bodies: usize,
    pub tick: u64,
    pub rng: Rng,
    pub player: Player,
    acc: f64,
    /// every state column, in manifest and snapshot order (cached: computing it allocates)
    pub(crate) cols: Vec<ColumnDesc>,
    /// snapshot buffer, sized for this config at creation (see snapshot.rs)
    pub(crate) snap: Vec<u8>,
    manifest: String,
}

impl World {
    pub fn new(cfg: Config, seed: u64) -> Box<World> {
        let mut w = Box::new(World {
            cfg,
            ships: Ships::with_capacity(cfg.max_ships),
            types: Types::with_capacity(cfg.max_types),
            bodies: Bodies::with_capacity(cfg.max_bodies),
            env: Env::with_capacity(cfg.env_n * cfg.env_n),
            game: Game::with_capacity(1),
            hold: Hold::with_capacity(MAX_GOODS),
            market: Market::with_capacity(cfg.max_bodies * MAX_GOODS),
            offers: Offers::with_capacity(cfg.max_bodies * MAX_OFFERS),
            missions: Missions::with_capacity(MAX_MISSIONS),
            traffic: Traffic::with_capacity(cfg.max_ships),
            route: Route::with_capacity(cfg.max_ships * MAX_PTS),
            mix: Mix::with_capacity(MAX_MIX),
            lanes: Lanes::with_capacity(cfg.max_bodies * cfg.max_bodies * N_ROLES),
            jlanes: JLanes::with_capacity(2 * N_JUMP * cfg.max_bodies),
            params: param_defaults(),
            count: 0,
            n_bodies: 0,
            tick: 0,
            rng: Rng::new(seed),
            player: Player::default(),
            acc: 0.0,
            cols: Vec::new(),
            snap: Vec::new(),
            manifest: String::new(),
        });
        w.cols = w.columns();
        w.snap = vec![0; snapshot::snapshot_len(&w.cols)];
        w.manifest = w.build_manifest();
        w
    }

    pub fn p(&self, k: P) -> f64 { self.params[k as usize] }

    /// Every state column (what the manifest exposes and a snapshot stores).
    pub fn columns(&self) -> Vec<ColumnDesc> {
        let mut c = Vec::new();
        self.ships.describe("ship", &mut c);
        self.types.describe("type", &mut c);
        self.bodies.describe("body", &mut c);
        self.env.describe("env", &mut c);
        self.game.describe("game", &mut c);
        self.hold.describe("hold", &mut c);
        self.market.describe("market", &mut c);
        self.offers.describe("offer", &mut c);
        self.missions.describe("mission", &mut c);
        self.traffic.describe("traffic", &mut c);
        self.route.describe("route", &mut c);
        self.mix.describe("mix", &mut c);
        self.lanes.describe("lane", &mut c);
        self.jlanes.describe("jlane", &mut c);
        c.push(ColumnDesc::of("world", "params", &self.params));
        c
    }

    /// JSON description of every column (address, element kind, length) plus the config.
    pub fn manifest(&self) -> &str { &self.manifest }

    fn build_manifest(&self) -> String {
        let snap = ColumnDesc::of("world", "snapshot", &self.snap);
        let cols: Vec<String> = self.cols.iter().chain(std::iter::once(&snap)).map(|c| format!(
            r#"{{"group":"{}","name":"{}","kind":"{}","ptr":{},"len":{}}}"#, c.group, c.name, c.kind, c.ptr, c.len
        )).collect();
        let names: Vec<String> = PARAM_NAMES.iter().map(|n| format!("\"{n}\"")).collect();
        format!(
            r#"{{"dt":{},"maxShips":{},"maxTypes":{},"maxBodies":{},"maxGoods":{},"maxOffers":{},"maxMissions":{},"envN":{},"envW":{},"params":[{}],"columns":[{}]}}"#,
            DT, self.cfg.max_ships, self.cfg.max_types, self.cfg.max_bodies, MAX_GOODS, MAX_OFFERS, MAX_MISSIONS, self.cfg.env_n, self.cfg.env_w,
            names.join(","), cols.join(",")
        )
    }

    /// Start over: every ship column zeroed, the game row, hold, missions and boards emptied, no live slots, clock at
    /// tick 0, no traffic. Types, bodies, markets, the traffic mix, gas, params and the generator are kept (reseed
    /// separately; post boards with `post_boards`, start traffic with `plan_traffic` and `seed_traffic`). Handles from before a clear are invalid.
    pub fn clear(&mut self) {
        self.ships.clear();
        self.game.clear();
        self.hold.clear();
        self.offers.clear();
        self.missions.clear();
        self.traffic.clear();
        self.route.clear();
        self.lanes.clear();
        self.jlanes.clear();
        self.count = 0;
        self.tick = 0;
        self.player.set = 0.0;
        self.player.input = 0;
        self.reset_clock();
    }

    /// Drop any partial tick owed (after a load or a clear) so the next frame starts clean.
    pub fn reset_clock(&mut self) { self.acc = 0.0; }

    // ---------- clock ----------

    /// Feed real elapsed seconds; returns how many fixed ticks are due now.
    pub fn due(&mut self, real_dt: f64) -> u32 {
        self.acc += real_dt.clamp(0.0, MAX_FRAME);
        let n = (self.acc / DT).floor() as u32;
        let run = n.min(MAX_TICKS_PER_FRAME);
        self.acc -= run as f64 * DT;
        if n > run { self.acc = self.acc.min(DT * 0.999); }
        run
    }

    /// How far the clock is between the last tick and the next, 0..1.
    pub fn alpha(&self) -> f64 { (self.acc / DT).clamp(0.0, 1.0) }

    // ---------- tick pipeline ----------

    /// One fixed step of everything the core owns. Stages, in order:
    /// game (descent and launch sequences, see port.rs),
    /// player (this tick's input bitmask into commands, when a player slot is set),
    /// traffic (arrivals, launches and landings, rails, and the AI flying ambient ships near the player),
    /// control (assist turns desired velocity into actuator commands), fields (gas at each ship),
    /// steer (angular motion), forces (thrust, drag, gravity), integrate (velocity, dampers, position),
    /// engines (glow). Trading and the day's costs are commands, applied between ticks (market.rs). Decide (AI) and the systems after motion still run in JS around this call.
    pub fn step(&mut self) {
        let n = self.count;
        let s = &mut self.ships;
        s.prev_x[..n].copy_from_slice(&s.x[..n]);
        s.prev_y[..n].copy_from_slice(&s.y[..n]);
        s.prev_ang[..n].copy_from_slice(&s.ang[..n]);
        self.step_game();
        player::control(self);
        self.step_traffic();
        flight::control(self);
        flight::fields(self);
        flight::steer(self);
        flight::forces(self);
        flight::integrate(self);
        flight::engines(self);
        self.tick += 1;
    }

    /// Write the interpolated render pose (prev -> current at alpha) for every slot.
    pub fn interpolate(&mut self) {
        let a = self.alpha();
        let s = &mut self.ships;
        for i in 0..self.count {
            s.rx[i] = (s.prev_x[i] + (s.x[i] - s.prev_x[i]) * a) as f32;
            s.ry[i] = (s.prev_y[i] + (s.y[i] - s.prev_y[i]) * a) as f32;
            s.ra[i] = wrap(s.prev_ang[i] + wrap(s.ang[i] - s.prev_ang[i]) * a) as f32;
        }
    }

    // ---------- slots and handles ----------

    /// Call after (re)spawning a slot or teleporting it: bumps the generation (spawns only) and
    /// snaps the interpolation history so the ship does not streak across the screen.
    pub fn slot_reset(&mut self, i: usize, respawn: bool) {
        let s = &mut self.ships;
        if respawn { s.generation[i] = s.generation[i].wrapping_add(1) & 0xffff; }
        s.prev_x[i] = s.x[i];
        s.prev_y[i] = s.y[i];
        s.prev_ang[i] = s.ang[i];
        s.rx[i] = s.x[i] as f32;
        s.ry[i] = s.y[i] as f32;
        s.ra[i] = s.ang[i] as f32;
    }

    /// A handle is slot | generation << 16: it stops resolving once the slot is respawned.
    pub fn handle(&self, i: usize) -> u32 { (i as u32) | (self.ships.generation[i] << 16) }

    pub fn resolve(&self, h: u32) -> Option<usize> {
        let i = (h & 0xffff) as usize;
        (i < self.count && self.ships.generation[i] == h >> 16 && self.ships.alive[i] != 0).then_some(i)
    }

    // ---------- verification ----------

    /// FNV-1a over everything the tick writes, for replay and cross-target checks.
    pub fn hash(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut eat = |v: u64| {
            for b in v.to_le_bytes() { h = (h ^ b as u64).wrapping_mul(0x0100_0000_01b3); }
        };
        eat(self.tick);
        eat(self.count as u64);
        eat(self.player.set.to_bits());
        eat(self.player.slot as u32 as u64 | (self.player.input as u64) << 32);
        eat(self.game.mode[0] as u64 | (self.game.at[0] as u16 as u64) << 8 | (self.game.day[0] as u64) << 32);
        eat(self.game.timer[0].to_bits());
        eat(self.game.credits[0] as u64 | (self.game.debt[0] as u64) << 32);
        eat(self.game.auto[0] as u16 as u64 | (self.game.curl[0] as u64) << 16);
        for &t in &self.hold.tons { eat(t as u64); }
        for &p in &self.market.price[..self.n_bodies * MAX_GOODS] { eat(p as u64); }
        let f = &self.offers;
        for o in 0..self.n_bodies * MAX_OFFERS {
            if f.live[o] == 0 { continue; }
            eat(o as u64 | (f.dest[o] as u16 as u64) << 16 | (f.good[o] as u64) << 32 | (f.days[o] as u64) << 40);
            eat(f.tons[o] as u64 | (f.pay[o] as u64) << 32);
            eat(f.expires[o] as u64);
        }
        let m = &self.missions;
        for k in 0..MAX_MISSIONS {
            eat(m.state[k] as u64 | (m.from[k] as u16 as u64) << 8 | (m.dest[k] as u16 as u64) << 24 | (m.good[k] as u64) << 40);
            eat(m.tons[k] as u64 | (m.pay[k] as u64) << 32);
            eat(m.due[k] as u64);
        }
        let s = &self.ships;
        for i in 0..self.count {
            eat(s.alive[i] as u64 | (s.ctl[i] as u64) << 8 | (s.burn[i] as u64) << 16 | (s.kind[i] as u64) << 24 | (s.generation[i] as u64) << 32);
            let t = &self.traffic;
            eat(s.rail[i] as u64 | (t.role[i] as u64) << 8 | (t.phase[i] as u64) << 16 | (t.leg[i] as u64) << 24 | (t.to[i] as u16 as u64) << 32);
            if t.role[i] != 0 { for col in [&t.timer, &t.s, &t.age] { eat(col[i].to_bits()); } }
            if s.alive[i] == 0 { continue; }
            for col in [&s.x, &s.y, &s.vx, &s.vy, &s.ang, &s.av, &s.turn_in, &s.main, &s.lat, &s.thr, &s.gas_h, &s.gas_d, &s.gas_i] {
                eat(col[i].to_bits());
            }
        }
        h
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world() -> Box<World> {
        World::new(Config { max_ships: 8, max_types: 2, max_bodies: 2, env_n: 8, env_w: 1000.0 }, 1)
    }

    #[test]
    fn clock_runs_fixed_ticks() {
        let mut w = world();
        let ticks: u32 = (0..120).map(|_| w.due(1.0 / 144.0)).sum();
        assert!((49..=50).contains(&ticks), "{ticks}");
        assert_eq!(w.due(10.0), MAX_TICKS_PER_FRAME); // a stall runs the cap, then drops the backlog
        assert!(w.alpha() < 1.0);
        assert_eq!(w.due(0.0), 0);
    }

    #[test]
    fn clear_restarts_the_world() {
        let mut w = world();
        w.count = 3;
        w.ships.alive[1] = 1;
        w.ships.x[1] = 5.0;
        w.step();
        w.clear();
        assert_eq!((w.count, w.tick, w.ships.x[1], w.ships.alive[1]), (0, 0, 0.0, 0));
        assert_eq!(w.hash(), world().hash());
    }

    #[test]
    fn handles_detect_reuse() {
        let mut w = world();
        w.count = 2;
        w.ships.alive[1] = 1;
        w.slot_reset(1, true);
        let h = w.handle(1);
        assert_eq!(w.resolve(h), Some(1));
        w.slot_reset(1, true);
        assert_eq!(w.resolve(h), None);
        assert_eq!(w.resolve(w.handle(1)), Some(1));
        w.ships.alive[1] = 0;
        assert_eq!(w.resolve(w.handle(1)), None);
    }

    #[test]
    fn interpolation_takes_the_short_way_round() {
        let mut w = world();
        w.count = 1;
        w.ships.prev_ang[0] = 3.0;
        w.ships.ang[0] = -3.0; // 0.28 rad apart across the wrap
        w.ships.prev_x[0] = 0.0;
        w.ships.x[0] = 10.0;
        w.acc = DT * 0.5;
        w.interpolate();
        assert!((w.ships.rx[0] - 5.0).abs() < 1e-5);
        assert!(w.ships.ra[0].abs() > 3.1, "{}", w.ships.ra[0]);
    }

    #[test]
    fn manifest_lists_every_column() {
        let w = world();
        let m = w.manifest();
        for c in w.columns() {
            assert!(m.contains(&format!(r#""group":"{}","name":"{}","kind":"{}","ptr":{},"len":{}"#, c.group, c.name, c.kind, c.ptr, c.len)));
            assert!(c.ptr != 0);
        }
        assert!(m.contains(r#""params":["rev","rcs""#));
        assert_eq!(w.params.len(), PARAM_NAMES.len());
    }
}
