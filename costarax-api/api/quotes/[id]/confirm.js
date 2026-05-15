const { supabaseAdmin, requireAuth } = require('../../../lib/supabase-admin')
const { sendEmail, orderConfirmedEmail } = require('../../../lib/email')

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
  if (!['buyer', 'business', 'admin'].includes(auth.profile.role)) {
    return res.status(403).json({ error: 'Buyer access required' })
  }

  const { id } = req.query
  const { order_notes } = req.body || {}

  const { data: quote, error: qErr } = await supabaseAdmin
    .from('quote_requests')
    .select('*, businesses(name, contact_email), suppliers(name)')
    .eq('id', id)
    .single()

  if (qErr || !quote) return res.status(404).json({ error: 'Quote not found' })
  if (quote.status !== 'replied') {
    return res.status(400).json({ error: 'Quote must be in replied status to confirm' })
  }

  // Verify buyer owns this quote
  if (auth.profile.role !== 'admin') {
    let buyerBusinessId = null
    const { data: biz } = await supabaseAdmin
      .from('businesses').select('id').eq('contact_email', auth.user.email).single()
    if (biz) {
      buyerBusinessId = biz.id
    } else {
      const { data: org } = await supabaseAdmin
        .from('organization_members').select('business_id').eq('user_id', auth.user.id).single()
      buyerBusinessId = org?.business_id || null
    }
    if (!buyerBusinessId || buyerBusinessId !== quote.buyer_business_id) {
      return res.status(403).json({ error: 'Not authorized' })
    }
  }

  const { error } = await supabaseAdmin.from('quote_requests').update({
    status: 'confirmed',
    confirmed_at: new Date().toISOString(),
    order_notes: order_notes?.trim() || null
  }).eq('id', id)

  if (error) return res.status(500).json({ error: error.message })

  // Notify supplier
  try {
    const { data: supplierMember } = await supabaseAdmin
      .from('organization_members').select('user_id').eq('supplier_id', quote.supplier_id).single()
    if (supplierMember?.user_id) {
      const { data: sp } = await supabaseAdmin
        .from('profiles').select('email').eq('id', supplierMember.user_id).single()
      if (sp?.email) {
        const tpl = orderConfirmedEmail({
          supplierName: quote.suppliers?.name,
          buyerName: quote.businesses?.name,
          orderNotes: order_notes?.trim() || null
        })
        await sendEmail({ to: sp.email, ...tpl })
      }
    }
  } catch (e) { console.log('Email error:', e.message) }

  return res.status(200).json({ message: 'Order confirmed' })
}
