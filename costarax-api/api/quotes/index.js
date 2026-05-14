const { supabaseAdmin, requireAuth } = require('../../lib/supabase-admin')
const { sendEmail, quoteReceivedEmail } = require('../../lib/email')

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()

  const auth = await requireAuth(req, res)
  if (!auth) return

  if (req.method === 'GET') {
    let data, error

    if (auth.profile.role === 'buyer' || auth.profile.role === 'business') {
      const { data: biz } = await supabaseAdmin
        .from('businesses').select('id').eq('contact_email', auth.user.email).single()

      if (!biz) {
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
      // Admin — see all quotes, then enrich with names
      ;({ data, error } = await supabaseAdmin.from('quote_requests')
        .select('id,buyer_business_id,supplier_id,products_summary,status,created_at')
        .order('created_at', { ascending: false }).limit(100))
      if (data?.length) {
        const bizIds = [...new Set(data.map(q => q.buyer_business_id).filter(Boolean))]
        const supIds = [...new Set(data.map(q => q.supplier_id).filter(Boolean))]
        const [bizRes, supRes] = await Promise.all([
          bizIds.length ? supabaseAdmin.from('businesses').select('id,name').in('id', bizIds) : { data: [] },
          supIds.length ? supabaseAdmin.from('suppliers').select('id,name').in('id', supIds) : { data: [] }
        ])
        const bizMap = Object.fromEntries((bizRes.data||[]).map(b => [b.id, b.name]))
        const supMap = Object.fromEntries((supRes.data||[]).map(s => [s.id, s.name]))
        data = data.map(q => ({
          ...q,
          businesses: { name: bizMap[q.buyer_business_id] || null },
          suppliers: { name: supMap[q.supplier_id] || null }
        }))
      }
    }

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data || [])
  }

  if (req.method === 'POST') {
    const { supplier_id, products_summary, message, weekly_volume } = req.body
    if (!supplier_id || !message) return res.status(400).json({ error: 'supplier_id and message are required' })

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

    if (!buyerBusinessId) return res.status(400).json({ error: 'No business associated with this account' })

    const { data: quote, error } = await supabaseAdmin.from('quote_requests').insert({
      buyer_business_id: buyerBusinessId, supplier_id, requested_by: auth.user.id,
      products_summary, message, weekly_volume: weekly_volume || null, status: 'sent'
    }).select('id').single()

    if (error) return res.status(500).json({ error: error.message })

    try {
      const { data: supplier } = await supabaseAdmin.from('suppliers').select('name').eq('id', supplier_id).single()
      const { data: supplierMember } = await supabaseAdmin.from('organization_members').select('user_id').eq('supplier_id', supplier_id).single()
      if (supplierMember?.user_id) {
        const { data: sp } = await supabaseAdmin.from('profiles').select('email').eq('id', supplierMember.user_id).single()
        if (sp?.email) {
          const tpl = quoteReceivedEmail({ supplierName: supplier?.name, buyerName: buyerName || auth.user.email, products: products_summary || '', message })
          await sendEmail({ to: sp.email, ...tpl })
        }
      }
    } catch(e) { console.log('Email error:', e.message) }

    return res.status(201).json({ id: quote.id, message: 'Quote request sent' })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
