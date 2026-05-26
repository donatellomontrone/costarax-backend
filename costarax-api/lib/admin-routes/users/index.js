// Admin: user management — list, update role/email, send password reset, delete (super-admin only)
const { supabaseAdmin, requireAdmin, requireSuperAdmin } = require('../../supabase-admin')
const { sendEmail, adminCreatedAccountEmail, adminRoleChangedEmail } = require('../../email')
const { enforce } = require('../../rate-limit')
const { logAdminAction } = require('../../admin-audit')
const { replaceSupplierLink, replaceBusinessLink } = require('../../membership-admin')

function normalizeUiRole(role) {
  if (role === 'buyer') return 'business'
  return role || '—'
}

async function handleUserUpdate(auth, body, res) {
  const { id, role, email } = body || {}
  if (!id) return res.status(400).json({ error: 'User id is required' })

  // Frontend uses 'business' label; DB enum uses 'buyer'.
  const VALID_UI_ROLES = ['admin', 'business', 'buyer', 'supplier', 'super_admin']
  const TO_DB_ROLE = { business: 'buyer', buyer: 'buyer', admin: 'admin', supplier: 'supplier', super_admin: 'super_admin' }

  let roleChanged = null
  if (role !== undefined) {
    if (!VALID_UI_ROLES.includes(role)) return res.status(400).json({ error: `Invalid role. Must be one of: admin, business, supplier, super_admin` })
    const dbRole = TO_DB_ROLE[role]

    const { data: before } = await supabaseAdmin.from('profiles').select('role').eq('id', id).single()
    const oldRole = before?.role || null

    if ((dbRole === 'super_admin' || oldRole === 'super_admin') && auth.profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only a super-admin can change the super_admin role.' })
    }
    if (oldRole === 'super_admin' && id === auth.user.id) {
      return res.status(400).json({ error: 'Super-admins cannot demote themselves. Ask another super-admin.' })
    }

    const { error } = await supabaseAdmin.from('profiles').update({ role: dbRole }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })

    if (oldRole !== dbRole) roleChanged = { oldRole, newRole: dbRole }
  }

  if (email?.trim()) {
    const newEmail = email.trim().toLowerCase()
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { email: newEmail })
    if (error) return res.status(500).json({ error: error.message })
    try { await supabaseAdmin.from('profiles').update({ email: newEmail }).eq('id', id) } catch (_) {}
  }

  let roleEmailQueued = false
  if (roleChanged) {
    roleEmailQueued = true
    ;(async () => {
      try {
        const { data: u } = await supabaseAdmin.auth.admin.getUserById(id)
        const targetEmail = u?.user?.email
        if (!targetEmail) return
        const tpl = adminRoleChangedEmail({ contactEmail: targetEmail, oldRole: roleChanged.oldRole, newRole: roleChanged.newRole })
        await sendEmail({ to: targetEmail, ...tpl })
      } catch (e) {
        console.error('[patch-user] role-change email failed', e.message)
      }
    })()
  }

  await logAdminAction(supabaseAdmin, {
    admin_id: auth.user.id,
    action_type: 'edit_user',
    target_id: id,
    notes: [
      roleChanged ? `role ${roleChanged.oldRole || '—'} -> ${roleChanged.newRole}` : null,
      email?.trim() ? `email -> ${email.trim().toLowerCase()}` : null,
    ].filter(Boolean).join(' · ')
  })

  return res.status(200).json({ message: 'User updated', roleChanged: !!roleChanged, roleEmailQueued })
}

