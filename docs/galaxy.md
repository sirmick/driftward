# The galaxy map: how it was made

How the game's star systems, jump lanes and faction territories were chosen, and how to run it again. The map is in `src/galaxy/galaxy.json`; the code is `tools/hyg.py`, `tools/galaxy.py`, `tools/mip.py` and `tools/galaxy_names.py`; the setting it follows is `src/lore/setting.md`. You can see the result in `map.html`, or in the game's debug screen (backquote) on its Map tab.

## The stars

The map is built on real stars. `tools/hyg.py` downloads the HYG database (v4.1, astronexus, CC BY-SA 4.0: credit the source, and anything derived from the data is share-alike) and writes `src/galaxy/stars.json`:

* **What's included:** every star system within 80 light years of Sol, and out to 100 ly toward the galactic core, where the Shadow is. That's 2,780 systems, with companions folded into their primary (Sirius B goes with Sirius).
* **Positions** are in light years in galactic coordinates: +x toward the galactic core, +z galactic north. The x–y plane is the galactic plane, which the map draws as its floor.
* **Each star gets one of the game's star classes** (`src/stars.js`), taken from its spectral type. When the type is missing, the class is guessed from colour and brightness.
* **Names:** stars use their proper name where they have one, then the spelled-out Bayer or Flamsteed name ("Tau Ceti", "61 Cygni"), then a catalogue number ("Gl 65A"). Rigil Kentaurus and Ran go by the names people use: Alpha Centauri and Epsilon Eridani.

What the neighbourhood holds:
* **No exotic objects nearby:** there are no real neutron stars, black holes or quasars within range. The nearest are hundreds of light years or more away. Pulsars and black holes appear only in the generated Drift.
* **Red dwarfs dominate:** they're about half the catalogue, and white dwarfs number about 140.
* **The catalogue thins with distance:** it misses faint stars, especially past 60 ly. Real space there is denser than the data, which is one reason the edge of the map looked thin and why the deep Drift is generated.

## The approach

A galaxy for this game needs things that pull against each other: real geography, quotas from the setting, everything connected, lore-specific places (the Calder March, the Glass, Corran), and fairness between factions. Hand-placing 600 systems couldn't balance all of those, and simple rules couldn't either. So the choices are made by **mixed-integer programs** (MIPs). Each requirement is written as a constraint, each preference as a cost, and a solver finds the best map that meets all the constraints.

* **Solver:** HiGHS, through `scipy.optimize.milp`. scipy is the only dependency, and it's already on the dev box.
* **Modelling layer:** `tools/mip.py` is a small layer over the solver: binary and continuous variables, constraints written as `{variable: coefficient}`, and an objective.
* **Finding conflicts:** constraints can be tagged with a group name. When a model is infeasible, `diagnose()` solves it again with slack on every tagged constraint and reports which groups had to give way. That's how every conflict below was found.
* **Seeded:** everything is seeded (2526), so the same inputs give the same map.

### Why it's staged

Solving everything in one model doesn't work. Choosing stars and lanes together was about 23,000 variables, and HiGHS found nothing in five minutes. So the work is split into stages, each feeding the next:

1. **Systems:** which stars are in the game, and in what role.
2. **Territories:** who holds what, decided on the lanes that *could* exist.
3. **Lanes:** which lanes actually exist, knowing the territories.
4. **The deep Drift:** grown outward from the edge rather than optimised.
5. **Names and years.**

The order of stages 2 and 3 matters. With lanes first and territories second, the lanes came out radial (spokes from Sol). A faction living in a ring then had nothing to hold its territory together, and the Ironhull Compact ended up in six pieces on opposite sides of Sol. Deciding territories first and then building lanes inside them fixed it.

## Stage 1: systems

**What's decided:** for each candidate star, at most one role: **inhabited** or **dead** (human space), **Drift** (dead stars round the edge, past the outer ring), **Bloom** (living or dead), **Shadow**, or **Glass**.

**Zones**, by distance from Sol:

