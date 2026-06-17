// Admin: build cross-supplier comparison groups.
// Maps each product to a normalized comparison_key (via Claude) so the SAME item
// sold by different suppliers under different names/brands shares one key.
// Processes a bounded batch per request (to stay under the serverless timeout);
// the admin UI calls it in a loop until { done: true }.
const { supabaseAdmin, requireAdmin } = require('../../supabase-admin')
const { looseComparisonKey } = require('../../comparison-key')
const Anthropic = require('@anthropic-ai/sdk')

const PER_REQUEST = 40   // small enough that one request finishes well under the
                         // serverless timeout (incl. Vercel Hobby's 10s); the
                         // admin UI loops with progress until done.
const NOISE = new Set(['dop', 'docg', 'doc', 'igp', 'pdo', 'pgi', 'd', 'o', 'p', 'cheese', 'the', 'of', 'and', 'with'])
function normKey(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter(t => t && !NOISE.has(t)).sort().join(' ')
}
const SYSTEM = `You normalize foodservice products into a "comparable product key" so the SAME item sold by different suppliers under different brands/names maps to the SAME key.
Rules:
- IGNORE brand/producer, exact pack size/weight, country, marketing words, aging months.
- KEEP the core product identity, its FORM/cut, and major grade if it changes the item (wheel vs sliced vs grated; ribeye vs tenderloin; whole vs fillet skin-on; raw vs cooked).
- Group AGGRESSIVELY by core product: a plain product from different brands is ONE key. Ignore brand-line/marketing names (Gran Rosa, Ovalina, Bologna-style, Traditional, Continental, Siciliana) and the meat type when it is implied by the product (mortadella is always pork).
- Only split when a real ingredient/preparation changes the item (truffle, pistachio, olives, smoked).
- Output a SHORT generic lowercase phrase (2-5 words).
Examples:
"Real Formaggi Parmesan Grana Padano DOP (4-5 KG)" -> "grana padano wheel"
"Alfra / Soresina Grana Padano 250 g sliced" -> "grana padano sliced"
"Latteria Soresina Grana Padano D.O.P 1/8 (2.5kg, by piece)" -> "grana padano wheel"
"Superba Mortadella (Bologna Sausage) (1 kg)" -> "mortadella"
"BERETTA MORTADELLA OVALINA (500 G)" -> "mortadella"
"Levoni Mortadella Bologna W/Pistacio IGP (2.5kg)" -> "mortadella pistachio"
"Australia Casalingo Mortadella with Truffle (Vacuum pack)" -> "mortadella truffle"
"Salmon Fillet Skin-on Tasmania Sashimi" -> "salmon fillet skin on"
"Tenderloin MS6-7 Sanchoku 2-4 kg/slab" -> "beef tenderloin"
Return ONLY JSON mapping every given id to its key: {"<id>":"<key>", ...}. No prose.`

async function countProducts(filterFn) {
  let q = supabaseAdmin.from('products').select('id', { count: 'exact', head: true }).eq('active', true)
  q = filterFn(q)
  const { count } = await q
  return count || 0
}

module.exports = async (req, res) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on the server' })

  const body = typeof req.body === 'string' ? (JSON.parse(req.body || '{}')) : (req.body || {})

  // Optional reset to re-group the whole catalog from scratch.
  if (body.reset) {
    await supabaseAdmin.from('products').update({ comparison_key: null }).not('comparison_key', 'is', null)
  }

  const total = await countProducts(q => q)

  const { data: pending, error: pErr } = await supabaseAdmin
    .from('products').select('id, canonical_name, category_id, brand, producer, origin_series, pack_weight, cut_type')
    .eq('active', true).is('comparison_key', null).limit(PER_REQUEST)
  if (pErr) return res.status(500).json({ error: pErr.message })

  if (!pending || !pending.length) {
    const grouped = await countProducts(q => q.not('comparison_key', 'is', null))
    return res.status(200).json({ done: true, processed: 0, remaining: 0, total, grouped })
  }

  const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const byCat = {}
  for (const p of pending) (byCat[p.category_id || 'other'] ||= []).push(p)
  const keyById = {}
  // Deterministic loose key: the reliable baseline (and the only key used when
  // the AI omits a product or errors). The AI just refines on top.
  const fallback = p => looseComparisonKey(p.canonical_name, p) || normKey(p.canonical_name)
  for (const [cat, items] of Object.entries(byCat)) {
    // Smaller batches + a bigger token budget so the JSON map isn't truncated
    // (truncation silently dropped ids → every dropped item fell back to a
    // unique whole-name key → nothing grouped, e.g. mortadella).
    for (let i = 0; i < items.length; i += 30) {
      const batch = items.slice(i, i + 30)
      const list = batch.map(p => `${p.id}|${p.canonical_name}`).join('\n')
      try {
        const msg = await ai.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 3500, system: SYSTEM,
          messages: [{ role: 'user', content: `Category: ${cat}\nProducts (id|name):\n${list}\n\nReturn the JSON map.` }]
        })
        const txt = msg.content[0]?.text || ''
        const json = txt.match(/\{[\s\S]*\}/)?.[0]
        const map = json ? JSON.parse(json) : {}
        // AI key when present; otherwise the deterministic loose key (NOT the
        // whole normalized name, which never groups).
        for (const p of batch) keyById[p.id] = (map[p.id] && normKey(map[p.id])) || fallback(p)
      } catch (_) {
        for (const p of batch) keyById[p.id] = fallback(p)
      }
    }
  }

  // Write (parallel in small chunks to stay fast).
  for (let i = 0; i < pending.length; i += 40) {
    await Promise.all(pending.slice(i, i + 40).map(p =>
      supabaseAdmin.from('products').update({ comparison_key: keyById[p.id] }).eq('id', p.id)))
  }

  const remaining = await countProducts(q => q.is('comparison_key', null))
  return res.status(200).json({ done: remaining === 0, processed: pending.length, remaining, total })
}
