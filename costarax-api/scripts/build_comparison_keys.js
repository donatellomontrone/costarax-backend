#!/usr/bin/env node
/**
 * Cross-supplier comparison grouping. Uses Claude to map each product to a
 * normalized "comparable product key" (ignoring brand/producer/pack size, but
 * keeping the product's form/cut/grade), so the SAME item from different
 * suppliers — named completely differently — shares one comparison_key.
 *
 * Dry-run by default (prints the groups it WOULD create). Pass --apply to write
 * comparison_key onto products.
 *
 *   SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. ANTHROPIC_API_KEY=.. \
 *   node scripts/build_comparison_keys.js [--apply]
 */
const { createClient } = require('@supabase/supabase-js')
const Anthropic = require('@anthropic-ai/sdk')

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY, AK = process.env.ANTHROPIC_API_KEY
if (!URL || !KEY || !AK) { console.error('Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY'); process.exit(1) }
const APPLY = process.argv.includes('--apply')
const db = createClient(URL, KEY, { auth: { persistSession: false } })
const ai = new Anthropic({ apiKey: AK })

const NOISE = new Set(['dop', 'docg', 'doc', 'igp', 'pdo', 'pgi', 'd', 'o', 'p', 'cheese', 'the', 'of', 'and'])
function normKey(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter(t => t && !NOISE.has(t))
    .sort().join(' ')
}
async function fetchAll(t, s) { const r = []; let f = 0; for (;;) { const { data, error } = await db.from(t).select(s).range(f, f + 999); if (error) throw new Error(error.message); if (data && data.length) r.push(...data); if (!data || data.length < 1000) break; f += 1000 } return r }
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o }

const SYSTEM = `You normalize foodservice products into a "comparable product key" so the SAME item sold by different suppliers under different brands/names maps to the SAME key.
Rules:
- IGNORE brand/producer, exact pack size/weight, country, marketing words, aging months.
- KEEP the core product identity, its FORM/cut, and major grade if it changes the item (wheel vs sliced vs grated; ribeye vs tenderloin; whole vs fillet skin-on; raw vs cooked).
- Output a SHORT generic lowercase phrase (2-5 words).
Examples:
"Real Formaggi Parmesan Grana Padano DOP (4-5 KG)" -> "grana padano wheel"
"Alfra / Soresina Grana Padano 250 g sliced" -> "grana padano sliced"
"Latteria Soresina Grana Padano D.O.P 1/8 (2.5kg, by piece)" -> "grana padano wheel"
"Salmon Fillet Skin-on Tasmania Sashimi" -> "salmon fillet skin on"
"Tenderloin MS6-7 Sanchoku 2-4 kg/slab" -> "beef tenderloin"
Return ONLY JSON mapping every given id to its key: {"<id>":"<key>", ...}. No prose.`

;(async () => {
  console.log(APPLY ? '== APPLY (writing comparison_key) ==' : '== DRY RUN (no writes — pass --apply) ==')
  const prods = await fetchAll('products', 'id, canonical_name, category_id, default_unit')
  console.log(`Loaded ${prods.length} products.`)
  const byCat = {}
  for (const p of prods) (byCat[p.category_id || 'other'] ||= []).push(p)

  const keyById = {}
  for (const [cat, items] of Object.entries(byCat)) {
    for (const batch of chunk(items, 45)) {
      const list = batch.map(p => `${p.id}|${p.canonical_name}`).join('\n')
      try {
        const msg = await ai.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 2000, system: SYSTEM,
          messages: [{ role: 'user', content: `Category: ${cat}\nProducts (id|name):\n${list}\n\nReturn the JSON map.` }]
        })
        const txt = msg.content[0]?.text || ''
        const json = txt.match(/\{[\s\S]*\}/)?.[0]
        const map = json ? JSON.parse(json) : {}
        for (const p of batch) keyById[p.id] = normKey(map[p.id] || p.canonical_name) || normKey(p.canonical_name)
        process.stdout.write('.')
      } catch (e) {
        console.warn(`\n  batch failed (${cat}): ${e.message} — falling back to literal`)
        for (const p of batch) keyById[p.id] = normKey(p.canonical_name)
      }
    }
  }
  console.log('')

  // Report groups (a real comparison group has the same key on >1 product)
  const groups = {}
  for (const p of prods) { const k = keyById[p.id]; (groups[k] ||= []).push(p) }
  const multi = Object.entries(groups).filter(([, ps]) => ps.length > 1).sort((a, b) => b[1].length - a[1].length)
  console.log(`\nDistinct comparison keys: ${Object.keys(groups).length}`)
  console.log(`Groups with 2+ SKUs (comparable): ${multi.length}`)
  console.log('\nTop groups:')
  multi.slice(0, 20).forEach(([k, ps]) => {
    console.log(`  [${k}] ×${ps.length}`)
    ps.slice(0, 4).forEach(p => console.log(`      - ${p.canonical_name.slice(0, 60)}`))
  })

  if (!APPLY) { console.log('\nDry run only — re-run with --apply to write comparison_key.'); return }
  let wrote = 0
  for (const c of chunk(prods, 200)) {
    await Promise.all(c.map(p => db.from('products').update({ comparison_key: keyById[p.id] }).eq('id', p.id)))
    wrote += c.length
  }
  console.log(`\n✓ Wrote comparison_key on ${wrote} products.`)
})().catch(e => { console.error(e); process.exit(1) })
