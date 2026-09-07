import { TaxonomyKind } from './taxonomy.types';

export interface SeedTerm {
  kind: TaxonomyKind;
  key: string;
  label: string;
  meta?: Record<string, string>;
  sortOrder: number;
}

const rows = (
  kind: TaxonomyKind,
  entries: [key: string, label: string, meta?: Record<string, string>][],
): SeedTerm[] =>
  entries.map(([key, label, meta], i) => ({ kind, key, label, meta, sortOrder: i * 10 }));

/** Granular interests for one category, keys prefixed to stay globally unique. */
const interests = (
  category: string,
  prefix: string,
  entries: [key: string, label: string][],
): SeedTerm[] =>
  entries.map(([key, label], i) => ({
    kind: TaxonomyKind.INTEREST,
    key: `${prefix}_${key}`,
    label,
    meta: { category },
    sortOrder: i * 10,
  }));

/** One colour group from the onboarding colours screen (Figma `39:1061` v2). */
const colours = (
  group: string,
  groupLabel: string,
  entries: [key: string, label: string, hex: string][],
): SeedTerm[] =>
  entries.map(([key, label, hex], i) => ({
    kind: TaxonomyKind.COLOR,
    key: `${group}_${key}`,
    label,
    meta: { hex, group, groupLabel },
    sortOrder: i * 10,
  }));

/**
 * The launch taxonomy, transcribed from the Wishtick-UI-v2 designs
 * (interests `36:839` + the 12 category screens; colours `39:1061`; sizes
 * `51:42`). Labels are verbatim from the design file, including its typos
 * ("Activites", "Liesure", "Deserts") — fix them here *and* in Figma together.
 *
 * Sprint 11 gives admins CRUD over this; the seed only establishes the
 * starting set, and re-running it never clobbers admin edits (see the upsert
 * in the seed migration).
 */
/**
 * Flattens the grouped relation picker into seed rows.
 *
 * The key is prefixed by its group so labels that repeat across groups — a
 * "Cousin" under Siblings and one that may later appear elsewhere — cannot
 * collide, the same reason INTEREST keys carry their category.
 */
const relations = (groups: [group: string, groupLabel: string, members: string[]][]): SeedTerm[] =>
  groups.flatMap(([group, groupLabel, members], groupIndex) =>
    members.map((label, i) => ({
      kind: TaxonomyKind.RELATION,
      // Accents are folded before slugging, or "Fiancé" keys as `fianc_` — a
      // trailing underscore where a letter was dropped.
      key: `${group}_${label
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')}`,
      label,
      meta: { group, groupLabel },
      sortOrder: groupIndex * 100 + i * 10,
    })),
  );

