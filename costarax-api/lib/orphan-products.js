const SUPABASE_IN_CHUNK = 200

function chunkArray(items, size = SUPABASE_IN_CHUNK) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function normalizeProductIds(input) {
  const items = Array.isArray(input) ? input : [input]
  return [...new Set(items.filter(id => typeof id === 'string' && id.trim()))]
}

function computePrunableProductIds(productIds, referencedIds) {
  const referenced = new Set(referencedIds || [])
  return normalizeProductIds(productIds).filter(id => !referenced.has(id))
}

function isSkippableReferenceQueryError(message = '') {
  const lower = String(message || '').toLowerCase()
  return lower.includes('permission denied for table') || lower.includes('relation') && lower.includes('does not exist')
}

function isProtectedDeleteError(message = '') {
  const lower = String(message || '').toLowerCase()
  return lower.includes('foreign key constraint') || lower.includes('violates foreign key')
}

async function collectReferencedProductIds(db, productIds) {
  const ids = normalizeProductIds(productIds)
  if (!ids.length) return []

  const referenced = new Set()
  const refTables = [
    { name: 'supplier_prices', required: true },
    { name: 'buyer_watchlist', required: false },
    { name: 'quote_items', required: false },
  ]

  for (const { name: table, required } of refTables) {
    for (const batch of chunkArray(ids)) {
      const { data, error } = await db
        .from(table)
        .select('product_id')
        .in('product_id', batch)
      if (error) {
        if (!required && isSkippableReferenceQueryError(error.message)) continue
        throw new Error(error.message)
      }
      ;(data || []).forEach(row => {
        if (row?.product_id) referenced.add(row.product_id)
      })
    }
  }

  return [...referenced]
}

async function pruneUnreferencedProducts(db, productIds) {
  const ids = normalizeProductIds(productIds)
  if (!ids.length) {
    return { checked: 0, deleted: 0, pruned_ids: [] }
  }

  const referencedIds = await collectReferencedProductIds(db, ids)
  const prunableIds = computePrunableProductIds(ids, referencedIds)
  const deletedIds = []

  for (const batch of chunkArray(prunableIds)) {
    const { error } = await db
      .from('products')
      .delete()
      .in('id', batch)
    if (!error) {
      deletedIds.push(...batch)
      continue
    }

    if (!isProtectedDeleteError(error.message)) {
      throw new Error(error.message)
    }

    for (const id of batch) {
      const { error: singleError } = await db
        .from('products')
        .delete()
        .eq('id', id)
      if (!singleError) {
        deletedIds.push(id)
        continue
      }
      if (isProtectedDeleteError(singleError.message)) continue
      throw new Error(singleError.message)
    }
  }

  return {
    checked: ids.length,
    deleted: deletedIds.length,
    pruned_ids: deletedIds,
  }
}

module.exports = {
  chunkArray,
  computePrunableProductIds,
  collectReferencedProductIds,
  pruneUnreferencedProducts,
}
