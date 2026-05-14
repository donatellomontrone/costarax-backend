const { supabaseAdmin, requireAuth } = require('../../../lib/supabase-admin')
const { sendEmail, quoteRepliedEmail } = require('../../../lib/email')

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAuth(req, res)
  if (!auth) return
  if (!['supplier', 'admin'].includes(auth.profile.role)) return res.status(403).json({ error: 'Supplier access required' })

  const { id } = req.query
  const { reply } = req.body
  if (!reply?.trim()) return res.status(400).json({ error: 'Reply text is required' })

  const { data: quote, error: qErr } = await supabaseAdmin
    .from('quote_requests').select('*,businesses(name,contact_email),suppliers(name)').eq('id', id).single()
  if (qErr || !quote) return res.status(404).json({ error: 'Quote not found' })

  const { error } = await supabaseAdmin.from('quote_requests').update({
    reply: reply.trim(), status: 'replied', replied_at: new Date().toISOString()
  }).eq('id', id)
  if (error) return res.status(500).json({ error: error.message })

  const buyerEmail = quote.businesses?.contact_email
  if (buyerEmail) {
    const tpl = quoteRepliedEmail({ buyerName: quote.businesses?.name, supplierName: quote.suppliers?.name, reply: reply.trim() })
    await sendEmail({ to: buyerEmail, ...tpl })
  }

  return res.status(200).json({ message: 'Reply sent' })
}
