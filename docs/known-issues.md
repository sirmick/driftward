# Known issues

Problems we know about and have chosen not to fix yet. Remove an entry when it is fixed.

## Performance

None of these hurt at today's scale (about 60 ships). They are the costs that grow first.

- **Hull fill cost.** The ship fragment shader (`SHIP_FS` in `src/shaders.js`) runs up to 28 self-shadow samples and 16 point lights per pixel. Cost follows screen area, not ship count: a zoomed-in capital ship costs more than a hundred distant fighters. Options: fewer shadow steps at low zoom, a light cap per ship size, or skipping shadows for hulls under a few pixels.
- **Bolts against ships is all pairs.** Each bolt tests every live ship each tick (bolt loop in `postTick`, `src/fly.js`). The Book plans a grid broadphase; it belongs in the core's pairwise stage when weapons move to Rust.
- **Sensor transmission sampling.** Each NPC's detection of the player marches gas samples along the line between them every tick (`transmission` in `src/fly.js`). Fine at 60 ships; should drop to 5 Hz and a coarser march as traffic grows, as the Book's tick table says.
- **Per-frame allocations in the flight renderer.** `gatherLights` builds and sorts a fresh index array; `render` allocates plume uniform arrays and a type order array per frame and a shield instance array literal per ship. Causes garbage-collection hitches over long sessions. Reuse preallocated arrays.
- **Instance uploads reallocate.** `upload` calls `bufferData` for every draw. Allocate once at capacity and use `bufferSubData`.
- **Planet fill cost.** The planet shader adds noise layers as you zoom in (up to 12 for terrain, 10 for clouds, plus ridges and craters): roughly 30 to 40 3D noise samples per planet pixel when a planet fills the screen, against 10 cheaper 2D ones before. Expect a few milliseconds at 1080p on a mid GPU, more at 4K or on integrated graphics. If it bites: cap the layers by a quality setting, or bake the base surface (option 2 in the planet detail discussion) and keep only the close-up layers procedural.
- **Bake time.** Large hulls and stations take noticeable time to bake in the workers, and a catalog edit rebakes everything. Only the changed brand or archetype needs rebaking. Each finished bake also uploads four textures with mipmaps on the main thread, which hitches a frame; the lab bakes the whole catalog at startup, while the game bakes a type only when a ship of it first needs drawing.

## Structure

- **Two flight renderers.** The lab's Fly tab (`src/fly.js`) and the game (`src/play/play.js`) each build their own instanced ship and plume draws from the same shaders. The game's is the one that grows; the Fly tab should move onto it once it covers shields, bolts and particles.
- **The lab page has no doctype.** `src/template.html` starts at `<title>`, so the lab renders in quirks mode. The game page has one.

## Gameplay gaps

- **Ships fly through planets.** Nothing collides, and a well's pull fades out near a body's centre, so a dive carries a ship straight through and out the far side. Landing (M1) needs a surface: approach speed limits, a landing zone, and what happens on impact.
- **The well model is untuned game physics.** Wells pull with a share of each hull's thrust and bend its top speed by direction (`core/src/flight.rs`); a slingshot works as momentum carried through a well, not as a speed gain. The numbers (`pull`, `well_in`, `well_out`, `well_reach`, and each hull class's `well` in the catalog) are first guesses, tunable live from the console.

- **Bodies hold still.** Planets, moons and stations sit at fixed points (EV style), so "slow relative to the port" is just "slow"; the Book's orbiting and spinning stations, where assist matches their velocity, come later. Stations spin only visually.
- **Ports are screens without services yet.** Trade, the mission board, the bar and refuel and repair are shown but disabled until M1's next steps; only wait-a-day and launch work.

## Bugs

- **Black squares flashed over the canvas (symptom fixed, source unconfirmed).** Seen on both pages on the user's GPU, never under the headless software renderer. Turning bloom off stopped them, which fits one bad (NaN or infinite) scene pixel being spread by the bloom chain's six half-size levels into squares of 2 to 64 pixels. The bloom bright pass now drops non-finite samples and caps hot ones, and the composite ignores bad bloom texels. What still makes the bad pixel on that GPU is unknown: on the game page, N paints raw non-finite scene pixels magenta (bloom cyan, negative values yellow), which would locate it; B toggles bloom.