| Zone | Distance | Roles |
| :-- | :-- | :-- |
| Inner ring | 0–22 ly | inhabited, dead |
| Middle ring | 22–42 ly | inhabited, dead, Glass |
| Outer ring | 42–65 ly | inhabited, dead |
| Exterior | 65–82 ly | Drift |
| Bloom | a ball 58 ly out above the galactic plane, 24 ly across, away from the core | Bloom living, Bloom dead |
| Shadow | past 65 ly, within a cone toward the core | Shadow |

The far zones' candidates are thinned to keep the model small: 520 for the outer ring and 330 for the exterior, named stars kept first. That leaves 1,711 candidate stars.

**Constraints:**
* **Counts per ring:** 45/50/55 inhabited (inner/middle/outer), 45/82/145 dead, 100 Drift (6–22 in each of the eight sectors round the galactic pole), 30 Bloom worlds and 16 dead Bloom systems, and 24 Shadow systems. Dead systems are about half the inner ring and more further out, as asked.
* **Always inhabited (pinned):** Sol, the five "-Max" ports (`docs/names.md`), and the famous neighbours: Sirius, Procyon, 61 Cygni, Epsilon Indi, Altair, Vega, Fomalhaut, Arcturus, Pollux and Capella.
* **The Calder March** is placed before the model: the tightest six stars that can carry its systems' classes, with the March's spacing kept. Named stars must really have the right class; catalogue stars can be anything. It lands in the middle ring whatever its distance. **The Glass** goes beside it, a little further out.
* **Spacing:** no two systems within 1 ly of each other, and inhabited systems at least 2.5, 4 or 5.5 ly apart (inner, middle, outer).
* **Room for lanes:** each chosen system needs enough chosen stars within jump range to have its minimum number of lanes. Jump range is 9, 11 and 14 ly for the rings, 16 for the exterior and the Shadow, and 12 for the Bloom.
* **One piece:** a flow runs from Sol through chosen stars only, stepping between stars within jump range, and every chosen system must receive one unit. Because the flow is continuous, this is cheap. A flow that could only head outward from Sol was too strict for the real neighbourhood and was dropped. Clusters that can only be reached the long way round are allowed: hard-to-reach places are a feature.

**What it prefers:**
* **Named stars for what they are:** sun-like ones as places to live, dim ones as dead systems.
* **Catalogue-number stars purely for where they are.** Nobody knows them, so after the solve each one's class is set to suit its role:
  * inhabited: mostly yellow and orange
  * dead: mostly red and white dwarfs
  * Drift and Shadow: a scattering of pulsars, black holes and blue giants
* **Shadow systems close to one centre toward the core**, so the Shadow has a front rather than scattered clumps.

This stage solves to optimal in 15–160 seconds, depending on the run.

## Stage 2: territories

**What's decided:** an owner for every inhabited human system; dead systems can be claimed as territory or left unclaimed. It works on the **lanes that could exist**: pairs of chosen systems within jump range, each among the other's 24 nearest, about 1,300–1,450 pairs.

**Constraints:**
* **The setting's counts:**

  | Faction | Inhabited systems | Where they sit |
  | :-- | --: | :-- |
  | Federation | 45 | at least 28 in the inner ring |
  | Ironhull Compact | 35 | middle and outer rings, at least 24 in the middle |
  | Prism | 20 | at least 12 in the inner ring |
  | Freeflag | 20 | outer ring only |
  | Blackhull havens | 5 | middle and outer rings |
  | Independent | 25 | middle and outer rings |

* **Fixed owners:** the March's systems belong to the owners in its region file, and the Federation holds Sol and the "-Max" ports.
* **The March joins the Compact:** a flow from Brannock, through Ironhull systems, must reach at least 24 of the Compact's inhabited systems. The region file says the March is the Ironhulls' way in to the rest of the Compact.
* **Held together:** for the four factions that hold land, a flow runs from a root in each piece of territory through that faction's own systems only. Every extra piece costs a penalty. Hard limits on pieces made the model infeasible twice on this sparse map, so this is a cost, not a rule. The pieces outside the main body are tagged as exclaves: navy base, outpost, company world or rebel cell.
* **Equal access to the Drift:** the Drift is cut into eight sectors round the galactic pole. A sector is blocked where the Bloom or the Shadow holds more of its edge than the Drift does. At least one open sector is required (five were open in the final run). Each of the four major factions must be able to reach the open Drift equally; the lane stage then makes the actual gateway counts equal.

