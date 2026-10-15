# M1 progress

M1 in the Book is "Trade and delivery": one system, a game shell, the sim core as a Rust/WASM crate, trading, one mission type, and ambient traffic. Its exit test: **a market trade and a delivery mission both complete end to end; save, reload and replay of the same inputs give the same result, tested headless.**

This file tracks that milestone against the Book's `[M1]` items. Update it as work lands. Status: **done**, **partial** (with what is missing), or **to do**.

Last updated: 2026-10-15, with step 9 (lore and art).

## Summary

| Area | Status |
|---|---|
| Sim core (Rust/WASM, columns, determinism, save, replay) | Done |
| Flight (M0 physics in the core, three-level assist) | Done |
| The M1 system, from its schema | Done |
| Landing, docking, launch, the day clock, autosave | Done |
| Port screen | Partial: trade, missions, the bar and the port's lore work; refuel and repair are placeholders |
| Cargo, credits, markets, trading | Done |
| Mission board and delivery missions | Done |
| Ambient traffic | Done |
| HUD, targeting, system map, location list | Done, but for ship status and sensor error radii |
| Shell | Done, but for death (no combat yet) |
| Lore, painted vistas and portraits (OpenRouter) | Done, generated offline |
| Exit test, headless | Every piece works and is tested; the single scripted test is to do |

## Done

