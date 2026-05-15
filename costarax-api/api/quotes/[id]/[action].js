const { supabaseAdmin, requireAuth } = require('../../../lib/supabase-admin')
const { sendEmail, quoteRepliedEmail, orderConfirmedEmail, orderFulfilledEmail } = require('../../../lib/email')

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

  const { id, action } = req.query

  // ── CANCEL / DECLINE ──────────────────────────────────────────────────────
  if (action === 'cancel') {
    const { data: quote } = await supabaseAdmin
      .from('quote_requests').select('buyer_business_id, supplier_id, status').eq('id', id).single()
    if (!quote) return res.status(404).json({ error: 'Quote not found' })

    if (auth.profile.role === 'buyer' || auth.profile.role === 'business') {
      const { data: biz } = await supabaseAdmin
        .from('businesses').select('id').eq('contact_email', auth.user.email).single()
      if (!biz || biz.id !== quote.buyer_business_id) return res.status(403).json({ error: 'Not authorized' })
    } else if (auth.profile.role === 'supplier') {
      const { data: org } = await supabaseAdmin
        .from('organization_members').select('supplier_id').eq('user_id', auth.user.id).single()
      if (!org || org.supplier_id !== quote.supplier_id) return res.status(403).json({ error: 'Not authorized' })
    }

    const { error } = await supabaseAdmin.from('quote_requests').update({ status: 'cancelled' }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ message: 'Quote cancelled' })
  }

  // ── REPLY ─────────────────────────────────────────────────────────────────
  if (action === 'reply') {
    if (!['supplier', 'admin'].includes(auth.profile.role)) return res.status(403).json({ error: 'Supplier access required' })

    const { reply } = req.body || {}
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
      await sendEmail({ to: buyerEmail, ...tpl }).catch(e => console.log('Email error:', e.message))
    }
    return res.status(200).json({ message: 'Reply sent' })
  }

  // ── CONFIRM ───────────────────────────────────────────────────────────────
  if (action === 'confirm') {
    if (!['buyer', 'business', 'admin'].includes(auth.profile.role)) return res.status(403).json({ error: 'Buyer access required' })

    const { order_notes } = req.body || {}

    const { data: quote, error: qErr } = await supabaseAdmin
      .from('quote_requests').select('*,businesses(name,contact_email),suppliers(name)').eq('id', id).single()
    if (qErr || !quote) return res.status(404).json({ error: 'Quote not found' })
    if (quote.status !== 'replied') return res.status(400).json({ error: 'Quote must be in replied status to confirm' })

    if (auth.profile.role !== 'admin') {
      let buyerBusinessId = null
      const { data: biz } = await supabaseAdmin.from('businesses').select('id').eq('contact_email', auth.user.email).single()
      if (biz) { buyerBusinessId = biz.id } else {
        const { data: org } = await supabaseAdmin.from('organization_members').select('business_id').eq('user_id', auth.user.id).single()
        buyerBusinessId = org?.business_id || null
      }
      if (!buyerBusinessId || buyerBusinessId !== quote.buyer_business_id) return res.status(403).json({ error: 'Not authorized' })
    }

    const { error } = await supabaseAdmin.from('quote_requests').update({
      status: 'confirmed', confirmed_at: new Date().toISOString(), order_notes: order_notes?.trim() || null
    }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })

    try {
      const { data: supplierMember } = await supabaseAdmin.from('organization_members').select('user_id').eq('supplier_id', quote.supplier_id).single()
      if (supplierMember?.user_id) {
        const { data: sp } = await supabaseAdmin.from('profiles').select('email').eq('id', supplierMember.user_id).single()
        if (sp?.email) {
          const tpl = orderConfirmedEmail({ supplierName: quote.suppliers?.name, buyerName: quote.businesses?.name, orderNotes: order_notes?.trim() || null })
          await sendEmail({ to: sp.email, ...tpl })
        }
      }
    } catch (e) { console.log('Email error:', e.message) }

    return res.status(200).json({ message: 'Order confirmed' })
  }

  // ── FULFILL ───────────────────────────────────────────────────────────────
  if (action === 'fulfill') {
    if (!['supplier', 'admin'].includes(auth.profile.role)) return res.status(403).json({ error: 'Supplier access required' })

    const { data: quote, error: qErr } = await supabaseAdmin
      .from('quote_requests').select('*,businesses(name,contact_email),suppliers(name)').eq('id', id).single()
    if (qErr || !quote) return res.status(404).json({ error: 'Quote not found' })
    if (quote.status !== 'confirmed') return res.status(400).json({ error: 'Quote must be confirmed before marking fulfilled' })

    if (auth.profile.role !== 'admin') {
      const { data: org } = await supabaseAdmin.from('organization_members').select('supplier_id').eq('user_id', auth.user.id).single()
      if (!org || org.supplier_id !== quote.supplier_id) return res.status(403).json({ error: 'Not authorized' })
    }

    const { error } = await supabaseAdmin.from('quote_requests').update({
      status: 'fulfilled', fulfilled_at: new Date().toISOString()
    }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })

    try {
      const buyerEmail = quote.businesses?.contact_email
      if (buyerEmail) {
        const tpl = orderFulfilledEmail({ buyerName: quote.businesses?.name, supplierName: quote.suppliers?.name, products: quote.products_summary })
        await sendEmail({ to: buyerEmail, ...tpl })
      }
    } catch (e) { console.log('Email error:', e.message) }

    return res.status(200).json({ message: 'Order marked as fulfilled' })
  }

  // ── REVIEW ────────────────────────────────────────────────────────────────
  if (action === 'review') {
    if (!['buyer', 'business', 'admin'].includes(auth.profile.role)) return res.status(403).json({ error: 'Buyer access required' })

    const { order_rating, delivery_rating, comment } = req.body || {}
    const or = parseInt(order_rating), dr = parseInt(delivery_rating)
    if (!or || or < 1 || or > 5) return res.status(400).json({ error: 'Order rating must be between 1 and 5' })
    if (!dr || dr < 1 || dr > 5) return res.status(400).json({ error: 'Delivery rating must be between 1 and 5' })

    const { data: quote } = await supabaseAdmin
      .from('quote_requests').select('buyer_business_id, supplier_id, status').eq('id', id).single()
    if (!quote) return res.status(404).json({ error: 'Quote not found' })
    if (quote.status !== 'fulfilled') return res.status(400).json({ error: 'Order must be fulfilled to leave a review' })

    if (auth.profile.role !== 'admin') {
      let buyerBusinessId = null
      const { data: biz } = await supabaseAdmin.from('businesses').select('id').eq('contact_email', auth.user.email).single()
      if (biz) { buyerBusinessId = biz.id } else {
        const { data: org } = await supabaseAdmin.from('organization_members').select('business_id').eq('user_id', auth.user.id).single()
        buyerBusinessId = org?.business_id || null
      }
      if (!buyerBusinessId || buyerBusinessId !== quote.buyer_business_id) return res.status(403).json({ error: 'Not authorized' })
    }

    const avgRating = Math.round((or + dr) / 2)
    const { error } = await supabaseAdmin.from('reviews').upsert({
      quote_id: id,
      buyer_business_id: quote.buyer_business_id,
      supplier_id: quote.supplier_id,
      rating: avgRating,
      order_rating: or,
      delivery_rating: dr,
      comment: comment?.trim() || null
    }, { onConflict: 'quote_id' })

    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ message: 'Review submitted' })
  }

  return res.status(404).json({ error: 'Unknown action' })
}
