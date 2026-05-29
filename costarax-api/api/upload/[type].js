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
const Anthropic = require('@anthropic-ai/sdk')
const pdfParse = require('pdf-parse')
const { supabaseAdmin, requireAuth } = require('../../lib/supabase-admin')
const { applyCors } = require('../../lib/cors')
const { resolveSupplierMembership } = require('../../lib/user-context')

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

const PRODUCT_METADATA_COLUMNS = [
  'producer',
  'brand',
  'cut_type',
  'grade_spec',
  'origin_series',
  'form_factor',
  'pack_weight',
]

let _productMetadataSchemaSupported = null
async function productMetadataSchemaSupported() {
  if (_productMetadataSchemaSupported !== null) return _productMetadataSchemaSupported
  const { error } = await supabaseAdmin
    .from('products')
    .select(`id, ${PRODUCT_METADATA_COLUMNS.join(', ')}`)
    .limit(1)
  _productMetadataSchemaSupported = !error
  return _productMetadataSchemaSupported
}

function titleCaseWords(s) {
  return String(s || '').replace(/\b\w/g, c => c.toUpperCase()).trim()
}

function inferStructuredProductMeta(rawName, unit, explicit = {}) {
  const raw = String(rawName || '').replace(/\s+/g, ' ').trim()
  const safeUnit = String(unit || '').trim() || 'kg'
  const CUT_PATTERNS = [
    ['Tenderloin', /tenderloin/i],
    ['Striploin', /strip\s*loin|striploin/i],
    ['Ribeye', /rib\s*eye|ribeye/i],
    ['Cube Roll', /cube\s*roll/i],
    ['Sirloin', /sirloin/i],
    ['Short Loin', /short\s*loin/i],
    ['Porterhouse', /porterhouse/i],
    ['T-Bone', /\bt[\s-]?bone\b/i],
    ['Tomahawk', /tomahawk/i],
    ['Butter', /\bbutter\b/i],
    ['Salami', /\bsalami\b/i],
    ['Cheese', /\bcheese\b/i],
    ['Wagyu', /\bwagyu\b/i],
  ]
  const cutMatch = CUT_PATTERNS.find(([, rx]) => rx.test(raw))
  let inferredBrand = null
  let inferredProducer = null
  if (cutMatch) {
    const idx = raw.search(cutMatch[1])
    if (idx > 0) {
      inferredBrand = raw.slice(0, idx).replace(/[|,-]\s*$/, '').trim()
    }
  }
  const producerMatch = raw.match(/\b(?:ohmi|mayura|sanchoku|minerva|creek\s*farm|point reyes|aguila gourmet meats|fidm reserve|vega sotuelamos|basiron)\b/i)
  if (producerMatch?.[0]) inferredProducer = titleCaseWords(producerMatch[0])
  const gradeParts = []
  const addGrade = (m) => { if (m && !gradeParts.includes(m[0].trim())) gradeParts.push(m[0].trim()) }
  addGrade(raw.match(/\bA\d\b/i))
  addGrade(raw.match(/\b(?:grade|marble(?:\s+grade|\s+score)?|ms|mb)\s*[- ]?\d+(?:\s*[-/]\s*\d+)?(?:\s*plus)?\b/i))
  addGrade(raw.match(/\bgrass\s*fed\b/i))
  addGrade(raw.match(/\bgrain\s*fed\b/i))
  addGrade(raw.match(/\bfullblood\b/i))
  const pack = raw.match(/\b\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?\s*(?:kg|g|lb|oz)\s*\/\s*(?:slab|pc|pack|case|box|tray|roll|bag|carton)\b/i)?.[0] || null
  const formBits = []
  ;['halves','half','bone in','bone-in','boneless','roll','slab','whole','block','sliced','center cut','center-cut'].forEach(token => {
    const rx = new RegExp(`\\b${token.replace('-', '[- ]?')}\\b`, 'i')
    if (rx.test(raw)) formBits.push(titleCaseWords(token))
  })
  const origin = raw.match(/\b(?:black\s*angus|f1\s*wagyu|irish|milano|australian|japanese|american)\b/i)?.[0] || null
  return {
    producer: explicit.producer || inferredProducer || inferredBrand || null,
    brand: explicit.brand || inferredBrand || inferredProducer || null,
    cut_type: explicit.cut_type || explicit.cut || (cutMatch ? cutMatch[0] : null),
    grade_spec: explicit.grade_spec || explicit.grade || (gradeParts.length ? gradeParts.join(' · ') : null),
    origin_series: explicit.origin_series || explicit.origin || (origin ? titleCaseWords(origin) : null),
    form_factor: explicit.form_factor || explicit.form || (formBits.length ? formBits.join(' · ') : null),
    pack_weight: explicit.pack_weight || explicit.pack || pack || null,
    default_unit: safeUnit,
  }
}

// ── Full CSV/TSV tokenizer (handles quoted fields with embedded newlines) ───
// Returns an array of rows, each row an array of cell strings.
// Critical: newlines inside quoted fields must NOT end a row. SheetJS
// (and Excel) preserve in-cell newlines this way, so splitting by '\n'
// before tokenizing corrupts multi-line cells.
function parseCsvAll(text, sep) {
  const rows = []
  let row = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++ }
        else inQ = false
      } else {
        cur += c
      }
    } else {
      if (c === '"') {
        inQ = true
      } else if (c === sep) {
        row.push(cur.trim()); cur = ''
      } else if (c === '\n' || c === '\r') {
        // End row only outside quotes; collapse \r\n into one terminator
        if (c === '\r' && text[i + 1] === '\n') i++
        row.push(cur.trim()); cur = ''
        if (row.some(v => v.length > 0)) rows.push(row)
        row = []
      } else {
        cur += c
      }
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur.trim())
    if (row.some(v => v.length > 0)) rows.push(row)
  }
  return rows
}

