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

// ── 1) price-list (text → AI extract → DB upsert) ─────────────────────────
async function handlePriceList(req, res) {
  const auth = await requireAuth(req, res)
  if (!auth) return
  if (!['supplier', 'admin'].includes(auth.profile.role)) {
    return res.status(403).json({ error: 'Supplier access required' })
  }

  let body
  try { body = await readJsonBody(req) } catch (e) { return res.status(400).json({ error: e.message }) }
  // Accept either pasted text OR a base64-encoded file (PDF / image) for Claude Vision.
  const { text, file_name, file_b64, file_mime } = body || {}
  const hasText = typeof text === 'string' && text.trim().length >= 10
  const hasFile = typeof file_b64 === 'string' && file_b64.length > 100 && typeof file_mime === 'string'
  if (!hasText && !hasFile) return res.status(400).json({ error: 'No content provided' })
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
  try {
    const ruleBlock = `Extract products from this price list. Return JSON array only.
Each item: {"name":"original","canonical":"Full English Name No Abbreviations","price":number,"unit":"kg/pc/box/etc","category":"meat|seafood|produce|dry|beverages|packaging","stock":number_or_null}
Rules: skip items without price. For price ranges use lower value. Expand abbreviations in canonical (e.g. mb2=Marble Grade 2).
Canonical naming rules: keep the cut + grade/marble score + brand + origin/series + distinguishing form factor (bone-in/boneless/halves/roll/center cut) + pack/weight band when present. Never collapse different brands, grades, or size bands into the same canonical name. If two lines differ by brand/grade/series/weight, they must become different canonical names. Example: "Creek Farm Striploin Grade 9 Grass Fed" must keep "Creek Farm" in canonical and must not become only "Striploin Grade 9 Grass Fed".
stock rules: if the source row has a stock/qty/available/inventory column with a number, return that number. If the row explicitly says "out of stock" / "OOS" / "sold out", return 0. Otherwise return null (do not guess).
Category rules: meat=pork/beef/chicken/poultry, seafood=fish/shrimp/squid, produce=vegetables/fruits/eggs, dry=rice/flour/oil/canned/spices, beverages=drinks/juice/water, packaging=boxes/bags/containers.
Supplier: ${supplierName}`

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
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
        const PRICE_LINE_RX = /\d[\d,]*\.\d{2}\/\w/
        const PAGE_HDR_RX   = /\+63|@|phone:|fax:|email:|Parañaque|Manila|Philippines/i
        const COL_HDR_RX    = /^Product Description[\s\t]+(Specs|Marble|Grade|Origin|Brand)/i
        const SECTION_RX    = /^[A-Z][A-Z\s\-\/&"]+[A-Z]\s*$/  // ALL-CAPS section headers
        const PRODUCT_SHAPE_RX = /(?:\d+(?:\.\d+)?\s*(?:kg|g|lb|oz)\s*\/\s*(?:slab|pc|pack|bone|case|box|tray)|\b(?:bone in|boneless|tenderloin|strip loin|rib eye|cube roll|short loin|sirloin|tomahawk|rack loin|loin ribs|chuck roll)\b)/i
        const rawLines = pdfText.split('\n').map(l => l.trim())
        let curSection = '', curSubgroup = ''
        const productLines = []
        for (const line of rawLines) {
          if (!line || PAGE_HDR_RX.test(line) || COL_HDR_RX.test(line)) continue
          if (SECTION_RX.test(line) && line.length < 70) { curSection = line; curSubgroup = ''; continue }
          if (PRICE_LINE_RX.test(line)) {
            // Prefix with section + sub-group context so AI can form proper canonical names
            const prefix = [curSection, curSubgroup].filter(Boolean).join(' > ')
            productLines.push(prefix ? `${prefix} | ${line}` : line)
            curSubgroup = '' // reset after attaching to this product
          } else if (line.length > 2 && line.length < 70 && !PRODUCT_SHAPE_RX.test(line)) {
            curSubgroup = line  // likely a grade/breed sub-header (e.g. "F1 Wagyu", "Angus")
          }
        }
        console.log('[price-list upload] pre-extracted', productLines.length, 'product lines (PDF was', pdfText.length, 'chars)')

        // Chunk by product lines: 70 per chunk × max 10 chunks = 700 products.
        // All chunks run in parallel; Haiku handles 70 clean lines well within
        // 4000 tokens of output and 3–4 s latency.
        const LINES_PER_CHUNK = 70
        if (productLines.length > 0) {
          const chunks = []
          for (let i = 0; i < productLines.length && chunks.length < 10; i += LINES_PER_CHUNK) {
            chunks.push(productLines.slice(i, i + LINES_PER_CHUNK).join('\n'))
          }
          const anthropicInner = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
          // Simplified prompt for clean pre-processed input:
          // each line is already "SECTION > Sub-group | Name Specs Brand Price/unit"
          const chunkRule = `${ruleBlock}
Format: each line is one product. Lines may be prefixed with "SECTION > Sub-group | " context.
Use the context to build a complete canonical name (e.g. "CHILLED BEEF > F1 Wagyu | Tenderloin MS6-7 … Sanchoku" → canonical "Sanchoku F1 Wagyu Tenderloin Marble Score 6-7").`
          const results = await Promise.all(chunks.map((chunk, idx) =>
            anthropicInner.messages.create({
              model,
              max_tokens: 6000,
              temperature: 0,
              system: 'You are a JSON extraction API. Output ONLY a valid JSON array. No markdown, no explanation, no text outside the JSON array.',
              messages: [{ role: 'user', content: `${chunkRule}\n---\n${chunk}\n---\nJSON:` }]
            }).then(r => {
              const text = r.content?.[0]?.text?.trim() || ''
              console.log(`[price-list chunk ${idx}] in=${r.usage?.input_tokens} out=${r.usage?.output_tokens} len=${text.length}`)
              return text
            }).catch(e => { console.error(`[price-list chunk ${idx}] FAILED:`, e.message); return '' })
          ))
          // Merge all chunk results
          const allItems = []
          for (const chunkContent of results) {
            if (!chunkContent) continue
            const m = chunkContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || chunkContent.match(/(\[[\s\S]*)/)
            let raw = m ? (m[1] || m[0]).trim() : chunkContent.trim()
            if (!raw.startsWith('[')) raw = '[' + raw
            if (!raw.trimEnd().endsWith(']')) {
              const last = raw.lastIndexOf('},')
              raw = (last > 0 ? raw.slice(0, last + 1) : raw) + ']'
            }
            try { const items = JSON.parse(raw); allItems.push(...items) } catch (_) {}
          }
          console.log('[price-list upload] total items before dedup:', allItems.length)
          // Deduplicate by CANONICAL name (not original name).
          // Many products share the same base cut name ("Tenderloin", "Chuck Roll")
          // but are distinct entries because they differ in brand/grade/origin.
          // Using the canonical (which includes brand/grade) preserves all unique products
          // while still removing genuine duplicates from chunk-boundary overlap.
          const seen = new Set()
          extracted = allItems.filter(i => {
            if (!i?.name) return false
            const canonicalName = (i.canonical || i.name || '').toLowerCase().trim()
            const unit = (i.unit || 'kg').toLowerCase().trim()
            const price = Number(i.price || 0)
            const key = `${canonicalName}__${unit}__${price.toFixed(2)}`
            if (seen.has(key)) return false
            seen.add(key)
            return price > 0
          })
          console.log('[price-list upload] extracted after dedup+filter:', extracted.length)
          // Skip the normal single-call path below
          if (!extracted.length) throw new Error('No products could be extracted from the PDF text.')
          // Jump straight to DB upsert — bypass the single-call code
          const catalog2 = await supabaseAdmin.from('products').select('id, canonical_name').eq('active', true)
          const products2 = catalog2.data || []
          function normalize2(s) { return (s||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim() }
          function tokens2(s) { return normalize2(s).split(' ').filter(t => t.length > 2) }
          const CUT_START_RX2 = /\b(strip\s*loin|striploin|rib\s*eye|ribeye|cube\s*roll|tenderloin|short\s*loin|sirloin|porterhouse|t-bone|tomahawk|chuck\s*roll|strip|loin|butter|salami|cheese|wagyu)\b/i
          function extractLeadingQualifier2(name) {
            const raw = String(name || '').replace(/\s+/g, ' ').trim()
            if (!raw) return ''
            const match = raw.match(CUT_START_RX2)
            if (!match || match.index <= 0) return ''
            return normalize2(raw.slice(0, match.index))
          }
          function leadingQualifierCompatible2(needleName, hayName) {
            const needleQualifier = extractLeadingQualifier2(needleName)
            if (!needleQualifier) return true
            const hayQualifier = extractLeadingQualifier2(hayName)
            if (!hayQualifier) return false
            return hayQualifier.includes(needleQualifier) || needleQualifier.includes(hayQualifier)
          }
          function scoreProductMatch2(needleName, hayName) {
            const needle = normalize2(needleName), hay = normalize2(hayName)
            if (!needle || !hay) return -1
            if (!leadingQualifierCompatible2(needleName, hayName)) return -1
            if (hay === needle) return 1000
            if (hay.includes(needle) && needle.length >= 12) return 950 - Math.max(0, hay.length - needle.length)
            const nt = tokens2(needle), ht = tokens2(hay)
            if (!nt.length || !ht.length) return -1
            if (nt.length < 3) return -1
            const shared = nt.filter(t => ht.includes(t))
            const needleRatio = shared.length / nt.length
            const hayRatio = shared.length / ht.length
            if (needleRatio < 0.8) return -1
            if ((nt.length >= 4 && hayRatio < 0.45) || (nt.length < 4 && hayRatio < 0.6)) return -1
            return needleRatio * 100 + hayRatio * 10 - Math.abs(ht.length - nt.length)
          }
          function matchProduct2(canonical) {
            let best = null, bestScore = -1
            for (const p of products2) {
              const score = scoreProductMatch2(canonical, p.canonical_name)
              if (score > bestScore) { best = p; bestScore = score }
            }
            return bestScore >= 0 ? best : null
          }
          const VALID_CATS = ['meat','seafood','produce','dry','beverages','packaging']
          const validItems2 = collapseExtractedItems(extracted)
          const toCreate2 = [], priceRows2 = []
          const parseStock2 = (v) => { if (v===null||v===undefined||v==='') return null; const n=Number(v); return Number.isFinite(n)&&n>=0?n:null }
          for (const item of validItems2) {
            const canonicalName = (item.canonical||item.name).trim()
            const category_id = VALID_CATS.includes(item.category) ? item.category : 'dry'
            const product = matchProduct2(canonicalName)
            const unit = (item.unit||'kg').trim()
            const stock_qty = parseStock2(item.stock)
            if (product) priceRows2.push({ supplier_id: supplierId, product_id: product.id, price_php: parseFloat(item.price), stock_qty, unit, active: true, updated_at: new Date().toISOString() })
            else toCreate2.push({ canonical_name: canonicalName, category_id, default_unit: unit, active: true, _price: parseFloat(item.price), _unit: unit, _stock: stock_qty })
          }
          if (toCreate2.length) {
            const { data: newP } = await supabaseAdmin.from('products').insert(toCreate2.map(({_price,_unit,_stock,...p})=>p)).select('id,canonical_name')
            if (newP) newP.forEach((np,i) => priceRows2.push({ supplier_id: supplierId, product_id: np.id, price_php: toCreate2[i]._price, stock_qty: toCreate2[i]._stock, unit: toCreate2[i]._unit, active: true, updated_at: new Date().toISOString() }))
          }
          let persistErr = null
          const dedupedPriceRows2 = collapsePriceRows(priceRows2)
          if (dedupedPriceRows2.length && supplierId) {
            const { error: deleteErr } = await supabaseAdmin
              .from('supplier_prices')
              .delete()
              .eq('supplier_id', supplierId)
              .in('product_id', dedupedPriceRows2.map(r => r.product_id))
            if (deleteErr) {
              persistErr = 'Could not replace existing supplier prices: ' + deleteErr.message
            } else {
              const { error: insertErr2 } = await supabaseAdmin
                .from('supplier_prices')
                .insert(dedupedPriceRows2)
              if (insertErr2) persistErr = 'Could not save supplier prices: ' + insertErr2.message
            }
          }
          const matched2 = dedupedPriceRows2.length
          if (persistErr) {
            if (uploadId) {
              await supabaseAdmin.from('price_list_uploads').update({
                status: 'rejected',
                ai_summary: JSON.stringify({ extracted: extracted.length, matched: matched2, created: toCreate2.length, error: persistErr })
              }).eq('id', uploadId)
            }
            return res.status(500).json({ error: persistErr, extracted: extracted.length, matched: matched2, created: toCreate2.length })
          }
          if (uploadId) await supabaseAdmin.from('price_list_uploads').update({ status: 'needs_review', ai_summary: JSON.stringify({ extracted: extracted.length, matched: matched2, created: toCreate2.length }) }).eq('id', uploadId)
          return res.status(201).json({ message: `Done! ${matched2} product${matched2!==1?'s':''} indexed (${toCreate2.length} new added to catalog).`, extracted: extracted.length, matched: matched2, created: toCreate2.length, anomalies: [] })
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
      userContent = `${ruleBlock}\n---\n${text.slice(0, 4000)}\n---\nJSON:`
    }

    const aiMsg = await anthropic.messages.create({
      model,
      max_tokens: 4000,
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

  const { data: catalog } = await supabaseAdmin.from('products').select('id, canonical_name').eq('active', true)
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
    const productIds = dedupedPriceRows.map(r => r.product_id)
    const { error: deleteErr } = await supabaseAdmin
      .from('supplier_prices')
      .delete()
      .eq('supplier_id', supplierId)
      .in('product_id', productIds)
    if (deleteErr) {
      upsertError = 'Could not replace existing supplier prices: ' + deleteErr.message
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
