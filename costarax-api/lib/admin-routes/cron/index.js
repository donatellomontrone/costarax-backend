// Daily cron — runs at 02:00 UTC (10:00 AM PH time)
// 1. Creates new quote requests for due recurring orders
// 2. Sends stale-quote reminders to suppliers (sent >48h, no reply)
//
// Vercel calls this with: Authorization: Bearer <CRON_SECRET>

const { supabaseAdmin } = require('../../supabase-admin')
const { sendEmail, watchlistPriceAlertEmail } = require('../../email')
const { notify } = require('../../notify')

const FREQ_DAYS = { weekly: 7, biweekly: 14, monthly: 30 }

module.exports = async (req, res) => {
  // Cron is invoked server-to-server by Vercel; no CORS needed.

  // Verify cron secret — REQUIRED. Without this, the cron endpoint is open to abuse.
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron] CRON_SECRET env var is not set — refusing to run')
    return res.status(503).json({ error: 'Cron secret not configured' })
  }
  const auth = req.headers.authorization || ''
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' })

  const results = { recurring: [], stale: [], watchlistAlerts: [], errors: [] }

  // ── 1. RECURRING ORDERS ─────────────────────────────────────────────────
  try {
    const { data: recurring } = await supabaseAdmin
      .from('quote_requests')
      .select('id,supplier_id,buyer_business_id,products_summary,message,weekly_volume,recurring_freq,created_at,businesses(name,contact_phone),suppliers(name,contact_phone)')
      .not('recurring_freq', 'is', null)
      .eq('status', 'fulfilled')
      .order('created_at', { ascending: false })

    const now = Date.now()
    const processed = new Set() // prevent double-creating for same buyer+supplier

    for (const q of (recurring || [])) {
      const days = FREQ_DAYS[q.recurring_freq]
      if (!days) continue

      const key = `${q.buyer_business_id}:${q.supplier_id}`
      if (processed.has(key)) continue

      const ageMs = now - new Date(q.created_at).getTime()
      const ageDays = ageMs / (1000 * 60 * 60 * 24)

      if (ageDays < days) continue // not due yet

      // Check no pending/active quote already exists between this pair
      const { data: existing } = await supabaseAdmin
        .from('quote_requests')
        .select('id,status')
        .eq('buyer_business_id', q.buyer_business_id)
        .eq('supplier_id', q.supplier_id)
        .in('status', ['sent', 'replied', 'confirmed'])
        .limit(1)
      if (existing?.length) { processed.add(key); continue }

      const { data: newQuote, error } = await supabaseAdmin
        .from('quote_requests')
        .insert({
          buyer_business_id: q.buyer_business_id,
          supplier_id:       q.supplier_id,
          products_summary:  q.products_summary,
          message:           `[Recurring order — ${q.recurring_freq}] ${q.message || ''}`.trim(),
          weekly_volume:     q.weekly_volume,
          recurring_freq:    q.recurring_freq,
          status:            'sent',
        })
        .select('id')
        .single()

      if (error) { results.errors.push(`recurring insert: ${error.message}`); continue }

      processed.add(key)
      results.recurring.push(newQuote.id)

      // Notify supplier
      notify({
        event: 'quote_received',
        to:    q.suppliers?.contact_phone,
        data:  { buyerName: q.businesses?.name || 'A buyer', products: q.products_summary || '' },
      })

      // Email supplier
      try {
        const { data: member } = await supabaseAdmin
          .from('organization_members').select('user_id').eq('supplier_id', q.supplier_id).single()
        if (member?.user_id) {
          const { data: profile } = await supabaseAdmin
            .from('profiles').select('email').eq('id', member.user_id).single()
          if (profile?.email) {
            await sendEmail({
              to:      profile.email,
              subject: `[Recurring] New order from ${q.businesses?.name || 'a buyer'} — Costarax`,
              html:    `<p>Hi ${q.suppliers?.name || 'there'},</p><p>A recurring order (${q.recurring_freq}) has been automatically sent from <strong>${q.businesses?.name || 'a buyer'}</strong>.</p><p>Products: ${q.products_summary || '—'}</p><p>Reply at <a href="https://costarax.com/app.html">costarax.com</a>.</p>`,
            }).catch(() => {})
          }
        }
      } catch (_) {}
    }
  } catch (e) {
    results.errors.push(`recurring block: ${e.message}`)
  }

  // ── 2. STALE QUOTE REMINDERS (sent >48h, no reply) ───────────────────────
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

    const { data: stale } = await supabaseAdmin
      .from('quote_requests')
      .select('id,supplier_id,products_summary,created_at,businesses(name),suppliers(name,contact_phone)')
      .eq('status', 'sent')
      .lt('created_at', cutoff)
      .is('replied_at', null)
      .order('created_at', { ascending: true })
      .limit(50)

    for (const q of (stale || [])) {
      results.stale.push(q.id)

      // WhatsApp/Viber/SMS via notify (quote_stale event)
      notify({
        event: 'quote_stale',
        to:    q.suppliers?.contact_phone,
        data:  { buyerName: q.businesses?.name || 'A buyer', products: q.products_summary || '' },
      })

      // Email supplier
      try {
        const { data: member } = await supabaseAdmin
          .from('organization_members').select('user_id').eq('supplier_id', q.supplier_id).single()
        if (member?.user_id) {
          const { data: profile } = await supabaseAdmin
            .from('profiles').select('email').eq('id', member.user_id).single()
          if (profile?.email) {
            await sendEmail({
              to:      profile.email,
              subject: `Reminder: ${q.businesses?.name || 'A buyer'} is waiting for your quote reply`,
              html:    `<p>Hi ${q.suppliers?.name || 'there'},</p><p><strong>${q.businesses?.name || 'A buyer'}</strong> sent you a quote request ${Math.round((Date.now() - new Date(q.created_at).getTime()) / 3600000)}h ago and is still waiting for your reply.</p><p>Products: ${q.products_summary || '—'}</p><p>Reply now at <a href="https://costarax.com/app.html">costarax.com</a> to keep your response rate high.</p>`,
            }).catch(() => {})
          }
        }
      } catch (_) {}
    }
  } catch (e) {
    results.errors.push(`stale block: ${e.message}`)
  }

  // ── 3. WATCHLIST PRICE ALERTS ────────────────────────────────────────────
  // For each business's watched products, compare current best price against
  // 7-day-ago price. Email the buyer if any product dropped or rose >7%.
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()

    // Load all watchlist entries with business contact info
    const { data: watchlistItems } = await supabaseAdmin
      .from('buyer_watchlist')
      .select('product_id, business_id, businesses(name, contact_email)')

    if (watchlistItems?.length) {
      // Current best prices per product
      const productIds = [...new Set(watchlistItems.map(w => w.product_id))]
      const { data: currentPrices } = await supabaseAdmin
        .from('supplier_prices')
        .select('product_id, price_php, unit')
        .in('product_id', productIds)
        .eq('active', true)

      // Best price 7 days ago from price_history
      const { data: histPrices } = await supabaseAdmin
        .from('price_history')
        .select('product_id, price_php, unit, recorded_at')
        .in('product_id', productIds)
        .lt('recorded_at', sevenDaysAgo)
        .order('recorded_at', { ascending: false })

      // Product names
      const { data: productRows } = await supabaseAdmin
        .from('products')
        .select('id, canonical_name, default_unit')
        .in('id', productIds)

      const productMap = Object.fromEntries((productRows || []).map(p => [p.id, p]))

      // Best current price per product
      const bestCurrent = {}
      ;(currentPrices || []).forEach(r => {
        if (!bestCurrent[r.product_id] || r.price_php < bestCurrent[r.product_id].price) {
          bestCurrent[r.product_id] = { price: r.price_php, unit: r.unit }
        }
      })

      // Best historical price per product (most recent before 7d cutoff)
      const bestHist = {}
      ;(histPrices || []).forEach(r => {
        if (!bestHist[r.product_id]) bestHist[r.product_id] = { price: r.price_php, unit: r.unit }
      })

      // Group watchlist by business_id
      const byBusiness = {}
      watchlistItems.forEach(w => {
        if (!byBusiness[w.business_id]) byBusiness[w.business_id] = { biz: w.businesses, items: [] }
        byBusiness[w.business_id].items.push(w.product_id)
      })

      for (const [bizId, { biz, items }] of Object.entries(byBusiness)) {
        if (!biz?.contact_email) continue
        const alerts = []
        items.forEach(pid => {
          const cur = bestCurrent[pid]
          const hist = bestHist[pid]
          if (!cur || !hist || !hist.price) return
          const pct = Math.round(((cur.price - hist.price) / hist.price) * 100)
          if (Math.abs(pct) >= 7) {
            alerts.push({
              productName: productMap[pid]?.canonical_name || pid,
              unit: cur.unit || productMap[pid]?.default_unit || 'unit',
              currentPrice: cur.price,
              prevPrice: hist.price,
              pct,
            })
          }
        })
        if (!alerts.length) continue

        alerts.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
        const tpl = watchlistPriceAlertEmail({ buyerName: biz.name, alerts })
        await sendEmail({ to: biz.contact_email, ...tpl }).catch(e => console.log('[watchlist alert email error]', e.message))
        results.watchlistAlerts.push({ bizId, alertCount: alerts.length })
      }
    }
  } catch (e) {
    results.errors.push(`watchlist block: ${e.message}`)
  }

  return res.status(200).json({
    ok: true,
    recurringCreated:  results.recurring.length,
    staleReminders:    results.stale.length,
    watchlistAlerts:   results.watchlistAlerts.length,
    errors:            results.errors,
  })
}
