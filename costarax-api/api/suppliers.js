const { supabaseAdmin, verifyToken } = require('../lib/supabase-admin')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

module.exports = async (req, res) => {
  try {
    Object.entries(CORS_H).forEach(([k, v]) => res.setHeader(k, v))
    if (req.method === 'OPTIONS') return res.status(200).end()
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    const token = req.headers.authorization?.replace('Bearer ', '')
    const user = await verifyToken(token)
    if (!user) return res.status(401).json({ error: 'Unauthorized' })

    // ── 1) Suppliers (active + approved) ─────────────────────────────────
    const { data: suppliers, error } = await supabaseAdmin
      .from('suppliers')
      .select('id,name,category,tagline,city,region,minimum_order_php,rating,review_count,verified,plan,active,vat_registered,cold_chain,years_in_business,logo_url')
      .eq('active', true)
      .eq('status', 'approved')

    if (error) {
      // Fall back to a leaner select if logo_url column doesn't exist yet
      if (/column .*logo_url.* does not exist|Could not find/i.test(error.message || '')) {
        const r = await supabaseAdmin.from('suppliers')
          .select('id,name,category,tagline,city,region,minimum_order_php,rating,review_count,verified,plan,active,vat_registered,cold_chain,years_in_business')
          .eq('active', true).eq('status', 'approved')
        if (r.error) return res.status(500).json({ error: r.error.message })
        return respond(res, r.data || [])
      }
      return res.status(500).json({ error: error.message })
    }

    return respond(res, suppliers || [])
  } catch (fatalErr) {
    console.error('[suppliers] Unhandled error:', fatalErr.message)
    return res.status(500).json({ error: 'Internal server error', detail: fatalErr.message })
  }
}

