//! Native run of the shared scenario: `scenario [seed] [ticks]` prints the final state hash.
//! `npm test` compares it with the WASM build's hash for the same inputs.

fn main() {
    let mut args = std::env::args().skip(1).map(|a| a.parse::<u64>().expect("numeric argument"));
    let seed = args.next().unwrap_or(1);
    let ticks = args.next().unwrap_or(3600);
    println!("{:016x}", driftward_core::scenario::run(seed, ticks));
}
