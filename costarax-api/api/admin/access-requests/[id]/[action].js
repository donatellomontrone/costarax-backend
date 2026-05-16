const { supabaseAdmin, requireAdmin } = require('../../../../../lib/supabase-admin')
const { sendEmail, accessApprovedEmail } = require('../../../../../lib/email')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAdmin(req, res)
  if (!auth) return

  const { id, action } = req.query

  const { data: request, error: reqErr } = await supabaseAdmin
    .from('access_requests').select('*').eq('id', id).single()

  if (reqErr || !request) return res.status(404).json({ error: 'Access request not found' })
  if (request.status !== 'pending') return res.status(400).json({ error: 'Already processed' })

  // ── REJECT ────────────────────────────────────────────────────────────────
  if (action === 'reject') {
    const { error } = await supabaseAdmin
      .from('access_requests').update({ status: 'rejected' }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })

    await supabaseAdmin.from('admin_actions').insert({
      admin_id: auth.user.id, action_type: 'reject_access_request',
      target_id: id, notes: `Rejected: ${request.company_name}`
    }).catch(() => {})

    return res.status(200).json({ message: `${request.company_name} rejected` })
  }

  // ── APPROVE ───────────────────────────────────────────────────────────────
  if (action === 'approve') {
    const isSupplier = request.requested_role === 'supplier'

    if (isSupplier) {
      const CATEGORY_MAP = {
        produce: 'produce', seafood: 'seafood', meat: 'meat',
        dairy: 'dairy', dry_goods: 'dry_goods', beverages: 'beverages'
      }
      const supplierCategory = CATEGORY_MAP[request.business_type] || 'general'

      const { data: supplier, error: supErr } = await supabaseAdmin.from('suppliers').insert({
        name: request.company_name, legal_name: request.company_name,
        category: supplierCategory,
        tagline: `${request.business_type || 'Supplier'} — Philippines`,
        city: request.city || null, region: request.region || null,
        tin: request.tin || null, contact_phone: request.contact_phone || null,
        minimum_order_php: 1000, verified: false, active: false,
        status: 'approved', rating: 5.0, review_count: 0
      }).select('id').single()

      if (supErr) return res.status(500).json({ error: `Supplier creation failed: ${supErr.message}` })

      const { data: invite, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        request.contact_email, {
          data: { role: 'supplier', company: request.company_name },
          redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || 'https://costarax.vercel.app'}/login.html`
        }
      )
      if (inviteErr) {
        console.error('Invite failed for supplier:', request.contact_email, inviteErr.message)
        return res.status(500).json({ error: `Invite failed: ${inviteErr.message}. Please retry or check the email address.` })
      }
      const userId = invite?.user?.id

      if (userId) {
        await supabaseAdmin.from('profiles').upsert({
          id: userId, email: request.contact_email, role: 'supplier', status: 'approved'
        }).catch(() => {})
        await supabaseAdmin.from('organization_members').insert({
          user_id: userId, supplier_id: supplier.id
        }).catch(() => {})
      }

      await supabaseAdmin.from('access_requests').update({
        status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: auth.user.id
      }).eq('id', id)

      await supabaseAdmin.from('admin_actions').insert({
        admin_id: auth.user.id, action_type: 'approve_supplier_request',
        target_id: supplier.id,
        notes: `Approved supplier: ${request.company_name} (${request.contact_email})`
      }).catch(() => {})

      if (request.contact_email) {
        const tpl = accessApprovedEmail({ companyName: request.company_name, contactEmail: request.contact_email })
        await sendEmail({ to: request.contact_email, ...tpl })
      }

      return res.status(200).json({
        message: `${request.company_name} approved as supplier. ${userId ? 'Invite email sent.' : 'No email sent — add SMTP credentials.'}`,
        supplier_id: supplier.id
      })

    } else {
      const { data: biz, error: bizErr } = await supabaseAdmin.from('businesses').insert({
        name: request.company_name, business_type: request.business_type || 'Business',
        tin: request.tin || null, city: request.city || null, region: request.region || null,
        contact_email: request.contact_email, contact_phone: request.contact_phone || null,
        status: 'approved', approved_at: new Date().toISOString()
      }).select('id').single()

      if (bizErr) return res.status(500).json({ error: `Business creation failed: ${bizErr.message}` })

      const { data: invite, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        request.contact_email, {
          data: { role: 'buyer', company: request.company_name },
          redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || 'https://costarax.vercel.app'}/login.html`
        }
      )
      if (inviteErr) {
        console.error('Invite failed for buyer:', request.contact_email, inviteErr.message)
        return res.status(500).json({ error: `Invite failed: ${inviteErr.message}. Please retry or check the email address.` })
      }
      const userId = invite?.user?.id

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
        admin_id: auth.user.id, action_type: 'approve_buyer_request',
        target_id: biz.id, notes: `Approved buyer: ${request.company_name}`
      }).catch(() => {})

      if (request.contact_email) {
        const tpl = accessApprovedEmail({ companyName: request.company_name, contactEmail: request.contact_email })
        await sendEmail({ to: request.contact_email, ...tpl })
      }

      return res.status(200).json({ message: `${request.company_name} approved as buyer`, business_id: biz.id })
    }
  }

  return res.status(404).json({ error: 'Unknown action' })
}
