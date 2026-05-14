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
    const { company_name, contact_email, tin, business_type, requested_role, contact_phone } = req.body || {}

    if (!contact_email) return res.status(400).json({ error: 'contact_email is required' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) {
      return res.status(400).json({ error: 'Invalid email address' })
    }

    const role = requested_role === 'supplier' ? 'supplier' : 'buyer'

    const { data, error } = await supabaseAdmin.from('access_requests').insert({
      requested_role: role,
      company_name: company_name?.trim() || null,
      contact_email: contact_email.trim().toLowerCase(),
      tin: tin?.trim() || null,
      business_type: business_type || null,
      contact_phone: contact_phone?.trim() || null
    }).select('id').single()

    if (error) {
      console.error('Insert error:', error)
      if (error.code === '23505') {
        return res.status(409).json({ error: 'This email has already submitted a request' })
      }
      return res.status(500).json({ error: error.message })
    }

    // Notify admin
    if (process.env.EMAIL_USER) {
      const tpl = accessRequestEmail({
        companyName: company_name || contact_email,
        contactEmail: contact_email,
        businessType: business_type
      })
      await sendEmail({ to: process.env.EMAIL_USER, ...tpl }).catch(() => {})
    }

    return res.status(201).json({
      id: data.id,
      message: 'Access request submitted successfully'
    })

  } catch (err) {
    console.error('Unexpected error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
