//! Replays: a snapshot to start from plus a log of what the player did, keyed by world tick: input changes (the
//! buttons held from that tick on) and commands (land, launch, ...; see port.rs), applied before that tick's step.
//! The page records the log as you play; `cargo run --bin replay` reruns it headless.

use crate::world::World;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogEntry {
    /// From this tick on, the player holds these buttons.
    Input { tick: u64, input: u32 },
    /// At this tick, the page issued this command.
    Command { tick: u64, code: u32, a: i32, b: i32 },
}

impl LogEntry {
    pub fn tick(&self) -> u64 { match *self { LogEntry::Input { tick, .. } | LogEntry::Command { tick, .. } => tick } }
}

/// Parse a log: `tick input` lines and `tick cmd code a b` lines (decimal; blank lines and # comments ignored).
pub fn parse_log(text: &str) -> Result<Vec<LogEntry>, String> {
    let mut out = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() { continue; }
        let words: Vec<&str> = line.split_whitespace().collect();
        let bad = || format!("input log line {}: expected `tick input` or `tick cmd code a b`, got `{line}`", n + 1);
        let entry = match words.as_slice() {
            [tick, input] => LogEntry::Input { tick: tick.parse().map_err(|_| bad())?, input: input.parse().map_err(|_| bad())? },
            [tick, "cmd", code, a, b] => LogEntry::Command {
                tick: tick.parse().map_err(|_| bad())?, code: code.parse().map_err(|_| bad())?,
                a: a.parse().map_err(|_| bad())?, b: b.parse().map_err(|_| bad())?,
            },
            _ => return Err(bad()),
        };
        out.push(entry);
    }
    Ok(out)
}

/// Step `ticks` times, applying each logged entry on its tick, in order (entries before the start apply at once).
pub fn run(w: &mut World, log: &[LogEntry], ticks: u64) {
    let mut k = 0;
    for _ in 0..ticks {
        while k < log.len() && log[k].tick() <= w.tick {
            match log[k] {
                LogEntry::Input { input, .. } => w.player.input = input,
                LogEntry::Command { code, a, b, .. } => { w.command(code, a, b); }
            }
            k += 1;
        }
        w.step();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::{IN_ASSIST, IN_BURN, IN_LEFT, IN_REVERSE, IN_THRUST};
    use crate::port::{CMD_LAND, CMD_LAUNCH, CMD_WAIT, MODE_FLYING, OK};
    use crate::scenario;

    #[test]
    fn replay_from_a_save_reproduces_the_session() {
        // play a session that flies, lands at a port, waits a day and launches, recording it as the page does
        let mut live = scenario::build(9);
        live.player.slot = 0;
        let (px, py) = (live.bodies.x[0], live.bodies.y[0]); // the scenario's first body is a port
        live.ships.x[0] = px + 100.0;
        live.ships.y[0] = py;
        live.ships.vx[0] = 0.0;
        live.ships.vy[0] = 0.0;
        live.slot_reset(0, false);
        live.save();
        let start = live.snapshot().to_vec();
        let script: [(u64, Option<u32>, Option<u32>); 8] = [
            (0, Some(IN_ASSIST | IN_THRUST), None), (40, Some(IN_ASSIST | IN_REVERSE), None), (200, Some(IN_ASSIST), None),
            (260, None, Some(CMD_LAND)), (500, None, Some(CMD_WAIT)), (520, None, Some(CMD_LAUNCH)),
            (700, Some(IN_ASSIST | IN_THRUST | IN_BURN), None), (800, Some(IN_ASSIST | IN_LEFT), None),
        ];
        let mut log = Vec::new();
        for t in 0..1000u64 {
            for &(at, input, cmd) in &script {
                if at != t { continue; }
                if let Some(input) = input { live.player.input = input; log.push(LogEntry::Input { tick: live.tick, input }); }
                if let Some(code) = cmd { assert_eq!(live.command(code, 0, 0), OK, "command {code} at {t}"); log.push(LogEntry::Command { tick: live.tick, code, a: 0, b: 0 }); }
            }
            live.step();
        }
        assert_eq!((live.mode(), live.day()), (MODE_FLYING, 2));
        let mut again = World::from_snapshot(&start).unwrap();
        run(&mut again, &log, 1000);
        assert_eq!(live.hash(), again.hash());
    }

    #[test]
    fn log_parsing() {
        assert_eq!(parse_log("# start\n0 513\n\n90 577 # burn\n120 cmd 1 0 0\n").unwrap(), vec![
            LogEntry::Input { tick: 0, input: 513 }, LogEntry::Input { tick: 90, input: 577 },
            LogEntry::Command { tick: 120, code: 1, a: 0, b: 0 },
        ]);
        assert!(parse_log("12").is_err());
        assert!(parse_log("1 2 3").is_err());
        assert!(parse_log("1 cmd 2").is_err());
    }
}
