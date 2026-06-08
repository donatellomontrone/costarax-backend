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
function normalize(s) {
  return deburr(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Tokens that describe quantity/packaging, not product identity — dropped from
// the match key so "Bangus 1kg" and "Bangus" collapse to the same product.
const UNIT_TOKENS = new Set([
  'kg','kgs','kilo','kilos','g','gram','grams','mg','ml','l','lt','liter','liters','litre','litres',
  'pc','pcs','piece','pieces','pack','packs','pkt','pck','box','boxes','case','cases','sack','sacks',
  'tray','trays','dozen','doz','tin','tins','can','cans','bottle','bottles','jar','jars','gal','gallon',
  'bag','bags','bundle','bundles','head','heads','x',
]);

// Alias groups for PH foodservice. FIRST item = preferred canonical/base term;
// the rest map onto it. Multi-word aliases are supported. Add freely.
// TRUE synonyms only (same product, different name/language). Do NOT add cuts,
// grades, sizes or varieties here — those are distinct SKUs and must stay apart
// (e.g. pork liempo ≠ pork kasim). FIRST item = preferred base term.
const ALIAS_GROUPS = [
  ['bangus', 'milkfish'],
  ['galunggong', 'mackerel scad', 'round scad'],
  ['lapu lapu', 'grouper', 'lapulapu'],
  ['tanigue', 'spanish mackerel', 'tangigue', 'tanguigue'],
  ['tambakol', 'yellowfin tuna'],
  ['pusit', 'squid', 'calamari'],
  ['hipon', 'shrimp'],
  ['alimasag', 'blue crab'],
  ['tahong', 'mussels', 'mussel'],
  ['talaba', 'oyster', 'oysters'],
  ['pork', 'baboy'],
  ['beef', 'baka'],
  ['ribeye', 'rib eye', 'rib-eye'],
  ['chicken', 'manok'],
  ['kangkong', 'water spinach', 'swamp cabbage'],
  ['talong', 'eggplant', 'aubergine'],
  ['sitaw', 'string beans', 'yard long beans'],
  ['tomato', 'tomatoes', 'kamatis'],
  ['onion', 'onions', 'sibuyas'],
  ['garlic', 'bawang'],
  ['potato', 'potatoes', 'patatas'],
  ['cabbage', 'repolyo'],
  ['carrot', 'carrots'],
  ['rice', 'bigas'],
  ['egg', 'eggs', 'itlog'],
  ['milk', 'gatas'],
  ['cheese', 'keso'],
  ['sugar', 'asukal'],
  ['salt', 'asin'],
  ['cooking oil', 'vegetable oil', 'mantika'],
  ['flour', 'all purpose flour', 'all-purpose flour', 'harina'],
  ['soy sauce', 'toyo'],
  ['vinegar', 'suka'],
  ['fish sauce', 'patis'],
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
    if (UNIT_TOKENS.has(t)) return false;                              // bare unit token
    if (/^\d+(?:\.\d+)?$/.test(t)) return false;                       // pure number
    if (/^\d+(?:\.\d+)?(kg|kgs|g|gr|grams?|mg|ml|cl|l|lt|ltr|oz|lb|lbs|pc|pcs)$/.test(t)) return false; // glued e.g. 1kg, 500g, 12pcs
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
