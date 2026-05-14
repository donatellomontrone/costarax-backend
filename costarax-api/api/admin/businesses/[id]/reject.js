const { supabaseAdmin, requireAdmin } = require('../../../../lib/supabase-admin')

const CORS_H = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'}

module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k,v]) => res.setHeader(k,v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireAdmin(req, res)
  if (!auth) return
  const { id } = req.query
  const { data: biz } = await supabaseAdmin.from('businesses').select('name').eq('id', id).single()
  if (!biz) return res.status(404).json({ error: 'Business not found' })
  const { error } = await supabaseAdmin.from('businesses').update({ status: 'rejected' }).eq('id', id)
  if (error) return res.status(500).json({ error: error.message })
  await supabaseAdmin.from('admin_actions').insert({ admin_id: auth.user.id, action_type: 'reject_business', target_id: id, notes: `Rejected: ${biz.name}` }).catch(() => {})
  return res.status(200).json({ message: `${biz.name} rejected` })
}
