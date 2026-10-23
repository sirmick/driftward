# Outfitting: frames, components, power and shields

Status, 2026-10-18: the basics and the freight modules built (the Book's Outfitting, Energy and heat, and Shields chapters, M2; code in `core/src/fit.rs`, the page's outfitter in `src/play/play.js`); weapons not yet. What is built and what waits is at the end. Every rating and price is a core param, live-tunable with `__play.sim.param(name, value)`. Endless Sky's model of energy and heat, but fitted the way MechWarrior is: every component is bought by the tonne (or by the plume, the corner, the bunk), against a frame's space, so a ship is much more configurable than in Endless Sky and the fitting rules are forgiving. A freighter refitted hard enough makes a nasty warship, though never quite a match for a dedicated military hull of its class. Union numbers first; other makers differ in their per-tonne ratings.

## Principles

- **The class sets the frame; the components are rated per tonne.** A size class decides a frame's mass, space and mounts. Every component has the same rating per tonne on every frame (for one maker), so a Copperhaul's 7 t torch and a Steelhaul's 7 t torch are the same part.
- **Stock fits reproduce today's catalog.** Each line's stock fit is a component list on its frame, chosen so the ship's acceleration, turn, top speed, hull, shield, hold and fuel come out at the catalog's numbers (class × style × line, as `play.js` builds them now). Flight feels the same until somebody refits. The line multipliers become explainable: the Clads' extra hull is welded armour, their extra shield more banks, their small hold hoppers pulled out for guns.
- **The Clads are refits.** The Union military line builds on the civilian line's hulls (`hullFrom: "civilian"`), so a Copperclad is a Copperhaul with the hoppers cut out and guns welded on, and a player who refits a Copperhaul all the way ends up with about a Copperclad. The gap to a dedicated warship is against a navy's own frames (below).
- **Mass matters.** Acceleration is thrust over the ship's mass as it is, cargo and fuel included; turning likewise from the jets. Heat capacity follows mass. (Jump fuel stays the hull's for now: see Decided.)
- **Units are real.** Mass in tonnes, thrust in MN (so MN over tonnes is the world's m/s², the units `play.js` displays at 4 km to the metre), power in MW, energy and heat in MJ, shields and hull in points.

## The frame

What a hull gives that no refit changes: its mass, its bay (split into a pressurised and an unpressurised volume), its plumes (one torch mount per nozzle, from the bake's `engines`), its four corners (the jet anchors `hullAnchors` finds: fore and aft on each flank), its weapon sites, and its structure (base hull points: today's civilian hull). The bridge is part of the frame.

Frame mass goes with length squared (a hull is a shell), so hull points per tonne stay about even across the classes.

| Class | Union hulls | Frame | Bay (pressurised / unpressurised) | Plumes (default hull) | Torch cap, all plumes | Armour cap |
| :-- | :-- | --: | :-- | --: | --: | --: |
| I, 18 m | Tinhaul, Tinclad | 45 t | 43 t (23 / 20) | 2 | 12 t (Haul) | 76 t |
| II, 34 m | Copperhaul, Copperclad | 170 t | 91 t (39 / 52) | 4 | 20 t (Haul) | 214 t |
| III, 60 m | Brasshaul, Brassclad | 520 t | 237 t (88 / 149) | 3 | 31 t (Haul) | 529 t |
| IV, 100 m | Ironhaul, Ironclad | 1,450 t | 566 t (184 / 382) | 6 | 42 t (Haul) | 1,386 t |
| V, 160 m | Steelhaul, Steelclad | 3,700 t | 1,346 t (402 / 944) | 8 | 48 t (Haul) | 3,528 t |

- **Plumes** are the nozzles on the generated hull: its core engines and one on each nacelle (the default seeds' here; the page counts each hull's own from its part list, so a hull picked in the debug screen's Ships tab has its own count).
- **Torch cap:** a limit per hull type, on all its plumes together, however they are split: `torch_room` (1.4) times its stock fit's torches. The Copperhaul's is 20 t (10 + 10 on two plumes, or 5 + 5 + 5 + 5 on four). A line that carries more than its class's frame holds has bigger bays (`frame` multipliers on the line: the container lines, the Bloom's warships).
- **Armour cap:** enough to double the frame's structure.
- **The pressurised share falls with size**, from about half the bay on a Tinhaul to under a third on a Steelhaul: crew and electronics don't grow as fast as the hold.

### Pressurised and unpressurised

| Pressurised | Unpressurised | Outside the bay |
| :-- | :-- | :-- |
| Bunks, sensors, reactor, jump drive, battery, shield banks, climate hold | Hoppers, container racks, fuel tanks, deflector, fins, heat sinks, most weapons and their ammunition | Torches (on the plumes), jets (on the corners), armour (on the hull) |

**The bulkhead** between the two moves in a refit, by up to 15% of the bay either way. Pressurising space costs 0.2 t of pressure hull and life support per tonne moved; venting it is free. The stock Clads move it 2 to 11% to make room for a bigger reactor and a gunner's bunk.

### Weapon sites

Up to 8 turrets and 6 forward-firing bays on the largest hulls, each heavy, medium or light. A site takes a weapon of its size or smaller. Turrets traverse, with arcs the ship's own hull can block (the Book's multicannons); bays fire forward (spinal rails, torpedo tubes). Sites come from the hull's generated weapon parts (`gen.js` places them already: pairs on the flanks, singles down the centreline), which will each need a type (turret or bay) and a size; a line's loadout sets the counts. A civilian hull keeps its sites empty, which is why a refit can arm it.

