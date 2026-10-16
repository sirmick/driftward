# Data audit: the universe's JSON, and loading it on demand

Status: **audit, 2026-10-16; nothing below is built yet.** This is the brief for the next session: what data the game has, where each piece lives and what checks it, the gaps between the layers, and the proposed restructure into a universe index plus systems loaded on demand.

## What exists today

| Layer | File(s) | JSON? | Schema? | Made by | Notes |
| :-- | :-- | :-- | :-- | :-- | :-- |
| Universe canon | `src/lore/setting.md` | prose | – | by hand | fed to every lore and story prompt as canon; fine as prose |
| Region notes | `src/lore/regions/<region>.md` | prose | – | by hand | only `calder-march.md` so far; canon for that region's stories |
| Real stars | `src/galaxy/stars.json` (472 KB) | ✓ | ✗ | `tools/hyg.py` | only the map needs it (its background stars, the catalogue view) |
| Map: systems, lanes, factions, regions, the Drift | `src/galaxy/galaxy.json` (252 KB) | ✓ | ✗ | `tools/galaxy.py` | ~930 systems (596 charted, ~333 generated Drift), ~1,130 lanes |
| Worlds: people, tier, port roles, wealth, security, unrest; region trade | `src/galaxy/worlds.json` | ✓ | ✗ | `tools/worlds.py` | 150 settled systems, keyed by star id |
| Stories: region summaries, system bullets | `src/galaxy/stories.json` (192 KB) | ✓ | ✗ | `tools/stories.py` | all 28 regions, 338 systems |
| **System** (star, planets, moons, stations, ports, belts, fields, traffic) | `src/systems/*.json` | ✓ | **✓** `src/schema/system.schema.json` | by hand | 6 systems (the Calder March); clamped by `src/schema.js`, checked by `tools/validate.js` |
| **System lore** (history, culture, art bible, ports, people, rumours, vistas) | `src/lore/<id>.json` | ✓ | **✓** `src/schema/lore.schema.json` | `tools/gen-content.js` | the same 6 systems |
| Ships, stations, factions' looks | `src/catalog.json` | ✓ | ✗ (enums cross-checked in `validate.js`) | by hand | |
| Star and planet looks | inside each system file | ✓ | ✓ (system schema) | by hand | the map's per-class looks are code (`STAR_LOOKS` in `src/map/map.js`) |
| Art | `art/<id>/*.webp`, `art/<id>/log.json` | log ✓ | ✗ | `tools/gen-content.js` | the build makes the manifest from the folder; images load on demand already |
| Economy (commodities, prices by port role) | `src/economy.json` | ✓ | ✗ (checked in `validate.js`) | by hand | |
| Traffic (hulls by culture and role, population weights) | `src/traffic.json` | ✓ | ✗ (checked in `validate.js`) | by hand | |
| Generation records | `src/lore/*.log.json`, `src/galaxy/stories.log.json` (604 KB), `art/*/log.json` | ✓ | ✗ | the generators | debug only |

Everything above is inlined into `play.html` (2.8 MB) and `map.html` by `tools/build.py`; the debug screen shows all of it (Content, Regions, Planets, Map tabs).

## Gaps and inconsistencies