// ── Direct parser for Costarax price-list template (CSV or TSV) ─────────────
// Detects the header row and parses without calling the AI.
// Returns null if the text does not match the template format.
function parseCostaraxTemplate(text, supplierName) {
  if (!text || text.length < 20) return null
  const sep = text.indexOf('\t') > 0 && text.indexOf('\t') < text.indexOf('\n') ? '\t' : ','
  const rows = parseCsvAll(text, sep)
  if (rows.length < 2) return null

  const headers = rows[0].map(h => (h || '').toLowerCase())
  const nameIdx  = headers.findIndex(h => h === 'product_name')
  const priceIdx = headers.findIndex(h => h === 'price_php')
  if (nameIdx === -1 || priceIdx === -1) return null  // not our template

  const unitIdx     = headers.findIndex(h => h === 'unit')
  const stockIdx    = headers.findIndex(h => h === 'stock_qty')
  const notesIdx    = headers.findIndex(h => h === 'notes')
  const brandIdx    = headers.findIndex(h => h === 'brand' || h === 'producer')
  const categoryIdx = headers.findIndex(h => h === 'category')
  const packSizeIdx = headers.findIndex(h => h === 'pack_size' || h === 'pack_weight')

  const VALID_CATS = ['meat','seafood','produce','dry','beverages','packaging']
  function normaliseCategory(raw) {
    if (!raw) return null
    const c = String(raw).toLowerCase().trim()
    if (VALID_CATS.includes(c)) return c
    if (c === 'dry goods' || c === 'dry_goods') return 'dry'
    if (c === 'beverage') return 'beverages'
    if (c === 'fish' || c === 'seafood ') return 'seafood'
    return null
  }
  function inferCat(name) {
    const n = name.toLowerCase()
    if (/\b(beef|pork|chicken|poultry|lamb|veal|meat|tenderloin|loin|chuck|rib|wagyu|tomahawk|striploin|strip loin|sirloin|ribeye|cube roll|t-bone|porterhouse|rack)\b/.test(n)) return 'meat'
    if (/\b(fish|shrimp|prawn|squid|seafood|crab|lobster|salmon|tuna|tilapia|bangus|milkfish)\b/.test(n)) return 'seafood'
    if (/\b(vegetable|fruit|egg|tomato|cabbage|onion|potato|carrot|lettuce|mushroom|herb)\b/.test(n)) return 'produce'
    if (/\b(rice|flour|oil|sugar|salt|sauce|vinegar|canned|spice|pepper|coffee|tea|noodle|pasta|dried|powder)\b/.test(n)) return 'dry'
    if (/\b(drink|juice|water|soda|beverage|beer|wine|alcohol)\b/.test(n)) return 'beverages'
    if (/\b(box|bag|container|tray|packaging)\b/.test(n)) return 'packaging'
    return 'dry'
  }

  const items = []
  // Track (canonical, unit) occurrences so we can disambiguate true duplicates
  // by appending " (2)", " (3)", … When a supplier lists the same product +
  // unit twice with different prices, we treat each occurrence as a distinct
  // catalog entry rather than letting collapsePriceRows silently drop one.
  const seenKeyCount = new Map()
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i]
    // Normalise multi-line cell content: collapse embedded newlines into a single space
    const rawName = ((cells[nameIdx] || '').replace(/\s+/g, ' ')).trim()
    const priceStr = ((cells[priceIdx] || '').replace(/,/g, '').replace(/\s+/g, ' ')).trim()
    const price = parseFloat(priceStr)
    if (!rawName || !isFinite(price) || price <= 0) continue

    const unit = unitIdx >= 0 ? (cells[unitIdx] || '').replace(/\s+/g, ' ').trim() || 'kg' : 'kg'
    const stockRaw = stockIdx >= 0 ? (cells[stockIdx] || '').trim() : ''
    const notes = notesIdx >= 0 ? (cells[notesIdx] || '').replace(/\s+/g, ' ').trim() : ''
    const brandRaw    = brandIdx    >= 0 ? (cells[brandIdx]    || '').replace(/\s+/g, ' ').trim() : ''
    const categoryRaw = categoryIdx >= 0 ? (cells[categoryIdx] || '').trim() : ''
    const packSize    = packSizeIdx >= 0 ? (cells[packSizeIdx] || '').replace(/\s+/g, ' ').trim() : ''

    const stockN = parseFloat(stockRaw)
    const stock = stockRaw === '' ? null : (isFinite(stockN) && stockN >= 0 ? stockN : null)

    // Build canonical name:
    //   1. Prefer the explicit `brand` column if the supplier filled it.
    //   2. Fall back to the legacy behaviour of treating a short
    //      notes value as a brand (backwards compat with old templates
    //      that didn't have a brand column).
    let brand = brandRaw || null
    if (!brand && notes && notes.length > 0 && notes.length < 40 && /^[A-Za-z0-9]/.test(notes)) {
      brand = notes
    }
    let canonical = rawName
    if (brand && !rawName.toLowerCase().includes(brand.toLowerCase())) {
      canonical = `${brand} ${rawName}`
    }

    // Append pack_size when meaningful so the catalog disambiguates
    // "Tenderloin 5kg slab" from "Tenderloin 1kg vac pack".
    if (packSize && !canonical.toLowerCase().includes(packSize.toLowerCase())) {
      canonical = `${canonical} (${packSize})`
    }

    // Disambiguate duplicates: same canonical+unit with a different price gets " (N)"
    const dedupKey = `${canonical.toLowerCase()}__${unit.toLowerCase()}`
    const seenCount = seenKeyCount.get(dedupKey) || 0
    if (seenCount > 0) canonical = `${canonical} (${seenCount + 1})`
    seenKeyCount.set(dedupKey, seenCount + 1)

    // Use the explicit category when valid, otherwise infer from the
    // canonical name. The downstream catalog upsert requires one of the
    // VALID_CATS values.
    const category = normaliseCategory(categoryRaw) || inferCat(canonical)

    items.push({
      name: rawName,
      canonical,
      price,
      unit,
      stock,
      category,
      brand: brand || null,
      producer: brand || notes || null,
      pack_weight: packSize || null,
    })
  }

  console.log('[price-list upload] template-parse: extracted', items.length, 'items from', rows.length - 1, 'data rows')
  return items.length > 0 ? items : null
}

