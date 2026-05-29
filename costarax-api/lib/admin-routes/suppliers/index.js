const { supabaseAdmin, requireAdmin } = require('../../supabase-admin')
const { sendEmail, welcomeInviteEmail } = require('../../email')

// Same branded-invite helper used by access-requests-action and
// businesses-action. Creates the auth user, generates a set-password
// link, returns both — never sends the Supabase default invite email.
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
  const auth = await requireAdmin(req, res)
  if (!auth) return

  // GET — list ALL suppliers (active + paused) with full details and subscription state.
  // Auto-pauses any supplier whose subscription's current_period_end is in the past.
  if (req.method === 'GET') {
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
    if (authErr) return res.status(500).json({ error: authErr.message })

    let sups = []
    {
      // Try the rich select including subscription_plan. If the column doesn't
      // exist yet (migrations/subscription_plan.sql not applied), fall back
      // to the legacy select so the admin panel still works.
      const tryRich = await supabaseAdmin
        .from('suppliers')
        .select('id, name, category, tagline, city, region, minimum_order_php, rating, verified, active, status, plan, subscription_plan, created_at, trial_ends_at, logo_url')
        .order('name')
      if (tryRich.error && /subscription_plan/i.test(tryRich.error.message || '')) {
        const fb = await supabaseAdmin
          .from('suppliers')
          .select('id, name, category, tagline, city, region, minimum_order_php, rating, verified, active, status, plan, created_at, trial_ends_at, logo_url')
          .order('name')
        if (fb.error) return res.status(500).json({ error: fb.error.message })
        sups = (fb.data || []).map(s => ({ ...s, subscription_plan: 'basic' }))
      } else if (tryRich.error) {
        return res.status(500).json({ error: tryRich.error.message })
      } else {
        sups = (tryRich.data || []).map(s => ({ ...s, subscription_plan: s.subscription_plan || 'basic' }))
      }
    }

    const ids = (sups || []).map(s => s.id)
    let subs = [], orgMembers = []
    if (ids.length > 0) {
      const [subsRes, membersRes] = await Promise.all([
        supabaseAdmin
          .from('subscriptions')
          .select('supplier_id, status, current_period_end, last_payment_at, last_payment_status, cancel_at_period_end, created_at')
          .in('supplier_id', ids),
        supabaseAdmin
          .from('organization_members')
          .select('supplier_id, user_id')
          .in('supplier_id', ids),
      ])
      subs = subsRes.data || []
      orgMembers = membersRes.data || []
    }
    const emailByUserId = Object.fromEntries((authData?.users || []).map(u => [u.id, u.email || null]))
    const subBy = {}
    subs.forEach(s => { subBy[s.supplier_id] = s })
    const membersBySup = {}
    orgMembers.forEach(m => {
      if (!membersBySup[m.supplier_id]) membersBySup[m.supplier_id] = []
      membersBySup[m.supplier_id].push({ user_id: m.user_id, email: emailByUserId[m.user_id] || null })
    })

    const now = new Date()
    const toAutoPauseSub   = []    // expired paid subscriptions
    const toAutoPauseTrial = []    // expired trials (no sub, trial_ends_at past)
    const enriched = (sups || []).map(s => {
      const sub = subBy[s.id] || null
      const periodEnd = sub?.current_period_end ? new Date(sub.current_period_end) : null
      const trialEnd  = s.trial_ends_at ? new Date(s.trial_ends_at) : null
      const subExpired   = !!(periodEnd && periodEnd < now)
      const trialExpired = !sub && !!(trialEnd && trialEnd < now)
      if (subExpired && s.active)   toAutoPauseSub.push(s.id)
      if (trialExpired && s.active) toAutoPauseTrial.push(s.id)
      return {
        ...s,
        subscription_status: sub?.status || null,
        last_payment_at: sub?.last_payment_at || null,
        last_payment_status: sub?.last_payment_status || null,
        current_period_end: sub?.current_period_end || null,
        cancel_at_period_end: sub?.cancel_at_period_end || false,
        membership_started_at: sub?.created_at || s.created_at || null,
        expired: subExpired,
        trial_expired: trialExpired,
        linked_users: membersBySup[s.id] || [],
      }
    })

    // Auto-pause: paid subscriptions whose period ended
    if (toAutoPauseSub.length > 0) {
      await supabaseAdmin.from('suppliers').update({ active: false })
        .in('id', toAutoPauseSub)
      await supabaseAdmin.from('admin_actions').insert(
        toAutoPauseSub.map(id => ({
          admin_id: auth.user.id,
          action_type: 'auto_pause_expired',
          target_id: id,
          notes: 'Subscription period ended — automatic pause'
        }))
      )
      enriched.forEach(s => { if (toAutoPauseSub.includes(s.id)) s.active = false })
    }

    // Auto-pause: trials whose trial_ends_at is past
    if (toAutoPauseTrial.length > 0) {
      await supabaseAdmin.from('suppliers').update({ active: false })
        .in('id', toAutoPauseTrial)
      await supabaseAdmin.from('admin_actions').insert(
        toAutoPauseTrial.map(id => ({
          admin_id: auth.user.id,
          action_type: 'auto_pause_trial_expired',
          target_id: id,
          notes: 'Trial period ended — automatic pause'
        }))
      )
      enriched.forEach(s => { if (toAutoPauseTrial.includes(s.id)) s.active = false })
    }

    return res.status(200).json(enriched)
  }

  // POST — create new supplier (optionally with linked auth user + invite)
  if (req.method === 'POST') {
    const { name, category, categories, tagline, city, region, minimum_order_php, tin, delivery_coverage, contact_email } = req.body
    if (!name || !category) return res.status(400).json({ error: 'name and category are required' })

    const { data, error } = await supabaseAdmin.from('suppliers').insert({
      name: name.trim(),
      legal_name: name.trim(),
      category,
      categories: Array.isArray(categories) && categories.length ? categories : [category],
      tagline: tagline?.trim() || null,
      city: city?.trim() || null,
      region: region?.trim() || null,
      minimum_order_php: minimum_order_php || 1000,
      tin: tin?.trim() || null,
      contact_email: contact_email?.trim() || null,
      delivery_coverage: delivery_coverage?.trim() || null,
      verified: false,
      active: false,
      status: 'pending',
      rating: 5.0,
      review_count: 0
    }).select('id, name').single()

    if (error) return res.status(500).json({ error: error.message })

    // If contact_email was provided, also create the auth user, upsert
    // their profile, link organization_members, and send our branded
    // welcome email with the set-password link. Soft-fail: if any of
    // these steps errors, the supplier row stays and the admin can use
    // the Users tab to recover.
    let inviteSent = false
    let userId = null
    if (contact_email?.trim()) {
      try {
        const r = await createUserWithBrandedInvite({
          email: contact_email, role: 'supplier', companyName: name
        })
        userId = r.userId
        if (userId) {
          await supabaseAdmin.from('profiles').upsert({
            id: userId, email: contact_email.trim().toLowerCase(),
            role: 'supplier', status: 'approved'
          }).catch(e => console.warn('[create-supplier] profile upsert:', e.message))
          await supabaseAdmin.from('organization_members').insert({
            user_id: userId, supplier_id: data.id
          }).catch(e => console.warn('[create-supplier] org_members insert:', e.message))
        }
        if (r.link) {
          const tpl = welcomeInviteEmail({
            companyName: name, contactEmail: contact_email,
            role: 'supplier', inviteLink: r.link
          })
          const sendRes = await sendEmail({ to: contact_email, ...tpl })
          inviteSent = sendRes?.ok === true
        }
      } catch (e) {
        console.warn('[create-supplier] invite flow failed:', e.message)
      }
    }

    await supabaseAdmin.from('admin_actions').insert({
      admin_id: auth.user.id,
      action_type: 'create_supplier',
      target_id: data.id,
      notes: `Created supplier: ${name}${inviteSent ? ` · invited ${contact_email}` : ''}`
    })

    return res.status(201).json({
      id: data.id,
      message: `${name} created${inviteSent ? ' · welcome email sent' : ''}`,
      inviteSent
    })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
