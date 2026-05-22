// ──────────────────────────────────────────────────────────────────────────
// Unified upload dispatcher.
//
// Vercel Hobby plan caps deployments at 12 Serverless Functions. We were at
// 16. Consolidating the four /api/upload/* endpoints into a single dynamic
// route gets us back under the limit. The browser keeps calling the same
// URLs (/api/upload/price-list, /api/upload/supplier-logo, …) — Vercel just
// routes them all to this file with the segment exposed as req.query.type.
// ──────────────────────────────────────────────────────────────────────────

const https = require('https')
const fs = require('fs')
const { formidable } = require('formidable')
const { supabaseAdmin, requireAuth } = require('../../lib/supabase-admin')
const { applyCors } = require('../../lib/cors')

exports.config = { api: { bodyParser: false } }

module.exports = async (req, res) => {
  try {
    if (applyCors(req, res, { methods: 'POST,OPTIONS' })) return
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    const type = req.query.type
    switch (type) {
      case 'price-list':          return handlePriceList(req, res)
      case 'access-request-doc':  return handleAccessRequestDoc(req, res)
      case 'supplier-logo':       return handleSupplierLogo(req, res)
      case 'product-image':       return handleProductImage(req, res)
      default:
        return res.status(404).json({ error: `Unknown upload type: ${type}` })
    }
  } catch (fatalErr) {
    console.error('[upload dispatcher] Unhandled error:', fatalErr.message)
    return res.status(500).json({ error: 'Internal server error', detail: fatalErr.message })
  }
}

