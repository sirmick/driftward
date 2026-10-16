# The universe's data: one index, systems loaded on demand

Status, 2026-10-16: **steps 1 to 3 of the plan below are built; 4 and 5 are next.** This file records what the game's data is, where each piece lives and what checks it, what was built and decided, and the brief for the next session.

## What exists now

| Layer | File(s) | Schema? | Made by | Notes |
| :-- | :-- | :-- | :-- | :-- |
| Universe canon | `src/lore/setting.md` | – | by hand | fed to every lore and story prompt as canon; prose |
| Region notes | `src/lore/regions/<region>.md` | – | by hand | only `calder-march.md` so far; merged into the index as the region's `notes` |
| Real stars | `src/galaxy/stars.json` (472 KB) | ✗ | `tools/hyg.py` | only the map reads it |
| Map: systems, lanes, factions, regions, the Drift | `src/galaxy/galaxy.json` | ✗ | `tools/galaxy.py` | a source for the index; the faction keys are now the system schema's |
| Worlds | `src/galaxy/worlds.json` | ✗ | `tools/worlds.py` | a source for the index; records the galaxy hash it was made from |
| Stories | `src/galaxy/stories.json` | ✗ | `tools/stories.py` | a source for the index; each region records the galaxy hash it was told from |
| **Universe index** | `src/galaxy/universe.json` (447 KB) | **✓** `src/schema/universe.schema.json` | `tools/universe.py`, on every build | factions, regions, every system once by star id, lanes; what the game, the map and the debug screen read |
| **System** (the flyable layout) | `src/systems/*.json` | **✓** `system.schema.json` | by hand | 6 systems (the Calder March); each must agree with its index entry |
| **System lore** | `src/lore/<id>.json` | **✓** `lore.schema.json` | `tools/gen-content.js` | the same 6 |
| Ships, stations, factions' looks | `src/catalog.json` | ✗ (enums cross-checked) | by hand | |
| Art | `art/<id>/*.webp`, `art/<id>/log.json` | ✗ | `tools/gen-content.js` | the build lists what exists; images load on demand |
| Economy, traffic | `src/economy.json`, `src/traffic.json` | ✗ (checked in `validate.js`) | by hand | `economy.json`'s `start.system` is where a new game begins |
| Generation records | `src/lore/*.log.json`, `src/galaxy/stories.log.json`, `art/*/log.json` | ✗ | the generators | debug only, read when the debug screen asks |

`npm run check` validates the index against its schema and checks:
* worlds and stories were made from the galaxy as it is (the hashes match);
* every reference resolves (regions, owners, lane ends);
* every system file agrees with its entry: name, owner, ring, region, star class; its ports' roles are exactly the world's; no port's tier is above the system's; a Builtworld where the index has one.

## How the pages get it

`src/data.js` is the one way in, for the game and the map page alike. Every file is read once, asynchronously:

| File | What | Read |
| :-- | :-- | :-- |
| `universe.json` | the index | at start |
| `systems/<id>.json` | the system file, its lore, its art manifest | the first time the game needs that system |
| `logs/<id>.json` | how its lore and art were made | when the debug screen's Content tab shows it |
| `stars.json` | the real stars | when a map is drawn |
| `galaxy-log.json` | the setting and the stories' call log | when the Regions tab opens |

**The decision: (c), both.** `npm run build` writes self-contained pages (each file inline in its own `<script type="application/json" data-file=...>`, parsed when first asked for), so `play.html` still opens from disk. `npm run build:hosted` writes `dist/`: the same pages without their data, `dist/data/` with each file, and `art/`. Serve that directory: `play.html` drops from 2.8 MB to 0.9 MB plus what is visited. `tools/play-smoke.py dist` serves and tests the hosted build. Both builds pass every check.

**The atlas holds only the systems visited** (`core/src/atlas.rs`):
* Each of its 8 slots carries its system's star id. A new game empties it and lays out the start system.
* A jump to a system not in the atlas reads its file if it must (the jump then returns a promise), lays it out, stores it, then jumps.
* When every slot is full, a new system takes the first slot the player isn't in and has no active mission to.
* A store mid-session goes into the replay log as `tick atlas k <hex>`: the slot's bytes, about 8 KB, since a native replay has no page to lay a system out. A replay puts them back on the same tick.
* Loading a save reads any system in its atlas the page hasn't read yet, then loads.
* The save format is version 17; older saves don't load.

## What changed in the vocabulary

* **Faction keys:** one set everywhere, the system schema's: `federation`, `ironhulls`, `prism`, `freeflag`, `blackhulls`. Plus `independent`, which the system schema gained. The galaxy tools and `galaxy.json` were renamed to them (a rename in place, no rerun).
* **Owner:** the index's `owner` is a system's faction, else the alien power whose space it is (`bloom`, `glass`, `shadow`), else `none`. That is the system schema's owner vocabulary, so a system file's owner must equal its entry's.
* **Population tiers:** a port's `population` gained `outwatch`, and a port gained `builtworld`. The traffic weights, city lights, orbiting traffic and the vista prompts' crowd text all know both.
* **Not done:** the index keeps the galaxy's field names as they were (`settled`, `charted`, `gateway`, `exclave` and the rest, flat on each system) rather than the grouped `years` and `tags` first sketched. Regions have no `kind` (heartland, march, frontier...): nothing in the data says it yet.

## Gaps that remain

1. **No path from the map to a flyable system** beyond the 6 hand-written files (step 4).
2. **Lanes never reach flight:** system files still have four fixed jump zones; the Book wants one per outbound lane, on its bearing (step 5).
3. **Facts are still written twice:** a system file's owner, ring, region and port roles repeat its index entry. They are now checked to agree, not derived. Generated systems (step 4) will take them from the entry directly.
4. **The jump box reads every flyable system** when it gets focus, so it can complete `place@system`. That's fine for 6 files. With generated systems it should list systems from the index and read one only when it is picked.
5. **A full atlas forgets a system's layout,** not its missions' history: a delivered or failed mission bound for an evicted slot names a port of whatever system now holds that slot. Only past 8 systems in one game; active missions keep their slot.
6. **The region notes are only the March's.** The index carries notes for any region that has a file.

## Next: steps 4 and 5

4. **Generated systems:** a system file made from an index entry and a seed: star class, people and tier, port roles, owner and lanes in; a layout that passes `system.schema.json` and the same cross-checks out.
   * The same code for `tools/` (preview, validate many) and for the page, which makes a system on first visit.
   * `loadSystem(id)` in the page falls back to it when the entry has no `file`; a hand-written file overrides it, as the March's do.
   * The atlas already takes any star id, and a stored layout already reaches replays, so a made system replays like a written one.
5. **Lanes drive jump zones:** each outbound lane a zone on its bearing toward its destination, coloured by destination, replacing the four fixed zones (`traffic.jumpRadius`, the core's jump lanes). Then travel between systems by lane, not only the debug jump.

Related: `docs/galaxy.md` (how the map, worlds and stories are made), `docs/book.md` (the design: galaxy map, the Drift, jumping), `README.md` (the files).
