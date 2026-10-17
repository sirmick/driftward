//! Sensors, signature and the stellar radiation field (the Book's Signature and detection, and Radiation: M0 items,
//! ported from the lab's frozen prototype, src/fly.js, into the core, so they save and replay).
//!
//! Signature: every ship emits one each tick, its hull length (over 18 m) to the 1.2 times what it is doing: idle,
//! the engines' glow, the burner, the side thrusters; the player's adds heat and an active ping, and running cold
//! (`game.cold`) cuts it to about a third.
//!
//! Detection: SNR = `sens_k` x signature / range (km)^2 x gas transmission along the line / local noise at the
//! listener (1 plus stellar radiation and ionized gas). The player's SNR on every ship (`ships.det`) and every ship's
//! on the player (`ships.seen`) settle toward the instant value, quickly on a stronger signal and slowly on a weaker
//! one; ships remember the player longest. Levels: `contact_snr` a contact (a position with an error radius),
//! `ident_snr` identified (class and faction); the player's target (`game.target`, a command), identified and within
//! `scan_range`, is scanned over `scan_secs` (`ships.scan`; leaving range or the target breaks an unfinished scan).
//! An active ping (`CMD_PING`) multiplies the player's sensor gain while it lasts, and its signature with it; it has
//! a cooldown.
//!
//! Stellar radiation: each star's output (`bodies.out`), dimmed in the shadow corridor behind every planet and moon,
//! raised by a flare on it, plus ionized gas. It raises sensor noise and heats the player's ship (service.rs); above
//! `rad_safe` (only a flare gets there) it wears unshielded hulls (`rad_hull`: a full flare in the open costs about a
//! tenth of a hull, a planet's shadow nothing; M2's shields will soak it first). Flares: a system's most flare-prone
//! star flares every so often (`flare_min` and `flare_span` over its `flares`), after `flare_warn` seconds of warning,
//! for `flare_secs`; the shelter is a planet's shadow.

use crate::math::{exp, hypot, ln};
use crate::port::{BODY_MOON, BODY_PLANET, BODY_STAR, MODE_FLYING, OK, WRONG_MODE};
use crate::world::{World, DT, P};

/// Run cold (a = 1) or not (a = 0).
pub const CMD_COLD: u32 = 14;
/// An active ping.
pub const CMD_PING: u32 = 15;
/// Target ship handle `a` (its bits), or none with b = -1.
pub const CMD_TARGET: u32 = 16;
/// Debug control plane: a flare's warning starts now.
pub const CMD_FLARE: u32 = 103;

/// The ping's cooldown has not run out.
pub const COOLING: i32 = 21;
/// The sensors don't hold that ship.
pub const NOT_HELD: i32 = 22;

/// Hull length the signature is measured against (a class I hull), metres.
const REF_LEN: f64 = 18.0;
/// Ionized gas's share of stellar radiation (the lab's).
const ION_RAD: f64 = 0.8;

fn smooth(e0: f64, e1: f64, x: f64) -> f64 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

impl World {
    /// How lit (x, y) is by star j: 1 in the open, 0 in the shadow corridor behind a planet or moon (away from the star).
    pub fn lit(&self, j: usize, x: f64, y: f64) -> f64 {
        let b = &self.bodies;
        let mut lit: f64 = 1.0;
        for p in 0..self.n_bodies {
            if b.kind[p] != BODY_PLANET && b.kind[p] != BODY_MOON { continue; }
            let (ux, uy) = (b.x[p] - b.x[j], b.y[p] - b.y[j]);
            let l = hypot(ux, uy);
            if l < 1e-6 { continue; }
            let (ux, uy) = (ux / l, uy / l);
            let (qx, qy) = (x - b.x[p], y - b.y[p]);
            let along = qx * ux + qy * uy;
            if along > 0.0 { lit = lit.min(smooth(b.r[p] * 0.92, b.r[p] * 1.04, hypot(qx - along * ux, qy - along * uy))); }
        }
        lit
    }

