const { supabaseAdmin, requireAdmin } = require('../../supabase-admin')

module.exports = async (req, res) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  if (authErr) return res.status(500).json({ error: authErr.message })

  const { data: businesses, error } = await supabaseAdmin
    .from('businesses')
    .select('id,name,status,city,region,contact_email,contact_phone,business_type,created_at,approved_at')
    .order('name')

  if (error) return res.status(500).json({ error: error.message })

  const ids = (businesses || []).map(b => b.id)
  let orgMembers = []
  if (ids.length > 0) {
    const { data: membersData, error: membersErr } = await supabaseAdmin
      .from('organization_members')
      .select('business_id,user_id')
      .in('business_id', ids)
    if (membersErr) return res.status(500).json({ error: membersErr.message })
    orgMembers = membersData || []
  }

  const emailByUserId = Object.fromEntries((authData?.users || []).map(u => [u.id, u.email || null]))
  const membersByBiz = {}
  orgMembers.forEach(m => {
    if (!membersByBiz[m.business_id]) membersByBiz[m.business_id] = []
    membersByBiz[m.business_id].push({ user_id: m.user_id, email: emailByUserId[m.user_id] || null })
  })

  const enriched = (businesses || []).map(b => ({
    ...b,
    linked_users: membersByBiz[b.id] || [],
  }))

  return res.status(200).json(enriched)
}
