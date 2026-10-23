//! The world: every column group, the clock, and the tick pipeline.

use crate::atlas::{AtlasBodies, AtlasGates, AtlasHead, AtlasMarket, AtlasMix, AtlasSys, MAX_SYSTEMS, NO_SYSTEM};
use crate::jump::{Gates, MAX_GATES};
use crate::cols::{params, soa, ColumnDesc};
use crate::combat::{Arms, AtlasSides, Battle, Bursts, Mounts, Outline, Shells, Sides, Turrets, ATLAS_SIDES, MAX_BURSTS, MAX_MOUNTS, MAX_OUTLINE, MAX_SHELLS, MAX_SIDES};
use crate::missile::{Missiles, MAX_MISSILES};
use crate::fit::{MAX_FIT, N_STATS, SLOT_NAMES, STAT_NAMES};
use crate::flight;
use crate::market::MAX_GOODS;
use crate::mission::{MAX_MISSIONS, MAX_OFFERS};
use crate::orbit::Orbit;
use crate::traffic::{MAX_MIX, MAX_PTS, N_JUMP, N_ROLES};
use crate::player;
use crate::port::{DESCENT_S, LAUNCH_S};
use crate::snapshot;
use crate::math::{sin_cos, wrap, PI};
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
        // hull points left (service.rs): radiation in a hazard zone wears it down; at zero the ship is lost
        hull: f64,
        // sensors (sensors.rs): the signature it emits; the player's smoothed SNR on it and its own on the player; the
        // player's scan of it, 0 to 1 (1 scanned)
        sig: f64, det: f64, seen: f64, scan: f64,
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
    /// affect the hull (0 not at all; fighters about .35, capital ships about .75); `cargo` is the hold, in tons;
    /// `hull` the hull's points when sound; `fuel` the tank, in tons (service.rs).
    /// The frame (fit.rs; docs/outfitting.md), content too: its mass (t), its bay's pressurised and unpressurised
    /// tonnes, its plumes (torch mounts), its structure (hull points before armour), its minimum crew, and the stock
    /// fit's sensors (t) and shield (points). The last row is the player's fitted ship, written by the core from the
    /// fit (fit.rs `player_kind`).
    /// Its geometry (combat.rs), content too: its light turret sites (`guns`; the sites in `mounts`), its outline's
    /// vertex count (the vertices in `outline`), the radius that holds it, and how far out its shield stands from the
    /// hull, metres (the shield shader's edge, src/gen.js shieldStandoff). The missiles its bays carry (missile.rs; the
    /// loadout's `missiles`), stock.
    pub struct Types {
        accel: f64, turn: f64, vmax: f64, well: f64, cargo: u32, hull: f64, fuel: f64, len: f64,
        frame: f64, bay_p: f64, bay_u: f64, plumes: u8, structure: f64, crew: u8, sensors: f64, shield: f64,
        guns: u8, outline: u8, rad: f64, standoff: f64, missiles: u16,
    }
}

soa! {
    /// Bodies (the stars, planets, moons, stations): position, radius, well strength g (relative to the g_ref param),
    /// population weight (traffic flows: 0 for no one), kind (port.rs BODY_*), and whether it has a port to land at.
    /// An environmental station (no port, round a world) has env, its mix group plus one (traffic.rs MIX_ENV rows),
    /// and launches ships at env_rate a second (next at env_next), env_jump of them to or from a jump zone.
    /// `reach`: how far its well reaches, in radii (0: the well_reach param; compact stars reach much further).
    /// A hazard zone (service.rs; the exotic stars') is `hazard` metres round it, where radiation wears a hull down by
    /// up to `rad` of its sound points a second, most at the centre. A port's services (service.rs SVC_* bits) and
    /// its fuel price, credits a ton. A star's `out`, its radiation output (sensors.rs: 1 a yellow dwarf's), and `flares`,
    /// how prone it is to flares (0 never).
    /// Its orbit (motion.rs): `orb_r` metres from body `orb_p` (-1: none) at `orb_a` radians at time 0, turning
    /// `orb_w` radians a second (0: it holds still); its velocity, and its previous-tick and render positions.
    pub struct Bodies {
        x: f64, y: f64, r: f64, g: f64, pop: f64, kind: u8, port: u8, env: u8, env_rate: f64, env_next: f64, env_jump: f64,
        reach: f64, hazard: f64, rad: f64, svc: u8, fuel_price: u32, out: f64, flares: f64,
        orb_p: i16, orb_r: f64, orb_a: f64, orb_w: f64, vx: f64, vy: f64, prev_x: f64, prev_y: f64, rx: f64, ry: f64,
    }
}