- **Sim core skeleton.** One Rust crate in `core/`, WASM in the pages and native for tests. Typed-array columns in WASM memory with zero-copy views in JS, a fixed 60 Hz tick with render interpolation, one step call per tick.
- **Determinism.** Seeded PCG32 and our own sin, cos, atan2 and exp. Native and WASM builds produce bit-identical states (checked on every `npm test`).
- **M0 flight in the core.** Assist controller, gas fields, steering, thrust with taper, drag, dampers, engine glow. Gravity wells are game physics: they pull with a share of thrust and bend top speed by direction, scaled per hull class.
- **Three-level assist.** Full assist, drift off (strafe, point retrograde), full off (torque rotation). On F in the game page; the Book says Tab.
- **Save, reload, replay.** The world saves to a fixed-size byte image. A snapshot plus a log of input changes and game commands replays a session exactly. The game page exports replays; `cargo run --bin replay` reruns them natively, and the smoke test checks a browser session with port visits replays to the same hash.
- **System from its schema.** `src/schema/system.schema.json` is the contract; `src/schema.js` clamps content to it before use (the Book's validation rule). `npm run check` validates every system file and the clamp.
- **The M1 system.** Brannock, Ironhull-owned, middle ring: an orange star, Cinder (mining), Halde (habitat town), the gas giant Vast and its moon Tallow (refinery), and Kettle Yard (shipyard station). Four ports, so 12 directed routes.
- **Landing and docking.** Be over a port and slow (30 m/s for planets, 12 for stations), press L. A 3.2 s sequence that curls round the planet: the ship turns across it and spirals out to the horizon, shrinking inside a plasma sheath drawn from the hull's distance field, and fades into the atmosphere. Launch rises at the horizon and spirals back in to the port, accelerating all the way, and hands back control at the speed it arrived at (1.4 times top speed, which the assist and dampers bleed off), heading round the planet the way the landing went. The camera follows, pulled back a little, and the view's zoom glides between flight, sequences and the port. Docking at a station is a straight slide into the clamps. Traffic lands and launches the same way. Skippable with Enter.
- **Time.** A landing costs a day; waiting in port costs a day. The day lives in the core.
- **Autosave on landing.** As in EV.
- **Landed and safe.** In port the ship is out of the flight sim.
- **Camera and zoom.** Top-down, centred on the ship and leading its velocity; mouse-wheel zoom.
- **Planets, stars and stations in flight.** Detailed planets with detail by zoom, a star with corona, stations baked from catalog archetypes, engine plumes and thruster jets.
- **Cargo, credits and markets.** A hold per hull class (fighter 10 t up to capital 600 t, in the catalog), credits and a debt in the core. Ten commodities in `src/economy.json`, each with a base price; each port role has a table of the ones it trades, at a low (0.7x), medium or high (1.4x) tier. The page writes the prices into the core's market columns at a new game, and they save with the world. Buy, sell and repay are game commands, checked by the core (landed, traded here, credits, hold space, cargo aboard), and replay like landings. `npm run check` validates the tables.
- **Start.** A used fighter, 1,500 credits and a 12,000-credit debt to a lender, gathering 0.2% a day; repay at any port.
- **Docking fees.** Waiting a day in port costs 20 credits (the `dock_fee` param); you cannot wait if you cannot pay.
- **Market screen.** Trade (T) on the port screen: what the port trades, price (green under base, amber over), tons aboard, buy and sell a ton or, shift-clicked, all you can; repay the lender. Credits and hold on the flight HUD.
- **Mission board.** Each port's board holds 3 to 8 haulage offers (core columns, posted from the seeded generator, so boards replay). Each day expired offers drop (an offer lasts 2 to 5 days) and free slots fill by chance. An offer binds live state: a destination port, cargo the origin's market trades, 1 to 12 tons, a deadline of the route's length in days (20 km a day) times a slack of 1.5 to 3, plus one, and pay of a base plus tons times kilometres, times an urgency that rises as the slack falls. Risk and faction wealth are 1 in M1.
- **Delivery missions.** Accept (a command) moves an offer to the player's missions (up to 4); its cargo takes hold space and cannot be sold. Landing at the destination delivers and pays; a day past the deadline fails it softly (the cargo is reclaimed, nothing is paid). Missions can be abandoned. The board panel (M) lists offers and your missions with days left; delivery and failure are reported as they happen; active missions show on the HUD, and their destinations on the nav overlay, radar and map.
- **Ambient traffic.** One culture (the Ironhulls, flying the catalog's Rustline hulls: fighter as shuttle, frigate as hauler, cruiser as liner; `src/traffic.json`). The core plans a lane per directed route and role from a gravity model: population times population over distance (shuttles over distance squared; haulers times how much dearer the destination's market is), scaled so about 14 ships are in flight at steady state, under a cap of 24. Ships undock as a Poisson process with the launch sequence, follow a route bent round the star and any planet in the way, and land or dock with the player's sequence and sheath, then are forgotten. A new game starts mid-flow (a Poisson number per lane, spread along the routes). Far from the player (over 8 km) ships run on rails; near, they fly the full physics under the assist controller, along the same route, and land by the player's rules. They show as dots on the radar. Rates, shares, speeds and distances are core params; the traffic hulls bake at page load.
- **Flight HUD.** As the Book lays it out: day, credits, hold and flight status top-left, with the autopilot and active missions; radar top-right (ships appear only here, as dots); the location list under it (the star, planets and free stations in orbital order; the body whose zone, 6 radii in and 7 out, the player is in expands to its moons and stations; range, LAND, DOCK and mission markers; click or 1 to 9 to target); the nav target bottom-right (range, closing speed, and for a port whether you are clear to land); the message log bottom-left.
- **Targeting.** T cycles the ships on the radar, nearest first; bodies from the location list or the map. A body or ship target is bracketed on screen, or marked by an arrow on the screen edge; a ship target lapses when it lands.
- **System map (M).** Orbits, bodies, ports, ships, mission destinations, the target and the autopilot's course; click to target.
- **Fly-to autopilot (G).** A core command, so it replays: under full assist it flies to the target body, round the star or a planet in the way (the same detour traffic uses), and brakes to stop over it, clear to land. Thrust, reverse or turn, or leaving full assist, takes over. The smoke test flies a delivery with it and replays the session natively.
- **Shell.** The page opens on the title, over a live view of Halde with traffic flying past: Continue (the last landing's autosave, with its day, port and credits), New game (from a seed: blank is random, a number is used as is, text is hashed), Settings. P, or Esc with nothing else to close, pauses: the clock stops (the replay log is by tick, so a pause leaves no trace); the pause menu has resume, save, load, settings, export replay and quit to title. Settings (bloom, the nav overlay and assist level a game starts with, the debug readout) are kept in the browser. Every landing autosaves, even one a stalled frame skips past.
- **Teleport (dev).** `__play.teleport(body)` puts the flying player at rest over a body, as a logged command, so tests can fly a delivery and still replay it.
- **Dev server.** Node, live reload of both pages, the crate rebuilds on change.
- **Lore and art (OpenRouter).** `tools/gen-content.js` writes a system's content offline, from its sim facts: the bodies (order from the star, size, surface, colours), the owning faction and its design language (the Book's appendix), and each port's role, population, authored description, what its market sells cheap and pays well for, and which ports are near or far. One text call (Claude Sonnet 5.5) writes the whole system, so its ports agree: history, culture, an art bible (palette, lighting, architecture, materials, mood, design language) and per port two or three paragraphs, notable places, two to four named people (role, who they are, a line, a look) and rumors, plus what its vista shows. The answer is clamped by the game's own validator against `src/schema/lore.schema.json` and checked against the system (every port covered, person ids unique); a failing answer is retried with the problems fed back. It goes to `src/lore/<id>.json`. Then an image model (Gemini 3.1 Flash Image) paints a 16:9 vista per port and a portrait per person into `art/<id>/` as WebP. The art bible and the body's sim parameters go into every vista prompt, so the painting matches the flight view: image models read colour words, not hex, so each palette colour is named (deep navy blue, ashen grey, rust brown) and described by what the planet shader paints with it (seas, lowlands and highlands; bands and storms; crater floors, ground and rims), and the start port's vista is the style reference for the others (the first portrait likewise for the portraits). Every prompt, model, seed and cost is logged in `art/<id>/log.json`. Content is reviewed and committed, so play never waits on a model and every player sees the same port. The M1 run cost $1.51, with the vistas redone once. `--no-ref` paints without the reference, for an image that copies the reference's layout rather than its style (Tallow's did). `npm run check` validates the lore and checks every image matches a port or person in it.
- **Port lore on the port screen.** The card shows the lore's first paragraph; About (I) has the full description, notable places and the system's history and culture; the Bar (B) lists the people in tonight with their portraits, what they say, and the rumors overheard. The painted vista fades in over the procedural view of the body. The build inlines the lore, and the page loads the art from `art/` beside it: opened on its own, without that folder, the page falls back to the procedural view and the people's initials.

