//! Headless replay: `replay <save.bin> <inputs.txt> <ticks>` loads a snapshot exported from the page,
//! runs the logged inputs for that many ticks, and prints the final tick and state hash. The page shows
//! the hash it reached, so a match proves the browser session replays natively.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 3 {
        eprintln!("usage: replay <save.bin> <inputs.txt> <ticks>");
        std::process::exit(2);
    }
    let save = std::fs::read(&args[0]).unwrap_or_else(|e| fail(&format!("{}: {e}", args[0])));
    let log = std::fs::read_to_string(&args[1]).unwrap_or_else(|e| fail(&format!("{}: {e}", args[1])));
    let log = driftward_core::replay::parse_log(&log).unwrap_or_else(|e| fail(&e));
    let ticks: u64 = args[2].parse().unwrap_or_else(|_| fail("ticks must be a number"));
    let mut w = driftward_core::World::from_snapshot(&save).unwrap_or_else(|e| fail(&format!("bad snapshot: {e:?}")));
    driftward_core::replay::run(&mut w, &log, ticks);
    println!("tick {} hash {:016x}", w.tick, w.hash());
}

fn fail(msg: &str) -> ! {
    eprintln!("replay: {msg}");
    std::process::exit(1);
}