// ── Helper: read raw JSON body when bodyParser is off ─────────────────────
async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('Invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

// ── 1) price-list (text → AI extract → DB upsert) ─────────────────────────
async function handlePriceList(req, res) {
  const auth = await requireAuth(req, res)
  if (!auth) return
  if (!['supplier', 'admin'].includes(auth.profile.role)) {
    return res.status(403).json({ error: 'Supplier access required' })
  }

  let body
  try { body = await readJsonBody(req) } catch (e) { return res.status(400).json({ error: e.message }) }
  const { text, file_name } = body || {}
  if (!text || text.trim().length < 10) return res.status(400).json({ error: 'No content provided' })

  let supplierId = null, supplierName = 'Supplier'
  const { data: org } = await supabaseAdmin
    .from('organization_members').select('supplier_id').eq('user_id', auth.user.id).single()
  supplierId = org?.supplier_id || null
  if (!supplierId && auth.profile.role !== 'admin') {
    return res.status(403).json({ error: 'No supplier linked to this account' })
  }
  if (supplierId) {
    const { data: sup } = await supabaseAdmin.from('suppliers').select('name').eq('id', supplierId).single()
    if (sup?.name) supplierName = sup.name
  }

  const { data: uploadRecord } = await supabaseAdmin
    .from('price_list_uploads').insert({ supplier_id: supplierId, file_name: file_name || 'price-list', status: 'uploaded' })
    .select('id').single()
  const uploadId = uploadRecord?.id || null

  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not configured on server' })

  let extracted = []
  try {
    const prompt = `Extract products from this price list. Return JSON array only.
Each item: {"name":"original","canonical":"Full English Name No Abbreviations","price":number,"unit":"kg/pc/box/etc","category":"meat|seafood|produce|dry|beverages|packaging","stock":number_or_null}
Rules: skip items without price. For price ranges use lower value. Expand abbreviations in canonical (e.g. mb2=Marble Grade 2).
stock rules: if the source row has a stock/qty/available/inventory column with a number, return that number. If the row explicitly says "out of stock" / "OOS" / "sold out", return 0. Otherwise return null (do not guess).
Category rules: meat=pork/beef/chicken/poultry, seafood=fish/shrimp/squid, produce=vegetables/fruits/eggs, dry=rice/flour/oil/canned/spices, beverages=drinks/juice/water, packaging=boxes/bags/containers.
Supplier: ${supplierName}
---
${text.slice(0, 2000)}
---
JSON:`

    const aiRes = await httpsPost(
      'api.groq.com',
      '/openai/v1/chat/completions',
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      { model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'You are a JSON extraction API. Output ONLY a valid JSON array. No markdown, no explanation, no text outside the JSON array.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.0, max_tokens: 1500 }
    )
    if (!aiRes.ok) throw new Error(aiRes.body?.error?.message || `Groq returned ${aiRes.status}`)
    const content = aiRes.body.choices?.[0]?.message?.content?.trim()
    if (!content) throw new Error('Empty response from Groq')

    const jsonMatch = content.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/) || content.match(/(\[[\s\S]*\])/)
    if (!jsonMatch) throw new Error('No JSON array returned by AI. Got: ' + content.slice(0, 200))
    let rawJson = (jsonMatch[1] || jsonMatch[0]).trim()
    try { extracted = JSON.parse(rawJson) }
    catch (_) {
      let repaired = rawJson.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":').replace(/:\s*'([^']*)'/g, ': "$1"').replace(/[\x00-\x1F\x7F]/g, ' ')
      if (!repaired.trimEnd().endsWith(']')) {
        const lastGood = repaired.lastIndexOf('},')
        repaired = (lastGood > 0 ? repaired.slice(0, lastGood + 1) : repaired) + ']'
      }
      try { extracted = JSON.parse(repaired) }
      catch (e2) {
        const objs = []
        const objRx = /\{[^{}]*"name"[^{}]*"price"[^{}]*\}/g
        let m
        while ((m = objRx.exec(rawJson)) !== null) { try { objs.push(JSON.parse(m[0])) } catch (_) {} }
        if (objs.length === 0) throw new Error('Malformed JSON from AI: ' + rawJson.slice(0, 200))
        extracted = objs
      }
    }
  } catch (e) {
    if (uploadId) {
      await supabaseAdmin.from('price_list_uploads').update({ status: 'rejected', ai_summary: JSON.stringify({ error: e.message }) }).eq('id', uploadId)
    }
    return res.status(500).json({ error: 'AI extraction failed: ' + e.message })
  }

  if (!extracted.length) return res.status(422).json({ error: 'No products found in the file.' })

  const { data: catalog } = await supabaseAdmin.from('products').select('id, canonical_name').eq('active', true)
  const products = catalog || []
  function normalize(s) { return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim() }
  function matchProduct(canonical) {
    const needle = normalize(canonical)
    return products.find(p => {
      const hay = normalize(p.canonical_name)
      if (hay === needle) return true
      const nt = needle.split(' '), ht = hay.split(' ')
      const shared = nt.filter(t => t.length > 2 && ht.includes(t)).length
      return shared >= Math.ceil(nt.length * 0.6)
    }) || null
  }

  const VALID_CATEGORIES = ['meat', 'seafood', 'produce', 'dry', 'beverages', 'packaging']
  const validItems = extracted.filter(i => i.name && i.price && i.price > 0)
  const toCreate = []
  const priceRows = []
  // Normalize stock value coming from the AI extractor: number ≥ 0 → kept, null/missing → null.
  const parseStock = (v) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  for (const item of validItems) {
    const canonicalName = (item.canonical || item.name).trim()
    const category_id = VALID_CATEGORIES.includes(item.category) ? item.category : 'dry'
    const product = matchProduct(canonicalName)
    const unit = (item.unit || 'kg').trim()
    const stock_qty = parseStock(item.stock)
    if (product) priceRows.push({ supplier_id: supplierId, product_id: product.id, price_php: parseFloat(item.price), stock_qty, unit, active: true, updated_at: new Date().toISOString() })
    else toCreate.push({ canonical_name: canonicalName, category_id, default_unit: unit, active: true, _price: parseFloat(item.price), _unit: unit, _stock: stock_qty })
  }

  let created = 0, insertError = null, upsertError = null
  if (toCreate.length) {
    const insertPayload = toCreate.map(({ _price, _unit, _stock, ...p }) => p)
    const { data: newProducts, error: iErr } = await supabaseAdmin.from('products').insert(insertPayload).select('id, canonical_name')
    insertError = iErr?.message || null
    if (newProducts) {
      created = newProducts.length
      newProducts.forEach((np, i) => priceRows.push({ supplier_id: supplierId, product_id: np.id, price_php: toCreate[i]._price, stock_qty: toCreate[i]._stock, unit: toCreate[i]._unit, active: true, updated_at: new Date().toISOString() }))
    }
  }

  if (priceRows.length && supplierId) {
    const productIds = priceRows.map(r => r.product_id)
    await supabaseAdmin.from('supplier_prices').delete().eq('supplier_id', supplierId).in('product_id', productIds)
    const { error: uErr } = await supabaseAdmin.from('supplier_prices').insert(priceRows)
    upsertError = uErr?.message || null
  }

  const matched = priceRows.length
  if (uploadId) {
    await supabaseAdmin.from('price_list_uploads').update({
      status: 'needs_review', ai_summary: JSON.stringify({ extracted: extracted.length, matched, created, error: upsertError || insertError || null })
    }).eq('id', uploadId)
  }

  return res.status(201).json({
    message: `Done! ${matched} product${matched !== 1 ? 's' : ''} indexed (${created} new added to catalog).`,
    extracted: extracted.length, validItems: validItems.length, toCreate: toCreate.length, matched, created,
    insertError, upsertError, sampleExtracted: extracted.slice(0, 2)
  })
}

function httpsPost(hostname, path, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj)
    const r = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (rs) => {
      let data = ''
      rs.on('data', c => { data += c })
      rs.on('end', () => { try { resolve({ ok: rs.statusCode >= 200 && rs.statusCode < 300, status: rs.statusCode, body: JSON.parse(data) }) } catch (e) { reject(new Error('Failed to parse response: ' + data.slice(0, 200))) } })
    })
    r.on('error', reject); r.write(body); r.end()
  })
}

