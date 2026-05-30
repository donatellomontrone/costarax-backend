const Anthropic = require('@anthropic-ai/sdk');
const { applyCors } = require('../lib/cors');
const { enforce, clientIp } = require('../lib/rate-limit');
const { supabaseAdmin, verifyToken } = require('../lib/supabase-admin');
const { resolveUserContext } = require('../lib/user-context');

const SYSTEM = `You are the Costarax support assistant — helpful, concise, and direct.

Costarax is a private B2B procurement intelligence platform for foodservice businesses in the Philippines.

Key facts:
- Connects foodservice buyers (restaurants, hotels, canteens, catering, retail food shops) with verified suppliers and distributors
- Buyers can search 380+ suppliers, compare prices across 12,000+ AI-indexed products, and send quote requests (RFQ) directly through the platform
- Suppliers upload their price lists; AI extracts, normalizes and indexes the products automatically
- Access is by application only — every business is verified against a valid BIR/TIN registration — approval within 24h
- Free for buying businesses. Suppliers contact the team to join.
- Prices in Philippine Peso (₱). Platform in English, Filipino (Tagalog), and Chinese.
- Live at: costarax.com

How it works for buyers:
1. Apply for access (fill the form on this page)
2. Once approved, search products and compare supplier prices side by side
3. Send a quote request to one or multiple suppliers at once
4. Confirm the order, track fulfillment, leave a review

How it works for suppliers:
1. Apply as Supplier (fill the form, select Supplier/Distributor)
2. Upload your price list (PDF, Excel, photo — AI does the rest)
3. Receive quote requests from verified buyers directly on the platform
4. Reply, confirm orders, mark as fulfilled

If someone wants to sign up: tell them to fill the "Request Business Access" form on this page and select whether they are a Buyer or Supplier.
If someone has a technical issue or complaint: acknowledge it, ask for their email, and tell them the team will follow up within 24h.
If asked about pricing for suppliers: say to contact the team via the form.
Keep replies short — 2-4 sentences max unless more detail is clearly needed. No bullet lists unless the question needs a structured answer. Never make up facts.`;

// Escalation phrases — if the buyer/supplier message contains any of these we
// flip the chat to 'escalated' and stop the AI replies, so a human takes over.
const ESCALATION_RE = /\b(talk to (a )?human|real person|real human|speak to (an? )?(operator|agent|representative|manager)|customer service|live agent|live person|escalate|cs ng tao|tao naman)\b/i;

const ESCALATION_REPLY = "I've flagged this for the Costarax team — a human will jump in here as soon as one is available. Your message is saved and we'll reply on this same chat.";

