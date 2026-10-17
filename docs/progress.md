# Progress against the Book's milestones

Status, 2026-10-17: from an audit of every milestone-tagged line in [the Book](book.md) (about 400) against the code and data. M1 has its own tracker, [m1-progress.md](m1-progress.md); the data work is [data.md](data.md). Update this as milestones move.

## Where each milestone stands

| Milestone | State | In short |
| :-- | :-- | :-- |
| **M0** Flight lab | **Done** | The three-level assist and full-off rotation, the last open items, are in the core and the game. No weapon recoil anywhere. |
| **M1** Trade and delivery | **Exit test passes; a few items open** | Open: the full daily tick, mission templates, news and intel in port, the debug API's actions, ships grouped by type. Sensors, stellar radiation and flares moved into the core on 2026-10-17. See [m1-progress.md](m1-progress.md). |
| **M2** Combat | **Not started in the core** | 0 of 48 in the game. 12 exist only in the lab's frozen prototype (`src/fly.js`): heat and overheat, shield regen and collapse, a bolt gun, hits on the silhouette, fleeing. The core ignores the fire key. Built early in M1: hull points, landed repair, fuel. |
| **M3** Assets and set pieces | **Mostly not started** | 4 of 35 partial: the per-system ship mix, the heavy hulls (lab only), weapon counts by class, rock compositions (visual only). No boarding, mining, capital landers, derelicts, or Blackhull and Freeflag lines. |
| **M4** Several systems | **Jumping built; the rest not started** | Scope met: the six March systems, joined by lanes. Built: the galaxy map, jump zones per lane with buoys, the torch jump with fuel and days per lane, the transit, chain jumping along a course ([jumping.md](jumping.md)). Not started: intel snapshots, interdiction, missions between systems, flight running the clock, misjump. |
| **M5** Economy | **Not started** | Fixed prices. Built early: the LLM lore and story pipeline (seeded, cached, committed), each region's trade balance in the data. |
| **M6** Law and standing | **Not started** | Inputs exist as data only: security per system, pirate havens, faction lines, the bar's named people. |
| **M7** Factions | **Not started** | Inputs as data: owners, unrest, the front, exclaves and choke points, populations and settlement tiers, the timeline. In the sim: a landing costs a day; liner traffic follows population. |
| **M8** The Drift | **Not started** | The Drift's shape is authored: depth 1 to 8, sectors, 421 drift lanes, gateways, 333 generated stars. No exploration mechanics. |
| **M9** Full galaxy | **Not started** | The Bloom, the Glass and the Shadow exist as lore, statuses and map colours. |

## What is ahead of the Book

- **The galaxy:** 929 systems, 1,133 lanes, factions, regions and the Drift chosen as mixed-integer programs from real stars (`tools/galaxy.py`), with every settled system's people, ports and wealth (`tools/worlds.py`) and backstories (`tools/stories.py`). The Book plans about 100 playable systems; the map holds the whole setting.
- **The universe index and loading** ([data.md](data.md)): one schema-checked index; systems, lore and art read when first needed; a hosted build that fetches them.
- **Schemas for every data file**, cross-checked in `npm run check`.
- **The galaxy map** (M4): courses by days or jumps, system cards, mission markers.
- **Lore and art** for all six March systems, and the debug screen that shows how each was made.
- **Fuel, hull, hazards and death** (M2 and M4 items) and twelve star classes with binaries.

## What stands in the way

- **The M4 exit test needs combat.** It asks for cross-system cargo *and bounty* runs, and interdiction at jump zones: M2's weapons, shields and pirates (and M3's drag field, or M2's ion weapons) come before it can pass.
- **Combat is a fresh design.** Everything combat-shaped is in the lab's frozen JavaScript, which the game does not use; M2 builds weapons, energy, heat, shields and damage as core columns.
- **Missions between systems** are the next M4 piece now jumping works (traffic already torches out and blinks in at the zones).
- **Beyond the March needs generated systems** ([data.md](data.md), step 4): only six of 929 systems can be flown.

## Fixed in the audit

- Six distances on the sim path (landing, radiation, moving stations) used the platform's `f64::hypot`, which can round differently natively and in WASM; they use the core's own now, so replays stay bit-identical by construction.
- The Book's M0 row (it listed the assist work as remaining) and its controls (M is now the galaxy map, Shift+M the system map).
