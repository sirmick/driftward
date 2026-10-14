//! Driftward simulation core.
//!
//! One crate, two builds: WASM for the page (`index.html` inlines it) and native for headless tests
//! and, later, a server. State lives in fixed-capacity typed columns (`cols`), advanced by a fixed
//! 60 Hz tick (`world`); flight physics is the first mechanism ported in (`flight`). All math that
//! feeds state is deterministic across targets (`math`, `rng`); `scenario` proves it. The player flies
//! by one input bitmask per tick (`player`); the world saves to a fixed-size byte image (`snapshot`), and a
//! snapshot plus an input log replays a session exactly (`replay`). Ports, landings and the day clock are in `port`;
//! cargo, credits and markets in `market`; the mission board and deliveries in `mission`; ambient traffic in
//! `traffic`.

pub mod cols;
pub mod ffi;
pub mod flight;
pub mod market;
pub mod math;
pub mod mission;
pub mod player;
pub mod port;
pub mod replay;
pub mod rng;
pub mod scenario;
pub mod snapshot;
pub mod traffic;
pub mod world;

pub use world::{Config, World, DT};
