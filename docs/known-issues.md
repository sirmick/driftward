# Known issues

Problems we know about and have chosen not to fix yet. Remove an entry when it is fixed.

## Performance

None of these hurt at today's scale (about 60 ships). They are the costs that grow first.

- **Hull fill cost.** The ship fragment shader (`SHIP_FS` in `src/shaders.js`) runs up to 28 self-shadow samples and 16 point lights per pixel. Cost follows screen area, not ship count: a zoomed-in capital ship costs more than a hundred distant fighters (empty texels in the quad's shield margin now discard before the march, so only the hull's own pixels pay). Options: fewer shadow steps at low zoom, a light cap per ship size, or skipping shadows for hulls under a few pixels.
- **Bolts against ships is all pairs.** Each bolt tests every live ship each tick (bolt loop in `postTick`, `src/fly.js`). The Book plans a grid broadphase; it belongs in the core's pairwise stage when weapons move to Rust.
- **Sensor transmission sampling.** Each NPC's detection of the player marches gas samples along the line between them every tick (`transmission` in `src/fly.js`). Fine at 60 ships; should drop to 5 Hz and a coarser march as traffic grows, as the Book's tick table says.
- **Per-frame allocations in the flight renderer.** `gatherLights` builds and sorts a fresh index array; `render` allocates plume uniform arrays and a type order array per frame and a shield instance array literal per ship. Causes garbage-collection hitches over long sessions. Reuse preallocated arrays.
- **Instance uploads reallocate.** `upload` calls `bufferData` for every draw. Allocate once at capacity and use `bufferSubData`.
- **Planet fill cost.** The planet shader adds noise layers as you zoom in (up to 12 for terrain, 11 for clouds, plus ridges, craters at up to five sizes, and city lights), and marches the atmosphere in 8 steps (16 at the limb): roughly 45 to 55 3D noise samples per terran pixel at the closest zoom (a fighter at full zoom, 175 m across), about 25 to 30 for giants and rocks. Expect a few milliseconds at 1080p on a mid GPU, more at 4K or on integrated graphics. If it bites: cap the layers by a quality setting, or bake the base surface (option 2 in the planet detail discussion) and keep only the close-up layers procedural.
- **A slow GPU drops frames at close zoom.** Measured on 2026-10-16 on a Radeon 890M (integrated) at 2240x1200: the scene took about 17 ms of GPU at full zoom over a planet, so frames missed 60 Hz about one in twenty and the view lurched 1 to 4 px; the page's own CPU time was about 1 ms. The render resolution now drops (Auto, in Settings) when frames run late, which costs sharpness at close zoom on such GPUs. Cheaper planet detail at close zoom would let them keep full resolution. The jitter probe (J, or a dev state report) shows frame, GPU and CPU times.
- **Many station bakes at the start.** Environmental stations share bakes by archetype, owner and seed (two seeds each), but a system with several types still bakes them all at load, and every hull type traffic can fly is baked up front.
- **The live-clock smoke check is load-sensitive.** `tools/play-smoke.py` measures ticks per second through the software renderer, so it fails (10 to 45 ticks/s) whenever the machine is busy with other work; on a quiet machine it reads about 60.
- **The HUD and map redraw everything every frame.** `drawHUD` rebuilds nav objects and mission lists per frame; the location list is rebuilt with `innerHTML` four times a second; the map redraws its static orbits and labels. Cache strings, update in place, and draw the map's static layer once offscreen.
- **Full-screen passes run at device resolution.** The sky's nebula (two 5-octave noise sums per pixel, very low frequency) and the scene and bloom targets follow the canvas at up to 2× pixel ratio. A quarter-resolution nebula and a render-scale setting would cap it.
- **Per-tick waste in the core.** Wells take a `hypot` for every ship and body before the reach test; `traffic_count` counts ships on every spawn; orbiters recompute their orbit normal every frame. Measured on 2026-10-15: a tick with 51 traffic ships takes about 1.1 µs natively, so none of this matters yet.
- **Bake time.** Large hulls and stations take noticeable time to bake in the workers, and a catalog edit rebakes everything. Only the changed brand or archetype needs rebaking. Each finished bake also uploads four textures with mipmaps on the main thread, which hitches a frame; the lab bakes the whole catalog at startup, while the game bakes a type only when a ship of it first needs drawing.

## Structure

