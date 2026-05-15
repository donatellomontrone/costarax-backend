const { supabaseAdmin, requireAuth } = require('../../../lib/supabase-admin')
const { sendEmail, orderFulfilledEmail } = require('../../../lib/email')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAuth(req, res)
  if (!auth) return
  if (!['supplier', 'admin'].includes(auth.profile.role)) {
    return res.status(403).json({ error: 'Supplier access required' })
  }

  const { id } = req.query

  const { data: quote, error: qErr } = await supabaseAdmin
    .from('quote_requests')
    .select('*, businesses(name, contact_email), suppliers(name)')
    .eq('id', id)
    .single()

  if (qErr || !quote) return res.status(404).json({ error: 'Quote not found' })
  if (quote.status !== 'confirmed') {
    return res.status(400).json({ error: 'Quote must be confirmed before marking fulfilled' })
  }

  // Verify supplier owns this quote
  if (auth.profile.role !== 'admin') {
    const { data: org } = await supabaseAdmin
      .from('organization_members').select('supplier_id').eq('user_id', auth.user.id).single()
    if (!org || org.supplier_id !== quote.supplier_id) {
      return res.status(403).json({ error: 'Not authorized' })
    }
  }

  const { error } = await supabaseAdmin.from('quote_requests').update({
    status: 'fulfilled',
    fulfilled_at: new Date().toISOString()
  }).eq('id', id)

  if (error) return res.status(500).json({ error: error.message })

  // Notify buyer
  try {
    const buyerEmail = quote.businesses?.contact_email
    if (buyerEmail) {
      const tpl = orderFulfilledEmail({
        buyerName: quote.businesses?.name,
        supplierName: quote.suppliers?.name,
        products: quote.products_summary
      })
      await sendEmail({ to: buyerEmail, ...tpl })
    }
  } catch (e) { console.log('Email error:', e.message) }

  return res.status(200).json({ message: 'Order marked as fulfilled' })
}