// ── 1) price-list (text → AI extract → DB upsert) ─────────────────────────
async function handlePriceList(req, res) {
  // Wall-time tracker so the function can return a partial response BEFORE
  // Vercel's gateway times out (which strips CORS headers and surfaces to
  // the browser as a confusing 504/CORS error). Whichever plan we're on,
  // capping ourselves at 50 s leaves headroom under both Hobby's 10 s
  // (effectively bypassed by skipping the cap then) and Pro's 60 s.
  const REQUEST_STARTED_AT = Date.now()
  const wallElapsed = () => Date.now() - REQUEST_STARTED_AT
  console.log('[upload] handlePriceList: start')

  const auth = await requireAuth(req, res)
  if (!auth) return
  if (!['supplier', 'admin'].includes(auth.profile.role)) {
    return res.status(403).json({ error: 'Supplier access required' })
  }

  let body
  try { body = await readJsonBody(req) } catch (e) { return res.status(400).json({ error: e.message }) }
  // Accept either pasted text OR a base64-encoded file (PDF / image) for Claude Vision.
  //
  // Two-step preview flow added on top of the legacy single-step flow:
  //   - dry_run: true → parse the file/text and return the extracted items
  //     without touching the DB. The frontend renders them in an editable
  //     preview modal.
  //   - items: [...] → the frontend posts the (possibly edited) items
  //     back here. We skip parsing entirely and feed them straight into
  //     the catalog-match + DB-write pipeline.
  // Old clients keep working unchanged.
  const { text, file_name, file_b64, file_mime, dry_run, items: providedItems } = body || {}
  const hasText = typeof text === 'string' && text.trim().length >= 10
  const hasFile = typeof file_b64 === 'string' && file_b64.length > 100 && typeof file_mime === 'string'
  const hasItems = Array.isArray(providedItems) && providedItems.length > 0
  if (!hasText && !hasFile && !hasItems) return res.status(400).json({ error: 'No content provided' })
  // Vercel Hobby plan caps JSON bodies at 4.5 MB. Stay safely under: ~3 MB raw
  // → ~4 MB base64. Bigger PDFs should be split or compressed client-side first.
  if (hasFile && file_b64.length > 4_000_000) {
    return res.status(413).json({ error: 'File too large. Max ~3 MB. Try compressing the PDF or cropping the image.' })
  }

  const collapseExtractedItems = (items) => {
    const byKey = new Map()
    ;(items || []).forEach(item => {
      if (!item?.name || !item?.price || Number(item.price) <= 0) return
      const canonicalName = (item.canonical || item.name || '').trim()
      const unit = (item.unit || 'kg').trim()
      const price = Number(item.price)
      const key = `${canonicalName.toLowerCase()}__${unit.toLowerCase()}__${price.toFixed(2)}`
      const existing = byKey.get(key)
      const normalized = {
        ...item,
        canonical: canonicalName,
        unit,
        price,
        stock: item.stock === '' ? null : item.stock,
      }
      if (!existing) {
        byKey.set(key, normalized)
        return
      }
      byKey.set(key, {
        ...existing,
        ...normalized,
        stock: normalized.stock ?? existing.stock ?? null,
      })
    })
    return Array.from(byKey.values())
  }

  const collapsePriceRows = (rows) => {
    const byKey = new Map()
    ;(rows || []).forEach(row => {
      if (!row?.supplier_id || !row?.product_id) return
      const unit = (row.unit || 'kg').trim()
      const key = `${row.supplier_id}__${row.product_id}__${unit.toLowerCase()}`
      const existing = byKey.get(key)
      if (!existing) {
        byKey.set(key, { ...row, unit })
        return
      }
      byKey.set(key, {
        ...existing,
        ...row,
        unit,
        stock_qty: row.stock_qty ?? existing.stock_qty ?? null,
      })
    })
    return Array.from(byKey.values())
  }

  let supplierId = null, supplierName = 'Supplier'
  const org = await resolveSupplierMembership(supabaseAdmin, auth.user.id, auth.user.email)
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

  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' })

  let extracted = []
  // When true, the catalog match step uses exact canonical_name match only.
  // This prevents the fuzzy matcher from collapsing distinct items in a
  // structured template (e.g. "Sanchoku Tenderloin MS6-7" vs
  // "Sanchoku Tenderloin MS4-5") onto a stale catalog entry from a
  // previous upload, which then get further dedup'd by collapsePriceRows.
  let useStrictMatching = false

  // ── Two-step flow short-circuits ─────────────────────────────────────────
  // 1) Frontend posts items directly (after the user confirmed the preview):
  //    skip parse and feed them into the catalog-match + save pipeline.
  // 2) Frontend posts dry_run + text: parse only, return items, no DB write.
  if (hasItems) {
    extracted = providedItems.map(it => ({
      name: String(it.name || it.canonical || '').trim(),
      canonical: String(it.canonical || it.name || '').trim(),
      price: Number(it.price) || 0,
      unit: String(it.unit || 'kg').trim(),
      stock: it.stock == null || it.stock === '' ? null : Number(it.stock),
      category: it.category || null,
      brand: it.brand || null,
      producer: it.producer || it.brand || null,
      pack_weight: it.pack_weight || it.pack_size || null,
      notes: it.notes || null,
    })).filter(it => it.name && it.price > 0)
    useStrictMatching = true
  } else if (dry_run && hasText) {
    const tmplItems = parseCostaraxTemplate(text, supplierName)
    if (!tmplItems || tmplItems.length === 0) {
      if (uploadId) {
        await supabaseAdmin.from('price_list_uploads').update({
          status: 'rejected',
          ai_summary: JSON.stringify({ error: 'Template parse returned no items' })
        }).eq('id', uploadId)
      }
      return res.status(422).json({
        error: 'No products found in the template. Check that the header row matches and rows have product_name + unit + price_php.',
        upload_id: uploadId
      })
    }
    return res.status(200).json({
      preview: true,
      items: tmplItems,
      count: tmplItems.length,
      upload_id: uploadId,
      message: `Parsed ${tmplItems.length} products. Review and confirm to save.`
    })
  }
  try {
    // Compact 5-field schema: canonical, price, unit, category, stock.
    // The downstream backend (inferStructuredProductMeta) already extracts
    // producer / brand / cut_type / grade_spec / origin_series / form_factor /
    // pack_weight from the canonical name with regex, so asking the AI to
    // emit them is wasted output tokens (~260 vs ~80 per item = 3× the
    // tokens per chunk = 3× the rate-limit cost on Tier 1's 10k tokens/min).
    const ruleBlock = `Extract products from this price list. Return JSON array only.
Each item: {"canonical":"Full English Name No Abbreviations","price":number,"unit":"kg/pc/box/etc","category":"meat|seafood|produce|dry|beverages|packaging","stock":number_or_null}
Rules: skip items without price. For price ranges use lower value. Expand abbreviations (mb2=Marble Grade 2, MS6-7=Marble Score 6-7).
CRITICAL canonical naming:
1. canonical MUST start with the brand/producer if mentioned (look at rightmost column / end of row).
2. canonical MUST include grade/marble score / series from section context (Platinum Label MB9+, F1 Wagyu, Grain Fed).
3. canonical MUST include distinguishing form factor (bone-in/boneless/Frenched/Chump On).
4. canonical MUST include pack/weight band when present.
5. Same cut + different brand/grade MUST get different canonicals. Never collapse.
Examples: "Mayura Platinum Label Tenderloin MB9+" vs "Mayura Signature Series Tenderloin MB8-9+", "Hardwick Australian Lamb Rack Frenched Bone In" vs "Wagstaff Australian Lamb Rack Frenched Bone In".
stock: if source has stock/qty column with number, return it. If "out of stock"/"OOS", return 0. Otherwise null.
Category: meat=beef/lamb/pork/chicken/poultry, seafood=fish/shrimp/squid/crab/scallop, produce=vegetables/fruits/eggs, dry=rice/flour/oil/canned/spices/pasta, beverages=drinks/juice/water/coffee, packaging=boxes/bags/containers.
Supplier: ${supplierName}`

    // maxRetries: 0 disables the SDK's internal exponential-backoff retry on
    // 429 / 5xx. We handle retries ourselves with bounded concurrency so we
    // know exactly how long a chunk can take. With the default (2 internal
    // retries × up to 60 s backoff each), a single rate-limited chunk could
    // silently block for ~2 minutes inside the SDK and cause a 504 even
    // though our outer code looks fine.
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 })
    let userContent
    // Always use Haiku — it's fast enough to finish within Vercel Hobby's 10-second
    // function limit. PDFs are pre-processed into text server-side with pdf-parse
    // so we never need to send a raw PDF binary to the AI (which would require
    // Sonnet and would always timeout at 10s).
    const model = 'claude-haiku-4-5-20251001'

    if (hasFile) {
      const isPdf   = /pdf/i.test(file_mime)
      const isImage = /^image\//i.test(file_mime)
      if (!isPdf && !isImage) {
        return res.status(415).json({ error: `Unsupported file type "${file_mime}". Use PDF or image (jpg, png, webp).` })
      }

      console.log(`[upload] t=${wallElapsed()}ms file received: ${isPdf?'PDF':'image'}, ${file_b64.length} bytes b64`)
      if (isPdf) {
        // Extract text from the PDF with pdf-parse (runs in <1 s server-side).
        // This avoids the 10-second Vercel Hobby timeout that Sonnet + raw PDF
        // would cause. For scanned/image-only PDFs pdf-parse returns little text;
        // in that case we fall back to a polite error asking the user to use an
        // image screenshot instead.
        const pdfBuffer = Buffer.from(file_b64, 'base64')
        let pdfText = ''
        try {
          const parsed = await pdfParse(pdfBuffer, { max: 0 })
          pdfText = (parsed.text || '').trim()
        } catch (pdfErr) {
          console.warn('[price-list upload] pdf-parse failed:', pdfErr.message)
        }
        if (pdfText.length < 80) {
          return res.status(422).json({
            error: 'Could not extract text from this PDF. It may be a scanned image. Please take a screenshot and upload as a JPG/PNG instead.'
          })
        }
        // ── Pre-process: extract only lines containing a price ──────────────
        // Raw pdf-parse output is ~60% noise: page headers, column headers,
        // section titles, blank lines. Each 6000-char raw chunk contains only
        // 56–90 product lines mixed with equal noise, and Haiku wastes its
        // max_tokens budget on that noise, yielding just 9–11 products per call.
        // By pre-filtering to price-bearing lines only, each chunk becomes
        // densely packed with products → 70 products per chunk, ~9 chunks total.
        //
        // The price-line regex is intentionally lax: handles ASCII "/kg" as
        // well as fullwidth "／ｋｇ" (Japanese price lists) and tolerates a
        // space between the decimal and the slash ("5,500.00 / kg").
        const PRICE_LINE_RX = /\d[\d,]*\.\d{2}\s*[\/／]\s*\S/
        // Aggressive page-header filter: catches phone, email, addresses, page
        // numbers, street tokens that recur on every page of structured PDFs.
        const PAGE_HDR_RX = /\+63|@|^phone:?$|^fax:?$|^email:?$|Parañaque|Metro Manila|^1700\s|Philippines|^Page\b|San Victores|Seacom|San Antonio|^\d{1,3}$/i
        const COL_HDR_RX  = /^Product Description[\s\t]+(Specs|Marble|Grade|Origin|Brand)/i
        const SECTION_RX  = /^[A-Z][A-Z\s\-\/&"]+[A-Z]\s*$/  // ALL-CAPS section headers
        const PRODUCT_SHAPE_RX = /(?:\d+(?:\.\d+)?\s*(?:kg|g|lb|oz)\s*\/\s*(?:slab|pc|pack|bone|case|box|tray)|\b(?:bone in|boneless|tenderloin|strip loin|rib eye|cube roll|short loin|sirloin|tomahawk|rack loin|loin ribs|chuck roll)\b)/i
        // A "subgroup" line is something like "Platinum Label MB9+",
        // "Signature Series MB8-9+", "F1 Wagyu", "Angus", "Grain Fed",
        // "Australian Lamb", "Australian Beef", "Full Blood Wagyu" — the
        // sub-header that describes the grade/origin/brand of the rows
        // that follow it. They usually contain capitalised words and are
        // short (< 60 chars). We require at least one capitalised word
        // so we don't accidentally pick up stray fragments.
        const looksLikeSubgroup = (line) => {
          if (line.length < 3 || line.length >= 60) return false
          if (PRODUCT_SHAPE_RX.test(line)) return false
          if (PAGE_HDR_RX.test(line)) return false
          // At least one capitalised word
          if (!/[A-Z][a-zA-Z+]+/.test(line)) return false
          return true
        }
        const rawLines = pdfText.split('\n').map(l => l.trim())
        let curSection = '', curSubgroup = ''
        const productLines = []
        for (let li = 0; li < rawLines.length; li++) {
          const line = rawLines[li]
          if (!line || PAGE_HDR_RX.test(line) || COL_HDR_RX.test(line)) continue
          if (SECTION_RX.test(line) && line.length < 70) { curSection = line; curSubgroup = ''; continue }
          if (PRICE_LINE_RX.test(line)) {
            // If the price-line is short (price-only, no product name),
            // back-track to the previous price line and pull the full
            // product block as context. No fixed line limit — column-based
            // PDFs (e.g. Japanese price lists) can spread one product over
            // 20+ lines.
            let combinedLine = line
            if (line.length < 40) {
              const ctx = []
              for (let j = li - 1; j >= 0; j--) {
                const prev = rawLines[j]
                if (!prev) continue
                if (PRICE_LINE_RX.test(prev)) break
                if (PAGE_HDR_RX.test(prev) || COL_HDR_RX.test(prev)) continue
                ctx.unshift(prev)
                if (ctx.length >= 50) break
              }
              if (ctx.length) {
                let joined = ctx.join(' | ')
                if (joined.length > 700) joined = joined.slice(-700)
                combinedLine = `${joined} | ${line}`
              }
            }
            // Prefix with section + sub-group context so AI can form proper canonical names
            const prefix = [curSection, curSubgroup].filter(Boolean).join(' > ')
            productLines.push(prefix ? `${prefix} | ${combinedLine}` : combinedLine)
            // ⚠️ DO NOT reset curSubgroup here. The sub-header (e.g. "Platinum
            // Label MB9+") applies to EVERY product underneath it until a new
            // section/subgroup appears. Resetting after each product caused
            // the 2nd, 3rd... product under each grade to lose its grade
            // context, which made the AI produce duplicate canonicals and
            // triggered fake "(2)" auto-renames.
          } else if (looksLikeSubgroup(line)) {
            curSubgroup = line  // grade/breed/origin sub-header
          }
        }
        console.log(`[upload] t=${wallElapsed()}ms pre-extracted ${productLines.length} product lines (PDF was ${pdfText.length} chars)`)

        // ── Diagnostics container ───────────────────────────────────────────
        const dx = {
          pdf_text_chars: pdfText.length,
          pdf_raw_lines: rawLines.length,
          product_lines_after_prefilter: productLines.length,
          chunks_total: 0,
          chunks_succeeded: 0,
          chunks_succeeded_on_first_try: 0,
          chunks_succeeded_on_retry: 0,
          chunks_failed: 0,
          chunks_truncated: 0,
          retries_attempted: 0,
          failed_chunk_ids: [],
          truncated_chunk_ids: [],
          chunk_input_lines_total: 0,
          chunk_items_emitted_total: 0,
          ai_items_raw: 0,
          after_canonical_dedup: 0,
          after_autorename: 0,
        }

        // Smaller chunks = faster per-call AI completion = lower wall time.
        // 25 lines × ~175 tok/item ≈ 4400 output tokens per chunk (~5 s on
        // Haiku 4.5). 25 chunks × 25 lines = 625-line capacity (enough for
        // most price lists).
        const LINES_PER_CHUNK = 25
        const MAX_CHUNKS = 25

        if (productLines.length > 0) {
          const chunks = []
          for (let i = 0; i < productLines.length && chunks.length < MAX_CHUNKS; i += LINES_PER_CHUNK) {
            chunks.push(productLines.slice(i, i + LINES_PER_CHUNK).join('\n'))
          }
          dx.chunks_total = chunks.length
          // maxRetries: 0 — handle retry logic in our own bounded pool. The
          // SDK's default internal retry on 429 would otherwise silently stall
          // a chunk for up to ~2 minutes and trigger Vercel's 504 timeout.
          const anthropicInner = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 })
          // Simplified prompt for clean pre-processed input:
          // each line is already "SECTION > Sub-group | Name Specs Brand Price/unit"
          const chunkRule = `${ruleBlock}
Format: each line is one product. Lines may be prefixed with "SECTION > Sub-group | " context.
Use the context to build a complete canonical name (e.g. "CHILLED BEEF > F1 Wagyu | Tenderloin MS6-7 … Sanchoku" → canonical "Sanchoku F1 Wagyu Tenderloin Marble Score 6-7").
IMPORTANT: Every input line MUST become one item in the output JSON array. Do not skip lines. If you can't parse a line, still emit it with whatever fields you can extract.`

          // Worker-pool concurrency cap.
          //
          // On Vercel Pro the function has 60 s, so we no longer have to be
          // clever about wall time. The simplest reliable strategy: cap how
          // many chunks are in flight at any moment so we never exceed
          // Anthropic's observed ~9-concurrent-connection ceiling on this
          // tier. 7 in flight gives a 2-slot safety margin.
          //
          // Math: 16 chunks ÷ 7 workers ≈ 2.3 chunks each × ~3-5 s per chunk
          // ≈ 8-12 s wall. Comfortably below 60 s.
          //
          // This replaces the two-phase strategy (b5a55f8) which kept
          // returning network errors even on Pro — likely due to a subtle
          // bug in the merge / diagnostics roll-up. Worker pool is simpler
          // and easier to reason about.
          // Concurrency 3 = at most ~6k output tokens in flight at any
          // moment (3 chunks × ~2k each with the compact 5-field schema),
          // safely under Tier 1's 10k tokens/minute Anthropic rate limit.
          // This is the real bottleneck — not concurrent-connections, but
          // output-tokens-per-minute. Concurrency 6 would emit ~12k/min
          // and trigger 429s on chunks 7+.
          const CHUNK_CONCURRENCY = 3
          console.log(`[upload] Pipeline: ${chunks.length} chunks, concurrency=${CHUNK_CONCURRENCY}`)

          const callChunkOnce = async (chunk) => anthropicInner.messages.create({
            model,
            // 25 items × ~80 tokens with the compact 5-field schema = ~2k
            // tokens; 3k gives comfortable headroom for slightly larger
            // canonical names without truncation.
            max_tokens: 3000,
            temperature: 0,
            system: 'You are a JSON extraction API. Output ONLY a valid JSON array. No markdown, no explanation, no text outside the JSON array. Every input line MUST produce one array element.',
            messages: [{ role: 'user', content: `${chunkRule}\n---\n${chunk}\n---\nJSON:` }]
          })
          const isRateLimit = (e) => e && (e.status === 429 || /rate.?limit|too many requests|concurrent connections/i.test(e.message || ''))

          const callChunk = async (chunk, idx) => {
            const lineCount = chunk.split('\n').length
            dx.chunk_input_lines_total += lineCount

            // Custom retry: short backoff (300-800 ms) on 429, ONE retry max.
            // SDK's internal retry is disabled (maxRetries: 0) because its
            // exponential backoff up to ~60 s could stall the whole function.
            // With our concurrency cap of 6 < 9, 429s should be rare.
            let r = null
            let lastErr = null
            try { r = await callChunkOnce(chunk) }
            catch (e) { lastErr = e }
            const usedRetry = !r && isRateLimit(lastErr)
            if (usedRetry) {
              dx.retries_attempted += 1
              const delay = 300 + Math.floor(Math.random() * 500)
              console.warn(`[chunk ${idx}] RATE_LIMITED — retrying in ${delay}ms`)
              await new Promise(res => setTimeout(res, delay))
              try { r = await callChunkOnce(chunk); lastErr = null }
              catch (e) { lastErr = e }
            }

            if (!r) {
              const tag = lastErr?.status === 429 ? 'RATE_LIMITED' : (lastErr?.status ? `HTTP_${lastErr.status}` : 'ERROR')
              console.error(`[chunk ${idx}] ${tag}: ${(lastErr?.message || '').slice(0, 200)}`)
              dx.chunks_failed += 1
              dx.failed_chunk_ids.push({ idx, error: lastErr?.message || 'unknown', status: lastErr?.status || null })
              return { idx, text: '', lines_in: lineCount }
            }
            const text = r.content?.[0]?.text?.trim() || ''
            const truncated = r.stop_reason === 'max_tokens'
            console.log(`[chunk ${idx}] in=${r.usage?.input_tokens} out=${r.usage?.output_tokens} len=${text.length} stop=${r.stop_reason} lines_in=${lineCount} retry=${usedRetry}`)
            dx.chunks_succeeded += 1
            if (usedRetry) dx.chunks_succeeded_on_retry += 1
            else dx.chunks_succeeded_on_first_try += 1
            if (truncated) {
              dx.chunks_truncated += 1
              dx.truncated_chunk_ids.push(idx)
            }
            return { idx, text, lines_in: lineCount }
          }

          // Worker-pool runner: N workers each pull the next unassigned
          // chunk from a shared cursor. Never more than N in flight.
          const runPool = async (items, concurrency, fn) => {
            const out = new Array(items.length)
            let cursor = 0
            const worker = async () => {
              while (true) {
                const i = cursor++
                if (i >= items.length) return
                out[i] = await fn(items[i], i)
              }
            }
            await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
            return out
          }
          console.log(`[upload] t=${wallElapsed()}ms starting AI pool of ${chunks.length} chunks`)
          const downstreamResults = await runPool(chunks, CHUNK_CONCURRENCY, callChunk)
          console.log(`[upload] t=${wallElapsed()}ms AI pool done: ${dx.chunks_succeeded} ok, ${dx.chunks_failed} failed`)
          dx.t_ai_done_ms = wallElapsed()

          // Merge all chunk results — count items emitted per chunk so we know
          // which chunks under-produced (truncation, partial JSON parse, etc).
          const allItems = []
          for (const { idx, text } of downstreamResults) {
            if (!text) continue
            const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || text.match(/(\[[\s\S]*)/)
            let raw = m ? (m[1] || m[0]).trim() : text.trim()
            if (!raw.startsWith('[')) raw = '[' + raw
            if (!raw.trimEnd().endsWith(']')) {
              const last = raw.lastIndexOf('},')
              raw = (last > 0 ? raw.slice(0, last + 1) : raw) + ']'
            }
            try {
              const items = JSON.parse(raw)
              dx.chunk_items_emitted_total += items.length
              allItems.push(...items)
            } catch (_) {
              console.warn(`[price-list chunk ${idx}] JSON parse failed, items lost`)
            }
          }
          dx.ai_items_raw = allItems.length
          console.log('[price-list upload] total items before dedup:', allItems.length, 'diagnostics so far:', JSON.stringify(dx))
          // Deduplicate by CANONICAL name + unit + price (not name).
          // Many products share the same base cut name ("Tenderloin", "Chuck Roll")
          // but are distinct entries because they differ in brand/grade/origin.
          // Using the canonical (which includes brand/grade) preserves all unique products
          // while still removing genuine duplicates from chunk-boundary overlap.
          const seen = new Set()
          let filtered = allItems.filter(i => {
            if (!i?.name) return false
            const canonicalName = (i.canonical || i.name || '').toLowerCase().trim()
            const unit = (i.unit || 'kg').toLowerCase().trim()
            const price = Number(i.price || 0)
            const key = `${canonicalName}__${unit}__${price.toFixed(2)}`
            if (seen.has(key)) return false
            seen.add(key)
            return price > 0
          })
          dx.after_canonical_dedup = filtered.length
          // Auto-rename duplicates that share canonical+unit with different prices:
          // append " (2)", " (3)", … so each gets a distinct product row.
          // Without this, collapsePriceRows would drop all but one price.
          let renameCount = 0
          const seenKeyCountPdf = new Map()
          extracted = filtered.map(i => {
            const c = (i.canonical || i.name || '').trim()
            const u = (i.unit || 'kg').trim()
            const k = `${c.toLowerCase()}__${u.toLowerCase()}`
            const n = seenKeyCountPdf.get(k) || 0
            seenKeyCountPdf.set(k, n + 1)
            if (n > 0) { renameCount += 1; return { ...i, canonical: `${c} (${n + 1})` } }
            return i
          })
          dx.after_autorename = extracted.length
          dx.autorenamed_count = renameCount
          console.log('[price-list upload] extracted after dedup+filter:', extracted.length, 'renamed:', renameCount)
          // If everything came back empty, return 500 WITH the diagnostics so
          // we can see exactly why (all chunks failed? JSON parse? truncated?)
          // instead of just throwing an opaque error.
          if (!extracted.length) {
            console.error('[upload] All chunks empty after pipeline:', JSON.stringify(dx))
            if (uploadId) {
              await supabaseAdmin.from('price_list_uploads').update({
                status: 'rejected',
                ai_summary: JSON.stringify({ error: 'No items extracted', diagnostics: dx })
              }).eq('id', uploadId).catch(() => {})
            }
            return res.status(500).json({
              error: 'No products could be extracted from the PDF. All AI chunks returned empty.',
              detail: `${dx.chunks_failed} chunks failed (of ${dx.chunks_total}). Check diagnostics for per-chunk error.`,
              diagnostics: dx
            })
          }
          // Jump straight to DB upsert — bypass the single-call code.
          // Strict (canonical_name, default_unit) match against the catalog —
          // mirrors the XLSX template path. The previous fuzzy matcher
          // collapsed multiple AI-generated canonicals onto the same stale
          // catalog product_id; collapsePriceRows then dropped the
          // duplicates (we lost ~150 of 581 items on the Hightower PDF).
          // With strict match each distinct (canonical, unit) gets its own
          // product row, exact re-uploads find the existing row, and
          // similar-but-different items create new products instead of
          // collapsing.
          const catalog2 = await supabaseAdmin.from('products').select('id, canonical_name, default_unit').eq('active', true)
          const products2 = catalog2.data || []
          function normalize2(s) { return (s||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim() }
          const productsByExactKey2 = new Map()
          for (const p of products2) {
            const k = `${normalize2(p.canonical_name)}__${(p.default_unit||'').toLowerCase().trim()}`
            productsByExactKey2.set(k, p)
          }
          function matchProductStrict2(canonical, unit) {
            const k = `${normalize2(canonical)}__${(unit||'').toLowerCase().trim()}`
            return productsByExactKey2.get(k) || null
          }
          const VALID_CATS = ['meat','seafood','produce','dry','beverages','packaging']
          const validItems2 = collapseExtractedItems(extracted)
          dx.after_collapse_extracted = validItems2.length
          dx.catalog_size = products2.length
          const toCreate2 = [], priceRows2 = []
          const parseStock2 = (v) => { if (v===null||v===undefined||v==='') return null; const n=Number(v); return Number.isFinite(n)&&n>=0?n:null }
          // Track how many distinct items hit the SAME existing product_id —
          // if two AI-distinct canonicals collapse to one catalog row, the
          // second one's price will be lost by collapsePriceRows later.
          const matchedProductIdCounts = new Map()
          for (const item of validItems2) {
            const canonicalName = (item.canonical||item.name).trim()
            const category_id = VALID_CATS.includes(item.category) ? item.category : 'dry'
            const unit = (item.unit||'kg').trim()
            const product = matchProductStrict2(canonicalName, unit)
            const stock_qty = parseStock2(item.stock)
            if (product) {
              matchedProductIdCounts.set(product.id, (matchedProductIdCounts.get(product.id) || 0) + 1)
              priceRows2.push({ supplier_id: supplierId, product_id: product.id, price_php: parseFloat(item.price), stock_qty, unit, active: true, updated_at: new Date().toISOString() })
            } else {
              const meta = inferStructuredProductMeta(canonicalName, unit, item)
              toCreate2.push({
                canonical_name: canonicalName,
                category_id,
                default_unit: unit,
                active: true,
                ...meta,
                _price: parseFloat(item.price),
                _unit: unit,
                _stock: stock_qty
              })
            }
          }
          dx.matched_existing_items = priceRows2.length
          dx.to_create_items = toCreate2.length
          // How many existing-product collisions? (≥2 AI items → same catalog id)
          const collisionPairs = [...matchedProductIdCounts.values()].filter(n => n > 1)
          dx.match_collisions = collisionPairs.length
          dx.items_lost_to_match_collisions = collisionPairs.reduce((a, n) => a + (n - 1), 0)
          if (toCreate2.length) {
            const schemaSupportsMeta = await productMetadataSchemaSupported()
            // Deduplicate by (canonical_name, default_unit) — same product can appear
            // multiple times with different prices; unique constraint forbids duplicate rows.
            const uniq2Map = new Map()
            for (const item of toCreate2) {
              const k = `${item.canonical_name.toLowerCase()}__${(item.default_unit||'kg').toLowerCase()}`
              if (!uniq2Map.has(k)) uniq2Map.set(k, item)
            }
            const uniqueToCreate2 = Array.from(uniq2Map.values())
            dx.to_create_after_dedup = uniqueToCreate2.length
            dx.to_create_dropped_by_dedup = toCreate2.length - uniqueToCreate2.length
            const insertPayload = uniqueToCreate2.map(({_price,_unit,_stock, ...p}) => {
              if (schemaSupportsMeta) return p
              const { producer, brand, cut_type, grade_spec, origin_series, form_factor, pack_weight, ...legacy } = p
              return legacy
            })
            const { data: newP, error: upsertErr } = await supabaseAdmin.from('products')
              .upsert(insertPayload, { onConflict: 'canonical_name,default_unit', ignoreDuplicates: false })
              .select('id,canonical_name,default_unit')
            if (upsertErr) {
              console.error('[price-list upload] products upsert FAILED:', upsertErr.message)
              dx.products_upsert_error = upsertErr.message
            }
            dx.products_upserted = newP?.length || 0
            if (newP) {
              const idLookup2 = new Map()
              newP.forEach(p => { idLookup2.set(`${p.canonical_name.toLowerCase()}__${(p.default_unit||'kg').toLowerCase()}`, p.id) })
              let priceRowsBefore = priceRows2.length
              toCreate2.forEach(item => {
                const k = `${item.canonical_name.toLowerCase()}__${(item.default_unit||'kg').toLowerCase()}`
                const pid = idLookup2.get(k)
                if (pid) priceRows2.push({ supplier_id: supplierId, product_id: pid, price_php: item._price, stock_qty: item._stock, unit: item._unit, active: true, updated_at: new Date().toISOString() })
              })
              dx.price_rows_added_from_new_products = priceRows2.length - priceRowsBefore
            }
          }
          let persistErr = null
          dx.price_rows_before_collapse = priceRows2.length
          const dedupedPriceRows2 = collapsePriceRows(priceRows2)
          dx.price_rows_after_collapse = dedupedPriceRows2.length
          dx.price_rows_lost_in_collapse = priceRows2.length - dedupedPriceRows2.length
          if (dedupedPriceRows2.length && supplierId) {
            // Full-replace semantics: every upload wipes the supplier's
            // current price list before inserting the new one. Previously
            // we only deleted prices for product_ids in the new payload,
            // which left orphan rows from earlier uploads — the supplier's
            // catalog grew with every retry instead of being replaced.
            const { error: deleteErr } = await supabaseAdmin
              .from('supplier_prices')
              .delete()
              .eq('supplier_id', supplierId)
            dx.full_replace_delete_error = deleteErr?.message || null
            if (deleteErr) {
              persistErr = 'Could not clear existing supplier prices: ' + deleteErr.message
            } else {
              const { error: insertErr2 } = await supabaseAdmin
                .from('supplier_prices')
                .insert(dedupedPriceRows2)
              if (insertErr2) persistErr = 'Could not save supplier prices: ' + insertErr2.message
            }
          }
          const matched2 = dedupedPriceRows2.length
          dx.price_rows_saved = matched2
          dx.t_total_ms = wallElapsed()
          // Final summary: total drop from PDF input to saved rows. The user
          // sees this number directly in the response and can pinpoint which
          // step caused the loss.
          dx.total_dropped_from_input = dx.product_lines_after_prefilter - matched2
          console.log(`[upload] t=${wallElapsed()}ms FINAL DIAGNOSTICS:`, JSON.stringify(dx))
          if (persistErr) {
            if (uploadId) {
              await supabaseAdmin.from('price_list_uploads').update({
                status: 'rejected',
                ai_summary: JSON.stringify({ extracted: extracted.length, matched: matched2, created: toCreate2.length, error: persistErr, diagnostics: dx })
              }).eq('id', uploadId)
            }
            return res.status(500).json({ error: persistErr, extracted: extracted.length, matched: matched2, created: toCreate2.length, diagnostics: dx })
          }
          if (uploadId) await supabaseAdmin.from('price_list_uploads').update({ status: 'needs_review', ai_summary: JSON.stringify({ extracted: extracted.length, matched: matched2, created: toCreate2.length, diagnostics: dx }) }).eq('id', uploadId)
          return res.status(201).json({ message: `Done! ${matched2} product${matched2!==1?'s':''} indexed (${toCreate2.length} new added to catalog).`, extracted: extracted.length, matched: matched2, created: toCreate2.length, anomalies: [], diagnostics: dx })
        }
        // Fallback: PDF had no recognisable price lines (unusual format).
        // Send first 6000 chars of raw text as a best-effort single call.
        userContent = `${ruleBlock}\n---\n${pdfText.slice(0, 6000)}\n---\nJSON:`
      } else {
        // Images: send as vision block (Haiku supports image vision natively)
        userContent = [
          { type: 'image', source: { type: 'base64', media_type: file_mime, data: file_b64 } },
          { type: 'text', text: `${ruleBlock}\n\nThe price list is the attached image. Read every product line and emit the JSON array. Output ONLY JSON.` }
        ]
      }
    } else {
      // ── Text path (CSV / TSV / XLSX-converted) ─────────────────────────
      // 1. Try direct template parse (no AI needed, handles all rows).
      const tmplItems = parseCostaraxTemplate(text, supplierName)
      if (tmplItems && tmplItems.length > 0) {
        extracted = tmplItems
        useStrictMatching = true  // template canonicals are deterministic — don't fuzzy match
        // Fall through to catalog lookup below — skip the AI call.
      } else {
        // 2. For long text → chunked parallel AI calls.
        // 3. For short text → single AI call (original behaviour).
        //
        // Chunk by character count, not lines: browser pdfjs returns one
        // very long line per page (~1KB each), so a 20-page PDF has only
        // ~20 lines — the old "lines.length > 60" gate skipped chunking
        // and the AI then truncated its output past 4000 tokens.
        const CHARS_PER_CHUNK = 3500   // ~875 tokens input → ~875 tokens output room left
        const MAX_CHUNKS = 10
        const NEEDS_CHUNKING = text.length > 6000
        if (NEEDS_CHUNKING) {
          // Greedy chunk on line boundaries; fall back to hard-cut if any
          // single line is itself larger than the chunk size.
          const lines = text.split('\n').filter(l => l.trim().length > 0)
          const textChunks = []
          let cur = ''
          for (const ln of lines) {
            if (ln.length > CHARS_PER_CHUNK) {
              // Single line too big — hard-cut it
              if (cur) { textChunks.push(cur); cur = '' }
              for (let off = 0; off < ln.length && textChunks.length < MAX_CHUNKS; off += CHARS_PER_CHUNK) {
                textChunks.push(ln.slice(off, off + CHARS_PER_CHUNK))
              }
              continue
            }
            if (cur.length + ln.length + 1 > CHARS_PER_CHUNK) {
              textChunks.push(cur)
              if (textChunks.length >= MAX_CHUNKS) { cur = ''; break }
              cur = ln
            } else {
              cur = cur ? `${cur}\n${ln}` : ln
            }
          }
          if (cur && textChunks.length < MAX_CHUNKS) textChunks.push(cur)

          console.log(`[price-list upload] text chunking: ${textChunks.length} chunks (~${text.length} chars total)`)
          const anthropicInner2 = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 })
          const chunkResults2 = await Promise.all(textChunks.map((chunk, idx) =>
            anthropicInner2.messages.create({
              model, max_tokens: 3000, temperature: 0,
              system: 'You are a JSON extraction API. Output ONLY a valid JSON array. No markdown, no explanation, no text outside the JSON array.',
              messages: [{ role: 'user', content: `${ruleBlock}\n---\n${chunk}\n---\nJSON:` }]
            }).then(r => {
              const t = r.content?.[0]?.text?.trim() || ''
              console.log(`[text-chunk ${idx}] in=${r.usage?.input_tokens} out=${r.usage?.output_tokens} len=${t.length}`)
              return t
            }).catch(e => { console.error(`[text-chunk ${idx}] FAILED:`, e.message); return '' })
          ))
          const allTextItems = []
          for (const chunkContent of chunkResults2) {
            if (!chunkContent) continue
            const m = chunkContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || chunkContent.match(/(\[[\s\S]*)/)
            let raw = m ? (m[1] || m[0]).trim() : chunkContent.trim()
            if (!raw.startsWith('[')) raw = '[' + raw
            if (!raw.trimEnd().endsWith(']')) {
              const last = raw.lastIndexOf('},')
              raw = (last > 0 ? raw.slice(0, last + 1) : raw) + ']'
            }
            try { const items = JSON.parse(raw); allTextItems.push(...items) } catch (_) {}
          }
          // Dedup by canonical+unit+price; auto-rename same canonical+unit
          // with different prices so collapsePriceRows doesn't drop variants.
          const seenText = new Set()
          let filteredText = allTextItems.filter(i => {
            if (!i?.name) return false
            const key = `${(i.canonical||i.name).toLowerCase()}__${(i.unit||'kg').toLowerCase()}__${Number(i.price||0).toFixed(2)}`
            if (seenText.has(key)) return false
            seenText.add(key)
            return Number(i.price) > 0
          })
          const seenKeyCountTxt = new Map()
          extracted = filteredText.map(i => {
            const c = (i.canonical || i.name || '').trim()
            const u = (i.unit || 'kg').trim()
            const k = `${c.toLowerCase()}__${u.toLowerCase()}`
            const n = seenKeyCountTxt.get(k) || 0
            seenKeyCountTxt.set(k, n + 1)
            if (n > 0) return { ...i, canonical: `${c} (${n + 1})` }
            return i
          })
          console.log('[price-list upload] text-chunk extracted:', extracted.length, 'items')
        } else {
          // Short text — single AI call
          userContent = `${ruleBlock}\n---\n${text}\n---\nJSON:`
        }
      }
    }

    // ── Single AI call (images, PDF fallback, short text) ────────────────
    if (!extracted.length && userContent !== undefined) {
    const aiMsg = await anthropic.messages.create({
      model,
      max_tokens: 2000,
      temperature: 0,
      system: 'You are a JSON extraction API. Output ONLY a valid JSON array. No markdown, no explanation, no text outside the JSON array.',
      messages: [{ role: 'user', content: userContent }]
    })
    const content = aiMsg.content?.[0]?.text?.trim()
    if (!content) throw new Error('Empty response from Anthropic')

    // Try to find the JSON array. The AI should output a bare array, but sometimes
    // wraps it in code fences. Also handle truncated responses (no closing ] or ```)
    // by taking everything from the first [ to the end and repairing.
    let rawJson = null
    const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    const arrayMatch = content.match(/(\[[\s\S]*)/)  // greedy — takes all from first [
    if (fenceMatch?.[1]?.trimStart().startsWith('[')) {
      rawJson = fenceMatch[1].trim()
    } else if (arrayMatch) {
      rawJson = arrayMatch[1].trim()
    }
    if (!rawJson) throw new Error('No JSON array returned by AI. Got: ' + content.slice(0, 200))

    // Ensure the array is closed (response may be truncated at max_tokens)
    function closeJson(s) {
      const t = s.trimEnd()
      if (t.endsWith(']')) return t
      // If truncated mid-object, find last complete object and close the array
      const lastComplete = t.lastIndexOf('},')
      if (lastComplete > 0) return t.slice(0, lastComplete + 1) + ']'
      const lastObj = t.lastIndexOf('},\n') > -1 ? t.lastIndexOf('},\n') : t.lastIndexOf('}')
      if (lastObj > 0) return t.slice(0, lastObj + 1) + ']'
      return t + ']'
    }
    rawJson = closeJson(rawJson)

    try { extracted = JSON.parse(rawJson) }
    catch (_) {
      let repaired = rawJson.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":').replace(/:\s*'([^']*)'/g, ': "$1"').replace(/[\x00-\x1F\x7F]/g, ' ')
      repaired = closeJson(repaired)
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
    } // end: if (!extracted.length && userContent !== undefined)
  } catch (e) {
    const errDetail = {
      message: e.message,
      status: e.status,
      error: e.error,
      type: e.constructor?.name,
      stack: e.stack?.split('\n').slice(0,4).join(' | ')
    }
    console.error('[price-list upload] AI extraction error:', JSON.stringify(errDetail))
    if (uploadId) {
      await supabaseAdmin.from('price_list_uploads').update({ status: 'rejected', ai_summary: JSON.stringify({ error: e.message, detail: errDetail }) }).eq('id', uploadId)
    }
    return res.status(500).json({ error: 'AI extraction failed: ' + e.message, detail: errDetail })
  }

  if (!extracted.length) return res.status(422).json({ error: 'No products found in the file.' })

  const { data: catalog } = await supabaseAdmin.from('products').select('id, canonical_name, default_unit').eq('active', true)
  const products = catalog || []
  function normalize(s) { return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() }
  function tokens(s) { return normalize(s).split(' ').filter(t => t.length > 2) }
  const CUT_START_RX = /\b(strip\s*loin|striploin|rib\s*eye|ribeye|cube\s*roll|tenderloin|short\s*loin|sirloin|porterhouse|t-bone|tomahawk|chuck\s*roll|strip|loin|butter|salami|cheese|wagyu)\b/i
  function extractLeadingQualifier(name) {
    const raw = String(name || '').replace(/\s+/g, ' ').trim()
    if (!raw) return ''
    const match = raw.match(CUT_START_RX)
    if (!match || match.index <= 0) return ''
    return normalize(raw.slice(0, match.index))
  }
  function leadingQualifierCompatible(needleName, hayName) {
    const needleQualifier = extractLeadingQualifier(needleName)
    if (!needleQualifier) return true
    const hayQualifier = extractLeadingQualifier(hayName)
    if (!hayQualifier) return false
    return hayQualifier.includes(needleQualifier) || needleQualifier.includes(hayQualifier)
  }
  function scoreProductMatch(needleName, hayName) {
    const needle = normalize(needleName), hay = normalize(hayName)
    if (!needle || !hay) return -1
    if (!leadingQualifierCompatible(needleName, hayName)) return -1
    if (hay === needle) return 1000
    if (hay.includes(needle) && needle.length >= 12) return 950 - Math.max(0, hay.length - needle.length)
    const nt = tokens(needle), ht = tokens(hay)
    if (!nt.length || !ht.length) return -1
    if (nt.length < 3) return -1
    const shared = nt.filter(t => ht.includes(t))
    const needleRatio = shared.length / nt.length
    const hayRatio = shared.length / ht.length
    if (needleRatio < 0.8) return -1
    if ((nt.length >= 4 && hayRatio < 0.45) || (nt.length < 4 && hayRatio < 0.6)) return -1
    return needleRatio * 100 + hayRatio * 10 - Math.abs(ht.length - nt.length)
  }
  function matchProduct(canonical) {
    let best = null, bestScore = -1
    for (const p of products) {
      const score = scoreProductMatch(canonical, p.canonical_name)
      if (score > bestScore) { best = p; bestScore = score }
    }
    return bestScore >= 0 ? best : null
  }
  // Strict matcher: only matches when canonical_name AND default_unit are an
  // exact (case-insensitive, normalized) match. Used for template uploads
  // where the canonical name is deterministic and we don't want fuzzy
  // matches collapsing distinct items.
  const productsByExactKey = new Map()
  if (useStrictMatching) {
    for (const p of products) {
      const k = `${normalize(p.canonical_name)}__${(p.default_unit||'').toLowerCase().trim()}`
      productsByExactKey.set(k, p)
    }
  }
  function matchProductStrict(canonical, unit) {
    const k = `${normalize(canonical)}__${(unit||'').toLowerCase().trim()}`
    return productsByExactKey.get(k) || null
  }

  const VALID_CATEGORIES = ['meat', 'seafood', 'produce', 'dry', 'beverages', 'packaging']
  const validItems = collapseExtractedItems(extracted)
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
    const unit = (item.unit || 'kg').trim()
    const product = useStrictMatching
      ? matchProductStrict(canonicalName, unit)
      : matchProduct(canonicalName)
    const stock_qty = parseStock(item.stock)
    if (product) priceRows.push({ supplier_id: supplierId, product_id: product.id, price_php: parseFloat(item.price), stock_qty, unit, active: true, updated_at: new Date().toISOString() })
    else {
      const meta = inferStructuredProductMeta(canonicalName, unit, item)
      toCreate.push({
        canonical_name: canonicalName,
        category_id,
        default_unit: unit,
        active: true,
        ...meta,
        _price: parseFloat(item.price),
        _unit: unit,
        _stock: stock_qty
      })
    }
  }

  let created = 0, insertError = null, upsertError = null
  if (toCreate.length) {
    const schemaSupportsMeta = await productMetadataSchemaSupported()
    // Deduplicate by (canonical_name, default_unit) before upsert.
    // The same product can appear with two different prices in one upload;
    // the unique constraint on products(canonical_name, default_unit) would
    // reject the whole batch if we send duplicate rows.
    const uniqMap = new Map()
    for (const item of toCreate) {
      const k = `${item.canonical_name.toLowerCase()}__${(item.default_unit||'kg').toLowerCase()}`
      if (!uniqMap.has(k)) uniqMap.set(k, item)
    }
    const uniqueToCreate = Array.from(uniqMap.values())
    const insertPayload = uniqueToCreate.map(({ _price, _unit, _stock, ...p }) => {
      if (schemaSupportsMeta) return p
      const { producer, brand, cut_type, grade_spec, origin_series, form_factor, pack_weight, ...legacy } = p
      return legacy
    })
    // Upsert: on conflict (canonical_name, default_unit) update the row so we
    // get back the id whether the product is new or already existed in the catalog.
    const { data: newProducts, error: iErr } = await supabaseAdmin.from('products')
      .upsert(insertPayload, { onConflict: 'canonical_name,default_unit', ignoreDuplicates: false })
      .select('id, canonical_name, default_unit')
    insertError = iErr?.message || null
    if (newProducts) {
      created = newProducts.length
      const idLookup = new Map()
      newProducts.forEach(p => { idLookup.set(`${p.canonical_name.toLowerCase()}__${(p.default_unit||'kg').toLowerCase()}`, p.id) })
      // Map ALL toCreate items (including duplicate canonicals) to their product_id
      toCreate.forEach(item => {
        const k = `${item.canonical_name.toLowerCase()}__${(item.default_unit||'kg').toLowerCase()}`
        const pid = idLookup.get(k)
        if (pid) priceRows.push({ supplier_id: supplierId, product_id: pid, price_php: item._price, stock_qty: item._stock, unit: item._unit, active: true, updated_at: new Date().toISOString() })
      })
    }
  }

  // ── Price anomaly detection ─────────────────────────────────────────────
  // Compare each new row's price against the median of OTHER suppliers' active
  // prices for the same product (matching unit when possible). Flag if the new
  // price is < 1/3 or > 3x the market median — almost always a unit mistake
  // (e.g. "kg" vs "50kg sack") or an OCR misread.
  const anomalies = []
  if (priceRows.length) {
    const productIds = priceRows.map(r => r.product_id)
    const { data: marketPrices } = await supabaseAdmin
      .from('supplier_prices')
      .select('product_id, price_php, unit, supplier_id')
      .in('product_id', productIds)
      .eq('active', true)
      .neq('supplier_id', supplierId || '')
    const byProduct = {}
    ;(marketPrices || []).forEach(mp => {
      if (!byProduct[mp.product_id]) byProduct[mp.product_id] = []
      byProduct[mp.product_id].push(mp)
    })
    const median = (arr) => {
      const s = [...arr].sort((a, b) => a - b)
      const mid = Math.floor(s.length / 2)
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
    }
    priceRows.forEach(r => {
      const others = (byProduct[r.product_id] || []).filter(mp => mp.unit === r.unit).map(mp => Number(mp.price_php))
      if (others.length < 2) return
      const med = median(others)
      if (!med) return
      const ratio = r.price_php / med
      if (ratio < 0.33 || ratio > 3) {
        anomalies.push({
          product_id: r.product_id, price: r.price_php, unit: r.unit,
          market_median: med, sample_size: others.length, ratio: Number(ratio.toFixed(2))
        })
      }
    })
  }

  const dedupedPriceRows = collapsePriceRows(priceRows)
  if (dedupedPriceRows.length && supplierId) {
    // Full-replace: wipe the supplier's existing price list before insert
    // so orphan rows from previous uploads don't accumulate.
    const { error: deleteErr } = await supabaseAdmin
      .from('supplier_prices')
      .delete()
      .eq('supplier_id', supplierId)
    if (deleteErr) {
      upsertError = 'Could not clear existing supplier prices: ' + deleteErr.message
    } else {
      const { error: uErr } = await supabaseAdmin.from('supplier_prices').insert(dedupedPriceRows)
      upsertError = uErr ? ('Could not save supplier prices: ' + uErr.message) : null
    }
  }

  const matched = dedupedPriceRows.length
  if (insertError || upsertError) {
    if (uploadId) {
      await supabaseAdmin.from('price_list_uploads').update({
        status: 'rejected',
        ai_summary: JSON.stringify({
          extracted: extracted.length,
          matched,
          created,
          anomalies: anomalies.length,
          anomaly_details: anomalies.slice(0, 5),
          error: upsertError || insertError
        })
      }).eq('id', uploadId)
    }
    return res.status(500).json({
      error: upsertError || insertError,
      extracted: extracted.length,
      validItems: validItems.length,
      toCreate: toCreate.length,
      matched,
      created,
      anomalies
    })
  }
  if (uploadId) {
    await supabaseAdmin.from('price_list_uploads').update({
      status: anomalies.length ? 'needs_review' : 'needs_review',
      ai_summary: JSON.stringify({ extracted: extracted.length, matched, created, anomalies: anomalies.length, anomaly_details: anomalies.slice(0, 5), error: upsertError || insertError || null })
    }).eq('id', uploadId)
  }

  const anomalyMsg = anomalies.length
    ? ` ⚠ ${anomalies.length} price anomal${anomalies.length === 1 ? 'y' : 'ies'} flagged for review.`
    : ''
  return res.status(201).json({
    message: `Done! ${matched} product${matched !== 1 ? 's' : ''} indexed (${created} new added to catalog).${anomalyMsg}`,
    extracted: extracted.length, validItems: validItems.length, toCreate: toCreate.length, matched, created,
    insertError, upsertError, anomalies, sampleExtracted: extracted.slice(0, 2)
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
  // supplier_id may come as a URL query param (?supplier_id=...) or as a form field
  const supplierId = req.query.supplier_id ||
    (Array.isArray(fields.supplier_id) ? fields.supplier_id[0] : fields.supplier_id)
  if (!supplierId) return res.status(400).json({ error: 'supplier_id is required' })

  if (auth.profile.role !== 'admin') {
    const ownSupplier = await resolveSupplierMembership(supabaseAdmin, auth.user.id, auth.user.email)
    const ownsSupplier = ownSupplier?.supplier_id === supplierId
    if (!ownsSupplier) return res.status(403).json({ error: 'You can only upload a logo for your own supplier' })
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
