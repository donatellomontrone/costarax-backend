// TEMPORARY — delete after use
const { supabaseAdmin } = require('../lib/supabase-admin')

module.exports = async (req, res) => {
  if (req.query.secret !== 'costarax-fix-2024') return res.status(401).end()

  const TARGET_EMAIL = 'moderna.bgc@gmail.com'

  // 1. Find user in auth
  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
  if (authErr) return res.status(500).json({ step: 'listUsers', error: authErr.message })

  const user = (authData?.users || []).find(u => u.email?.toLowerCase() === TARGET_EMAIL.toLowerCase())
  if (!user) return res.status(404).json({ error: 'User not found: ' + TARGET_EMAIL })

  // 2. Find supplier High tower
  const { data: suppliers, error: supErr } = await supabaseAdmin
    .from('suppliers').select('id,name,status,active').ilike('name', '%high tower%')
  if (supErr) return res.status(500).json({ step: 'suppliers', error: supErr.message })
  if (!suppliers?.length) return res.status(404).json({ error: 'No supplier matching High tower' })

  const supplier = suppliers[0]

  // 3. Check current state
  const { data: existing } = await supabaseAdmin
    .from('organization_members').select('user_id,supplier_id').eq('user_id', user.id)

  // 4. Remove old supplier links, add new one
  await supabaseAdmin.from('organization_members').delete().eq('user_id', user.id).not('supplier_id', 'is', null)
  const { error: insErr } = await supabaseAdmin.from('organization_members').insert({
    user_id: user.id, supplier_id: supplier.id
  })
  if (insErr) return res.status(500).json({ step: 'insert', error: insErr.message })

  // 5. Ensure role = supplier
  await supabaseAdmin.from('profiles').upsert({ id: user.id, email: user.email, role: 'supplier' }, { onConflict: 'id' })

  return res.status(200).json({
    ok: true,
    user: { id: user.id, email: user.email },
    supplier: { id: supplier.id, name: supplier.name, active: supplier.active, status: supplier.status },
    wasLinked: existing
  })
}