    /// Stellar radiation at (x, y), with ionized gas `ion` there: each star's output, dimmed in shadows, times a flare's
    /// gain on its star.
    pub fn stellar(&self, x: f64, y: f64, ion: f64) -> f64 {
        let b = &self.bodies;
        let (flaring, star, lvl, gain) = (self.game.flare[0] == 2, self.game.flare_star[0], self.game.flare_lvl[0], self.p(P::flare_gain));
        let mut rad = ION_RAD * ion;
        for j in 0..self.n_bodies {
            if b.kind[j] != BODY_STAR || b.out[j] <= 0.0 { continue; }
            let k = if flaring && star as usize == j { 1.0 + gain * lvl } else { 1.0 };
            rad += b.out[j] * k * self.lit(j, x, y);
        }
        rad
    }

    /// Sensor noise at (x, y), with ionized gas `ion` there.
    pub fn noise(&self, x: f64, y: f64, ion: f64) -> f64 {
        1.0 + self.p(P::noise_rad) * self.stellar(x, y, ion) + self.p(P::noise_ion) * ion
    }

    /// The gas at (x, y): hydrogen, dust, ionized (bilinear on the grid; none off it).
    pub(crate) fn gas_at(&self, x: f64, y: f64) -> (f64, f64, f64) {
        let n = self.cfg.env_n;
        let half = self.cfg.env_w / 2.0;
        let cell = self.cfg.env_w / n as f64;
        let (fx, fy) = ((x + half) / cell - 0.5, (y + half) / cell - 0.5);
        let (i0, j0) = (fx.floor(), fy.floor());
        if i0 < 0.0 || j0 < 0.0 || i0 >= (n - 1) as f64 || j0 >= (n - 1) as f64 { return (0.0, 0.0, 0.0); }
        let (tx, ty) = (fx - i0, fy - j0);
        let k = j0 as usize * n + i0 as usize;
        let (w00, w10, w01, w11) = ((1.0 - tx) * (1.0 - ty), tx * (1.0 - ty), (1.0 - tx) * ty, tx * ty);
        let e = &self.env;
        let at = |g: &[f32]| g[k] as f64 * w00 + g[k + 1] as f64 * w10 + g[k + n] as f64 * w01 + g[k + n + 1] as f64 * w11;
        (at(&e.h), at(&e.d), at(&e.i))
    }

