const { supabaseAdmin, requireAdmin } = require('../../../lib/supabase-admin')

const CORS_H = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'}

module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k,v]) => res.setHeader(k,v))
  if (req.method === 'OPTIONS') return res.status(200).end()

  const auth = await requireAdmin(req, res)
  if (!auth) return

  // GET — list all suppliers with full details
  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('suppliers')
      .select('id, name, category, tagline, city, region, minimum_order_php, rating, verified, active, status, plan')
      .order('name')
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  // POST — create new supplier
  if (req.method === 'POST') {
    const { name, category, tagline, city, region, minimum_order_php, tin, delivery_coverage } = req.body
    if (!name || !category) return res.status(400).json({ error: 'name and category are required' })

    const { data, error } = await supabaseAdmin.from('suppliers').insert({
      name: name.trim(),
      legal_name: name.trim(),
      category,
      tagline: tagline?.trim() || null,
      city: city?.trim() || null,
      region: region?.trim() || null,
      minimum_order_php: minimum_order_php || 1000,
      tin: tin?.trim() || null,
      delivery_coverage: delivery_coverage?.trim() || null,
      verified: false,
      active: false,
      status: 'pending',
      rating: 5.0,
      review_count: 0
    }).select('id, name').single()

    if (error) return res.status(500).json({ error: error.message })

    await supabaseAdmin.from('admin_actions').insert({
      admin_id: auth.user.id,
      action_type: 'create_supplier',
      target_id: data.id,
      notes: `Created supplier: ${name}`
    }).catch(() => {})

    return res.status(201).json({ id: data.id, message: `${name} created successfully` })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
