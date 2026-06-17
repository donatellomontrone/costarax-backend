// THE single cross-supplier grouping logic, used everywhere (admin button +
// daily cron). The AI is the general intelligence — it groups ANY category by
// meaning with no per-category word lists. looseComparisonKey is only the
// instant seed (at upload) and the last-resort fallback when the AI can't be
// reached for a specific product.
//
// Reliability is the whole point: the AI used to silently OMIT products from
// its JSON map, and every omitted product fell back to a per-SKU key → nothing
// grouped (mortadella/prosciutto/flour). Here we RETRY the omitted ids (and a
// wholly-failed batch) before ever falling back, so one pass groups everything.
const Anthropic = require('@anthropic-ai/sdk')
const { looseComparisonKey } = require('./comparison-key')

const NOISE = new Set(['dop', 'docg', 'doc', 'igp', 'pdo', 'pgi', 'd', 'o', 'p', 'cheese', 'the', 'of', 'and', 'with'])
function normKey(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter(t => t && !NOISE.has(t)).sort().join(' ')
}

const SYSTEM = `You normalize foodservice products into a "comparable product key" so the SAME item sold by different suppliers under different brands/names maps to the SAME key.
Rules:
- IGNORE brand/producer, exact pack size/weight, country, marketing words, aging months.
- Group AGGRESSIVELY by core product: a plain product from different brands is ONE key. Ignore brand-line/marketing/variety-name words (Gran Rosa, Ovalina, Bologna-style, Traditional, Continental, Siciliana, Gold Label) and the meat type when implied by the product (mortadella/prosciutto are pork).
- KEEP the form/cut and any real ingredient/preparation that changes the item: wheel vs sliced vs grated; ribeye vs tenderloin; whole vs fillet skin-on; raw/crudo vs cooked/cotto; truffle, pistachio, olives, smoked.
- Output a SHORT generic lowercase phrase (2-5 words).
Examples:
"Real Formaggi Parmesan Grana Padano DOP (4-5 KG)" -> "grana padano wheel"
"Alfra / Soresina Grana Padano 250 g sliced" -> "grana padano sliced"
"Superba Mortadella (Bologna Sausage) (1 kg)" -> "mortadella"
"BERETTA MORTADELLA OVALINA (500 G)" -> "mortadella"
"Australia Casalingo Mortadella with Truffle (Vacuum pack)" -> "mortadella truffle"
"Levoni Prosciutto Parma boneless DOP 18M Crudo (7-8kg)" -> "prosciutto crudo parma"
"Trinita Prosciutto Cotto (Cooked Ham) (1 kg)" -> "prosciutto cotto"
"Molino Dallagiovanna Flour Type 00 (5kg)" -> "pizza flour 00"
"Caputo Tipo 1 Farina di Grano Tenero (2.5kg)" -> "soft wheat flour"
"Salmon Fillet Skin-on Tasmania Sashimi" -> "salmon fillet skin on"
"Tenderloin MS6-7 Sanchoku 2-4 kg/slab" -> "beef tenderloin"
Return ONLY JSON mapping every given id to its key: {"<id>":"<key>", ...}. No prose.`

const MODEL = 'claude-haiku-4-5-20251001'

function parseMap(txt) {
  const json = String(txt || '').match(/\{[\s\S]*\}/)?.[0]
  if (!json) return {}
  try { return JSON.parse(json) } catch (_) { return {} }
}

// Ask the AI for keys for one batch, then RETRY whatever it omitted so a
// dropped id never silently falls back to a per-SKU key.
async function aiKeysForBatch(ai, cat, batch) {
  const call = async (items) => {
    const list = items.map(p => `${p.id}|${p.canonical_name}`).join('\n')
    const msg = await ai.messages.create({
      model: MODEL, max_tokens: 3500, system: SYSTEM,
      messages: [{ role: 'user', content: `Category: ${cat}\nProducts (id|name):\n${list}\n\nReturn the JSON map.` }],
    })
    return parseMap(msg.content[0]?.text || '')
  }
  let map = {}
  try { map = await call(batch) } catch (_) { map = {} }
  let missing = batch.filter(p => !map[p.id])
  // One retry pass for the omitted ids (or the whole batch if it all failed).
  if (missing.length) {
    try { Object.assign(map, await call(missing)) } catch (_) { /* keep what we have */ }
  }
  return map
}

// Assign comparison keys to up to `limit` products that still need AI grouping
// (comparison_key_ai_at IS NULL). `reset` re-grooms the whole catalog by
// clearing that timestamp first. Bounded so a single serverless invocation
// stays well under the timeout; callers loop until { remaining: 0 }.
async function assignComparisonKeys(db, { limit = 40, reset = false } = {}) {
  if (reset) {
    await db.from('products').update({ comparison_key_ai_at: null }).not('comparison_key_ai_at', 'is', null)
  }

  const { data: pending, error } = await db
    .from('products')
    .select('id, canonical_name, category_id, brand, producer, origin_series, pack_weight, cut_type')
    .eq('active', true).is('comparison_key_ai_at', null).limit(limit)
  if (error) throw new Error(error.message)
  if (!pending || !pending.length) return { processed: 0, remaining: 0 }

  const fallback = p => looseComparisonKey(p.canonical_name, p) || normKey(p.canonical_name)
  const keyById = {}

  if (process.env.ANTHROPIC_API_KEY) {
    const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const byCat = {}
    for (const p of pending) (byCat[p.category_id || 'other'] ||= []).push(p)
    for (const [cat, items] of Object.entries(byCat)) {
      for (let i = 0; i < items.length; i += 30) {
        const batch = items.slice(i, i + 30)
        const map = await aiKeysForBatch(ai, cat, batch)
        for (const p of batch) keyById[p.id] = (map[p.id] && normKey(map[p.id])) || fallback(p)
      }
    }
  } else {
    // No AI configured → deterministic key for everyone (still groups well).
    for (const p of pending) keyById[p.id] = fallback(p)
  }

  const stamp = new Date().toISOString()
  for (let i = 0; i < pending.length; i += 40) {
    await Promise.all(pending.slice(i, i + 40).map(p =>
      db.from('products').update({ comparison_key: keyById[p.id], comparison_key_ai_at: stamp }).eq('id', p.id)))
  }

  const { count } = await db.from('products')
    .select('id', { count: 'exact', head: true })
    .eq('active', true).is('comparison_key_ai_at', null)
  return { processed: pending.length, remaining: count || 0 }
}

module.exports = { assignComparisonKeys }