async function respond(res, suppliers) {
  if (suppliers.length === 0) {
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120')
    return res.status(200).json([])
  }
  const ids = suppliers.map(s => s.id)

  // ── 2) Aggregations in parallel ────────────────────────────────────────
  const [reviewsRes, quotesRes, pricesRes] = await Promise.all([
    supabaseAdmin.from('reviews')
      .select('supplier_id, rating, order_rating, delivery_rating')
      .in('supplier_id', ids),
    supabaseAdmin.from('quote_requests')
      .select('supplier_id, status, created_at, replied_at')
      .in('supplier_id', ids),
    supabaseAdmin.from('supplier_prices')
      .select('supplier_id,product_id,price_php,products(id,canonical_name,default_unit,category_id)')
      .in('supplier_id', ids).eq('active', true)
  ])

  // ── 3) Per-supplier stats ────────────────────────────────────────────
  const stats = {}
  ids.forEach(id => {
    stats[id] = {
      reviewCount: 0, ratingSum: 0,
      totalQuotes: 0, sent: 0, replied: 0, confirmed: 0, fulfilled: 0, cancelled: 0,
      replyTimesMs: []
    }
  })
  ;(reviewsRes.data || []).forEach(r => {
    const st = stats[r.supplier_id]; if (!st) return
    st.reviewCount++
    const avg = r.rating != null ? Number(r.rating)
      : ((Number(r.order_rating || 0) + Number(r.delivery_rating || 0)) / 2)
    st.ratingSum += avg
  })
  ;(quotesRes.data || []).forEach(q => {
    const st = stats[q.supplier_id]; if (!st) return
    st.totalQuotes++
    if (q.status === 'sent')      st.sent++
    if (['replied','confirmed','fulfilled'].includes(q.status)) st.replied++
    if (q.status === 'confirmed' || q.status === 'fulfilled')    st.confirmed++
    if (q.status === 'fulfilled') st.fulfilled++
    if (q.status === 'cancelled') st.cancelled++
    if (q.replied_at && q.created_at) {
      const ms = new Date(q.replied_at).getTime() - new Date(q.created_at).getTime()
      if (ms > 0 && ms < 30 * 24 * 60 * 60 * 1000) st.replyTimesMs.push(ms)
    }
  })

  const priceMap = {}
  ;(pricesRes.data || []).forEach(p => {
    if (!priceMap[p.supplier_id]) priceMap[p.supplier_id] = []
    priceMap[p.supplier_id].push({
      product_id: p.product_id,
      product_name: p.products?.canonical_name,
      product_unit: p.products?.default_unit,
      product_category: p.products?.category_id,
      price_php: p.price_php
    })
  })

  // ── 4) Composite score per supplier (0-100) ──────────────────────────
  const result = suppliers.map(s => {
    const st = stats[s.id] || {}
    const reviewCount = st.reviewCount || 0
    const avgRating = reviewCount > 0 ? st.ratingSum / reviewCount : Number(s.rating) || 0
    const total = st.totalQuotes || 0
    const replyRate    = total > 0 ? st.replied / total : null
    const fulfillRate  = (st.confirmed + st.fulfilled) > 0 ? st.fulfilled / (st.confirmed + st.fulfilled) : null
    const cancelRate   = total > 0 ? st.cancelled / total : null
    const avgReplyHours = st.replyTimesMs.length
      ? (st.replyTimesMs.reduce((a, b) => a + b, 0) / st.replyTimesMs.length) / 3.6e6
      : null

    // Score components — see scoreBreakdown in the response
    const components = {}
    const confidence = Math.min(1, reviewCount / 20)
    components.rating       = Math.round((avgRating / 5) * 35 * (0.4 + 0.6 * confidence) * 10) / 10
    components.replyRate    = (replyRate != null && total >= 3) ? Math.round(replyRate * 15 * 10) / 10 : 0
    components.fulfillRate  = (fulfillRate != null && (st.confirmed + st.fulfilled) >= 1) ? Math.round(fulfillRate * 15 * 10) / 10 : 0
    components.cancelPenalty = cancelRate != null ? Math.round(Math.max(0, 10 - cancelRate * 30) * 10) / 10 : 0
    if (avgReplyHours != null) {
      components.replySpeed = avgReplyHours < 4 ? 5 : avgReplyHours < 12 ? 3 : avgReplyHours < 24 ? 1 : 0
    } else {
      components.replySpeed = 0
    }
    components.trust =
      (s.verified ? 4 : 0) +
      (s.cold_chain ? 3 : 0) +
      (s.vat_registered ? 2 : 0) +
      ((Number(s.years_in_business) || 0) >= 3 ? 1 : 0)
    components.activity = Math.round(Math.min(1, total / 50) * 5 * 10) / 10
    components.reviewVolume = Math.min(5, reviewCount * 0.5)

    const score = Math.round(Math.max(0, Math.min(100,
      components.rating + components.replyRate + components.fulfillRate +
      components.cancelPenalty + components.replySpeed + components.trust +
      components.activity + components.reviewVolume
    )))

    let grade
    if (score >= 85)      grade = 'A'
    else if (score >= 70) grade = 'B'
    else if (score >= 55) grade = 'C'
    else if (score >= 40) grade = 'D'
    else                  grade = 'E'

    return {
      ...s,
      location: [s.city, s.region].filter(Boolean).join(', '),
      prices: priceMap[s.id] || [],
      metrics: {
        score, grade,
        reviewCount,
        avgRating: Number(avgRating.toFixed(2)),
        totalQuotes: total,
        replyRate:        replyRate        != null ? Number(replyRate.toFixed(3))        : null,
        fulfillRate:      fulfillRate      != null ? Number(fulfillRate.toFixed(3))      : null,
        cancellationRate: cancelRate       != null ? Number(cancelRate.toFixed(3))       : null,
        avgReplyHours:    avgReplyHours    != null ? Number(avgReplyHours.toFixed(1))    : null,
        fulfilledOrders:  st.fulfilled,
        confirmedOrders:  st.confirmed,
        breakdown: components
      }
    }
  })

  // Sort: highest score first, then by avg rating
  result.sort((a, b) => (b.metrics.score - a.metrics.score) || (b.metrics.avgRating - a.metrics.avgRating))

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120')
  return res.status(200).json(result)
}
