const { supabaseAdmin, requireAdmin } = require('../../../lib/supabase-admin')

const CORS_H = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'}

module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k,v]) => res.setHeader(k,v))
  if (req.method === 'OPTIONS') return res.status(200).end()

  const auth = await requireAdmin(req, res)
  if (!auth) return

  // GET — list ALL suppliers (active + paused) with full details and subscription state.
  // Auto-pauses any supplier whose subscription's current_period_end is in the past.
  if (req.method === 'GET') {
    const { data: sups, error } = await supabaseAdmin
      .from('suppliers')
      .select('id, name, category, tagline, city, region, minimum_order_php, rating, verified, active, status, plan, created_at, trial_ends_at, logo_url')
      .order('name')
    if (error) return res.status(500).json({ error: error.message })

    const ids = (sups || []).map(s => s.id)
    let subs = []
    if (ids.length > 0) {
      const r = await supabaseAdmin
        .from('subscriptions')
        .select('supplier_id, status, current_period_end, last_payment_at, last_payment_status, cancel_at_period_end, created_at')
        .in('supplier_id', ids)
      subs = r.data || []
    }
    const subBy = {}
    subs.forEach(s => { subBy[s.supplier_id] = s })

    const now = new Date()
    const toAutoPauseSub   = []    // expired paid subscriptions
    const toAutoPauseTrial = []    // expired trials (no sub, trial_ends_at past)
    const enriched = (sups || []).map(s => {
      const sub = subBy[s.id] || null
      const periodEnd = sub?.current_period_end ? new Date(sub.current_period_end) : null
      const trialEnd  = s.trial_ends_at ? new Date(s.trial_ends_at) : null
      const subExpired   = !!(periodEnd && periodEnd < now)
      const trialExpired = !sub && !!(trialEnd && trialEnd < now)
      if (subExpired && s.active)   toAutoPauseSub.push(s.id)
      if (trialExpired && s.active) toAutoPauseTrial.push(s.id)
      return {
        ...s,
        subscription_status: sub?.status || null,
        last_payment_at: sub?.last_payment_at || null,
        last_payment_status: sub?.last_payment_status || null,
        current_period_end: sub?.current_period_end || null,
        cancel_at_period_end: sub?.cancel_at_period_end || false,
        membership_started_at: sub?.created_at || s.created_at || null,
        expired: subExpired,
        trial_expired: trialExpired
      }
    })

    // Auto-pause: paid subscriptions whose period ended
    if (toAutoPauseSub.length > 0) {
      await supabaseAdmin.from('suppliers').update({ active: false })
        .in('id', toAutoPauseSub)
      await supabaseAdmin.from('admin_actions').insert(
        toAutoPauseSub.map(id => ({
          admin_id: auth.user.id,
          action_type: 'auto_pause_expired',
          target_id: id,
          notes: 'Subscription period ended — automatic pause'
        }))
      )
      enriched.forEach(s => { if (toAutoPauseSub.includes(s.id)) s.active = false })
    }

    // Auto-pause: trials whose trial_ends_at is past
    if (toAutoPauseTrial.length > 0) {
      await supabaseAdmin.from('suppliers').update({ active: false })
        .in('id', toAutoPauseTrial)
      await supabaseAdmin.from('admin_actions').insert(
        toAutoPauseTrial.map(id => ({
          admin_id: auth.user.id,
          action_type: 'auto_pause_trial_expired',
          target_id: id,
          notes: 'Trial period ended — automatic pause'
        }))
      )
      enriched.forEach(s => { if (toAutoPauseTrial.includes(s.id)) s.active = false })
    }

    return res.status(200).json(enriched)
  }

  // POST — create new supplier
  if (req.method === 'POST') {
    const { name, category, tagline, city, region, minimum_order_php, tin, delivery_coverage } = req.body
    if (!name || !category) return res.status(400).json({ error: 'name and category are required' })

    const { data, error } = await supabaseAdmin.from('suppliers').insert({
      name: name.trim(),
      legal_name: name.trim(),
      category,
      tagline: tagline?.trim() || null,
      city: city?.trim() || null,
      region: region?.trim() || null,
      minimum_order_php: minimum_order_php || 1000,
      tin: tin?.trim() || null,
      delivery_coverage: delivery_coverage?.trim() || null,
      verified: false,
      active: false,
      status: 'pending',
      rating: 5.0,
      review_count: 0
    }).select('id, name').single()

    if (error) return res.status(500).json({ error: error.message })

    await supabaseAdmin.from('admin_actions').insert({
      admin_id: auth.user.id,
      action_type: 'create_supplier',
      target_id: data.id,
      notes: `Created supplier: ${name}`
    })

    return res.status(201).json({ id: data.id, message: `${name} created successfully` })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
