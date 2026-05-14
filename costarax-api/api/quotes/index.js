const { supabaseAdmin, requireAuth } = require('../../lib/supabase-admin')
const { sendEmail, quoteReceivedEmail } = require('../../lib/email')

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end()

  const auth = await requireAuth(req, res)
  if (!auth) return

  if (req.method === 'GET') {
    let data, error
    if (auth.profile.role === 'buyer') {
      const { data: org } = await supabaseAdmin.from('organization_members').select('business_id').eq('user_id', auth.user.id).single()
      if (!org) return res.status(200).json([]);
      ({ data, error } = await supabaseAdmin.from('quote_requests')
        .select('id,supplier_id,products_summary,message,weekly_volume,status,reply,replied_at,created_at,suppliers(name)')
        .eq('buyer_business_id', org.business_id).order('created_at', { ascending: false }))
    } else if (auth.profile.role === 'supplier') {
      const { data: org } = await supabaseAdmin.from('organization_members').select('supplier_id').eq('user_id', auth.user.id).single()
      if (!org) return res.status(200).json([]);
      ({ data, error } = await supabaseAdmin.from('quote_requests')
        .select('id,buyer_business_id,products_summary,message,weekly_volume,status,reply,replied_at,created_at,businesses(name,contact_email)')
        .eq('supplier_id', org.supplier_id).order('created_at', { ascending: false }))
    } else {
      ({ data, error } = await supabaseAdmin.from('quote_requests').select('*,businesses(name),suppliers(name)').order('created_at', { ascending: false }).limit(100))
    }
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  if (req.method === 'POST') {
    const { supplier_id, products_summary, message, weekly_volume } = req.body
    if (!supplier_id || !message) return res.status(400).json({ error: 'supplier_id and message are required' })

    const { data: org } = await supabaseAdmin.from('organization_members').select('business_id,businesses(name,contact_email)').eq('user_id', auth.user.id).single()
    if (!org?.business_id) return res.status(400).json({ error: 'No business associated with this account' })

    const { data: quote, error } = await supabaseAdmin.from('quote_requests').insert({
      buyer_business_id: org.business_id, supplier_id, requested_by: auth.user.id,
      products_summary, message, weekly_volume: weekly_volume || null, status: 'pending'
    }).select('id').single()

    if (error) return res.status(500).json({ error: error.message })

    // Email supplier
    const { data: supplier } = await supabaseAdmin.from('suppliers').select('name').eq('id', supplier_id).single()
    const { data: supplierMember } = await supabaseAdmin.from('organization_members').select('profiles(email)').eq('supplier_id', supplier_id).single()
    const supplierEmail = supplierMember?.profiles?.email
    if (supplierEmail) {
      const tpl = quoteReceivedEmail({ supplierName: supplier?.name, buyerName: org.businesses?.name || 'A verified buyer', products: products_summary || '', message })
      await sendEmail({ to: supplierEmail, ...tpl })
    }

    return res.status(201).json({ id: quote.id, message: 'Quote request sent' })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