module.exports = async (req, res) => {
  const auth = await requireAdmin(req, res)
  if (!auth) return

  // ── GET — list all users with roles + org context ────────────────────────
  if (req.method === 'GET') {
    const rawPage = Number(req.query?.page || 1)
    const rawLimit = Number(req.query?.limit || 1000)
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1
    const limit = Math.min(1000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 1000))
    const q = String(req.query?.q || '').trim().toLowerCase()
    const roleFilter = String(req.query?.role || '').trim().toLowerCase()

    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    if (authErr) return res.status(500).json({ error: authErr.message })

    const users = authData?.users || []
    const ids = users.map(u => u.id)

    const [profilesRes, orgsRes] = await Promise.all([
      supabaseAdmin.from('profiles').select('id,email,role').in('id', ids),
      supabaseAdmin.from('organization_members')
        .select('user_id,supplier_id,business_id,suppliers(name,status,active,contact_email,city,region),businesses(name,status,city,region)')
        .in('user_id', ids),
    ])

    const profileMap = Object.fromEntries((profilesRes.data || []).map(p => [p.id, p]))
    const supplierOrgByUser = {}
    const businessOrgByUser = {}
    ;(orgsRes.data || []).forEach(m => {
      if (m?.supplier_id) {
        const current = supplierOrgByUser[m.user_id]
        if (!current || scoreSupplierMembership(m) > scoreSupplierMembership(current)) supplierOrgByUser[m.user_id] = m
      }
      if (m?.business_id) {
        const current = businessOrgByUser[m.user_id]
        if (!current || scoreBusinessMembership(m) > scoreBusinessMembership(current)) businessOrgByUser[m.user_id] = m
      }
    })

    const result = users.map(u => ({
      id:              u.id,
      email:           u.email,
      role:            normalizeUiRole(profileMap[u.id]?.role),
      created_at:      u.created_at,
      last_sign_in_at: u.last_sign_in_at || null,
      supplier_id:     supplierOrgByUser[u.id]?.supplier_id || null,
      supplier_name:   supplierOrgByUser[u.id]?.suppliers?.name || null,
      supplier_status: supplierOrgByUser[u.id]?.suppliers?.status || null,
      supplier_active: supplierOrgByUser[u.id]?.suppliers?.active ?? null,
      supplier_contact_email: supplierOrgByUser[u.id]?.suppliers?.contact_email || null,
      supplier_city: supplierOrgByUser[u.id]?.suppliers?.city || null,
      supplier_region: supplierOrgByUser[u.id]?.suppliers?.region || null,
      business_id: businessOrgByUser[u.id]?.business_id || null,
      business_name:   businessOrgByUser[u.id]?.businesses?.name || null,
      business_status: businessOrgByUser[u.id]?.businesses?.status || null,
      business_city: businessOrgByUser[u.id]?.businesses?.city || null,
      business_region: businessOrgByUser[u.id]?.businesses?.region || null,
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

    const filtered = result.filter(row => {
      if (roleFilter && String(row.role || '').toLowerCase() !== roleFilter) return false
      if (!q) return true
      const haystack = [
        row.email,
        row.role,
        row.supplier_name,
        row.business_name,
        row.supplier_contact_email,
        row.supplier_city,
        row.supplier_region,
        row.business_city,
        row.business_region,
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })

    const total = filtered.length
    const start = (page - 1) * limit
    const items = filtered.slice(start, start + limit)

    if (!req.query?.page && !req.query?.limit && !req.query?.q && !req.query?.role) {
      return res.status(200).json(filtered)
    }

    return res.status(200).json({
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    })
  }

  // ── PATCH — update role and/or email ─────────────────────────────────────
  if (req.method === 'PATCH') {
    return handleUserUpdate(auth, req.body, res)
  }

  // ── POST — create user OR send password reset email ──────────────────────
  if (req.method === 'POST') {
    const { id, email, action, password, role, supplier_id, business_id } = req.body || {}

    if (action === 'edit_user') {
      return handleUserUpdate(auth, req.body, res)
    }

    // Link (or unlink) a user to a supplier organisation
    if (action === 'link_supplier') {
      if (!id) return res.status(400).json({ error: 'User id is required' })
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(id)
      const canonicalEmail = authUser?.user?.email?.trim()?.toLowerCase?.() || null
      if (canonicalEmail) {
        try { await supabaseAdmin.from('profiles').upsert({ id, email: canonicalEmail }, { onConflict: 'id' }) } catch (_) {}
      }
      let linkResult
      try {
        linkResult = await replaceSupplierLink(supabaseAdmin, { userId: id, supplierId: supplier_id || null })
      } catch (e) {
        return res.status(500).json({ error: e.message })
      }
      await logAdminAction(supabaseAdmin, {
        admin_id: auth.user.id,
        action_type: supplier_id ? 'link_supplier_user' : 'unlink_supplier_user',
        target_id: id,
        notes: supplier_id
          ? `linked supplier ${supplier_id}${linkResult?.displaced_user_ids?.length ? ` · displaced users ${linkResult.displaced_user_ids.join(', ')}` : ''}`
          : 'removed supplier link'
      })
      return res.status(200).json({
        message: supplier_id ? 'Supplier linked' : 'Supplier unlinked',
        linked_supplier_id: linkResult?.supplier_id || null,
        displaced_user_ids: linkResult?.displaced_user_ids || [],
        removed_supplier_ids: linkResult?.removed_supplier_ids || [],
      })
    }

    if (action === 'link_business') {
      if (!id) return res.status(400).json({ error: 'User id is required' })
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(id)
      const canonicalEmail = authUser?.user?.email?.trim()?.toLowerCase?.() || null
      if (canonicalEmail) {
        try { await supabaseAdmin.from('profiles').upsert({ id, email: canonicalEmail }, { onConflict: 'id' }) } catch (_) {}
      }
      let linkResult
      try {
        linkResult = await replaceBusinessLink(supabaseAdmin, { userId: id, businessId: business_id || null })
      } catch (e) {
        return res.status(500).json({ error: e.message })
      }
      await logAdminAction(supabaseAdmin, {
        admin_id: auth.user.id,
        action_type: business_id ? 'link_business_user' : 'unlink_business_user',
        target_id: id,
        notes: business_id
          ? `linked business ${business_id}`
          : 'removed business link'
      })
      return res.status(200).json({
        message: business_id ? 'Buyer linked' : 'Buyer unlinked',
        linked_business_id: linkResult?.business_id || null,
        removed_business_ids: linkResult?.removed_business_ids || [],
      })
    }

    // Create a new user
    if (action === 'create') {
      if (!email?.trim() || !password) return res.status(400).json({ error: 'Email and password required' })

      // Enforce password policy server-side (frontend check is bypassable)
      if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' })
      if (!/[A-Za-z]/.test(password)) return res.status(400).json({ error: 'Password must include at least one letter.' })
      if (!/\d/.test(password)) return res.status(400).json({ error: 'Password must include at least one digit.' })

      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: email.trim().toLowerCase(),
        password,
        email_confirm: true,
      })
      if (createErr) return res.status(500).json({ error: createErr.message })

      // Set role in profiles (frontend may send UI role 'business' for buyers)
      const TO_DB_ROLE = { business: 'buyer', buyer: 'buyer', admin: 'admin', supplier: 'supplier' }
      const dbRole = TO_DB_ROLE[role] || 'buyer'
      const { error: upsertErr } = await supabaseAdmin.from('profiles')
        .upsert({
          id: created.user.id,
          email: email.trim().toLowerCase(),
          role: dbRole,
          status: 'approved',
        }, { onConflict: 'id' })

      if (upsertErr) {
        console.error('[create-user] profile upsert failed:', upsertErr.message)
        return res.status(500).json({
          error: `User created but role assignment failed: ${upsertErr.message}. Set the role manually.`,
          id: created.user.id,
        })
      }

      // Link supplier user to their organisation so login resolves correctly
      if (dbRole === 'supplier' && supplier_id) {
        try {
          await replaceSupplierLink(supabaseAdmin, { userId: created.user.id, supplierId: supplier_id })
        } catch (e) {
          console.error('[create-user] org_member insert failed:', e.message)
        }
      }
      if (dbRole === 'buyer' && business_id) {
        try {
          await replaceBusinessLink(supabaseAdmin, { userId: created.user.id, businessId: business_id })
        } catch (e) {
          console.error('[create-user] business link failed:', e.message)
        }
      }

      // Generate a one-time set-password link and notify the new user.
      let resetLink = null
      try {
        const { data: linkData } = await supabaseAdmin.auth.admin.generateLink({
          type: 'recovery',
          email: email.trim().toLowerCase(),
          options: { redirectTo: 'https://costarax.com/app.html' },
        })
        resetLink = linkData?.properties?.action_link || linkData?.action_link || null
        if (resetLink) {
          try {
            const u = new URL(resetLink)
            u.searchParams.set('redirect_to', 'https://costarax.com/app.html')
            resetLink = u.toString()
          } catch {}
        }
      } catch (e) { console.error('[create-user] generateLink failed', e.message) }

      const tpl = adminCreatedAccountEmail({ contactEmail: email.trim().toLowerCase(), role: dbRole, resetLink })
      const emailRes = await sendEmail({ to: email.trim().toLowerCase(), ...tpl })

      await logAdminAction(supabaseAdmin, {
        admin_id: auth.user.id,
        action_type: 'create_user',
        target_id: created.user.id,
        notes: `created ${email.trim().toLowerCase()} as ${dbRole}${supplier_id ? ` · linked supplier ${supplier_id}` : ''}${business_id ? ` · linked business ${business_id}` : ''}`
      })

      return res.status(201).json({
        message: 'User created',
        id: created.user.id,
        role: dbRole,
        emailSent: emailRes?.ok === true,
      })
    }
    if (!id && !email) return res.status(400).json({ error: 'User id or email required' })

    // Resolve email from id if needed
    let targetEmail = email
    if (!targetEmail && id) {
      const { data: u } = await supabaseAdmin.auth.admin.getUserById(id)
      targetEmail = u?.user?.email
    }
    if (!targetEmail) return res.status(404).json({ error: 'User not found' })

    // Rate limit reset emails: 3 per hour per target email to prevent abuse/spam.
    if (!(await enforce(req, res, { bucket: 'admin-reset-email', identifier: targetEmail, max: 3, windowSec: 3600 }))) return

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
    await logAdminAction(supabaseAdmin, {
      admin_id: auth.user.id,
      action_type: 'send_password_reset',
      target_id: id || null,
      notes: `reset sent to ${targetEmail}`
    })
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

  // ── DELETE — permanently delete a user (super-admin only) ───────────────
  if (req.method === 'DELETE') {
    // Re-check super-admin (requireAdmin only checks admin/super_admin).
    if (auth.profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only a super-admin can delete users.' })
    }

    const id = req.query.id || req.body?.id
    if (!id) return res.status(400).json({ error: 'User id is required' })
    if (id === auth.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' })

    // Block deletion of other super-admins to prevent accidental wipeout.
    const { data: target } = await supabaseAdmin.from('profiles').select('role,email').eq('id', id).single()
    if (target?.role === 'super_admin') {
      return res.status(400).json({ error: 'Cannot delete another super-admin. Demote them first.' })
    }

    // Best-effort cleanup of org_members; auth user delete cascades to profiles.
    try { await supabaseAdmin.from('organization_members').delete().eq('user_id', id) } catch (_) {}

    const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
    if (error) return res.status(500).json({ error: error.message })

    try {
      await supabaseAdmin.from('admin_actions').insert({
        admin_id: auth.user.id,
        action_type: 'delete_user',
        target_id: id,
        notes: `Deleted user: ${target?.email || id}`,
      })
    } catch (_) {}

    return res.status(200).json({ message: 'User deleted', id })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

function scoreSupplierMembership(row) {
  const supplier = row?.suppliers || {}
  let score = 0
  if (supplier.status === 'approved') score += 100
  if (supplier.active) score += 50
  if (supplier.status === 'pending') score += 10
  if (supplier.status === 'rejected') score -= 100
  return score
}

function scoreBusinessMembership(row) {
  const business = row?.businesses || {}
  let score = 0
  if (business.status === 'approved') score += 100
  if (business.status === 'pending') score += 10
  if (business.status === 'rejected') score -= 100
  return score
}
