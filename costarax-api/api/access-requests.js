const { supabaseAdmin } = require('../lib/supabase-admin')
const { sendEmail, accessRequestEmail } = require('../lib/email')
const { applyCors } = require('../lib/cors')
const { enforce, clientIp } = require('../lib/rate-limit')

module.exports = async (req, res) => {
  if (applyCors(req, res, { methods: 'POST,OPTIONS' })) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Rate limit: 5 requests / hour per IP. Public endpoint, no auth.
  if (!(await enforce(req, res, { bucket: 'access-requests', identifier: clientIp(req), max: 5, windowSec: 3600 }))) return

  try {
    const body = req.body || {}
    const clip = (v, n) => String(v || '').trim().slice(0, n)

    const company_name   = clip(body.company_name, 200)
    const contact_email  = clip(body.contact_email, 200).toLowerCase()
    const business_type  = clip(body.business_type, 60)
    const tin            = clip(body.tin, 32) || null
    const contact_phone  = clip(body.contact_phone, 32) || null
    const city           = clip(body.city, 80) || null
    const region         = clip(body.region, 80) || null
    const requested_role = body.requested_role === 'supplier' ? 'supplier' : 'buyer'

    if (!contact_email)  return res.status(400).json({ error: 'contact_email is required' })
    if (!company_name)   return res.status(400).json({ error: 'company_name is required' })
    if (!business_type)  return res.status(400).json({ error: 'business_type is required' })

    // RFC-light email check + reject any HTML/control chars
    const EMAIL_RE = /^[^\s<>"'`\\;]+@[^\s<>"'`\\;]+\.[^\s<>"'`\\;]+$/
    if (!EMAIL_RE.test(contact_email)) return res.status(400).json({ error: 'invalid contact_email' })
    if (/[<>]/.test(company_name + business_type + (tin||'') + (contact_phone||'') + (city||'') + (region||''))) {
      return res.status(400).json({ error: 'invalid characters in form fields' })
    }

    // Insert without custom id — let DB generate it
    const { error: insertErr } = await supabaseAdmin
      .from('access_requests')
      .insert({ requested_role, company_name, business_type, contact_email, tin, contact_phone, city, region })

    if (insertErr) {
      if (insertErr.code === '23505') {
        // Already exists — merge any newly-provided fields into the existing
        // request (never overwrite a prior value with null) so a "finish your
        // profile" step can enrich the original. Then return the id so any
        // document uploads attach to the same row.
        const { data: existing } = await supabaseAdmin
          .from('access_requests')
          .select('id')
          .eq('contact_email', contact_email)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (existing?.id) {
          const patch = { requested_role, company_name, business_type }
          if (tin)           patch.tin = tin
          if (contact_phone) patch.contact_phone = contact_phone
          if (city)          patch.city = city
          if (region)        patch.region = region
          const { error: updErr } = await supabaseAdmin.from('access_requests').update(patch).eq('id', existing.id)
          if (updErr) console.warn('access_request merge update failed:', updErr.message)
          return res.status(200).json({ id: existing.id, message: 'Request updated.' })
        }
        return res.status(409).json({ error: 'This email has already submitted a request' })
      }
      return res.status(500).json({ error: insertErr.message })
    }

    // Fetch the just-inserted id by email
    const { data: inserted } = await supabaseAdmin
      .from('access_requests')
      .select('id')
      .eq('contact_email', contact_email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // Notify admin
    const adminEmail = process.env.ADMIN_EMAIL || 'hello@costarax.com'
    const tpl = accessRequestEmail({ companyName: company_name, contactEmail: contact_email, businessType: business_type })
    await sendEmail({ to: adminEmail, ...tpl }).catch(() => {})

    return res.status(201).json({
      id: inserted?.id || null,
      message: 'Access request submitted successfully'
    })

  } catch (err) {
    console.error('Unexpected error:', err.message)
    return res.status(500).json({ error: 'Internal server error: ' + err.message })
  }
}
