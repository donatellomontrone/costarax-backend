const crypto = require('crypto')
const { supabaseAdmin, requireAuth } = require('../../lib/supabase-admin')
const { sendEmail, quoteReceivedEmail } = require('../../lib/email')
const { applyCors } = require('../../lib/cors')

module.exports = async (req, res) => {
  try {
    if (applyCors(req, res, { methods: 'POST,OPTIONS' })) return
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const auth = await requireAuth(req, res)
    if (!auth) return

    const { supplier_ids, products_summary, message, weekly_volume, items_by_supplier } = req.body || {}

    // Determine mode: "same" (supplier_ids + message) or "basket" (items_by_supplier dict)
    const isBasket = items_by_supplier && typeof items_by_supplier === 'object' && !Array.isArray(items_by_supplier)
    let effectiveSupIds = []
    if (isBasket) {
      effectiveSupIds = Object.keys(items_by_supplier).filter(Boolean)
      if (effectiveSupIds.length === 0) {
        return res.status(400).json({ error: 'items_by_supplier must have at least one supplier entry' })
      }
    } else {
      if (!Array.isArray(supplier_ids) || supplier_ids.length === 0) {
        return res.status(400).json({ error: 'supplier_ids must be a non-empty array' })
      }
      if (!message || !message.trim()) {
        return res.status(400).json({ error: 'message is required' })
      }
      effectiveSupIds = supplier_ids
    }
    if (effectiveSupIds.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 suppliers per RFQ' })
    }

    // Resolve buyer business id (same logic as POST /api/quotes)
    let buyerBusinessId = null, buyerName = null
    const { data: biz } = await supabaseAdmin
      .from('businesses').select('id,name').eq('contact_email', auth.user.email).single()
    if (biz) { buyerBusinessId = biz.id; buyerName = biz.name }
    else {
      const { data: org } = await supabaseAdmin
        .from('organization_members').select('business_id').eq('user_id', auth.user.id).maybeSingle()
      if (org?.business_id) {
        buyerBusinessId = org.business_id
        const { data: b } = await supabaseAdmin.from('businesses').select('name').eq('id', org.business_id).single()
        buyerName = b?.name
      }
    }
    if (!buyerBusinessId) return res.status(400).json({ error: 'No business associated with this account' })

    // Dedupe supplier ids and verify they all exist + are active
    const uniqueSupIds = [...new Set(effectiveSupIds.filter(Boolean))]
    const { data: validSuppliers } = await supabaseAdmin
      .from('suppliers').select('id, name').in('id', uniqueSupIds).eq('active', true).eq('status', 'approved')
    if (!validSuppliers || validSuppliers.length === 0) {
      return res.status(400).json({ error: 'No active suppliers found among the provided IDs' })
    }

    const rfqGroupId = crypto.randomUUID()
    const rows = validSuppliers.map(s => {
      if (isBasket) {
        const bucket = items_by_supplier[s.id] || {}
        const bmsg = (bucket.message || '').trim()
        if (!bmsg) {
          // Each basket entry must have its own message — skip empties
          return null
        }
        return {
          buyer_business_id: buyerBusinessId,
          supplier_id: s.id,
          requested_by: auth.user.id,
          products_summary: (bucket.products_summary || products_summary || '').slice(0, 500) || null,
          message: bmsg,
          weekly_volume: bucket.weekly_volume || weekly_volume || null,
          status: 'sent',
          rfq_group_id: rfqGroupId
        }
      }
      return {
        buyer_business_id: buyerBusinessId,
        supplier_id: s.id,
        requested_by: auth.user.id,
        products_summary: products_summary || null,
        message: message.trim(),
        weekly_volume: weekly_volume || null,
        status: 'sent',
        rfq_group_id: rfqGroupId
      }
    }).filter(Boolean)

    if (rows.length === 0) {
      return res.status(400).json({ error: 'No valid items to send — every basket entry needs a non-empty message' })
    }

    let { data: inserted, error } = await supabaseAdmin
      .from('quote_requests').insert(rows).select('id, supplier_id')
    // Graceful fallback when rfq_group_id column doesn't exist yet
    if (error && /column .*rfq_group_id.* does not exist/i.test(error.message)) {
      const fallbackRows = rows.map(({ rfq_group_id, ...rest }) => rest)
      const retry = await supabaseAdmin.from('quote_requests').insert(fallbackRows).select('id, supplier_id')
      inserted = retry.data; error = retry.error
      if (!error) {
        if (isBasket) sendNotificationsBasket(inserted, validSuppliers, items_by_supplier, buyerName, auth.user.email)
        else          sendNotifications(inserted, validSuppliers, products_summary, message, buyerName, auth.user.email)
        return res.status(201).json({
          rfq_group_id: null,
          sent_to: inserted.length,
          warning: 'rfq_group_id column missing — run migrations/rfq_group.sql in Supabase to enable RFQ comparison view'
        })
      }
    }
    if (error) return res.status(500).json({ error: error.message })

    // Fire-and-forget email notifications to each supplier — in basket mode
    // each supplier gets THEIR specific message, in same mode they all share one.
    if (isBasket) {
      sendNotificationsBasket(inserted, validSuppliers, items_by_supplier, buyerName, auth.user.email)
    } else {
      sendNotifications(inserted, validSuppliers, products_summary, message, buyerName, auth.user.email)
    }

    return res.status(201).json({
      rfq_group_id: rfqGroupId,
      sent_to: inserted.length,
      mode: isBasket ? 'basket' : 'same',
      message: isBasket
        ? `Basket order sent — ${inserted.length} separate RFQ${inserted.length !== 1 ? 's' : ''} delivered`
        : `RFQ sent to ${inserted.length} supplier${inserted.length !== 1 ? 's' : ''}`
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

// Per-supplier notifications when each supplier has a different basket
async function sendNotificationsBasket(inserted, validSuppliers, itemsBySupplier, buyerName, buyerEmail) {
  const supMap = Object.fromEntries(validSuppliers.map(s => [s.id, s.name]))
  await Promise.allSettled((inserted || []).map(async (q) => {
    try {
      const bucket = itemsBySupplier[q.supplier_id] || {}
      const { data: supplierMember } = await supabaseAdmin.from('organization_members')
        .select('user_id').eq('supplier_id', q.supplier_id).single()
      if (supplierMember?.user_id) {
        const { data: sp } = await supabaseAdmin.from('profiles').select('email').eq('id', supplierMember.user_id).single()
        if (sp?.email) {
          const tpl = quoteReceivedEmail({
            supplierName: supMap[q.supplier_id],
            buyerName: buyerName || buyerEmail,
            products: bucket.products_summary || '',
            message: bucket.message || ''
          })
          await sendEmail({ to: sp.email, ...tpl })
        }
      }
    } catch (e) { console.error('RFQ basket notify error:', e.message) }
  }))
}
