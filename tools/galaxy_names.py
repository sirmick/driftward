"""Provisional names for the galaxy's systems (tools/galaxy.py), real near Sol and more and more invented farther out:
the inner ring keeps its stars' real names; out from there a settled system takes a name in its faction's style more
and more often, a dead one only now and then (a prospector's claim), and the grown Drift keeps its survey numbers
until someone charts it. Every invented name is marked provisional: the lore pass can rename it, and docs/names.md
tracks the ones that have been settled.

Each faction names the way it lives (src/lore/setting.md): the Federation after the places and ideals of the inner
ring, the Ironhulls in hard, short, workaday words (Brannock, Ostry, Cinder, Halde), Prism softly and abstractly
(Serein, Quire), Freeflag after what it is fighting for, the Blackhull havens with a gallows humour, the
Independents after whoever filed the claim; the Bloom's worlds by the names human surveyors gave them.
"""
import random

POOLS = {
    'fed': ['Concord', 'Meridian', 'New Lagos', 'Halvard', 'Port Ilyan', 'Covenant', 'Aurelia', 'Cassady', 'Tiberine',
            'New Kerala', 'Providence', 'Vesta Major', 'Solace', 'Harrowgate', 'Bellamy', 'Castellan', 'New Ankara',
            'Prospero', 'Ardmore', 'Wardenclyffe', 'Lighthouse', 'Ostend', 'Fairhaven', 'Corvina', 'Pellucid',
            'Marchmont', 'Steadfast', 'New Quito', 'Admiralty', 'Sabine', 'Hollis', 'Garrison', 'Treaty', 'Valparaiso'],
    'iron': ['Gant', 'Holt', 'Brack', 'Tarn', 'Slagend', 'Anvil', 'Coker', 'Rake', 'Grist', 'Harl', 'Stour', 'Wrack',
             'Clinker', 'Dross', 'Kell', 'Burr', 'Fettle', 'Quarle', 'Hob', 'Skerry', 'Cadge', 'Gorse', 'Mattock',
             'Rivet', 'Trammel', 'Ingot', 'Barrow', 'Scarth', 'Dunnage', 'Swarf', 'Pelt', 'Callow', 'Tholl', 'Graff'],
    'prism': ['Lucent', 'Aubade', 'Calme', 'Vesper', 'Lumen', 'Clarine', 'Ondine', 'Sereine', 'Tessel', 'Aster',
              'Liminal', 'Pavane', 'Allure', 'Candor', 'Velour', 'Etude', 'Nacre', 'Halcyon Rise', 'Cadence', 'Opaline'],
    'free': ['Tarrow', 'Unbowed', 'Last Light', 'Hope', 'Reckoning', 'Defiance', 'Openhand', 'New Tarrow', 'Bread',
             'Common', 'Standfast', 'Dawnward', 'Free Harbor', 'Remembrance', 'Kinship', 'Sufferance', 'Ember',
             'Liberty Rock', 'Shoulder', 'Mutual', 'Two Hundred', 'Vent', 'Strike', 'Loom'],
    'black': ['Gallows', 'Rook', 'Scuttle', 'Grudge', 'Bilge', 'Cutlass', 'Blind Eye', 'Wreckers', 'Barnacle', 'Low Tide'],
    'indep': ['Last Chance', 'Murphy\'s Claim', 'Okafor', 'Hendry\'s Rest', 'Juniper', 'Long Shot', 'Halfway', 'Patch',
              'Dunmore', 'Vasquez', 'Second Wind', 'Kittering', 'Dry Well', 'Nowhere Much', 'Sweetwater', 'Oduya',
              'Pell\'s Folly', 'Cobb', 'Larkin', 'Quill', 'Fennimore', 'Ramsey', 'Lindqvist', 'Bright Prospect',
              'Holloway', 'Nakamura', 'Odds On', 'Grubstake', 'Tenpenny', 'Kowalski'],
    'claim': ['Kettle', 'Scrapheap', 'Prospect', 'Tailings', 'Outcrop', 'Seam', 'Lode', 'Spoil', 'Assay', 'Vug',
              'Gangue', 'Placer', 'Drift Mouth', 'Adit', 'Winze', 'Stope', 'Collar', 'Footwall'],
    'bloom': ['Verdance', 'Mere', 'Greenwater', 'Tendril', 'Rainhold', 'Loam', 'Canopy', 'Fernlight', 'Spore',
              'Mossdeep', 'Rhizome', 'Bower', 'Thicket', 'Petal', 'Dewfall', 'Lichen', 'Sporefall', 'Root', 'Seedbed',
              'Pollen', 'Marsh', 'Frond', 'Bough', 'Burgeon', 'Quickening', 'Undergrowth', 'Tilth', 'Arbor', 'Glade', 'Fen'],
    'emptied': ['Mallory', 'Sigrun', 'Avesta', 'Penhallow'],
}
SUFFIX = ['', ' Reach', ' Deep', ' Gate', ' Landing', ' Station', ' Hold', ' Prime', ' Minor', ' Rest']


def namer(seed=2526):
    """A namer: name(pool) gives the pool's next unused name, then the pool's names with a suffix, never repeating."""
    rng, used, order = random.Random(seed), set(), {}

    def name(pool):
        if pool not in order:
            order[pool] = POOLS[pool][:]
            rng.shuffle(order[pool])
        for suffix in SUFFIX:
            for base in order[pool]:
                n = base + suffix
                if n not in used:
                    used.add(n)
                    return n
        raise ValueError(f'the {pool} names ran out')

    def reserve(n):
        used.add(n)

    return name, reserve


# how often an invented name replaces a catalogue one, by ring, for settled systems and dead ones
INVENT_SETTLED = {'inner': 0, 'middle': .7, 'outer': 1}
INVENT_DEAD = {'inner': 0, 'middle': 0, 'outer': .25}
