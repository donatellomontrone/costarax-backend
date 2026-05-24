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
      .select('user_id, supplier_id, business_id, suppliers(id,name,status,active,category,city,region), businesses(id,name,status,city,region)')
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

async function resolveSupplierMembership(db, userId, authEmail = null) {
  const ctx = await resolveUserContext(db, userId, authEmail)
  return ctx.supplier
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
  resolveSupplierMembership,
  resolveBusinessMembership,
}
