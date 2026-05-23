// GET /api/my-prices
// Returns the authenticated supplier's active prices using service_role,
// bypassing any RLS / GRANT issues that affect the client-side Supabase query.
// Used by the supplier dashboard to guarantee products always load.

const { supabaseAdmin, requireAuth } = require('../lib/supabase-admin')
const { applyCors } = require('../lib/cors')
const { resolveSupplierMembership } = require('../lib/user-context')

module.exports = async (req, res) => {
  if (applyCors(req, res, { methods: 'GET,OPTIONS' })) return
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAuth(req, res)
  if (!auth) return
  if (!['supplier', 'admin'].includes(auth.profile.role)) {
    return res.status(403).json({ error: 'Supplier access required' })
  }

  const org = await resolveSupplierMembership(supabaseAdmin, auth.user.id, auth.user.email)
  if (!org?.supplier_id) return res.status(404).json({ error: 'No supplier linked' })

  // Fetch active prices WITH product details (service_role bypasses all RLS).
  // Including canonical_name/category_id lets the frontend build idToPid without
  // depending on the client-side products query (which may be limited to 1000 rows
  // or blocked by missing RLS grants).
  const { data: active, error: aErr } = await supabaseAdmin
    .from('supplier_prices')
    .select('product_id, price_php, stock_qty, unit, updated_at, products(id, canonical_name, default_unit, category_id)')
    .eq('supplier_id', org.supplier_id)
    .eq('active', true)

  if (aErr) return res.status(500).json({ error: aErr.message })

  // Fetch hidden prices so supplier can manage/unhide them
  const { data: hidden } = await supabaseAdmin
    .from('supplier_prices')
    .select('product_id, price_php, stock_qty, unit, updated_at, products(id, canonical_name, default_unit, category_id)')
    .eq('supplier_id', org.supplier_id)
    .eq('active', false)

  return res.status(200).json({
    supplier_id: org.supplier_id,
    active:  active  || [],
    hidden:  hidden  || []
  })
}
