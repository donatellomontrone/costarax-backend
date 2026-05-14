const { supabaseAdmin, requireAuth } = require('../../lib/supabase-admin')
const { sendEmail, quoteReceivedEmail } = require('../../lib/email')
 
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end()
 
  const auth = await requireAuth(req, res)
  if (!auth) return
 
  if (req.method === 'GET') {
    let data, error
 
    if (auth.profile.role === 'buyer' || auth.profile.role === 'business') {
      // Find business by user email
      const { data: biz } = await supabaseAdmin
        .from('businesses').select('id').eq('contact_email', auth.user.email).single()
 
      if (!biz) {
        // Try organization_members as fallback
        const { data: org } = await supabaseAdmin
          .from('organization_members').select('business_id').eq('user_id', auth.user.id).single()
        if (!org) return res.status(200).json([])
        ;({ data, error } = await supabaseAdmin.from('quote_requests')
          .select('id,supplier_id,products_summary,message,weekly_volume,status,reply,replied_at,created_at')
          .eq('buyer_business_id', org.business_id).order('created_at', { ascending: false }))
      } else {
        ;({ data, error } = await supabaseAdmin.from('quote_requests')
          .select('id,supplier_id,products_summary,message,weekly_volume,status,reply,replied_at,created_at')
          .eq('buyer_business_id', biz.id).order('created_at', { ascending: false }))
      }
 
    } else if (auth.profile.role === 'supplier') {
      const { data: org } = await supabaseAdmin
        .from('organization_members').select('supplier_id').eq('user_id', auth.user.id).single()
      if (!org) return res.status(200).json([])
      ;({ data, error } = await supabaseAdmin.from('quote_requests')
        .select('id,buyer_business_id,products_summary,message,weekly_volume,status,reply,replied_at,created_at')
        .eq('supplier_id', org.supplier_id).order('created_at', { ascending: false }))
    } else {
      ;({ data, error } = await supabaseAdmin.from('quote_requests')
        .select('*').order('created_at', { ascending: false }).limit(100))
    }
 
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data || [])
  }
 
  if (req.method === 'POST') {
    const { supplier_id, products_summary, message, weekly_volume } = req.body
    if (!supplier_id || !message) return res.status(400).json({ error: 'supplier_id and message are required' })
 
    // Find buyer business by email first, then organization_members as fallback
    let buyerBusinessId = null
    let buyerName = null
 
    const { data: biz } = await supabaseAdmin
      .from('businesses').select('id,name').eq('contact_email', auth.user.email).single()
 
    if (biz) {
      buyerBusinessId = biz.id
      buyerName = biz.name
    } else {
      const { data: org } = await supabaseAdmin
        .from('organization_members').select('business_id').eq('user_id', auth.user.id).single()
      if (org?.business_id) {
        buyerBusinessId = org.business_id
        const { data: b } = await supabaseAdmin.from('businesses').select('name').eq('id', org.business_id).single()
        buyerName = b?.name
      }
    }
 
    if (!buyerBusinessId) {
      return res.status(400).json({ error: 'No business associated with this account' })
    }
 
    const { data: quote, error } = await supabaseAdmin.from('quote_requests').insert({
      buyer_business_id: buyerBusinessId,
      supplier_id,
      requested_by: auth.user.id,
      products_summary,
      message,
      weekly_volume: weekly_volume || null,
      status: 'pending'
    }).select('id').single()
 
    if (error) return res.status(500).json({ error: error.message })
 
    // Email supplier
    try {
      const { data: supplier } = await supabaseAdmin.from('suppliers').select('name').eq('id', supplier_id).single()
      const { data: supplierMember } = await supabaseAdmin.from('organization_members').select('user_id').eq('supplier_id', supplier_id).single()
      if (supplierMember?.user_id) {
        const { data: supplierProfile } = await supabaseAdmin.from('profiles').select('email').eq('id', supplierMember.user_id).single()
        if (supplierProfile?.email) {
          const tpl = quoteReceivedEmail({ supplierName: supplier?.name, buyerName: buyerName || auth.user.email, products: products_summary || '', message })
          await sendEmail({ to: supplierProfile.email, ...tpl })
        }
      }
    } catch(e) { console.log('Email error:', e.message) }
 
    return res.status(201).json({ id: quote.id, message: 'Quote request sent' })
  }
 
  res.status(405).json({ error: 'Method not allowed' })
}
 
