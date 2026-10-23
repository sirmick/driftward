# Weapons: the multicannon line, weapon sites and the test worlds

Status, 2026-10-23: design agreed; building. The Book's Weapons, Shields and Damage chapters (M2). This milestone builds the fundamentals every weapon shares (sites, modules, shells, hits, damage, fire control), one weapon (the light multicannon), the combat AI's first pass, and two test worlds. The rest of the multicannon line, rails, beams, torpedoes, ion and arc come after, as rows in the same tables. Every number here is a core param, live-tunable with `__play.sim.param(name, value)`, and a first guess until the combat lab has been flown.

## The multicannon line

A turreted autocannon firing a torrent of exploding shells. A shell bursts on contact, or by itself when its fuse runs out, so it can be set to burst at a range (flak). The light gun is the line's point defence as well as a weapon: when torpedoes and missiles arrive, a ship's light guns default to defence (missiles, then fighters, then ships).

| Size | Shell | Rate | Punch (per shell) | Fuse range | Mass | Status |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| **S** | **30 mm** | **10 /s** | **1×** | **~900 m** | **2 t** | **built** |
| M | ~57 mm | ~3 /s | ~6× | ~1,400 m | ~8 t | later |
| L | ~120 mm | ~0.8 /s | ~35× | ~2,200 m | ~30 t | later |
| XL | ~200 mm | ~0.25 /s | ~150× | ~3,000 m | ~90 t | later |

Punch goes about with the calibre cubed and the rate falls steeply, so the big guns hit far harder per second and far harder per shell. Shield hardness (below) is what keeps a battery of light guns from stripping a capital shield.

### The light multicannon (S)

| | |
| :-- | :-- |
| Site | S turret (any turret site takes it) |
| Traverse | 360°, 4 rad/s; leads its target |
| Rate | 10 shells a second, a spread of 1.5° |
| Shell | 1,200 m/s plus the ship's velocity; fuse 0.75 s (900 m); a burst of 12 m radius |
| Damage | 1 point a shell, full inside 4 m, falling to nothing at the burst's edge |
| Energy and heat | 0.02 MJ and 0.05 MJ a shell (0.2 MW and 0.5 MW firing) |
| Ammunition | 400 rounds a tonne of magazine (40 s of fire); the munitions commodity |
| Mass and price | 2 t, unpressurised; 3,000 cr |

Its params are `mc_s_*`. The other sizes will be the same columns with their own values.

## Weapon sites

Every ship is armed; the lightest carry a single light multicannon. The counts by class and line:

| Class | Civilian | Military |
| :-- | :-- | :-- |
| I (18 m) | 1 S | 2 S |
| II (34 m) | 2 S | 4 S |
| III (60 m) | 2 S | 4 S + 2 M |
| IV (100 m) | 4 S | 4 S + 2 L |
| V (160 m) | 4 S + 2 M | 6 S + 2 L + 2 M |

- **Turrets** (S, M, L, XL) traverse. A site takes a gun of its size or smaller. S turrets go in flank pairs and at the ends, for the widest point-defence cover; M and L on the centreline, where the hull is deep.
- **Ventral mounts** are fixed (no gimbal): missile racks, mass drivers, spinal rails. They fire along the hull's axis. Not built yet; the site type exists so hulls can carry them.
- **Fire groups:** the light guns are one group, with modes defence, offence and hold (defence acts as offence until there are missiles); the M and L guns are the main battery, on the selected target.
- `gen.js` draws three turret sizes per faction, scaled from its weapon part, so a ship's guns show on it. The civilian loadouts go from no weapons to the counts above (seeded hulls change a little).
- Stock fits fill every S site with a light multicannon and a tonne of magazine per gun; M and L sites stay empty until those guns exist. The catalog's old `flight.dmg` and `flight.rate` (the lab's prototype) go.

## Shells, hits and damage

- **Shells live in the core**: a fixed pool (position, velocity, fuse, owner, weapon), stepped with the ships, so replays stay bit-identical native and WASM.
- **Hits resolve against the hull's silhouette**: the build bakes a coarse convex outline per hull type (from the generated parts, in the ship's frame, at its drawn size) into the catalog's data for the core. Each tick a shell's path is tested against the outlines of ships near it; a hit bursts on contact. A fuse-out burst damages every ship inside its radius.
- **Damage** goes to the shield first, then the hull:
  - **Hardness:** a hit at or under a shield's hardness does a tenth of its damage to that shield (`shield_hard`, a few points on capital ships, under a light shell's punch on small ones).
  - **Bleed-through:** a share of a kinetic hit reaches the hull while the shield holds (`bleed_kin`, 0.1 for shells).
  - **Regen pauses** for `shield_pause` seconds after a hit; at zero the shield collapses and restarts cold (already built).
  - **The hull** at zero: the ship is destroyed (the player's: the existing lost-ship path).
- Ion, arc and heat channels, resistances, system damage, field repair and disable come later in M2.

## NPCs in combat

Traffic flies its catalog stats, not a fit. For combat each ship slot gains its own hull, shield, shield timer, magazine and turret headings, with the type's shield, regen, hardness and guns taken from its line's stock fit (so a Copperclad's numbers match the outfitter's). The player keeps the full fit, energy and heat; NPCs' energy and heat wait.

## The combat AI (first pass)

A small state machine per armed NPC:

- **Loiter:** with no hostile detected, fly to the system's contested station and circle it, so the two sides keep meeting there.
- **Engage:** a hostile detected (the sensors' signature model, between NPCs as for the player, so running cold and hiding in a planet's shadow work on them too) becomes the target, re-picked about once a second, nearest first. Close to about 70% of the guns' range, then circle and strafe; the turrets do the aiming.
- **Flee:** under `morale` of its hull, turn for its faction's jump zone and leave.
- **Hostility:** by faction pairs (`hostile` in the lab's system file); the player is neutral unless it fires on a faction or joins one from the debug screen.

## The test worlds

Two systems that are not in the Calder March: dead stars from the galaxy, each a hand-written system file marked `"lab": true`, so the lore and art checks skip them and they stay off the galaxy map and out of normal play. The debug screen gets a Labs row to jump to each, and back to the start.

- **Flares are opt-in.** A star flares only when its system file says so (`"flares"` on the star); nearly every star doesn't. Brannock, the start, is calm.
- **The flare lab:** a white giant, flaring often, with planets to shelter behind.
- **The combat lab:** one star, one neutral station, the Union's Clads against the Freeflag, each side kept at strength by arrivals at its own jump zone on opposite sides of the station. The player arrives neutral; the debug screen can join a side and arm the player's ship with its line's stock guns.
- **The Freeflag line:** pirates' refits of Union civilian hulls (`hullFrom` the Union's civilians), their own paint, every site filled.

## Build order

1. Flares opt-in; the flare lab; Labs in the debug screen.
2. The combat lab and the Freeflag line.
3. Weapon sites (catalog, `gen.js`, the fit, the outfitter's Weapons group), the light multicannon as a module.
4. Shells, outlines and hits, damage to shields and hull.
5. NPC combat state, the AI, hostility, the player's fire control.
6. Tracers, muzzle flashes, bursts, shield hits; then a tuning pass in the combat lab.
