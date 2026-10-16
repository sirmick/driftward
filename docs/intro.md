# Intro and training

Status: **note only**, nothing built. An opening sequence that leads into a training stretch. It should mostly reuse the game's own graphics (planet, star, ship and station shaders, the star map) rather than new art.

## The sequence, roughly

Following the history in [setting.md](../src/lore/setting.md):

1. **The Lean Years.** Earth from orbit, its atmosphere darkening: haze, smoke, the lights going out. The planet shader with its air pushed dirty.
2. **The torch (2076).** A ship leaving Earth at full torch, the drive flame long and blinding.
3. **The Hundred Years.** The solar system filling: the Moon, Mars, the belt, then a jump-style cut out to a moon of Jupiter (Callisto, Valhalla crater).
4. **The Valhalla Result (2176) and the Rush.** Cut to the 3D star map: systems lighting up outward from Sol over the centuries, inner ring, middle, outer.
5. **Contact (2376).** Bloom worlds appearing on the map, their sector.
6. Then the Fracture, Freeflag, Shadowfall and the Glass as map beats, landing in 2526 and the player's first ship: the training part.

## What it asks of other systems

* The star map's **timeline**: done. Every system in src/galaxy/galaxy.json carries its year (settled; for the Bloom, charted after contact in 2376; the Shadow seen from 2519; Corran and the front emptied 2521 to 2523; the Glass lost in 2524), on the setting's Rush curve, and the map's Year slider plays it back. The intro needs a scripted camera and a timed sweep of that slider.
* The planet shader needs to show Earth (and the darkening) well enough to open the game on.
* A scripted camera, so a sequence can drive flight and map views without the player.
