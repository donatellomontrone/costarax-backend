// /api/businesses
//
// Public buyer-side endpoint. Mirrors /api/suppliers?mine=1 for the buyer
// flow: when the frontend's direct supabase-client query against
// organization_members is blocked by RLS for a freshly-approved buyer,
// it falls back here to get its own businesses row. Without this,
// buyers with a working session can end up without a buyerBusinessId
// and silently lose the ability to send RFQs or view their quotes.
//
// Future-proofed for an admin "list all businesses" call too — but
// /api/admin/businesses already handles that and is kept as the
// canonical admin route. This endpoint only serves the `mine=1` case
// today.

const { supabaseAdmin, verifyToken } = require('../lib/supabase-admin')
const { applyCors } = require('../lib/cors')
const { resolveBusinessMembership } = require('../lib/user-context')

module.exports = async (req, res) => {
  try {
    if (applyCors(req, res, { methods: 'GET,OPTIONS' })) return
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    const token = req.headers.authorization?.replace('Bearer ', '')
    const user = await verifyToken(token)
    if (!user) return res.status(401).json({ error: 'Unauthorized' })

    // Only `mine=1` is supported today. Buyers don't need a public list
    // of other buyer organisations (that's what suppliers and the admin
    // dashboard are for).
    if (req.query?.mine !== '1') {
      return res.status(400).json({ error: 'Pass ?mine=1' })
    }

    // Try resolving the buyer's business via organization_members first
    // (works when the user was approved via the proper flow). Fall back
    // to email-match on the businesses table for legacy records that
    // were imported without an org_members row.
    let businessId = null
    try {
      const org = await resolveBusinessMembership(supabaseAdmin, user.id, user.email)
      businessId = org?.business_id || null
    } catch (_) {}

    if (!businessId && user.email) {
      const { data: byEmail } = await supabaseAdmin
        .from('businesses')
        .select('id')
        .eq('contact_email', user.email.toLowerCase())
        .maybeSingle()
      businessId = byEmail?.id || null
    }

    if (!businessId) return res.status(404).json({ error: 'No business linked to this user' })

    const { data: business, error } = await supabaseAdmin
      .from('businesses')
      .select('id,name,business_type,tin,city,region,contact_email,contact_phone,status,approved_at,created_at')
      .eq('id', businessId)
      .maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!business) return res.status(404).json({ error: 'Business record not found' })

    return res.status(200).json(business)
  } catch (e) {
    console.error('[businesses] unhandled error:', e.message)
    return res.status(500).json({ error: 'Internal server error', detail: e.message })
  }
}
