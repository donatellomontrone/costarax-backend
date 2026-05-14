const { supabaseAdmin, verifyToken } = require('../lib/supabase-admin')

const CORS_H = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'}

module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k,v]) => res.setHeader(k,v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const token = req.headers.authorization?.replace('Bearer ', '')
  const user = await verifyToken(token)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  const { data: suppliers, error } = await supabaseAdmin
    .from('suppliers')
    .select('id,name,category,tagline,city,region,minimum_order_php,rating,review_count,verified,plan,active')
    .eq('active', true)
    .eq('status', 'approved')
    .order('rating', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })

  const ids = suppliers.map(s => s.id)
  const { data: prices } = await supabaseAdmin
    .from('supplier_prices')
    .select('supplier_id,product_id,price_php,products(id,canonical_name,default_unit,category_id)')
    .in('supplier_id', ids)
    .eq('active', true)

  const priceMap = {}
  ;(prices || []).forEach(p => {
    if (!priceMap[p.supplier_id]) priceMap[p.supplier_id] = []
    priceMap[p.supplier_id].push({
      product_id: p.product_id,
      product_name: p.products?.canonical_name,
      product_unit: p.products?.default_unit,
      product_category: p.products?.category_id,
      price_php: p.price_php
    })
  })

  const result = suppliers.map(s => ({
    ...s,
    location: [s.city, s.region].filter(Boolean).join(', '),
    prices: priceMap[s.id] || []
  }))

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120')
  return res.status(200).json(result)
}
