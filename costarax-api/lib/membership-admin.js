function cloneRow(row) {
  return {
    user_id: row.user_id,
    supplier_id: row.supplier_id || null,
    business_id: row.business_id || null,
  }
}

function normalizeLinkResult(row, userId) {
  return {
    user_id: row?.user_id || userId,
    supplier_id: row?.supplier_id || null,
    displaced_user_ids: Array.isArray(row?.displaced_user_ids) ? row.displaced_user_ids.filter(Boolean) : [],
    removed_supplier_ids: Array.isArray(row?.removed_supplier_ids) ? row.removed_supplier_ids.filter(Boolean) : [],
  }
}

async function replaceSupplierLinkViaRpc(db, { userId, supplierId = null }) {
  const { data, error } = await db.rpc('admin_replace_supplier_link', {
    p_user_id: userId,
    p_supplier_id: supplierId || null,
  })

  if (error) {
    const msg = String(error.message || '')
    const code = String(error.code || '')
    const shouldFallback =
      code === '42883' ||
      code === '42702' ||
      /admin_replace_supplier_link/i.test(msg) ||
      /function .* does not exist/i.test(msg) ||
      /column reference .* is ambiguous/i.test(msg)
    if (shouldFallback) return null
    throw new Error(error.message)
  }

  const row = Array.isArray(data) ? data[0] : data
  return normalizeLinkResult(row, userId)
}

async function replaceSupplierLinkLegacy(db, { userId, supplierId = null }) {
  // App-layer fallback for environments where the SQL function has not been
  // applied yet. Keep behavior identical to the pre-RPC implementation.
  const { data: currentRows, error: currentErr } = await db
    .from('organization_members')
    .select('user_id, supplier_id, business_id')
    .or(`user_id.eq.${userId}${supplierId ? `,supplier_id.eq.${supplierId}` : ''}`)

  if (currentErr) throw new Error(currentErr.message)

  const previousUserSupplierRows = (currentRows || [])
    .filter(row => row.user_id === userId && row.supplier_id)
    .map(cloneRow)
  const previousSupplierRows = supplierId
    ? (currentRows || [])
        .filter(row => row.supplier_id === supplierId && row.user_id !== userId)
        .map(cloneRow)
    : []

  const restore = async () => {
    const restoreRows = [...previousUserSupplierRows, ...previousSupplierRows]
    if (restoreRows.length === 0) return
    await db.from('organization_members').insert(restoreRows)
  }

  const { error: unlinkErr } = await db
    .from('organization_members')
    .delete()
    .eq('user_id', userId)
    .not('supplier_id', 'is', null)
  if (unlinkErr) throw new Error(unlinkErr.message)

  if (supplierId) {
    const { error: detachErr } = await db
      .from('organization_members')
      .delete()
      .eq('supplier_id', supplierId)
      .neq('user_id', userId)
    if (detachErr) {
      await restore()
      throw new Error(detachErr.message)
    }

    const { error: insertErr } = await db
      .from('organization_members')
      .insert({ user_id: userId, supplier_id: supplierId })
    if (insertErr) {
      await restore()
      throw new Error(insertErr.message)
    }
  }

  const { data: finalRows, error: finalErr } = await db
    .from('organization_members')
    .select('user_id, supplier_id')
    .eq('user_id', userId)
    .not('supplier_id', 'is', null)
  if (finalErr) throw new Error(finalErr.message)

  const linkedSupplierId = finalRows?.[0]?.supplier_id || null
  if ((supplierId || null) !== linkedSupplierId) {
    await restore()
    throw new Error('Supplier link verification failed')
  }

  return normalizeLinkResult({
    user_id: userId,
    supplier_id: linkedSupplierId,
    displaced_user_ids: previousSupplierRows.map(row => row.user_id),
    removed_supplier_ids: previousUserSupplierRows.map(row => row.supplier_id).filter(Boolean),
  }, userId)
}

async function replaceSupplierLink(db, { userId, supplierId = null }) {
  const rpcResult = await replaceSupplierLinkViaRpc(db, { userId, supplierId })
  if (rpcResult) return rpcResult
  return replaceSupplierLinkLegacy(db, { userId, supplierId })
}

module.exports = {
  normalizeLinkResult,
  replaceSupplierLink,
  replaceSupplierLinkLegacy,
  replaceSupplierLinkViaRpc,
}
