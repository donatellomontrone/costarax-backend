const { supabaseAdmin, requireAdmin } = require('../../../../lib/supabase-admin')

const CORS_H = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'}

module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k,v]) => res.setHeader(k,v))
  if (req.method === 'OPTIONS') return res.status(200).end()

  const auth = await requireAdmin(req, res)
  if (!auth) return

  const { id } = req.query

  // PATCH — update supplier fields
  if (req.method === 'PATCH') {
    const allowed = ['name', 'category', 'categories', 'tagline', 'description', 'city', 'region',
                     'minimum_order_php', 'tin', 'delivery_coverage', 'delivery_areas', 'verified',
                     'active', 'status', 'plan', 'vat_registered', 'payment_terms', 'credit_terms',
                     'contact_name', 'contact_phone', 'contact_email', 'delivery_days', 'lead_time_days',
                     'cold_chain', 'years_in_business', 'price_validity_days', 'sample_available',
                     'certifications', 'bir_registration', 'trial_ends_at']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' })
    updates.updated_at = new Date().toISOString()

    let { error } = await supabaseAdmin.from('suppliers').update(updates).eq('id', id)
    // Graceful fallback: if trial_ends_at column doesn't exist yet (migration
    // not applied on this database), retry the update without that field and
    // surface a clearer error so the admin knows what to do.
    if (error && /column .*trial_ends_at.* does not exist/i.test(error.message)) {
      const { trial_ends_at, ...withoutTrial } = updates
      if (Object.keys(withoutTrial).length > 1) { // > 1 because updated_at is always there
        const retry = await supabaseAdmin.from('suppliers').update(withoutTrial).eq('id', id)
        error = retry.error
      }
      if (!error) {
        return res.status(200).json({
          message: 'Supplier updated (trial date NOT saved — run migrations/trial_ends_at.sql in Supabase first)',
          warning: 'trial_ends_at column missing; other fields saved successfully'
        })
      }
    }
    // Same defensive check for logo_url (in case photos.sql hasn't been applied)
    if (error && /column .*logo_url.* does not exist/i.test(error.message)) {
      return res.status(500).json({
        error: 'Database missing logo_url column — run migrations/photos.sql in the Supabase SQL editor',
        detail: error.message
      })
    }
    if (error) return res.status(500).json({ error: error.message })

    await supabaseAdmin.from('admin_actions').insert({
      admin_id: auth.user.id,
      action_type: 'edit_supplier',
      target_id: id,
      notes: `Updated fields: ${Object.keys(updates).join(', ')}`
    }).catch(() => {})

    return res.status(200).json({ message: 'Supplier updated' })
  }

  // DELETE — remove supplier
  if (req.method === 'DELETE') {
    const { data: s } = await supabaseAdmin.from('suppliers').select('name').eq('id', id).single()
    const { error } = await supabaseAdmin.from('suppliers').update({ active: false, status: 'removed' }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    await supabaseAdmin.from('admin_actions').insert({
      admin_id: auth.user.id, action_type: 'remove_supplier', target_id: id,
      notes: `Removed supplier: ${s?.name}`
    }).catch(() => {})
    return res.status(200).json({ message: 'Supplier removed' })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
