const { supabaseAdmin } = require('../../lib/supabase-admin')
const crypto = require('crypto')
const { sendEmail } = require('../../lib/email')

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Length-safe constant-time hex compare. Returns false unless both inputs are
// non-empty, equal-length hex strings (timingSafeEqual throws on length mismatch).
function safeEq(aHex, bHex) {
  if (!aHex || !bHex || aHex.length !== bHex.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(aHex), Buffer.from(bHex))
  } catch { return false }
}

function verifySignature(rawBody, signature, secret) {
  try {
    const parts = {}
    signature.split(',').forEach(p => { const [k, v] = p.split('='); parts[k] = v })
    const toSign = `${parts.t}.${rawBody}`
    const expected = crypto.createHmac('sha256', secret).update(toSign).digest('hex')
    // Header carries both test (te) and live (li) HMACs; accept whichever matches.
    return safeEq(expected, parts.te) || safeEq(expected, parts.li)
  } catch { return false }
}

exports.config = { api: { bodyParser: false } }

module.exports = async (req, res) => {
  try {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).end()

  if (!process.env.PAYMONGO_WEBHOOK_SECRET) {
    console.error('PAYMONGO_WEBHOOK_SECRET not configured — rejecting webhook')
    return res.status(500).json({ error: 'Webhook secret not configured' })
  }

  const rawBody = await getRawBody(req)
  const signature = req.headers['paymongo-signature']

  if (!signature || !verifySignature(rawBody.toString(), signature, process.env.PAYMONGO_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: 'Invalid signature' })
  }

  let event
  try { event = JSON.parse(rawBody.toString()) }
  catch { return res.status(400).json({ error: 'Invalid JSON' }) }

  const eventId   = event.data?.id
  const eventType = event.data?.attributes?.type
  const attrs     = event.data?.attributes?.data?.attributes || {}

  // Idempotency check
  const { data: existing } = await supabaseAdmin
    .from('payment_events').select('id').eq('provider', 'paymongo').eq('provider_event_id', eventId).maybeSingle()
  if (existing) return res.status(200).json({ message: 'Already processed' })

  await supabaseAdmin.from('payment_events').insert({
    provider: 'paymongo', provider_event_id: eventId, event_type: eventType,
    livemode: event.data?.attributes?.livemode || false, payload: event
  })

  const sessionId = event.data?.attributes?.data?.id
  const now = new Date().toISOString()
  const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  // ── Payment succeeded → activate supplier ────────────────────────────────
  if (eventType === 'checkout_session.payment.paid') {
    const { data: sub } = await supabaseAdmin
      .from('subscriptions')
      .select('supplier_id, suppliers(name)')
      .eq('provider_checkout_session_id', sessionId)
      .maybeSingle()

    if (sub?.supplier_id) {
      // Activate supplier
      await supabaseAdmin.from('suppliers').update({ active: true, status: 'approved' }).eq('id', sub.supplier_id)

      // Update subscription
      await supabaseAdmin.from('subscriptions').update({
        status: 'active',
        last_payment_status: 'paid',
        last_payment_at: now,
        current_period_end: nextMonth,
        cancel_at_period_end: false
      }).eq('supplier_id', sub.supplier_id)

      // Notify supplier
      const { data: org } = await supabaseAdmin
        .from('organization_members').select('profiles(email)').eq('supplier_id', sub.supplier_id).limit(1).maybeSingle()
      const email = org?.profiles?.email
      if (email) {
        await sendEmail({
          to: email,
          subject: 'Your Costarax subscription is active',
          html: `<div style="font-family:sans-serif;padding:24px;max-width:500px">
            <h2 style="color:#1A5C3A">Payment confirmed ✓</h2>
            <p>Your Costarax supplier profile is now active and visible to verified buyers.</p>
            <a href="https://costarax.com/app.html?role=supplier" style="display:inline-block;margin-top:16px;background:#1A5C3A;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;">Go to dashboard</a>
          </div>`
        })
      }

      console.info(`Supplier ${sub.supplier_id} activated after payment`)
    }
  }

  // ── Payment failed → notify supplier ─────────────────────────────────────
  if (eventType === 'checkout_session.payment.failed') {
    await supabaseAdmin.from('subscriptions').update({
      last_payment_status: 'failed'
    }).eq('provider_checkout_session_id', sessionId)
  }

  // ── Subscription expired → suspend supplier ───────────────────────────────
  if (eventType === 'subscription.payment_failed' || eventType === 'subscription.cancelled') {
    const subscriptionId = attrs.id
    if (subscriptionId) {
      const { data: sub } = await supabaseAdmin
        .from('subscriptions').select('supplier_id').eq('provider_subscription_id', subscriptionId).maybeSingle()
      if (sub?.supplier_id) {
        await supabaseAdmin.from('suppliers').update({ active: false }).eq('id', sub.supplier_id)
        await supabaseAdmin.from('subscriptions').update({
          status: 'past_due', last_payment_status: 'failed'
        }).eq('supplier_id', sub.supplier_id)
        console.info(`Supplier ${sub.supplier_id} suspended — payment failed`)
      }
    }
  }

  await supabaseAdmin.from('payment_events')
    .update({ processed_at: now }).eq('provider_event_id', eventId)

  return res.status(200).json({ message: 'Webhook processed' })
  } catch (fatalErr) {
    console.error('[webhooks/paymongo] Unhandled error:', fatalErr.message)
    return res.status(500).json({ error: 'Internal server error', detail: fatalErr.message })
  }
}
