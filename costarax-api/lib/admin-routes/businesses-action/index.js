const { supabaseAdmin, requireAdmin } = require('../../supabase-admin')
const { sendEmail, accessApprovedEmail } = require('../../email')

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAdmin(req, res)
  if (!auth) return

  const { id, action } = req.query

  // ── APPROVE ───────────────────────────────────────────────────────────────
  if (action === 'approve') {
    const { data: biz } = await supabaseAdmin.from('businesses').select('name,contact_email,status').eq('id', id).single()
    if (!biz) return res.status(404).json({ error: 'Business not found' })
    if (biz.status === 'approved') return res.status(400).json({ error: 'Already approved' })

    const { error } = await supabaseAdmin.from('businesses').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })

    // Send an invite so the buyer can actually log in. Previously this
    // path only flipped status — the buyer received an approval email but
    // had no account to sign into. Now we mirror the supplier-approve
    // flow: create auth user via inviteUserByEmail, upsert profile with
    // role=buyer, and create the organization_members link.
    let inviteSent = false
    let userId = null
    if (biz.contact_email) {
      try {
        const { data: invite, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
          biz.contact_email, {
            data: { role: 'buyer', company: biz.name },
            redirectTo: 'https://costarax.com/login.html'
          }
        )
        if (inviteErr) {
          // Soft-fail: log but don't undo the approval — the admin can
          // manually invite from Users tab as a recovery path.
          console.warn('[approve-business] invite failed:', biz.contact_email, inviteErr.message)
        } else {
          inviteSent = true
          userId = invite?.user?.id || null
        }
      } catch (e) {
        console.warn('[approve-business] invite threw:', e.message)
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
      notes: `Approved: ${biz.name}${inviteSent ? ' · invite sent' : ' · no invite (no email or invite failed)'}`
    })
    if (biz.contact_email) {
      const tpl = accessApprovedEmail({ companyName: biz.name, contactEmail: biz.contact_email })
      await sendEmail({ to: biz.contact_email, ...tpl })
    }
    return res.status(200).json({ message: `${biz.name} approved${inviteSent ? ' (invite sent)' : ''}`, inviteSent })
  }

  // ── REJECT ────────────────────────────────────────────────────────────────
  if (action === 'reject') {
    const { data: biz } = await supabaseAdmin.from('businesses').select('name').eq('id', id).single()
    if (!biz) return res.status(404).json({ error: 'Business not found' })

    const { error } = await supabaseAdmin.from('businesses').update({ status: 'rejected' }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })

    await supabaseAdmin.from('admin_actions').insert({ admin_id: auth.user.id, action_type: 'reject_business', target_id: id, notes: `Rejected: ${biz.name}` })
    return res.status(200).json({ message: `${biz.name} rejected` })
  }

  return res.status(404).json({ error: 'Unknown action' })
}
