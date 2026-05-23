// One-shot fix: link moderna.bgc@gmail.com to "High tower" supplier
// Run with: node -r dotenv/config fix-moderna-supplier.js (needs env vars)
// Or: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node fix-moderna-supplier.js

const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

async function main() {
  // 1. Find user
  const TARGET_EMAIL = 'moderna.bgc@gmail.com'
  const { data: authData, error: authErr } = await sb.auth.admin.listUsers({ perPage: 1000 })
  if (authErr) { console.error('listUsers error:', authErr.message); process.exit(1) }

  const user = (authData?.users || []).find(u => u.email?.toLowerCase() === TARGET_EMAIL.toLowerCase())
  if (!user) { console.error('User not found:', TARGET_EMAIL); process.exit(1) }
  console.log('Found user:', user.id, user.email)

  // 2. Find supplier "High tower"
  const { data: suppliers, error: supErr } = await sb
    .from('suppliers')
    .select('id, name, status, active')
    .ilike('name', '%high tower%')
  if (supErr) { console.error('suppliers error:', supErr.message); process.exit(1) }
  if (!suppliers?.length) { console.error('No supplier matching "High tower"'); process.exit(1) }

  console.log('Found suppliers:')
  suppliers.forEach(s => console.log(' ', s.id, s.name, 'active:', s.active, 'status:', s.status))

  const supplier = suppliers[0]

  // 3. Check existing org_members
  const { data: existing } = await sb
    .from('organization_members')
    .select('user_id, supplier_id')
    .eq('user_id', user.id)
  console.log('Existing org_members for user:', existing)

  // 4. Remove old supplier links for this user, then insert new one
  await sb.from('organization_members').delete().eq('user_id', user.id).not('supplier_id', 'is', null)

  const { error: insErr } = await sb.from('organization_members').insert({
    user_id: user.id,
    supplier_id: supplier.id
  })
  if (insErr) { console.error('Insert error:', insErr.message); process.exit(1) }

  console.log(`\n✅ Linked ${TARGET_EMAIL} → supplier "${supplier.name}" (${supplier.id})`)

  // 5. Also ensure profile role is 'supplier'
  const { error: profErr } = await sb.from('profiles')
    .upsert({ id: user.id, email: user.email, role: 'supplier' }, { onConflict: 'id' })
  if (profErr) console.warn('Profile upsert warning:', profErr.message)
  else console.log('✅ Profile role confirmed as supplier')
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
