const { supabaseAdmin, requireAdmin } = require('../../supabase-admin')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

module.exports = async (req, res) => {
  try {
    Object.entries(CORS_H).forEach(([k,v]) => res.setHeader(k,v))
    if (req.method === 'OPTIONS') return res.status(200).end()

    const auth = await requireAdmin(req, res)
    if (!auth) return

    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    // Last 500 payment events, newest first
    const { data: events, error } = await supabaseAdmin
      .from('payment_events')
      .select('id, provider, provider_event_id, event_type, livemode, payload, processed_at, created_at')
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) return res.status(500).json({ error: error.message })

    // Lookup all subscriptions so we can map a payment event back to its supplier
    const { data: subs } = await supabaseAdmin
      .from('subscriptions')
      .select('id, supplier_id, provider_checkout_session_id, provider_subscription_id, status, current_period_end, last_payment_at, last_payment_status, plan')
    const subList = subs || []

    // Resolve supplier names for the suppliers in subscriptions
    const supplierIds = [...new Set(subList.map(s => s.supplier_id).filter(Boolean))]
    let supplierMap = {}
    if (supplierIds.length > 0) {
      const { data: supRows } = await supabaseAdmin
        .from('suppliers').select('id, name').in('id', supplierIds)
      ;(supRows || []).forEach(s => { supplierMap[s.id] = s.name })
    }

    const subByCheckout = {}, subBySubId = {}
    subList.forEach(s => {
      if (s.provider_checkout_session_id) subByCheckout[s.provider_checkout_session_id] = s
      if (s.provider_subscription_id)     subBySubId[s.provider_subscription_id]     = s
    })

    // Enrich each event with supplier + extracted amount/currency/method
    const enriched = (events || []).map(e => {
      const payload   = e.payload || {}
      const outerData = payload.data?.attributes?.data || {}
      const innerAttrs= outerData.attributes || {}
      const checkoutSessionId = outerData.id || null         // for checkout_session.* events
      const subscriptionId    = innerAttrs.id || null        // for subscription.* events
      // PayMongo amounts are in centavos
      const rawAmount = innerAttrs.amount || innerAttrs.amount_paid || innerAttrs.total_amount || null
      const amount_php = rawAmount ? Math.round(rawAmount) / 100 : null
      const currency = innerAttrs.currency || 'PHP'
      const paymentMethod =
        innerAttrs.payment_method_used ||
        innerAttrs.payment_method?.type ||
        innerAttrs.source?.type ||
        null
      const sub = subByCheckout[checkoutSessionId] || subBySubId[subscriptionId] || null
      return {
        id: e.id,
        provider: e.provider,
        provider_event_id: e.provider_event_id,
        event_type: e.event_type,
        livemode: !!e.livemode,
        created_at: e.created_at,
        processed_at: e.processed_at,
        amount_php,
        currency,
        payment_method: paymentMethod,
        supplier_id: sub?.supplier_id || null,
        supplier_name: sub ? (supplierMap[sub.supplier_id] || null) : null,
        plan: sub?.plan || null
      }
    })

    // Aggregate
    const succeeded = enriched.filter(e => e.event_type === 'checkout_session.payment.paid')
    const failed    = enriched.filter(e => /payment\.failed/.test(e.event_type || ''))
    const totalRevenue = succeeded.reduce((sum, e) => sum + (e.amount_php || 0), 0)
    const thisMonth = new Date()
    thisMonth.setDate(1); thisMonth.setHours(0,0,0,0)
    const mtdRevenue = succeeded
      .filter(e => new Date(e.created_at) >= thisMonth)
      .reduce((sum, e) => sum + (e.amount_php || 0), 0)
    const activeSubs = subList.filter(s => s.status === 'active').length
    const pastDueSubs = subList.filter(s => s.status === 'past_due').length

    return res.status(200).json({
      events: enriched,
      stats: {
        total_events: enriched.length,
        succeeded: succeeded.length,
        failed: failed.length,
        total_revenue_php: totalRevenue,
        mtd_revenue_php: mtdRevenue,
        active_subscriptions: activeSubs,
        past_due_subscriptions: pastDueSubs
      }
    })
  } catch (fatalErr) {
    console.error('[admin/payments] Unhandled error:', fatalErr.message)
    return res.status(500).json({ error: 'Internal server error', detail: fatalErr.message })
  }
}
