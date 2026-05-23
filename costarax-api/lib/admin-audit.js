async function logAdminAction(db, payload) {
  try {
    const row = {
      admin_id: payload.admin_id,
      action_type: payload.action_type,
      target_id: payload.target_id || null,
      notes: payload.notes || null,
    }
    await db.from('admin_actions').insert(row)
  } catch (e) {
    console.warn('[admin_audit] failed:', e?.message || e)
  }
}

module.exports = { logAdminAction }
