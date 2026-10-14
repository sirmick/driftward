//! Replays: a snapshot to start from plus a log of input changes, keyed by world tick.
//! The page records the log as you play; `cargo run --bin replay` reruns it headless.

use crate::world::World;

/// One input change: from this world tick on, the player holds these buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputChange { pub tick: u64, pub input: u32 }

/// Parse "tick input" lines (decimal; blank lines and # comments ignored).
pub fn parse_log(text: &str) -> Result<Vec<InputChange>, String> {
    let mut out = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() { continue; }
        let mut it = line.split_whitespace().map(str::parse::<u64>);
        match (it.next(), it.next(), it.next()) {
            (Some(Ok(tick)), Some(Ok(input)), None) if input <= u32::MAX as u64 => out.push(InputChange { tick, input: input as u32 }),
            _ => return Err(format!("input log line {}: expected `tick input`, got `{line}`", n + 1)),
        }
    }
    Ok(out)
}

/// Step `ticks` times, applying each logged change on its tick (changes before the start apply at once).
pub fn run(w: &mut World, log: &[InputChange], ticks: u64) {
    let mut k = 0;
    for _ in 0..ticks {
        while k < log.len() && log[k].tick <= w.tick {
            w.player.input = log[k].input;
            k += 1;
        }
        w.step();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::{IN_ASSIST, IN_BURN, IN_LEFT, IN_THRUST};
    use crate::scenario;

    #[test]
    fn replay_from_a_save_reproduces_the_session() {
        // play a session, recording input changes as the page does
        let mut live = scenario::build(9);
        live.player.slot = 0;
        live.save();
        let start = live.snapshot().to_vec();
        let script = [(0, IN_ASSIST | IN_THRUST), (90, IN_ASSIST | IN_THRUST | IN_BURN), (200, IN_ASSIST | IN_LEFT), (420, IN_THRUST), (600, 0)];
        let mut log = Vec::new();
        for t in 0..900u64 {
            if let Some(&(_, input)) = script.iter().find(|(at, _)| *at == t) {
                live.player.input = input;
                log.push(InputChange { tick: live.tick, input });
            }
            live.step();
        }
        let mut again = World::from_snapshot(&start).unwrap();
        run(&mut again, &log, 900);
        assert_eq!(live.hash(), again.hash());
    }

    #[test]
    fn log_parsing() {
        assert_eq!(parse_log("# start\n0 513\n\n90 577 # burn\n").unwrap(), vec![InputChange { tick: 0, input: 513 }, InputChange { tick: 90, input: 577 }]);
        assert!(parse_log("12").is_err());
        assert!(parse_log("1 2 3").is_err());
    }
}
