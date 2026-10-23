// ======================= DATA =======================
// Where a page's content comes from (docs/data.md): the universe index (src/galaxy/universe.json, tools/universe.py)
// at start; a system (its file, lore and art manifest) the first time it is needed; the debug extras (the real-star
// catalogue, how the content was made) when their screen opens. One async API whichever way the page was built
// (tools/build.py): self-contained, each file rides inline in its own <script type="application/json" data-file=...>,
// parsed the first time it is asked for, so the page still opens from disk; hosted (build --hosted), each is fetched
// from data/ beside the page, so only what is used is downloaded.
//   universe.json          the index: factions, regions, every system, lanes; and art.logos, each faction's logo
//                          found in art/factions/ ({ badge, flat } paths; tools/build.py adds it to the page's copy)
//   systems/<id>.json      { system: the system file, lore: src/lore/<id>.json or null, art: { vistas, portraits } }
//   logs/<id>.json         { lore, art }: how a system's content was made (the debug screen's Content tab)
//   stars.json             the real stars round Sol (tools/hyg.py), for the map
//   galaxy-log.json        { setting, stories }: the setting and how the stories were told (the Regions tab)
function makeData(base = 'data/') {
  const asked = new Map(), got = new Map();
  async function read(name) {
    const el = document.querySelector(`script[type="application/json"][data-file="${name}"]`);
    if (el) return JSON.parse(el.textContent);
    const r = await fetch(base + name);
    if (!r.ok) throw new Error(`${base}${name}: ${r.status} ${r.statusText}`);
    return r.json();
  }
  // a file's contents, read once and shared; a failed read is forgotten, so asking again tries again
  function file(name) {
    if (!asked.has(name)) asked.set(name, read(name).then(v => { got.set(name, v); return v; }, e => { asked.delete(name); throw e; }));
    return asked.get(name);
  }
  return {
    file,
    // already read: has(name), and its contents now (undefined until then), for code that can't wait a turn
    has: name => got.has(name), peek: name => got.get(name),
    universe: () => file('universe.json'), system: id => file(`systems/${id}.json`), log: id => file(`logs/${id}.json`),
    catalogue: () => file('stars.json'), galaxyLog: () => file('galaxy-log.json'),
  };
}
