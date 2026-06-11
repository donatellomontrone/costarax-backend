const Anthropic = require('@anthropic-ai/sdk');
const { supabaseAdmin, verifyToken, requireAuth } = require('../lib/supabase-admin');
const { applyCors } = require('../lib/cors');
const { enforce, clientIp } = require('../lib/rate-limit');
const { resolveUserContext } = require('../lib/user-context');

module.exports = async (req, res) => {
  if (applyCors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

  if (req.method === 'GET' && req.query?.__route === 'me') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const ctx = await resolveUserContext(supabaseAdmin, auth.user.id, auth.user.email);
    return res.status(200).json(ctx);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Rate limit: 30 AI searches / hour per user (each call hits Anthropic).
  if (!(await enforce(req, res, { bucket: 'ai-search', identifier: user.id || clientIp(req), max: 30, windowSec: 3600, failClosed: true }))) return;

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { q, products } = body;

  if (!q?.trim() || q.trim().length < 2) return res.status(400).json({ error: 'Query too short' });
  if (!Array.isArray(products) || !products.length) return res.status(400).json({ error: 'Products list required' });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Take as many candidate products as fit a token-safe character budget. The
  // client sends them pre-ranked by relevance, so the most relevant arrive
  // first; Haiku's large context lets us consider far more than the old 150 cap
  // (which, on a multi-thousand-product catalog, hid almost everything).
  const MAX_CHARS = 100000;
  let productList = '';
  for (const p of products) {
    const line = `${p.pid}|${p.name}|${p.unit}|${p.cat}\n`;
    if (productList.length + line.length > MAX_CHARS) break;
    productList += line;
  }
  productList = productList.trimEnd();

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: `You are the search engine for Costarax, a B2B foodservice procurement platform in the Philippines (restaurants, hotels, caterers). Suppliers range from local wet-market traders to premium importers (wagyu, caviar, Italian/French/Japanese specialties).
Given a buyer query and a catalog, return the product IDs that genuinely satisfy the intent — best match first.
Understand: English + Filipino/Tagalog synonyms (bangus=milkfish, hipon=shrimp, baboy=pork, manok=chicken), Italian/French/Japanese food terms, brands, cuts & grades (ribeye, tenderloin, MS6-7, A5 wagyu), and COOKING CONTEXTS — e.g. "ingredients for carbonara" → guanciale/pancetta, pecorino/parmesan, eggs, pasta; "sinigang" → pork or fish, tamarind/sampalok, vegetables; "for grilling" → steaks, sausages. Handle dietary needs and price/size hints, and tolerate typos.
Rank by how well each product fits the intent and DROP irrelevant ones. If nothing fits, return an empty list.
Return ONLY valid JSON: {"pids":["pid1","pid2",...],"intent":"short restatement of what the buyer wants"}.
Max 24 pids, best first. No prose — just the JSON.`,
      messages: [{
        role: 'user',
        content: `Catalog (pid|name|unit|category):\n${productList}\n\nBuyer query: "${q.trim()}"\n\nReturn the matching product IDs as JSON, best match first.`
      }]
    });

    const text = msg.content[0]?.text?.trim() || '';
    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonStr) return res.status(200).json({ pids: [], intent: '' });

    const result = JSON.parse(jsonStr);
    return res.status(200).json({
      pids: Array.isArray(result.pids) ? result.pids : [],
      intent: typeof result.intent === 'string' ? result.intent : ''
    });
  } catch (e) {
    console.error('AI search error:', e.message);
    return res.status(200).json({ pids: [], intent: '' });
  }
};