1. **No path from the map to a flyable system.** Only the 6 March systems have system files; the galaxy links an entry to its file through a `system` field that only those 6 carry. Nothing turns a galaxy entry plus its world into a system file, so ~590 systems exist on the map only.
2. **Two vocabularies for the same things.**
   * Faction keys: system files say `owner: federation | prism | ironhulls | blackhulls | freeflag | bloom | glass | shadow | none`; the galaxy says `faction: fed | iron | prism | free | black | indep` (and has Independents, which the system schema lacks).
   * Population tiers: system ports use `outpost | colony | town | world`; worlds use `outwatch | outpost | colony | town | world`, plus a `builtworld` flag. The system schema has no outwatch or Builtworld; the thresholds differ.
   * Port roles and star classes do match (`economy.json` roles = the system schema's role enum; the twelve star classes everywhere).
3. **Facts duplicated, no single source of truth.** Brannock's people are in the March's region notes (4 billion), its system file's port tiers, and `worlds.json`; its owner in the system file and the galaxy; its ring and region in both. Nothing checks they agree.
4. **Lanes never reach flight.** The galaxy has lanes (length, days, border and Drift flags); system files have four fixed jump zones (north, east, south, west, `traffic.jumpRadius`). The Book wants a zone per outbound lane, on the bearing toward its destination, coloured by destination.
5. **A region's data is in four places:** its name (`galaxy.json` regions), its trade (`worlds.json` regions), its summary (`stories.json` regions), its notes (`lore/regions/*.md`). There is no region object and no region schema.
6. **The core save holds every system** (`core/src/atlas.rs`: every system's layout, saved with the world). Fine for 6; not for 900.
7. **Galaxy reruns break downstream data.** Worlds and stories are keyed by star id, but a galaxy rerun can rename, re-own or re-region systems. There is no check that worlds and stories still match the galaxy they were made from (record the galaxy's hash in each).

## Proposed structure

**A universe index, loaded at start** (`universe.json`, one file, roughly 200–300 KB compact):
* `factions`: id, name, colour (one vocabulary, used by system files too);
* `regions`: id, name, kind (heartland, march, frontier, Drift sector, alien, hazard), summary, notes (the markdown, moved in or referenced), trade (exports, imports), borders;
* `lanes`: from, to, ly, days, `border`, `drift`;
* `systems`: the index entry per system: id, name, star (position, class, catalogue name), region, owner, status, ring, people and tier, port roles, wealth, security, unrest, years (settled, charted, emptied, lost), tags (hazard, front, gateway, exclave, provisional), story bullets, and `file` when a hand-written system file exists.

**Per system, loaded on demand:** `systems/<id>.json` (the flyable layout), `lore/<id>.json` (ports, people, rumours), `art/<id>/` (already on demand).

**Debug and map extras, loaded when opened:** `stars.json` (the real-star catalogue, for the map's background), every generation log.

**Systems without a file:** a system's flyable layout is **generated on first visit** from its index entry (star class, people, tier, port roles, owner, lanes) and a seed, then cached in the save; a hand-written file overrides it (as the March's do). This is the Book's "Drift systems are generated on first contact", extended to all unauthored systems.

**Schemas:** `src/schema/universe.schema.json` (faction, region, lane, system-index entry), validated in `npm run check` alongside the system and lore schemas, plus cross-checks: every system file agrees with its index entry (owner, ring, region, people's tier), worlds and stories match the galaxy's hash.

## The decision to make first

How the pages load on demand. Today `play.html` is one self-contained file that opens from disk (`file://`), where browsers block `fetch`.
* **(a) Inline, parsed lazily:** the build puts each system in its own `<script type="application/json">` and the game parses one when needed. Still opens from disk; every system is in the download.
* **(b) Fetch:** the page fetches `universe.json` and `systems/<id>.json`. Truly on demand; must be served (`npm run dev` or a host); no longer opens from disk.
* **(c) Both,** behind one async `loadSystem(id)`; the build picks inline or fetch. **Recommended:** fetch for the hosted game, inline for a self-contained build.

## Suggested order

1. **One vocabulary:** faction keys and population tiers agreed across the system schema, the galaxy and worlds (add Independents and the outwatch to the system schema; Builtworld as a body or port flag).
2. **`universe.schema.json` and `universe.json`:** built by a step that merges `galaxy.json`, `worlds.json`, `stories.json` and the region notes; validated in `npm run check`, with the cross-checks above.
3. **The loader:** `loadUniverse()` and `loadSystem(id)` behind (a)/(b)/(c); the game, the map page and the debug screen read through it; the core's atlas holds only the systems visited.
4. **Generated systems:** a system file from an index entry and a seed (`tools/` for previewing, the same code in the page for first visits), validated by the system schema.
5. **Lanes drive jump zones:** each outbound lane a zone on its bearing; travel between systems by lane (today only the debug jump moves between systems).

Related: `docs/galaxy.md` (how the map, worlds and stories are made), `docs/book.md` (the design: galaxy map, the Drift, jumping), `README.md` (the files).
