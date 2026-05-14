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
  const { data } = await supabaseAdmin.from('profiles').select('role,status').eq('id', userId).single()
  return data
}
 
async function requireAuth(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return null }
  const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token)
  if (userErr || !user) { res.status(401).json({ error: 'Unauthorized' }); return null }
 
  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles').select('role,status').eq('id', user.id).single()
 
  // If profile fetch fails, fall back to user metadata
  if (profileErr || !profile) {
    console.log('Profile fetch failed:', profileErr?.message, 'user:', user.id)
    const meta = user.user_metadata || {}
    return { user, profile: { role: meta.role || 'buyer', status: 'approved' } }
  }
 
  if (profile.status && profile.status !== 'approved') {
    res.status(403).json({ error: 'Account not approved' }); return null
  }
  return { user, profile }
}
 
async function requireAdmin(req, res) {
  const auth = await requireAuth(req, res)
  if (!auth) return null
  if (auth.profile.role !== 'admin') { res.status(403).json({ error: 'Admin access required' }); return null }
  return auth
}
 
module.exports = { supabaseAdmin, verifyToken, getProfile, requireAuth, requireAdmin }
