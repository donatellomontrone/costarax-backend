const Anthropic = require('@anthropic-ai/sdk');
const { supabaseAdmin, verifyToken, requireAuth } = require('../lib/supabase-admin');
const { applyCors } = require('../lib/cors');
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

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { q, products } = body;

  if (!q?.trim() || q.trim().length < 2) return res.status(400).json({ error: 'Query too short' });
  if (!Array.isArray(products) || !products.length) return res.status(400).json({ error: 'Products list required' });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const productList = products.slice(0, 150)
    .map(p => `${p.pid}|${p.name}|${p.unit}|${p.cat}`)
    .join('\n');

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: `You are a product search assistant for a Filipino foodservice procurement platform (restaurants, hotels, catering).
Match buyer search queries to product IDs from the list. Understand Filipino terms, cooking contexts, and ingredient synonyms.
Return ONLY valid JSON: {"pids":["pid1","pid2"],"intent":"what the buyer is looking for"}.
Be inclusive — if someone asks for "sinigang ingredients" return all relevant products (pork/fish, vegetables, tamarind, etc.).
Max 12 pids. No explanation, just the JSON.`,
      messages: [{
        role: 'user',
        content: `Available products (pid|name|unit|category):\n${productList}\n\nBuyer query: "${q.trim()}"\n\nReturn matching product IDs as JSON.`
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