// ── 2) access-request-doc (multi-file PDF/img upload to storage) ──────────
async function handleAccessRequestDoc(req, res) {
  const form = formidable({ maxFileSize: 10 * 1024 * 1024, maxFiles: 5 })
  let fields, files
  try { [fields, files] = await form.parse(req) } catch (e) { return res.status(400).json({ error: 'File parse error: ' + e.message }) }
  const accessRequestId = Array.isArray(fields.access_request_id) ? fields.access_request_id[0] : fields.access_request_id
  const docType = Array.isArray(fields.document_type) ? fields.document_type[0] : fields.document_type
  if (!accessRequestId) return res.status(400).json({ error: 'access_request_id is required' })
  const { data: ar, error: arErr } = await supabaseAdmin.from('access_requests').select('id, status').eq('id', accessRequestId).single()
  if (arErr || !ar) return res.status(404).json({ error: 'Access request not found' })
  if (ar.status !== 'pending') return res.status(400).json({ error: 'Access request is no longer pending' })

  const fileArr = Array.isArray(files.file) ? files.file : [files.file].filter(Boolean)
  const results = []
  for (const file of fileArr) {
    const buffer = fs.readFileSync(file.filepath)
    const timestamp = Date.now()
    const ext = file.originalFilename?.split('.').pop() || 'pdf'
    const storagePath = `${accessRequestId}/${timestamp}-${(file.originalFilename || 'document').replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const { error: uErr } = await supabaseAdmin.storage.from('access-request-docs')
      .upload(storagePath, buffer, { contentType: file.mimetype || 'application/octet-stream', upsert: false })
    if (uErr) { console.error('Storage upload error:', uErr.message); continue }
    await supabaseAdmin.from('access_request_documents').insert({
      access_request_id: accessRequestId, document_type: docType || 'other',
      file_name: file.originalFilename || 'document.' + ext, file_path: storagePath, file_size_bytes: file.size
    })
    fs.unlinkSync(file.filepath)
    results.push({ name: file.originalFilename, path: storagePath })
  }
  return res.status(201).json({ uploaded: results.length, files: results })
}

// ── 3) supplier-logo (auth-gated image upload) ────────────────────────────
async function handleSupplierLogo(req, res) {
  const auth = await requireAuth(req, res)
  if (!auth) return

  const ALLOWED = new Set(['image/png','image/jpeg','image/webp','image/svg+xml'])
  const form = formidable({ maxFileSize: 2 * 1024 * 1024, maxFiles: 1 })
  let fields, files
  try { [fields, files] = await form.parse(req) } catch (e) { return res.status(400).json({ error: 'File parse error: ' + e.message }) }
  const supplierId = Array.isArray(fields.supplier_id) ? fields.supplier_id[0] : fields.supplier_id
  if (!supplierId) return res.status(400).json({ error: 'supplier_id is required' })

  if (auth.profile.role !== 'admin') {
    const { data: member } = await supabaseAdmin.from('organization_members').select('supplier_id').eq('user_id', auth.user.id).single()
    if (!member || member.supplier_id !== supplierId) return res.status(403).json({ error: 'You can only upload a logo for your own supplier' })
  }

  const file = (Array.isArray(files.file) ? files.file : [files.file].filter(Boolean))[0]
  if (!file) return res.status(400).json({ error: 'No file provided' })
  if (!ALLOWED.has(file.mimetype)) return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` })

  const buffer = fs.readFileSync(file.filepath)
  const ext = (file.originalFilename || 'logo').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'png'
  const storagePath = `${supplierId}/logo-${Date.now()}.${ext}`
  const { error: upErr } = await supabaseAdmin.storage.from('supplier-assets')
    .upload(storagePath, buffer, { contentType: file.mimetype, upsert: false })
  fs.unlinkSync(file.filepath)
  if (upErr) return res.status(500).json({ error: 'Storage upload failed: ' + upErr.message })
  const { data: { publicUrl } } = supabaseAdmin.storage.from('supplier-assets').getPublicUrl(storagePath)
  const { error: dbErr } = await supabaseAdmin.from('suppliers').update({ logo_url: publicUrl, updated_at: new Date().toISOString() }).eq('id', supplierId)
  if (dbErr) {
    if (/column .*logo_url.* does not exist/i.test(dbErr.message)) {
      return res.status(500).json({ error: 'Run migrations/photos.sql in Supabase to add the logo_url column', detail: dbErr.message })
    }
    return res.status(500).json({ error: 'DB update failed: ' + dbErr.message })
  }
  return res.status(201).json({ logo_url: publicUrl, path: storagePath })
}

