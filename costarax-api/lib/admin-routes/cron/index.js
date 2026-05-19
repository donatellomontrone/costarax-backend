// Daily cron — runs at 02:00 UTC (10:00 AM PH time)
// 1. Creates new quote requests for due recurring orders
// 2. Sends stale-quote reminders to suppliers (sent >48h, no reply)
//
// Vercel calls this with: Authorization: Bearer <CRON_SECRET>

const { supabaseAdmin } = require('../../supabase-admin')
const { sendEmail } = require('../../email')
const { notify } = require('../../notify')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
}

const FREQ_DAYS = { weekly: 7, biweekly: 14, monthly: 30 }

module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()

  // Verify cron secret (Vercel sets this automatically when CRON_SECRET is configured)
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = req.headers.authorization || ''
    if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' })
  }

  const results = { recurring: [], stale: [], errors: [] }

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

  return res.status(200).json({
    ok: true,
    recurringCreated: results.recurring.length,
    staleReminders:  results.stale.length,
    errors:          results.errors,
  })
}
