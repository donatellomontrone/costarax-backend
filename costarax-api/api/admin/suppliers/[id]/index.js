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
                     'certifications', 'bir_registration']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' })
    updates.updated_at = new Date().toISOString()

    const { error } = await supabaseAdmin.from('suppliers').update(updates).eq('id', id)
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
