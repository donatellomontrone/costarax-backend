function normalizeUiRole(profileRole) {
  if (profileRole === 'buyer') return 'business'
  if (profileRole === 'super_admin') return 'admin'
  return profileRole || null
}

function chooseSupplierMembership(rows) {
  const suppliers = (rows || []).filter(r => r?.supplier_id)
  if (suppliers.length === 0) return null
  const ranked = [...suppliers].sort((a, b) => scoreSupplierMembership(b) - scoreSupplierMembership(a))
  return ranked[0]
}

function chooseBusinessMembership(rows) {
  const businesses = (rows || []).filter(r => r?.business_id)
  if (businesses.length === 0) return null
  const ranked = [...businesses].sort((a, b) => scoreBusinessMembership(b) - scoreBusinessMembership(a))
  return ranked[0]
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

async function resolveUserContext(db, userId, authEmail = null) {
  const [profileRes, orgRes] = await Promise.all([
    db.from('profiles').select('email, role, status').eq('id', userId).maybeSingle(),
    db.from('organization_members')
      .select('user_id, supplier_id, business_id, suppliers(id,name,status,active,category,city,region,subscription_plan), businesses(id,name,status,city,region)')
      .eq('user_id', userId),
  ])

  const profile = profileRes.data || null
  const membershipRows = orgRes.data || []
  const supplierMembership = chooseSupplierMembership(membershipRows)
  const businessMembership = chooseBusinessMembership(membershipRows)
  const profileRole = profile?.role || null
  const normalizedProfileRole = normalizeUiRole(profileRole)

  const allowedUiRoles = []
  if (supplierMembership) allowedUiRoles.push('supplier')
  if (businessMembership) allowedUiRoles.push('business')
  if (['admin', 'super_admin'].includes(profileRole)) allowedUiRoles.push('admin')

  // Legacy fallback: older accounts may still rely on profile.role before
  // memberships were consistently created. Keep them usable while we migrate.
  if (allowedUiRoles.length === 0 && ['business', 'supplier'].includes(normalizedProfileRole)) {
    allowedUiRoles.push(normalizedProfileRole)
  }

  const dedupedRoles = [...new Set(allowedUiRoles)]
  const defaultUiRole =
    (normalizedProfileRole && dedupedRoles.includes(normalizedProfileRole) && normalizedProfileRole) ||
    dedupedRoles[0] ||
    null

  return {
    user_id: userId,
    email: (authEmail || profile?.email || '').toLowerCase() || null,
    profile_role: profileRole,
    profile_status: profile?.status || null,
    normalized_profile_role: normalizedProfileRole,
    allowed_ui_roles: dedupedRoles,
    default_ui_role: defaultUiRole,
    supplier: supplierMembership ? {
      supplier_id: supplierMembership.supplier_id,
      name: supplierMembership.suppliers?.name || null,
      status: supplierMembership.suppliers?.status || null,
      active: supplierMembership.suppliers?.active ?? null,
      category: supplierMembership.suppliers?.category || null,
      city: supplierMembership.suppliers?.city || null,
      region: supplierMembership.suppliers?.region || null,
      subscription_plan: supplierMembership.suppliers?.subscription_plan || null,
    } : null,
    business: businessMembership ? {
      business_id: businessMembership.business_id,
      name: businessMembership.businesses?.name || null,
      status: businessMembership.businesses?.status || null,
      city: businessMembership.businesses?.city || null,
      region: businessMembership.businesses?.region || null,
    } : null,
    memberships: membershipRows,
  }
}

function scoreLooseSupplierCandidate(row) {
  let score = 0
  if (row?.status === 'approved') score += 100
  if (row?.active) score += 50
  if (row?.status === 'pending') score += 10
  if (row?.status === 'rejected') score -= 100
  return score
}

async function resolveSupplierMembership(db, userId, authEmail = null) {
  const ctx = await resolveUserContext(db, userId, authEmail)
  if (ctx.supplier?.supplier_id) return ctx.supplier

  const email = String(authEmail || ctx.email || '').trim().toLowerCase()
  if (!email) return null
  if (ctx.normalized_profile_role !== 'supplier') return null

  const { data: supplierRows, error } = await db
    .from('suppliers')
    .select('id, name, status, active, category, city, region, contact_email, subscription_plan')
    .ilike('contact_email', email)

  if (error) {
    console.warn('[user-context] supplier email fallback failed:', error.message)
    return null
  }
  if (!supplierRows?.length) return null

  const best = [...supplierRows].sort((a, b) => scoreLooseSupplierCandidate(b) - scoreLooseSupplierCandidate(a))[0]
  if (!best?.id) return null

  return {
    supplier_id: best.id,
    name: best.name || null,
    status: best.status || null,
    active: best.active ?? null,
    category: best.category || null,
    city: best.city || null,
    region: best.region || null,
    subscription_plan: best.subscription_plan || null,
    resolved_via: 'contact_email_fallback',
  }
}

async function resolveBusinessMembership(db, userId, authEmail = null) {
  const ctx = await resolveUserContext(db, userId, authEmail)
  return ctx.business
}

module.exports = {
  normalizeUiRole,
  chooseSupplierMembership,
  chooseBusinessMembership,
  scoreSupplierMembership,
  scoreBusinessMembership,
  resolveUserContext,
  scoreLooseSupplierCandidate,
  resolveSupplierMembership,
  resolveBusinessMembership,
}
