const { supabaseAdmin, requireAuth } = require('../../../lib/supabase-admin')
const { applyCors } = require('../../../lib/cors')
const { resolveBusinessMembership, resolveSupplierMembership } = require('../../../lib/user-context')

async function getCallerQuoteAccess(auth, quoteId) {
  const { data: quote } = await supabaseAdmin
    .from('quote_requests').select('buyer_business_id,supplier_id').eq('id', quoteId).single()
  if (!quote) return { quote: null, allowed: false }

  const role = auth.profile.role
  if (role === 'admin') return { quote, allowed: true }

  if (role === 'buyer' || role === 'business') {
    const { data: biz } = await supabaseAdmin
      .from('businesses').select('id').eq('contact_email', auth.user.email).maybeSingle()
    let bid = biz?.id
    if (!bid) {
      const org = await resolveBusinessMembership(supabaseAdmin, auth.user.id, auth.user.email)
      bid = org?.business_id
    }
    return { quote, allowed: !!bid && bid === quote.buyer_business_id }
  }

  if (role === 'supplier') {
    const org = await resolveSupplierMembership(supabaseAdmin, auth.user.id, auth.user.email)
    return { quote, allowed: !!org && org.supplier_id === quote.supplier_id }
  }

  return { quote, allowed: false }
}

module.exports = async (req, res) => {
  if (applyCors(req, res, { methods: 'GET,POST,OPTIONS' })) return

  const auth = await requireAuth(req, res)
  if (!auth) return

  const { id } = req.query
  const { quote, allowed } = await getCallerQuoteAccess(auth, id)
  if (!quote) return res.status(404).json({ error: 'Quote not found' })
  if (!allowed) return res.status(403).json({ error: 'Not authorized' })

  // GET — load all messages for this quote
  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('quote_messages')
      .select('id,sender_role,sender_profile_id,body,created_at,profiles(full_name,email)')
      .eq('quote_request_id', id)
      .order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data || [])
  }

  // POST — save a new message (sender determined from auth context)
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
    const text = body.text?.trim() || body.body?.trim()
    if (!text) return res.status(400).json({ error: 'Text is required' })

    const senderRole = auth.profile.role === 'admin' ? 'admin'
      : (auth.profile.role === 'supplier' ? 'supplier' : 'buyer')

    const { data, error } = await supabaseAdmin
      .from('quote_messages')
      .insert({
        quote_request_id: id,
        sender_profile_id: auth.user.id,
        sender_role: senderRole,
        body: text
      })
      .select('id,sender_role,sender_profile_id,body,created_at,profiles(full_name,email)')
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
