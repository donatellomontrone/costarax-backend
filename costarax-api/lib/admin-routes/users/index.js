// Admin: user management — list, update role/email, send password reset
const { supabaseAdmin, requireAdmin } = require('../../supabase-admin')
const { sendEmail } = require('../../email')

module.exports = async (req, res) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  // ── GET — list all users with roles + org context ────────────────────────
  if (req.method === 'GET') {
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    if (authErr) return res.status(500).json({ error: authErr.message })

    const users = authData?.users || []
    const ids = users.map(u => u.id)

    const [profilesRes, orgsRes] = await Promise.all([
      supabaseAdmin.from('profiles').select('id,email,role').in('id', ids),
      supabaseAdmin.from('organization_members')
        .select('user_id,supplier_id,business_id,suppliers(name),businesses(name)')
        .in('user_id', ids),
    ])

    const profileMap = Object.fromEntries((profilesRes.data || []).map(p => [p.id, p]))
    const orgMap     = Object.fromEntries((orgsRes.data   || []).map(m => [m.user_id, m]))

    const result = users.map(u => ({
      id:              u.id,
      email:           u.email,
      role:            profileMap[u.id]?.role || '—',
      created_at:      u.created_at,
      last_sign_in_at: u.last_sign_in_at || null,
      supplier_name:   orgMap[u.id]?.suppliers?.name || null,
      business_name:   orgMap[u.id]?.businesses?.name || null,
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

    return res.status(200).json(result)
  }

  // ── PATCH — update role and/or email ─────────────────────────────────────
  if (req.method === 'PATCH') {
    const { id, role, email } = req.body || {}
    if (!id) return res.status(400).json({ error: 'User id is required' })

    const VALID_ROLES = ['admin', 'business', 'supplier']

    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` })
      const { error } = await supabaseAdmin.from('profiles').update({ role }).eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
    }

    if (email?.trim()) {
      const newEmail = email.trim().toLowerCase()
      const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { email: newEmail })
      if (error) return res.status(500).json({ error: error.message })
      // Keep profiles table in sync
      await supabaseAdmin.from('profiles').update({ email: newEmail }).eq('id', id).catch(() => {})
    }

    return res.status(200).json({ message: 'User updated' })
  }

  // ── POST — create user OR send password reset email ──────────────────────
  if (req.method === 'POST') {
    const { id, email, action, password, role } = req.body || {}

    // Create a new user
    if (action === 'create') {
      if (!email?.trim() || !password) return res.status(400).json({ error: 'Email and password required' })
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: email.trim().toLowerCase(),
        password,
        email_confirm: true,
      })
      if (createErr) return res.status(500).json({ error: createErr.message })

      // Set role in profiles
      if (role) {
        await supabaseAdmin.from('profiles')
          .upsert({ id: created.user.id, email: email.trim().toLowerCase(), role }, { onConflict: 'id' })
          .catch(() => {})
      }
      return res.status(201).json({ message: 'User created', id: created.user.id })
    }
    if (!id && !email) return res.status(400).json({ error: 'User id or email required' })

    // Resolve email from id if needed
    let targetEmail = email
    if (!targetEmail && id) {
      const { data: u } = await supabaseAdmin.auth.admin.getUserById(id)
      targetEmail = u?.user?.email
    }
    if (!targetEmail) return res.status(404).json({ error: 'User not found' })

    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: targetEmail,
      options: { redirectTo: 'https://costarax.com/app.html' },
    })
    if (linkErr) return res.status(500).json({ error: linkErr.message })

    let resetLink = linkData?.properties?.action_link || linkData?.action_link
    if (!resetLink) return res.status(500).json({ error: 'Could not generate reset link' })

    // Force redirect_to to costarax.com — Supabase falls back to Site URL (localhost) otherwise
    try {
      const u = new URL(resetLink)
      u.searchParams.set('redirect_to', 'https://costarax.com/app.html')
      resetLink = u.toString()
    } catch (e) { /* leave as-is */ }

    const emailResult = await sendEmail({
      to:      targetEmail,
      subject: 'Reset your Costarax password',
      html:    `<p>An admin has requested a password reset for your Costarax account.</p><p><a href="${resetLink}" style="display:inline-block;padding:10px 20px;background:#1a7a4a;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Reset my password</a></p><p style="font-size:12px;color:#888">This link expires in 1 hour. If you did not request this, you can ignore this email.</p>`,
    })

    const emailSent = emailResult?.ok === true
    return res.status(200).json({
      message: emailSent
        ? `Reset email sent to ${targetEmail}`
        : `Email delivery failed: ${emailResult?.error || 'unknown error'} — send the backup link below to the user`,
      link: resetLink,
      emailSent,
      emailDebug: {
        provider: process.env.EMAIL_HOST ? 'smtp' : (process.env.RESEND_API_KEY ? 'resend' : 'none'),
        host: process.env.EMAIL_HOST || null,
        user: process.env.EMAIL_USER ? process.env.EMAIL_USER.slice(0, 4) + '…' : null,
        from: process.env.EMAIL_FROM || null,
        error: emailResult?.error || null,
      },
    })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