soa! {
    /// The player's game state, one row: mode (port.rs MODE_*), the body landed at or heading for, the time left in
    /// a descent or launch sequence, the strategic day, the player's credits and debt to the lender, and the fly-to
    /// autopilot's target body plus one (0: off; player.rs) and the point it is steering for (a waypoint round an
    /// obstacle, or the target).
    /// The landing and launch sequences curl round the port's body: `curl` 0 counter-clockwise, 1 clockwise (port.rs);
    /// a launch hands the ship back moving along the unit vector (hand_x, hand_y) at hand_v m/s, written when it starts
    /// (port.rs `launch_velocity`), so the page draws the sequence toward the velocity the core will give.
    /// The player (player.rs): the ship slot flown (-1 for none: the Fly tab drives its player from JS), the assist
    /// set speed (m/s), and the buttons held this tick. `system`: the atlas system being played (atlas.rs). `fuel`:
    /// tons in the tank (service.rs). (fvx, fvy): the velocity full assist holds the set speed relative to, a moving
    /// port's as the ship nears it (player.rs `frame`), written each tick.
    pub struct Game {
        mode: u8, at: i16, timer: f64, curl: u8, day: u32, credits: u32, debt: u32, auto: i16, aim_x: f64, aim_y: f64,
        hand_x: f64, hand_y: f64, hand_v: f64, player: i32, set: f64, input: u32, system: u8, fuel: f64, fvx: f64, fvy: f64,
        // a jump (jump.rs): its phase, the gate it leaves by, the phase's seconds, the speed the torch began at, the
        // lane's fuel and how much is burnt, a chain asked for in transit (a gate, or -1 none, -2 missed), the system
        // it left; and the day's fraction the lanes' days carry
        jump: u8, jgate: i16, jt: f64, jv0: f64, jcost: f64, jburnt: f64, jchain: i16, jfrom: u32, day_part: f64,
        // heat (service.rs): 0 cold to 1 full, and whether the burner is locked until it cools
        heat: f64, hot: u8,
        // the assist's throttle (player.rs): 0 to 1 of the top speed where the ship is
        throttle: f64,
        // sensors (sensors.rs): running cold; the active ping (its level, decaying from 1 as it goes out, and the
        // cooldown left); the ship the player targets (its handle plus one, 0 none; exact in an f64), which a scan needs
        cold: u8, ping: f64, ping_cd: f64, target: f64,
        // stellar flares (sensors.rs): phase (0 quiet, 1 warning, 2 flaring), seconds into it, when the next is due
        // (game seconds; 0 not drawn yet), the flaring star, and the flare's level now (0 to 1)
        flare: u8, flare_t: f64, flare_due: f64, flare_star: i16, flare_lvl: f64,
        // the fit (fit.rs): whether the player's ship is fitted (its type the last row, built from `fit`), the catalog
        // type it is built on; its shield's points and the seconds left in a collapsed shield's restart; the battery
        // (MJ); the share of the helm's and drive's power met last tick (a brownout below 1), and the power drawn (MW)
        fitted: u8, base: u16, shield: f64, shield_t: f64, energy: f64, drive: f64, mw_use: f64,
    }
}

soa! {
    /// A ship's fit (fit.rs, docs/outfitting.md): tonnes of each component in its slot (fit.rs F_*; bunks a count, the
    /// bulkhead signed). The player's ship has one, `fit`, and the outfitter's draft beside it, `draft`.
    pub struct Fit { t: f64 }
}

soa! {
    /// Each commodity's hold (content: economy.json's `hold`; fit.rs CLASS_*): bulk goes in hoppers, general cargo in
    /// container racks, climate cargo (food, medicine) only in a climate hold; every hold takes the classes below it.
    pub struct Goods { class: u8 }
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
    /// The player's missions, MAX_MISSIONS rows: state (mission.rs M_*), where from and to (bodies of system `sys`),
    /// the cargo, the pay, and the last day it may be delivered.
    pub struct Missions { state: u8, sys: u8, from: i16, dest: i16, good: u8, tons: u32, pay: u32, due: u32 }
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
    /// Each traffic ship's route points, MAX_PTS a slot (slot * MAX_PTS + point): start, waypoints, end; `s` is the
    /// distance along the route to the point, so a ship's place on it is a lookup from its current leg.
    pub struct Route { x: f64, y: f64, s: f64 }
}

soa! {
    /// The traffic mix (content: the system file's traffic, written by the page), MAX_MIX rows: stream (MIX_LOCAL,
    /// MIX_THROUGH, MIX_LOITER; 0 an empty row), the ship type, and a weight (local and through: its share of the
    /// stream; loiter: ships it keeps in flight round `body`). Loiter rows also carry their planned launch rate and
    /// dwell, and the time (seconds of game time) of their next launch (traffic.rs).
    pub struct Mix { stream: u8, body: i16, kind: u16, weight: f64, rate: f64, dwell: f64, next: f64 }
}

soa! {
    /// Local traffic lanes, per directed route between ports and role ((from * max_bodies + to) * N_ROLES + role):
    /// launch rate (ships a second), dwell (seconds a ship spends on the route), and the time (seconds of game time)
    /// of the next launch, drawn as a Poisson process's exponential gaps. Planned at a new game (traffic.rs).
    pub struct Lanes { rate: f64, dwell: f64, next: f64 }
}

soa! {
    /// Through traffic lanes, per jump zone and port, arriving (zone to port) and departing (port to zone):
    /// ((dir * N_JUMP + zone) * max_bodies + body): rate, dwell and next, as for Lanes.
    pub struct JLanes { rate: f64, dwell: f64, next: f64 }
}

soa! {
    /// Nebula gas on a square grid centred on the origin, row-major, three species.
    pub struct Env { h: f32, d: f32, i: f32 }
}

