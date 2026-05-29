const { supabaseAdmin, requireAdmin } = require('../../supabase-admin')
const { sendEmail, accessApprovedEmail, welcomeInviteEmail } = require('../../email')

// Create the auth user + generate a one-time set-password link WITHOUT
// triggering Supabase's default invite email. Returns { userId, link }.
// Falls back gracefully if any step fails — the caller decides whether
// to revert the access_request claim.
async function createUserWithBrandedInvite({ email, role, companyName }) {
  const lower = String(email || '').trim().toLowerCase()
  if (!lower) throw new Error('Email is required')

  // 1) Create auth user. email_confirm: true skips Supabase's "confirm
  //    your email" verification mail — we trust admin's approval.
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email: lower,
    email_confirm: true,
    user_metadata: { role, company: companyName || null }
  })
  if (createErr) {
    // If the user already exists (e.g. a previous failed approval), look
    // them up and continue with a recovery link instead.
    const isDuplicate = /already (registered|exists)|duplicate/i.test(createErr.message || '')
    if (!isDuplicate) throw new Error(`createUser failed: ${createErr.message}`)
  }
  let userId = created?.user?.id || null
  if (!userId) {
    // Recover existing user id by listing — Supabase doesn't expose a
    // getUserByEmail admin helper, so we paginate. Tier 1 cap should be
    // < 1000 users for a long time.
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    const match = (list?.users || []).find(u => (u.email || '').toLowerCase() === lower)
    userId = match?.id || null
  }
  if (!userId) throw new Error('Could not resolve auth user id after createUser')

  // 2) Generate a recovery link (used as both "set initial password" and
  //    "reset password" — the destination panel on login.html is the same).
  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: 'recovery',
    email: lower,
    options: { redirectTo: 'https://costarax.com/login.html' }
  })
  if (linkErr) throw new Error(`generateLink failed: ${linkErr.message}`)
  let link = linkData?.properties?.action_link || linkData?.action_link || null
  if (link) {
    try {
      const u = new URL(link)
      u.searchParams.set('redirect_to', 'https://costarax.com/login.html')
      link = u.toString()
    } catch (_) {}
  }
  return { userId, link }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAdmin(req, res)
  if (!auth) return

  const { id, action } = req.query

  // Atomic claim — race-safe against double-click without needing a new
  // enum value. The access_requests.status column has a restrictive enum
  // (pending / approved / rejected) so we can't park it in an
  // intermediate 'processing' state. Instead we claim by jumping directly
  // to the FINAL status (approved or rejected) using a conditional UPDATE
  // that only succeeds if status is still 'pending'. Postgres guarantees
  // exactly ONE concurrent request wins this update — the other gets
  // zero rows back and exits with 409 'Already processed'.
  //
  // If the downstream work (supplier creation, invite email) then fails,
  // we revert the row back to 'pending' so the admin can retry. The
  // (tiny) failure window is: row flipped to approved, but reverting it
  // back also fails. In that case the admin would see an approved
  // access_request without a supplier — a known oddity worth a manual
  // cleanup, but no data corruption and no duplicates.
  const targetStatus = action === 'reject' ? 'rejected' : 'approved'
  const { data: claimedRows, error: claimErr } = await supabaseAdmin
    .from('access_requests')
    .update({
      status: targetStatus,
      reviewed_at: new Date().toISOString(),
      reviewed_by: auth.user.id
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select('*')

  if (claimErr) return res.status(500).json({ error: `Could not claim request: ${claimErr.message}` })
  if (!claimedRows || claimedRows.length === 0) {
    // Either id doesn't exist OR another request already claimed it.
    const { data: existing } = await supabaseAdmin
      .from('access_requests').select('status').eq('id', id).maybeSingle()
    if (!existing) return res.status(404).json({ error: 'Access request not found' })
    return res.status(409).json({ error: `Already ${existing.status}` })
  }
  const request = claimedRows[0]

  // Helper to revert the claim back to 'pending' if downstream creation
  // fails — without this, a partially-failed approve leaves the row
  // stuck in 'approved' state without a supplier/business and the admin
  // can't retry.
  const revertClaim = async () => {
    await supabaseAdmin.from('access_requests')
      .update({ status: 'pending', reviewed_at: null, reviewed_by: null })
      .eq('id', id).eq('status', targetStatus)
      .catch(() => {})
  }

  // ── REJECT ────────────────────────────────────────────────────────────────
  if (action === 'reject') {
    // Status already set to 'rejected' by the atomic claim above.
    await supabaseAdmin.from('admin_actions').insert({
      admin_id: auth.user.id, action_type: 'reject_access_request',
      target_id: id, notes: `Rejected: ${request.company_name}`
    })
    return res.status(200).json({ message: `${request.company_name} rejected` })
  }

  // ── APPROVE ───────────────────────────────────────────────────────────────
  if (action === 'approve') {
    const isSupplier = request.requested_role === 'supplier'

    if (isSupplier) {
      const CATEGORY_MAP = {
        produce: 'produce', seafood: 'seafood', meat: 'meat',
        dairy: 'dairy', dry_goods: 'dry_goods', beverages: 'beverages'
      }
      const supplierCategory = CATEGORY_MAP[request.business_type] || 'general'

      const { data: supplier, error: supErr } = await supabaseAdmin.from('suppliers').insert({
        name: request.company_name, legal_name: request.company_name,
        category: supplierCategory,
        tagline: `${request.business_type || 'Supplier'} — Philippines`,
        city: request.city || null, region: request.region || null,
        tin: request.tin || null, contact_phone: request.contact_phone || null,
        minimum_order_php: 1000, verified: false, active: false,
        status: 'approved', rating: 5.0, review_count: 0
      }).select('id').single()

      if (supErr) { await revertClaim(); return res.status(500).json({ error: `Supplier creation failed: ${supErr.message}` }) }

      // Branded invite flow (replaces Supabase's default invite email).
      let userId = null
      let inviteLink = null
      try {
        const r = await createUserWithBrandedInvite({
          email: request.contact_email, role: 'supplier', companyName: request.company_name
        })
        userId = r.userId
        inviteLink = r.link
      } catch (e) {
        console.error('Branded invite failed for supplier:', request.contact_email, e.message)
        // Roll back the supplier we just created so a retry doesn't dup it
        await supabaseAdmin.from('suppliers').delete().eq('id', supplier.id).catch(() => {})
        await revertClaim()
        return res.status(500).json({ error: `Invite failed: ${e.message}. Please retry or check the email address.` })
      }

      if (userId) {
        await supabaseAdmin.from('profiles').upsert({
          id: userId, email: request.contact_email, role: 'supplier', status: 'approved'
        })
        await supabaseAdmin.from('organization_members').insert({
          user_id: userId, supplier_id: supplier.id
        })
      }

      // Note: access_requests.status was already set to 'approved' (with
      // reviewed_at + reviewed_by) by the atomic claim at the top of this
      // handler.
      await supabaseAdmin.from('admin_actions').insert({
        admin_id: auth.user.id, action_type: 'approve_supplier_request',
        target_id: supplier.id,
        notes: `Approved supplier: ${request.company_name} (${request.contact_email})`
      })

      // Send our branded welcome email with the set-password link. This
      // is the SINGLE email the supplier should receive — there's also
      // the legacy accessApprovedEmail confirmation; drop it to avoid
      // sending two consecutive "approved" emails.
      if (request.contact_email) {
        const tpl = welcomeInviteEmail({
          companyName: request.company_name,
          contactEmail: request.contact_email,
          role: 'supplier',
          inviteLink
        })
        await sendEmail({ to: request.contact_email, ...tpl })
      }

      return res.status(200).json({
        message: `${request.company_name} approved as supplier. Welcome email sent.`,
        supplier_id: supplier.id
      })

    } else {
      const { data: biz, error: bizErr } = await supabaseAdmin.from('businesses').insert({
        name: request.company_name, business_type: request.business_type || 'Business',
        tin: request.tin || null, city: request.city || null, region: request.region || null,
        contact_email: request.contact_email, contact_phone: request.contact_phone || null,
        status: 'approved', approved_at: new Date().toISOString()
      }).select('id').single()

      if (bizErr) { await revertClaim(); return res.status(500).json({ error: `Business creation failed: ${bizErr.message}` }) }

      let userId = null
      let inviteLink = null
      try {
        const r = await createUserWithBrandedInvite({
          email: request.contact_email, role: 'buyer', companyName: request.company_name
        })
        userId = r.userId
        inviteLink = r.link
      } catch (e) {
        console.error('Branded invite failed for buyer:', request.contact_email, e.message)
        await supabaseAdmin.from('businesses').delete().eq('id', biz.id).catch(() => {})
        await revertClaim()
        return res.status(500).json({ error: `Invite failed: ${e.message}. Please retry or check the email address.` })
      }

      if (userId) {
        await supabaseAdmin.from('profiles').upsert({
          id: userId, email: request.contact_email, role: 'buyer', status: 'approved'
        })
        await supabaseAdmin.from('organization_members').insert({
          user_id: userId, business_id: biz.id
        })
      }

      // Already set to 'approved' by the atomic claim above.
      await supabaseAdmin.from('admin_actions').insert({
        admin_id: auth.user.id, action_type: 'approve_buyer_request',
        target_id: biz.id, notes: `Approved buyer: ${request.company_name}`
      })

      // Single branded welcome email (replaces both the Supabase default
      // invite and the legacy accessApprovedEmail).
      if (request.contact_email) {
        const tpl = welcomeInviteEmail({
          companyName: request.company_name,
          contactEmail: request.contact_email,
          role: 'buyer',
          inviteLink
        })
        await sendEmail({ to: request.contact_email, ...tpl })
      }

      return res.status(200).json({ message: `${request.company_name} approved as buyer. Welcome email sent.`, business_id: biz.id })
    }
  }

  return res.status(404).json({ error: 'Unknown action' })
}
