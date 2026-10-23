# Weapons: the multicannon line, weapon sites and the test worlds

Status, 2026-10-23: the fundamentals, the light multicannon, the combat AI's first pass and the test worlds built (As built, at the end). The Book's Weapons, Shields and Damage chapters (M2). This milestone builds the fundamentals every weapon shares (sites, modules, shells, hits, damage, fire control), one weapon (the light multicannon), the combat AI's first pass, and two test worlds. The rest of the multicannon line, rails, beams, torpedoes, ion and arc come after, as rows in the same tables. Every number here is a core param, live-tunable with `__play.sim.param(name, value)`, and a first guess until the combat lab has been flown.

## The multicannon line

A turreted autocannon firing a torrent of exploding shells. A shell bursts on contact, or by itself when its fuse runs out, so it can be set to burst at a range (flak). The light gun is the line's point defence as well as a weapon: when torpedoes and missiles arrive, a ship's light guns default to defence (missiles, then fighters, then ships).

| Size | Shell | Rate | Punch (per shell) | Fuse range | Mass | Status |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| **S** | **30 mm** | **10 /s** | **1×** | **720 m** | **2 t** | **built** |
| **M** | **57 mm** | **3 /s** | **6×** | **1,425 m** | **8 t** | **built** |
| **L** | **120 mm** | **0.8 /s** | **35×** | **2,250 m** | **30 t** | **built** |
| XL | ~200 mm | ~0.25 /s | ~150× | ~3,000 m | ~90 t | later |

Punch goes about with the calibre cubed and the rate falls steeply, so the big guns hit far harder per second and far harder per shell. Shield hardness (below) is what keeps a battery of light guns from stripping a capital shield.

### The light multicannon (S)

| | |
| :-- | :-- |
| Site | S turret (any turret site takes it) |
| Traverse | 360°, 4 rad/s; leads its target |
| Rate | 10 shells a second, a spread of 2.6°; each shell's speed and fuse 6% off either way |
| Shell | 1,200 m/s plus the ship's velocity; fuse 0.6 s (720 m); a burst of 12 m radius |
| Damage | 1 point a shell, full inside 4 m, falling to nothing at the burst's edge |
| Energy and heat | 0.02 MJ and 0.05 MJ a shell (0.2 MW and 0.5 MW firing) |
| Ammunition | 400 rounds a tonne of magazine (40 s of fire); the munitions commodity |
| Mass and price | 2 t, unpressurised; 3,000 cr |

Its params are `mc_*`.

### The medium and heavy multicannons (M, L)

| | Medium (57 mm) | Heavy (120 mm) |
| :-- | :-- | :-- |
| Site | M or L turret | L turret |
| Traverse | 2 rad/s | 0.9 rad/s |
| Rate, spread | 3 /s, 3.4° | 0.8 /s, 2.1° |
| Shell | 1,500 m/s, fuse 0.95 s (1,425 m), burst 22 m (full inside 7 m) | 1,800 m/s, fuse 1.25 s (2,250 m), burst 40 m (full inside 12 m) |
| Damage | 6 a shell (18 /s) | 35 a shell (28 /s) |
| Energy and heat | 0.15 and 0.4 MJ a shell | 1 and 2.5 MJ a shell |
| Magazine | 60 rounds a tonne | 8 rounds a tonne |
| Mass and price | 8 t, 14,000 cr | 30 t, 60,000 cr |

Params `mm_*` and `ml_*`. Every calibre shares the one magazine, in tonnes. A stock fit carries about 40 s of fire for each gun: 1 t a light gun, 2 t a medium, 4 t a heavy. The heavy gun's slow shells and slow traverse miss small, quick ships, but a hit through a fighter's shield is most of its hull. Its 35-point punch is far over any shield's hardness.

## Missiles

Mid-sized and large military ships carry forward missile bays. A missile alone isn't much: its warhead is between a medium and a heavy shell, and light guns shoot it down. Missiles matter in **waves**: a side picks one high-value enemy and every ship that can reach it fires at once, timed to arrive together, to swamp the target's point defence.

