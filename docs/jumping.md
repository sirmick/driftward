# Jumping between systems

Status, 2026-10-17: built (the Book's Jumping chapter, M4; code in `core/src/jump.rs`, the page's side in `src/play/play.js` and `src/play/galaxy.js`). Built for experimenting: every number below is a core param, live-tunable with `__play.sim.param(name, value)`.

## The zones

Every system has 16 zones round it, one every 22.5° (zone k on the bearing k × 22.5° counter-clockwise from +x, in the galactic plane's x and y), at the system's jump radius (`jump_radius`, the system file's `traffic.jumpRadius`, 40 to 48 km in the March). Each lane takes the zone nearest its bearing toward its destination; where two lanes want the same zone, the second takes the nearest free one (in the universe index's lane order, so every page agrees; `gatesOf` in `play.js`). A lane's zone works both ways: you leave Brannock from its Calder zone and arrive at Calder's Brannock zone.

- **Lanes per system:** at most 16; the galaxy's most is 7 (GJ 3440), most have 2 or 3. Two lanes share a nearest zone in 90 of the 929 systems, never three.
- **A zone** is a runway along its bearing: `zone_len` 12 km long, `zone_width` 6 km wide, centred on the jump radius.
- **Gates** are the lanes as core content: per system, each lane's destination (star id), zone, light years and days, written by the page when it lays a system out and stored in the atlas with the rest of the system.
- **Buoys** mark them: a field across each runway, one every 500 m along and across, their lamps chasing outward along the bearing in the colour of who holds the far end (the course's next lane in green). Drawn on the HUD canvas.
- **The system map and radar** show each lane's runway, named, with its days, in the far end's colour; the course's next lane in green.
- **Traffic** arrives at and leaves by the gates (`n_zones`, `jump_point` in `traffic.rs`); a system without gates keeps the old four compass zones.

## The jump

| Phase | What happens | Params |
| :-- | :-- | :-- |
| **J** | In a lane's zone, moving out along it within `jump_align` (20°), at `jump_min` (0.5) of top speed or more, with the lane's fuel aboard. Refused otherwise, with the reason on the HUD. | |
| **Torch** | The drive takes the ship (on rails: the flight stages skip it), along the bearing, accelerating at `torch_accel` (2) top speeds a second to `jump_speed` (6×), burning half the lane's fuel as it goes. The plume grows long. | `torch_accel`, `jump_speed` |
| **Blink** | The rest of the fuel goes; the clock advances by the lane's days (fractions carry over, `game.day_part`); the core switches to the destination (its traffic and boards, as the debug jump does). The ship is out of the sim. | |
| **Transit** | `transit_secs` (4 s), played on the galaxy map: the lane lit, the ship a ring sliding along it, a timing bar. | `transit_secs` |
| **Chain window** | The last `chain_window` (0.8 s): J chains on along the course (amber prompt, the bar's end lit). A J before it wastes the chance. | `chain_window` |
| **Arrival** | Unchained: in the destination's zone for the lane come by, at jump speed heading in, slowing to top speed over `arrive_secs` (3 s); then the pilot has it, the assist holding top speed. | `arrive_secs` |
| **Chained** | In the zone of the course's next lane instead, lined up at jump speed; it coasts `chain_coast` (0.6 s) and blinks straight out, the next lane's fuel × `chain_cost` (1.0) spent at once; a new transit, a new window. | `chain_coast`, `chain_cost` |

**Fuel:** a lane costs the hull's tank × light years × `jump_fuel` (0.05: a 10 ly lane is half a tank). The Copperhaul's 4 t tank: Brannock to Calder (4.5 ly) 0.9 t, Calder to Merrow (10 ly) 2 t.

**Replays and saves:** J is a logged command (`CMD_HYPER`; a = -1 to jump, a = the next lane's gate in the destination to chain), every phase is core state on the game row, and the destination is stored into the atlas before each command (logged as its slot's bytes), so a session with jumps and chains replays natively to the same hash. The page lays each system out in a second core world that is never stepped, so storing one mid-flight never touches the live system.

**The page follows the core:** a blink changes system inside a tick, so after the steps (each frame, and after a test's `advance`) the page shows the new system (quietly in transit; the bake barrier goes up on a real arrival, not a chained pass), and plays the transit.

## Keys

- **J:** jump (in a zone), or chain (in the transit's window). The jitter probe moved to Shift+J.
- **M:** the galaxy map, where the course is set; the chain follows it. **Shift+M:** the system map.
- Dev: `CMD_ZONE` (102) puts the flying player in gate a's zone, lined up at top speed (`__play.command(__play.CMD.zone, g)`).

## Not built yet

- **Breaking a jump:** nothing can pull a ship off the line during the torch yet (interdiction is M2/M3: drag fields, ion, tractors); the core holds it on the bearing.
- **Misjump** (from anywhere at top speed, with damage): the Book's emergency exit.
- **Traffic's own torches and arrivals at speed:** NPCs still appear and vanish at the zones as before; they don't chain.
- **The autopilot to a zone:** fly there by hand, or target and fly toward it on the system map.
- **Uncharted lanes:** a lane to a system without a file says so; generated systems (docs/data.md step 4) open them up.
- **Sensor blackout on arrival** (the Book's 2 s).
