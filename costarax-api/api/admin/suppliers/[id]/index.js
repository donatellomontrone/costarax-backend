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

      // Defensive retry: if Postgres complains a column doesn't exist OR has
      // the wrong type for our value, strip that field and try again. Bounded
      // by 8 iterations so a permanent error can't infinite-loop.
      const missingCols = []
      const droppedCols = []
      let payload = { ...updates }
      payload.updated_at = new Date().toISOString()

      let lastError = null
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const { error } = await runUpdate(payload)
          if (!error) { lastError = null; break }
          lastError = error
          const msg = String(error.message || '')
          console.warn(`PATCH attempt ${attempt+1} error:`, msg, 'code:', error.code, 'details:', error.details, 'hint:', error.hint)

          // 1) Missing column
          let m = msg.match(/column "?([a-z_]+)"? .* does not exist/i)
          if (m && payload[m[1]] !== undefined) {
            missingCols.push(m[1]); delete payload[m[1]]; continue
          }
          // 2) Could not find column on the cache (PostgREST)
          m = msg.match(/Could not find the '([a-z_]+)' column/i) ||
              msg.match(/'([a-z_]+)' column of '[^']+' in the schema cache/i)
          if (m && payload[m[1]] !== undefined) {
            missingCols.push(m[1]); delete payload[m[1]]; continue
          }
          // 3) Invalid type / malformed array literal — strip the column
          //    (Postgres "details" usually names the offending column)
          if (error.details) {
            const dm = String(error.details).match(/column "?([a-z_]+)"?/i)
            if (dm && payload[dm[1]] !== undefined) {
              droppedCols.push(dm[1]); delete payload[dm[1]]; continue
            }
          }
          // 4) "invalid input syntax for type X" without an obvious column —
          //    try removing array-typed fields one at a time as a last resort
          if (/invalid input syntax|malformed array/i.test(msg)) {
            for (const k of ['categories', 'certifications', 'delivery_days']) {
              if (payload[k] !== undefined) { droppedCols.push(k); delete payload[k]; break }
            }
            continue
          }
          // Unknown error — bail
          break
        } catch (e) {
          lastError = { message: e.message || String(e) }
          break
        }
      }

      if (lastError) {
        console.error('PATCH supplier failed:', lastError.message, 'after attempts. Payload keys left:', Object.keys(payload))
        return res.status(500).json({
          error: lastError.message,
          detail: lastError.details || lastError.hint || null,
          missingColumns: missingCols,
          droppedColumns: droppedCols
        })
      }

      // Audit log (fire-and-forget)
      await supabaseAdmin.from('admin_actions').insert({
        admin_id: auth.user.id,
        action_type: 'edit_supplier',
        target_id: id,
        notes: `Updated: ${Object.keys(payload).filter(k => k !== 'updated_at').join(', ')}`
      }).catch(() => {})

      const allDropped = [...missingCols, ...droppedCols]
      if (allDropped.length > 0) {
        return res.status(200).json({
          message: `Supplier updated. ${allDropped.length} field${allDropped.length !== 1 ? 's' : ''} NOT saved (${allDropped.join(', ')}).`,
          warning: missingCols.length
            ? `Missing columns: ${missingCols.join(', ')}. Run migrations/trial_ends_at.sql or migrations/photos.sql in Supabase.`
            : `Dropped fields due to value/type mismatch: ${droppedCols.join(', ')}.`,
          missingColumns: missingCols,
          droppedColumns: droppedCols
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
