# Driftward

An Escape Velocity-style space game for the browser, where the galaxy never runs out: ships, stations, planets, suns, asteroids and eventually factions, missions and lore are generated from structured JSON that an LLM can author.

This repository holds two self-contained WebGL2 pages with no dependencies and no build step needed to run them: the asset lab with its flight prototype, and the game, which is on its way to the first playable milestone (M1). Both run on the simulation core, a Rust crate compiled to WebAssembly and inlined into each page.

## Run it

Open `index.html` for the lab or `play.html` for the game, in a browser with WebGL2 (any current Chrome, Firefox, Safari or Edge). That's it.

The game so far: the Book's M1 system, Brannock (an orange star, three planets, a moon and a shipyard station, four of them ports), loaded from a schema-validated file. You start landed at Halde Landing in a used fighter with 1,500 credits and a 12,000-credit debt to a lender; launch, fly, and land or dock at any port (be over it and slow, press L: a short descent inside a plasma sheath, a day passes, the game autosaves). Each port's market (T) trades commodities at fixed prices set by its role (a mine sells ore cheap and pays well for food and goods; the refinery buys ore and sells metals), so buying low at one port and selling high at another pays; waiting in port costs a docking fee, and the debt gathers interest daily. The mission board (M) posts deliveries to the other ports: accept one, carry its cargo, and land at the destination by the deadline to be paid; your missions show on the HUD and their destinations on the nav overlay and minimap. Flight runs on the core's model, with the Book's three assist levels on F (full assist; drift off, with Q/E strafe and X retro; full off, where spins persist), side, reverse and turning thruster jets on each hull, gravity wells that pull you in and bend your top speed, so you fall in fast and crawl out (game physics, stronger on bigger hulls, though every hull can climb out), a minimap and a navigation overlay (I) that labels or points to every planet with its distance and closing speed; save (F6) and load (F9), and export a replay of the session. Everything that changes game state runs in the core, so a save restores the exact state and a replay reruns identically, in the browser or natively.

## What's in the lab

| Tab | What it does |
|---|---|
| **Yard** | 4 brands × 5 hull classes, assembled from parametric parts and baked to lit sprites. Drag to move the sun. |
| **Ship** | One ship up close: map views (albedo, normal, height, emissive, shield field), part list, catalog editor. |
| **Planets** | 12 generated systems plus a builder: 13 palettes, rings on any axis, moons on inclined orbits. |
| **Suns** | One of each class from red dwarf to quasar, with a draggable lens flare. |
| **Heavies** | Specialist hulls: bulk freighter, agri ship, mining tug towing its refinery, colony ship, fleet carrier, survey vessel. |
| **Stations** | Ring habitats, container ports, forges, refineries, shipyards and relay arrays, each built in an owning brand's style. |
| **Asteroids** | Ten compositions (carbonaceous to ore-veined crystal), ray-marched and tumbling, sized to scale. |
| **Fly** | One Newtonian physics for every ship with flight assist as an autopilot layer; nebula gas (hydrogen, dust, ionized), stellar radiation with planet shadows and flares; signature-based sensors, scanning, running cold and active pings; NPC traffic and combat. |

Flight controls: W/S set speed (assist on) or main/reverse thrust (assist off), A/D turn, Q/E strafe and X point retrograde (assist off), Shift burner, Space fire, Tab next sensor contact, C run cold, P active ping, F flight assist, R trigger a stellar flare, wheel or +/− zoom.

## How it works

**Ships are data.** `src/catalog.json` defines size classes (length, bake resolution, flight stats) and brands. A brand is a style grammar: palette, union mode, symmetry, bevel profile, detail switches, plume and shield style, flight multipliers, a catalog of part templates with parameter ranges, and a loadout per size. Shape values are fractions of hull length; detail spacing is in meters, so a fighter and a capital ship of one brand share panel size and window pitch.

**Pipeline:** `brand + size + seed` → part list (`assemble` in `src/gen.js`) → per-texel 2D SDF evaluation into albedo, normal, height, emissive, spec and a shield distance field (`bake`, run in Web Workers) → lit in a fragment shader with self-shadowing, up to 16 point lights, plumes, shields and HDR bloom.

