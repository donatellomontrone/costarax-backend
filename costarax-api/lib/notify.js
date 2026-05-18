const { Vonage } = require('@vonage/server-sdk')

// Vonage client — initialised lazily so missing env vars don't crash cold starts
let _vonage = null
function getVonage() {
  if (_vonage) return _vonage
  const key    = process.env.VONAGE_API_KEY
  const secret = process.env.VONAGE_API_SECRET
  if (!key || !secret) return null
  _vonage = new Vonage({ apiKey: key, apiSecret: secret })
  return _vonage
}

// Normalise a Philippine mobile number to E.164 (+63XXXXXXXXXX)
function e164PH(raw) {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('63') && digits.length === 12) return '+' + digits
  if (digits.startsWith('0') && digits.length === 11)  return '+63' + digits.slice(1)
  if (digits.length === 10 && digits.startsWith('9'))  return '+63' + digits
  // International number already — prefix + if missing
  if (digits.length > 10) return '+' + digits
  return null
}

// Message templates
const TEMPLATES = {
  quote_received: ({ buyerName, products }) =>
    `[Costarax] New quote request from ${buyerName}.\nProducts: ${products || '—'}.\nReply at costarax.com`,

  quote_replied: ({ supplierName }) =>
    `[Costarax] ${supplierName} replied to your quote request.\nConfirm your order at costarax.com`,

  order_confirmed: ({ buyerName }) =>
    `[Costarax] ${buyerName} confirmed an order with you.\nView details at costarax.com`,

  order_fulfilled: ({ supplierName }) =>
    `[Costarax] Your order from ${supplierName} has been fulfilled.\nRate your experience at costarax.com`,
}

// Send SMS via Vonage
async function sendSMS(to, text) {
  const vonage = getVonage()
  if (!vonage) { console.log('[notify] Vonage not configured — skipping SMS'); return }
  const phone = e164PH(to)
  if (!phone) { console.log('[notify] Invalid phone number:', to); return }
  const from = process.env.VONAGE_FROM || 'Costarax'
  try {
    const result = await vonage.sms.send({ to: phone, from, text })
    const msg = result?.messages?.[0]
    if (msg?.status !== '0') {
      console.warn('[notify] SMS failed:', msg?.['error-text'], 'to:', phone)
    } else {
      console.log('[notify] SMS sent to', phone)
    }
  } catch (e) {
    console.error('[notify] SMS error:', e.message)
  }
}

// Send Viber Business message via Vonage Messages API
async function sendViber(to, text) {
  const serviceId = process.env.VONAGE_VIBER_SERVICE_ID
  const appId     = process.env.VONAGE_APPLICATION_ID
  const privKey   = process.env.VONAGE_PRIVATE_KEY
  if (!serviceId || !appId || !privKey) {
    console.log('[notify] Viber not configured — skipping')
    return
  }
  const phone = e164PH(to)
  if (!phone) return
  try {
    // Messages API via Vonage SDK
    const vonageMsgs = new (require('@vonage/server-sdk').Vonage)({
      apiKey:      process.env.VONAGE_API_KEY,
      apiSecret:   process.env.VONAGE_API_SECRET,
      applicationId: appId,
      privateKey:  privKey,
    })
    await vonageMsgs.messages.send({
      message_type: 'text',
      channel:      'viber_service',
      to:           phone.replace('+', ''),
      from:         serviceId,
      text,
    })
    console.log('[notify] Viber sent to', phone)
  } catch (e) {
    console.error('[notify] Viber error:', e.message)
  }
}

/**
 * notify({ event, to, data })
 *
 * event: 'quote_received' | 'quote_replied' | 'order_confirmed' | 'order_fulfilled'
 * to:    phone number string (raw PH format)
 * data:  template variables object
 *
 * Tries Viber first (if configured), then SMS. Both are fire-and-forget.
 */
async function notify({ event, to, data = {} }) {
  const tpl = TEMPLATES[event]
  if (!tpl) { console.warn('[notify] Unknown event:', event); return }
  if (!to)  { console.log('[notify] No phone for event', event, '— skipping'); return }

  const text = tpl(data)

  // Run both in parallel — each fails gracefully on its own
  await Promise.allSettled([
    sendViber(to, text),
    sendSMS(to, text),
  ])
}

module.exports = { notify }
