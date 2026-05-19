// Public endpoint — supplier self-registration
// Creates a supplier row with status='pending', active=false
// Admin approves via Manage Suppliers tab

const { supabaseAdmin } = require('../lib/supabase-admin')
const { sendEmail } = require('../lib/email')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
}

module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    name, category, city, region,
    contact_name, contact_email, contact_phone,
    description, years_in_business,
  } = req.body || {}

  if (!name?.trim())          return res.status(400).json({ error: 'Business name is required' })
  if (!contact_email?.trim()) return res.status(400).json({ error: 'Contact email is required' })
  if (!contact_phone?.trim()) return res.status(400).json({ error: 'Contact phone is required' })
  if (!category?.trim())      return res.status(400).json({ error: 'Category is required' })

  // Duplicate check
  const { data: existing } = await supabaseAdmin
    .from('suppliers')
    .select('id')
    .ilike('name', name.trim())
    .limit(1)
  if (existing?.length) return res.status(409).json({ error: 'A supplier with this name already exists. Contact support if this is your business.' })

  const { data: supplier, error } = await supabaseAdmin
    .from('suppliers')
    .insert({
      name:              name.trim(),
      category:          category.trim(),
      city:              city?.trim() || null,
      region:            region?.trim() || null,
      contact_name:      contact_name?.trim() || null,
      contact_email:     contact_email.trim().toLowerCase(),
      contact_phone:     contact_phone.trim(),
      description:       description?.trim() || null,
      years_in_business: parseInt(years_in_business) || null,
      status:            'pending',
      active:            false,
      plan:              'free',
      verified:          false,
      trial_ends_at:     new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select('id,name')
    .single()

  if (error) return res.status(500).json({ error: error.message })

  // Notify admin
  const adminEmail = process.env.ADMIN_EMAIL || 'donatello@costarax.com'
  await sendEmail({
    to:      adminEmail,
    subject: `New supplier registration: ${name.trim()}`,
    html:    `<p>A new supplier has registered on Costarax and is pending approval.</p><ul><li><strong>Name:</strong> ${name.trim()}</li><li><strong>Category:</strong> ${category.trim()}</li><li><strong>Location:</strong> ${[city, region].filter(Boolean).join(', ') || '—'}</li><li><strong>Contact:</strong> ${contact_name || '—'} · ${contact_email} · ${contact_phone}</li></ul><p>Review and approve at <a href="https://costarax.com/app.html">costarax.com/app.html</a> → Admin → Manage Suppliers.</p>`,
  }).catch(() => {})

  // Confirm to applicant
  await sendEmail({
    to:      contact_email.trim().toLowerCase(),
    subject: 'Your Costarax supplier application has been received',
    html:    `<p>Hi ${contact_name || name.trim()},</p><p>Thank you for registering <strong>${name.trim()}</strong> on Costarax. Our team will review your application and get back to you within 1–2 business days.</p><p>Questions? Reply to this email or message us at <a href="https://costarax.com">costarax.com</a>.</p><p>— The Costarax Team</p>`,
  }).catch(() => {})

  return res.status(201).json({ message: 'Application received. You will be contacted within 1–2 business days.', id: supplier.id })
}