**What it prefers:**
* **Compact territories:** splitting two near neighbours between factions costs, more the closer they are.
* **Directions (bearings):** the Ironhulls, Freeflag and Prism lean towards the March's side of Sol. Each of their systems costs its angle away from that direction.
* **The Shadow front:** the Federation gets a bonus for holding systems that face the Shadow (the navy holds the front).

This stage is the hardest. With a 20-minute limit it stops about 17% from proven optimal. The territories are cached in `~/.cache/driftward/territories.json`.

## Stage 3: lanes

**What's decided:** which of the possible lanes exist.

**Constraints:**
* **Lanes per system:** inhabited systems have 3–7, dead 2–5, Drift 1–4, and Sol 3–8.
* **One piece:** a flow from Sol along the actual lanes reaches every system.
* **Each piece of territory is joined by its own lanes,** with loops: an inhabited system has two lanes inside its own territory wherever it can.
* **The Drift edge:** every Drift sector is reached from human space by at least 8 lanes, or as many as it can carry.
* **Equal Drift gateways:** a faction's gateway is a system of its own with a lane into an open sector's Drift. The four factions must end up with the same number, at least 2 each; the final run has 5 each.

**What it prefers:**
* **Short lanes:** each lane costs its length.
* **Cheap inside, dear across borders:** a lane inside a territory costs 0.7× its length; one across a border costs 1.6× its length plus 4. So borders cross at a few **choke points**, which the map draws in warm white.
* **Short routes from Sol:** every jump on a system's route from Sol costs a little. That keeps routes short without forbidding a long way round. The per-ring jump targets (6, 10, 14…) are only reported.

The 20-minute limit gets this within about 3% of optimal.

## Stage 4: the deep Drift

The Book says Drift systems are generated on first contact, seeded from their neighbours, so the deep Drift is **grown** rather than optimised. Growing it was also forced by the numbers: a few hundred systems spread evenly over the shell outside human space would sit about 28 ly apart, too far for lanes.

From the Drift systems on the edge, reaches of **generated stars** push outward:
* **Branching:** about 1.3 children per system at depth 1, falling below 1 deeper in, so the Drift thins as it goes.
* **Steps:** each child is 7–12 ly out at depth 2, rising to 13–18 ly at depth 8.
* **Placement:** every new star is at least 6 ly from any other, and never in the Bloom's or the Shadow's direction.
* **Loops:** near the edge, a Drift system often links to a neighbour at about the same depth: half of them at depth 1, none at 7–8.

The final run has about 420 Drift systems at depths 1–8 (fringe, wild, deep, the black), with 57 at depth 1 thinning to 16 at depth 8. Generated systems are named DR-0001 and up until someone surveys them, and their lanes are marked as Drift lanes (which shift, per the Book).

## Stage 5: names and years

**Names** (`tools/galaxy_names.py`):
* **Inner ring:** every system keeps its real name.
* **Further out:** a settled system takes an invented name in its owner's style more and more often (70% of the middle ring, all of the outer). The exception is a star with a real proper name, which keeps it (Capella, Arcturus).
* **Dead systems:** a few in the outer ring take a prospector's claim name.
* **The Bloom's worlds** get the names their human surveyors gave them.
* **Corran** is the first emptied Shadow system, as the setting says.

Every invented name is marked `provisional`. `docs/names.md` explains how to make one final.

**Years:**
* **Settlement:** inhabited systems are ordered by jumps and distance from Sol (Freeflag's and the Independents' come late) and placed on the setting's Rush curve: about a dozen by 2200, forty by 2250, a hundred by 2320, a hundred and forty by 2375, and the rest since.
* **The Bloom** is charted from contact in 2376 to 2410.
* **The Shadow** is seen from 2519; its three innermost systems were human, emptied in 2521 (Corran), 2522 and 2523.
* **The Glass** went glass in 2524.

The map's Year slider plays this back.

## Stage 6: hazard stars and regions

**Hazard stars.** No real neutron star or black hole lies within range, but a catalogue-number star can be any class (nobody knows it). So six are placed by rule, each where it matters, and a region is named round each:

