const { supabaseAdmin, requireAdmin } = require('../../../../../lib/supabase-admin')
const { sendEmail, accessApprovedEmail } = require('../../../../../lib/email')

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAdmin(req, res)
  if (!auth) return

  const { id } = req.query

  // Get the access request
  const { data: request, error: reqErr } = await supabaseAdmin
    .from('access_requests')
    .select('*')
    .eq('id', id)
    .single()

  if (reqErr || !request) return res.status(404).json({ error: 'Access request not found' })
  if (request.status !== 'pending') return res.status(400).json({ error: 'Already processed' })

  const isSupplier = request.requested_role === 'supplier'

  if (isSupplier) {
    // 1. Create supplier record
    const { data: supplier, error: supErr } = await supabaseAdmin.from('suppliers').insert({
      name: request.company_name,
      legal_name: request.company_name,
      category: 'produce', // default, admin can edit later
      tagline: `${request.business_type || 'Supplier'} — Philippines`,
      city: request.city || null,
      region: request.region || null,
      tin: request.tin || null,
      contact_phone: request.contact_phone || null,
      minimum_order_php: 1000,
      verified: false,
      active: false, // will activate after first payment
      status: 'approved',
      rating: 5.0,
      review_count: 0
    }).select('id').single()

    if (supErr) return res.status(500).json({ error: `Supplier creation failed: ${supErr.message}` })

    // 2. Invite supplier to create account via Supabase Auth
    const { data: invite, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      request.contact_email, {
        data: { role: 'supplier', company: request.company_name },
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || 'https://costarax.vercel.app'}/login.html`
      }
    )

    let userId = invite?.user?.id

    if (inviteErr) {
      // If invite fails (user already exists), try to get existing user
      console.log('Invite error (may already exist):', inviteErr.message)
      const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers()
      const existing = existingUsers?.users?.find(u => u.email === request.contact_email)
      userId = existing?.id
    }

    // 3. Create profile for the supplier user
    if (userId) {
      await supabaseAdmin.from('profiles').upsert({
        id: userId,
        email: request.contact_email,
        role: 'supplier',
        status: 'approved'
      }).catch(() => {})

      // 4. Link user to supplier via organization_members
      await supabaseAdmin.from('organization_members').insert({
        user_id: userId,
        supplier_id: supplier.id
      }).catch(() => {})
    }

    // 5. Mark access request as approved
    await supabaseAdmin.from('access_requests').update({
      status: 'approved',
      reviewed_at: new Date().toISOString(),
      reviewed_by: auth.user.id
    }).eq('id', id)

    // 6. Audit log
    await supabaseAdmin.from('admin_actions').insert({
      admin_id: auth.user.id,
      action_type: 'approve_supplier_request',
      target_id: supplier.id,
      notes: `Approved supplier: ${request.company_name} (${request.contact_email})`
    }).catch(() => {})

    // 7. Send approval email
    if (request.contact_email) {
      const tpl = accessApprovedEmail({ companyName: request.company_name, contactEmail: request.contact_email })
      await sendEmail({ to: request.contact_email, ...tpl })
    }

    return res.status(200).json({
      message: `${request.company_name} approved as supplier. ${userId ? 'Invite email sent.' : 'No email sent — add SMTP credentials.'}`,
      supplier_id: supplier.id
    })

  } else {
    // Buyer approval — create business record
    const { data: biz, error: bizErr } = await supabaseAdmin.from('businesses').insert({
      name: request.company_name,
      business_type: request.business_type || 'Business',
      tin: request.tin || null,
      city: request.city || null,
      region: request.region || null,
      contact_email: request.contact_email,
      contact_phone: request.contact_phone || null,
      status: 'approved',
      approved_at: new Date().toISOString()
    }).select('id').single()

    if (bizErr) return res.status(500).json({ error: `Business creation failed: ${bizErr.message}` })

    // Invite buyer
    const { data: invite, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      request.contact_email, {
        data: { role: 'buyer', company: request.company_name },
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || 'https://costarax.vercel.app'}/login.html`
      }
    )

    let userId = invite?.user?.id
    if (inviteErr) {
      const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers()
      userId = existingUsers?.users?.find(u => u.email === request.contact_email)?.id
    }

    if (userId) {
      await supabaseAdmin.from('profiles').upsert({
        id: userId, email: request.contact_email, role: 'buyer', status: 'approved'
      }).catch(() => {})
      await supabaseAdmin.from('organization_members').insert({
        user_id: userId, business_id: biz.id
      }).catch(() => {})
    }

    await supabaseAdmin.from('access_requests').update({
      status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: auth.user.id
    }).eq('id', id)

    await supabaseAdmin.from('admin_actions').insert({
      admin_id: auth.user.id, action_type: 'approve_buyer_request', target_id: biz.id,
      notes: `Approved buyer: ${request.company_name}`
    }).catch(() => {})

    if (request.contact_email) {
      const tpl = accessApprovedEmail({ companyName: request.company_name, contactEmail: request.contact_email })
      await sendEmail({ to: request.contact_email, ...tpl })
    }

    return res.status(200).json({ message: `${request.company_name} approved as buyer`, business_id: biz.id })
  }
}
