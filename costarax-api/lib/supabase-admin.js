const { createClient } = require('@supabase/supabase-js')

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

async function verifyToken(token) {
  if (!token) return null
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !user) return null
  return user
}

async function getProfile(userId) {
  const { data } = await supabaseAdmin.from('profiles').select('role,status,email').eq('id', userId).single()
  return data
}

async function requireAuth(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  const user = await verifyToken(token)
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return null }
  const profile = await getProfile(user.id)
  if (!profile || profile.status !== 'approved') { res.status(403).json({ error: 'Account not approved' }); return null }
  return { user, profile }
}

async function requireAdmin(req, res) {
  const auth = await requireAuth(req, res)
  if (!auth) return null
  if (auth.profile.role !== 'admin') { res.status(403).json({ error: 'Admin access required' }); return null }
  return auth
}

module.exports = { supabaseAdmin, verifyToken, getProfile, requireAuth, requireAdmin }