**A navy's frames beat a refit** with more and heavier sites, wider turret arcs, about 30% more structure, built-in cooling, and military-grade gear that is about 30% denser and needs standing to buy (the Book's Sworn).

## Components (Union ratings)

| Component | Where | Bought by | Rating | Draw and heat |
| :-- | :-- | :-- | :-- | :-- |
| **Torch** | a plume | the plume: 0.5 t, then 1 t steps, the plumes' total to the cap | 1 MN per t | 0.1 MW per MN at full thrust; heat 0.25 MW per MN. The burner adds 0.3 MW and 2 MW of heat per MN |
| **Jet cluster** | a corner (four) | half a tonne, then the ton | Turn rate ∝ jet tonnes ÷ (mass × length); lateral thrust | 0.25 MW per t while firing |
| **Furnace** (reactor) | pressurised | 5 t | 3 MW per 5 t | Waste heat 0.5 MW per 5 t. Still gives half output when damaged |
| **Battery** | pressurised | the ton | 40 MJ per t | |
| **Deflector** (shield emitter) | unpressurised | 2 t | Shield regen 2.5 points/s per 2 t | 1 MW per 2 t while regenerating, 0.1 MW holding |
| **Shield bank** | pressurised | the ton | 30 shield points per t | |
| **Fin radiator** | unpressurised | the ton | Sheds 4 MW at full heat | |
| **Heat sink** | unpressurised | the ton | 5 MJ of heat capacity per t | |
| **Armour** | the hull | the ton | 5 hull points per t; no bay space | |
| **Jump drive** | pressurised | the ton | Jumps 40 t of laden ship per t; the Prism nav core comes with it | |
| **Sensors** | pressurised | the ton | Gain ∝ tonnes, so range ∝ √tonnes; the Copperhaul's 2 t is today's `sens_k` | 0.2 MW per t |
| **Bunk** | pressurised | the bunk, 2 t | One crew member, life support included | 0.05 MW each |
| **Fuel tank** | unpressurised | the ton | 0.8 t of fuel per t | |
| **Hopper** | unpressurised | the ton of hold | Ore, water, metals, chemicals, fuel; weighs 0.1 t per t | |
| **Container rack** | unpressurised | the ton of hold | Any good but food and medicine; 0.15 t per t | |
| **Climate hold** | pressurised | the ton of hold | Anything; food and medicine only here; 0.3 t per t | |

- **Heat capacity** is 1 MJ per tonne of ship, plus heat sinks. Fins and the hull's skin shed in proportion to how hot the ship is. Calibration: the stock Copperhaul fills from cold in about 15 s of burn and cools in about 10 s, as today.
- **Torches mix and match:** a Brasshaul may run 8+7+7, or 10+4+8. Uneven thrust makes no torque (ignored).
- **Torch price grows with the cube of its tonnes**, so the same thrust split unevenly costs much more, and stock fits split as evenly as the steps allow. For two plumes, relative to 7+7: 6+8 1.06×, 5+9 1.24×, 4+10 1.55×, 8+8 (more thrust) 1.49×.
- **Food and medicine travel only in a climate hold**, and climate-hold runs pay a lot more: deliveries 2.5 times over, and food and medicine dearer to trade.
- **Jump fuel** (proposed, not built: see Decided) would go with laden mass and the lane's length, calibrated so each stock ship pays today's cost per light year. The drive refuses a ship over its rating.
- **Power shortfall browns out by priority** rather than failing outright: helm and drive first, then shields, then weapons, then the rest. The battery covers any gap until it runs dry.

