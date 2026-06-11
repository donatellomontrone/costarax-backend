// product-index.js — the shared "product brain".
//
// One normalization + synonym layer used by BOTH:
//   • the upload indexer — to collapse the same real product from different
//     suppliers into ONE canonical catalog row (via match_key), and
//   • buyer search — to make it intuitive (e.g. "milkfish" finds "Bangus").
//
// Keep the alias groups growing over time; that's the whole intelligence.

// Strip accents/diacritics (deburr).
function deburr(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Lowercase, deburr, drop punctuation, collapse whitespace.
// Numeric ranges/grades are glued ("6-7" -> "6x7") BEFORE punctuation is
// stripped, so grade/marble-score ranges stay distinct in the match key:
// "Ribeye MS6-7" and "Ribeye MS6-9" must NOT collapse to the same product.
function normalize(s) {
  return deburr(s).toLowerCase()
    .replace(/(\d)\s*[-\/]\s*(\d)/g, '$1x$2')
    .replace(/[^a-z0-9\s]/g, ' ')
    // Glue a number to a following unit ("30 g" -> "30g", "500 ml" -> "500ml")
    // so spaced and glued sizes collapse to the SAME distinguishing token.
    .replace(/\b(\d+(?:\.\d+)?)\s+(kgs?|gr?|grams?|mg|ml|cl|lt?|ltr|liters?|litres?|oz|lbs?|pcs?|pieces?)\b/g, '$1$2')
    .replace(/\s+/g, ' ').trim();
}

// Tokens that describe quantity/packaging, not product identity — dropped from
// the match key so "Bangus 1kg" and "Bangus" collapse to the same product.
const UNIT_TOKENS = new Set([
  'kg','kgs','kilo','kilos','g','gram','grams','mg','ml','l','lt','liter','liters','litre','litres',
  'pc','pcs','piece','pieces','pack','packs','pkt','pck','box','boxes','case','cases','sack','sacks',
  'tray','trays','dozen','doz','tin','tins','can','cans','bottle','bottles','jar','jars','gal','gallon',
  'bag','bags','bundle','bundles','head','heads','x',
]);

// Connective particles / filler words that never carry product identity.
// Dropped from the match key so "Giniling na Baboy" collapses to "Ground Pork"
// and "Bangus sa Gata" doesn't fragment on the particle.
const STOPWORDS = new Set([
  'na','ng','ang','mga','sa','at',            // Tagalog particles
  'of','the','and','with','in','a',           // English filler
]);

// Alias groups for PH foodservice. FIRST item = preferred canonical/base term;
// every other item in the group maps onto it. Multi-word aliases are supported
// (matched longest-first, so "red snapper" resolves before bare "snapper").
//
// RULE: TRUE synonyms only — the SAME real product written differently
// (another language, a market name, a spelling variant). Language-equivalent
// names for the SAME cut are fine ("liempo" == "pork belly"). Do NOT merge
// DIFFERENT cuts / grades / sizes / varieties — those are distinct SKUs and
// must stay apart (pork liempo ≠ pork kasim, fresh ≠ frozen).
const ALIAS_GROUPS = [
  // ── Fish (same species: English / Tagalog / market name) ──
  ['bangus', 'milkfish'],
  ['galunggong', 'mackerel scad', 'round scad'],
  ['tamban', 'sardines', 'sardine'],
  ['tulingan', 'bullet tuna', 'frigate tuna'],
  ['tambakol', 'yellowfin tuna', 'bariles'],
  ['tanigue', 'spanish mackerel', 'tangigue', 'tanguigue'],
  ['lapu lapu', 'grouper', 'lapulapu'],
  ['maya maya', 'red snapper', 'snapper', 'maya-maya'],
  ['matangbaka', 'big eye scad', 'bigeye scad', 'matang baka'],
  ['dilis', 'anchovy', 'anchovies'],
  ['dalagang bukid', 'fusilier', 'yellowtail fusilier'],
  ['espada', 'beltfish', 'hairtail', 'cutlassfish'],
  ['talakitok', 'trevally', 'jack fish'],
  ['bisugo', 'threadfin bream'],
  ['hito', 'catfish'],
  ['dalag', 'mudfish', 'snakehead'],
  ['sapsap', 'ponyfish', 'slipmouth'],
  ['pampano', 'pompano'],
  // ── Shellfish / other seafood ──
  ['hipon', 'shrimp', 'prawn', 'prawns'],
  ['sugpo', 'tiger prawn', 'tiger shrimp'],
  ['pusit', 'squid', 'calamari'],
  ['pugita', 'octopus'],
  ['alimango', 'mud crab', 'mangrove crab'],
  ['alimasag', 'blue crab', 'blue swimming crab'],
  ['tahong', 'mussels', 'mussel'],
  ['talaba', 'oyster', 'oysters'],
  ['halaan', 'clam', 'clams'],
  ['banagan', 'lobster'],
  // ── Pork (whole + language-equivalent cuts; distinct cuts stay apart) ──
  ['pork', 'baboy'],
  ['pork belly', 'liempo'],
  ['pork shoulder', 'pork kasim', 'kasim'],
  ['pork hock', 'pork pata', 'pata'],
  // ── Beef ──
  ['beef', 'baka'],
  ['ribeye', 'rib eye', 'rib-eye'],
  ['beef brisket', 'punta y pecho'],
  ['beef shank', 'kenchi'],
  // ── Poultry ──
  ['chicken', 'manok'],
  ['duck', 'itik', 'pato'],
  ['goat', 'kambing', 'chevon'],
  ['turkey', 'pabo'],
  // ── "Ground / minced" adjective (true synonym across languages) ──
  ['ground', 'minced', 'giniling'],
  // ── Vegetables ──
  ['kangkong', 'water spinach', 'swamp cabbage'],
  ['talong', 'eggplant', 'aubergine'],
  ['sitaw', 'string beans', 'yardlong beans', 'yard long beans'],
  ['tomato', 'tomatoes', 'kamatis'],
  ['onion', 'onions', 'sibuyas'],
  ['spring onion', 'scallion', 'scallions', 'green onion', 'green onions', 'sibuyas na mura'],
  ['garlic', 'bawang'],
  ['ginger', 'luya'],
  ['potato', 'potatoes', 'patatas'],
  ['cabbage', 'repolyo'],
  ['pechay', 'bok choy', 'pak choi', 'petsay'],
  ['carrot', 'carrots'],
  ['ampalaya', 'bitter gourd', 'bitter melon'],
  ['upo', 'bottle gourd', 'calabash'],
  ['patola', 'sponge gourd', 'luffa', 'ridge gourd'],
  ['sayote', 'chayote'],
  ['kalabasa', 'squash', 'pumpkin'],
  ['okra', 'lady finger', 'ladies finger'],
  ['malunggay', 'moringa', 'horseradish leaves'],
  ['gabi', 'taro'],
  ['kamote', 'sweet potato', 'sweet potatoes'],
  ['kamoteng kahoy', 'cassava', 'yuca', 'yucca'],
  ['corn', 'mais', 'sweet corn'],
  ['togue', 'bean sprouts', 'mung bean sprouts'],
  ['labanos', 'radish', 'daikon', 'white radish'],
  ['singkamas', 'jicama', 'turnip'],
  ['mustasa', 'mustard greens', 'mustard leaves'],
  ['kondol', 'winter melon', 'wax gourd', 'ash gourd'],
  ['bell pepper', 'capsicum', 'sweet pepper', 'atsal'],
  ['siling haba', 'finger pepper', 'long green pepper'],
  ['siling labuyo', 'birds eye chili', 'bird eye chili'],
  ['chili', 'chilli', 'sili'],
  ['pipino', 'cucumber'],
  ['monggo', 'mung bean', 'mung beans', 'green gram'],
  ['ube', 'purple yam'],
  // ── Fruits ──
  ['banana', 'saging'],
  ['mango', 'mangga', 'mangoes'],
  ['pineapple', 'pinya'],
  ['papaya', 'papaw'],
  ['guava', 'bayabas'],
  ['coconut', 'niyog'],
  ['young coconut', 'buko'],
  ['calamansi', 'calamondin', 'kalamansi', 'philippine lime'],
  ['dalandan', 'native orange'],
  ['pomelo', 'suha', 'pummelo'],
  ['atis', 'sugar apple', 'sweetsop'],
  ['guyabano', 'soursop'],
  ['jackfruit', 'langka'],
  ['santol', 'cotton fruit'],
  ['watermelon', 'pakwan'],
  ['melon', 'cantaloupe', 'muskmelon'],
  ['grapes', 'ubas', 'grape'],
  ['apple', 'apples', 'mansanas'],
  ['pear', 'peras'],
  ['lime', 'dayap'],
  // ── Dairy / eggs / staples ──
  ['rice', 'bigas'],
  ['egg', 'eggs', 'itlog'],
  ['milk', 'gatas'],
  ['evaporated milk', 'evap milk', 'evap'],
  ['condensed milk', 'condensada'],
  ['cheese', 'keso'],
  ['butter', 'mantikilya'],
  ['sugar', 'asukal'],
  ['brown sugar', 'asukal na pula'],
  ['salt', 'asin'],
  ['cooking oil', 'vegetable oil', 'mantika'],
  ['flour', 'all purpose flour', 'all-purpose flour', 'harina'],
  ['cornstarch', 'corn starch', 'gawgaw'],
  ['bread', 'tinapay'],
  ['coffee', 'kape'],
  ['tea', 'tsaa'],
  ['ice', 'yelo'],
  // ── Condiments / seasonings / aromatics ──
  ['soy sauce', 'toyo'],
  ['vinegar', 'suka'],
  ['fish sauce', 'patis'],
  ['ketchup', 'catsup'],
  ['lemongrass', 'tanglad'],
  ['bay leaf', 'bay leaves', 'laurel'],
  ['cilantro', 'coriander', 'wansoy'],
  // ── Water ──
  ['water', 'mineral water', 'purified water', 'distilled water', 'tubig'],
];

// alias phrase -> base term
const ALIAS_TO_BASE = {};
for (const grp of ALIAS_GROUPS) {
  const base = grp[0];
  for (const a of grp) ALIAS_TO_BASE[a] = base;
}
// aliases sorted longest-first so multi-word phrases match before single words
const ALIASES_SORTED = Object.keys(ALIAS_TO_BASE).sort((a, b) => b.length - a.length);

// Replace any known alias phrase in a normalized string with its base term.
function applyAliases(norm) {
  let out = ' ' + norm + ' ';
  for (const a of ALIASES_SORTED) {
    const base = ALIAS_TO_BASE[a];
    if (a === base) continue;
    out = out.replace(new RegExp('\\s' + a.replace(/\s+/g, '\\s+') + '\\s', 'g'), ' ' + base + ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Stable identity key for a product. Same real product written differently by
// two suppliers collapses to the same key:
//   "Bangus (Milkfish) 1kg"  ->  "bangus"
//   "Milkfish - fresh"       ->  "bangus fresh"
function matchKey(name) {
  const base = applyAliases(normalize(name));
  const toks = base.split(' ').filter(t => {
    if (!t) return false;
    if (STOPWORDS.has(t)) return false;     // particle / filler
    if (UNIT_TOKENS.has(t)) return false;   // bare unit word (kg, pc, box…) with no number
    // Numbers and glued sizes/grades (30g, 50g, "size 22", "n 1", "igp 3") are
    // KEPT — they distinguish SKUs: caviar 30g ≠ 50g, oyster N.1 ≠ N.3,
    // balsamic IGP 2 ≠ IGP 4. (Dropping them used to silently merge them.)
    return true;
  });
  const uniq = [...new Set(toks)].sort();   // dedupe synonym collisions + order-insensitive
  const key = uniq.join(' ');
  return key || base || normalize(name);
}

// For search: expand a buyer query into the terms to look for, so synonyms hit.
//   "milkfish" -> ["milkfish", "bangus"]
function expandSynonyms(query) {
  const norm = normalize(query);
  const base = applyAliases(norm);
  const terms = new Set([norm, base]);
  for (const [alias, b] of Object.entries(ALIAS_TO_BASE)) {
    if (b === base || base.split(' ').includes(b)) { terms.add(alias); terms.add(b); }
  }
  return [...terms].map(t => t.trim()).filter(t => t.length >= 2);
}

module.exports = { deburr, normalize, matchKey, applyAliases, expandSynonyms, ALIAS_GROUPS };
