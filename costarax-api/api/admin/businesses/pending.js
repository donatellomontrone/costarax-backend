const { supabaseAdmin, requireAdmin } = require('../../../lib/supabase-admin')

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireAdmin(req, res)
  if (!auth) return
  const { data, error } = await supabaseAdmin.from('businesses')
    .select('id,name,business_type,contact_email,tin,city,region,created_at').eq('status', 'pending').order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json(data)
}