| Hazard | Class | Rule | Region |
| :-- | :-- | :-- | :-- |
| The Lighthouse | pulsar | a dead system with lanes to both Federation and Prism systems, nearest Sol | Lighthouse Run |
| The Furnace | Wolf-Rayet | a dead system in the Ironhulls' main body, nearest its middle | The Furnace Deeps |
| The Beacon | blue supergiant | a dead system in or beside Freeflag's main body | Beacon Cells |
| The Metronome | pulsar | a dead system with a lane to the Shadow front, nearest Corran | Corran Gate |
| The Sink | black hole | an unclaimed dead system beside the Independents | The Sink |
| The Maw | black hole | a grown Drift star at depth 4–5 in the open Drift | The Maw (two jumps round it) |

**Regions.** Every system belongs to exactly one region. Assignment runs in order, and a later rule overrides an earlier one:

1. **What a system is:**
   * the March's six systems → **the Calder March**
   * the Glass → **Mirrorspace**
   * human space within 12.5 ly of Sol, whoever holds it → **the Inner Sphere (IS)**
   * the Federation's main body → **the Long Watch** if within 55° of the Shadow's direction (past 20 ly), otherwise **the Concord Worlds**
   * Prism → **Prism Incorporate** (main body) or **Prism Research** (the company worlds apart)
   * the Ironhulls → **the Anvil** (main body) or **the Ironhull Outposts**
   * Freeflag → **the Reach** (main body) or **the Cells**
   * the Independents → **the Margins**; the Blackhull havens → **Blackspace**
   * the Bloom → **the Garden**, except its third farthest from human space, **the Hedge**
   * the Shadow → **Blightspace**; the systems it emptied → **Corran Gate**
   * the Drift, by open sector → **the Shoals**, **the Black Shelf**, **the Long Dark**, **the Far Lanterns**, **the Outer Dark**, **the Farthest Reach**; closed sectors stay **the Drift**
2. **The front:** human systems facing the Shadow join **Corran Gate**.
3. **Hazards:** each hazard star and its human neighbours (one jump; two for the Maw) take the hazard's region.
4. **The rest:** any system still without a region, such as an unclaimed dead system, takes the region of its nearest neighbour along the lanes.

The names are in `REGIONS` in `tools/galaxy.py`. The map names each region on its biggest piece, plus any other piece of eight or more systems, and the panel lists a system's region.

## Worlds and stories

**Worlds** (`tools/worlds.py` → `src/galaxy/worlds.json`, keyed by star id, a few seconds):
* **Population:** each settled system's people are ranked within its ring by how long it has been settled, its star, its lanes and its owner (Freeflag and the Independents live thin), then placed on the ring's span. That runs from an outwatch of about a thousand people up to a few billion. There are only six **Builtworlds** in human space, whole planets built over, each about ten billion people: Earth, Alpha Centauri, Tau Ceti, Epsilon Eridani, Procyon and Prism's 61 Cygni. The Calder March keeps its region file's figures. Total: about 185 billion.
* **Economy:** each system gets ports by its size, and a MIP chooses their roles from `src/economy.json`:
  * across the galaxy, every commodity's supply covers at least 90% of what people and industry need;
  * every region of three or more settled systems has a commodity it exports and one it must import, so trade runs between regions;
  * roles follow their owner's character (the Ironhulls mine, refine and forge; Prism does research; the Federation farms and runs the military);
  * rare roles stay rare: 8–12 shipyards, 20 military ports, in big systems;
  * the March keeps its system files' roles.
* **Wealth, security and unrest** (0–100) come from the ring, the owner, the front and the choke points.

**Stories** (`tools/stories.py` → `src/galaxy/stories.json`, every prompt and cost in `stories.log.json`):
* **One call per region,** so neighbours agree. The setting and the region's notes go in as canon, and each system's facts as the only source: owner, year, people, ports, lanes, choke points, hazards, the front.
* **What comes back:** 3–6 bullets per settled system or living Bloom world, 1–2 per notable dead one, and a region summary. The answer is checked against the facts and asked again if it fails. `--dry` prints the prompt and an estimate.
* **Cost:** about $0.07 a region with Sonnet 5.5. The Inner Sphere, the Calder March and the Reach are written; the rest are not yet.
* **A rerun of the galaxy can rename systems the stories mention:** once stories exist, keep the map, or rewrite the stories.