// System prompt for in-app SUPPORT mode (user is already logged in).
// Different from the public landing-page prompt: no "are you buyer or supplier" —
// we already know — and points at specific in-app features.
function supportSystemPrompt(ctx) {
  const role = ctx?.role || 'buyer';
  const name = (ctx?.businessName || ctx?.supplierName || '').trim();
  const greeting = name ? `You're chatting with ${name} (${role}).` : `You're chatting with a verified ${role}.`;

  const buyerHelp = `
THE PERSON YOU'RE TALKING TO IS A BUYER. They use Costarax to:
- Compare prices: tab "Compare prices" lists products from multiple suppliers side-by-side, with a 30-day price trend sparkline + delta chip (▲ rise / ▼ drop) and a "BUY NOW / WAIT / PRICE PEAK" badge.
- Send quote requests (RFQs): click "+ Create RFQ" or click a price row to pre-fill a basket. Can send the same RFQ to multiple suppliers in one shot.
- Track quotes: tab "My quotes" shows status (Awaiting reply → Reply received → Confirmed → Fulfilled). They can confirm orders, mark received, leave reviews.
- Insights tab: spending by month, top suppliers, top products, market movers (biggest price drops/rises), Watchlist (⭐ products they track), My usuals (saved RFQ templates), Budget tracker (monthly spend caps per category).
- My account: business profile, TIN, contact info.

Useful tips you can give buyers:
- To save an RFQ for reuse: click "+ Create RFQ" → fill items → "📋 Save as template" → name it. Find it in Insights > My usuals.
- To watch a product: click the ☆ next to its name in Compare prices.
- To set a budget: Insights > Budget card > "+ Set" → pick category.`;

  const supplierHelp = `
THE PERSON YOU'RE TALKING TO IS A SUPPLIER. They use Costarax to:
- Upload price lists: tab "Products" → "⬆ Upload price list" → paste or attach. AI extracts products, prices, units automatically.
- Manage catalog: tab "Products" lets them edit, hide, delete (single or bulk), set per-item stock quantities, and download their menu as CSV.
- Add single item: in the ⋯ "More" dropdown of Products.
- Reply to quote requests: tab "Quote requests" shows incoming RFQs grouped by status.
- Activity tab: timeline of buyer interactions with search + filters.
- Analytics tab: quote demand, conversion funnel, top buyers, top products requested, price competitiveness vs market, stock health, and your own price moves over 30d. Has 7d/30d/90d/Custom date filters.
- My account: business profile, payment terms, delivery areas, contact info.

Useful tips you can give suppliers:
- To update stock: tab Products → click the stock badge of a row → enter quantity.
- To download own catalog: Products > ⋯ menu > "Download my menu".
- Bulk hide/delete products: tick the checkboxes, use the action bar.`;

  return `You are the Costarax in-app support assistant — helpful, concise, direct.

CONTEXT: ${greeting}

CRITICAL RULES — never break these:
- You ALREADY KNOW the user's role (${role}). Treat that as ground truth.
- NEVER ask "are you a buyer or supplier?", "are you a supplier wanting to…", "if you're a buyer…" or any branching question about which side of the marketplace they're on. That question is forbidden.
- NEVER list both supplier-side and buyer-side answers in the same reply. Give only the answer for a ${role}.
- If the user's question is ambiguous, default to the ${role} interpretation. Only ask for clarification on specifics (which product? which quote?), never on who they are.

ABOUT COSTARAX: A private B2B procurement intelligence platform for foodservice businesses in the Philippines. Connects buyers (restaurants, hotels, canteens) with verified suppliers. 380+ suppliers, 12,000+ AI-indexed products. Prices in ₱. UI in English / Filipino / Chinese.

${role === 'supplier' ? supplierHelp : buyerHelp}

RULES:
- Be specific. Reference the actual tab name or button they should click.
- Keep replies short: 2–3 sentences, max 4. No bullet lists unless they asked "how do I…" with multiple steps.
- Never make up product prices, supplier names, quote numbers, or counts. If a question needs data you don't have, say so and offer to escalate.
- If the user asks a question outside your scope (their company finances, legal, taxes, unrelated topics): politely redirect or offer to escalate to a human operator.
- If the user complains about a specific supplier/buyer/order: acknowledge, gather one or two clarifying details, then offer to escalate ("Want me to bring in a Costarax team member?").
- If you genuinely don't know, say "I don't know — want me to escalate this to a human?"
- Mirror the user's language (English / Filipino / mixed Taglish are all fine).`;
}

async function askAI(messagesArr, ctx) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const system = ctx ? supportSystemPrompt(ctx) : SYSTEM;
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system,
    messages: messagesArr.slice(-12).map(m => ({ role: m.role, content: String(m.content).slice(0, 1000) }))
  });
  return msg.content[0]?.text?.trim() || '';
}

