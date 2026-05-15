const formidable = require('formidable')
const fs = require('fs')
const path = require('path')
const { supabaseAdmin, requireAuth } = require('../../lib/supabase-admin')
const OpenAI = require('openai')

const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

exports.config = { api: { bodyParser: false } }

// ── Parse file to plain text ──────────────────────────────────────────────────
async function extractText(filePath, mimetype, originalName) {
  const ext = (originalName || '').split('.').pop().toLowerCase()

  // CSV — plain text
  if (ext === 'csv' || mimetype === 'text/csv') {
    return fs.readFileSync(filePath, 'utf8')
  }

  // Excel
  if (['xls', 'xlsx'].includes(ext) ||
      mimetype === 'application/vnd.ms-excel' ||
      mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    const XLSX = require('xlsx')
    const wb = XLSX.readFile(filePath)
    let text = ''
    wb.SheetNames.forEach(name => {
      const sheet = wb.Sheets[name]
      text += `[Sheet: ${name}]\n`
      text += XLSX.utils.sheet_to_csv(sheet) + '\n'
    })
    return text
  }

  // PDF
  if (ext === 'pdf' || mimetype === 'application/pdf') {
    const pdfParse = require('pdf-parse')
    const buffer = fs.readFileSync(filePath)
    const data = await pdfParse(buffer)
    return data.text
  }

  return null
}

// ── Ask OpenAI to extract products ───────────────────────────────────────────
async function extractProductsWithAI(text, supplierName) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  const prompt = `You are a data extraction assistant for a Filipino foodservice procurement platform.

Extract all products and prices from this supplier price list. Return ONLY a valid JSON array.

Rules:
- Each item must have: "name" (string), "price" (number, PHP per unit), "unit" (string)
- Normalize units: use "kg", "g", "pc", "box", "case", "liter", "dozen", "bag", "tray"
- Convert price ranges to the lower price (e.g. "120-130" → 120)
- Skip items with no price or unclear entries
- Clean up product names (remove extra spaces, fix capitalization)
- If a price is per 500g, convert to per kg (multiply by 2)

Supplier: ${supplierName}

Price list content:
${text.slice(0, 8000)}

Return format (JSON array only, no explanation):
[{"name":"Product Name","price":100,"unit":"kg"},...]`

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 2000
  })

  const content = response.choices[0].message.content.trim()
  // Extract JSON from response (handle code blocks)
  const jsonMatch = content.match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error('AI returned no JSON array')
  return JSON.parse(jsonMatch[0])
}

// ── Match extracted product name to products table ────────────────────────────
function normalize(str) {
  return (str || '').toLowerCase()
    .replace(/[()]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchProduct(extractedName, products) {
  const needle = normalize(extractedName)
  // Exact match first
  let match = products.find(p => normalize(p.canonical_name) === needle)
  if (match) return match
  // Partial match — extracted name contains canonical or vice versa
  match = products.find(p => {
    const hay = normalize(p.canonical_name)
    return needle.includes(hay) || hay.includes(needle)
  })
  return match || null
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  Object.entries(CORS_H).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireAuth(req, res)
  if (!auth) return

  if (!['supplier', 'admin'].includes(auth.profile.role)) {
    return res.status(403).json({ error: 'Supplier access required' })
  }

  // Resolve supplier_id
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

  // Parse form
  const form = formidable({ maxFileSize: 20 * 1024 * 1024, maxFiles: 1 })
  let fields, files
  try { [fields, files] = await form.parse(req) }
  catch (e) { return res.status(400).json({ error: 'File parse error: ' + e.message }) }

  const fileArr = Array.isArray(files.file) ? files.file : [files.file].filter(Boolean)
  if (!fileArr.length) return res.status(400).json({ error: 'No file provided' })

  const file = fileArr[0]
  const allowed = ['application/pdf', 'text/csv', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
  if (!allowed.includes(file.mimetype) && !['pdf','csv','xls','xlsx'].includes((file.originalFilename||'').split('.').pop().toLowerCase())) {
    return res.status(400).json({ error: 'Only PDF, CSV and Excel files are accepted' })
  }

  // Upload raw file to Supabase storage
  const buffer = fs.readFileSync(file.filepath)
  const timestamp = Date.now()
  const storagePath = `${supplierId || 'admin'}/${timestamp}-${(file.originalFilename || 'price-list').replace(/[^a-zA-Z0-9._-]/g, '_')}`
  const { error: uploadErr } = await supabaseAdmin.storage
    .from('price-lists').upload(storagePath, buffer, { contentType: file.mimetype, upsert: false })
  if (uploadErr) {
    fs.unlinkSync(file.filepath)
    return res.status(500).json({ error: 'Storage error: ' + uploadErr.message })
  }

  // Record upload
  const { data: uploadRecord } = await supabaseAdmin.from('price_list_uploads').insert({
    supplier_id: supplierId,
    file_name: file.originalFilename,
    file_path: storagePath,
    file_size_bytes: file.size,
    status: 'processing'
  }).select('id').single()

  // Extract text from file
  let rawText
  try { rawText = await extractText(file.filepath, file.mimetype, file.originalFilename) }
  catch (e) { rawText = null }
  fs.unlinkSync(file.filepath)

  if (!rawText || rawText.trim().length < 20) {
    await supabaseAdmin.from('price_list_uploads').update({
      status: 'error', error_message: 'Could not extract text from file', processed_at: new Date().toISOString()
    }).eq('id', uploadRecord?.id)
    return res.status(422).json({ error: 'Could not read file content. Please try a CSV or Excel format.' })
  }

  // AI extraction
  let extracted = []
  try { extracted = await extractProductsWithAI(rawText, supplierName) }
  catch (e) {
    await supabaseAdmin.from('price_list_uploads').update({
      status: 'error', error_message: 'AI extraction failed: ' + e.message, processed_at: new Date().toISOString()
    }).eq('id', uploadRecord?.id)
    return res.status(500).json({ error: 'AI extraction failed. Please try again.' })
  }

  if (!extracted.length) {
    await supabaseAdmin.from('price_list_uploads').update({
      status: 'error', error_message: 'No products found in file', processed_at: new Date().toISOString()
    }).eq('id', uploadRecord?.id)
    return res.status(422).json({ error: 'No products could be extracted from the file.' })
  }

  // Load products catalog for matching
  const { data: catalog } = await supabaseAdmin.from('products').select('id, canonical_name, default_unit').eq('active', true)
  const products = catalog || []

  // Match and upsert prices
  let matched = 0, unmatched = []
  for (const item of extracted) {
    if (!item.name || !item.price || item.price <= 0) continue
    const product = matchProduct(item.name, products)
    if (!product) { unmatched.push(item.name); continue }
    await supabaseAdmin.from('supplier_prices').upsert({
      supplier_id: supplierId,
      product_id: product.id,
      price_php: parseFloat(item.price),
      active: true
    }, { onConflict: 'supplier_id,product_id' })
    matched++
  }

  // Update upload record
  await supabaseAdmin.from('price_list_uploads').update({
    status: 'completed',
    products_extracted: extracted.length,
    products_matched: matched,
    processed_at: new Date().toISOString()
  }).eq('id', uploadRecord?.id)

  return res.status(201).json({
    message: `Done! ${matched} products indexed successfully.${unmatched.length ? ` ${unmatched.length} not recognized: ${unmatched.slice(0,5).join(', ')}${unmatched.length > 5 ? '...' : ''}` : ''}`,
    extracted: extracted.length,
    matched,
    unmatched
  })
}
