const crypto = require('crypto')
const { supabaseAdmin, requireAuth } = require('../../lib/supabase-admin')
const { sendEmail, quoteReceivedEmail } = require('../../lib/email')

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

module.exports = async (req, res) => {
  try {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
    if (req.method === 'OPTIONS') return res.status(200).end()
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const auth = await requireAuth(req, res)
    if (!auth) return

    const { supplier_ids, products_summary, message, weekly_volume } = req.body || {}
    if (!Array.isArray(supplier_ids) || supplier_ids.length === 0) {
      return res.status(400).json({ error: 'supplier_ids must be a non-empty array' })
    }
    if (supplier_ids.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 suppliers per RFQ' })
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required' })
    }

    // Resolve buyer business id (same logic as POST /api/quotes)
    let buyerBusinessId = null, buyerName = null
    const { data: biz } = await supabaseAdmin
      .from('businesses').select('id,name').eq('contact_email', auth.user.email).single()
    if (biz) { buyerBusinessId = biz.id; buyerName = biz.name }
    else {
      const { data: org } = await supabaseAdmin
        .from('organization_members').select('business_id').eq('user_id', auth.user.id).single()
      if (org?.business_id) {
        buyerBusinessId = org.business_id
        const { data: b } = await supabaseAdmin.from('businesses').select('name').eq('id', org.business_id).single()
        buyerName = b?.name
      }
    }
    if (!buyerBusinessId) return res.status(400).json({ error: 'No business associated with this account' })

    // Dedupe supplier ids and verify they all exist + are active
    const uniqueSupIds = [...new Set(supplier_ids.filter(Boolean))]
    const { data: validSuppliers } = await supabaseAdmin
      .from('suppliers').select('id, name').in('id', uniqueSupIds).eq('active', true).eq('status', 'approved')
    if (!validSuppliers || validSuppliers.length === 0) {
      return res.status(400).json({ error: 'No active suppliers found among the provided IDs' })
    }

    const rfqGroupId = crypto.randomUUID()
    const rows = validSuppliers.map(s => ({
      buyer_business_id: buyerBusinessId,
      supplier_id: s.id,
      requested_by: auth.user.id,
      products_summary: products_summary || null,
      message: message.trim(),
      weekly_volume: weekly_volume || null,
      status: 'sent',
      rfq_group_id: rfqGroupId
    }))

    let { data: inserted, error } = await supabaseAdmin
      .from('quote_requests').insert(rows).select('id, supplier_id')
    // Graceful fallback when rfq_group_id column doesn't exist yet
    if (error && /column .*rfq_group_id.* does not exist/i.test(error.message)) {
      const fallbackRows = rows.map(({ rfq_group_id, ...rest }) => rest)
      const retry = await supabaseAdmin.from('quote_requests').insert(fallbackRows).select('id, supplier_id')
      inserted = retry.data; error = retry.error
      if (!error) {
        // Return success but warn
        await sendNotifications(inserted, validSuppliers, products_summary, message, buyerName, auth.user.email)
        return res.status(201).json({
          rfq_group_id: null,
          sent_to: inserted.length,
          warning: 'rfq_group_id column missing — run migrations/rfq_group.sql in Supabase to enable RFQ comparison view'
        })
      }
    }
    if (error) return res.status(500).json({ error: error.message })

    // Fire-and-forget email notifications to each supplier
    sendNotifications(inserted, validSuppliers, products_summary, message, buyerName, auth.user.email)

    return res.status(201).json({
      rfq_group_id: rfqGroupId,
      sent_to: inserted.length,
      message: `RFQ sent to ${inserted.length} supplier${inserted.length !== 1 ? 's' : ''}`
    })
  } catch (fatalErr) {
    console.error('[rfq] Unhandled error:', fatalErr.message)
    return res.status(500).json({ error: 'Internal server error', detail: fatalErr.message })
  }
}

async function sendNotifications(inserted, validSuppliers, products_summary, message, buyerName, buyerEmail) {
  const supMap = Object.fromEntries(validSuppliers.map(s => [s.id, s.name]))
  await Promise.allSettled((inserted || []).map(async (q) => {
    try {
      const { data: supplierMember } = await supabaseAdmin.from('organization_members')
        .select('user_id').eq('supplier_id', q.supplier_id).single()
      if (supplierMember?.user_id) {
        const { data: sp } = await supabaseAdmin.from('profiles').select('email').eq('id', supplierMember.user_id).single()
        if (sp?.email) {
          const tpl = quoteReceivedEmail({
            supplierName: supMap[q.supplier_id],
            buyerName: buyerName || buyerEmail,
            products: products_summary || '',
            message
          })
          await sendEmail({ to: sp.email, ...tpl })
        }
      }
    } catch (e) { console.error('RFQ notify error:', e.message) }
  }))
}