// ── Persistent support mode (auth required) ────────────────────────────────
async function handleSupportMode(req, res, body) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const action = body.action;
  const { data: profile } = await supabaseAdmin
    .from('profiles').select('role').eq('id', user.id).single();
  const userRole = profile?.role || 'buyer';
  const isAdmin  = ['admin','super_admin'].includes(userRole);

  // Resolve role + display name. The frontend passes `active_role` from the
  // current URL (?role=supplier/business), which is the truth for the AI —
  // a user can hold both memberships, and they might be using the buyer UI
  // even though their primary profile is supplier (or vice-versa).
  async function resolveCtx() {
    const fullCtx = await resolveUserContext(supabaseAdmin, user.id, user.email);
    const hinted = body.active_role;
    const role =
      hinted === 'supplier' ? 'supplier' :
      hinted === 'buyer' || hinted === 'business' ? 'buyer' :
      isAdmin ? 'admin' :
      userRole === 'supplier' ? 'supplier' : 'buyer';
    return {
      role,
      businessName: fullCtx.business?.name || null,
      supplierName: fullCtx.supplier?.name || null,
    };
  }

  if (action === 'start') {
    const ctxForActions = await resolveCtx();
    const quickActionsFor = (role) => role === 'supplier'
      ? [
          { label: '📤 Upload my price list',     prompt: 'How do I upload my price list?' },
          { label: '💬 Reply to a quote request', prompt: 'How do I reply to a quote request?' },
          { label: '📦 Update stock on a product', prompt: 'How do I update the stock for one of my products?' },
          { label: '📊 See my analytics',         prompt: 'How do I see my sales analytics?' },
          { label: '👤 Talk to a human',          prompt: 'I want to talk to a human.', escalate: true },
        ]
      : [
          { label: '🔍 Compare prices for a product', prompt: 'How do I compare prices across suppliers for a product?' },
          { label: '📝 Send a quote request (RFQ)',   prompt: 'How do I send a quote request to suppliers?' },
          { label: '📋 Track my orders',              prompt: 'Where do I track my open quotes and orders?' },
          { label: '⭐ Use my watchlist',              prompt: 'How does the watchlist work?' },
          { label: '💰 Set a monthly budget',         prompt: 'How do I set a budget for a category?' },
          { label: '👤 Talk to a human',              prompt: 'I want to talk to a human.', escalate: true },
        ];

    // Find an existing open chat for this user; if none, create one.
    const { data: existing } = await supabaseAdmin
      .from('support_chats')
      .select('id, status, started_at')
      .eq('user_id', user.id)
      .neq('status', 'closed')
      .order('last_message_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      // Decide whether to show quick actions for a returning chat: only when
      // the user hasn't typed anything yet (only the AI greeting exists).
      const { count: userMsgs } = await supabaseAdmin
        .from('support_messages').select('id', { count: 'exact', head: true })
        .eq('chat_id', existing.id).eq('sender', 'user');
      const includeActions = (userMsgs || 0) === 0;
      return res.status(200).json({
        chat: existing,
        quick_actions: includeActions ? quickActionsFor(ctxForActions.role) : []
      });
    }
    const ctx = ctxForActions;
    const { data: created, error } = await supabaseAdmin
      .from('support_chats')
      .insert({ user_id: user.id, user_role: ctx.role })
      .select('id, status, started_at')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    // Personalised opening greeting.
    const name = (ctx.businessName || ctx.supplierName || '').trim();
    const firstName = name ? name.split(/\s+/)[0] : '';
    const orgLabel  = name ? ` from ${name}` : '';
    const greeting = ctx.role === 'supplier'
      ? `Hi${firstName ? ` ${firstName}` : ''}! I'm here to help${orgLabel} with your catalog, quote requests, analytics or anything Costarax-related. Pick a topic below or just type your question.`
      : `Hi${firstName ? ` ${firstName}` : ''}! I'm here to help${orgLabel} with finding suppliers, comparing prices, RFQs or your account. Pick a topic below or just type your question.`;
    await supabaseAdmin.from('support_messages').insert({
      chat_id: created.id, sender: 'ai', body: greeting
    });
    return res.status(200).json({ chat: created, quick_actions: quickActionsFor(ctx.role), greeting });
  }

  if (action === 'fetch') {
    const chatId = Number(body.chat_id);
    if (!chatId) return res.status(400).json({ error: 'chat_id required' });
    const { data: chat } = await supabaseAdmin
      .from('support_chats').select('id, status, assigned_admin').eq('id', chatId).single();
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    // Only owner or admin can read.
    const { data: ownerCheck } = await supabaseAdmin
      .from('support_chats').select('user_id').eq('id', chatId).single();
    if (ownerCheck?.user_id !== user.id && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const { data: msgs } = await supabaseAdmin
      .from('support_messages').select('id, sender, body, created_at')
      .eq('chat_id', chatId).order('created_at', { ascending: true });
    return res.status(200).json({ chat, messages: msgs || [] });
  }

  if (action === 'send') {
    const chatId = Number(body.chat_id);
    const text   = String(body.text || '').trim().slice(0, 2000);
    if (!chatId || !text) return res.status(400).json({ error: 'chat_id and text required' });

    const { data: chat } = await supabaseAdmin
      .from('support_chats').select('id, user_id, status').eq('id', chatId).single();
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    if (chat.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (chat.status === 'closed') return res.status(400).json({ error: 'Chat is closed' });

    // Save the user message.
    await supabaseAdmin.from('support_messages').insert({ chat_id: chatId, sender: 'user', body: text });
    await supabaseAdmin.from('support_chats').update({ last_message_at: new Date().toISOString() }).eq('id', chatId);

    // Detect escalation in the message.
    const escalateNow = ESCALATION_RE.test(text) || body.force_escalate === true;
    if (escalateNow && chat.status === 'ai') {
      await supabaseAdmin.from('support_chats').update({ status: 'escalated' }).eq('id', chatId);
      await supabaseAdmin.from('support_messages').insert({ chat_id: chatId, sender: 'system', body: ESCALATION_REPLY });
      return res.status(200).json({ escalated: true, reply: ESCALATION_REPLY });
    }

    // If already escalated, do NOT call AI — just save and wait for admin.
    if (chat.status === 'escalated') {
      return res.status(200).json({ waiting_for_human: true });
    }

    // Otherwise, AI replies. Pull recent history (last 20 messages).
    const { data: history } = await supabaseAdmin
      .from('support_messages').select('sender, body')
      .eq('chat_id', chatId).order('created_at', { ascending: true }).limit(20);
    const conv = (history || [])
      .filter(m => ['user','ai','admin'].includes(m.sender))
      .map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.body }));

    if (!process.env.ANTHROPIC_API_KEY) {
      const fallback = "I can't reach the AI right now — I've saved your message and the Costarax team will follow up shortly.";
      await supabaseAdmin.from('support_messages').insert({ chat_id: chatId, sender: 'system', body: fallback });
      await supabaseAdmin.from('support_chats').update({ status: 'escalated' }).eq('id', chatId);
      return res.status(200).json({ reply: fallback, escalated: true });
    }

    try {
      const ctx = await resolveCtx();
      const aiReply = await askAI(conv, ctx);
      await supabaseAdmin.from('support_messages').insert({ chat_id: chatId, sender: 'ai', body: aiReply });
      return res.status(200).json({ reply: aiReply });
    } catch (e) {
      console.error('AI reply error:', e.message);
      const fallback = "I'm having trouble right now — I've flagged this so a human can help.";
      await supabaseAdmin.from('support_messages').insert({ chat_id: chatId, sender: 'system', body: fallback });
      await supabaseAdmin.from('support_chats').update({ status: 'escalated' }).eq('id', chatId);
      return res.status(200).json({ reply: fallback, escalated: true });
    }
  }

  if (action === 'admin_reply') {
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
    const chatId = Number(body.chat_id);
    const text   = String(body.text || '').trim().slice(0, 2000);
    if (!chatId || !text) return res.status(400).json({ error: 'chat_id and text required' });
    await supabaseAdmin.from('support_messages').insert({ chat_id: chatId, sender: 'admin', body: text });
    await supabaseAdmin.from('support_chats').update({
      assigned_admin: user.id, status: 'escalated', last_message_at: new Date().toISOString()
    }).eq('id', chatId);
    return res.status(200).json({ ok: true });
  }

  if (action === 'close') {
    const chatId = Number(body.chat_id);
    if (!chatId) return res.status(400).json({ error: 'chat_id required' });
    const { data: chat } = await supabaseAdmin
      .from('support_chats').select('user_id').eq('id', chatId).single();
    if (chat?.user_id !== user.id && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
    await supabaseAdmin.from('support_chats').update({ status: 'closed' }).eq('id', chatId);
    return res.status(200).json({ ok: true });
  }

  if (action === 'admin_list') {
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
    const { data } = await supabaseAdmin
      .from('support_chats')
      .select('id, user_id, user_role, status, assigned_admin, started_at, last_message_at')
      .neq('status', 'closed')
      .order('status', { ascending: true })  // 'escalated' before 'ai'
      .order('last_message_at', { ascending: false })
      .limit(50);
    return res.status(200).json({ chats: data || [] });
  }

  return res.status(400).json({ error: 'unknown action' });
}

module.exports = async (req, res) => {
  if (applyCors(req, res, { methods: 'POST,OPTIONS' })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  // ── Persistent / authenticated support mode ──
  if (body.mode === 'support') return handleSupportMode(req, res, body);

  // ── Stateless landing-page Q&A (existing behaviour) ──
  // Rate limit: 20 messages / hour per IP (chat is public + costs money per call).
  if (!(await enforce(req, res, { bucket: 'chat', identifier: clientIp(req), max: 20, windowSec: 3600 }))) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(200).json({ reply: "Hi! I'm the Costarax assistant. Our AI support is being set up — in the meantime, fill the access request form on this page and our team will get back to you within 24h." });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];

  if (!messages.length) return res.status(400).json({ error: 'messages required' });

  const safe = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-12)
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 800) }));

  try {
    const reply = await askAI(safe);
    return res.status(200).json({ reply });
  } catch (e) {
    console.error('Chat error:', e.message);
    return res.status(500).json({ error: 'AI unavailable', reply: "Sorry, I'm having trouble right now. Please fill the access request form and our team will reach you within 24h." });
  }
};
