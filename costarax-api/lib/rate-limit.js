// Persistent rate limiter backed by a Supabase rate_limits table.
// Each call records a (bucket, identifier, ts) row and counts recent rows.
// Schema (create once in Supabase SQL editor):
//   create table if not exists rate_limits (
//     id bigserial primary key,
//     bucket text not null,
//     identifier text not null,
//     created_at timestamptz not null default now()
//   );
//   create index if not exists rate_limits_lookup_idx
//     on rate_limits (bucket, identifier, created_at desc);

const { supabaseAdmin } = require('./supabase-admin')

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (fwd) return String(fwd).split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

// limit(req, { bucket, identifier, max, windowSec, failClosed })
// Returns { allowed, remaining, retryAfter }.
// failClosed: when the counter query errors, deny instead of allow. Use this on
// costly endpoints (e.g. AI calls that hit a paid API) so a broken/missing
// rate_limits table can't turn into unbounded spend. Defaults to fail-open.
async function limit(req, { bucket, identifier, max, windowSec, failClosed = false }) {
  const id = String(identifier || clientIp(req)).slice(0, 200)
  const since = new Date(Date.now() - windowSec * 1000).toISOString()

  const { count, error } = await supabaseAdmin
    .from('rate_limits')
    .select('id', { head: true, count: 'exact' })
    .eq('bucket', bucket)
    .eq('identifier', id)
    .gte('created_at', since)

  // On query error (table missing / DB hiccup): fail-closed denies, fail-open allows.
  if (error) {
    console.error('[rate-limit] query error', error.message, failClosed ? '(failing closed)' : '(failing open)')
    if (failClosed) {
      return { allowed: false, remaining: 0, retryAfter: windowSec }
    }
    return { allowed: true, remaining: max, retryAfter: 0 }
  }

  if ((count || 0) >= max) {
    return { allowed: false, remaining: 0, retryAfter: windowSec }
  }

  // Best-effort insert; don't block the request if it fails.
  supabaseAdmin.from('rate_limits').insert({ bucket, identifier: id }).then(({ error: insErr }) => {
    if (insErr) console.error('[rate-limit] insert error', insErr.message)
  })

  return { allowed: true, remaining: max - (count || 0) - 1, retryAfter: 0 }
}

// Convenience wrapper that writes the standard 429 response.
async function enforce(req, res, opts) {
  const r = await limit(req, opts)
  if (!r.allowed) {
    res.setHeader('Retry-After', String(r.retryAfter))
    res.status(429).json({ error: 'Too many requests. Try again later.' })
    return false
  }
  return true
}

module.exports = { limit, enforce, clientIp }