| | |
| :-- | :-- |
| Bays | class III: 2, 16 missiles; class IV and V: 4, 64 missiles (military and raider lines; civilians none). The loadout's `bay` and `missiles` |
| Site | a forward bay (site size 4): fixed, launching along the hull's axis, a hatch either side of the bow |
| Volley | a missile from each bay, then `ms_reload` (25 s) before the bays are loaded again |
| Motor | 150 m/s² for 12 s (about 1.8 km/s and 10 km under power), lit 0.4 s out of the bay; then it coasts, and destroys itself 20 s after launch |
| Physics | the ships' own: thrust along its heading, turning at 3 rad/s, gravity wells pulling it as a fighter (`ms_well` 0.35), the gas's drag. No drive taper and no dampers |
| Guidance | proportional navigation (constant bearing, decreasing range): across the line of sight, `ms_nav` (3.5) × closing speed × its turn rate, the motor's remainder along it. It heads a crossing target off instead of chasing it |
| Seeker | holds the target while the target's signature, seen from the missile, makes a contact (the sensors' model × `ms_seek`); lost, it flies on straight. Running cold works on missiles too |
| Warhead | proximity fuse 6 m off its target's shield (or hull); it passes through every other ship, and one that has lost its target flies on until it expires. 25 points, full inside 8 m, nothing past 30 m, by the shells' rules (ships close by the target take some too): it passes any shield's hardness below class V |
| Toughness | a 3 m circle to shells; 4 points (four light shells, or a burst's blast nearby) destroy it |

### Waves

Every `ms_wave` seconds (30, give or take 20%) each lab side picks the most valuable enemy its ships are fighting: the longest hull, the most hurt of those. Every ship of the side with missiles, its bays loaded and the target within `ms_range` (8 km) launches a volley at it. The farthest launches at once and the nearer wait out the difference in flight time, so the wave arrives within a second or two.

### Point defence

A ship defends itself, not its neighbours. Its light multicannons shoot first at the nearest missile within their reach that is homing on their ship, or another side's within `ms_pd_near` (200 m) of it, fired on unbidden (the player's too, at the usual energy and heat). Only with no such missile do they turn back to ships. So a wave meets its target's own guns, a handful, not the whole fleet's. The flak fuse bursts each shell at the missile's range, so a stream of light shells makes a screen. Medium and heavy guns don't defend.

### The player

Missile (Z) launches a volley at the target whenever the bays are loaded, while held. The HUD shows the missiles aboard and the bays' reload. A fitted ship carries its hull's stock load, restocked free on landing for now (as the magazine is); there is no outfitter row for missiles yet.

Params `ms_*`.

## Weapon sites

Every ship is armed; the lightest carry a single light multicannon. The counts by class and line:

| Class | Civilian | Military |
| :-- | :-- | :-- |
| I (14 m) | 1 S | 2 S |
| II (30 m) | 2 S | 4 S |
| III (66 m) | 2 S | 4 S + 2 M |
| IV (145 m) | 4 S | 4 S + 2 L |
| V (320 m) | 4 S + 2 M | 6 S + 2 L + 2 M |

- **Turrets** (S, M, L, XL) traverse. A site takes a gun of its size or smaller. S turrets go in flank pairs and at the ends, for the widest point-defence cover; M and L on the centreline, where the hull is deep.
- **Ventral mounts** are fixed (no gimbal): missile bays, mass drivers, spinal rails. They fire along the hull's axis. The forward missile bay is built (Missiles, above); the others are not yet.
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

Two systems that are not in the Calder March: dead stars from the galaxy, each a hand-written system file marked `"lab": true` (and listed in `tools/universe.py`'s LABS), so the lore and art checks skip them and their ports need no people. They are on the galaxy map as the dead stars they are, but no lane from the March reaches them. The debug screen gets a Labs row to jump to each, and back to the start.

- **Flares are opt-in.** A star flares only when its system file says so (`"flares"` on the star); nearly every star doesn't. Brannock, the start, is calm.
- **The flare lab:** a white giant, flaring often, with planets to shelter behind.
- **The combat lab:** one star, one neutral station, the Union's Clads against the Freeflag, each side kept at strength by arrivals at its own jump zone on opposite sides of the station. The player arrives neutral; the debug screen can join a side and arm the player's ship with its line's stock guns.
- **The Freeflag line:** pirates' refits of Union civilian hulls (`hullFrom` the Union's civilians), their own paint, every site filled.

## As built (2026-10-23)

