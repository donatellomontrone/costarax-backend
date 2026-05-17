const { supabaseAdmin, requireAdmin } = require('../../../../lib/supabase-admin')
const { sendEmail, accessApprovedEmail } = require('../../../../lib/email')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAdmin(req, res)
  if (!auth) return

  const { id, action } = req.query

  // ── APPROVE ───────────────────────────────────────────────────────────────
  if (action === 'approve') {
    const { data: biz } = await supabaseAdmin.from('businesses').select('name,contact_email,status').eq('id', id).single()
    if (!biz) return res.status(404).json({ error: 'Business not found' })
    if (biz.status === 'approved') return res.status(400).json({ error: 'Already approved' })

    const { error } = await supabaseAdmin.from('businesses').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })

    await supabaseAdmin.from('admin_actions').insert({ admin_id: auth.user.id, action_type: 'approve_business', target_id: id, notes: `Approved: ${biz.name}` })
    if (biz.contact_email) {
      const tpl = accessApprovedEmail({ companyName: biz.name, contactEmail: biz.contact_email })
      await sendEmail({ to: biz.contact_email, ...tpl })
    }
    return res.status(200).json({ message: `${biz.name} approved` })
  }

  // ── REJECT ────────────────────────────────────────────────────────────────
  if (action === 'reject') {
    const { data: biz } = await supabaseAdmin.from('businesses').select('name').eq('id', id).single()
    if (!biz) return res.status(404).json({ error: 'Business not found' })

    const { error } = await supabaseAdmin.from('businesses').update({ status: 'rejected' }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })

    await supabaseAdmin.from('admin_actions').insert({ admin_id: auth.user.id, action_type: 'reject_business', target_id: id, notes: `Rejected: ${biz.name}` })
    return res.status(200).json({ message: `${biz.name} rejected` })
  }

  return res.status(404).json({ error: 'Unknown action' })
}
