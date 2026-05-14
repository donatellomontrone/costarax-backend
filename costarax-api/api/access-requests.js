const { supabaseAdmin } = require('../lib/supabase-admin')
const { sendEmail, accessRequestEmail } = require('../lib/email')

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { company_name, contact_email, tin, business_type, requested_role } = req.body
  if (!contact_email) return res.status(400).json({ error: 'contact_email is required' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) return res.status(400).json({ error: 'Invalid email' })

  const { error } = await supabaseAdmin.from('access_requests').insert({
    requested_role: requested_role === 'supplier' ? 'supplier' : 'buyer',
    company_name: company_name?.trim() || null,
    contact_email: contact_email.trim().toLowerCase(),
    tin: tin?.trim() || null,
    business_type: business_type || null,
    status: 'pending'
  })

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'This email has already submitted a request' })
    return res.status(500).json({ error: error.message })
  }

  if (process.env.EMAIL_USER) {
    const tpl = accessRequestEmail({ companyName: company_name || contact_email, contactEmail: contact_email, businessType: business_type })
    await sendEmail({ to: process.env.EMAIL_USER, ...tpl })
  }

  return res.status(201).json({ message: 'Access request submitted successfully' })
}
