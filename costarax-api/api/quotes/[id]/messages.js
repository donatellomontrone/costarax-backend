const { supabaseAdmin, requireAuth } = require('../../../lib/supabase-admin')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

async function getCallerQuoteAccess(auth, quoteId) {
  const { data: quote } = await supabaseAdmin
    .from('quote_requests').select('buyer_business_id,supplier_id').eq('id', quoteId).single()
  if (!quote) return { quote: null, allowed: false }

  const role = auth.profile.role
  if (role === 'admin') return { quote, allowed: true }

  if (role === 'buyer' || role === 'business') {
    const { data: biz } = await supabaseAdmin
      .from('businesses').select('id').eq('contact_email', auth.user.email).single()
    let bid = biz?.id
    if (!bid) {
      const { data: org } = await supabaseAdmin
        .from('organization_members').select('business_id').eq('user_id', auth.user.id).single()
      bid = org?.business_id
    }
    return { quote, allowed: !!bid && bid === quote.buyer_business_id }
  }

  if (role === 'supplier') {
    const { data: org } = await supabaseAdmin
      .from('organization_members').select('supplier_id').eq('user_id', auth.user.id).single()
    return { quote, allowed: !!org && org.supplier_id === quote.supplier_id }
  }

  return { quote, allowed: false }
}

module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()

  const auth = await requireAuth(req, res)
  if (!auth) return

  const { id } = req.query
  const { quote, allowed } = await getCallerQuoteAccess(auth, id)
  if (!quote) return res.status(404).json({ error: 'Quote not found' })
  if (!allowed) return res.status(403).json({ error: 'Not authorized' })

  // GET — load all messages
  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('quote_messages')
      .select('id,sender_type,sender_name,text,created_at')
      .eq('quote_id', id)
      .order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data || [])
  }

  // POST — save a new message
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
    const { sender_type, sender_name, text } = body

    if (!['buyer', 'supplier'].includes(sender_type)) return res.status(400).json({ error: 'Invalid sender_type' })
    if (!text?.trim()) return res.status(400).json({ error: 'Text is required' })

    const { data, error } = await supabaseAdmin
      .from('quote_messages')
      .insert({ quote_id: id, sender_type, sender_name: sender_name || null, text: text.trim() })
      .select('id,sender_type,sender_name,text,created_at')
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
