const { supabaseAdmin, requireAdmin } = require('../../supabase-admin')
const { sendEmail, welcomeInviteEmail } = require('../../email')

// Same helper used by access-requests-action — create the auth user and
// generate a one-time set-password link without triggering the Supabase
// default invite email.
async function createUserWithBrandedInvite({ email, role, companyName }) {
  const lower = String(email || '').trim().toLowerCase()
  if (!lower) throw new Error('Email is required')
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email: lower, email_confirm: true,
    user_metadata: { role, company: companyName || null }
  })
  if (createErr && !/already (registered|exists)|duplicate/i.test(createErr.message || '')) {
    throw new Error(`createUser failed: ${createErr.message}`)
  }
  let userId = created?.user?.id || null
  if (!userId) {
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    userId = (list?.users || []).find(u => (u.email || '').toLowerCase() === lower)?.id || null
  }
  if (!userId) throw new Error('Could not resolve auth user id after createUser')
  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: 'recovery', email: lower,
    options: { redirectTo: 'https://costarax.com/login.html' }
  })
  if (linkErr) throw new Error(`generateLink failed: ${linkErr.message}`)
  let link = linkData?.properties?.action_link || linkData?.action_link || null
  if (link) {
    try { const u = new URL(link); u.searchParams.set('redirect_to', 'https://costarax.com/login.html'); link = u.toString() } catch (_) {}
  }
  return { userId, link }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAdmin(req, res)
  if (!auth) return

  const { id, action } = req.query

  // ── APPROVE ───────────────────────────────────────────────────────────────
  if (action === 'approve') {
    const { data: biz } = await supabaseAdmin.from('businesses').select('name,contact_email,status').eq('id', id).maybeSingle()
    if (!biz) return res.status(404).json({ error: 'Business not found' })
    if (biz.status === 'approved') return res.status(400).json({ error: 'Already approved' })

    const { error } = await supabaseAdmin.from('businesses').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })

    // Branded invite flow — replaces Supabase's default invite email.
    let inviteSent = false
    let userId = null
    let inviteLink = null
    if (biz.contact_email) {
      try {
        const r = await createUserWithBrandedInvite({
          email: biz.contact_email, role: 'buyer', companyName: biz.name
        })
        userId = r.userId
        inviteLink = r.link
        inviteSent = !!inviteLink
      } catch (e) {
        // Soft-fail: log but don't undo the approval — the admin can
        // manually re-send from Users tab as a recovery path.
        console.warn('[approve-business] branded invite failed:', biz.contact_email, e.message)
      }

      if (userId) {
        try {
          await supabaseAdmin.from('profiles').upsert({
            id: userId, email: biz.contact_email, role: 'buyer', status: 'approved'
          })
        } catch (e) { console.warn('[approve-business] profile upsert failed:', e.message) }
        try {
          await supabaseAdmin.from('organization_members').insert({
            user_id: userId, business_id: id
          })
        } catch (e) { console.warn('[approve-business] org_members insert failed:', e.message) }
      }
    }

    await supabaseAdmin.from('admin_actions').insert({
      admin_id: auth.user.id, action_type: 'approve_business', target_id: id,
      notes: `Approved: ${biz.name}${inviteSent ? ' · branded invite sent' : ' · no invite (no email or invite failed)'}`
    })

    // Single branded welcome email with set-password link.
    if (biz.contact_email && inviteSent) {
      const tpl = welcomeInviteEmail({
        companyName: biz.name,
        contactEmail: biz.contact_email,
        role: 'buyer',
        inviteLink
      })
      await sendEmail({ to: biz.contact_email, ...tpl })
    }
    return res.status(200).json({ message: `${biz.name} approved${inviteSent ? ' (welcome email sent)' : ''}`, inviteSent })
  }

  // ── REJECT ────────────────────────────────────────────────────────────────
  if (action === 'reject') {
    const { data: biz } = await supabaseAdmin.from('businesses').select('name').eq('id', id).maybeSingle()
    if (!biz) return res.status(404).json({ error: 'Business not found' })

    const { error } = await supabaseAdmin.from('businesses').update({ status: 'rejected' }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })

    await supabaseAdmin.from('admin_actions').insert({ admin_id: auth.user.id, action_type: 'reject_business', target_id: id, notes: `Rejected: ${biz.name}` })
    return res.status(200).json({ message: `${biz.name} rejected` })
  }

  return res.status(404).json({ error: 'Unknown action' })
}
