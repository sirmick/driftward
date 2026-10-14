# M1 progress

M1 in the Book is "Trade and delivery": one system, a game shell, the sim core as a Rust/WASM crate, trading, one mission type, and ambient traffic. Its exit test: **a market trade and a delivery mission both complete end to end; save, reload and replay of the same inputs give the same result, tested headless.**

This file tracks that milestone against the Book's `[M1]` items. Update it as work lands. Status: **done**, **partial** (with what is missing), or **to do**.

Last updated: 2026-10-14, with step 4 (cargo, credits and markets).

## Summary

| Area | Status |
|---|---|
| Sim core (Rust/WASM, columns, determinism, save, replay) | Done |
| Flight (M0 physics in the core, three-level assist) | Done |
| The M1 system, from its schema | Done |
| Landing, docking, launch, the day clock, autosave | Done |
| Port screen | Partial: trade works; missions, bar, refuel and repair are placeholders |
| Cargo, credits, markets, trading | Done |
| Mission board and delivery missions | To do (next) |
| Ambient traffic | To do |
| HUD, targeting, system map, location list, shell | Partial |
| Lore, painted vistas and portraits (OpenRouter) | To do |
| Exit test, headless | Machinery and trading done; needs missions |

## Done

- **Sim core skeleton.** One Rust crate in `core/`, WASM in the pages and native for tests. Typed-array columns in WASM memory with zero-copy views in JS, a fixed 60 Hz tick with render interpolation, one step call per tick.
- **Determinism.** Seeded PCG32 and our own sin, cos, atan2 and exp. Native and WASM builds produce bit-identical states (checked on every `npm test`).
- **M0 flight in the core.** Assist controller, gas fields, steering, thrust with taper, drag, dampers, engine glow. Gravity wells are game physics: they pull with a share of thrust and bend top speed by direction, scaled per hull class.
- **Three-level assist.** Full assist, drift off (strafe, point retrograde), full off (torque rotation). On F in the game page; the Book says Tab.
- **Save, reload, replay.** The world saves to a fixed-size byte image. A snapshot plus a log of input changes and game commands replays a session exactly. The game page exports replays; `cargo run --bin replay` reruns them natively, and the smoke test checks a browser session with port visits replays to the same hash.
- **System from its schema.** `src/schema/system.schema.json` is the contract; `src/schema.js` clamps content to it before use (the Book's validation rule). `npm run check` validates every system file and the clamp.
- **The M1 system.** Brannock, Ironhull-owned, middle ring: an orange star, Cinder (mining), Halde (habitat town), the gas giant Vast and its moon Tallow (refinery), and Kettle Yard (shipyard station). Four ports, so 12 directed routes.
- **Landing and docking.** Be over a port and slow (30 m/s for planets, 12 for stations), press L. A 2.5 s descent inside a plasma sheath drawn from the hull's distance field; docking is a short shrink. Launch is the reverse and hands back control with a small orbital velocity. Skippable with Enter.
- **Time.** A landing costs a day; waiting in port costs a day. The day lives in the core.
- **Autosave on landing.** As in EV.
- **Landed and safe.** In port the ship is out of the flight sim.
- **Camera and zoom.** Top-down, centred on the ship and leading its velocity; mouse-wheel zoom.
- **Planets, stars and stations in flight.** Detailed planets with detail by zoom, a star with corona, stations baked from catalog archetypes, engine plumes and thruster jets.
- **Cargo, credits and markets.** A hold per hull class (fighter 10 t up to capital 600 t, in the catalog), credits and a debt in the core. Ten commodities in `src/economy.json`, each with a base price; each port role has a table of the ones it trades, at a low (0.7x), medium or high (1.4x) tier. The page writes the prices into the core's market columns at a new game, and they save with the world. Buy, sell and repay are game commands, checked by the core (landed, traded here, credits, hold space, cargo aboard), and replay like landings. `npm run check` validates the tables.
- **Start.** A used fighter, 1,500 credits and a 12,000-credit debt to a lender, gathering 0.2% a day; repay at any port.
- **Docking fees.** Waiting a day in port costs 20 credits (the `dock_fee` param); you cannot wait if you cannot pay.
- **Market screen.** Trade (T) on the port screen: what the port trades, price (green under base, amber over), tons aboard, buy and sell a ton or, shift-clicked, all you can; repay the lender. Credits and hold on the flight HUD.
- **Dev server.** Node, live reload of both pages, the crate rebuilds on change.

## Partial

- **Port screen.** Name, body, role, population, description and a vista of the body; trade, wait a day and launch work. Missing: mission board, bar, refuel and repair (shown disabled), painted vista and lore.
- **HUD.** Day, credits, hold, speed, top speed, assist level, nearest body, well strength, minimap, navigation overlay (I), velocity and heading marks. Missing: ship status (shields, hull, energy, heat, fuel), nav target bottom-right (range, relative speed, clear to land), active mission with days left, message log, radar contacts at their error radius.
- **Shell.** New game, save and load buttons, replay export. Missing: title screen, new game from a seed, continue from the last landing save, settings, pause.
- **Debug control plane.** The page exposes `window.__play` (new game, advance, commands, probe, save, load, export replay), which headless tests drive. Missing: a local API (time scale, teleport, spawn, state inspector, replay and diff) that Claude Code can drive without a browser script.
- **Controls.** Arrows or WASD, Shift burner, L land, wheel zoom work. Missing: T to cycle targets, M for the map; assist level is on F, not Tab.

## To do

In build order.

1. **Mission board and delivery missions (step 5).** A mission is a template run as a state machine: deliver cargo to a named port in the system. 3 to 8 offers per board, each expiring; deadline in days from route length times slack; pay from base, distance, risk and urgency. Accept, carry, deliver on landing; failure is soft. Active mission on the HUD.
2. **Ambient traffic (step 6).** The Ironhull hull family in three sizes (shuttle, hauler, liner), 10 to 20 ships. Flows between ports from a gravity model (population times population over distance, weighted by role complementarity). Poisson arrivals from undocking; steady state on entry; ships on rails far from the player and full physics and AI near; they land, dock and launch with the same animation. AI moves into the core.
3. **HUD, targeting and maps.** T cycles targets with a nav target panel; M opens the system map (orbits, bodies, contacts, mission destinations; click to target; fly-to autopilot under full assist); the location list on the right, expanding the body whose zone the player is in; ship status; message log.
4. **Shell.** Title, new game with a seed, continue from the last landing save, settings, pause. Death reloads the last landing save.
5. **Lore and art (OpenRouter).** Lore per location written from sim facts (population, owner, role, description, notable places, named NPCs, rumors); painted vistas and portraits from an image model, with a per-system art bible; seeded and cached, with the procedural backdrop offline.
6. **Exit test.** A headless script that buys at one port, sells at another, accepts and completes a delivery, then saves, reloads and replays to the same state hash, natively.

## Deviations from the Book

- **No array compaction yet.** Ship slots are stable with an alive mask; generation handles detect reuse. The Book's swap-remove compaction waits until no JS-owned columns run parallel to the core's.
- **Bodies hold still.** No orbiting or spinning stations yet (stations spin only visually), so "slow relative to the port" is just "slow".
- **Gravity is game physics,** by design: see `core/src/flight.rs`.
- **Prices are content, not core code.** The Book's markets are columns in the core; M1's fixed prices are computed in the page from `src/economy.json` and written into them, so M5's moving prices can replace the writer without changing the columns or the trading commands.
- **One price per commodity per port.** No buy and sell spread, as in EV: profit comes only from price gaps between ports.

See also [Known issues](known-issues.md) and the Book's [Build staging](book.md#build-staging).