- **Two flight renderers.** The lab's Fly tab (`src/fly.js`) and the game (`src/play/play.js`) each build their own instanced ship and plume draws from the same shaders. The game's is the one that grows; the Fly tab should move onto it once it covers shields, bolts and particles.
- **The Fly tab is a frozen prototype.** `src/fly.js` keeps hp, shields, cooldowns, AI, waypoints, sensor tracks, bolts and the player's heat and fuel in JS arrays, outside the snapshot and the state hash, and its `playerInput` re-implements `player.rs`. Decided 2026-10-15: it is not migrated. Combat, AI and sensors get built in the core, as column groups, when the game's milestones need them; the Fly tab stays as it is until then, and goes once the game covers what it shows.
- **The lab's light presets are a separate list.** Stars are one format since 2026-10-16 (`src/stars.js`: the schema's twelve classes, drawn by one kit in the game and its debug screen's Suns tab), but the lab's star-light buttons still pick from `look.js`'s five `STARS` presets, which five of the classes borrow their light from.
- **Look decisions hardcoded in the planet shader.** Sea level, the cloud threshold, biome, ice, surf and storm colours, lightning and city-light colours are constants, so an author cannot ask for an arid terran world or no ice caps. Debris and orbital traffic counts per surface are fixed in `play.js` and estimated again in `gen-content.js`.
- **Defaults that disagree.** Traffic defaults are repeated in `core/src/world.rs` with no bounds.
- **Content without a schema.** `catalog.json`, `economy.json` and `traffic.json` are checked only piecemeal by `tools/validate.js`; faction enums in the system schema are copied from the catalog by hand and already disagree (`brandOf` accepts line ids the enum rejects).
- **Cross-references at runtime.** `npm run check` now catches duplicate ids, orbits inside their parent, bodies past the jump radius and repeated services, but the game itself still drops traffic lines and loiter ports that don't match without a word, and a station's `radius` is its docking zone while the core uses 0.6 of it.
- **No model has written a system.** `gen-content.js` authors lore only, so `system.schema.json` is untested as an LLM-facing contract.
- **The lab page has no doctype.** `src/template.html` starts at `<title>`, so the lab renders in quirks mode. The game page has one.

## Gameplay gaps

- **Ships fly through planets.** Nothing collides, and a well's pull fades out near a body's centre, so a dive carries a ship straight through and out the far side. Landing (M1) needs a surface: approach speed limits, a landing zone, and what happens on impact.
- **The well model is untuned game physics.** Wells pull with a share of each hull's thrust and bend its top speed by direction (`core/src/flight.rs`); a slingshot works as momentum carried through a well, not as a speed gain. The numbers (`pull`, `well_in`, `well_out`, `well_reach`, and each hull class's `well` in the catalog) are first guesses, tunable live from the console.

- **Station orbits pass through things.** Stations circle their world at real-orbit pacing, so they pass each other, and their orbits may sweep through a moon or another body's stations (Gaunt's stations through Rime's, at Ostry). Nothing collides; the sprites draw on top of each other, and a ship over two docking zones lands at the nearer.
- **Station bakes are big.** At twice their old resolution, each station bake is four 1280 to 1792 px RGBA textures with mipmaps, about 50 MB of GPU memory; a system with nine distinct station bakes holds about 450 MB, and bakes from systems left behind stay cached. If it bites: drop the resolution of environmental stations, or free the bakes of systems the player has left.
- **Radiation has no warning but the HUD.** A hazard zone shows on the radar and map and the HUD gives the dose, but there is no alarm, screen effect or edge-of-zone cue yet; a pilot who isn't watching the HUD can fly into a black hole's zone and lose the ship.
- **News and intel are not built yet.** Every other port service works.
- **Mission pay is untuned.** Pay is a 200-credit base plus 2 credits per ton per kilometre, so small loads pay far more per ton than big ones, and the board does not yet weigh offers by what the player's ship can carry (the Book's M6 weighting).
- **The lender has no teeth.** The debt gathers interest, and you can repay it at any port, but nothing happens if you never do.

## Bugs

- **Nav overlay labels overlap** when two off-screen bodies lie in nearly the same direction: their edge arrows and labels draw on top of each other.

- **Black squares flashed over the canvas (symptom fixed, source unconfirmed).** Seen on both pages on the user's GPU, never under the headless software renderer. Turning bloom off stopped them, which fits one bad (NaN or infinite) scene pixel being spread by the bloom chain's six half-size levels into squares of 2 to 64 pixels. The bloom bright pass now drops non-finite samples and caps hot ones, and the composite ignores bad bloom texels. What still makes the bad pixel on that GPU is unknown: on the game page, N paints raw non-finite scene pixels magenta (bloom cyan, negative values yellow), which would locate it; B toggles bloom.