    /// The share of a signal that gets through the gas between two points (dust most of all).
    fn transmission(&self, x0: f64, y0: f64, x1: f64, y1: f64) -> f64 {
        let d = hypot(x1 - x0, y1 - y0);
        let n = (2.0 + (d / 1200.0).ceil()).min(12.0);
        let ds = d / 1000.0 / n;
        let mut tau = 0.0;
        for k in 0..n as usize {
            let f = (k as f64 + 0.5) / n;
            let (h, du, i) = self.gas_at(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
            tau += (0.25 * h + 1.7 * du + 0.5 * i) * ds;
        }
        exp(-tau)
    }

    /// The player's slot while it flies, if it does.
    fn flying_player(&self) -> Option<usize> {
        usize::try_from(self.game.player[0]).ok().filter(|&i| i < self.count && self.ships.alive[i] != 0 && self.mode() == MODE_FLYING)
    }

    /// The ship the player targets, if it still exists.
    pub fn target_ship(&self) -> Option<usize> {
        let t = self.game.target[0];
        if t < 1.0 { return None; }
        self.resolve((t - 1.0) as u32)
    }

    /// Cold, ping and target (`CMD_COLD`, `CMD_PING`, `CMD_TARGET`) and the debug flare.
    pub(crate) fn sensor_command(&mut self, code: u32, a: i32, b: i32) -> i32 {
        if code == CMD_FLARE {
            if self.game.flare[0] != 0 { return WRONG_MODE; }
            return if self.start_flare() { OK } else { WRONG_MODE };
        }
        if self.flying_player().is_none() { return WRONG_MODE; }
        match code {
            CMD_COLD => { self.game.cold[0] = (a != 0) as u8; OK }
            CMD_PING => {
                if self.game.ping_cd[0] > 0.0 { return COOLING; }
                (self.game.ping[0], self.game.ping_cd[0]) = (1.0, self.p(P::ping_cool));
                OK
            }
            CMD_TARGET => {
                if b < 0 { self.game.target[0] = 0.0; return OK; }
                let h = a as u32;
                match self.resolve(h) {
                    Some(i) if Some(i) != self.flying_player() && self.ships.det[i] >= self.p(P::contact_snr) => {
                        self.game.target[0] = h as f64 + 1.0;
                        OK
                    }
                    _ => NOT_HELD,
                }
            }
            _ => crate::port::UNKNOWN_COMMAND,
        }
    }

    /// The most flare-prone star (0 for none), and its prone-ness.
    fn flare_star(&self) -> (usize, f64) {
        let b = &self.bodies;
        (0..self.n_bodies).filter(|&j| b.kind[j] == BODY_STAR).fold((0, 0.0), |m, j| if b.flares[j] > m.1 { (j, b.flares[j]) } else { m })
    }

    /// A flare's warning begins, on the most flare-prone star; false if no star flares.
    fn start_flare(&mut self) -> bool {
        let (j, prone) = self.flare_star();
        if prone <= 0.0 { return false; }
        let g = &mut self.game;
        (g.flare[0], g.flare_t[0], g.flare_star[0], g.flare_lvl[0]) = (1, 0.0, j as i16, 0.0);
        true
    }

    /// The flare clock: quiet until the next is due, then the warning, then the flare.
    fn step_flare(&mut self) {
        let now = self.tick as f64 * DT;
        let (j, prone) = self.flare_star();
        let valid = |w: &World| { let s = w.game.flare_star[0]; s >= 0 && (s as usize) < w.n_bodies && w.bodies.kind[s as usize] == BODY_STAR };
        if prone <= 0.0 || (self.game.flare[0] != 0 && !valid(self)) { // no star flares here (or the last system's flare is gone)
            let g = &mut self.game;
            (g.flare[0], g.flare_t[0], g.flare_lvl[0], g.flare_due[0]) = (0, 0.0, 0.0, 0.0);
            return;
        }
        let _ = j;
        match self.game.flare[0] {
            0 => {
                if self.game.flare_due[0] <= 0.0 {
                    let gap = self.rng.range(self.p(P::flare_min), self.p(P::flare_min) + self.p(P::flare_span)) / prone;
                    self.game.flare_due[0] = now + gap;
                } else if now >= self.game.flare_due[0] { self.start_flare(); }
            }
            1 => {
                self.game.flare_t[0] += DT;
                if self.game.flare_t[0] >= self.p(P::flare_warn) { (self.game.flare[0], self.game.flare_t[0]) = (2, 0.0); }
            }
            _ => {
                let secs = self.p(P::flare_secs);
                let t = self.game.flare_t[0] + DT;
                self.game.flare_t[0] = t;
                self.game.flare_lvl[0] = smooth(0.0, 1.2, t) * (1.0 - smooth(secs - 2.0, secs, t));
                if t >= secs {
                    let g = &mut self.game;
                    (g.flare[0], g.flare_t[0], g.flare_lvl[0], g.flare_due[0]) = (0, 0.0, 0.0, 0.0); // the next drawn next tick
                }
            }
        }
    }

    /// The sensors stage, after motion: the ping, the flare clock, every ship's signature, then the player's sensors on
    /// every ship and every ship's on the player, and the scan of the player's target.
    pub(crate) fn step_sensors(&mut self) {
        (self.game.ping[0], self.game.ping_cd[0]) = ((self.game.ping[0] - self.p(P::ping_decay) * DT).max(0.0), (self.game.ping_cd[0] - DT).max(0.0));
        self.step_flare();
        let player = self.flying_player();
        let (idle, thrust, burnk, latk) = (self.p(P::sig_idle), self.p(P::sig_thrust), self.p(P::sig_burn), self.p(P::sig_lat));
        let (heatk, pingk, coldk) = (self.p(P::sig_heat), self.p(P::sig_ping), self.p(P::sig_cold));
        for i in 0..self.count {
            let s = &self.ships;
            if s.alive[i] == 0 { self.ships.sig[i] = 0.0; continue; }
            let len = self.types.len[s.kind[i] as usize].max(1.0);
            let size = exp(1.2 * ln(len / REF_LEN));
            let burn = s.burn[i] != 0 && s.main[i] > 0.0;
            let mut e = idle + thrust * s.thr[i] + if burn { burnk } else { 0.0 } + latk * s.lat[i].abs();
            if Some(i) == player {
                e += heatk * self.game.heat[0] + pingk * self.game.ping[0];
                if self.game.cold[0] != 0 { e *= coldk; }
            }
            self.ships.sig[i] = size * e;
        }
        let Some(p) = player else {
            // landed, in a sequence, between systems or lost: nothing held; it builds again after launch
            for i in 0..self.count { let s = &mut self.ships; (s.det[i], s.seen[i]) = (0.0, 0.0); if s.scan[i] < 1.0 { s.scan[i] = 0.0; } }
            self.game.target[0] = 0.0;
            return;
        };
        let (k, gain) = (self.p(P::sens_k), 1.0 + self.p(P::ping_gain) * self.game.ping[0]);
        let (px, py) = (self.ships.x[p], self.ships.y[p]);
        let n_me = self.noise(px, py, self.ships.gas_i[p]);
        let (d_rise, d_fall, s_rise, s_fall) = (self.p(P::det_rise) * DT, self.p(P::det_fall) * DT, self.p(P::seen_rise) * DT, self.p(P::seen_fall) * DT);
        let (ident, range, scan_dt, contact) = (self.p(P::ident_snr), self.p(P::scan_range), DT / self.p(P::scan_secs).max(DT), self.p(P::contact_snr));
        let target = self.target_ship();
        for i in 0..self.count {
            if i == p { continue; }
            if self.ships.alive[i] == 0 { let s = &mut self.ships; (s.det[i], s.seen[i]) = (0.0, 0.0); continue; }
            let (x, y) = (self.ships.x[i], self.ships.y[i]);
            let d = hypot(x - px, y - py);
            let r2 = d * d / 1e6 + 0.04;
            let n_them = self.noise(x, y, self.gas_at(x, y).2);
            let (me, them) = (k * self.ships.sig[i] * gain / r2 / n_me, k * self.ships.sig[p] / r2 / n_them);
            let tr = if me.max(them) < 0.5 { 1.0 } else { self.transmission(px, py, x, y) };
            let (me, them) = (me * tr, them * tr);
            let s = &mut self.ships;
            s.det[i] += (me - s.det[i]) * if me > s.det[i] { d_rise } else { d_fall }.min(1.0);
            s.seen[i] += (them - s.seen[i]) * if them > s.seen[i] { s_rise } else { s_fall }.min(1.0);
            if s.scan[i] < 1.0 {
                s.scan[i] = if target == Some(i) && s.det[i] >= ident && d < range { (s.scan[i] + scan_dt).min(1.0) } else { 0.0 };
            }
        }
        // a target the sensors no longer hold is lost (the page says so)
        if let Some(t) = target { if self.ships.det[t] < contact * 0.5 { self.game.target[0] = 0.0; } }
        else if self.game.target[0] != 0.0 { self.game.target[0] = 0.0; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::BODY_PLANET;
    use crate::world::Config;

    /// The player flying at the origin and one other ship `d` metres east, both class III length (60 m), idle; a yellow
    /// star 40 km west, a planet between, so the east is lit.
    fn world(d: f64) -> Box<World> {
        let mut w = World::new(Config { max_ships: 4, max_types: 1, max_bodies: 2, env_n: 4, env_w: 1000.0 }, 5);
        (w.types.accel[0], w.types.turn[0], w.types.vmax[0], w.types.len[0]) = (48.0, 1.0, 300.0, 60.0);
        w.n_bodies = 2;
        (w.bodies.x[0], w.bodies.r[0], w.bodies.kind[0], w.bodies.out[0], w.bodies.flares[0]) = (-40_000.0, 2400.0, BODY_STAR, 1.0, 1.0);
        (w.bodies.x[1], w.bodies.y[1], w.bodies.r[1], w.bodies.kind[1]) = (-20_000.0, 0.0, 1500.0, BODY_PLANET);
        w.count = 2;
        (w.ships.alive[0], w.ships.alive[1], w.ships.x[1]) = (1, 1, d);
        w.game.player[0] = 0;
        w
    }
    fn run(w: &mut World, secs: f64) { for _ in 0..(secs / DT).round() as usize { w.step(); } }

    #[test]
    fn signature_falls_with_range_and_running_cold() {
        let (mut near, mut far) = (world(3000.0), world(12_000.0));
        run(&mut near, 3.0); run(&mut far, 3.0);
        let (dn, df) = (near.ships.det[1], far.ships.det[1]);
        assert!(dn > 3.0, "near: identified ({dn})");
        assert!(df < dn / 10.0, "far: much weaker ({df} vs {dn})");
        let base = near.ships.seen[1];
        near.command(CMD_COLD, 1, 0);
        run(&mut near, 20.0);
        assert!(near.ships.seen[1] < base * 0.5, "cold: they hear less of the player ({} vs {base})", near.ships.seen[1]);
        assert!(near.ships.det[1] > 3.0, "and the player still hears them");
    }

    #[test]
    fn a_ping_reaches_further_and_cools_down() {
        let mut w = world(16_000.0);
        run(&mut w, 3.0);
        let before = w.ships.det[1];
        assert!(before < 1.0, "out of contact at 16 km idle: {before}");
        assert_eq!(w.command(CMD_PING, 0, 0), OK);
        assert_eq!(w.command(CMD_PING, 0, 0), COOLING);
        run(&mut w, 0.5);
        assert!(w.ships.det[1] >= 1.0, "the ping finds it: {}", w.ships.det[1]);
        run(&mut w, 6.0);
        assert_eq!(w.command(CMD_PING, 0, 0), OK, "cooled down");
    }

    #[test]
    fn a_held_target_in_range_is_scanned_and_a_lost_one_lapses() {
        let mut w = world(4000.0);
        let h = w.handle(1) as i32;
        assert_eq!(w.command(CMD_TARGET, h, 0), NOT_HELD); // not held yet
        run(&mut w, 2.0);
        assert_eq!(w.command(CMD_TARGET, h, 0), OK);
        let t = w.p(P::scan_secs) + 0.2;
        run(&mut w, t);
        assert_eq!(w.ships.scan[1], 1.0);
        w.ships.x[1] = 60_000.0; // gone far out of range
        run(&mut w, 5.0);
        assert_eq!(w.target_ship(), None, "the target lapses");
        assert_eq!(w.ships.scan[1], 1.0, "a finished scan stays");
    }

    #[test]
    fn shadows_shelter_from_a_flare() {
        let mut w = world(4000.0);
        assert!(w.lit(0, 4000.0, 0.0) < 0.01, "behind the planet: in its shadow");
        assert!(w.lit(0, 4000.0, 5000.0) > 0.99, "off its line: lit");
        assert_eq!(w.command(CMD_FLARE, 0, 0), OK);
        let t = w.p(P::flare_warn) + 3.0;
        run(&mut w, t);
        assert_eq!(w.game.flare[0], 2);
        let (shade, open) = (w.stellar(4000.0, 0.0, 0.0), w.stellar(4000.0, 5000.0, 0.0));
        assert!(shade < 0.05 && open > 8.0, "sheltered {shade}, exposed {open}");
        let t = w.p(P::flare_secs);
        run(&mut w, t);
        assert_eq!((w.game.flare[0], w.game.flare_lvl[0]), (0, 0.0));
    }

    /// A full flare from a yellow dwarf costs a ship in the open about a tenth of its hull, and one in a planet's shadow
    /// nothing.
    #[test]
    fn a_flare_wears_an_exposed_hull_and_spares_a_sheltered_one() {
        let hull_after = |y: f64| {
            let mut w = world(4000.0);
            (w.types.hull[0], w.ships.hull[0], w.ships.y[0]) = (100.0, 100.0, y);
            w.ships.x[0] = 4000.0; // behind the planet when y is 0
            w.command(CMD_FLARE, 0, 0);
            let t = w.p(P::flare_warn) + w.p(P::flare_secs) + 0.5;
            run(&mut w, t);
            w.ships.hull[0]
        };
        let (open, shade) = (hull_after(8000.0), hull_after(0.0));
        assert!((86.0..94.0).contains(&open), "exposed: {open}");
        assert!(shade > 99.9, "sheltered: {shade}");
    }

    #[test]
    fn flares_come_on_their_own() {
        let mut w = world(4000.0);
        let t = w.p(P::flare_min) + w.p(P::flare_span) + w.p(P::flare_warn) + 1.0;
        run(&mut w, t);
        assert!(w.game.flare[0] == 2 || w.game.flare_due[0] > w.p(P::flare_min), "a flare came: {:?}", (w.game.flare[0], w.game.flare_due[0]));
    }
}
