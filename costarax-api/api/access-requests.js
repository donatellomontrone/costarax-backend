const { supabaseAdmin } = require('../lib/supabase-admin')
const { sendEmail, accessRequestEmail } = require('../lib/email')

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const body = req.body || {}
    const company_name   = (body.company_name || '').trim()
    const contact_email  = (body.contact_email || '').trim().toLowerCase()
    const business_type  = (body.business_type || '').trim()
    const tin            = (body.tin || '').trim() || null
    const contact_phone  = (body.contact_phone || '').trim() || null
    const city           = (body.city || '').trim() || null
    const region         = (body.region || '').trim() || null
    const requested_role = body.requested_role === 'supplier' ? 'supplier' : 'buyer'

    if (!contact_email)  return res.status(400).json({ error: 'contact_email is required' })
    if (!company_name)   return res.status(400).json({ error: 'company_name is required' })
    if (!business_type)  return res.status(400).json({ error: 'business_type is required' })

    // Insert without custom id — let DB generate it
    const { error: insertErr } = await supabaseAdmin
      .from('access_requests')
      .insert({ requested_role, company_name, business_type, contact_email, tin, contact_phone, city, region })

    if (insertErr) {
      if (insertErr.code === '23505') {
        // Already exists — find existing id to allow document re-upload
        const { data: existing } = await supabaseAdmin
          .from('access_requests').select('id').eq('contact_email', contact_email).single()
        if (existing?.id) {
          return res.status(200).json({ id: existing.id, message: 'Request already submitted — documents will be added to your existing request.' })
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
      .single()

    // Notify admin
    const adminEmail = process.env.ADMIN_EMAIL || 'donatello@costarax.com'
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