**Heavies** share that pipeline with forward-facing layouts (`heavies` in the catalog): container bays, glass farm domes, tow cables, flight decks with launch tubes, docking cradles with parked frigates, probe racks and shuttle bays. Their nozzles feed the same throttle-driven plumes as fighters.

**Stations** use the same bake: an archetype layout (`stations` in the catalog) places hubs, rings, open lattice trusses, container stacks, tanks, radiators, furnaces, dishes and solar arrays, and the owning brand supplies the look, so a Rustline refinery is patched and asymmetric while a Vaelith one grows into a single organic skin. A detail-scale factor keeps paneling legible at kilometer size.

**Asteroids** are sphere-traced: a noise-displaced ellipsoid for the silhouette, craters, grit and ore veins as shading detail, soft self-shadowing, and a per-body tumble axis.

**Planets and suns** are drawn analytically in fragment shaders: seamless 3D noise on a rotating sphere, equatorial rings that cast and receive shadows, moons on inclined orbits, blackbody star colors, granulation and corona, pulsar beams, and a ray-marched black hole with a Doppler-beamed disk that lenses the real sky behind it.

**The sim core** (`core/`, Rust) owns flight physics. It keeps ships in fixed-capacity typed columns inside WASM memory; the page reads and writes them through zero-copy typed-array views built from a manifest the core exports, and calls one step per tick. The clock is a fixed 60 Hz tick, and the renderer draws from a pose the core interpolates between ticks, so motion is smooth at any refresh rate. Everything that feeds state is deterministic: a seeded generator, and its own sin, cos, atan2 and exp built from IEEE basic operations, so the native and WASM builds produce bit-identical states. Tuning constants are a named parameter column that can be changed live. In the lab's Fly tab, AI, weapons, shields, sensors and effects still run in JavaScript around each tick. The game page runs no game logic in JavaScript at all: the player flies by one input bitmask per tick, the world saves to a fixed-size byte image (allocated with the world, so saving never grows WASM memory), and a snapshot plus the log of input changes replays a session exactly. Mechanisms move into the core as the game needs them; rendering, UI and LLM calls stay in JavaScript.

**Two pages, one kit.** Shader sources, the WebGL helpers and post-processing, the bake worker pool and the brand look helpers are shared modules that the build inlines into both pages.

**Flight** keeps all entity state in typed arrays (structure of arrays): ships, bolts, particles and lights. Every ship has main, reverse and lateral thrusters under one Newtonian model; a drive taper caps self-propelled speed and dampers bleed off anything gravity or slingshots add. Flight assist is a controller that turns a desired velocity into thruster commands, and NPCs fly through the same controller. The sector carries coarse gas and radiation fields: gas adds drag, attenuates sensors and (ionized) drains shields; radiation follows the star with shadows behind planets and spikes during flares. Detection is signature over range squared, times gas transmission, over local noise. Rendering is instanced: one draw per ship type, one each for plumes, shields, bolts and particles. Hits test against the baked shield/hull field, so bolts strike the actual silhouette.

**Everything is parameterized** for LLM authoring: categorical choices are enums (brand part roles, planet palettes, ring styles, star types), everything else is a bounded number. The JSON panels in the lab show exactly what a model would emit.

## Layout