params! {
    rev = 0.5;            "reverse thrust as a fraction of main"
    rcs = 0.3;            "lateral thrust as a fraction of main"
    burn_accel = 2.5;     "burner thrust multiplier (the burner adds acceleration, not top speed)"
    burn_cap = 1.0;       "burner speed cap multiplier (1: the burner keeps the hull's top speed)"
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
    cruise_max = 3.0;     "in open space (outside every well) top speed rises, at most to this multiple of the hull's"
    cruise_brake = 1.0;   "the open-space top speed is what this share of the hull's thrust brakes to top speed by the nearest well's edge"
    cruise_bleed = 1.0;   "inertial damper rate above the speed limit in open space, per second (fast: speed follows the open-space ceiling down)"
    throttle_secs = 1.0;  "seconds holding W (or S) sweeps the assist's throttle from stop to full (a quick tap moves it about a tenth)"
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
    traffic_cap = 90.0;   "most ambient ships in flight at once"
    share_through = 0.45; "through traffic's share of traffic_ships (arriving at and leaving by the jump zones)"
    share_shuttle = 0.3;  "shuttles' share of the local traffic"
    share_hauler = 0.5;   "haulers' share of the local traffic"
    share_liner = 0.2;    "liners' share of the local traffic"
    traffic_cruise = 0.7; "ambient ships cruise at this fraction of their top speed"
    traffic_near = 8000.0; "within this many metres of the player, ambient ships fly full physics; beyond, rails"
    jump_radius = 45000.0; "distance from the star of the jump zones (the middle of each lane's runway; jump.rs)"
    jump_spread = 2500.0; "traffic arrives and leaves anywhere within this many metres of a jump zone's middle"
    zone_len = 12000.0;   "a jump zone's runway: its length along the lane's bearing, metres, centred on the jump radius"
    zone_width = 6000.0;  "a jump zone's runway: its width across the bearing, metres"
    jump_align = 20.0;    "a jump wants the ship moving within this many degrees of the zone's bearing"
    jump_min = 0.5;       "and at this share of its top speed or more"
    jump_speed = 6.0;     "the torch takes the ship to this multiple of its top speed, where it blinks out; it arrives at it"
    torch_accel = 2.0;    "the torch's acceleration, in the hull's top speeds a second"
    jump_fuel = 0.05;     "a jump's fuel, as a share of the hull's tank per light year of lane (a 10 ly lane: half a tank)"
    transit_secs = 4.0;   "seconds between systems, out of the sim (the page plays the trip on the galaxy map)"
    chain_window = 0.8;   "the last seconds of a transit in which J chains on to the course's next lane"
    chain_cost = 1.0;     "a chained jump's fuel, as a multiple of the lane's"
    chain_coast = 0.6;    "seconds a chained arrival coasts in the next zone before it blinks out again"
    arrive_secs = 3.0;    "seconds an arrival takes to slow from jump speed to top speed"
    loiter_orbit = 3.0;   "loitering ships circle their port at this many body radii"
    loiter_turns = 1.25;  "mean number of turns a loitering ship flies round its port before landing"
    loiter_cruise = 0.45; "loitering ships fly at this fraction of their top speed"
    env_trip = 90.0;      "a typical environmental station trip, seconds (seeds the ships already under way at a new game)"
    heat_burn = 15.0;     "seconds of burner that take a cold ship to full heat, where the burner locks"
    heat_cool = 10.0;     "seconds a ship takes to cool from full heat to cold, not burning, in clear space"
    heat_gas = 4.0;       "gas speeds cooling: the rate times 1 + this times the gas density round the ship"
    heat_unlock = 0.5;    "a locked burner unlocks once heat is down to this share"
    heat_rad = 1.0;       "radiation's heat: a dose (share of a sound hull lost a second) adds this times it in heat a second"
    sens_k = 100.0;       "sensor constant: SNR = this x signature / range (km)^2 x gas transmission / local noise"
    sig_idle = 0.15;      "signature terms, times hull length over 18 m to the 1.2: idle"
    sig_thrust = 0.6;     "signature: engines, times the engine glow"
    sig_burn = 1.6;       "signature: the burner lit"
    sig_lat = 0.1;        "signature: side thrusters, times their command"
    sig_heat = 0.6;       "signature: the player's heat, times it"
    sig_ping = 8.0;       "signature: an active ping, times its level"
    sig_cold = 0.35;      "running cold multiplies the player's signature by this"
    contact_snr = 1.0;    "SNR at which a ship is a contact (position, with an error radius)"
    ident_snr = 3.0;      "SNR at which a contact is identified (class and faction)"
    scan_range = 5000.0;  "an identified target within this many metres is scanned"
    scan_secs = 2.2;      "seconds a scan takes"
    det_rise = 4.0;       "the player's sensors settle on a stronger signal at this rate a second"
    det_fall = 1.5;       "and lose a weaker one at this rate"
    seen_rise = 3.0;      "other ships' sensors settle on the player at this rate a second"
    seen_fall = 0.35;     "and forget slowly (they remember where they last saw you)"
    ping_gain = 5.0;      "an active ping multiplies sensor gain by 1 + this, times its level"
    ping_decay = 0.25;    "a ping's level falls this much a second"
    ping_cool = 6.0;      "seconds before the next ping"
    noise_rad = 0.35;     "local sensor noise: 1 + this x stellar radiation + noise_ion x ionized gas"
    noise_ion = 0.6;      "local sensor noise from ionized gas"
    flare_min = 70.0;     "a flare comes every flare_min to flare_min + flare_span seconds, divided by the star's flares"
    flare_span = 50.0;    "the spread of the time between flares, seconds"
    flare_warn = 8.0;     "seconds of warning before a flare"
    flare_secs = 9.0;     "seconds a flare lasts (rising over 1.2 s, falling over its last 2)"
    flare_gain = 9.0;     "a flare multiplies its star's radiation by 1 + this at its height"
    heat_star = 0.02;     "stellar radiation's heat: this times the radiation, a second"
    rad_safe = 2.5;       "stellar radiation above this wears an unshielded hull (above every star's own output: only a flare gets there)"
    rad_hull = 0.0018;    "share of a sound hull lost a second per unit of stellar radiation above rad_safe: a full flare in the open costs about a tenth of a hull"
    repair_cost = 2.0;    "credits a hull point costs to repair"
    match_reach = 4.0;    "full assist and the autopilot match a moving port's velocity within this many of its radii (fading in from there to half as near)"
    // outfitting (fit.rs; docs/outfitting.md): Union gear's ratings per tonne, then prices
    torch_mn = 1.0;       "torch thrust, MN per tonne (MN over tonnes of ship is thousands of m/s^2)"
    torch_room = 1.4;     "a hull's plumes take this many times its stock fit's torch tonnes, in all"
    torch_mw = 0.1;       "torch draw at full thrust, MW per MN"
    torch_heat = 0.25;    "torch heat at full thrust, MW per MN"
    burn_mw = 0.3;        "the burner's extra draw, MW per MN of torch"
    burn_heat = 2.0;      "the burner's extra heat, MW per MN of torch"
    jet_turn = 3450.0;    "turn rate, rad/s: this x jet tonnes / (tonnes of ship x length in metres)"
    jet_mw = 0.25;        "jets' draw while firing, MW per tonne"
    furnace_mw = 0.6;     "reactor output, MW per tonne (3 MW a 5 t step)"
    furnace_waste = 0.1667; "reactor waste heat, MW per MW it produces"
    battery_mj = 40.0;    "battery store, MJ per tonne"
    defl_regen = 1.25;    "deflector regen, shield points a second per tonne"
    defl_mw = 0.5;        "deflector draw while regenerating, MW per tonne"
    defl_hold = 0.05;     "deflector draw holding a full shield, MW per tonne"
    bank_pts = 30.0;      "shield bank capacity, points per tonne"
    shield_rad = 2.0;     "radiation drains a shield this many times faster than it would wear the hull (points per point)"
    shield_heat = 0.25;   "the share of radiation's heat that reaches a shielded hull"
    shield_restart = 6.0; "seconds a collapsed shield (or one dropped to run cold) takes to restart"
    fin_mw = 4.0;         "fin radiators' shedding at full heat, MW per tonne"
    skin_mw = 0.05;       "the hull's own shedding at full heat, MW per tonne of frame"
    sink_mj = 5.0;        "heat sinks' capacity, MJ per tonne"
    heat_mj = 1.0;        "heat capacity, MJ per tonne of ship"
    armour_pts = 5.0;     "armour, hull points per tonne"
    jump_t = 40.0;        "jump drive rating, tonnes of laden ship per tonne of drive"
    sensor_mw = 0.2;      "sensors' draw, MW per tonne"
    sensor_ref = 2.0;     "tonnes of sensors that give the base gain, sens_k (gain goes with tonnes)"
    bunk_t = 2.0;         "a bunk's tonnes"
    bunk_mw = 0.05;       "a bunk's life support, MW"
    avionics_mw = 0.002;  "the bridge and avionics, MW per tonne of frame"
    tank_fuel = 0.8;      "fuel per tonne of tank (the rest of the tonne is the tank)"
    hopper_mass = 0.1;    "a hopper's mass per tonne of hold"
    rack_mass = 0.15;     "a container rack's mass per tonne of hold"
    climate_mass = 0.3;   "a climate hold's mass per tonne of hold"
    bulkhead_max = 0.15;  "the bulkhead moves at most this share of the bay either way"
    bulkhead_mass = 0.2;  "pressure hull and life support, tonnes per tonne of bay pressurised"
    climate_pay = 2.5;    "a delivery of climate cargo (food, medicine) pays this many times as much"
    resale = 0.6;         "the outfitter buys components back at this share of their price"
    price_torch = 12.0;   "a torch's price: this x its tonnes cubed, credits"
    price_jet = 300.0;    "credits a tonne: jets"
    price_furnace = 400.0; "credits a tonne: reactor"
    price_battery = 150.0; "credits a tonne: battery"
    price_deflector = 500.0; "credits a tonne: deflector"
    price_bank = 350.0;   "credits a tonne: shield banks"
    price_fin = 120.0;    "credits a tonne: fin radiators"
    price_sink = 100.0;   "credits a tonne: heat sinks"
    price_armour = 80.0;  "credits a tonne: armour"
    price_jump = 900.0;   "credits a tonne: jump drive"
    price_sensor = 600.0; "credits a tonne: sensors"
    price_bunk = 400.0;   "credits a bunk"
    price_tank = 60.0;    "credits a tonne: fuel tank"
    price_hopper = 40.0;  "credits a tonne: hoppers"
    price_rack = 50.0;    "credits a tonne: container racks"
    price_climate = 250.0; "credits a tonne: climate hold"
    price_bulkhead = 150.0; "credits a tonne the bulkhead moves (labour: nothing back)"
    // weapons (combat.rs; docs/weapons.md): the light multicannon, damage, shields in combat, the combat AI
    mc_rate = 10.0;       "light multicannon: shells a second, each gun"
    mc_speed = 1200.0;    "light multicannon: muzzle speed, m/s (a shell keeps its ship's velocity too)"
    mc_fuse = 0.6;        "light multicannon: the longest fuse, seconds (its reach: speed x fuse)"
    mc_spread = 0.045;    "light multicannon: the most a shell strays from the barrel, radians (triangular)"
    mc_jitter = 0.06;     "every multicannon: a shell's muzzle speed and fuse each vary by up to this share, either way"
    mm_rate = 3.0;        "medium multicannon (57 mm): shells a second"
    mm_speed = 1500.0;    "medium multicannon: muzzle speed, m/s"
    mm_fuse = 0.95;       "medium multicannon: the longest fuse, seconds"
    mm_spread = 0.03;     "medium multicannon: the most a shell strays, radians"
    mm_blast = 22.0;      "medium multicannon: a burst's reach, metres"
    mm_core = 7.0;        "medium multicannon: full damage inside this many metres"
    mm_dmg = 6.0;         "medium multicannon: a shell's damage"
    mm_traverse = 2.0;    "medium multicannon: turret traverse, rad/s"
    mm_mj = 0.15;         "medium multicannon: energy a shell, MJ"
    mm_heat = 0.4;        "medium multicannon: heat a shell, MJ"
    mm_rounds = 60.0;     "rounds of 57 mm a tonne of magazine"
    mm_t = 8.0;           "a medium multicannon's tonnes"
    price_mm = 14000.0;   "credits a medium multicannon"
    ml_rate = 0.8;        "heavy multicannon (120 mm): shells a second"
    ml_speed = 1800.0;    "heavy multicannon: muzzle speed, m/s"
    ml_fuse = 1.25;       "heavy multicannon: the longest fuse, seconds"
    ml_spread = 0.018;    "heavy multicannon: the most a shell strays, radians"
    ml_blast = 40.0;      "heavy multicannon: a burst's reach, metres"
    ml_core = 12.0;       "heavy multicannon: full damage inside this many metres"
    ml_dmg = 35.0;        "heavy multicannon: a shell's damage"
    ml_traverse = 0.9;    "heavy multicannon: turret traverse, rad/s"
    ml_mj = 1.0;          "heavy multicannon: energy a shell, MJ"
    ml_heat = 2.5;        "heavy multicannon: heat a shell, MJ"
    ml_rounds = 8.0;      "rounds of 120 mm a tonne of magazine"
    ml_t = 30.0;          "a heavy multicannon's tonnes"
    price_ml = 60000.0;   "credits a heavy multicannon"
    mc_blast = 12.0;      "light multicannon: a burst's reach, metres"
    mc_core = 4.0;        "light multicannon: full damage inside this many metres of a burst"
    mc_dmg = 1.0;         "light multicannon: a shell's damage"
    mc_traverse = 4.0;    "light multicannon: turret traverse, rad/s"
    mc_mj = 0.02;         "light multicannon: energy a shell, MJ"
    mc_heat = 0.05;       "light multicannon: heat a shell, MJ"
    mc_rounds = 400.0;    "rounds of 30 mm a tonne of magazine (the magazine holds every calibre: a round takes 1 / rounds of a tonne)"
    mc_t = 2.0;           "a light multicannon's tonnes (unpressurised)"
    price_mc = 3000.0;    "credits a light multicannon"
    price_magazine = 150.0; "credits a tonne: magazine (rounds included)"
    shield_hard = 3.0;    "shield hardness on a 100 m hull (going with length to the 1.5): a hit no harder does only hard_frac"
    hard_frac = 0.1;      "share of a hit at or under the shield's hardness that the shield takes"
    bleed_kin = 0.1;      "share of a kinetic hit that reaches the hull while the shield holds"
    shield_pause = 1.0;   "seconds a hit stops a shield regenerating"
    shield_refill = 20.0; "seconds a ship's shield (but the player's, fit.rs) takes to fill from empty"
    morale = 0.3;         "a fighter flees under this share of its hull"
    ai_think = 0.5;       "seconds between a fighter's looks round"
    ai_range = 0.7;       "a fighter closes to this share of its guns' reach, then circles"
    ai_cruise = 0.8;      "a fighter flies at this share of its top speed"
    ai_orbit = 3.0;       "with no enemy in sight, fighters circle the contested body at this many radii (at most half of ai_leash above it)"
    ai_leash = 4000.0;    "fighters take on only enemies within this many metres of the contested body's surface (the player anywhere it shoots them)"
    side_gap = 0.5;       "seconds between a lab side's arrivals"
    side_drop = 3500.0;   "a lab side's ships come out of their jump this many metres short of the contested body, along their route (0: at their zone)"
    // missiles (missile.rs; docs/weapons.md)
    ms_accel = 150.0;     "missile: the motor's thrust, m/s^2"
    ms_burn = 12.0;       "missile: seconds the motor burns"
    ms_life = 20.0;       "missile: seconds from launch until it destroys itself"
    ms_turn = 3.0;        "missile: turn rate, rad/s"
    ms_nav = 3.5;         "missile: proportional navigation's constant (acceleration across the line of sight per unit of closing speed times its turn rate)"
    ms_eject = 0.4;       "missile: seconds out of the bay before the motor lights"
    ms_eject_v = 30.0;    "missile: speed it leaves the bay at, m/s, on top of its ship's velocity"
    ms_seek = 1.0;        "missile: its seeker's gain, times the sensors' (sens_k): it holds the target while it makes a contact"
    ms_well = 0.35;       "missile: how strongly gravity wells pull it (a ship type's `well`)"
    ms_dmg = 60.0;        "missile: the warhead's damage"
    ms_blast = 30.0;      "missile: the warhead's reach, metres"
    ms_core = 8.0;        "missile: full damage inside this many metres"
    ms_prox = 6.0;        "missile: the proximity fuse bursts it within this many metres of a hostile ship's shield"
    ms_hp = 8.0;          "missile: damage that destroys it (eight light shells)"
    ms_rad = 3.0;         "missile: its size to shells, a circle this many metres round"
    ms_pd_near = 200.0;   "point defence: light guns fire on missiles homing on their ship, or another side's within this many metres of it"
    ms_range = 8000.0;    "missile: a wave's ships launch at a target within this many metres"
    ms_reload = 4.0;      "missile: seconds a ship's bays take to load again after a volley"
    ms_wave_min = 4.0;    "missile: ships of a side on the same target that make a wave"
    ms_wave_max = 24.0;   "missile: a wave takes ships until it has this many missiles; the rest go for the next target"
    ms_wave_gap = 4.0;    "missile: seconds after a side's wave before its next (about a reload, so the next goes together)"
    ms_tot_slack = 1.0;   "missile: a wave is to arrive this many seconds after its farthest missile could (room for every missile to make it)"
    ms_worthy = 50.0;     "missile: the shortest hull worth missiles, metres (class III up)"
    ms_lone = 100.0;      "missile: a ship without a wave fires alone at a hull this long or more (class IV up)"
    ms_patience = 8.0;    "missile: seconds a ship holds its missiles waiting for a wave before it fires alone"
    ms_retarget = 3000.0; "missile: one whose target is gone takes the nearest enemy its seeker holds within this many metres"
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
    /// the player's fit and the outfitter's draft (fit.rs), and each commodity's hold class (content)
    pub fit: Fit,
    pub draft: Fit,
    /// combat (combat.rs): types' sites and outlines, each ship's arms and turrets, shells, bursts, the fight, the
    /// lab's sides (and the atlas's copy of them)
    pub mounts: Mounts,
    pub outline: Outline,
    pub arms: Arms,
    pub turrets: Turrets,
    pub shells: Shells,
    /// missiles in flight (missile.rs)
    pub missiles: Missiles,
    pub bursts: Bursts,
    pub battle: Battle,
    pub sides: Sides,
    pub atlas_sides: AtlasSides,
    pub goods: Goods,
    /// the outfitter's view of a fit (fit.rs `view_fit`, `view_stock`): its stats, and a stock fit, for the page; not state
    pub fitview: Vec<f64>,
    pub fitstock: Vec<f64>,
    /// combat's tally (combat.rs `damage`), for tuning: damage done by weapon (W_*) to ships of each class (I to V),
    /// shield then hull ((weapon * 5 + class) * 2 + 0 or 1); not state, outside the snapshot and the hash, zeroed by `clear`
    pub tally: Vec<f64>,
    /// the weapon whose blast is being dealt (W_*), for the tally: scratch
    pub(crate) tally_w: u8,
    pub market: Market,
    pub offers: Offers,
    pub missions: Missions,
    pub traffic: Traffic,
    pub route: Route,
    pub mix: Mix,
    pub lanes: Lanes,
    pub jlanes: JLanes,
    /// the live system's lanes (jump.rs)
    pub gates: Gates,
    /// the layouts of the systems this game has been to (atlas.rs)
    pub atlas_head: AtlasHead,
    pub atlas_sys: AtlasSys,
    pub atlas_bodies: AtlasBodies,
    pub atlas_market: AtlasMarket,
    pub atlas_mix: AtlasMix,
    pub atlas_gates: AtlasGates,
    pub params: Vec<f64>,
    /// live ship slots are 0..count
    pub count: usize,
    pub n_bodies: usize,
    pub tick: u64,
    pub rng: Rng,
    acc: f64,
    /// every state column, in manifest and snapshot order (cached: computing it allocates)
    pub(crate) cols: Vec<ColumnDesc>,
    /// snapshot buffer, sized for this config at creation (see snapshot.rs)
    pub(crate) snap: Vec<u8>,
    /// one atlas slot's row as bytes, for the page to log and a replay to put back (atlas.rs); sized at creation
    pub atlas_row: Vec<u8>,
    /// orbiting debris and traffic: looks only, outside the snapshot and the hash (orbit.rs)
    pub orbit: Orbit,
    /// the ships by where they are, for shells' hits: scratch, rebuilt each tick, outside the snapshot (grid.rs)
    pub(crate) grid: crate::grid::Grid,
    /// the missiles by where they are, for shells and point defence: scratch, as `grid`
    pub(crate) mgrid: crate::grid::Grid,
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
            fit: Fit::with_capacity(MAX_FIT),
            draft: Fit::with_capacity(MAX_FIT),
            mounts: Mounts::with_capacity(cfg.max_types * MAX_MOUNTS),
            outline: Outline::with_capacity(cfg.max_types * MAX_OUTLINE),
            arms: Arms::with_capacity(cfg.max_ships),
            turrets: Turrets::with_capacity(cfg.max_ships * MAX_MOUNTS),
            shells: Shells::with_capacity(MAX_SHELLS),
            missiles: Missiles::with_capacity(MAX_MISSILES),
            bursts: Bursts::with_capacity(MAX_BURSTS),
            battle: Battle::with_capacity(1),
            sides: Sides::with_capacity(MAX_SIDES),
            atlas_sides: AtlasSides::with_capacity(ATLAS_SIDES),
            goods: Goods::with_capacity(MAX_GOODS),
            fitview: vec![0.0; N_STATS],
            tally: vec![0.0; crate::combat::N_TALLY],
            tally_w: 0,
            fitstock: vec![0.0; MAX_FIT],
            market: Market::with_capacity(cfg.max_bodies * MAX_GOODS),
            offers: Offers::with_capacity(cfg.max_bodies * MAX_OFFERS),
            missions: Missions::with_capacity(MAX_MISSIONS),
            traffic: Traffic::with_capacity(cfg.max_ships),
            route: Route::with_capacity(cfg.max_ships * MAX_PTS),
            mix: Mix::with_capacity(MAX_MIX),
            lanes: Lanes::with_capacity(cfg.max_bodies * cfg.max_bodies * N_ROLES),
            jlanes: JLanes::with_capacity(2 * N_JUMP * cfg.max_bodies),
            atlas_head: AtlasHead::with_capacity(1),
            atlas_sys: AtlasSys::with_capacity(MAX_SYSTEMS),
            atlas_bodies: AtlasBodies::with_capacity(MAX_SYSTEMS * cfg.max_bodies),
            atlas_market: AtlasMarket::with_capacity(MAX_SYSTEMS * cfg.max_bodies * MAX_GOODS),
            atlas_mix: AtlasMix::with_capacity(MAX_SYSTEMS * MAX_MIX),
            gates: Gates::with_capacity(MAX_GATES),
            atlas_gates: AtlasGates::with_capacity(MAX_SYSTEMS * MAX_GATES),
            params: param_defaults(),
            count: 0,
            n_bodies: 0,
            tick: 0,
            rng: Rng::new(seed),
            acc: 0.0,
            cols: Vec::new(),
            snap: Vec::new(),
            atlas_row: Vec::new(),
            orbit: Orbit::new(),
            grid: crate::grid::Grid::new(cfg.max_ships),
            mgrid: crate::grid::Grid::new(MAX_MISSILES),
            manifest: String::new(),
        });
        w.cols = w.columns();
        w.snap = vec![0; snapshot::snapshot_len(&w.cols)];
        w.atlas_row = vec![0; w.atlas_row_len()];
        w.gates.dest.fill(NO_SYSTEM);
        w.atlas_reset();
        w.game.player[0] = -1; // no player until the page sets one
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
        self.fit.describe("fit", &mut c);
        self.draft.describe("draft", &mut c);
        self.mounts.describe("mount", &mut c);
        self.outline.describe("outline", &mut c);
        self.arms.describe("arms", &mut c);
        self.turrets.describe("turret", &mut c);
        self.shells.describe("shell", &mut c);
        self.missiles.describe("missile", &mut c);
        self.bursts.describe("burst", &mut c);
        self.battle.describe("battle", &mut c);
        self.sides.describe("side", &mut c);
        self.atlas_sides.describe("atlas_side", &mut c);
        self.goods.describe("goods", &mut c);
        self.market.describe("market", &mut c);
        self.offers.describe("offer", &mut c);
        self.missions.describe("mission", &mut c);
        self.traffic.describe("traffic", &mut c);
        self.route.describe("route", &mut c);
        self.mix.describe("mix", &mut c);
        self.lanes.describe("lane", &mut c);
        self.jlanes.describe("jlane", &mut c);
        self.gates.describe("gate", &mut c);
        self.atlas_head.describe("atlas", &mut c);
        self.atlas_sys.describe("atlas_sys", &mut c);
        self.atlas_bodies.describe("atlas_body", &mut c);
        self.atlas_market.describe("atlas_market", &mut c);
        self.atlas_mix.describe("atlas_mix", &mut c);
        self.atlas_gates.describe("atlas_gate", &mut c);
        c.push(ColumnDesc::of("world", "params", &self.params));
        c
    }

    /// JSON description of every column (address, element kind, length) plus the config.
    pub fn manifest(&self) -> &str { &self.manifest }

    fn build_manifest(&self) -> String {
        // the snapshot buffer and the orbiters' output are exposed too, but are not state
        let mut extra = vec![ColumnDesc::of("world", "snapshot", &self.snap), ColumnDesc::of("fit", "view", &self.fitview), ColumnDesc::of("fit", "stock", &self.fitstock), ColumnDesc::of("battle", "tally", &self.tally)];
        self.orbit.describe(&mut extra);
        let cols: Vec<String> = self.cols.iter().chain(extra.iter()).map(|c| format!(
            r#"{{"group":"{}","name":"{}","kind":"{}","ptr":{},"len":{}}}"#, c.group, c.name, c.kind, c.ptr, c.len
        )).collect();
        let quote = |l: &[&str]| l.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(",");
        format!(
            r#"{{"dt":{},"maxShips":{},"maxTypes":{},"maxBodies":{},"maxGoods":{},"maxOffers":{},"maxMissions":{},"maxMix":{},"maxMounts":{},"maxOutline":{},"maxShells":{},"maxMissiles":{},"maxBursts":{},"maxSides":{},"launchS":{},"descentS":{},"envN":{},"envW":{},"playerKind":{},"fitSlots":[{}],"fitStats":[{}],"params":[{}],"columns":[{}]}}"#,
            DT, self.cfg.max_ships, self.cfg.max_types, self.cfg.max_bodies, MAX_GOODS, MAX_OFFERS, MAX_MISSIONS, MAX_MIX, MAX_MOUNTS, MAX_OUTLINE, MAX_SHELLS, MAX_MISSILES, MAX_BURSTS, MAX_SIDES, LAUNCH_S, DESCENT_S, self.cfg.env_n, self.cfg.env_w,
            self.player_kind(), quote(&SLOT_NAMES), quote(&STAT_NAMES), quote(PARAM_NAMES), cols.join(",")
        )
    }

    /// Start over: every ship column zeroed, the game row, hold, missions and boards emptied, no live slots, clock at
    /// tick 0, no traffic. Types, bodies, markets, the traffic mix, the atlas, gas, params and the generator are kept (reseed
    /// separately; post boards with `post_boards`, start traffic with `plan_traffic` and `seed_traffic`). Handles from before a clear are invalid.
    pub fn clear(&mut self) {
        self.ships.clear();
        let player = self.game.player[0]; // the slot flown survives a clear; its set speed and input don't
        self.game.clear();
        self.game.player[0] = player;
        self.hold.clear();
        self.fit.clear();
        self.draft.clear();
        self.arms.clear();
        self.turrets.clear();
        self.battle.clear();
        self.clear_fire();
        self.tally.fill(0.0);
        self.sides.next.fill(0.0);
        self.sides.wave.fill(0.0);
        self.sides.wave_ok.fill(0.0);
        self.offers.clear();
        self.missions.clear();
        self.traffic.clear();
        self.route.clear();
        self.lanes.clear();
        self.jlanes.clear();
        self.count = 0;
        self.tick = 0;
        self.reset_clock();
    }

    /// Drop any partial tick owed (after a load or a clear) so the next frame starts clean.
    pub fn reset_clock(&mut self) { self.acc = 0.0; }

    /// Place body j on its orbit: `radius` from body `parent` (place the parent first) at `angle_deg` degrees, with
    /// the core's own trig, so a system lays out bit for bit the same in every browser and natively. It writes the
    /// position and the orbit (still: `body_motion` sets it turning, motion.rs).
    pub fn place_body(&mut self, j: usize, parent: usize, radius: f64, angle_deg: f64) {
        let a = angle_deg * PI / 180.0;
        let (s, c) = sin_cos(a);
        let b = &mut self.bodies;
        b.x[j] = b.x[parent] + c * radius;
        b.y[j] = b.y[parent] + s * radius;
        (b.orb_p[j], b.orb_r[j], b.orb_a[j], b.orb_w[j], b.vx[j], b.vy[j]) = (if parent == j { -1 } else { parent as i16 }, radius, a, 0.0, 0.0, 0.0);
        (b.prev_x[j], b.prev_y[j], b.rx[j], b.ry[j]) = (b.x[j], b.y[j], b.x[j], b.y[j]);
    }

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
    /// bodies (moving stations along their orbits, carrying what is docked at them, motion.rs),
    /// game (descent and launch sequences, see port.rs),
    /// player (this tick's input bitmask into commands, when a player slot is set),
    /// traffic (arrivals, launches and landings, rails, and the AI flying ambient ships near the player),
    /// control (assist turns desired velocity into actuator commands), fields (gas at each ship),
    /// steer (angular motion), forces (thrust, drag, gravity), integrate (velocity, dampers, position),
    /// engines (glow), ships (heat, hazards' radiation, a hull lost; service.rs), sensors (signature, detection, scans,
    /// flares; sensors.rs). Trading and the day's costs are commands, applied between ticks (market.rs). Decide (AI) and the systems after motion still run in JS around this call.
    pub fn step(&mut self) {
        let n = self.count;
        let s = &mut self.ships;
        s.prev_x[..n].copy_from_slice(&s.x[..n]);
        s.prev_y[..n].copy_from_slice(&s.y[..n]);
        s.prev_ang[..n].copy_from_slice(&s.ang[..n]);
        self.move_bodies();
        self.step_game();
        self.step_jump();
        self.fit_tick(); // the player's fitted type from its fit, its load and last tick's power (fit.rs)
        player::control(self);
        self.step_traffic();
        flight::control(self);
        flight::fields(self);
        flight::steer(self);
        flight::forces(self);
        flight::integrate(self);
        flight::engines(self);
        self.step_ships();
        self.step_sensors();
        self.step_combat();
        self.tick += 1;
    }

    /// Write the interpolated render pose (prev -> current at alpha) for every slot and body.
    pub fn interpolate(&mut self) {
        let a = self.alpha();
        let s = &mut self.ships;
        for i in 0..self.count {
            s.rx[i] = (s.prev_x[i] + (s.x[i] - s.prev_x[i]) * a) as f32;
            s.ry[i] = (s.prev_y[i] + (s.y[i] - s.prev_y[i]) * a) as f32;
            s.ra[i] = wrap(s.prev_ang[i] + wrap(s.ang[i] - s.prev_ang[i]) * a) as f32;
        }
        let sh = &mut self.shells;
        for n in 0..MAX_SHELLS {
            if sh.live[n] == 0 { continue; }
            sh.rx[n] = (sh.prev_x[n] + (sh.x[n] - sh.prev_x[n]) * a) as f32;
            sh.ry[n] = (sh.prev_y[n] + (sh.y[n] - sh.prev_y[n]) * a) as f32;
        }
        let ms = &mut self.missiles;
        for n in 0..MAX_MISSILES {
            if ms.live[n] == 0 { continue; }
            ms.rx[n] = (ms.prev_x[n] + (ms.x[n] - ms.prev_x[n]) * a) as f32;
            ms.ry[n] = (ms.prev_y[n] + (ms.y[n] - ms.prev_y[n]) * a) as f32;
            ms.ra[n] = ms.ang[n] as f32;
        }
        let b = &mut self.bodies;
        for j in 0..self.n_bodies {
            b.rx[j] = b.prev_x[j] + (b.x[j] - b.prev_x[j]) * a;
            b.ry[j] = b.prev_y[j] + (b.y[j] - b.prev_y[j]) * a;
        }
    }

    // ---------- slots and handles ----------

    /// Call after (re)spawning a slot or teleporting it: bumps the generation (spawns only) and
    /// snaps the interpolation history so the ship does not streak across the screen.
    pub fn slot_reset(&mut self, i: usize, respawn: bool) {
        let s = &mut self.ships;
        if respawn { s.generation[i] = s.generation[i].wrapping_add(1) & 0xffff; (s.sig[i], s.det[i], s.seen[i], s.scan[i]) = (0.0, 0.0, 0.0, 0.0); }
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
        eat(self.game.set[0].to_bits());
        eat(self.game.player[0] as u32 as u64 | (self.game.input[0] as u64) << 32);
        eat(self.game.mode[0] as u64 | (self.game.at[0] as u16 as u64) << 8 | (self.game.day[0] as u64) << 32);
        eat(self.game.timer[0].to_bits());
        eat(self.game.credits[0] as u64 | (self.game.debt[0] as u64) << 32);
        eat(self.game.auto[0] as u16 as u64 | (self.game.curl[0] as u64) << 16 | (self.game.system[0] as u64) << 24);
        let g = &self.game;
        eat(g.jump[0] as u64 | (g.jgate[0] as u16 as u64) << 8 | (g.jchain[0] as u16 as u64) << 24 | (g.jfrom[0] as u64) << 32);
        for v in [g.jt[0], g.jcost[0], g.jburnt[0], g.day_part[0]] { eat(v.to_bits()); }
        for v in [self.game.hand_x[0], self.game.hand_y[0], self.game.hand_v[0], self.game.fuel[0]] { eat(v.to_bits()); }
        // the fit (fit.rs): the player's power, shield and heat, the fit and the outfitter's draft
        eat(g.fitted[0] as u64 | (g.base[0] as u64) << 8);
        for v in [g.shield[0], g.shield_t[0], g.energy[0], g.drive[0], g.heat[0]] { eat(v.to_bits()); }
        for (&a, &b) in self.fit.t.iter().zip(&self.draft.t) { eat(a.to_bits()); eat(b.to_bits()); }
        // tuning and the system: a live param change or a moved body shows in the hash at once
        for &p in &self.params { eat(p.to_bits()); }
        for j in 0..self.n_bodies { eat(self.bodies.x[j].to_bits()); eat(self.bodies.y[j].to_bits()); eat(self.bodies.r[j].to_bits()); eat(self.bodies.g[j].to_bits()); }
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
        // combat (combat.rs): shells in flight, each ship's arms, the fight
        let sh = &self.shells;
        for n in 0..MAX_SHELLS { if sh.live[n] != 0 { eat(n as u64 | (sh.side[n] as u64) << 16 | (sh.owner[n] as u64) << 32); for v in [sh.x[n], sh.y[n], sh.t[n]] { eat(v.to_bits()); } } }
        eat(self.battle.player_side[0] as u64 | (self.battle.angry[0] as u64) << 8 | (self.battle.burst[0] as u64) << 16);
        for s in 0..MAX_SIDES { eat(self.sides.next[s].to_bits()); eat(self.sides.wave[s].to_bits()); eat(self.sides.wave_ok[s].to_bits()); }
        let ms = &self.missiles;
        for n in 0..MAX_MISSILES { if ms.live[n] != 0 { eat(n as u64 | (ms.side[n] as u64) << 16 | (ms.owner[n] as u64) << 32); eat(ms.target[n] as u64); for v in [ms.x[n], ms.y[n], ms.vx[n], ms.vy[n], ms.ang[n], ms.burn[n], ms.t[n], ms.hp[n], ms.eta[n]] { eat(v.to_bits()); } } }
        let s = &self.ships;
        for i in 0..self.count {
            let a = &self.arms;
            if s.alive[i] != 0 {
                eat(a.side[i] as u64 | (a.guns[i] as u64) << 8 | (a.missiles[i] as u64) << 16 | (a.target[i] as u64) << 32);
                eat(a.wave_tgt[i] as u64);
                for v in [a.shield[i], a.shield_t[i], a.ammo[i], a.think[i], a.reload[i], a.wave_t[i], a.wait[i]] { eat(v.to_bits()); }
            }
            eat(s.alive[i] as u64 | (s.ctl[i] as u64) << 8 | (s.burn[i] as u64) << 16 | (s.kind[i] as u64) << 24 | (s.generation[i] as u64) << 32);
            let t = &self.traffic;
            eat(s.rail[i] as u64 | (t.role[i] as u64) << 8 | (t.phase[i] as u64) << 16 | (t.leg[i] as u64) << 24 | (t.to[i] as u16 as u64) << 32);
            if t.role[i] != 0 { for col in [&t.timer, &t.s, &t.age] { eat(col[i].to_bits()); } }
            if s.alive[i] == 0 { continue; }
            for col in [&s.x, &s.y, &s.vx, &s.vy, &s.ang, &s.av, &s.turn_in, &s.main, &s.lat, &s.thr, &s.gas_h, &s.gas_d, &s.gas_i, &s.hull] {
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
    fn bodies_place_on_their_parents_orbits() {
        let mut w = world();
        w.bodies.x[0] = 100.0;
        w.place_body(1, 0, 50.0, 90.0);
        assert!((w.bodies.x[1] - 100.0).abs() < 1e-9 && (w.bodies.y[1] - 50.0).abs() < 1e-9, "{} {}", w.bodies.x[1], w.bodies.y[1]);
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
