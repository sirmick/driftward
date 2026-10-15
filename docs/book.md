# **Driftward: The Book**

The book of mechanisms. Each chapter describes how one part of the game works: the state it keeps, the rules that change that state, and what it feeds into. Setting, names and lore are out of scope; the few setting facts that mechanisms depend on are listed in the appendix. Each mechanism is tagged with the milestone that builds it, \[M0\] to \[M9\] (see Build staging), and every list is sorted by milestone.  
**Work so far:**

* Repository: [github.com/sirmick/driftward](https://github.com/sirmick/driftward) (asset lab and flight prototype; open index.html, no build step).  
* Live prototype: [the Driftward asset lab](https://claude.ai/artifact/4bJGAogVDy25LeVjvSAjjJ) (Yard, Ship, Planets, Suns, Heavies, Stations, Asteroids and Fly tabs).  
* Latest commit: [7441872](https://github.com/sirmick/driftward/commit/7441872), "Fly: unified flight physics, nebula and radiation, sensors".

Chapter status:

| Part | Chapter | Status |
| :---- | :---- | :---- |
| I. Foundations | Design rules; Time | Draft |
| II. The world | Galaxy map; System contents | Draft |
|  | Facilities | Agreed |
| III. Simulation | Economy; Population and colonies | Agreed |
|  | Conflict; Faction AI; Traffic; Reputation and allegiance | Agreed |
| IV. Play | Flight, sensors and environment; Jumping and interdiction; Docking and landing; Ships; Outfitting; Energy and heat; Weapons; Shields; Damage and repair; Boarding and capture; Fleets and doctrine; Law, notoriety and scanning; Mining; Exploration and the Drift; Death, saving and insurance | Agreed |
|  | Missions | Agreed |
|  | Player systems | Draft |
|  | Progression; Interface and art | Draft |
| V. Building it | Content pipeline; Simulation core; Build staging | Draft; not yet designed in full |
|  | Open questions | Living list |

# **Part I: Foundations**

## **Design rules**

* Sim decides, LLM narrates: every number, price and outcome comes from rules. LLM output is text, plus picks from enumerated options, validated against a schema.  
* The world runs without the player: economy, conflict and traffic advance on the clock whether or not the player acts.  
* Persistence: player actions are written into world state (named systems, kept colonies, killed targets) and are never rolled back.  
* Frontier generation: charted space is fixed. Drift systems are generated on first contact, seeded from their neighbors so they stay coherent.  
* Two fidelity tiers: the player's current system is simulated in full; every other system runs as aggregates. This applies to the economy, conflict and traffic alike.

## **Time**

* \[M1\] Landings cost 1 day. While landed the player can wait in place, one day at a time, paying docking fees.  
* \[M1\] Each day runs the economy, conflict, population and event ticks. Once flight runs the clock, the daily tick is spread across frames (or run in a worker) so it never hitches; day boundaries fall on fixed frame counts, so it stays deterministic.  
* \[M1\] Deadlines, intel age, event durations and recovery curves are all measured on this clock. Faction task forces move at the same days per lane as the player.  
* \[M4\] Flight runs the clock in real time: 10 minutes in space is 1 day. It always runs, in combat too, so mining, loitering and slow Drift crawls cost days. Until then, only landings and waiting advance the clock.  
* \[M4\] Jumps advance the clock in proportion to lane length, about 1–3 days, shown on the map. A better drive spends less fuel per jump but takes the same time.  
* \[M7\] Pacing: a typical system visit is 2–5 minutes (under half a day); a 30-jump stretch is about 85 days, which sets the scale for front shifts and colony growth.

# **Part II: The world**

## **Galaxy map**

* \[M4\] Graph: systems are nodes and jump lanes are edges, grouped into regions.  
* \[M4\] Rings: every system sits in the inner, middle or outer ring. The ring sets baseline wealth, security and unrest.  
* \[M4\] Jumping: leaves from a jump zone at top speed (see Jumping and interdiction); costs fuel and advances the clock.  
* \[M4\] Intel snapshots: every system's map entry is a snapshot with an age and an accuracy. The map never shows live state for systems the player is not in.  
* \[M4\] Accuracy by distance: adjacent systems are well known; accuracy falls with lane distance and with age ("prices 14 days old"). Values are shown as estimates with error bars that widen with both.  
* \[M4\] Real error: a snapshot is the true state plus noise drawn when it was taken, so a distant or stale reading can be wrong, not just vague.  
* \[M5\] System entry: owner and government, security and unrest, known events, commodity prices, and a traffic histogram of ships by role and size class with tonnage flowing in and out.  
* \[M6\] Sources: visiting gives exact data. Relays and bars sell fresh snapshots for a region; faction rank shares that faction's intel; the player's freighters and outposts report from where they are.  
* \[M8\] Lane types: stable lanes never change. Drift lanes shift every few weeks, so charts expire. Hidden lanes are revealed by scanning anomalies.

## **System contents**

* \[M0\] Hazards: nebula gas and radiation fields (see Flight, sensors and environment); accretion disks are lethal but allow slingshots.  
* \[M1\] Stars: single or binary, one of 12 classes. Exotics (pulsars, black holes) create hazard zones.  
* \[M1\] Planets and moons: inhabited ones are landable, with a market, mission board and outfitter. Uninhabited ones are resource and survey targets.  
* \[M1\] Belts and fields: mining targets.  
* \[M1\] Stations: facilities (next chapter).  
* \[M3\] Derelicts and wrecks: salvage, logs and sometimes survivors.  
* \[M4\] Jump points and beacons at the system edge.  
* \[M5\] Heavies: large NPC ships in transit, carrying aggregate flows.  
* \[M8\] Anomalies: science targets and the source of hidden lanes.

## **Facilities**

* \[M5\] Each facility is an economic node that runs recipes: inputs in, outputs out, with stockpiles.  
* \[M5\] Several facilities share a system and form a local supply chain. In the player's system the flows between them are real ships (ore tugs, tankers, crew shuttles), so interdicting a refinery's tugs cuts its output.

Facility recipes and services:

| Facility | Takes | Makes | Services |
| :---- | :---- | :---- | :---- |
| Mining outpost | — | Ore | Mining contracts |
| Ice harvester | — | Water, volatiles |  |
| Gas skimmer (at giants) | — | Fuel, chemicals | Cheap fuel |
| Refinery | Ore, volatiles | Metals, chemicals |  |
| Forge | Metals | Alloys, components, munitions |  |
| Agri ship or agri world | Water, light | Food, biomass |  |
| Habitat ring | Food, goods | Crew, passengers, labor | Bar, rumors, hiring |
| Container port | — | — | Market hub, warehousing |
| Shipyard | Alloys, components | Hulls, outfits | Buy and sell ships |
| Relay array | — | Intel, charts | Mission board, news |
| Military base | Food, munitions | Security | Bounties, licenses |
| Research lab | Science data | Tech unlocks | Science missions |
| Pirate haven | Contraband | Contraband | Black market, fence |

# **Part III: Simulation**

## **Economy**

### **Goods and prices**

* \[M5\] Commodity tiers: raw (ore, ice, gas, biomass); refined (metals, water, fuel, chemicals); manufactured (alloys, components, machinery, food, medicine, consumer goods, munitions); rare (alien biotech, crystal, artifacts); contraband (weapons, narcotics, AI cores); data (charts, intel, science).  
* \[M5\] Price: base × (target ÷ stock)^elasticity, clamped to roughly ¼× to 4×.  
* \[M5\] Market depth: each sale moves stock, so dumping 200 tons crashes the price. One-route grinding stops paying.  
* \[M5\] NPC haulers trade on price gaps. That equalizes prices and produces the visible traffic that pirates hunt.  
* \[M9\] Investment: funding a facility expansion buys a share of its output and influence in the system.

### **Two fidelity tiers**

* \[M5\] Current system: every facility runs recipes continuously with real stockpiles; trade moves in individual haulers that can be escorted or interdicted.  
* \[M5\] Every other system: one aggregate stock per commodity per market, updated per tick. Trade moves as flows along lanes, sized by the price gap minus transport cost and capped by lane capacity and risk. Between events, stock drifts with mean-reverting noise toward target.  
* \[M5\] Handoff: arriving seeds the detailed sim from the aggregate state, with hauler counts proportional to current flows. Leaving folds the detailed state back, so the player's effects persist.

### **Shock propagation**

* \[M5\] A local supply cut lowers stock, and the price rises immediately.  
* \[M5\] Neighbors feel it over the next ticks as imports shrink.  
* \[M5\] The effect spreads outward by lane distance, delayed and damped, while the price gap pulls in supply from farther away: felt next door within days, faintly three jumps out, gone within weeks.  
* \[M5\] Haulers reroute toward the shortage, so traffic visibly shifts.

### **Remote events**

* \[M5\] Each system rolls events on a Poisson clock whose rate rises with instability (weak security, war, outer ring). Severity is heavy-tailed.  
* \[M5\] Every event is a mechanical effect with a duration and a recovery curve. The LLM writes only the news item.

Event effects:

| Event | Mechanical effect |
| :---- | :---- |
| Refinery or forge disaster | Facility output ×0 for N days, then a ramp back |
| Famine or crop blight | Agri output ×0.2 for weeks; food demand spikes in every system it feeds; habitats lose population until relieved |
| Attack on a shipping lane | Lane capacity ×0.3 and risk up; flows reroute |
| Pirate surge | Risk up on several lanes; insurance and prices up |
| Plague | Medicine demand ×3 |
| New colony boom | Food and goods demand up for months |
| Strike or embargo | A facility, or one faction's trade, stops |
| Rich discovery | Ore supply up and prices crash; prospectors arrive |

### **Interactions**

* \[M5\] Repairs consume goods: a damaged facility needs alloys and components to recover, so every disaster creates demand for its own repair.  
* \[M5\] Information lag: remote events are learned only through news and intel, so racing goods to a fresh shortage is a trading skill.  
* \[M7\] Relief: supplying a famine or plague system pays well, moves reputation and lowers unrest. An unrelieved famine permanently reduces the system's population.  
* \[M7\] Interdiction as a weapon: starving a faction's forge raises its munitions and outfitting costs and lowers its fleet strength.

### **Guardrails**

* \[M5\] Price clamps and minimum background flows, so no market collapses permanently.  
* \[M5\] A cap on concurrent major events per region.  
* \[M5\] Recovery curves, so the galaxy heals without the player.

## **Population and colonies**

### **State**

* \[M7\] Population (P) per inhabited body, shown to the player as a tier.  
* \[M7\] Capacity (K): set by habitability (planet type, habitats, agri ships and worlds) and raised by infrastructure.  
* \[M7\] Needs met (S): the share of per-capita demand actually supplied: food, water, medicine and goods, plus luxuries in the inner ring.  
* \[M7\] Population feeds the existing unrest and wealth values.

### **Growth**

* \[M7\] Logistic, gated by needs: P grows toward K slowly (months of strategic time) only while needs are met.  
* \[M7\] Shortfalls: a food shortfall shrinks population fast (famine); a medicine shortfall lets plague kill; overcrowding (P above K) raises unrest and pushes people out.  
* \[M7\] Migration: people move along lanes toward wealth, safety and met needs, carried as liner passengers in traffic. War, famine and exterminator waves create refugee surges that strain the destination's needs and raise unrest there too.

### **What population does**

* \[M7\] Labor: facility output scales with available labor, so a depopulated system's refineries slow. Habitats turn population into crew and passengers.  
* \[M7\] Demand: per-capita consumption sets the economy's stock targets, so a growing colony pulls in goods.  
* \[M7\] Taxes fund the owning faction's wealth, which funds fleet strength.

### **Settlement tiers**

Crossing a threshold adds services, facility slots, defenses and traffic:

| Tier | Population | Unlocks |
| :---- | :---- | :---- |
| Outpost | Up to about 1,000 | Refuel and a basic hull patch; built from kits |
| Colony | Thousands | Small market and mission board |
| Town | Hundreds of thousands | Outfitter, more facility slots, patrols |
| World | Millions and up | Full services, shipyard, major traffic |

### **Colony life cycle**

* \[M7\] Founding: a colony ship delivers the first settlers and a station kit.  
* \[M7\] Fragile phase: the colony needs supply runs (missions) until local agri and ice make it self-sufficient; it grows if fed and dies if not.  
* \[M7\] Decline: sustained shortfall shrinks it. Below a floor it is abandoned and becomes a derelict, feeding the Drift's derelicts and the resettlement loop.

### **Exceptions**

* \[M9\] The hive grows as biomass by seeding, not by migration; the AI zone has no population and converts systems; the exterminators have none.

### **Simulation**

* \[M7\] Population ticks on the strategic clock in both fidelity tiers, including during flight.  
* \[M7\] The galaxy map shows each body's tier and trend, subject to intel age.

## **Conflict**

### **Actors**

Factions are referred to by role in the mechanism chapters; their names are in the appendix. Each one changes system ownership by a different mechanism:

| Role | Territory | Takes systems by | Mechanical notes |
| :---- | :---- | :---- | :---- |
| Navy | Inner and middle rings | Conquest and garrison | Reactive: allocates fleets to the largest threat; crackdowns raise unrest |
| AI corpo | Inner-ring enclaves | Buyout | No territorial war; uses contracts, private security and debt |
| Miners | Belts and refineries everywhere | Never takes systems | Strikes (a supply shock); shelter pirates; side with whoever pays or feeds them |
| Pirates | Hidden havens | Lawlessness | Raid core-bound convoys, not miners |
| Rebels | Outer ring, spreading inward | Revolt | Driven by unrest; insurgency and convoy raids instead of fleet battles |
| Hive | Own cluster plus seeded worlds | Seeding | Takes uninhabited or devastated worlds; hostile to exterminators |
| AI zone | One contiguous region | Conversion | Alternates slow creep with surges when containment lapses |
| Exterminators | Beyond the edge | Sterilization | Incursion waves; no diplomacy (see below) |

### **State**

* \[M7\] Per system: owner, influence per faction, garrison, unrest (0–1), devastation.  
* \[M7\] Per faction: strength (fleet points produced by the economy of owned systems), supply reach, war weariness, and a posture of expand, hold or recover.  
* \[M7\] The strategic tick runs on the same clock as the economy.

### **Ownership changes**

How a system changes hands:

| Mechanism | Used by | Condition |
| :---- | :---- | :---- |
| Conquest | Navy, rebels, any fleet power | Challenger influence exceeds the owner's and the garrison is broken |
| Revolt | Rebels, independents | Unrest above threshold for N ticks while the garrison is weak |
| Lawlessness | Pirates | Patrol presence below threshold; owner unchanged, but law, prices and traffic flip |
| Buyout | AI corpo | Economic influence overtakes the owner's, within the owner's tolerance |
| Conversion | AI zone | Uncontested presence in an adjacent system for long enough |
| Seeding | Hive | Uninhabited or devastated world near hive space |
| Sterilization | Exterminators | A wave wins; the system becomes dead and enters the resettlement loop |
| Strike | Miners | Not a change of owner: output stops until demands are met or the strike is broken |

### **Unrest**

* \[M7\] Inputs: ring baseline; food and medicine prices against wages (famine and blockades feed straight in); garrison oppression, which lowers revolt odds now and raises pressure later; adjacency to rebel systems, spreading along lanes; player actions.  
* \[M7\] Outer-ring coupling: navy crackdowns on miners for harboring pirates raise miner unrest, which feeds the rebels.

### **Feedback that drives ebb and flow**

* \[M7\] Supply lines: strength decays with lane distance from owned industry. Overextension weakens a front; cutting a lane isolates the pocket beyond it.  
* \[M7\] War weariness: losses build weariness, which forces ceasefires and a recover posture.  
* \[M7\] Occupation cost: newly taken systems have high unrest and low output for a period.  
* \[M7\] Guardrails: capitals carry large garrison multipliers, ownership changes per region per period are capped, and a soft pull toward equilibrium prevents one faction taking the map.  
* \[M9\] Common enemy: an exterminator wave forces a temporary truce between the navy, rebels and hive; it lapses after the wave.

### **Exterminator waves**

* \[M9\] 3–5 hidden minds, each with its own strength, fight each other off-map.  
* \[M9\] A wave launches when one mind dominates the others, so the incursion timer is an outcome of that hidden war, not a fixed clock.  
* \[M9\] Each wave's loadout counters the damage mix that beat the previous wave.  
* \[M9\] No diplomacy. Late arcs can shift strength between minds; one optional arc has a mind use the player against a rival, then betray them.

### **AI zone**

* \[M9\] The zone's border advances by conversion. Containment pressure (navy presence on its border lanes) holds it; when pressure lapses, it surges.

### **Resettlement loop**

* \[M8\] Dead system → salvage rush (miners, pirates) → colony ships → outpost → colony → contested → conquered or sterilized → dead again.  
* \[M8\] Any faction can seed resettlement. The founder owns the colony until someone takes it.

### **Consequences and remote resolution**

* \[M7\] An ownership change rewrites tariffs, legality, prices, mission offers and reputation effects. Traffic changes to the new owner's ships.  
* \[M7\] Remote fronts carry a pressure value; battles and ownership changes fire as Poisson events weighted by pressure. Only the current system resolves in detail.  
* \[M7\] Missions apply influence and supply deltas. The player is a weight on the scale, not the deciding factor.

## **Faction AI**

The decision layer above Conflict: how each faction chooses where to expand, attack, defend and withdraw. It is deterministic and runs on the strategic tick; no LLM is in the loop.

### **Pacing**

* \[M7\] Slow by design: tuned in player jumps: each jump advances the clock by its lane length (about 1–3 days) and each landing by 1 day. A front visibly shifts over about 30 jumps; one system rarely changes hands in fewer than about 10\.  
* \[M7\] Slowness comes from the mechanism, not a timer: plans take many ticks to build, hold for a minimum period once chosen, and run on the faction's own aging intel.

### **Decision loop**

Each faction, each strategic tick:

* \[M7\] Assess: score every known system on value (economy, population, lane centrality), threat and frontier stage. Inputs come from the faction's own intel, which ages and carries error like the player's, so factions can misjudge.  
* \[M7\] Generate: candidate actions per system: settle, attack, reinforce, raid, escort trade, scout, withdraw.  
* \[M7\] Score: utility \= value × P(success) − cost − risk, weighted by doctrine.  
* \[M7\] Allocate: wealth pays upkeep first, then actions in order of utility per credit, then new hulls and colony ships.  
* \[M7\] Commit: a chosen plan holds for a minimum period unless it fails outright; switching plans has a cost in the score, so factions do not dither.

### **Doctrine**

* \[M7\] Each faction has a doctrine vector: aggression, expansion, greed, caution, honor. It is authored offline within a schema and drifts slowly with events (heavy losses raise caution).

Every faction runs the same loop; doctrine and the allowed action set make them differ:

| Faction | Allowed actions | Bias |
| :---- | :---- | :---- |
| Navy | Attack, reinforce, escort, scout, settle, withdraw | Reactive: fleets go to the largest threat, leaving gaps elsewhere |
| AI corpo | Buyout, contracts, private security | No territorial war |
| Miners | Strike, harbor pirates, settle belts | Never take systems |
| Pirates | Raid, lawlessness | Weak patrols and core-bound cargo; avoid miner traffic |
| Rebels | Revolt, insurgency, convoy raids | Gated by unrest |
| Hive | Seeding | Simple state machine |
| AI zone | Conversion, surge | Creeps under containment, surges when it lapses |
| Exterminators | None | Not this loop: the wave director in Conflict |

### **Task forces**

* \[M7\] Fleets are abstract task forces (tonnage by role) that move along lanes at a fixed number of days per jump. They become real ships only when the player is present, per the fidelity tiers.  
* \[M7\] Buildups take visible time: fleets mass at a border, colony kits stockpile, patrols thin elsewhere.

### **Missions from unmet needs**

* \[M7\] Any part of a plan the faction cannot cover itself is posted as a mission: scout, escort the colony ship, supply run, sabotage, hold a jump zone.  
* \[M7\] Mission outcomes shift the plan's P(success). A plan whose missions fail stalls or is abandoned. The board shows which plan each mission serves.

### **Diplomacy**

* \[M7\] Tension per faction pair, moved by raids, border incidents and shared enemies. Thresholds flip the pair between war, cold, peace and alliance, with hysteresis.  
* \[M7\] Coalitions: a dominant faction raises every other faction's tension toward it, adding to Conflict's guardrails against one faction taking the map.

### **Visibility**

* \[M7\] Plans are readable as intel ("fleet massing at X, likely target Y, 60%"), with the same age and accuracy rules as other intel. Closer and fresher intel is sharper.

### **Player voice**

* \[M9\] The normal loop (expansion, the scramble for resources) runs on its own.  
* \[M9\] Major plans (an offensive, a declaration of war or peace, a founding drive into the Drift) are put to the player once they hold top rank in that faction: pick one of the two or three highest-scoring candidates. The pick gets a utility bonus and the player's arc missions attach to it.

### **Leaders**

* \[M9\] Each major faction has named leaders: a head and front commanders. A leader adds a doctrine offset on top of the faction's doctrine.  
* \[M9\] Leaders can die in battle, be assassinated (a mission target) or be replaced after failure. A successor brings a new offset, so a faction's behavior shifts when its leadership does.  
* \[M9\] Names and personalities come from the lore pass.

## **Traffic**

Traffic is a projection of a system's sim state onto ships, and what happens to those ships feeds back into the sim.

### **Sources**

* \[M5\] Lane flows (tons per day per commodity) become haulers and convoys.  
* \[M5\] Local recipe flows between facilities become tugs, tankers and crew shuttles.  
* \[M5\] Lane risk and lawlessness become pirates.  
* \[M5\] Active events add overlays (below).  
* \[M7\] Garrison and faction strength become patrols.  
* \[M7\] Front pressure becomes military task forces.  
* \[M7\] Population and wealth become liners and private craft.

### **Spawning**

* \[M1\] Arrival rate: per role, λ \= flow ÷ ship capacity for haulers, and the equivalent for other roles. Arrivals are a Poisson process at jump points and from station undocking.  
* \[M1\] Steady state on entry: the system starts with N \= λ × dwell time ships per role, placed at random points along their routes, so traffic looks mid-flow.  
* \[M1\] Budget: a cap on concurrent ships (about 40–60 to start). Roles share it by rate; when the cap binds, each ship represents more tonnage rather than more ships appearing.  
* \[M3\] Ship mix: role → owning faction → line → doctrine → size class, weighted by ring and system wealth. Haulers, shuttles, liners and miners come from civilian lines; patrols and task forces from military lines (see Ships). Hulls are generated from the faction style, line, size class and a seed, and cached.

### **Roles**

Each role is a small state machine:

| Role | Loop | Reacts to |
| :---- | :---- | :---- |
| Hauler | Jump in → dock → undock → jump out | Flees threats; calls for help |
| Tug or shuttle | Between local facilities (ore → refinery → port) | Interdiction cuts the recipe input |
| Convoy | Haulers plus escorts, formed when lane risk passes a threshold | Escorts engage; haulers keep moving |
| Patrol | Circuit of jump points and stations; scans traffic | Distress calls, player notoriety, pirates |
| Pirate | Lurks near lanes and jump points | Attacks when prey value ÷ defense is high enough; flees on losses |
| Miner | Belt → mine → refinery | Flees; escorted in the outer ring |
| Task force | Moves to the front or a contested station | Front pressure, ownership changes |
| Liner or private craft | Port to port | Passive |
| Alien or AI presence | Hive seeders, AI-zone probes, exterminator waves | Their own conflict rules |

* \[M2\] Distress: an attacked ship calls for help; a patrol responds after a delay that falls as patrol density rises.  
* \[M2\] Morale: every NPC has a flee threshold, so fights end in retreats as well as kills.

### **Feedback into the sim**

* \[M5\] Delivered cargo adds to stock; destroyed or stolen cargo never arrives.  
* \[M5\] Pirate successes raise lane risk, which raises convoy formation.  
* \[M5\] On exit, net deliveries, losses and kills fold into the aggregate state.  
* \[M7\] Kills reduce faction strength; patrol kills lower pirate presence.

### **Persistence**

* \[M1\] Ambient ships are forgotten on exit.  
* \[M4\] Ships the player touched (damaged, robbed, hostile, mission-linked) are remembered for N days.  
* \[M6\] Named NPCs persist globally and move on the lane graph at the aggregate level.

### **Event overlays**

How events show up in traffic:

| Event | Traffic |
| :---- | :---- |
| Blockade | Patrol line at jump points, haulers queueing, smugglers |
| Famine | Relief convoys inbound |
| Ownership change | New owner's patrols; old owner's ships evacuating |
| Exterminator wave | Refugee streams outbound, then silence |
| Strike | Idle miners and haulers parked at stations |

### **Simulation detail**

* \[M1\] Ships far from the player run on rails along their routes; near the player they switch to full physics and AI.  
* \[M1\] Whole system, not a bubble: every ship in the system exists for the whole visit; distance only sets fidelity (rails far, full physics and AI near), so ambushes, convoys and patrol sweeps stay consistent. The concurrent-ship cap keeps it cheap.  
* \[M4\] NPC hails (extortion, bribes, distress): the sim picks the hail type and the reply options (pay, refuse, fight, flee) and resolves the outcome; the LLM writes the lines, generated when the ship spawns.  
* \[M5\] Each system's traffic mix is also part of its map intel (see Galaxy map).

## **Reputation and allegiance**

* \[M6\] Standing per faction (−100 to \+100): how the faction feels now. It sets prices, access and hostility; gains with one faction move standing with its rivals through the relations matrix; it drifts slowly toward a baseline.  
* \[M6\] Merit per faction: earned from that faction's missions and never decays. It pays for promotion.  
* \[M6\] Rank (1–5): promotion needs a merit threshold, a minimum standing and a promotion mission.

Ranks:

| Rank | Unlocks |
| :---- | :---- |
| 1 Contractor | Basic missions; early arcs are open with every faction, including the AI zone and the hive |
| 2 Trusted | Licensed outfits; the faction shares its intel |
| 3 Sworn | An oath mission commits the player: rival factions' advanced arcs lock and standing with them drops. Military outfits and hulls |
| 4 Officer | Exclusive advanced arcs, a faction escort wing, faction insurance |
| 5 Flag | Say over major plans (see Faction AI), capital hulls, endgame |

* \[M6\] Suspension: standing below a rank's floor suspends its privileges until repaired. Attacking one's own faction strips rank and sends hunters.  
* \[M6\] Exclusions at commit: navy, rebels and pirates exclude each other; the AI corpo and the AI zone exclude each other; the hive refuses anyone committed to the AI corpo. Miners stay neutral.  
* \[M6\] Faction record: territory, doctrine, relations matrix, wealth, military strength, needs, and a voice profile for the LLM. Needs drive mission offers. Minor factions are generated within the same schema.  
* \[M9\] Career ratings (global): combat (kills weighted by target strength), trade (tonnage and profit) and exploration (systems charted). They gate specialist missions and change NPC reactions: pirates avoid a high combat rating; bounty hunters seek it out.

# **Part IV: Play**

## **Flight, sensors and environment**

One physics for every ship, with flight assist as a control layer on top. The environment is a set of fields over each system that every ship samples each tick.

### **Physics**

* \[M0\] Newtonian for every ship: thrust, mass and inertia, with no friction in vacuum. The player and NPCs share one integration path.  
* \[M0\] Actuators: main engine, reverse thrusters (50% of main), lateral thrusters (30% of main) and a turn rate.  
* \[M0\] Drive taper: each thruster's force falls to zero as speed along its axis approaches the hull's v\_max, so a ship cannot push itself past its cap.  
* \[M0\] Dampers: speed above v\_max, from gravity, slingshots or recoil, bleeds off slowly.  
* \[M0\] Burner: ×1.7 thrust and ×1.3 speed cap; burns fuel, adds heat and a large signature.  
* \[M0\] External forces: gas drag (density × v²), planet gravity (softened inside the body) and weapon recoil, all summed with thrust and integrated once. Gravity can carry a ship past v\_max; the dampers then bleed off the excess.

### **Flight assist**

Three levels on the same thrusters and limits; the controller just does more or less of the flying:

| Mode | Rotation | Translation | For |
| :---- | :---- | :---- | :---- |
| Full assist | Rate-controlled: the stick sets turn rate; the ship stops turning on release | Velocity hold: set speed along the nose, lateral thrusters cancel drift | Default |
| Drift off | Rate-controlled | Newtonian: thrust adds velocity, nothing cancels drift | Intermediate: strafe-drifting, firing while sliding |
| Full off | Torque: angular momentum persists; counter-thrust to stop a turn | Newtonian | Pros: full control |

* \[M0\] Full assist: forward and back set a speed along the nose; the controller turns the desired velocity into main, reverse and lateral thrust. NPCs always fly through this controller.  
* \[M1\] Drift off and full off: raw thrusters, plus strafe and point-retrograde controls.  
* \[M1\] No mode is faster in raw terms, since all three share the same limits. The player can switch at any time.

### **Signature and detection**

* \[M0\] Signature: hull size^1.2 × (idle \+ engine thrust \+ burner \+ shields up \+ recent fire \+ heat). Running cold drops shields and cuts signature to about a third; an active ping adds a large spike.  
* \[M0\] Detection: SNR \= k × signature ÷ range² × gas transmission ÷ local noise. Noise rises with radiation and ionized gas around the observer.  
* \[M0\] Contact levels: SNR ≥ 1 is a contact (position with an error radius); SNR ≥ 3 is identified (class and faction); holding an identified target within 5 km for about 2 s completes a scan (shields, hull, role, and whether it is tracking you).  
* \[M0\] Active ping: sensor gain ×6 for a few seconds, but the pinging ship's signature spikes so everyone hears it. Has a cooldown.  
* \[M0\] Symmetry: NPCs run the same equation against the player. Hostiles engage only contacts they hold and remember a lost contact for a few seconds.  
* \[M2\] Targeting: missile lock needs an identified contact; lock time rises with range and ECM and falls with signature. Unguided weapons fire at any contact with a lead indicator. ECM adds false contacts; decoys pull torpedoes.

### **Nebula gas**

Each system stores a coarse density grid per gas species:

| Species | Drag | Sensors | Shields | Other |
| :---- | :---- | :---- | :---- | :---- |
| Hydrogen | Mild | Mild attenuation | — | Fuel scoop: slow refuel |
| Dust | Heavy | Strong attenuation; the best place to hide | — | Abrasion on armor; mining pockets |
| Ionized | Moderate | Raises noise | Drains shields | Arc weapons chain farther; ion storms as events |

* \[M2\] Gas carries heat away, so radiators work several times faster inside a nebula.  
* \[M2\] Beams lose damage with gas density along their path; torpedo seekers suffer in dust; multicannons and rails are unaffected.

### **Radiation**

* \[M0\] Field: the star's output by class, multiplied during flares and dimmed in shadows, plus ionized gas. Pulsar beams and accretion disks add local sources.  
* \[M0\] Shadows: radiation travels in straight lines from its source, so each planet casts a shadow corridor on its far side.  
* \[M0\] Effects: shields soak radiation continuously; above a threshold, unshielded hulls take damage and heat; radiation raises the sensor noise floor for everyone nearby.  
* \[M0\] Flares: timed events with a short warning. The stellar term rises about tenfold for several seconds; shelter is a planet's shadow.

### **Heat and fuel**

* \[M2\] Heat: added by the burner, firing and radiation, and shed by radiators, faster in gas. Overheating locks weapons and burner until the ship cools; extreme heat damages the hull.  
* \[M4\] Fuel: spent by the burner and by jumps; refilled at stations or by scooping hydrogen.

### **Data**

* \[M0\] Each system's gas and radiation fields are generated from its star and nebula parameters (enums the LLM picks), sampled per ship each tick, and drawn by the renderer from the same data.

## **Jumping and interdiction**

Jumps leave from fixed zones at full speed, which makes routes predictable and interdiction possible.

### **Jump zones**

* \[M4\] Geometry: every outbound lane has a zone: a large arc at the system edge on the bearing toward the destination, outside every gravity well. Zones are kilometres wide, so covering one takes several ships.  
* \[M4\] Display: zones appear on the radar and system map as arcs colored by destination, with known contacts inside them. The galaxy map shows reported blockades, subject to intel age and error.

### **The jump**

* \[M4\] Conditions: the ship is inside the destination's zone, its velocity vector (not its nose) is within about ±20° of the bearing, and its speed is at or above about 97% of the hull's rated top speed, held for a short window (about 1 s, longer for heavy hulls). Fuel is spent.  
* \[M4\] No spool and no mass lock: the run-up is the charge. Speed gained from the burner, gravity or slingshots counts.  
* \[M4\] Arrival: in the destination's inbound zone on the side facing the origin, scattered across the zone, with velocity preserved and a short sensor blackout (about 2 s).  
* \[M4\] Emergency misjump: at top speed from anywhere outside a gravity well; the ship lands at a random point in the destination system with drive damage and a heavy fuel cost. It keeps a blockade from ever being a hard lock.

### **Interdiction**

Anything that holds a ship below its top speed, or bends its velocity off the bearing, during the hold window stops the jump:

* \[M3\] Drag-field projector: the interdictor outfit. A bubble of artificial drag; because thrust is near zero at top speed, any drag pulls a ship under. It runs on a duty cycle, is very loud, and makes its carrier the priority target. Fields are leaky: a burner can punch through a weak one.  
* \[M4\] Ion weapons drain energy and weaken thrust; tractors pull directly; mines and debris force dodges and add drag.  
* \[M4\] Blocking hulls and threat force turns that break alignment.  
* \[M4\] Dust in a zone adds natural drag, so some zones are hard to leave even unguarded.  
* \[M4\] Blockade strength: bubble area ÷ zone area. Remote systems use the same number for lane capacity and risk. A full siege covers every inbound zone into a system.

### **Survival**

* \[M4\] Speed: arrive at the zone already fast and aligned; use the burner for margin above top speed, and slingshots to get there.  
* \[M4\] Shields: hold a straight line under fire instead of jinking, which would break alignment.  
* \[M4\] Timing: run the gaps in a drag field's duty cycle or a patrol's sweep; approach cold through dust; use flares to blind sensors; let a convoy draw fire.  
* \[M4\] Alternatives: another lane and double back (days and fuel), a hidden lane, decoys, or a misjump.

### **Knock-on effects**

* \[M4\] NPCs obey the same rules, so traffic forms long straight corridors into each zone, and pirates know where to hunt.  
* \[M4\] Arrivals come in fast, so an inbound ambush needs drag fields rather than parked guns.  
* \[M4\] Missions: blockade running, interdicting a bounty target whose route is known from the lane graph, escorting a convoy through a camped zone, breaking a siege by killing its interdictors. Navy patrols sweep zones.

## **Docking and landing**

Ports are safe harbor once you are down; the risk lives in the approach and the launch.

### **Landing on planets**

* \[M1\] Approach: fly over the planet's disc, slow to near-stationary relative to it, and request clearance.  
* \[M1\] Descent: a short, skippable sequence (2–3 s). The ship shrinks toward the surface inside a red plasma sheath that runs white-hot on the leading edge, then fades into the atmosphere's tint. The sheath is drawn from each hull's baked distance field, so it fits every generated silhouette.  
* \[M1\] Blastoff: the same in reverse. The ship rises out of the surface glare wrapped in plasma, grows to full scale, and control returns with a small orbital velocity.  
* \[M1\] Time: each landing advances the strategic clock by 1 day.  
* \[M6\] Clearance: checked against notoriety with the owner, restrictions, blockades and hostility. The port may deny it, demand a customs scan, or take a bribe in corrupt systems. Pirate havens clear only ships with the transponder off.

### **Capital ships**

* \[M3\] Capitals cannot land. They hold station in orbit while a lander detaches and makes the plasma descent.  
* \[M3\] Large stations and shipyards have capital berths; elsewhere the capital stays off and sends its lander.

### **Docking at stations**

* \[M1\] As in Escape Velocity: be over the station and nearly still relative to it, then hold briefly while the clamps engage.  
* \[M1\] Moving stations: ring stations spin and some orbit, so still means matched to the station's velocity. Assist does the matching; with assist off it is a skill.  
* \[M3\] Berths by size class: a small relay array cannot take a carrier.

### **Safe harbor**

* \[M1\] Once landed or docked, the player is safe: flight is paused and nothing can attack the ship.  
* \[M1\] Services by facility type: market, outfitter, shipyard, mission board, bar (rumors and hiring), hull repair, refuel, news and intel. Controlled ports run the customs deep scan on arrival.  
* \[M7\] Ownership change while docked: if the port changes hands to a hostile faction, the player is warned and must launch and flee. No docking services are available until they leave.

### **Launch**

* \[M1\] NPC haulers, liners and patrols land, dock and launch by the same rules and with the same animation.  
* \[M2\] Ships launch slowly from a known point, so ports can be camped. The counterweight is patrol density: heavy near lawful stations, absent in lawless space. There is no invulnerability window.

## **Ships**

How hulls are made and what sets them apart. Every hull is generated; none is drawn by hand.

* \[M0\] Generation: faction style \+ line \+ size class \+ seed → a part list → a baked sprite and its distance field (used for hits, shields and the landing sheath). The same inputs give the same hull, so hulls are cached, not stored.  
* \[M1\] Faction style: what every hull of a faction shares, whatever its line: the part grammar, materials, weathering, plume and shield look, following the faction's design language (see the appendix). A style's rules hold across all its lines: the miners' hulls are always rusted and welded.  
* \[M1\] Lines: each faction builds its hulls in lines. A faction with civilians has at least one civilian line beside its military line. A line overrides what differs from the style: palette, material, part mix, loadout, flight stats and hold.  
* \[M1\] Size classes: five, by length, shared by every line, so a civilian hull is about the size of the military hull in its class. Classes are neutral; each line names its own (a navy's class III is its destroyer, the miners' class III a hauler). Class V hulls are capital ships, whatever their line.

| Class | Length |
| :---- | :---- |
| I | 18 m |
| II | 34 m |
| III | 60 m |
| IV | 100 m |
| V | 160 m |

* \[M1\] Line stats: a size class sets base acceleration, turn, top speed, hull, shields and hold; a line multiplies them. Civilian lines carry cargo and passengers: large holds, light or no armament, weaker shields, slower handling. Military lines carry little cargo.  
* \[M1\] Shared hulls: a line may build on another line's hulls, so the same seed gives the same vessel outfitted differently. The miners' war line is their cargo and ore haulers with weapons and armor welded on. Lines that do not share hulls share only the faction style (the AI corpo's black warships and white liners).  
* \[M2\] Mounts by line: the line's loadout decides what goes on a hull's mount points: cargo pods, ore hoppers, tow gear and passenger modules on a civilian hull; turrets, gun ports and armor on a military one. So the same hull has different outfit space and mounts in each line (see Outfitting).  
* \[M3\] Specialist hulls: the heavies (bulk freighter, agri ship, mining tug, colony ship, fleet carrier, survey vessel) belong to a faction's line and are built in its style.  
* \[M3\] Factions without lines of their own: pirates fly captured and kitbashed hulls, run dark; rebels fly other factions' civilian hulls, converted. Exterminators build only for war. See the appendix.  
* \[M6\] Profile: identification shows a hull's faction and line, which feed scanning and insurance (see Law, notoriety and scanning; Death, saving and insurance).

## **Outfitting**

* \[M2\] Hull capacities: outfit space, weapon space, engine space, gun ports and turret mounts. Counts and mount positions come from the generated hull's parts.  
* \[M2\] Mass: outfits add mass, which lowers acceleration and turn rate.  
* \[M2\] Energy and heat: generators, batteries and coolers, on Endless Sky's model (see Energy and heat). Most build tradeoffs live here.  
* \[M2\] Ammunition: multicannon rounds and torpedoes are consumed and bought as the munitions commodity, so a starved forge leaves fleets in that sector short.  
* \[M2\] Damage channels: shield, hull, heat, ion (drains shields and energy), arc, and disable (leaves the ship boardable).  
* \[M3\] Compatibility: outfits from another faction's tech fit at an extra cost in space or energy.

## **Energy and heat**

Endless Sky's model: every outfit is a set of per-tick energy and heat terms, and the ship's budget is their sum.

### **Energy**

* \[M2\] Generation: reactors and solar panels produce energy every tick.  
* \[M2\] Storage: batteries and capacitors set the energy pool; capacitors also feed burst weapons such as railguns.  
* \[M2\] Consumption: each weapon shot has a firing energy; thrusters, steering and the burner draw energy while active; shield regen, field repair, active pings and drag-field projectors draw it continuously.  
* \[M2\] Shortfall: if the pool cannot cover an action, the action does not happen. A weapon does not fire, a thruster does not push, shields stop regenerating. Building enough generation is part of every fit.  
* \[M2\] Ion damage drains the energy pool directly, which is why it stalls weapons and regen.

### **Heat**

* \[M2\] Sources: reactors run hot; each shot adds firing heat; thrusters and the burner add heat while active; radiation adds heat to unshielded hulls.  
* \[M2\] Dissipation: each tick the ship sheds a fraction of its heat, set by hull and cooling outfits. Coolers shed more at a cost in energy. Gas raises dissipation several times (see Flight, sensors and environment).  
* \[M2\] Capacity: maximum heat scales with ship mass, so big hulls soak more.  
* \[M2\] Overheat: above maximum heat the ship cannot fire or use the burner until it cools; far above it the hull takes damage.  
* \[M2\] Signature: heat adds to signature, so a hot ship is a loud ship.

### **What it gives the design**

* \[M2\] Every fit is a budget: generation against draw, dissipation against heat. Beam boats need big reactors and coolers; multicannon and torpedo boats need ammunition instead of energy; railgun boats need capacitors.  
* \[M2\] Fights have a tempo: burst until the pool or the heat runs out, then back off and recover.  
* \[M2\] Numbers follow Endless Sky's conventions as the starting point and are tuned in the balance pass.

## **Weapons**

* \[M2\] Multicannons: rapid kinetic turrets used for both point defense and offense, with a spread cone and engagement arcs that the ship's own hull can block. Modes per turret group: defense (missiles, then fighters, then ships), offense, and hold fire. Aim leads the target; the spread keeps hits statistical.  
* \[M2\] Torpedoes and missiles: slow, guided and heavy-hitting, with their own hit points so multicannons can shoot them down. Decoys and jammers shift the odds. Expensive and limited. The core tactical loop is saturating enemy point-defense coverage versus out-defending their salvos.  
* \[M2\] Railguns: near-hitscan slug, one shot every 1–2 seconds after a visible charge. Heavy hull damage; the slug penetrates fighters and missiles in its path. Recoil is applied as an impulse to the firing ship. Spinal mounts fire forward only; turreted rails appear on class III hulls and up. Capacitor-fed, with a high energy and heat cost.  
* \[M2\] Beams: continuous ray dealing damage per second; needs dwell time. Strong against shields, weak against hull. Heat-limited, with an overheat lockout.  
* \[M2\] Ion cannon: slow bolt that drains shields and the target's energy, which can stall its weapons and regen. Almost no hull damage.  
* \[M2\] Arc projector: short-range lightning that chains to nearby ships, fighters and missiles. Spikes shield damage and briefly stops regen. Strong against formations and fighter screens; weak against single targets at range and unshielded hulls.  
* \[M2\] All hits resolve against the hull's actual silhouette.

Damage against defenses:

| Weapon | Shields | Hull | Notes |
| :---- | :---- | :---- | :---- |
| Multicannon | Low | Medium | Volume fire; ammo-limited |
| Railgun | Medium | Very high | Penetrates; recoil; slow cadence |
| Beam | Very high | Low | Energy- and heat-limited |
| Ion cannon | High, plus energy drain | Very low | Stalls regen and weapons |
| Arc projector | High, chains | Low | Short range; punishes formations |
| Torpedo | High | High | Can be intercepted |

## **Shields**

* \[M2\] Capacity and regen: a pool and a regen rate. Regen pauses briefly after each hit, so sustained fire beats burst.  
* \[M2\] Hardness: hits below a per-shield threshold are mostly ignored, so multicannons don't strip capital shields.  
* \[M2\] Bleed-through: a fraction of kinetic damage reaches the hull while shields hold; railguns bleed through the most.  
* \[M2\] Resistances: each shield type has a multiplier per damage channel.  
* \[M2\] Collapse: at zero the shield drops and needs a longer cold restart.  
* \[M2\] Readable state: shield color and pattern degrade with health, so state is visible without a HUD.  
* \[M2\] Outfits: generators, capacitors and regen boosters are separate. Scanners reveal a target's shield type and resistances.

Shield profiles by faction role:

| Role | Shield | Mechanical character |
| :---- | :---- | :---- |
| Navy | Balanced | No weak channel, no standout |
| AI corpo | High capacity, fast regen | Vulnerable to ion |
| Miners | Low capacity | High bleed-through; rely on armor |
| Pirates | Salvaged | Random mix per ship; scanning pays off |
| Rebels | Thin, quick-cycling | Short regen delay |
| Hive | Organic membrane | Regenerates under fire; weak to arc |
| AI zone | Adaptive | Resistance shifts toward whatever hit it most recently |
| Exterminators | None | Heavy armor and numbers; shield strippers are useless |

## **Damage and repair**

Three layers, each restored differently:

| Layer | What it does | How it recovers |
| :---- | :---- | :---- |
| Shields | Absorb damage first | Regenerate on their own, at a rate set by the generator, capacitor and booster outfits and the shield type |
| Hull | Structural integrity; at zero the ship is destroyed | Only when landed, at a station or shipyard, for credits and materials |
| Systems | Drive, thrusters and weapons, each with a condition from 0 to 1 | Field repair, slowly, while underway |

* \[M2\] System damage: hits that get past shields damage the hull and can damage a system. Drive damage lowers top speed, thruster damage lowers turn rate and lateral thrust, and weapon damage lowers firing rate.  
* \[M2\] Field repair: systems recover gradually in flight, at a rate set by repair outfits and crew. Hull does not.  
* \[M2\] Repair and jumping: the jump threshold is the hull's rated top speed, so a damaged drive cannot jump until field repair brings it back. The burner's ×1.3 cap can bridge a small shortfall at a cost in fuel and heat. A crippled ship limps somewhere quiet, repairs, then runs.  
* \[M2\] Disable: below a hull threshold every system goes offline and the ship can be boarded.  
* \[M2\] Field repair is free: it costs only time, never spare parts. Materials are spent only on landed repair (see below).  
* \[M5\] Station repair costs credits and draws alloys and components from the local market, so repair prices follow the economy and a blockaded port charges more.

## **Boarding and capture**

What happens after a ship is disabled.

### **Boarding**

* \[M3\] Disable first: the target's hull is below the disable threshold, so every system is offline.  
* \[M3\] Dock with it: match its velocity and hold within docking range, as with a station. The hold lasts a few seconds per size class.  
* \[M3\] Exposed while boarding: the boarding ship is stationary and loud, and any hit breaks the hold.

### **Options once aboard**

* \[M3\] Plunder: take cargo, fuel and ammunition, up to free hold space.  
* \[M3\] Strip outfits: remove installed outfits; slow, and they come out damaged.  
* \[M3\] Capture: a crew contest, the boarder's crew and marines against the defenders, modified by hull size and faction. A win adds the ship to the player's fleet as an escort or sells it at a shipyard; a loss costs crew.  
* \[M3\] Rescue: take survivors aboard, for missions and reputation.

### **Consequences**

* \[M3\] A captured ship keeps its system damage and limps home on field repair; its hull needs a shipyard.  
* \[M3\] Capitals cannot be captured until their systems are knocked out, and they field large defending crews.  
* \[M3\] NPCs board by the same rules: pirates disable and plunder haulers, and the navy captures smugglers.  
* \[M6\] Boarding is a crime under the owner's law and raises notoriety with that faction.

## **Fleets and doctrine**

* \[M3\] Size-class roles, for military lines: class I (fixed guns, a pair of missiles); class II (1–2 multicannons, a small rail); class III (turreted multicannons, torpedo rack, turret rails); class IV (multicannon grid, beam batteries, torpedo salvos); class V, capital (spinal rail, dense multicannon grid, launch bays). Large ships are dangerous through coverage, not just hit points.  
* \[M3\] Doctrine sets each faction's loadout mix, used for NPC fits and encounter generation: navy (multicannons, rails, torpedoes); AI corpo (beams, ion, strong shields); miners and pirates (mining lasers, mass drivers, salvaged multicannons); rebels (missile swarms to saturate defenses); hive and AI zone (to be designed).  
* \[M6\] Escorts and wingmen follow fleet orders as in Endless Sky. Hired escorts cost upkeep.  
* \[M9\] Refit pressure: exterminator waves push players and NPC fleets toward rails, torpedoes and multicannons, which raises regional munitions demand.

## **Law, notoriety and scanning**

Law belongs to the system owner, scans are a sensor action, and notoriety is each faction's memory of what the player has done in its space.

### **Jurisdiction**

* \[M6\] Owner's law: each faction has a legality table (which commodities and outfits are contraband, which acts are crimes). It applies in systems that faction owns, so law changes when ownership does.  
* \[M6\] Lawless systems have no law and no scans; pirate havens buy anything.  
* \[M6\] Restricted zones (military bases, capital approaches) make simple presence a crime without clearance.

### **Scanning**

* \[M6\] Patrols scan identified contacts they pass, with a chance per pass of security level × profile multiplier × notoriety factor.  
* \[M6\] A scan takes time in range (a few seconds within about 2 km). Leaving range breaks it, but evading or refusing a scan is itself a crime.  
* \[M6\] Scans reveal cargo manifest, contraband, illegal outfits and outstanding bounties.  
* \[M6\] Customs at controlled stations run deep scans on landing, with a better chance of finding hidden cargo.  
* \[M6\] **Transponder:** on by default. With it on, an identified contact shows name, owner and allegiance. With it off, others see only the hull type (class and size) until they hold a close-range scan long enough. What is expected depends on whose space you are in: inner-ring and corporate space want it on (the first time you get a warning; ignoring it is a misdemeanor that draws scans first); miner space does not care; in pirate space a live transponder marks you as a target and gets you attacked.

### **Profile**

* \[M6\] Some hulls invite scans: miner-built hulls of either line are scanned roughly twice as often in navy space, given the miners' ties to pirates. Corporate hulls are scanned less in the inner ring.  
* \[M6\] Standing: good reputation with the system owner lowers scan odds; notoriety raises them.

### **Clandestine hold**

* \[M6\] An outfit that holds a limited tonnage of cargo hidden from scans. It costs mass and outfit space, so a smuggler gives up speed and capacity.  
* \[M6\] Detection: each scan finds hidden cargo with a small chance set by scanner grade against hold grade; customs deep scans raise it.  
* \[M6\] Contraband sells at a premium where it is illegal, which funds the trade and creates smuggling missions.

### **Notoriety**

Notoriety is tracked per faction and rises with crimes in its jurisdiction:

| Notoriety | Effect |
| :---- | :---- |
| Low | Scanned more often |
| Medium | Fines enforced; patrols intercept and order a stop |
| High | Hostile on sight in that faction's space; bounty posted on its mission boards and its allies' |
| Severe | Named bounty hunters spawn and follow the player across lanes |

* \[M6\] **Crimes:** contraband found, evading or refusing a scan, transponder off after a warning (where the law requires it), trespass, attacking or robbing that faction's ships, killing.  
* \[M6\] Outcomes when caught: fine and confiscation at low notoriety; at higher notoriety patrols open fire.  
* \[M6\] Decay and clearing: notoriety decays over days on the strategic clock. Paying fines at that faction's stations clears it; bribes work in corrupt or outer-ring systems; reputation missions can wipe a bounty.  
* \[M6\] The player as enforcer: the player can scan NPCs too. A scan reveals wanted status and cargo, which drives bounty hunting and piracy decisions.

## **Mining**

Blast rocks with dedicated equipment, pull the pieces in, and they go into the cargo hold.

### **Rocks**

* \[M3\] Composition: each asteroid type has a yield profile (carbonaceous, metallic, ice, ore-veined, crystal), matching the asteroid generator's types.  
* \[M3\] Prospecting: a prospector scan shows a rock's composition and yield before committing to it.  
* \[M5\] Belts have a richness that depletes as they are mined and recovers slowly; rich-discovery events raise it, and mining hotspots are rich pockets.

### **Breaking**

* \[M3\] Mining lasers: beam weapons tuned for rock; high damage to asteroids, little to ships.  
* \[M3\] Blast charges: ammunition for large rocks and cores; cracking a core releases the rare yields.  
* \[M3\] A broken rock fractures into smaller rocks and ore fragments that drift away on their own momentum and expire after a while.

### **Collection**

* \[M3\] Tractor beam: an outfit that pulls fragments in from short range while it draws energy.  
* \[M3\] Collector limpets: launched drones that fetch fragments autonomously at longer range. They are consumed or recovered, and they can be shot down.  
* \[M3\] Collected fragments enter the hold as raw commodities (ore, ice, crystal) by tonnage and sell into the local market like any cargo.

### **Risk**

* \[M3\] Mining is slow, hot and loud: lasers and charges raise signature, so miners are prey for pirates.  
* \[M3\] Rocks hit hard: collisions deal damage that scales with relative speed. Belt dust also cuts sensor range.  
* \[M5\] NPC miners follow the same rules, and their deliveries feed the refineries' recipes.

Mining outfits:

| Outfit | Slot | Role |
| :---- | :---- | :---- |
| Mining laser | Weapon | Breaks rock |
| Blast charges | Weapon (ammunition) | Breaks large rocks and cracks cores |
| Tractor beam | Outfit (energy draw) | Pulls fragments at short range |
| Limpet controller and limpets | Outfit plus consumables | Fetches fragments at range |
| Prospector scanner | Outfit | Reveals composition and yield |

* \[M3\] Onboard refinery: an outfit that turns ore in the hold into metals at about 70% yield, roughly halving cargo mass; it costs outfit space, energy and heat. Station refineries yield more, so it pays mostly on long trips and in the Drift.

## **Exploration and the Drift**

Beyond the outer ring, systems are generated on first arrival and seeded from their neighbors so regions stay coherent. Survivability falls with depth, measured in jumps from charted space, out to about 8\.

### **Depth**

How the Drift changes with depth:

| Depth | Character | Where to land | What is there |
| :---- | :---- | :---- | :---- |
| 1–2 | Fringe | Barely surviving settlements; derelict outposts | Few patrols, easy fuel scooping, pricier insurance |
| 3–4 | Wild | Derelict outposts and stations, rare and partial | Rising hazards, pirate holdouts; insurance ends |
| 5–6 | Deep | Almost nothing; derelict stations at best | Very unstable lanes, alien presences, rich anomalies |
| 7–8 | The black | Nothing | Exterminator scouts, extreme hazards, the most valuable charts and science |

* \[M8\] Beyond about 8 jumps the lanes are too unstable to hold; the far edge is always moving.

### **Lanes**

* \[M8\] Drift lanes shift: each has a stability value and re-routes every few weeks of strategic time, so charts expire.  
* \[M8\] Uncharted lanes appear as unnamed jump zones. A blind jump costs extra fuel, scatters the arrival and gives no intel; the first arrival generates the system.  
* \[M8\] Hidden lanes come from anomalies: shortcuts, and some of the only ways around blockades.

### **Surviving out there**

* \[M4\] Fuel: scoop hydrogen and skim gas giants; the map shows a fuel range ring.  
* \[M8\] Hull: repaired only when landed. Landing spots thin out with depth: barely surviving settlements, derelict outposts and derelict stations, each a partial repair at best and often a specialist mission to reach or restore.  
* \[M8\] Tenders: docking inside a tender's bay counts as landed, so a tender heals its fleet's hulls. A tender needs a small assembled fleet: the tender itself, a transport carrying fuel, parts and ammunition, and escorts.  
* \[M8\] Ammunition runs out where there are no forges. Energy weapons need no resupply, so deep fleets fit beams and ion.  
* \[M8\] The way home: survey beacons hold a lane steady for a while and mark the trail. Lose them and the route back may have moved.  
* \[M8\] Insurance: premiums rise with depth and coverage ends past depth 4\. Past that, lost escorts, tenders and cargo are gone for good.  
* \[M8\] The right fleet lasts: with a tender to heal, a transport to resupply and energy weapons, an expedition can stay in the black for a long time. A lone ship cannot.

### **Charting**

* \[M8\] Surveys: hold survey scans near the star, planets, belts, jump zones and anomalies; each adds to the system's chart completeness.  
* \[M8\] Charts are data cargo, sold at relays and cartographers, valued by completeness, freshness and novelty.  
* \[M8\] Naming rights: the first full survey names the system and earns a royalty whenever its chart trades. Charts expire as lanes drift, so re-surveys pay again.

### **Anomalies**

Outcomes are rules; the LLM writes the text and lore:

| Type | How it is resolved | What it yields |
| :---- | :---- | :---- |
| Derelicts | Board or salvage | Cargo, logs, survivors |
| Signals | Triangulate with scans from several positions | Thread missions, hidden caches |
| Spatial (rifts, lenses) | Send a probe into the hazard | Hidden lanes, science data |
| Alien sites | Scan, at risk | Lore, rare science, faction attention |

* \[M8\] Science data sells to research labs and drives tech unlocks.

### **Frontier stages**

Every Drift system moves through stages:

| Stage | Reached by |
| :---- | :---- |
| Unknown | — |
| Discovered | First arrival |
| Charted | Survey completeness above a threshold |
| Anchored | An outpost or beacon network stabilizes its lanes |
| Settled | A colony is founded (resettlement loop) |
| Claimed | A faction takes ownership |
| Contested | Rival claims meet |

### **How factions expand**

* \[M8\] Gate: factions can only target systems that are charted and anchored. The player opens doors; factions walk through them. NPC survey and outpost ships push the frontier slowly without the player.  
* \[M8\] Appetite: set by doctrine and needs (miners want ore, the AI corpo artifacts and science, rebels land away from the navy, the hive living space; the navy follows to protect and tax). Each strategic tick a faction scores frontier candidates by value minus risk, within its supply reach.  
* \[M8\] Every step is a mission: survey contracts, outpost-kit delivery, colony-ship escort, supply runs (community goals), threat clearance, colony defense.  
* \[M8\] Collisions: two factions racing for the same rich system open a new conflict front.  
* \[M8\] Recession: destroyed outposts and lost beacons destabilize lanes; cut-off or sterilized colonies drift back toward unknown. The frontier needs upkeep.  
* \[M8\] Guardrails: a cap on frontier growth per period and a generation budget per region.

## **Death, saving and insurance**

### **Saving**

* \[M1\] Autosave on landing, as in EV. Tenders and derelict ports count as landings. The save holds the whole simulation, galaxy included (columnar arrays, a few MB).  
* \[M1\] Death reloads the last landing save. Everything since is lost: time, cargo, credits and mission progress.  
* \[M1\] No rerolls: the RNG is seeded, so repeating the same inputs after a reload gives the same outcome. Only different choices change results.  
* \[M9\] Ironman (optional run flag): one save that is never rolled back. Death costs the ship and the player continues from an escape pod at the last port; if broke, the lender offers a used class II hull against new debt. Shown on the player's record.

### **Insurance**

Insurance covers what is lost while the player survives: escorts, the player's freighters on assigned routes, tenders, outposts and fleet cargo.

* \[M6\] Underwriters: the corpo underwriter in inner and corporate space, a miners' mutual in the outer ring, none in pirate space.  
* \[M6\] Premium: per jump per insured asset, value × rate. The rate is about 0.2% in the core, 1% in the fringe (depth 1–2) and 3% in the wild (depth 3–4); nothing is offered past depth 4\. Surcharges for notoriety, recent claims and miner-built hulls.  
* \[M6\] Cover: hull and fitted outfits. Cargo needs a rider. Illegal cargo and clandestine holds are never covered.  
* \[M6\] Deductible: 15% of value, plus 5% per claim in the last \~50 jumps, capped at 40%.  
* \[M6\] Claim: the same hull and fit are delivered to a port in the underwriter's territory after a few days of strategic time. Captured ships cannot be insured until registered at a shipyard.  
* \[M6\] Exclusions: losses past depth 4, while fighting the underwriter's faction, or while wanted where the loss happens.  
* \[M9\] Faction policy (rank 4 and up): cheaper, and covers the faction's own war zones, which commercial underwriters surcharge or exclude.

## **Missions**

### **Layers**

* \[M1\] All four run on the same machinery.  
* \[M5\] Ambient: procedural offers spawned from sim needs.  
* \[M6\] Threads: short chains through a recurring contact.  
* \[M7\] Faction arcs: tiers 1–5.  
* \[M9\] Spine arcs: major story beats.

### **Template, bindings, narration**

* \[M1\] Template: a state machine. Objective nodes: go to, land, deliver, pick up, escort, destroy, disable, board, scan, survive, defend, wait. Triggers: entering a system, a kill, cargo loaded, a timer, a sim event. Failure conditions: deadline missed, cargo lost, target escapes, escort dies, caught by a scan. Branch points: keep the cargo, report the client, betray the escort.  
* \[M1\] Outcomes: credits, reputation deltas and sim deltas (influence, supply, unrest).  
* \[M1\] Bindings: resolved from live sim state: source and destination facilities, commodity, faction, target fleet. Deadline \= route length × slack. Pay \= base × distance × risk × urgency × faction wealth.  
* \[M4\] Narration: the LLM writes briefing, contact, dialogue and debrief from the bindings; it can pick from enumerated options (twist type, contact personality) but cannot change numbers. Cached per mission.

### **Offer generation**

* \[M1\] 3–8 offers per board; each expires.  
* \[M5\] Repeating the same template for the same faction has diminishing returns.  
* \[M6\] The board weights offers by location, reputation and rank, and the player's ship capability (cargo space, combat rating).

Sim sources and the offers they spawn:

| Sim source | Offers |
| :---- | :---- |
| Economy shortage | Haul, bulk contracts, rush delivery |
| Remote events | Relief runs, blockade running, salvage |
| Conflict fronts | Strike, convoy escort, defense, sabotage, recon, front-line contracts |
| Unrest | Rebel arms runs, navy crackdowns, evacuation |
| Pirates and lawlessness | Bounties, convoy protection, fencing |
| Exploration frontier | Survey, charting, probes, anomaly science |
| Exterminator wave | Evacuation, refit supply, holdout defense |

### **Threads**

* \[M6\] Hooks: a completed mission can leave a hook; the contact returns with a probability tied to how it was resolved.  
* \[M6\] Twists: a hidden truth (contraband cargo, defecting escort, innocent target, front company) revealed by a scan or a choice, opening a branch.  
* \[M6\] Recurring contacts: persistent NPCs with a memory summary the LLM writes from.  
* \[M6\] Graduation: a thread can turn into a faction arc.

### **Arcs**

* \[M7\] Authored skeleton: we write beats and conditions; the LLM fills people, places and dialogue to fit the current sim.  
* \[M7\] World-state beats: a beat searches for a fitting system; if none exists, it nudges the sim within guardrails.  
* \[M7\] Pinning: systems in an active arc can't change owner mid-beat; if one does anyway, the arc takes an adapt branch.  
* \[M7\] No dead ends: a failed beat routes to a recovery branch with consequences.

### **Encounters**

* \[M2\] Combat missions generate an encounter spec: a fleet built from the faction's doctrine, sized to the player's combat rating with variance, and set up as an ambush, defense, intercept or assault.  
* \[M4\] Intel quality sets how accurately the offer shows risk.

### **Rules**

* \[M1\] Deadlines are in days on the strategic clock.  
* \[M1\] Failure is soft: consequences persist, nothing hard-locks.

### **Template families**

* \[M1\] Haulage: cargo delivery to a named port (in-system in M1). Rush, fragile and contraband cargo, passengers (VIPs, refugees, colonists) and bulk contracts come later.  
* \[M2\] Combat: bounties on named targets who move between systems, convoy escort, station defense, blockade running, raids.  
* \[M2\] Assaults: targets who fight back and flee; raids on installations.  
* \[M3\] Industry: mining contracts, salvage recovery, supplying a colony over time (it grows if fed and dies if not).  
* \[M3\] Rescue: derelicts with survivors on a time limit; escape pods and black boxes.  
* \[M3\] Mining hotspots: find and crack ore-rich asteroids.  
* \[M4\] Data runs: deliver data, or steal it from station uplinks.  
* \[M4\] Taxi and tourism: passengers who want to see a hazard up close.  
* \[M5\] Source and return: find a quantity of a commodity anywhere and deliver it.  
* \[M5\] Long-range sales: rare goods worth more the farther they travel from origin.  
* \[M6\] Intrigue: smuggling past scans, courier work, investigations as clue chains.  
* \[M6\] Wing contracts: jobs that need the player's own escorts or freighters.  
* \[M7\] Community goals: system-wide efforts (build a station, break a blockade) with tiered contributions and rewards.  
* \[M7\] Conflict zones: join one side of an active battle and earn combat bonds.  
* \[M8\] Exploration: charting Drift systems, probes near hazards, anomaly data.  
* \[M8\] Survey scans: planets, anomalies and alien sites.  
* \[M9\] Incursions: periodic invasions of border systems.

## **Player systems**

* \[M0\] Flight hazards: slingshots past black holes, pulsar beams, sensor cover in nebulae.  
* \[M4\] Information as a commodity: prices, lane maps and target locations go stale; relays and bars sell fresh intel.  
* \[M5\] News feed: the LLM writes headlines from sim events, including the player's actions.  
* \[M6\] Notoriety and law: see Law, notoriety and scanning.  
* \[M6\] Insurance: see Death, saving and insurance.  
* \[M6\] Crew: hired officers give bonuses and carry personal threads.  
* \[M6\] Own logistics: player freighters run assigned routes on the NPC trade AI.  
* \[M8\] Charting and naming rights: the first to survey a Drift system names it and earns royalties when its chart data trades.  
* \[M8\] Outposts: station kits deployed in Drift systems; they need supply and defense.

## **Progression**

* \[M1\] Start: a used class II civilian hull from the owning faction's line (in M1, the miners') and a debt to a lender.  
* \[M6\] Mid game: better hulls, faction ranks, a small fleet.  
* \[M8\] Late game: deep Drift charting, outposts, faction-level influence.  
* \[M9\] Spine: light and optional: about five authored beats, gated by rank and Drift depth and built on the arc machinery above; the LLM fills everything between beats and the sandbox carries the rest.

## **Interface and art**

### **Flight view**

* \[M1\] Top-down camera centred on the ship, leading toward the direction of travel; mouse-wheel zoom.  
* \[M1\] HUD as an overlay, no side panel: day and credits top-left; radar top-right, with contacts drawn at their error radius; ship status (shields, hull, energy, heat, fuel) and assist level bottom-left; nav target bottom-right (range, relative speed, clear to land); active mission with days left; message log.  
* \[M1\] Location list on the right: the star, planets and free-orbiting stations and belts in fixed orbital order. The body whose local zone (a fixed multiple of its radius) the player is inside expands to show its moons and stations, one body at a time, with hysteresis at the edge. Each row shows icon, name, range, and landable, dockable and mission markers; a click or number key sets the nav target. Ships appear only on the radar.  
* \[M1\] System map (M): orbits, bodies, known contacts and mission destinations; click to target; a fly-to autopilot under full assist.  
* \[M1\] Controls: arrows or WASD, Shift for the burner, Tab for assist level, T to cycle targets, L to land or dock, M for the map, J to jump (from M4). Gamepad later.

### **Ports**

* \[M1\] Landed screen: a painted vista, the location's name, description and lore, and its services: trade, mission board, bar, refuel and repair, wait a day, launch. Outfitter and shipyard from M2.  
* \[M1\] Lore per location, written from sim facts: population tier, owner, economic role, two or three paragraphs of description, notable places, two to four named NPCs with portraits, and rumors. Each system also has its own history, culture and art bible.  
* \[M1\] Shell: title, new game (seed), continue from the last landing save, settings, pause. A dev panel (time scale, teleport, spawn, state inspector, save, replay and diff) is exposed on the debug control plane.

### **Art**

* \[M1\] In flight: the asset lab's procedural ships, planets, suns, stations and belts, plus starfield and nebula parallax, engine plumes and the landing plasma sheath.  
* \[M1\] Ports: futuristic painted vistas of planets and facilities, and character portraits in a painterly fantasy-realism style (the classic CRPG portrait look), both from an image model via OpenRouter.  
* \[M1\] Consistency: each system has an art bible (palette, lighting, architecture and materials, mood, and the owning faction's design language) included in every prompt, and its first approved vista is the style reference for the rest. Vista prompts are built from each body's sim parameters, so the painting matches the flight view.  
* \[M1\] Timing and fallback: vistas are generated with the system, portraits when a character first appears; all are seeded and cached. Offline, ports show a procedural backdrop.

### **The M1 system**

* \[M1\] An Ironhull-owned mid-ring industrial system with six bodies: the star, three planets, one moon and one station. Four are ports, giving 12 directed routes.  
* \[M1\] Two ways to earn: buying and selling commodities on each port's market, at fixed prices that vary with the port's role; and delivery missions from the mission board, carrying cargo to a named port in the system.  
* \[M1\] Traffic: flows between ports from a gravity model (population × population ÷ distance, weighted by how well the ports' roles complement each other), plus through traffic arriving at and leaving by placeholder jump zones (north, east, south, west) and ships loitering round their ports, spawned as described in Traffic. Who flies is a per-system mix of faction lines and size classes: mostly Ironhull, with Federation and Prism civilian visitors. M5 replaces the static flows with ones derived from the economy.

# **Part V: Building it**

## **Content pipeline**

* \[M1\] Validation: output is clamped to schema ranges and enumerations before use.  
* \[M5\] Scope: the LLM writes names, descriptions, people, events, mission text, and new brands, planets and systems, always inside schemas. The sim owns every number and outcome.  
* \[M5\] Timing: generation runs ahead of the player (adjacent systems are pre-generated), so nothing waits on a model in flight.  
* \[M5\] Determinism: results are cached and replayed from seeds.  
* \[M5\] Budget and fallback: generation is batched at each jump for the newly adjacent systems, under a cost cap per jump set in config; work over the cap queues. Offline or over budget, text comes from templates filled from the same bindings and seeds, so play never waits on a model; generated text is cached once it arrives.

## **Simulation core**

How the simulation is built, so mechanisms stay fast, testable and portable.

### **Data layout**

* \[M1\] Columns, not objects: every entity kind (ships, projectiles, particles, systems, markets) is a set of typed-array columns, and an entity is an index into them.  
* \[M1\] Handles: index plus a generation counter, so arrays can compact (swap-remove) without breaking targets, mission bindings or escort orders.  
* \[M1\] Grouped by type: entities of one type stay contiguous so each loop is homogeneous; this matches the instanced render buckets.  
* \[M1\] Masks, not branches: alive, role and mode flags are columns that kernels multiply by.

### **Tick pipeline**

A fixed 60 Hz flight tick, with an accumulator and render interpolation:

| Stage | Rate | Work |
| :---- | :---- | :---- |
| Decide | 3–5 Hz, staggered | AI writes desired velocity, facing and fire flags; the only branch-heavy stage |
| Control | Every tick | Desired velocity → thruster and turn commands (the assist controller) |
| Fields | Every tick | Gather gas density and radiation at every ship position |
| Forces | Every tick | Thrust (rotated by heading, tapered), drag, gravity (ships × bodies) |
| Integrate | Every tick | Semi-implicit Euler for position, velocity, angle and angular velocity |
| Constraints | Every tick | Dampers and clamps |
| Pairwise | Every tick; sensors at 5 Hz | Projectiles × ships via a grid broadphase, then the hull-field test; sensors ships × ships within nearby cells |
| Systems | Every tick | Shields, heat, fuel, signature |

* \[M1\] The strategic sim (economy, conflict, events) runs on the strategic clock, 1 day per landing, in proportion to lane length on jumps, and in real time in flight, over its own columns.

### **Determinism**

* \[M1\] Seeded RNG and our own sin, cos and exp, so a run replays identically on any machine.  
* \[M1\] This gives replays, regression tests for mechanisms, and server validation for a shared galaxy.

### **Rust and WASM**

* \[M1\] From day one the simulation core is Rust: one crate, compiled to WASM in the browser and native for headless tests and a future server.  
* \[M1\] Rendering, UI and LLM orchestration stay in JavaScript.  
* \[M1\] Port: M1 moves the M0 flight lab's physics, sensors and fields into the crate alongside the new sim core skeleton; later systems (economy, conflict, faction AI) are written in Rust as they arrive.  
* \[M1\] Boundary: columns live in WASM memory. JavaScript reads them through zero-copy typed-array views and calls one step per tick; the renderer uploads straight from those views. No per-entity calls cross the boundary.  
* \[M9\] Projectiles and particles move to GPU compute when multicannon volume demands it.

### **Tooling**

* \[M1\] Dev server: Node, with live reload; the Rust crate rebuilds to WASM on change.  
* \[M1\] Inference: text and image generation go through OpenRouter.  
* \[M1\] Debug control plane: the dev panel's actions (time scale, teleport, spawn, state inspector, save, replay and diff) are exposed over a local API that Claude Code can drive, in the browser or headless.

## **Build staging**

The Book is built in playable milestones. Each milestone is a complete loop someone can play, built on the final architecture (typed-array columns, seeded RNG, the strategic clock), so nothing is thrown away.

### **Rules**

* Playable at every stage: a milestone ends with a loop that is fun on its own, not a set of disconnected features.  
* Data first: every content type enters through its JSON Schema, so the LLM can author it as soon as the schema exists.  
* Simulate small, scale later: a mechanism ships at the smallest scale that exercises it, then grows with the milestones.  
* Rust/WASM from day one: the sim core is a Rust crate compiled to WASM from M1, so no milestone is built on a throwaway core; GPU projectiles follow in M9.

### **Milestones**

Each milestone adds to the one before and ends with an exit test:

| Milestone | Scope | Mechanisms | Exit test |
| :---- | :---- | :---- | :---- |
| M0 Flight lab (exists) | One sector | Flight physics and assist, nebula and radiation, sensors, NPC combat, procedural ships, stations, planets and suns | Remaining: the three-level assist and full-off rotation |
| M1 Trade and delivery | One system | Game shell (space, landing, port screens, takeoff with the plasma sheath); sim core skeleton as a Rust/WASM crate with the M0 flight physics ported in (typed-array columns, fixed-step deterministic loop, seeded RNG, save on landing); the system loaded from its schema; cargo hold, credits, the three-level assist; trading commodities on each port's market, and one mission type from the mission board (deliver cargo to a named port in the system); ambient liners and haulers | A market trade and a delivery mission both complete end to end; save, reload and replay of the same inputs give the same result, tested headless |
| M2 Combat | One system | Weapons (multicannons, beams, rails), energy and heat, shields, hull and systems damage, field and landed repair, outfitting and a shipyard, pirates, bounty and defend missions, disabling | The player outfits for a fight and wins a bounty |
| M3 Assets and set pieces | One system plus a sandbox spawner | Faction asset build-out: full hull rosters per faction (every line in every size class, and the heavies), station styles, shield colors, weapon and plume looks, the alien visual languages (hive, AI zone, exterminators). In-system mechanics with graphics: boarding and capture, mining (lasers, charges, tractor beam and limpets), capital landers, drag-field projectors, scans, derelicts and wrecks, escape pods, cargo canisters, jump-in and jump-out effects | Every faction's roster can be spawned and fought; each mechanic works in one system; all assets come through schemas |
| M4 Several systems | 5–10 systems | Jump zones, the galaxy map, fuel, days per lane, interdiction, intel snapshots, missions between systems; fixed prices | Cross-system cargo and bounty runs work, and interdictions happen at jump zones |
| M5 Economy | The same cluster | Stocks, supply and demand, lane flows, traffic from flows, trading, mining as an input; LLM-authored systems | Profitable trade routes emerge from the sim |
| M6 Law and standing | 10–20 systems with fixed owners | Law, notoriety, scans and the transponder, the clandestine hold, standing, merit and ranks 1–3 with the oath, escorts, insurance, crew, player freighters, mission threads | A smuggling run and a navy career both work, and notoriety and standing change how each faction treats the player |
| M7 Factions | 30–60 systems | Conflict and faction AI, population and colonies, ownership changes, diplomacy, missions from faction needs, faction arcs, community goals and conflict zones | Fronts visibly shift over about 30 jumps, and the player's missions move them |
| M8 The Drift | The frontier | Exploration and frontier stages, depth tiers, tenders, derelict ports, fleets and doctrine, charting, outposts | A fleet pushes to depth 6 and back, and a charted system gets settled |
| M9 Full galaxy | All rings | The hive, the AI zone and exterminator waves as actors, ranks 4–5 and player voice, named leaders, career ratings, the authored spine, ironman; GPU projectiles | A full playthrough with an oath, an endgame arc and a living map |

## **Open questions**

* Decided: balanced loop between trade and combat; death reloads the last landing save, and insurance covers escorts and holdings; single-player first, built so a shared galaxy can come later; time advances 1 day per landing, in proportion to lane length on jumps, and in real time in flight.  
* Build staging: see the Build staging chapter.  
* Decided (former opens): whole-system traffic with distance-based fidelity; field repair is free; onboard refining as a lossy outfit; a light spine of about five gated beats; NPC hails and the LLM budget and offline fallback as described in Traffic and Content pipeline.  
* Tone, names and lore (outside this book).

## **Appendix: setting facts mechanisms depend on**

* About 500 years in the future.  
* Eight factions: the Federation (navy), Prism (AI corpo), the Ironhulls (miners), the Blackhulls (pirates, aligned with the Ironhulls), Freeflag (rebels, sympathetic), the Bloom (organic alien hive), the Glass (AI zone) and the Shadow (xenophobic alien exterminators modeled on MorningLightMountain in Pandora's Star). Mechanism chapters refer to them by role.  
* Three rings: inner (prosperous), middle (industrial, hard), outer (poor and lawless).  
* Ship and port styles follow each faction's design language, and its ships come in the lines below (see Ships). Shadow, Glass and Blackhull kitbash styles are still to be designed.

Faction names:

| Role | Name | Member | Adjective | Nickname | Design language |
| :---- | :---- | :---- | :---- | :---- | :---- |
| Navy | The Federation | a fed / feds | Federal | the feds | Disciplined, symmetrical, armored; grey and white with heraldic markings; monumental architecture |
| AI corpo | Prism | Prism associates | Prism | glassfaces | Sleek and seamless; white, glass and light; clean luxury, unsettling calm |
| Miners | Ironhulls | an ironhull / ironhulls | ironhull | rusters, rockheads | Welded, modular, rusted and patched; sodium-lamp orange; hab rings bolted to rock |
| Pirates | Blackhulls | a blackhull / blackhulls | blackhull | hulls, darkrunners | Kitbashed Ironhull and captured hulls, run dark; trophies, mismatched paint |
| Rebels | Freeflag | a freeflagger / freeflaggers | Freeflag | flaggers, rags | Converted civilian craft, improvised; flags and slogans |
| Hive | The Bloom | a bloomling / bloomlings | Bloom-grown | weeds, the rot | Grown and chitinous, bioluminescent, membranes |
| AI zone | The Glass | none; converted systems are glassed | Glass | the mirror | Geometric, fractal, alien precision; no human scale |
| Exterminators | The Shadow | a shade / shades | Shadow | the dark; shadowfall (an incursion) | Massive, brutal, uniform; built only for war |

Ship lines:

| Faction | Military line | Civilian line | Notes |
| :---- | :---- | :---- | :---- |
| Federation | Grey and white, heraldic markings, symmetrical, armored | Civil-service haulers and liners: the same grey and white, plainer, unarmored | Separate hulls |
| Prism | Gloss black, seamless | White and glass, very sleek: long tapers, smooth skins, almost nothing sticking out | Separate hulls; one style |
| Ironhulls | The cargo and ore haulers refitted for war: weapons and armor welded on | Cargo and ore haulers | Shared hulls; always rusted, welded and patched, sodium-lamp orange |
| Blackhulls | None of their own | None of their own | Captured and kitbashed hulls, Ironhull first, run dark; trophies, mismatched paint |
| Freeflag | None of their own | None of their own | Other factions' civilian hulls, converted; flags and slogans |
| The Bloom | Grown warforms | A worker line (seeders, harvesters), to be designed | Grown, chitinous, bioluminescent |
| The Glass | To be designed | Probably none | |
| The Shadow | Built only for war | None | |

