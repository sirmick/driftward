# Driftward

An Escape Velocity-style space game for the browser, where the galaxy never runs out: ships, planets, suns and eventually factions, missions and lore are generated from structured JSON that an LLM can author.

This repository holds the asset lab and flight prototype: one self-contained WebGL2 page with no dependencies and no build step needed to run it.

## Run it

Open `index.html` in a browser with WebGL2 (any current Chrome, Firefox, Safari or Edge). That's it.

## What's in the lab

| Tab | What it does |
|---|---|
| **Yard** | 4 brands × 5 hull classes, assembled from parametric parts and baked to lit sprites. Drag to move the sun. |
| **Ship** | One ship up close: map views (albedo, normal, height, emissive, shield field), part list, catalog editor. |
| **Planets** | 12 generated systems plus a builder: 13 palettes, rings on any axis, moons on inclined orbits. |
| **Suns** | One of each class from red dwarf to quasar, with a draggable lens flare. |
| **Fly** | Inertial flight with NPC traffic, combat, shields and planets. |

Flight controls: W/↑ thrust, A/D turn, S brake (assisted) or turn retrograde (Newtonian), Shift burn, Space fire, Tab target, F flight model, wheel or +/− zoom.

## How it works

**Ships are data.** `src/catalog.json` defines size classes (length, bake resolution, flight stats) and brands. A brand is a style grammar: palette, union mode, symmetry, bevel profile, detail switches, plume and shield style, flight multipliers, a catalog of part templates with parameter ranges, and a loadout per size. Shape values are fractions of hull length; detail spacing is in meters, so a fighter and a capital ship of one brand share panel size and window pitch.

**Pipeline:** `brand + size + seed` → part list (`assemble` in `src/gen.js`) → per-texel 2D SDF evaluation into albedo, normal, height, emissive, spec and a shield distance field (`bake`, run in Web Workers) → lit in a fragment shader with self-shadowing, up to 16 point lights, plumes, shields and HDR bloom.

**Planets and suns** are drawn analytically in fragment shaders: seamless 3D noise on a rotating sphere, equatorial rings that cast and receive shadows, moons on inclined orbits, blackbody star colors, granulation and corona, pulsar beams, and a ray-marched black hole with a Doppler-beamed disk that lenses the real sky behind it.

**Flight** keeps all entity state in typed arrays (structure of arrays): ships, bolts, particles and lights. Rendering is instanced: one draw per ship type, one each for plumes, shields, bolts and particles. Hits test against the baked shield/hull field, so bolts strike the actual silhouette.

**Everything is parameterized** for LLM authoring: categorical choices are enums (brand part roles, planet palettes, ring styles, star types), everything else is a bounded number. The JSON panels in the lab show exactly what a model would emit.

## Layout

```
index.html          built, self-contained page (open this)
src/
  catalog.json      size classes and the four brand catalogs
  gen.js            ship assembly and baking (pure JS, runs in workers and Node)
  app.js            renderer, yard and ship views, UI
  fly.js            flight simulation and instanced rendering
  planets.js        planet shader and builder
  suns.js           star, pulsar and black hole shaders, lens flare, builder
  template.html     page shell and styles
tools/
  build.py          assembles src/ into index.html
  check.js          boots the page against a stub WebGL context and validates every shader
  preview.js        CPU bake of the whole catalog to a PNG grid
```

## Develop

```
npm install          # dev tools only: PNG writer and glslangValidator
npm run build        # src/ -> index.html
npm run check        # build, then validate all shaders
npm run preview      # bake every ship on the CPU -> preview.png
```

## Roadmap

- One JSON Schema for brands, planets and suns, used both as the LLM contract and as the validator that clamps its output
- Palette generator (OKLCH) so the LLM picks palette intent rather than raw hex
- Galaxy sim: systems, economy and NPC traffic driven by supply and demand
- Planet and star specs inside the flight sector
- LLM-authored brands, systems and mission arcs

## License

MIT. See [LICENSE](LICENSE).