```
index.html          built lab page (open this)
play.html           built game page (or this)
core/               the sim core, a Rust crate (WASM for the pages, native for tests and replays)
  src/world.rs      column groups, tuning params, the fixed-step clock and tick pipeline, handles, state hash
  src/flight.rs     flight physics stages: assist control, gas fields, steering, forces, integration, engines
  src/math.rs       deterministic sin, cos, atan2, exp
  src/rng.rs        seeded PCG32
  src/cols.rs       structure-of-arrays macro and the column manifest
  src/ffi.rs        the exports the page calls
  src/player.rs     the player's ship from one input bitmask per tick (assist set speed, raw thrust, retro)
  src/snapshot.rs   save and load: the whole world as one fixed-size byte image
  src/replay.rs     input logs, and rerunning them from a snapshot
  src/port.rs       ports and landings: flying, descending, landed, launching; the day; the game commands
  src/market.rs     cargo hold, credits, the lender, markets: buy, sell and repay commands
  src/mission.rs    mission boards and delivery missions: offers, accept, deliver on landing, deadlines
  src/scenario.rs   scripted world shared by native and WASM, for the determinism check
  src/bin/          scenario (prints a scenario's hash) and replay (reruns an exported session)
src/
  core.js           loads the inlined WASM and wraps its columns in typed-array views
  shaders.js        GLSL sources shared by both pages
  gfx.js            the WebGL2 kit: context, programs, textures, HDR targets, bloom and tone map
  bake.js           the bake worker pool and its texture uploads
  look.js           colour helpers, star presets, brand plume and shield looks
  schema.js         clamps content to its JSON Schema before use; lays out a star system
  schema/           JSON Schemas: the contract for LLM-authored content (system.schema.json)
  systems/          star systems (m1.json: Brannock, the Book's M1 system)
  economy.json      commodities, price tiers by port role, the starting credits and debt
  play/             the game page: template.html and play.js
  catalog.json      size classes, the four brand catalogs, station archetypes and heavy hulls
  gen.js            ship and station assembly and baking (pure JS, runs in workers and Node)
  app.js            the lab: yard and ship views, tabs, UI
  fly.js            flight simulation and instanced rendering
  planets.js        planet shader and builder
  suns.js           star, pulsar and black hole shaders, lens flare, builder
  stations.js       stations and heavies tabs: bakes via gen.js, builders
  asteroids.js      asteroid shader and builder
  template.html     lab page shell and styles
tools/
  build.py          compiles core/ to WASM and assembles it with src/ into index.html and play.html
  check.js          boots the page against a stub WebGL context and validates every shader
  core-test.js      core unit tests, native vs WASM state hashes, and a WASM session replayed natively
  fly-smoke.py      drives the lab's Fly tab in headless Chromium: speeds, seeded replay, clock rate
  play-smoke.py     drives the game page: start landed, the market, the mission board and a delivery, flight, a port visit, save and load, a browser session replayed natively
  validate.js       validates every system file against its schema, and checks the clamp itself
  dev.js            dev server: rebuilds on change, live-reloads both pages
  preview.js        CPU bake of the whole catalog to a PNG grid
```

## Develop

```
npm install          # dev tools only: PNG writer and glslangValidator
npm run dev          # serve on :8000 (all interfaces; lab at /, game at /play.html), rebuild on save, live reload
npm run build        # core/ -> WASM, then src/ + WASM -> index.html and play.html
npm run check        # build, validate all shaders and systems, run the core tests and the determinism checks
npm test             # core tests and the determinism checks only
npm run preview      # bake every ship on the CPU -> preview.png
```

Building needs Rust with the WASM target (`rustup target add wasm32-unknown-unknown`). `python3 tools/build.py --skip-core` reuses the last compiled core. The browser smoke tests need Playwright for Python: `python tools/fly-smoke.py` and `python tools/play-smoke.py` (on the dev box, use `~/.venvs/web/bin/python`).

In the lab, `__fly.sim` is the core: `__fly.sim.param('damper', 0.8)` retunes live, `__fly.reset(seed)` starts a seeded sector, and `__fly.probe()` reports the tick and state hash. In the game, `__play` does the same (`__play.newGame(seed)`, `__play.advance(sec, keys)`, `__play.probe()`), plus `__play.teleport(body)`, which puts the flying player at rest over a body as a logged command, so a session that uses it still replays.

To rerun a session exported from the game (Export replay downloads the starting snapshot and the input log; the log's header has the exact command and the hash to expect):

```
cd core && cargo run --release --bin replay -- driftward-save.bin driftward-inputs.txt <ticks>
```

## Design

[The Book](docs/book.md) describes every game mechanism, tagged by the milestone that builds it, along with the build staging (M0 to M9), the M1 scope and the faction names. It is an export of the design doc; update it by re-exporting rather than editing it here.

[M1 progress](docs/m1-progress.md) tracks the first playable milestone: what is done and what is left. [Known issues](docs/known-issues.md) lists the performance costs and bugs we know about but have not fixed yet.

## Roadmap

- One JSON Schema for brands, planets and suns, used both as the LLM contract and as the validator that clamps its output
- Palette generator (OKLCH) so the LLM picks palette intent rather than raw hex
- Galaxy sim: systems, economy and NPC traffic driven by supply and demand
- Planet and star specs inside the flight sector
- LLM-authored brands, systems and mission arcs

## License

MIT. See [LICENSE](LICENSE).