Later, smaller items: a fuel transfer pump (fuel bought as cargo into the tank, in flight), passenger cabins, an escape pod (the Book's death and insurance), and the later milestones' transponder, cargo scanner, prospector, mining laser, tractor and smuggler's compartment. Weapons arrive in M2 with their own table.

## Stock fits

Generated by the core (`stock_fit`) from each hull's catalog stats, the default hulls' plumes, with mass empty and with a full hold, and acceleration against the catalog's. Every catalog hull's stock fit fits its bay; all are within 6% of the catalog's acceleration but the Tinhaul (16% quick: two plumes take an even pair, 4 + 4), and turn a little quicker (10 to 20%, more on the smallest hulls, as jets come by the half tonne).

| | Plumes (t) | Jets | Reactor | Battery | Deflector | Banks | Fins | Armour | Bunks | Sensors | Jump | Tank | Hoppers + racks | Bulkhead | Mass | Accel (catalog) |
| :-- | :-- | :-- | :-- | --: | --: | :-- | --: | --: | --: | --: | --: | --: | :-- | :-- | :-- | :-- |
| Tinhaul | 4+4 | 4 × 0.5 t | 5 t, 3 MW | 2 t | 2 t | 1 t (30) | 2 t | – | 2 | 1 t | 3 t | 2 t | 5 + 5 | – | 78 → 88 t | 102 (88) |
| **Copperhaul** | **4+3+3+4** | 4 × 1 t | 10 t, 6 MW | 3 t | 4 t | 3 t (90) | 4 t | – | 3 | 2 t | 8 t | 5 t | 15 + 15 | – | 237 → 267 t | 59 (58) |
| Brasshaul | 7+8+7 | 4 × 3 t | 25 t, 15 MW | 4 t | 10 t | 7 t (210) | 11 t | – | 5 | 4 t | 21 t | 13 t | 45 + 45 | – | 670 → 760 t | 33 (33) |
| Ironhaul | 5+5+5+5+5+5 | 4 × 6 t | 40 t, 24 MW | 5 t | 20 t | 16 t (480) | 26 t | – | 9 | 8 t | 55 t | 32 t | 120 + 120 | – | 1,754 → 1,994 t | 17 (16) |
| Steelhaul | 5+4+4+4+4+4+4+5 | 4 × 11 t | 85 t, 51 MW | 6 t | 48 t | 39 t (1,170) | 63 t | – | 17 | 16 t | 137 t | 75 t | 300 + 300 | – | 4,356 → 4,956 t | 8 (7) |
| Tinclad | 5+5 | 4 × 0.5 t | 10 t, 6 MW | 2 t | 4 t | 2 t (60) | 2 t | 5 t | 2 | 1 t | 3 t | 2 t | 1 + 2 | – | 92 → 95 t | 108 (104) |
| Copperclad | 5+4+4+5 | 4 × 2 t | 15 t, 9 MW | 3 t | 6 t | 5 t (150) | 5 t | 12 t | 3 | 2 t | 8 t | 5 t | 4 + 5 | – | 264 → 273 t | 68 (68) |
| Brassclad | 9+10+9 | 4 × 4 t | 30 t, 18 MW | 5 t | 14 t | 11 t (330) | 12 t | 30 t | 5 | 4 t | 21 t | 13 t | 13 + 14 | – | 717 → 744 t | 39 (38) |
| Ironclad | 6+6+6+6+6+6 | 4 × 7 t | 55 t, 33 MW | 6 t | 32 t | 26 t (780) | 29 t | 77 t | 9 | 8 t | 54 t | 32 t | 36 + 36 | – | 1,860 → 1,932 t | 19 (19) |
| Steelclad | 6+5+5+5+5+5+5+6 | 4 × 13 t | 115 t, 69 MW | 7 t | 78 t | 64 t (1,920) | 69 t | 196 t | 17 | 16 t | 132 t | 75 t | 90 + 90 | – | 4,603 → 4,783 t | 9 (9) |

Stock fits carry the minimum crew and a spare bunk. Since 2026-10-23 every stock fit also has a light multicannon on each light site and a tonne of magazine for each ([weapons.md](weapons.md)); the table above predates them, and the torches and reactor grow a little to carry them.

### The Copperhaul, stock

| Pressurised: 32 of 39 t | Unpressurised: 43 of 52 t | Outside the bay |
| :-- | :-- | :-- |
| 3 bunks (6 t), sensors (2 t), Furnace (10 t), jump drive (8 t), battery (3 t, 120 MJ), shield banks (3 t, 90 points) | Hoppers (15 t) and container racks (15 t), fuel tank (5 t, holding 4 t), deflector (4 t, 5 points/s), fins (4 t) | Torches 4 + 3 + 3 + 4 t on its four plumes (14 MN; 20 t in all at most), a 1 t jet cluster on each corner, no armour |

Cruising draws 3.5 MW of the Furnace's 6; shield regen adds 2; the burner adds about 4 more, which the battery covers for about 30 s while the heat climbs to lockout (13 s of burner from cold). The obvious first upgrade is a climate hold, for the food and medicine runs: the racks out and the bulkhead moved to make the pressurised room.

## The outfitter

A port panel beside Trade, Board and Bar (key O), in the same style, in four parts:

- **The ship:** the baked hull (`shipyard.js` already draws hulls into cells) with its pressurised and unpressurised zones over it, its plumes, corners, armour and weapon sites marked where they are on the hull. Up to 14 sites (8 turrets, 6 bays) on the biggest hulls, about 10 m apart at the panel's scale; crowded ones lead out to chips at the edge. Clicking one jumps to its row.
- **The fit:** the two zones as bars, each module a block as wide as its tonnes, the bulkhead a handle between them (clamped at ±15%); rows for the plumes (a size each, the uneven-pair price shown), corners, armour and sites.
- **The modules:** the components by group (Power, Drive, Defence, Cargo, Crew, Sensors and nav; Weapons in M2), groups with something fitted open, a search box. Each row gives its side, its step and rating, the tonnes fitted, and steppers. A port lists what it stocks.
- **The budget:** live, with green and red changes against the current fit: power (generation against cruise, regen, burn and combat draws; how long the battery covers a gap), heat (burn time to lockout; whether the ship rides out a flare), mass and acceleration empty and full, turn, shields, hull, fuel range in light years, the jump drive's rating against laden mass, and warnings in words ("power short while burning", "over the jump drive's rating", "no climate hold: no food or medicine").

Edits are a draft, priced (purchases less resale, about 60%) and timed (days by tonnes moved); Refit commits, Reset drops it, Stock restores the line's fit. Arrow keys and +/− work the steppers; the bulkhead and plumes are best with a mouse.

## How it is built

- **The fit lives in the core**, as tonnes per component per ship, changed by a refit command the core checks. The page sends a draft and shows the result.
- **One evaluator in the core** works out power, heat, mass, acceleration, turn, shields and range from a fit. The outfitter's preview and the flying use the same function, so the numbers on screen are the numbers flown.
- **The catalog holds the components** (ratings, side, step, price, which ports stock them) and each line's stock fit, validated by `npm run check`, which also checks that every stock fit still reproduces its line's flight stats.
- **The HUD's SHIELD and CHARGE** fill in from the same state; radiation and flares drain shields before the hull.

## Decided

- **Refits are instant**, at the price of the difference.
- **A ship may launch with no reactor**: the battery runs it until it is flat, then the helm and drive brown out to nothing. The outfitter warns.
- **Minimum crew** per class (1, 2, 4, 8, 16): a ship with fewer bunks can't launch. Stock fits carry one spare bunk.
- **The jump drive** may become something simpler; for now it is a component rated 40 t of laden ship a tonne, and a ship it can't move can't jump. Lane fuel stays the hull's (the catalog's tank), whatever the fit's tank holds.

