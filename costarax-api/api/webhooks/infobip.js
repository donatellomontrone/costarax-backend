// Infobip inbound webhook — the WhatsApp/Viber <-> in-app chat relay.
//
// Flow:
//   1. A buyer/supplier messages the Costarax WhatsApp/Viber number. Their first
//      message carries a reference code [CX-<quote_request_id>] (pre-filled by the
//      "Continue on WhatsApp" button on the site).
//   2. Infobip forwards the inbound message here.
//   3. We map sender phone -> quote thread + role, store it in `quote_messages`
//      (so it appears in the on-site chat box), and relay it to the counterparty's
//      WhatsApp/Viber so the conversation stays in sync on every surface.
//
// Inert until Infobip env vars are set (INFOBIP_API_KEY/BASE_URL/SENDERS) and the
// webhook URL is registered on the Infobip dashboard. Optional shared secret:
// set INFOBIP_WEBHOOK_TOKEN and register the URL as .../api/webhooks/infobip?token=XXX

const { supabaseAdmin } = require('../../lib/supabase-admin')
const { sendWhatsAppText, sendViberText, e164PH } = require('../../lib/notify')

const CODE_RX = /\[CX-([0-9a-fA-F-]{6,})\]/

function samePhone(a, b) {
  const x = e164PH(a), y = e164PH(b)
  return !!x && !!y && x === y
}

// Pull the message text + channel out of Infobip's (somewhat variable) MO payload.
function extractInbound(r) {
  const text =
    r?.message?.text ??
    r?.message?.content?.text ??
    r?.content?.text ??
    r?.text ??
    r?.cleanText ?? ''
  const channelRaw = String(r?.channel || r?.integrationType || r?.platform || 'WHATSAPP').toUpperCase()
  const channel = channelRaw.includes('VIBER') ? 'viber' : 'whatsapp'
  return { from: r?.from || r?.sender, text: String(text || '').trim(), channel }
}

async function resolveThread(phone, text) {
  // 1) Reference code in the message → authoritative.
  const m = text.match(CODE_RX)
  let quoteId = m ? m[1] : null
  let role = null

  if (quoteId) {
    const { data: q } = await supabaseAdmin
      .from('quote_requests').select('id,buyer_business_id,supplier_id').eq('id', quoteId).maybeSingle()
    if (!q) quoteId = null
    else {
      const [{ data: biz }, { data: sup }] = await Promise.all([
        supabaseAdmin.from('businesses').select('contact_phone').eq('id', q.buyer_business_id).maybeSingle(),
        supabaseAdmin.from('suppliers').select('contact_phone').eq('id', q.supplier_id).maybeSingle(),
      ])
      if (samePhone(phone, sup?.contact_phone)) role = 'supplier'
      else role = 'buyer' // default the sender to the buyer side if not clearly the supplier
      await supabaseAdmin.from('wa_thread_map')
        .upsert({ phone: e164PH(phone), quote_request_id: quoteId, role, updated_at: new Date().toISOString() }, { onConflict: 'phone' })
      return { quoteId, role }
    }
  }

  // 2) No code → fall back to the last thread this phone was mapped to.
  const { data: map } = await supabaseAdmin
    .from('wa_thread_map').select('quote_request_id,role').eq('phone', e164PH(phone)).maybeSingle()
  if (map?.quote_request_id) return { quoteId: map.quote_request_id, role: map.role || 'buyer' }

  return { quoteId: null, role: null }
}

async function relayToCounterparty(quoteId, senderRole, channel, text) {
  const { data: q } = await supabaseAdmin
    .from('quote_requests').select('buyer_business_id,supplier_id').eq('id', quoteId).maybeSingle()
  if (!q) return
  const [{ data: biz }, { data: sup }] = await Promise.all([
    supabaseAdmin.from('businesses').select('name,contact_phone').eq('id', q.buyer_business_id).maybeSingle(),
    supabaseAdmin.from('suppliers').select('name,contact_phone').eq('id', q.supplier_id).maybeSingle(),
  ])
  const fromName = senderRole === 'supplier' ? (sup?.name || 'Supplier') : (biz?.name || 'Buyer')
  const toPhone = senderRole === 'supplier' ? biz?.contact_phone : sup?.contact_phone
  if (!toPhone) return
  const msg = `${fromName} (via Costarax): ${text}`
  if (channel === 'viber') await sendViberText(toPhone, msg)
  else await sendWhatsAppText(toPhone, msg)
}

module.exports = async (req, res) => {
  // Always 200 quickly so Infobip doesn't retry-storm; do the work best-effort.
  try {
    if (req.method !== 'POST') return res.status(200).json({ ok: true })

    const token = process.env.INFOBIP_WEBHOOK_TOKEN
    if (token && req.query?.token !== token) return res.status(401).json({ error: 'bad token' })

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const results = Array.isArray(body.results) ? body.results
      : Array.isArray(body.messages) ? body.messages
      : (body.from || body.message ? [body] : [])

    for (const r of results) {
      const { from, text, channel } = extractInbound(r)
      if (!from) continue

      const { quoteId, role } = await resolveThread(from, text)
      const clean = text.replace(CODE_RX, '').trim() || '[message]'

      if (!quoteId) {
        // Couldn't route — guide the sender once.
        const help = 'Costarax: we couldn’t match this message to a quote. Please reply from the “Continue on WhatsApp” button on costarax.com so we can link your conversation.'
        if (channel === 'viber') await sendViberText(from, help); else await sendWhatsAppText(from, help)
        continue
      }

      await supabaseAdmin.from('quote_messages').insert({
        quote_request_id: quoteId,
        sender_role: role || 'buyer',
        body: clean,
        via: channel,
      })

      await relayToCounterparty(quoteId, role || 'buyer', channel, clean)
    }

    return res.status(200).json({ ok: true, handled: results.length })
  } catch (e) {
    console.error('[infobip webhook] error:', e.message)
    return res.status(200).json({ ok: false })
  }
}
