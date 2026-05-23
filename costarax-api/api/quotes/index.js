const { supabaseAdmin, requireAuth } = require('../../lib/supabase-admin')
const { sendEmail, quoteReceivedEmail } = require('../../lib/email')
const { notify } = require('../../lib/notify')
const { applyCors } = require('../../lib/cors')
const { resolveSupplierMembership, resolveBusinessMembership } = require('../../lib/user-context')

module.exports = async (req, res) => {
  if (applyCors(req, res, { methods: 'GET,POST,OPTIONS' })) return

  const auth = await requireAuth(req, res)
  if (!auth) return

  if (req.method === 'GET') {
    let data, error

    // Try a rich SELECT first, fall back to a leaner one if newer columns
    // (rfq_group_id, total_amount_php, confirmed_at, fulfilled_at, order_notes)
    // don't exist yet on this database.
    const RICH_COLS = 'id,supplier_id,products_summary,message,weekly_volume,status,reply,replied_at,created_at,rfq_group_id,total_amount_php,confirmed_at,fulfilled_at,order_notes'
    const LEAN_COLS = 'id,supplier_id,products_summary,message,weekly_volume,status,reply,replied_at,created_at'
    const fetchBuyerQuotes = async (bid) => {
      let r = await supabaseAdmin.from('quote_requests').select(RICH_COLS)
        .eq('buyer_business_id', bid).order('created_at', { ascending: false })
      if (r.error && /column .*does not exist|Could not find/i.test(r.error.message || '')) {
        r = await supabaseAdmin.from('quote_requests').select(LEAN_COLS)
          .eq('buyer_business_id', bid).order('created_at', { ascending: false })
      }
      return r
    }

    if (auth.profile.role === 'buyer' || auth.profile.role === 'business') {
      const { data: biz } = await supabaseAdmin
        .from('businesses').select('id').eq('contact_email', auth.user.email).single()

      if (!biz) {
        const org = await resolveBusinessMembership(supabaseAdmin, auth.user.id, auth.user.email)
        if (!org?.business_id) return res.status(200).json([])
        ;({ data, error } = await fetchBuyerQuotes(org.business_id))
      } else {
        ;({ data, error } = await fetchBuyerQuotes(biz.id))
      }

    } else if (auth.profile.role === 'supplier') {
      const org = await resolveSupplierMembership(supabaseAdmin, auth.user.id, auth.user.email)
      if (!org?.supplier_id) return res.status(200).json([])
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
      const org = await resolveBusinessMembership(supabaseAdmin, auth.user.id, auth.user.email)
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
      const { data: supplier } = await supabaseAdmin.from('suppliers').select('name,contact_phone').eq('id', supplier_id).single()
      const { data: supplierMember } = await supabaseAdmin.from('organization_members').select('user_id').eq('supplier_id', supplier_id).limit(1).maybeSingle()
      if (supplierMember?.user_id) {
        const { data: sp } = await supabaseAdmin.from('profiles').select('email').eq('id', supplierMember.user_id).single()
        if (sp?.email) {
          const tpl = quoteReceivedEmail({ supplierName: supplier?.name, buyerName: buyerName || auth.user.email, products: products_summary || '', message })
          await sendEmail({ to: sp.email, ...tpl })
        }
      }
      notify({ event: 'quote_received', to: supplier?.contact_phone, data: { buyerName: buyerName || 'A buyer', products: products_summary || '' } })
    } catch(e) { console.error('Email error:', e.message) }

    return res.status(201).json({ id: quote.id, message: 'Quote request sent' })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
