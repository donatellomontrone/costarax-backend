const { supabaseAdmin, requireAdmin } = require('../../../../lib/supabase-admin')

const CORS_H = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'}

module.exports = async (req, res) => {
  try {
    Object.entries(CORS_H).forEach(([k,v]) => res.setHeader(k,v))
    if (req.method === 'OPTIONS') return res.status(200).end()

    const auth = await requireAdmin(req, res)
    if (!auth) return

    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'Missing supplier id' })

    // PATCH — update supplier fields
    if (req.method === 'PATCH') {
      const body = req.body || {}
      const allowed = ['name', 'category', 'categories', 'tagline', 'description', 'city', 'region',
                       'minimum_order_php', 'tin', 'delivery_coverage', 'delivery_areas', 'verified',
                       'active', 'status', 'plan', 'vat_registered', 'payment_terms', 'credit_terms',
                       'contact_name', 'contact_phone', 'contact_email', 'delivery_days', 'lead_time_days',
                       'cold_chain', 'years_in_business', 'price_validity_days', 'sample_available',
                       'certifications', 'bir_registration', 'trial_ends_at']
      const updates = {}
      for (const key of allowed) {
        if (body[key] !== undefined) updates[key] = body[key]
      }
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' })

      // Helper: run update, return { error } from Supabase
      const runUpdate = (payload) => supabaseAdmin.from('suppliers').update(payload).eq('id', id)

      // Strip fields whose column doesn't exist yet (so the update doesn't 500).
      // We retry until either the update succeeds or there are no fields left.
      const optionalCols = ['trial_ends_at', 'logo_url']
      const missingCols = []
      let payload = { ...updates }
      // Best-effort: include updated_at; if it doesn't exist we'll strip and retry.
      payload.updated_at = new Date().toISOString()

      let lastError = null
      for (let attempt = 0; attempt < 5; attempt++) {
        const { error } = await runUpdate(payload)
        if (!error) { lastError = null; break }
        lastError = error
        const msg = error.message || ''
        // Identify a missing column from the Postgres error and strip it
        const m = msg.match(/column "?([a-z_]+)"? .* does not exist/i)
        if (m && payload[m[1]] !== undefined) {
          missingCols.push(m[1])
          delete payload[m[1]]
          continue
        }
        // Some other error — bail
        break
      }

      if (lastError) {
        console.error('PATCH supplier error:', lastError.message)
        return res.status(500).json({ error: lastError.message })
      }

      // Audit log (fire-and-forget)
      await supabaseAdmin.from('admin_actions').insert({
        admin_id: auth.user.id,
        action_type: 'edit_supplier',
        target_id: id,
        notes: `Updated: ${Object.keys(payload).filter(k => k !== 'updated_at').join(', ')}`
      }).catch(() => {})

      if (missingCols.length > 0) {
        return res.status(200).json({
          message: `Supplier updated. ${missingCols.length} field${missingCols.length !== 1 ? 's' : ''} NOT saved (${missingCols.join(', ')}) — run the missing SQL migrations to enable them.`,
          warning: `Missing columns: ${missingCols.join(', ')}. Run migrations/trial_ends_at.sql and/or migrations/photos.sql in Supabase.`,
          missingColumns: missingCols
        })
      }
      return res.status(200).json({ message: 'Supplier updated' })
    }

    // DELETE — remove supplier (soft delete)
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

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (fatalErr) {
    console.error('[admin/suppliers/[id]] Unhandled error:', fatalErr.message, fatalErr.stack)
    return res.status(500).json({ error: 'Internal server error', detail: fatalErr.message })
  }
}
