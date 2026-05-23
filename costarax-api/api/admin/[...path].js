const suppliersIndex = require('../../lib/admin-routes/suppliers')
const suppliersId = require('../../lib/admin-routes/suppliers-id')
const accessRequestsAction = require('../../lib/admin-routes/access-requests-action')
const businessesAction = require('../../lib/admin-routes/businesses-action')
const paymentsIndex = require('../../lib/admin-routes/payments')
const usersIndex = require('../../lib/admin-routes/users')
const cronIndex = require('../../lib/admin-routes/cron')
const { applyCors } = require('../../lib/cors')
const { supabaseAdmin } = require('../../lib/supabase-admin')

module.exports = async (req, res) => {
  if (applyCors(req, res, { methods: 'GET,POST,PATCH,DELETE,OPTIONS' })) return

  const queryPath = Array.isArray(req.query.path) ? req.query.path : [req.query.path].filter(Boolean)
  const urlPath = (req.url || '')
    .split('?')[0]
    .replace(/^\/api\/admin\/?/, '')
    .split('/')
    .filter(Boolean)
  const path = queryPath.length ? queryPath : urlPath
  const [resource, id, action] = path

  // Rewrites inject _id / _action query params when Vercel's catch-all
  // doesn't route multi-segment paths to this function directly.
  const rId     = req.query._id     || id
  const rAction = req.query._action || action

  if (resource === 'suppliers' && path.length === 1 && !rId) {
    return suppliersIndex(req, res)
  }

  if (resource === 'suppliers' && (path.length === 2 || rId)) {
    req.query.id = rId
    return suppliersId(req, res)
  }

  if (resource === 'access-requests' && (path.length === 3 || (rId && rAction))) {
    req.query.id = rId
    req.query.action = rAction
    return accessRequestsAction(req, res)
  }

  if (resource === 'businesses' && (path.length === 3 || (rId && rAction))) {
    req.query.id = rId
    req.query.action = rAction
    return businessesAction(req, res)
  }

  if (resource === 'payments' && path.length === 1) {
    return paymentsIndex(req, res)
  }

  if (resource === 'users') {
    if (path.length === 2 || rId) req.query.id = rId
    return usersIndex(req, res)
  }

  if (resource === 'cron') {
    return cronIndex(req, res)
  }

  // ── TEMPORARY one-shot fixer — remove after use ──────────────────────────
  if (resource === '_fix' && req.query.secret === 'cx-fix-2024-ok') {
    const email = req.query.email || 'moderna.bgc@gmail.com'
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    if (authErr) return res.status(500).json({ step: 'listUsers', error: authErr.message })
    const user = (authData?.users || []).find(u => u.email?.toLowerCase() === email.toLowerCase())
    if (!user) return res.status(404).json({ error: 'User not found: ' + email })
    const { data: suppliers } = await supabaseAdmin.from('suppliers').select('id,name,status,active').ilike('name', req.query.supplier || '%high tower%')
    if (!suppliers?.length) return res.status(404).json({ error: 'Supplier not found' })
    const supplier = suppliers[0]
    const { data: existing } = await supabaseAdmin.from('organization_members').select('user_id,supplier_id').eq('user_id', user.id)
    await supabaseAdmin.from('organization_members').delete().eq('user_id', user.id).not('supplier_id', 'is', null)
    const { error: insErr } = await supabaseAdmin.from('organization_members').insert({ user_id: user.id, supplier_id: supplier.id })
    if (insErr) return res.status(500).json({ step: 'insert', error: insErr.message })
    await supabaseAdmin.from('profiles').upsert({ id: user.id, email: user.email, role: 'supplier' }, { onConflict: 'id' })
    return res.status(200).json({ ok: true, user: { id: user.id, email: user.email }, supplier, was: existing })
  }

  return res.status(404).json({ error: 'Admin route not found' })
}
