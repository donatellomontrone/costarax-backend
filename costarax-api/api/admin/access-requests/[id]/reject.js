const { supabaseAdmin, requireAdmin } = require('../../../../../lib/supabase-admin')

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

  const { id } = req.query

  const { data: request, error: reqErr } = await supabaseAdmin
    .from('access_requests')
    .select('id, company_name, status')
    .eq('id', id)
    .single()

  if (reqErr || !request) return res.status(404).json({ error: 'Access request not found' })
  if (request.status !== 'pending') return res.status(400).json({ error: 'Already processed' })

  const { error } = await supabaseAdmin
    .from('access_requests')
    .update({ status: 'rejected' })
    .eq('id', id)

  if (error) return res.status(500).json({ error: error.message })

  await supabaseAdmin.from('admin_actions').insert({
    admin_id: auth.user.id,
    action_type: 'reject_access_request',
    target_id: id,
    notes: `Rejected: ${request.company_name}`
  }).catch(() => {})

  return res.status(200).json({ message: `${request.company_name} rejected` })
}
