const { supabaseAdmin, requireAuth } = require('../../../lib/supabase-admin')

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAuth(req, res)
  if (!auth) return

  const { id } = req.query

  const { data: quote } = await supabaseAdmin
    .from('quote_requests').select('buyer_business_id, supplier_id, status').eq('id', id).single()
  if (!quote) return res.status(404).json({ error: 'Quote not found' })

  // Buyer can cancel their own quote, supplier can decline, admin can do both
  if (auth.profile.role === 'buyer' || auth.profile.role === 'business') {
    const { data: biz } = await supabaseAdmin
      .from('businesses').select('id').eq('contact_email', auth.user.email).single()
    if (!biz || biz.id !== quote.buyer_business_id) {
      return res.status(403).json({ error: 'Not authorized' })
    }
  } else if (auth.profile.role === 'supplier') {
    const { data: org } = await supabaseAdmin
      .from('organization_members').select('supplier_id').eq('user_id', auth.user.id).single()
    if (!org || org.supplier_id !== quote.supplier_id) {
      return res.status(403).json({ error: 'Not authorized' })
    }
  }

  const { error } = await supabaseAdmin
    .from('quote_requests').update({ status: 'cancelled' }).eq('id', id)

  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ message: 'Quote cancelled' })
}