## Partial

- **Port screen.** Name, body, role, population, the painted vista, lore, trade, the mission board, the bar, wait a day and launch. Missing: refuel and repair (shown disabled), which wait for fuel and damage in the core. The bar is people and rumors only: no hiring or bar missions until M2.
- **HUD.** Missing: ship status (shields, hull, energy, heat, fuel), which waits for damage and fuel in the core, and radar contacts drawn at their sensor error radius, which waits for sensors in the core.
- **Shell.** Missing: death reloading the last landing save, which waits for something that can kill you (M2).
- **Debug control plane.** The debug screen (backquote) opens over the game with the clock stopped. **Content** shows how the system's content was made, each thing once: a header with the models, dates and costs; the pipeline's shared parts (the system-level facts, the lore prompt with its facts and schema factored out, the run and its attempts, the art bible, and the paragraphs the image prompts share); a card per port with its body (parameters, palette, the facts' words for it, market and routes), its lore, its vista and its people with their portraits, each image with only its own part of the prompt (the full prompt on demand); and the raw files. **Player** is live: the ship and its stats, flight state, credits, debt and net worth, the hold priced at every port (best price for cargo aboard marked), missions, and the session's tick, hash and seed. The lore run records its prompt in `src/lore/<id>.log.json` (Brannock's was recorded after the fact, and says so); the build inlines it and the art log. The page also exposes `window.__play` (new game, advance, commands, teleport, probe, save, load, export replay), which headless tests drive. Missing: a local API (time scale, teleport, spawn, state inspector, replay and diff) that Claude Code can drive without a browser script.
- **Controls.** As the Book's: arrows or WASD, Shift burner, Tab assist level (F too), T targets, L land, M map, wheel zoom; plus 1 to 9 for locations, G fly to, I the nav overlay; in port, T trade and M the mission board. Missing: J to jump (M4), gamepad.

## To do

In build order.

1. **Exit test.** A headless script that buys at one port, sells at another, accepts and completes a delivery, then saves, reloads and replays to the same state hash, natively.

## Deviations from the Book

- **No array compaction yet.** Ship slots are stable with an alive mask; generation handles detect reuse. The Book's swap-remove compaction waits until no JS-owned columns run parallel to the core's.
- **Bodies hold still.** No orbiting or spinning stations yet (stations spin only visually), so "slow relative to the port" is just "slow".
- **Gravity is game physics,** by design: see `core/src/flight.rs`.
- **Prices are content, not core code.** The Book's markets are columns in the core; M1's fixed prices are computed in the page from `src/economy.json` and written into them, so M5's moving prices can replace the writer without changing the columns or the trading commands.
- **Missions are fixed code, not templates yet.** The Book's mission template (objective nodes, triggers, branches) is tagged M1, but M1 has one mission type, so delivery is written directly in `core/src/mission.rs`; the template machinery waits for a second type.
- **Traffic hulls are stand-ins.** The Book's Ironhull family (shuttle, hauler, liner) does not exist in the catalog yet; the Rustline brand's fighter, frigate and cruiser stand in until M3's faction rosters.
- **Traffic never meets the player.** Ships pass through each other and the player; no hails, scans or reactions until combat and law arrive.
- **One price per commodity per port.** No buy and sell spread, as in EV: profit comes only from price gaps between ports.

See also [Known issues](known-issues.md) and the Book's [Build staging](book.md#build-staging).