// ── 4) product-image (auth-gated image upload) ────────────────────────────
async function handleProductImage(req, res) {
  const auth = await requireAuth(req, res)
  if (!auth) return
  if (!['admin', 'supplier'].includes(auth.profile.role)) {
    return res.status(403).json({ error: 'Only suppliers and admins can upload product images' })
  }
  const ALLOWED = new Set(['image/png','image/jpeg','image/webp'])
  const form = formidable({ maxFileSize: 2 * 1024 * 1024, maxFiles: 1 })
  let fields, files
  try { [fields, files] = await form.parse(req) } catch (e) { return res.status(400).json({ error: 'File parse error: ' + e.message }) }
  const productId = Array.isArray(fields.product_id) ? fields.product_id[0] : fields.product_id
  if (!productId) return res.status(400).json({ error: 'product_id is required' })

  const file = (Array.isArray(files.file) ? files.file : [files.file].filter(Boolean))[0]
  if (!file) return res.status(400).json({ error: 'No file provided' })
  if (!ALLOWED.has(file.mimetype)) return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` })

  const { data: prod, error: prodErr } = await supabaseAdmin.from('products').select('id, canonical_name').eq('id', productId).single()
  if (prodErr || !prod) return res.status(404).json({ error: 'Product not found' })

  const buffer = fs.readFileSync(file.filepath)
  const ext = (file.originalFilename || 'image').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  const storagePath = `${productId}/${Date.now()}.${ext}`
  const { error: upErr } = await supabaseAdmin.storage.from('product-images')
    .upload(storagePath, buffer, { contentType: file.mimetype, upsert: false })
  fs.unlinkSync(file.filepath)
  if (upErr) return res.status(500).json({ error: 'Storage upload failed: ' + upErr.message })
  const { data: { publicUrl } } = supabaseAdmin.storage.from('product-images').getPublicUrl(storagePath)
  const { error: dbErr } = await supabaseAdmin.from('products').update({ image_url: publicUrl }).eq('id', productId)
  if (dbErr) {
    if (/column .*image_url.* does not exist/i.test(dbErr.message)) {
      return res.status(500).json({ error: 'Run migrations/photos.sql in Supabase to add the image_url column', detail: dbErr.message })
    }
    return res.status(500).json({ error: 'DB update failed: ' + dbErr.message })
  }
  return res.status(201).json({ image_url: publicUrl, path: storagePath })
}
