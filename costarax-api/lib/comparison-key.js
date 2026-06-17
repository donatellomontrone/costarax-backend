// Deterministic "loose" comparison key.
//
// Groups the SAME core product across suppliers by stripping everything that
// only describes a particular SKU — brand/producer, origin, pack size/weight,
// units, packaging form, grade/certification and generic marketing words —
// and keeping the product noun plus the qualifiers that actually change what
// the item IS (truffle vs plain, pistachio, olives, smoked, buffalo…).
//
// Used two ways so cross-supplier comparison never silently breaks again:
//   1. assigned at UPLOAD time to every new product (immediate grouping, no
//      manual step, no AI dependency), and
//   2. as the FALLBACK inside the AI grouping job when the model omits a
//      product (previously it fell back to the full normalized name → a unique
//      key per SKU → nothing grouped).
// The AI pass still refines the hard/semantic cases on top of this.

// Sizes / weights / volumes / counts attached to a unit word, e.g. "1 kg",
// "(180 g)", "2.5kg", "12 pcs", "500ml" — all dropped.
const SIZE_RE = /\b\d+(?:[.,]\d+)?\s*(?:-\s*\d+(?:[.,]\d+)?)?\s*(?:kgs?|kilos?|kilograms?|grams?|gr?s?|mg|ml|cl|lt?|ltr|liters?|litres?|oz|lbs?|pcs?|pieces?|packs?|cases?|boxes?|box|tins?|jars?|cans?|bottles?|sachets?|tubs?|units?|x)\b/gi

// Aging windows ("6months", "12-14 months", "24 mos", "18M", "2 years") —
// never part of the product identity for comparison.
const AGING_RE = /\b\d+(?:\s*-\s*\d+)?\s*(?:months?|mos|mo|m|yrs?|years?|y)\b/gi

// Tokens that never define the product's identity for comparison purposes.
const NOISE = new Set([
  // units / counts
  'kg','kgs','kilo','kilos','g','gr','grs','gram','grams','mg','ml','cl','l','lt','ltr','liter','litre','liters','litres','oz','lb','lbs','pc','pcs','piece','pieces','x',
  // packaging / form / presentation
  'pack','packs','packed','case','cases','box','boxes','tin','tins','jar','jars','can','cans','bottle','bottles','sachet','sachets','tub','tubs','unit','units','vacuum','vac','whole','portion','portions','by','loaf','wheel','wedge','half','bulk','retail','tray','carton','bag','bags','sack','sacks','sac','pouch','pouches','knife',
  // grade / certification
  'dop','docg','doc','igp','pdo','pgi','pdo.','d','o','p',
  // origins (also stripped from the brand/origin columns, this catches inline)
  'italy','italia','italian','spain','spanish','espana','france','french','francia','australia','australian','germany','german','deutschland','holland','dutch','usa','uk','swiss','switzerland','imported','import','domestic',
  // generic marketing / filler (EN + IT)
  'the','and','of','with','w','in','per','a','for','from','di','de','del','della','dei','al','alla','con','e','su',
  'premium','selection','quality','superior','original','classic','classico','classica','traditional','continental','deli','gourmet','fine','best','natural','naturale','fresh','long','shelf','life','brand','style','type','tipo','assorted','mixed','special','label','ideale',
  // charcuterie/deli descriptors that don't change the core product
  'sausage','bologna','salume','salumi','cold','cut','cuts','cured','aged','ham','months','month','mos',
])

// Spelling / language unifiers so variants merge instead of splitting.
const ALIAS = {
  pistacio:'pistachio', pistachios:'pistachio', pistacchio:'pistachio', pistacchi:'pistachio',
  tartufo:'truffle', tartufi:'truffle', truffles:'truffle',
  olive:'olives', oliva:'olives', olives:'olives',
  bufala:'buffalo', buffala:'buffalo', bufalo:'buffalo',
  affumicato:'smoked', affumicata:'smoked',
  prosciutti:'prosciutto', formaggio:'cheese', formaggi:'cheese',
  // bilingual / form unifiers
  farina:'flour', farine:'flour', semolina:'semola', rimacinata:'semola',
  disossato:'boneless', disossata:'boneless', debonned:'boneless', deboned:'boneless', debone:'boneless',
  stagionato:'cured', stagionata:'cured',
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

// canonicalName: the product's full name.
// meta: { brand, producer, origin, origin_series, pack_weight } — any stored
//       columns, removed verbatim first (the most reliable way to drop a brand
//       like "Beretta" or "El Pozo" that no static list would catch).
function looseComparisonKey(canonicalName, meta = {}) {
  let s = ' ' + String(canonicalName || '') + ' '
  // Remove the stored brand/origin/pack values verbatim first…
  const brandTokens = new Set()
  for (const v of [meta.brand, meta.producer, meta.origin, meta.origin_series, meta.pack_weight, meta.cut_type]) {
    const val = (v == null ? '' : String(v)).trim()
    if (val.length > 1) {
      try {
        const re = new RegExp('\\b' + escapeRe(val).replace(/\s+/g, '\\s+') + '\\b', 'ig')
        s = s.replace(re, ' ')
      } catch (_) { /* ignore bad regexes */ }
    }
    // …and collect their individual tokens, so a multi-brand name written
    // differently than the column ("Alfra / Real Formaggi / Soresina" vs brand
    // "Alfra/Real Formaggi") still gets every brand word stripped.
    for (const tok of tokenize(val)) if (tok.length > 1) brandTokens.add(tok)
  }
  s = s.replace(AGING_RE, ' ').replace(SIZE_RE, ' ')

  const out = []
  const seen = new Set()
  for (let t of tokenize(s)) {
    if (/^\d+$/.test(t)) continue            // bare numbers (leftover sizes/counts)
    if (NOISE.has(t)) continue
    if (brandTokens.has(t)) continue         // brand/producer/origin words
    t = ALIAS[t] || t
    if (t.length < 2) continue
    if (seen.has(t)) continue                // dedupe ("mortadella mortadella" → one)
    seen.add(t)
    out.push(t)
  }
  // Sort so token order in the source name never matters.
  const key = out.sort().join(' ')
  // Never return an empty key — fall back to a normalized whole-name so the
  // product still gets SOME key (worst case: groups only with its exact twins).
  return key || tokenize(canonicalName).join(' ')
}

// Fill comparison_key for any of the given products that don't have one yet.
// Runs after an upload so new products are immediately groupable across
// suppliers — WITHOUT a manual "Build comparison groups" pass. The
// `is('comparison_key', null)` guard means products already keyed (by a prior
// upload or the AI refinement pass) are left untouched, so re-uploads never
// destabilize existing groups.
async function fillMissingComparisonKeys(db, productIds) {
  const ids = [...new Set((Array.isArray(productIds) ? productIds : [productIds]).filter(Boolean))]
  if (!ids.length) return 0
  let filled = 0
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200)
    const { data, error } = await db
      .from('products')
      .select('id, canonical_name, brand, producer, origin_series, pack_weight, cut_type')
      .in('id', batch)
      .is('comparison_key', null)
    if (error || !data || !data.length) continue
    await Promise.all(data.map(p =>
      db.from('products').update({ comparison_key: looseComparisonKey(p.canonical_name, p) }).eq('id', p.id)))
    filled += data.length
  }
  return filled
}

module.exports = { looseComparisonKey, fillMissingComparisonKeys }
