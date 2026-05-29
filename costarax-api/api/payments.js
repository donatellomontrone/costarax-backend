// /api/payments
//
// Self-serve subscription checkout for suppliers. Today only one action is
// implemented — create-checkout-session — but we leave room for future
// actions (e.g. cancel, change-plan, refund) by keying off body.action.
//
// Flow:
//   1. Supplier opens Plan & visibility tab in their workspace, clicks
//      "Upgrade to Pro" or "Upgrade to Corporate"
//   2. Frontend POSTs here with { action: 'create-checkout-session',
//      plan, duration_months }
//   3. We resolve the caller's supplier_id from the bearer token, mint a
//      PayMongo checkout session, persist a subscriptions row with
//      status='pending' and the provider_checkout_session_id, and return
//      { checkout_url } to redirect the browser to.
//   4. PayMongo handles card / GCash / PayMaya / GrabPay payment.
//   5. On success, PayMongo POSTs checkout_session.payment.paid to
//      /api/webhooks/paymongo, which flips the supplier active and the
//      subscription status='active'.
//   6. PayMongo redirects the user back to ?payment=success which the
//      frontend handles to refresh state and show a success toast.

const { supabaseAdmin, verifyToken } = require('../lib/supabase-admin')
const { applyCors } = require('../lib/cors')
const { resolveSupplierMembership } = require('../lib/user-context')

const PAYMONGO_API = 'https://api.paymongo.com/v1'

// Plan pricing — keep in sync with PLAN_META in app.html. Amounts in PHP,
// converted to centavos (×100) inside the checkout payload.
const PLAN_PRICING = {
  pro: {
    label: 'Costarax Pro',
    php_per_month: 7500,
    description: 'Pro plan: priority placement, analytics, featured supplier badge.'
  },
  corporate: {
    label: 'Costarax Corporate',
    php_per_month: 20000,
    description: 'Corporate plan: homepage placement, sponsored category, AI pricing recommendations, premium ranking.'
  }
}

function basicAuthHeader(secret) {
  // PayMongo uses HTTP Basic Auth with the secret key as the username
  // and an empty password. Pre-encode here so the value can go into the
  // Authorization header directly.
  return 'Basic ' + Buffer.from(`${secret}:`, 'utf-8').toString('base64')
}

async function paymongoFetch(path, secret, body) {
  const res = await fetch(`${PAYMONGO_API}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader(secret),
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch (_) {}
  if (!res.ok) {
    const err = json?.errors?.[0] || { detail: text.slice(0, 300) }
    throw Object.assign(new Error(err.detail || err.message || `PayMongo ${path} returned ${res.status}`), { status: res.status, body: json })
  }
  return json
}

module.exports = async (req, res) => {
  try {
    if (applyCors(req, res, { methods: 'POST,OPTIONS' })) return
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    if (!process.env.PAYMONGO_SECRET_KEY) {
      return res.status(500).json({
        error: 'PAYMONGO_SECRET_KEY not configured on server. Add it as a Vercel env var (use test key while integrating).'
      })
    }

    const token = req.headers.authorization?.replace('Bearer ', '')
    const user = await verifyToken(token)
    if (!user) return res.status(401).json({ error: 'Unauthorized' })

    const body = req.body || {}
    const action = String(body.action || '').trim()

    if (action === 'create-checkout-session') {
      const plan = String(body.plan || '').toLowerCase()
      const durationMonths = Math.max(1, Math.min(12, Number(body.duration_months) || 1))

      if (!PLAN_PRICING[plan]) {
        return res.status(400).json({ error: `Invalid plan "${plan}". Must be pro or corporate.` })
      }

      // Resolve supplier_id from the caller's session. Admin overrides
      // (acting on behalf of a supplier) are not supported here yet —
      // PayMongo's "send_email_receipt" goes to the caller's email so
      // it would be confusing.
      const org = await resolveSupplierMembership(supabaseAdmin, user.id, user.email)
      if (!org?.supplier_id) return res.status(403).json({ error: 'No supplier linked to this user' })

      const { data: supplier } = await supabaseAdmin
        .from('suppliers').select('id, name').eq('id', org.supplier_id).maybeSingle()
      if (!supplier) return res.status(404).json({ error: 'Supplier record not found' })

      const pricing = PLAN_PRICING[plan]
      const totalPHP = pricing.php_per_month * durationMonths
      const amountCentavos = Math.round(totalPHP * 100)

      // Build success/cancel redirect URLs back to the supplier workspace.
      // The frontend reads ?payment=success|cancelled to show a toast.
      const APP_URL = process.env.APP_URL || 'https://costarax.com'
      const successUrl = `${APP_URL}/app.html?role=supplier&payment=success&plan=${plan}`
      const cancelUrl = `${APP_URL}/app.html?role=supplier&payment=cancelled`

      // Create the PayMongo checkout session.
      const session = await paymongoFetch('/checkout_sessions', process.env.PAYMONGO_SECRET_KEY, {
        data: {
          attributes: {
            line_items: [{
              name: `${pricing.label} · ${durationMonths} month${durationMonths > 1 ? 's' : ''}`,
              description: pricing.description,
              quantity: 1,
              amount: amountCentavos,
              currency: 'PHP'
            }],
            payment_method_types: ['card', 'gcash', 'paymaya', 'grab_pay'],
            success_url: successUrl,
            cancel_url: cancelUrl,
            description: `${supplier.name} — ${pricing.label} (${durationMonths}mo)`,
            send_email_receipt: true,
            customer_email: user.email || undefined,
            metadata: {
              supplier_id: supplier.id,
              supplier_name: supplier.name,
              plan,
              duration_months: String(durationMonths)
            }
          }
        }
      })

      const checkoutSessionId = session?.data?.id
      const checkoutUrl = session?.data?.attributes?.checkout_url
      if (!checkoutSessionId || !checkoutUrl) {
        return res.status(500).json({ error: 'PayMongo returned an unexpected response shape', detail: session })
      }

      // Upsert a subscriptions row tied to this checkout. The webhook
      // will flip it to status='active' on payment.paid.
      const periodEnd = new Date(Date.now() + durationMonths * 30 * 24 * 60 * 60 * 1000).toISOString()
      const subPayload = {
        supplier_id: supplier.id,
        plan,
        status: 'pending',
        provider_checkout_session_id: checkoutSessionId,
        last_payment_status: 'pending',
        current_period_end: periodEnd,
        cancel_at_period_end: false,
      }
      const { error: upsertErr } = await supabaseAdmin
        .from('subscriptions')
        .upsert(subPayload, { onConflict: 'supplier_id' })
      if (upsertErr) {
        console.warn('[payments] subscription upsert warning:', upsertErr.message)
        // Don't block the checkout on this — the webhook will still
        // identify the session id and create the row if missing.
      }

      return res.status(200).json({
        checkout_url: checkoutUrl,
        session_id: checkoutSessionId,
        plan,
        duration_months: durationMonths,
        amount_php: totalPHP,
      })
    }

    return res.status(400).json({ error: `Unknown action "${action}"` })
  } catch (e) {
    console.error('[payments] unhandled error:', e.message)
    return res.status(500).json({ error: 'Payment endpoint failed', detail: e.message })
  }
}
