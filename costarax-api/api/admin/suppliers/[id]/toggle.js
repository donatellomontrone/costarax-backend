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
  const { data: s } = await supabaseAdmin.from('suppliers').select('name,active').eq('id', id).single()
  if (!s) return res.status(404).json({ error: 'Supplier not found' })
  const newActive = !s.active
  const { error } = await supabaseAdmin.from('suppliers').update({ active: newActive }).eq('id', id)
  if (error) return res.status(500).json({ error: error.message })
  await supabaseAdmin.from('admin_actions').insert({ admin_id: auth.user.id, action_type: newActive ? 'activate_supplier' : 'pause_supplier', target_id: id, notes: `${newActive ? 'Activated' : 'Paused'}: ${s.name}` }).catch(() => {})
  return res.status(200).json({ active: newActive, message: `${s.name} ${newActive ? 'activated' : 'paused'}` })
}
