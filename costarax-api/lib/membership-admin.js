function cloneRow(row) {
  return {
    user_id: row.user_id,
    supplier_id: row.supplier_id || null,
    business_id: row.business_id || null,
  }
}

async function replaceSupplierLink(db, { userId, supplierId = null }) {
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

  return {
    user_id: userId,
    supplier_id: linkedSupplierId,
    displaced_user_ids: previousSupplierRows.map(row => row.user_id),
    removed_supplier_ids: previousUserSupplierRows.map(row => row.supplier_id).filter(Boolean),
  }
}

module.exports = {
  replaceSupplierLink,
}
