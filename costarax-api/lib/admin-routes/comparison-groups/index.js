// Admin: build cross-supplier comparison groups (the manual / on-demand trigger).
// The actual logic lives in lib/grouping.js so the daily cron uses the EXACT
// same code path. Processes a bounded batch per request; the admin UI loops
// until { done: true }. Pass { reset: true } to re-groom the whole catalog.
const { supabaseAdmin, requireAdmin } = require('../../supabase-admin')
const { assignComparisonKeys } = require('../../grouping')

const PER_REQUEST = 40

async function countActive(db, filterFn = q => q) {
  const { count } = await filterFn(db.from('products').select('id', { count: 'exact', head: true }).eq('active', true))
  return count || 0
}

module.exports = async (req, res) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})

  try {
    const total = await countActive(supabaseAdmin)
    const { processed, remaining } = await assignComparisonKeys(supabaseAdmin, { limit: PER_REQUEST, reset: !!body.reset })
    if (processed === 0 && remaining === 0) {
      const grouped = await countActive(supabaseAdmin, q => q.not('comparison_key', 'is', null))
      return res.status(200).json({ done: true, processed: 0, remaining: 0, total, grouped })
    }
    return res.status(200).json({ done: remaining === 0, processed, remaining, total })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