**The universe index** (`tools/universe.py` → `src/galaxy/universe.json`, remade by every build): the galaxy, worlds, stories and region notes merged into the one file the game loads, each system once by star id, with its owner in the system files' vocabulary (`federation`, `ironhulls`, `prism`, `freeflag`, `blackhulls`, `independent`, an alien power, or `none`; the galaxy uses the same faction keys). Schema: `src/schema/universe.schema.json`. Worlds and stories record the hash of the galaxy they were made from (`galaxy_hash`: every system's star, name, region, owner, ring and status, and the lanes' ends), so after a galaxy rerun `npm run check` fails until `tools/worlds.py` and `tools/stories.py` have been run on the new map. It also checks every system file against its index entry. See `docs/data.md`.

The game's debug screen shows all of it: the **Regions** tab (each region's facts, trade, summary and hand-written notes) and the **Planets** tab (every system's people, ports, wealth, security, unrest and story). On the map, double-click a star for its detail.

## Running it

```
python3 tools/hyg.py                     # the catalogue (downloads HYG to ~/.cache/driftward once)
python3 tools/galaxy.py --time 1200      # all of it: about 45 minutes (each solve may use the time limit)
python3 tools/galaxy.py --reuse          # keep the systems in galaxy.json; territories, lanes, Drift
python3 tools/galaxy.py --relane         # keep the systems and the cached territories; lanes and Drift (minutes)
python3 tools/galaxy.py --drift-only     # keep everything; regrow the Drift, names and years (seconds)
python3 tools/galaxy.py --stage select   # stop after a stage: select, lanes (no factions), or factions (default)
python3 tools/worlds.py                  # then the worlds and stories on the new map (npm run check
python3 tools/stories.py all             #   fails while they were made from another galaxy)
npm run build                            # then rebuild the pages (and the universe index)
```

**The final run, as committed** (`--time 1200`):

| Stage | Result | Time | Distance from optimal |
| :-- | :-- | :-- | :-- |
| Systems | 1,711 candidate stars | 15 s | optimal |
| Territories | | 20 min (limit) | 17% |
| Lanes | | 20 min (limit) | 3% |

The output: 596 charted systems plus 320 generated Drift systems, and 1,126 lanes, median 9.9 ly.

| Faction | Pieces | Gateways into the open Drift |
| :-- | --: | --: |
| Federation | 2 | 5 |
| Ironhull Compact | 3 | 5 |
| Prism | 2 | 5 |
| Freeflag | 3 | 5 |

There are 66 choke-point lanes, and the Shadow touches human space at a single system (Corran's neighbour).

**Rerunning changes things.** Any change to the numbers at the top of `tools/galaxy.py`, and any rerun with a different time limit, can move systems, owners and names. `galaxy.json` is the canon, so commit it. Once systems have authored content (system files, lore), pin them (as the March is pinned) before rerunning.

## What went wrong on the way, and the fixes

Each of these was found with `diagnose()`:
* **Sirius:** it's 8.6 ly from Sol with nothing in between, so the inner ring's jump range went from 8 to 9 ly.
* **The Bloom:** its first ball was too small to hold its quota once spacing applied, so it was widened.
* **The Glass and the March:** fixed systems closer together than the spacing allowed. Both are now placed with spacing kept.
* **Only 8 nearest neighbours as possible lanes** split the map into pieces. It's now 24.
* **Equal gateways with only three open sectors** forced each faction to own systems far from its main body. Narrowing what counts as a blocked sector, and letting the lane stage pick the gateways itself, fixed it.
* **Lanes before territories** gave the six-piece Ironhull Compact, fixed by the stage order above.

## Known gaps

* **Brannock joined the Anvil** (fixed): the territory model now requires a flow from Brannock, through Ironhull systems, to reach at least 24 of the Compact's inhabited systems. The region file says the March is the Ironhulls' way in to the rest of the Compact.
* **The Shadow front is a single system.** "The navy holds the line" wants a wider front: say, at least 4–6 lanes between the Shadow and human space.
* **The territory solve stops at its time limit.** More time, or a tighter formulation, would make territories more compact still.
* **Invented names are provisional,** and the lore for most systems doesn't exist yet.