- **Test worlds.** `src/systems/flarelab.json` (GJ 3822, a white giant, `flares` 4: one about every 25 s; a planet and moon to hide behind) and `src/systems/combatlab.json` (Gl 179: Prize, set between its two lanes' jump zones; the Union's Clads arrive by one, the Freeflag's raiders by the other). The debug screen's header has a Labs row: Start, Flares, Combat, and the side the player is on (none, 1, 2).
- **Sites.** `gen.js` lays out the light sites the table gives (scrap hulls keep both of a pair now), and `footprint()` hands the core each hull's convex outline (up to 12 vertices, in the baked sprite's frame) and its sites. Only light sites exist yet.
- **The fit.** Two slots, `mc` (guns, one a light site) and `magazine` (tonnes); stock fits fill every site and carry a tonne of rounds a gun. The outfitter's Weapons group sells both; its budget shows guns, rounds, seconds of fire and reach. Landing restocks the magazine free for now (munitions come with the economy).
- **The core** (`core/src/combat.rs`): per-ship arms (side, shield, target, rounds, guns) and turrets; a 1,024-shell pool; hits by segment against the outline; blast damage with hardness and bleed-through; the AI; the lab's sides (kept in the atlas per system). Everyone's shield but the player's is here (regenerating in `shield_refill`); the player's stays the fit's. Every ship is armed, but only lab fighters and the player fire.
- **Fire control.** Fire (Space) shoots the player's guns at the target, or straight ahead without one; each shell costs energy and heat, and a heat lockout stops them. The fuse is set to the target's range.
- **The AI.** Fighters see by the sensors' model (the player through `seen`, others by their signature), fight only enemies within `ai_leash` of the contested station (the player anywhere, once it has fired on them), circle their target at `ai_range` of the guns' reach, and flee under `morale`. From far off they come in at open-space speed.
- **Looks.** Tracers for shells, the lab's shield-hit shader on shields struck (the newest two hits a ship), a hull glowing and sparks on hull hits, a fireball and debris for a ship lost, and brief lights on the hulls round a burst. Turret barrels are still the bake's (they don't turn yet).
- **Determinism.** The scenario `npm run check` runs natively and in WASM now has fighters on two sides firing at each other; the hashes agree. The snapshot is version 24.
- **Medium and heavy guns (2026-10-23).** Sites by size (`gen.js` draws the turret bigger the bigger the site; the catalog's loadouts take `weaponM` and `weaponL`); the guns are one table in the core (`Gun`, by size), placed biggest first on the biggest sites (`place_guns`), with the magazine in tonnes. The fit has `mm` and `ml` slots; the outfitter sells all three, and its budget shows the sites, seconds of fire and reach. Fighters circle at `ai_range` of their longest gun's reach. Tracers grow longer and brighter with the calibre. The combat lab's sides now fly class III and IV ships (Brassclads with two medium guns, Ironclads with two heavy) beside the light ones.
- **Tuning (2026-10-23).** `shield_hard` 3 (was 1): a 60 m class III shield's hardness is 1.08, so light shells only scratch shields from class III up (a tenth, nothing through), while class I and II shields still take them in full; medium shells (6) are shrugged off only by class V (160 m: 7.7). The light gun's fuse is 0.6 s (720 m), the shortest reach of the line. Tracers are coloured by calibre: yellow light, orange medium, red heavy. Tab cycles the ships on screen (Shift+Tab back); the flight mode is F alone.
- **Shields as surfaces (2026-10-23).** While a shield holds, shells meet it at its surface, `types.standoff` out from the outline (the shield shader's edge: the brand's `shield.standoff` times the hull's length, `shieldStandoff` in gen.js), and a blast is measured to that surface; with the shield down they reach the outline. Bursts say what happened: on a shield (a ripple in its colour, a cold flash, sparks skating off along the surface, no fire), shrugged off (`B_SHRUG`, a hit no harder than the shield: a faint flicker), a splash (`B_SPLASH`, a burst nearby that reached a shield: a fainter ripple), or on the hull (fire, debris, embers left on the plating, the hull glowing). Snapshot version 25.
- **A fight that never stops (2026-10-23).** The combat lab keeps 10 ships a side in the fight; those fleeing don't count, so others come in their place. A new one comes every `side_gap` (2 s) out of a jump `side_drop` (3.5 km) short of Prize along its route, not at the system's edge 30 to 60 km out. A new game there starts in a Prism military class I, the fastest hull, to watch from (the system file's `startShip`; `?ship=` still wins).
- **Classes scaled up (2026-10-23).** The class lengths are 14 / 30 / 66 / 145 / 320 m (were 18 / 34 / 60 / 100 / 160), about 2.2 times a step, and the bakes' resolution rose with them. Shield hardness now goes with length to the 1.5 (was squared), which keeps the tuning above at the new lengths: class II 0.49, III 1.6, IV 5.2, V 17.2; light shells shrugged off from class III up, medium ones by class V.
- **A grid for hits (2026-10-23; core/src/grid.rs).** Each tick the ships that can be hit go into a spatial hash of 250 m cells (a counting sort into flat arrays, no allocation); a shell tests only the ships whose cells its path, grown by the farthest any shield reaches, touches, and a burst only those within its blast. Same hits in the same order as testing every ship (the check's hashes didn't move), at a handful of ships a shell instead of all of them. Scratch only: outside the snapshot.
- **Big fights (2026-10-23).** The page's world holds 512 ships (was 128), the core 8,192 shells in flight and 1,024 bursts remembered (were 1,024 and 128; snapshot version 26). A lab's fighters don't count toward ambient traffic's `traffic_cap` (90), and a side keeps up to 200 (was 24). The combat lab keeps 60 a side, one arriving every `side_gap` (0.5 s) a side.
- **A battle over a planet (2026-10-23).** The combat lab's prize is a gas giant now, Prize (2.8 km, a port in its cloud tops), not a station. `ai_leash` counts from the contested body's surface, and loitering fighters circle at `ai_orbit` radii but no more than half a leash above it, so over a planet they swing round just off its limb instead of 8 km out.
- **Missiles (2026-10-23; core/src/missile.rs).** Forward bays (site size 4, `gen.js` draws a hatch each side of the bow and `footprint()` hands them to the core with the turret sites; `MAX_MOUNTS` 16), `types.missiles` from the loadout, a 512-missile pool, flight by proportional navigation under the ships' physics, a proximity fuse, waves per lab side (`side.wave`; the volleys timed by distance), and point defence in `turrets` (a missile grid, `mgrid`, like the ships'; shells test missiles as moving circles, and a burst's blast reaches them). A missile shot down is `B_SHOT`: a white flash and fragments; missiles draw as short white bolts with a flame and a smoke trail. The determinism scenario's biggest hull has two bays and both sides fire waves; the hashes agree. Snapshot version 27. Point defence first covered every enemy missile in a gun's reach: in the 60-a-side combat lab over 5 minutes, 1,154 launched at 18 targets (all class IV), 83% shot down, 9% struck a ship, 2 ships lost to them. Now a ship defends only itself (`ms_pd_near`) and a missile takes 4 points (`ms_hp`, was 2): over the same 5 minutes, 1,104 launched at 20 targets, 43% shot down, 32% struck a ship (8% their target, the rest ships in the way), 24% burst in the open (most after their target died or slipped the seeker), and 34 of the 455 ships lost went within 10 s of a missile hit. Then the fuse went to the target alone (missiles pass through every other ship): 946 launched at 19 targets (all class IV), 52% shot down, 17% struck their target, 26% burst in the open. Every target died, but most within seconds of the launch, to guns: a wave picks the most hurt of the biggest enemies, a ship already dying, and its missiles arrive to nothing.
- **Not yet:** the XL guns; spinal and other ventral mounts; missiles in the outfitter and bought as munitions; point defence covering allies' missiles beyond its own reach; countermeasures; turrets that turn on screen; hull blocking turret arcs; munitions bought; ion, arc and heat damage, resistances, system damage, field repair, disable; distress calls and patrols; traffic fighting back; bounty missions.

## Build order

1. Flares opt-in; the flare lab; Labs in the debug screen.
2. The combat lab and the Freeflag line.
3. Weapon sites (catalog, `gen.js`, the fit, the outfitter's Weapons group), the light multicannon as a module.
4. Shells, outlines and hits, damage to shields and hull.
5. NPC combat state, the AI, hostility, the player's fire control.
6. Tracers, muzzle flashes, bursts, shield hits; then a tuning pass in the combat lab.
