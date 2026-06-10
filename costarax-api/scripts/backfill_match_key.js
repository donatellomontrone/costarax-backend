#!/usr/bin/env node
/**
 * Backfill products.match_key with the canonical matchKey() brain, and resolve
 * any (match_key, default_unit) collisions so the UNIQUE index is satisfiable
 * and the upload dedup works on the EXISTING catalog (not just new uploads).
 *
 * Safe by default: prints what it WOULD do. Pass --apply to actually write.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill_match_key.js
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill_match_key.js --apply
 */
const { createClient } = require('@supabase/supabase-js')
const { matchKey } = require('../lib/product-index')

const APPLY = process.argv.includes('--apply')
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.')
  process.exit(1)
}
const db = createClient(URL, KEY, { auth: { persistSession: false } })

async function fetchAll(table, select) {
  const rows = []; let from = 0; const size = 1000
  while (true) {
    const { data, error } = await db.from(table).select(select).range(from, from + size - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    if (data && data.length) rows.push(...data)
    if (!data || data.length < size) break
    from += size
  }
  return rows
}

;(async () => {
  console.log(APPLY ? '== APPLY MODE (writing changes) ==' : '== DRY RUN (no writes — pass --apply to write) ==')
  const products = await fetchAll('products', 'id, canonical_name, default_unit, match_key, created_at')
  console.log(`Loaded ${products.length} products.`)

  const prices = await fetchAll('supplier_prices', 'id, supplier_id, product_id, unit')
  const pricesByProduct = new Map()
  for (const pr of prices) {
    if (!pricesByProduct.has(pr.product_id)) pricesByProduct.set(pr.product_id, [])
    pricesByProduct.get(pr.product_id).push(pr)
  }

  // Group products by the NEW (match_key, unit).
  const groups = new Map()
  for (const p of products) {
    const mk = matchKey(p.canonical_name || '')
    const u = String(p.default_unit || '').toLowerCase().trim()
    const k = mk + '__' + u
    if (!groups.has(k)) groups.set(k, { mk, u, items: [] })
    groups.get(k).items.push(p)
  }

  let setCount = 0, collisionGroups = 0, productsDeleted = 0, pricesRepointed = 0, pricesDropped = 0

  for (const { mk, u, items } of groups.values()) {
    if (!mk) { console.warn('  (skip) empty match_key for:', items.map(i => i.canonical_name)); continue }

    if (items.length === 1) {
      const p = items[0]
      if (p.match_key !== mk) {
        setCount++
        if (APPLY) {
          const { error } = await db.from('products').update({ match_key: mk }).eq('id', p.id)
          if (error) console.error('  set-fail', p.id, error.message)
        }
      }
      continue
    }

    // Collision: multiple existing products collapse to one match_key.
    collisionGroups++
    const ranked = [...items].sort((a, b) =>
      ((pricesByProduct.get(b.id) || []).length - (pricesByProduct.get(a.id) || []).length) ||
      String(a.created_at || '').localeCompare(String(b.created_at || '')))
    const survivor = ranked[0]
    const losers = ranked.slice(1)
    console.log(`COLLISION "${mk}" [${u}] keep #${survivor.id} "${survivor.canonical_name}" — merge: ${losers.map(l => `"${l.canonical_name}"`).join(', ')}`)

    const survSeen = new Set((pricesByProduct.get(survivor.id) || []).map(pr => pr.supplier_id + '__' + String(pr.unit || '').toLowerCase()))
    for (const loser of losers) {
      for (const pr of (pricesByProduct.get(loser.id) || [])) {
        const k = pr.supplier_id + '__' + String(pr.unit || '').toLowerCase()
        if (survSeen.has(k)) {
          pricesDropped++
          if (APPLY) await db.from('supplier_prices').delete().eq('id', pr.id)
        } else {
          survSeen.add(k); pricesRepointed++
          if (APPLY) await db.from('supplier_prices').update({ product_id: survivor.id }).eq('id', pr.id)
        }
      }
      productsDeleted++
      if (APPLY) await db.from('products').delete().eq('id', loser.id)
    }
    if (APPLY) {
      const { error } = await db.from('products').update({ match_key: mk }).eq('id', survivor.id)
      if (error) console.error('  survivor-set-fail', error.message)
    }
  }

  console.log('\n── Summary ──')
  console.log(`match_key set (singletons) : ${setCount}`)
  console.log(`collision groups           : ${collisionGroups}`)
  console.log(`products merged/deleted    : ${productsDeleted}`)
  console.log(`supplier_prices repointed  : ${pricesRepointed}`)
  console.log(`duplicate prices dropped   : ${pricesDropped}`)
  console.log(APPLY ? '\n✓ DONE (applied).' : '\nDry run only — re-run with --apply to write.')
})().catch(e => { console.error(e); process.exit(1) })
