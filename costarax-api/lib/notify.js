// Notification dispatcher — Infobip (WhatsApp + Viber + SMS)
// All channels are optional and fail gracefully if env vars are not set.

const https = require('https')

function getConfig() {
  return {
    apiKey:   process.env.INFOBIP_API_KEY,
    baseUrl:  process.env.INFOBIP_BASE_URL, // e.g. xxxxx.api.infobip.com
    whatsapp: process.env.INFOBIP_WHATSAPP_SENDER, // registered WA number
    viber:    process.env.INFOBIP_VIBER_SENDER,     // Viber sender ID
    sms:      process.env.INFOBIP_SMS_SENDER || 'Costarax',
  }
}

// Normalise a Philippine mobile number to E.164 (e.g. 639XXXXXXXXX)
function e164PH(raw) {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('63') && digits.length === 12) return digits
  if (digits.startsWith('0')  && digits.length === 11) return '63' + digits.slice(1)
  if (digits.length === 10    && digits.startsWith('9')) return '63' + digits
  if (digits.length > 10) return digits.replace(/^\+/, '')
  return null
}

// Generic Infobip REST call
async function infobipPost(path, body, apiKey, baseUrl) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const options = {
      hostname: baseUrl,
      path,
      method: 'POST',
      headers: {
        'Authorization': `App ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// WhatsApp template definitions — register these names on Infobip dashboard
// Each event maps to a template name + ordered placeholders array
const WA_TEMPLATES = {
  quote_received: {
    name: 'costarax_quote_received',
    placeholders: ({ buyerName, products }) => [buyerName, products || '—'],
  },
  quote_replied: {
    name: 'costarax_quote_replied',
    placeholders: ({ supplierName }) => [supplierName],
  },
  order_confirmed: {
    name: 'costarax_order_confirmed',
    placeholders: ({ buyerName }) => [buyerName],
  },
  order_fulfilled: {
    name: 'costarax_order_fulfilled',
    placeholders: ({ supplierName }) => [supplierName],
  },
  quote_stale: {
    name: 'costarax_quote_stale',
    placeholders: ({ buyerName }) => [buyerName],
  },
}

// SMS fallback uses plain text
const SMS_TEMPLATES = {
  quote_received: ({ buyerName, products }) =>
    `[Costarax] New quote from ${buyerName}. Products: ${products || '—'}. costarax.com`,
  quote_replied: ({ supplierName }) =>
    `[Costarax] ${supplierName} replied to your quote. costarax.com`,
  order_confirmed: ({ buyerName }) =>
    `[Costarax] ${buyerName} confirmed an order with you. costarax.com`,
  order_fulfilled: ({ supplierName }) =>
    `[Costarax] Order from ${supplierName} fulfilled. Rate at costarax.com`,
  quote_stale: ({ buyerName }) =>
    `[Costarax] Reminder: ${buyerName} is waiting for your quote reply. Reply at costarax.com`,
}

async function sendWhatsApp(to, event, data, cfg) {
  if (!cfg.whatsapp) { console.log('[notify] WhatsApp sender not configured — skipping'); return }
  const phone = e164PH(to)
  if (!phone) { console.log('[notify] Invalid phone for WhatsApp:', to); return }
  const tpl = WA_TEMPLATES[event]
  if (!tpl) return
  try {
    const res = await infobipPost('/whatsapp/1/message/template', {
      messages: [{
        from: cfg.whatsapp,
        to:   phone,
        content: {
          templateName: tpl.name,
          templateData: { body: { placeholders: tpl.placeholders(data) } },
          language: 'en',
        },
      }]
    }, cfg.apiKey, cfg.baseUrl)
    if (res.status >= 400) console.warn('[notify] WhatsApp failed:', res.status, JSON.stringify(res.body))
    else console.log('[notify] WhatsApp sent to', phone)
  } catch (e) { console.error('[notify] WhatsApp error:', e.message) }
}

async function sendViber(to, event, data, cfg) {
  if (!cfg.viber) { console.log('[notify] Viber sender not configured — skipping'); return }
  const phone = e164PH(to)
  if (!phone) { console.log('[notify] Invalid phone for Viber:', to); return }
  const text = SMS_TEMPLATES[event]?.(data)
  if (!text) return
  try {
    const res = await infobipPost('/viber/2/messages', {
      messages: [{
        sender:       cfg.viber,
        destinations: [{ to: phone }],
        content:      { type: 'TEXT', text },
      }]
    }, cfg.apiKey, cfg.baseUrl)
    if (res.status >= 400) console.warn('[notify] Viber failed:', res.status, JSON.stringify(res.body))
    else console.log('[notify] Viber sent to', phone)
  } catch (e) { console.error('[notify] Viber error:', e.message) }
}

async function sendSMS(to, event, data, cfg) {
  const phone = e164PH(to)
  if (!phone) { console.log('[notify] Invalid phone for SMS:', to); return }
  const text = SMS_TEMPLATES[event]?.(data)
  if (!text) return
  try {
    const res = await infobipPost('/sms/2/text/advanced', {
      messages: [{
        from: cfg.sms,
        destinations: [{ to: phone }],
        text
      }]
    }, cfg.apiKey, cfg.baseUrl)
    if (res.status >= 400) console.warn('[notify] SMS failed:', res.status, JSON.stringify(res.body))
    else console.log('[notify] SMS sent to', phone)
  } catch (e) { console.error('[notify] SMS error:', e.message) }
}

/**
 * notify({ event, to, data })
 *
 * event: 'quote_received' | 'quote_replied' | 'order_confirmed' | 'order_fulfilled'
 * to:    phone number (raw PH format — 09XX, 639XX, or +639XX)
 * data:  template variables
 *
 * Sends WhatsApp + Viber in parallel (each skipped if sender not configured).
 * SMS used as fallback only if neither WA nor Viber is configured.
 */
async function notify({ event, to, data = {} }) {
  if (!WA_TEMPLATES[event]) { console.warn('[notify] Unknown event:', event); return }
  if (!to) { console.log('[notify] No phone for event:', event, '— skipping'); return }

  const cfg = getConfig()
  if (!cfg.apiKey || !cfg.baseUrl) {
    console.log('[notify] Infobip not configured — skipping all notifications')
    return
  }

  const hasApp = cfg.whatsapp || cfg.viber

  await Promise.allSettled([
    sendWhatsApp(to, event, data, cfg),
    sendViber(to, event, data, cfg),
    // SMS only as fallback when no app channel is configured
    ...(!hasApp ? [sendSMS(to, event, data, cfg)] : []),
  ])
}

module.exports = { notify }