export const TAXONOMY_SEED: SeedTerm[] = [
  // ── Interest categories (Figma 36:839, in display order) ──────────────────
  ...rows(TaxonomyKind.INTEREST_CATEGORY, [
    ['fashion', 'Fashion & Personal Style'],
    ['technology', 'Technology & Gadgets'],
    ['home_living', 'Home & Living'],
    ['health_fitness', 'Health & Fitness'],
    ['travel', 'Travel & Experiences'],
    ['entertainment', 'Entertainment'],
    ['hobbies', 'Hobbies & Creativity'],
    ['kids_family', 'Kids & family'],
    ['automotive', 'Automotive'],
    ['sustainable', 'Sustainable Living'],
    ['food_beverages', 'Food & Beverages'],
    ['other', 'Other'],
  ]),

  // ── Granular interests, one block per category screen ─────────────────────
  ...interests('fashion', 'fashion', [
    ['clothing', 'Clothing'],
    ['shoes', 'Shoes'],
    ['bags_wallets', 'Bags & Wallets'],
    ['watches', 'Watches'],
    ['jewellery', 'Jewellery'],
    ['accessories', 'Accessories'],
    ['eye_wear', 'Eye Wear'],
    ['fragrances', 'Fragrances'],
    ['beauty_makeup', 'Beauty & Makeup'],
    ['grooming', 'Grooming'],
    ['skincare', 'Skincare'],
  ]),
  ...interests('technology', 'tech', [
    ['smartphones', 'Smartphones'],
    ['computers', 'Computers'],
    ['laptops_tablets', 'Laptops & Tablets'],
    ['audio_devices', 'Audio devices'],
    ['gaming', 'Gaming'],
    ['smart_home', 'Smart Home'],
    ['wearables', 'Wearables'],
    ['camera_photography', 'Camera & Photography'],
    ['accessories', 'Tech Accessories'],
  ]),
  ...interests('home_living', 'home', [
    ['decor', 'Home decor'],
    ['furniture', 'Furniture'],
    ['kitchen_dining', 'Kitchen & Dining'],
    ['appliances', 'Home Appliances'],
    ['bedding_bath', 'Bedding & Bath'],
    ['lighting', 'Lighting'],
    ['gardening', 'Gardening'],
    ['improvement', 'Home Improvement'],
  ]),
  ...interests('health_fitness', 'health', [
    ['equipments', 'Equipments'],
    ['sports_gear', 'Sports Gear'],
    ['yoga_meditation', 'Yoga & Meditation'],
    ['nutrition', 'Nutrition'],
    ['outdoor_activities', 'Outdoor Activities'],
    ['cycling', 'Cycling'],
    ['running', 'Running'],
  ]),
  ...interests('travel', 'travel', [
    ['adventure_outdoor', 'Adventure & Outdoor Activites'],
    ['road_trips', 'Road Trips'],
    ['luxury_leisure', 'Luxury & Liesure Travel'],
    ['accessories', 'Travel Accessories'],
    ['spa_wellness', 'Spa & Wellness'],
    ['fine_dining', 'Fine Dining'],
    ['coffee_dates', 'Coffee dates'],
    ['concerts_live', 'Concert & Live Events'],
    ['movie_theatre', 'Movie & Theatre'],
    ['workshops_classes', 'Workshops & Classes'],
  ]),
  ...interests('entertainment', 'ent', [
    ['books', 'Books'],
    ['movies_tv_ott', 'Movies & TV & OTT'],
    ['music', 'Music'],
    ['gaming', 'Gaming'],
  ]),
  ...interests('hobbies', 'hobby', [
    ['art_craft', 'Art & Craft'],
    ['music_instruments', 'Music Instruments'],
    ['pottery', 'Pottery'],
    ['painting', 'Painting'],
  ]),
  ...interests('kids_family', 'kids', [
    ['baby_products', 'Baby Products'],
    ['toys', 'Toys'],
    ['family_activities', 'Family Activities'],
    ['pet_care', 'Pet Care'],
  ]),
  ...interests('automotive', 'auto', [
    ['cars', 'Cars'],
    ['motorcycles', 'Motorcycles'],
    ['car_accessories', 'Car Accessories'],
  ]),
  ...interests('sustainable', 'sus', [
    ['eco_friendly', 'Eco-Friendly Products'],
    ['organic_living', 'Organic Living'],
    ['reusable', 'Reusable Products'],
    ['fashion', 'Sustainable Fashion'],
  ]),
  ...interests('food_beverages', 'food', [
    ['chocolates_sweets', 'Chocolates & Sweets'],
    ['cakes_desserts', 'Cakes & Deserts'],
    ['beverages', 'Beverages'],
    ['dining_experiences', 'Dining & Restaurant Experiences'],
  ]),
  // "Other" suggestions (Figma 239:454); free-text customs are a profile
  // field, not taxonomy.
  ...interests('other', 'other', [
    ['diy_crafts', 'DIY Crafts'],
    ['baking', 'Baking'],
    ['astronomy', 'Astronomy'],
    ['poetry', 'Poetry'],
    ['anime', 'Anime'],
    ['pets', 'Pets'],
  ]),

  // ── Colours (Figma 39:1061 v2; hex sampled from the design render) ────────
  // Teal Blue and Periwinkle are grey placeholder circles in the design file —
  // the hexes here are stand-ins until the design team supplies real ones.
  ...colours('neutral', 'Neutrals & Slate', [
    ['white', 'White', '#FFFFFF'],
    ['beige', 'Beige', '#F9F0E7'],
    ['light_grey', 'Light Grey', '#DEE1E1'],
    ['slate', 'Slate', '#727C8F'],
    ['black', 'Black', '#161616'],
  ]),
  ...colours('earth', 'Earth Tones', [
    ['cocoa', 'Cocoa', '#8A492B'],
    ['terracotta', 'Terracotta', '#D86F42'],
    ['mocha', 'Mocha', '#AB907F'],
    ['sand', 'Sand', '#E8D2AE'],
    ['olive', 'Olive', '#828050'],
  ]),
  ...colours('pastel', 'Pastels', [
    ['blush', 'Blush', '#FDB8CA'],
    ['peach', 'Peach', '#FEC1A5'],
    ['lemon', 'Lemon', '#FEEC9F'],
    ['mint', 'Mint', '#ACEBD0'],
    ['lavender', 'Lavender', '#C5BCF5'],
  ]),
  ...colours('blue', 'Blues', [
    ['navy', 'Navy', '#0C327E'],
    ['royal', 'Royal Blue', '#156BF2'],
    ['sky', 'Sky Blue', '#A7DEFD'],
    ['teal', 'Teal Blue', '#367588'],
    ['periwinkle', 'Peri winkle', '#AEB6E8'],
  ]),
  ...colours('green', 'Greens', [
    ['forest', 'Forest', '#025733'],
    ['emerald', 'Emerald', '#01AE6F'],
    ['sage', 'Sage', '#A7C3AA'],
    ['mint', 'Mint', '#A9EACE'],
    ['lime', 'Lime', '#F4FF80'],
  ]),
  ...colours('red', 'Red & Pinks', [
    ['cherry', 'Cherry', '#B71B3D'],
    ['ruby', 'Ruby', '#D81F2C'],
    ['coral', 'Coral', '#FF7B5C'],
    ['rose', 'Rose', '#F4B6C2'],
    ['hot_pink', 'Hot Pink', '#E94E85'],
  ]),
  ...colours('orange', 'Oranges & Yellows', [
    ['orange', 'Orange', '#FF7300'],
    ['tangerine', 'Tangerine', '#FF8C0A'],
    ['amber', 'Amber', '#F3AB4A'],
    ['yellow', 'Yellow', '#FFD31A'],
    ['lemon', 'Lemon', '#FFE97A'],
  ]),
  ...colours('purple', 'Purple & Violet', [
    ['plum', 'Plum', '#5B1A6E'],
    ['violet', 'Violet', '#7C6BE6'],
    ['lavender', 'Lavender', '#B7ADF2'],
    ['lilac', 'Lilac', '#D8B6F2'],
    ['orchid', 'Orchid', '#DB7DD9'],
  ]),

  ...rows(TaxonomyKind.CLOTHING_SIZE, [
    ['xxs', 'XXS', { system: 'alpha' }],
    ['xs', 'XS', { system: 'alpha' }],
    ['s', 'S', { system: 'alpha' }],
    ['m', 'M', { system: 'alpha' }],
    ['l', 'L', { system: 'alpha' }],
    ['xl', 'XL', { system: 'alpha' }],
    ['xxl', 'XXL', { system: 'alpha' }],
    ['xxxl', '3XL', { system: 'alpha' }],
    ['prefer_not_to_say', 'Prefer not to say'],
  ]),

  // The size screen (51:42) offers UK / US / EU; one key per size per system.
  ...rows(TaxonomyKind.SHOE_SIZE, [
    ...([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] as const).map(
      (n) => [`uk_${n}`, `UK ${n}`, { system: 'uk' }] as [string, string, Record<string, string>],
    ),
    ...([4, 5, 6, 7, 8, 9, 10, 11, 12, 13] as const).map(
      (n) => [`us_${n}`, `US ${n}`, { system: 'us' }] as [string, string, Record<string, string>],
    ),
    ...([36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47] as const).map(
      (n) => [`eu_${n}`, `EU ${n}`, { system: 'eu' }] as [string, string, Record<string, string>],
    ),
    ['prefer_not_to_say', 'Prefer not to say'],
  ]),

  ...rows(TaxonomyKind.FIT_PREFERENCE, [
    ['slim', 'Slim'],
    ['regular', 'Regular'],
    ['relaxed', 'Relaxed'],
    ['oversized', 'Oversized'],
  ]),

  ...rows(TaxonomyKind.GIFT_CATEGORY, [
    ['books', 'Books'],
    ['electronics', 'Electronics'],
    ['fashion', 'Fashion & Accessories'],
    ['beauty', 'Beauty & Grooming'],
    ['home', 'Home & Living'],
    ['kitchen', 'Kitchen & Dining'],
    ['toys', 'Toys & Games'],
    ['sports_gear', 'Sports & Fitness'],
    ['experiences', 'Experiences'],
    ['handmade', 'Handmade & Personalised'],
    ['jewellery', 'Jewellery'],
    ['stationery', 'Stationery'],
    ['gift_cards', 'Gift Cards'],
    ['food_drink', 'Food & Drink'],
  ]),

  ...rows(TaxonomyKind.LIFESTYLE, [
    ['minimalist', 'Minimalist'],
    ['eco_conscious', 'Eco-conscious'],
    ['luxury', 'Luxury'],
    ['practical', 'Practical'],
    ['trendy', 'Trendy'],
    ['homebody', 'Homebody'],
    ['adventurer', 'Adventurer'],
    ['foodie', 'Foodie'],
    ['tech_savvy', 'Tech-savvy'],
    ['vegan', 'Vegan'],
    ['pet_parent', 'Pet parent'],
    ['new_parent', 'New parent'],
  ]),

  ...rows(TaxonomyKind.OCCASION, [
    ['birthday', 'Birthday'],
    ['anniversary', 'Anniversary'],
    ['wedding', 'Wedding'],
    ['baby_shower', 'Baby Shower'],
    ['housewarming', 'Housewarming'],
    ['graduation', 'Graduation'],
    ['festival', 'Festival'],
    ['retirement', 'Retirement'],
    ['engagement', 'Engagement'],
    ['just_because', 'Just Because'],
    // The important-dates screen's occasion carousel (Figma 199:10 / 204:371).
    ['special_moments', 'Special Moments'],
    // Appended for Home's "What are we celebrating today?" grid (Figma 51:11),
    // which shows both by name. Appended rather than slotted in beside
    // `festival` so no existing row's sortOrder shifts.
    ['rakhi', 'Rakhi'],
    ['best_wishes', 'Best Wishes'],
  ]),

  // Mirrors Event.type in Sprint 5. Kept in the taxonomy so the event-creation
  // screen is server-driven like the rest.
  ...rows(TaxonomyKind.EVENT_TYPE, [
    ['birthday', 'Birthday'],
    ['anniversary', 'Anniversary'],
    ['generic', 'Custom Event'],
    ['special', 'Special Celebration'],
  ]),

  // ── Relations (Figma `2252:423`) ──────────────────────────────────────────
  //
  // Grouped exactly as the picker draws them, with `meta.group`/`groupLabel`
  // driving the collapsible sections — the same shape COLOR already uses.
  //
  // ⚠️ Only **Partner** has designed options: `2252:485` is the one expanded
  // state exported, and the other five groups are shown collapsed in every
  // frame. Their members below are filled in, not designed. They live in the
  // taxonomy precisely so correcting them is a seed edit rather than an app
  // release — see sprints.md.
  ...relations([
    ['partner', 'Partner', ['Boyfriend', 'Girlfriend', 'Husband', 'Wife', 'Fiancé']],
    ['friends', 'Friends', ['Best friend', 'Close friend', 'Friend', 'Flatmate', 'Neighbour']],
    ['parents', 'Parents', ['Mother', 'Father', 'Step-mother', 'Step-father', 'Guardian']],
    ['siblings', 'Siblings', ['Sister', 'Brother', 'Step-sister', 'Step-brother', 'Cousin']],
    ['colleagues', 'Colleagues', ['Colleague', 'Manager', 'Team-mate', 'Client', 'Mentor']],
    ['kids', 'Kids', ['Daughter', 'Son', 'Niece', 'Nephew', 'Grandchild']],
  ]),
];

/**
 * v1 seed keys superseded by the v2 design — the flat interest list and the
 * ungrouped colours. Migration 005 deactivates them on existing databases;
 * fresh databases never create them.
 */
export const TAXONOMY_RETIRED: { kind: TaxonomyKind; keys: string[] }[] = [
  {
    kind: TaxonomyKind.INTEREST,
    keys: [
      'music',
      'travel',
      'reading',
      'gaming',
      'cooking',
      'fitness',
      'photography',
      'art',
      'technology',
      'fashion',
      'movies',
      'sports',
      'gardening',
      'pets',
      'crafts',
      'outdoors',
      'wellness',
      'collecting',
    ],
  },
  {
    kind: TaxonomyKind.COLOR,
    keys: [
      'black',
      'white',
      'red',
      'pink',
      'purple',
      'blue',
      'teal',
      'green',
      'yellow',
      'orange',
      'brown',
      'grey',
      'beige',
      'gold',
      'silver',
    ],
  },
];