## As built (first pass: the basics and freight)

- **The core** (`core/src/fit.rs`): the fit and the outfitter's draft as columns on the player's ship (tonnes per slot), the frames on the types (from `catalog.json`'s `sizes[].frame`), each commodity's hold class (`economy.json`'s `hold`). The player's ship flies as the core's last type row, rebuilt from its fit every tick, so cargo and fuel weigh. A new game gets its hull's stock fit, generated from the catalog's stats (the Copperhaul: 4 + 3 + 3 + 4 t torches on its default hull's four plumes, a 10 t Furnace, 3 bunks, 15 t of hoppers and 15 t of racks; 59 m/s², 2% over the catalog).
- **Power, heat and shields** each tick as above, with the brownout by priority; the HUD's SHIELD and CHG bars are live (DOWN or COLD while a shield restarts, LOW in a brownout). Running cold drops the shield.
- **Cargo by hold class**: food and medicine only in a climate hold (the market and the board say so); climate deliveries pay `climate_pay` (2.5) times over, and food and medicine are dearer (60 and 300 cr base).
- **The outfitter**: a port service (Kettle Yard, Calder Station, Quire Foundry and Thresh Dock have one), key O. Rows with steppers by group, the bay's two sides as bars, the hull's silhouette with its plumes and corners marked where they are, the budget with changes, warnings, and Refit, Reset and Stock. Every change is a logged command, so replays follow refits.
- **Not yet**: weapons and their sites; the zones drawn on the hull (the bay is bars for now); per-corner jets (the four move together); the soft mass limit; traffic's own fits (traffic flies its catalog stats); crew wages; buying a hull.
