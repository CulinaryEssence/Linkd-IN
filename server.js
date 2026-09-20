/**
 * LinkedIn Poster — self-hosted approval workflow with AI formatting & prompt transformation.
 */

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS + CSP headers to prevent browser blocked-request errors
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header(
    'Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data:; connect-src 'self' https:;"
  );
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

const TOKEN_FILE = path.join(__dirname, 'token-store.json');
const DRAFTS_FILE = path.join(__dirname, 'drafts.json');
const IMAGES_DIR = path.join(__dirname, 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ---------- Local JSON Database Storage ----------
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
// Storage: in-memory cache, written through to Redis/Valkey (REDIS_URL) when configured so data
// survives Render redeploys; local JSON files remain as a fallback.
const REDIS_URL = process.env.REDIS_URL;
let redis = null;
const cache = { drafts: null, token: null };

async function initStorage() {
  if (REDIS_URL) {
    try {
      const { createClient } = require('redis');
      redis = createClient({ url: REDIS_URL });
      redis.on('error', e => console.error('redis error:', e.message));
      await redis.connect();
      const d = await redis.get('lp:drafts');
      const t = await redis.get('lp:token');
      cache.drafts = d ? JSON.parse(d) : null;
      cache.token = t ? JSON.parse(t) : null;
      console.log('Storage: Redis connected');
    } catch (e) {
      console.error('Redis unavailable, using local files only:', e.message);
      redis = null;
    }
  }
  if (cache.drafts === null) cache.drafts = readJSON(DRAFTS_FILE, []);
  if (cache.token === null) cache.token = readJSON(TOKEN_FILE, null);
  if (redis) {
    await redis.set('lp:drafts', JSON.stringify(cache.drafts));
    if (cache.token) await redis.set('lp:token', JSON.stringify(cache.token));
  }
}
function persist(key, file, value) {
  try { writeJSON(file, value); } catch (e) { /* read-only disk is fine when Redis is used */ }
  if (redis) redis.set(key, JSON.stringify(value)).catch(e => console.error('redis write failed:', e.message));
}
function getToken() { return cache.token; }
function saveToken(token) { cache.token = token; persist('lp:token', TOKEN_FILE, token); }
function getDrafts() { return cache.drafts || []; }
function saveDrafts(drafts) { cache.drafts = drafts; persist('lp:drafts', DRAFTS_FILE, drafts); }

// ---------- Auth: 30-day login cookie (phone-friendly) or HTTP Basic (curl/API) ----------
app.set('trust proxy', 1);
const SESSION_DAYS = 30;
function sign(v) {
  return crypto.createHmac('sha256', 'lp-session:' + (DASHBOARD_PASSWORD || '')).update(v).digest('hex');
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function makeSession() {
  const exp = String(Date.now() + SESSION_DAYS * 86400000);
  return exp + '.' + sign(exp);
}
function validSession(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)lp_session=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig) return false;
  const good = sign(exp);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  return Number(exp) > Date.now();
}
function requireDashboardAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) return res.status(500).send('DASHBOARD_PASSWORD is not set on the server.');
  if (validSession(req)) return next();
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(pass, DASHBOARD_PASSWORD)) return next();
  }
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return res.redirect('/login');
  return res.status(401).json({ error: 'Authentication required.' });
}

const loginFails = new Map();
function loginPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="LinkedIn Poster">
<title>LinkedIn Poster - Login</title>
<style>body{font-family:sans-serif;max-width:360px;margin:20vh auto;padding:0 16px;}
input,button{width:100%;padding:12px;font-size:16px;margin-top:10px;box-sizing:border-box;border-radius:6px;}
button{background:#1a7f37;color:#fff;border:none;} .err{color:#c53030;}</style></head>
<body><h2>LinkedIn Poster</h2>${msg ? `<p class="err">${msg}</p>` : ''}
<form method="POST" action="/login">
<input type="text" name="username" value="u" autocomplete="username" style="display:none">
<input type="password" name="password" placeholder="Dashboard password" autocomplete="current-password" autofocus required>
<button type="submit">Log in</button></form></body></html>`;
}
// Unauthenticated health check (for uptime pings that keep the free Render instance awake)
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/login', (req, res) => res.send(loginPage('')));
app.post('/login', (req, res) => {
  const ip = req.ip;
  const rec = loginFails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - rec.t > 600000) { rec.n = 0; rec.t = Date.now(); }
  if (rec.n >= 5) return res.status(429).send(loginPage('Too many attempts. Try again in 10 minutes.'));
  const pass = (req.body && req.body.password) || '';
  if (DASHBOARD_PASSWORD && safeEqual(pass, DASHBOARD_PASSWORD)) {
    loginFails.delete(ip);
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `lp_session=${makeSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
    return res.redirect('/');
  }
  rec.n++; loginFails.set(ip, rec);
  return res.status(401).send(loginPage('Wrong password.'));
});

// ---------- Google Gemini helpers (used when GEMINI_API_KEY is set) ----------
const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models/';
async function geminiGenerate(model, body) {
  const r = await fetch(`${GEMINI_BASE}${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || `Gemini HTTP ${r.status}`);
  return data;
}
async function geminiText(system, user) {
  const model = process.env.GEMINI_TEXT_MODEL || 'gemini-3.6-flash';
  const data = await geminiGenerate(model, {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }]
  });
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.map(p => p.text || '').join('').trim();
}
async function geminiImage(prompt) {
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const data = await geminiGenerate(model, {
    contents: [{ role: 'user', parts: [{ text: prompt.slice(0, 8000) + '\n\nGenerate a 1:1 square image.' }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
  });
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const img = parts.find(p => (p.inlineData || p.inline_data));
  if (!img) throw new Error('Gemini returned no image (' + model + ')');
  return Buffer.from((img.inlineData || img.inline_data).data, 'base64');
}

// =====================================================================
// AI Transformation Step 1: Technical Visual Prompt Generator
// =====================================================================
// Saved house style: makes generated images look like real, natural photographs.
const NATURAL_PHOTO_STYLE = 'Candid documentary photograph taken on a real phone or DSLR in an actual working commercial kitchen. Natural window light mixed with ordinary overhead kitchen light, soft real shadows, slightly uneven exposure. Worn wooden or scratched stainless steel surface with water droplets, flour dust, small crumbs and fingerprints. Irregular natural shapes and colors, accurate food texture with visible grain and pores, muted true-to-life colors, matte natural finish, natural depth of field, gentle film grain, slightly off-center snapshot composition, square 1:1 frame.';

// Three-stage prompt builder: (1) pull the physical facts out of the post, (2) write a prompt that
// states each fact as a hard requirement, (3) audit the prompt against the facts and fix any gap.
function parseJson(t) {
  return JSON.parse(String(t).replace(/```json|```/g, '').trim());
}

async function composeFaithfulPrompt(postText, sink) {
  const factsRaw = await geminiText(
    `You are a food scientist and a commercial food photographer. Read the post and decide what a camera must capture so a chef understands the lesson from the picture alone.
Reply ONLY as JSON:
{"lesson":"one sentence",
 "layout":"how the finished graphic is assembled, e.g. two separate photos joined side by side, left = mistake, right = correct",
 "setting":"real kitchen surface and equipment named in the post",
 "states":[{
   "label":"short English label of this state, e.g. MISTAKE: air-exposed",
   "subject":"exact food/equipment",
   "identity_features":"the features that make this subject instantly recognisable and unmistakable versus look-alikes (e.g. meringue: stiff white foam standing in upright sharp curled peaks, matte-satin, piped swirls or baked crisp shell with pale gold tips)",
   "confusable_with":"look-alike foods an image model may wrongly draw (e.g. custard, whipped cream, pudding)",
   "visual_anchors":"POSITIVE-ONLY description of how this state looks in real life, including strong degree, with familiar colour references and texture (e.g. avocado air-exposed for 4 hours: flesh the colour of strong tea to dark milk chocolate, dry matte surface, slightly sunken and wrinkled, dark brown almost black at the edges)",
   "how_to_recreate":"how a cook would produce this exact state for a real photo"}]}
Use true physics and chemistry from the post. English only.`,
    postText
  );
  const facts = parseJson(factsRaw);
  if (sink) sink.facts = facts;
  const compose = async (sys, user) => parseJson(await geminiText(sys, user));
  const panelRules = `Write ONE standalone image-generation prompt PER state, as JSON {"panels":[{"label":"...","prompt":"..."}]}. Rules, all mandatory:
- One subject in one state per prompt. Never put two states or a comparison inside one prompt (image models blend them).
- Start with the subject's identity_features so it is recognised as the right food, then the visual_anchors with their colour references and degree. Say the degree strongly (deep, dark, obvious).
- POSITIVE wording only. Never write "not", "no", "without" or mention what the food must not look like, because naming the unwanted thing makes the model draw it. Never mention the look-alike foods.
- Tight close-up framing so the food fills most of the frame and the key surface detail is large.
- Use the identical lighting, surface, lens and angle wording in every panel so the pair matches when placed side by side.
- Realistic natural photograph of the real food. No text, letters, numbers or logos.
- English only.`;
  let panels = await compose(panelRules, JSON.stringify(facts));
  panels = await compose(
    `Audit these panel prompts against the facts. For each panel verify: (1) exactly one subject and one state, (2) identity_features present so the food cannot be mistaken for its look-alikes, (3) visual_anchors present with strong degree and colour references, (4) no negations and no mention of look-alikes, (5) framing, lighting and surface wording identical across panels. Fix any gap and return the same JSON shape {"panels":[{"label":"...","prompt":"..."}]}. Output ONLY JSON.`,
    `FACTS:\n${JSON.stringify(facts)}\n\nPANELS:\n${JSON.stringify(panels)}`
  );
  const list = (panels.panels || []).filter(x => x && x.prompt);
  if (!list.length) throw new Error('no panels');
  if (sink) sink.panels = list;
  return list.map(x => `${x.label}: ${x.prompt}`).join('\n\n');
}

async function createVisualPrompt(postText, sink) {
  const systemInstruction = `
    You are an expert technical visual graphic designer for professional culinary, food science, and hospitality management content.
    Analyze the provided post text and construct an explicit visual prompt for an image generator.

    YOUR JOB: turn the post into ONE natural, real-looking photograph that a busy chef or restaurant manager understands in 3 seconds and that teaches the post's main idea without any words.

    METHOD (do this silently, output only the final prompt):
    1. Extract the post's single core lesson and the 3 to 5 most concrete things it names (specific ingredients, equipment, temperatures, times, the mistake and the fix).
    2. Show the lesson as a real before/after or side-by-side comparison of the actual subject (for example: two halves of the same avocado, one browned after air exposure, one protected with lime juice and plastic wrap, on the same board). The difference must be obvious and physically accurate.
    3. Look like an authentic documentary photograph from a real working kitchen, NOT a glossy render (a full style paragraph is appended automatically, so focus your prompt on WHAT is in the frame): shot on a full-frame camera, 50mm lens, natural window light mixed with kitchen light, slightly imperfect real surfaces (scratched steel, worn wooden board, a few crumbs, water droplets), true-to-life colors and textures, realistic scale, visible pores and cell texture in the food, gentle film grain. Avoid: plastic-looking or over-smooth surfaces, oversaturated colors, perfect symmetry, glowing edges, floating objects, distorted hands or fruit shapes.
    4. NO TEXT of any kind in the image: no words, no letters, no numbers, no labels, no logos, no captions, no signs, no packaging print.
    5. Every object in the frame must come from the post. No generic stock imagery, no chefs holding plates.

    FORMAT: 1:1 square, sharp focus, one clear focal subject.

    Write the prompt as one dense paragraph describing exactly what appears in the frame, the camera, the light and the surfaces.

    Output ONLY the final descriptive image generator prompt text.
  `;

  if (process.env.GEMINI_API_KEY) {
    try {
      const faithful = await composeFaithfulPrompt(postText, sink);
      if (faithful) return faithful;
    } catch (e) {
      console.error('faithful prompt failed, using simple prompt:', e.message);
    }
    try {
      const out = await geminiText(systemInstruction, `Generate visual prompt for:\n"${postText}"`);
      if (out) return out;
    } catch (e) {
      console.error('Gemini visual prompt failed:', e.message);
    }
  }
  try {
    if (!process.env.OPENAI_API_KEY) return postText;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: `Generate visual prompt for:\n"${postText}"` }
        ]
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || postText;
  } catch (e) {
    console.error('createVisualPrompt failed:', e);
    return postText;
  }
}

// =====================================================================
// AI Transformation Step 2: Technical LinkedIn Post Formatter
// =====================================================================
async function formatLinkedInPost(rawInput) {
  const systemInstruction = `
    You are an elite technical culinary AI collaborator formatting content for LinkedIn.
    Refine the provided raw input into a highly structured, professional technical post adhering strictly to:

    STRICT FORMATTING RULES:
    1. ZERO EMOJIS OR SMILEYS. Keep typography clean and strictly professional.
    2. SCROLL-STOPPING HOOK: Start immediately with a counterintuitive operational truth or common industry mistake in line 1.
    3. HARD TERMS EXPLAINED SIMPLY: Break down complex food science terms using real-world analogies.
    4. CONCRETE KITCHEN EXAMPLES: Include specific equipment names, exact temperatures, dimensions, or precise ingredient specs.
    5. SCANNABLE LAYOUT: Use bold section titles, horizontal rules (---), concise bullet points, and LaTeX notation ($Q = mc\\Delta T$).
    6. ACTIONABLE STEPS & PITFALLS: Provide clear numbered execution steps and explicit common errors to avoid.
    7. THE GOLDEN RULE: Include a distinct 1-line process formula near the bottom.
    8. ENGAGEMENT QUESTION: End with a specific operational question targeted at culinary directors and managers.
  `;

  try {
    if (!process.env.OPENAI_API_KEY) return rawInput;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: `Format post:\n"${rawInput}"` }
        ]
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || rawInput;
  } catch (e) {
    console.error('formatLinkedInPost failed:', e);
    return rawInput;
  }
}

// ---------- OAuth Routes ----------
app.get('/auth/linkedin', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const scope = encodeURIComponent('openid profile w_member_social');
  const url = `https://www.linkedin.com/oauth/v2/authorization` +
    `?response_type=code` +
    `&client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${state}` +
    `&scope=${scope}`;
  res.redirect(url);
});

app.get('/auth/linkedin/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) return res.status(400).send(`LinkedIn auth failed: ${error_description || error}`);

  try {
    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(400).send(`Token exchange failed: ${JSON.stringify(tokenData)}`);
    }

    const meRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const me = await meRes.json();
    const personUrn = `urn:li:person:${me.sub}`;

    saveToken({
      access_token: tokenData.access_token,
      expires_at: Date.now() + (tokenData.expires_in * 1000),
      person_urn: personUrn,
      name: me.name || null
    });

    res.send(`
      <h2>Connected ✓</h2>
      <p>LinkedIn account <strong>${me.name || ''}</strong> is authorized.</p>
      <p><a href="/">Return to Dashboard</a></p>
    `);
  } catch (e) {
    res.status(500).send('OAuth exchange error: ' + e.message);
  }
});

// ---------- API Routes ----------
app.get('/api/status', requireDashboardAuth, (req, res) => {
  const token = getToken();
  res.json({ connected: !!token, name: token ? token.name : null });
});

app.get('/api/drafts', requireDashboardAuth, (req, res) => {
  res.json(getDrafts());
});

app.post('/api/drafts', requireDashboardAuth, async (req, res) => {
  const { text, imageUrl } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  const formattedPostText = await formatLinkedInPost(text);
  let finalPrompt = formattedPostText;
  if (!imageUrl) {
    finalPrompt = await createVisualPrompt(formattedPostText);
  }

  const drafts = getDrafts();
  const draft = {
    id: crypto.randomUUID(),
    text: formattedPostText,
    visualPrompt: finalPrompt,
    imageUrl: imageUrl || null,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  drafts.unshift(draft);
  saveDrafts(drafts);
  res.json(draft);
});

app.patch('/api/drafts/:id', requireDashboardAuth, (req, res) => {
  const drafts = getDrafts();
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'not found' });
  if (req.body.text !== undefined) draft.text = req.body.text;
  if (req.body.imageUrl !== undefined) draft.imageUrl = req.body.imageUrl;
  if (req.body.visualPrompt !== undefined) draft.visualPrompt = req.body.visualPrompt;
  if (req.body.texturePrompt !== undefined) draft.texturePrompt = req.body.texturePrompt;
  saveDrafts(drafts);
  res.json(draft);
});

app.delete('/api/drafts/:id', requireDashboardAuth, (req, res) => {
  let drafts = getDrafts();
  drafts = drafts.filter(d => d.id !== req.params.id);
  saveDrafts(drafts);
  res.json({ ok: true });
});

// ---------- Bulk Upgrade Admin Endpoint ----------
app.post('/api/admin/upgrade-all-posts', requireDashboardAuth, async (req, res) => {
  try {
    let drafts = getDrafts();
    let updatedCount = 0;

    for (let i = 0; i < drafts.length; i++) {
      if (drafts[i].status !== 'posted') {
        const formattedText = await formatLinkedInPost(drafts[i].text);
        const visualPrompt = await createVisualPrompt(formattedText);

        drafts[i].text = formattedText;
        drafts[i].visualPrompt = visualPrompt;
        drafts[i].updatedAt = new Date().toISOString();
        updatedCount++;
      }
    }

    saveDrafts(drafts);
    res.json({ success: true, upgraded: updatedCount });
  } catch (e) {
    console.error('Bulk upgrade failed:', e);
    res.status(500).json({ error: 'Failed to upgrade posts' });
  }
});

// ---------- Bulk Import: 100 Days posts (no AI rewrite) ----------
// POST /api/admin/import-posts  body (optional): { "startDate": "YYYY-MM-DD" }
// Loads every post in posts/culinary_essence_100_days.md as a pending draft, text kept exactly as written.
// Safe to re-run: days already imported are skipped. Nothing posts without "Approve & Post".
app.post('/api/admin/import-posts', requireDashboardAuth, (req, res) => {
  try {
    const src = fs.readFileSync(path.join(__dirname, 'posts', 'culinary_essence_100_days.md'), 'utf8');
    const blocks = src.split(/^---\s*$/m).map(b => b.trim()).filter(b => /^## Day /.test(b));
    const start = req.body && req.body.startDate ? new Date(req.body.startDate + 'T09:00:00+04:00') : null;
    const drafts = getDrafts();
    const existing = new Set(drafts.map(d => d.day).filter(Boolean));
    const added = [];

    blocks.forEach((block, i) => {
      const m = block.match(/^## (Day [\d &]+): (.*)\n+([\s\S]*)$/);
      if (!m) return;
      const day = m[1], title = m[2].trim(), text = m[3].trim();
      if (existing.has(day)) return;
      const draft = {
        id: crypto.randomUUID(),
        day, title, text,
        visualPrompt: null,
        imageUrl: null,
        status: 'pending',
        createdAt: new Date().toISOString(),
        order: i + 1
      };
      if (start) {
        // Day 5 & 6 is one post, so schedule by list position, not day number
        draft.scheduledFor = new Date(start.getTime() + i * 86400000).toISOString();
      }
      added.push(draft);
    });

    added.sort((a, b) => b.order - a.order).forEach(d => drafts.unshift(d));
    saveDrafts(drafts);
    res.json({ success: true, imported: added.length, skipped: blocks.length - added.length });
  } catch (e) {
    console.error('Import failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- AI Image Generation (from draft text) ----------
async function saveImageBuffer(name, buf) {
  fs.writeFileSync(path.join(IMAGES_DIR, name), buf);
  if (redis) await redis.set('lp:img:' + name, buf.toString('base64'), { EX: 14 * 86400 }).catch(e => console.error('redis image write failed:', e.message));
}
async function loadImageBuffer(imageUrl) {
  const name = path.basename(imageUrl);
  const f = path.join(IMAGES_DIR, name);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  if (redis) {
    const b64 = await redis.get('lp:img:' + name);
    if (b64) { const buf = Buffer.from(b64, 'base64'); fs.writeFileSync(f, buf); return buf; }
  }
  return null;
}

async function requestImage(model, prompt) {
  const body = { model, prompt: prompt.slice(0, 3900), size: '1024x1024', n: 1 };
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok || !data.data || !data.data[0]) {
    throw new Error((data.error && data.error.message) || 'Image generation failed');
  }
  const item = data.data[0];
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) return await (await fetch(item.url)).buffer();
  throw new Error('No image returned');
}

async function cfImage(prompt) {
  const url = process.env.CF_IMAGE_WORKER_URL;
  const secret = process.env.CF_IMAGE_WORKER_SECRET;
  if (!url || !secret) throw new Error('CF_IMAGE_WORKER_URL/CF_IMAGE_WORKER_SECRET not set');
  const p = String(prompt).replace(/\s+/g, ' ').slice(0, 450) + ' ' + NATURAL_PHOTO_STYLE;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: p })
  });
  if (!r.ok) throw new Error(`worker ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  if (!d || !d.image) throw new Error('worker returned no image');
  return Buffer.from(d.image, 'base64');
}

app.get('/images/:file', requireDashboardAuth, async (req, res) => {
  const buf = await loadImageBuffer(req.params.file);
  if (!buf) return res.status(404).end();
  res.type('png').send(buf);
});

const TEXTURE_FIX_TEMPLATE = 'Image 1 is the picture to edit. Image 2 is a real photograph used only as a texture reference. Keep image 1 exactly the same: composition, camera angle, lighting, background, surfaces and every object stay unchanged. Only re-render the surface of {SUBJECTS} so it matches the real texture in image 2: {TRAITS}. No glossy or plastic sheen, no smooth gradients, no perfect symmetry. Do not add any text.';

async function createTexturePrompt(postText) {
  const fallback = TEXTURE_FIX_TEMPLATE.replace('{SUBJECTS}', 'the main food items').replace('{TRAITS}', 'natural uneven color, fine moist grain, tiny pores and irregular edges, true-to-life dull tones');
  if (!process.env.GEMINI_API_KEY) return fallback;
  try {
    const out = await geminiText(
      'You write image-edit instructions. From the post, identify the main food items shown in a photo of it and the real-world surface texture traits of each (e.g. oxidized avocado: uneven brown patches, moist fine grain, dull matte surface). Reply ONLY as JSON: {"subjects":"...","traits":"..."} in English, subjects as a short phrase, traits as a comma-separated list of 5 to 8 concrete natural texture details.',
      postText
    );
    const j = JSON.parse(String(out).replace(/```json|```/g, '').trim());
    if (j.subjects && j.traits) return TEXTURE_FIX_TEMPLATE.replace('{SUBJECTS}', j.subjects).replace('{TRAITS}', j.traits);
  } catch (e) { console.error('texture prompt failed:', e.message); }
  return fallback;
}

app.post('/api/drafts/:id/visual-prompt', requireDashboardAuth, async (req, res) => {
  const drafts = getDrafts();
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'not found' });
  try {
    const sink = {};
    const vp = (await createVisualPrompt(draft.text, sink)).trim();
    draft.facts = sink.facts || null;
    draft.panels = sink.panels || null;
    draft.visualPrompt = vp + '\n\nApply to every image: ' + NATURAL_PHOTO_STYLE;
    draft.texturePrompt = await createTexturePrompt(draft.text);
    saveDrafts(drafts);
    res.json({ ok: true, visualPrompt: draft.visualPrompt });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/drafts/:id/upload-image', requireDashboardAuth, express.json({ limit: '15mb' }), async (req, res) => {
  const drafts = getDrafts();
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'not found' });
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(String(req.body && req.body.data || ''));
  if (!m) return res.status(400).json({ error: 'Send a PNG or JPG image.' });
  const name = `${draft.id}-${Date.now()}.png`;
  await saveImageBuffer(name, Buffer.from(m[2], 'base64'));
  draft.imageUrl = '/images/' + name;
  saveDrafts(drafts);
  res.json({ ok: true, imageUrl: draft.imageUrl });
});

app.post('/api/drafts/:id/check-image', requireDashboardAuth, async (req, res) => {
  const drafts = getDrafts();
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft || !draft.imageUrl) return res.status(400).json({ error: 'Attach an image first.' });
  if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: 'GEMINI_API_KEY is needed for the image check.' });
  try {
    const buf = await loadImageBuffer(draft.imageUrl.split('/').pop());
    if (!buf) throw new Error('Image file not found.');
    const facts = draft.facts || { lesson: draft.text.slice(0, 300) };
    const model = process.env.GEMINI_TEXT_MODEL || 'gemini-3.6-flash';
    const data = await geminiGenerate(model, {
      systemInstruction: { parts: [{ text: 'You are a strict food-photography QA reviewer for a professional culinary brand. Judge whether the image teaches the post correctly. Reply ONLY as JSON: {"verdict":"PASS or FAIL","issues":["specific problem..."],"stronger_prompt":"a corrected image prompt: one subject per state, positive wording only, strong colour anchors, or empty string if PASS"}. Check: (1) is each required subject clearly the right food, not a look-alike; (2) does each state show the required appearance with sufficient strength (for example, oxidised flesh must be clearly dark brown, not fresh-looking); (3) does it look like a real natural photograph, not AI-generated (plastic sheen, smooth textures, warped shapes, invented text); (4) any text in the image must be correct English.' }] },
      contents: [{ role: 'user', parts: [
        { text: 'POST:\n' + draft.text.slice(0, 2500) + '\n\nREQUIRED FACTS:\n' + JSON.stringify(facts) },
        { inlineData: { mimeType: 'image/png', data: buf.toString('base64') } }
      ] }]
    });
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const result = parseJson(parts.map(x => x.text || '').join(''));
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/drafts/:id/generate-image', requireDashboardAuth, async (req, res) => {
  if (!process.env.CF_IMAGE_WORKER_URL && !process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'No image provider configured.' });
  const drafts = getDrafts();
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'not found' });

  try {
    const prompt = draft.visualPrompt || await createVisualPrompt(draft.text);
    let buf = null;
    const errors = [];
    if (process.env.CF_IMAGE_WORKER_URL) {
      try {
        buf = await cfImage(prompt);
      } catch (e) {
        console.error('cf image failed: ' + e.message);
        errors.push('cf: ' + e.message);
      }
    }
    if (!buf && process.env.GEMINI_API_KEY) {
      try {
        buf = await geminiImage(prompt);
      } catch (e) {
        console.error('gemini image failed: ' + e.message);
        errors.push('gemini: ' + e.message);
      }
    }
    const models = (!buf && process.env.OPENAI_API_KEY) ? [process.env.IMAGE_MODEL || 'gpt-image-1', 'gpt-image-1-mini'].filter((m, i, a) => a.indexOf(m) === i) : [];
    for (const model of models) {
      try {
        buf = await requestImage(model, prompt);
        break;
      } catch (e) {
        console.error(`${model} failed: ${e.message}`);
        errors.push(`${model}: ${e.message}`);
      }
    }
    if (!buf) throw new Error(errors.join(' | '));
    const name = `${draft.id}-${Date.now()}.png`;
    await saveImageBuffer(name, buf);
    draft.visualPrompt = prompt;
    draft.imageUrl = '/images/' + name;
    saveDrafts(drafts);
    res.json({ ok: true, imageUrl: draft.imageUrl });
  } catch (e) {
    console.error('generate-image failed:', e);
    res.status(502).json({ error: e.message });
  }
});

// ---------- Image Upload & Post Execution ----------
async function uploadImageToLinkedIn(imageUrl, accessToken, personUrn) {
  const initRes = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': '202504',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify({ initializeUploadRequest: { owner: personUrn } })
  });
  const initData = await initRes.json();
  const uploadUrl = initData.value.uploadUrl;
  const imageUrn = initData.value.image;

  let imgBuffer;
  if (imageUrl.startsWith('/images/')) {
    imgBuffer = await loadImageBuffer(imageUrl);
    if (!imgBuffer) throw new Error('Generated image is no longer available. Click Regenerate image.');
  } else {
    const imgRes = await fetch(imageUrl);
    imgBuffer = await imgRes.buffer();
  }

  await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: imgBuffer
  });

  return imageUrn;
}

app.post('/api/drafts/:id/post', requireDashboardAuth, async (req, res) => {
  const token = getToken();
  if (!token) return res.status(400).json({ error: 'LinkedIn is not connected yet. Visit /auth/linkedin first.' });

  const drafts = getDrafts();
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'not found' });

  try {
    let content;
    if (draft.imageUrl) {
      const imageUrn = await uploadImageToLinkedIn(draft.imageUrl, token.access_token, token.person_urn);
      content = { media: { title: '', id: imageUrn } };
    }

    const postBody = {
      author: token.person_urn,
      commentary: draft.text,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(content ? { content } : {})
    };

    const postRes = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': '202504',
        'X-Restli-Protocol-Version': '2.0.0'
      },
      body: JSON.stringify(postBody)
    });

    if (!postRes.ok) {
      const errText = await postRes.text();
      return res.status(502).json({ error: 'LinkedIn rejected post', detail: errText });
    }

    draft.status = 'posted';
    draft.postedAt = new Date().toISOString();
    saveDrafts(drafts);
    res.json({ ok: true, draft });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Dashboard UI Handler ----------
app.get('/', requireDashboardAuth, (req, res) => {
  const token = getToken();
  const drafts = getDrafts();

  const draftCards = drafts.map(d => `
    <div class="card ${d.status === 'posted' ? 'posted' : ''}">
      <textarea data-id="${d.id}" ${d.status === 'posted' ? 'readonly' : ''}>${escapeHtml(d.text)}</textarea>
      ${d.status !== 'posted' ? `<div class="meta" style="margin-top:6px;color:#2b6cb0;"><strong>Visual Prompt (editable):</strong></div><textarea data-vp="${d.id}" style="min-height:90px;" placeholder="Click Get visual prompt, or type your own">${escapeHtml(d.visualPrompt || '')}</textarea><div class="meta" style="margin-top:6px;color:#2b6cb0;"><strong>Step 2 texture-fix prompt (use with a real reference photo):</strong></div><textarea data-tp="${d.id}" style="min-height:90px;">${escapeHtml(d.texturePrompt || '')}</textarea>` : ''}
      ${d.imageUrl ? `<img src="${d.imageUrl}" style="max-width:320px;display:block;margin:8px 0;">` : ''}
      <div class="meta">${d.status === 'posted' ? '✓ Posted ' + d.postedAt : 'Pending review'}</div>
      ${d.status !== 'posted' ? `
        <button onclick="getPrompt('${d.id}', this)">${d.visualPrompt ? 'New visual prompt' : 'Get visual prompt'}</button>
        <button onclick="copyPrompt('${d.id}', this)">Copy prompt</button>
        <button onclick="copyTexture('${d.id}', this)">Copy texture-fix prompt</button>
        <button onclick="pickImage('${d.id}')">Upload image</button>
        <button onclick="pickTwo('${d.id}')">Join 2 photos (before/after)</button>
        <input type="file" id="two-${d.id}" accept="image/*" multiple style="display:none" onchange="joinImages('${d.id}', this)">
        ${d.imageUrl ? `<button onclick="checkImage('${d.id}', this)">Check image</button>` : ''}
        <input type="file" id="file-${d.id}" accept="image/*" style="display:none" onchange="uploadImage('${d.id}', this)">
        <button onclick="generateImage('${d.id}', this)">Quick AI image (basic)</button>
        <button onclick="saveDraft('${d.id}')">Save edits</button>
        <button onclick="postDraft('${d.id}')" class="post-btn">Approve &amp; Post</button>
        <button onclick="deleteDraft('${d.id}')" class="delete-btn">Delete</button>
      ` : ''}
    </div>
  `).join('') || '<p>No drafts found.</p>';

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="apple-mobile-web-app-capable" content="yes">
      <meta name="apple-mobile-web-app-title" content="LinkedIn Poster">
      <title>LinkedIn Poster</title>
      <style>
        body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 16px;}
        .status{padding:10px;border-radius:6px;margin-bottom:20px;}
        .connected{background:#e6f4ea;color:#1e4620;}
        .not-connected{background:#fdeaea;color:#7a1f1f;}
        .card{border:1px solid #ddd;border-radius:8px;padding:14px;margin-bottom:14px;}
        .card.posted{opacity:0.6;}
        textarea{width:100%;min-height:100px;font-family:inherit;font-size:14px;padding:8px;box-sizing:border-box;}
        button{margin-top:8px;margin-right:6px;padding:8px 14px;border-radius:6px;border:none;cursor:pointer;}
        .post-btn{background:#1a7f37;color:white;}
        .delete-btn{background:#c53030;color:white;}
        .meta{font-size:12px;color:#666;margin-top:6px;}
        form.new-draft{border:1px dashed #aaa;border-radius:8px;padding:14px;margin-bottom:24px;}
      </style>
    </head>
    <body>
      <h1>LinkedIn Poster</h1>
      <div class="status ${token ? 'connected' : 'not-connected'}">
        ${token ? `Connected as <strong>${token.name || 'your LinkedIn account'}</strong>` : `Not connected — <a href="/auth/linkedin">connect LinkedIn</a> first.`}
      </div>

      <form class="new-draft" onsubmit="return addDraft(event)">
        <h3>New draft</h3>
        <textarea id="newText" placeholder="Paste or write the post text here..."></textarea>
        <input id="newImage" type="text" placeholder="Image URL (optional)" style="width:100%;padding:8px;margin-top:8px;box-sizing:border-box;">
        <button type="submit">Add to queue</button>
      </form>

      <h3>Drafts</h3>
      ${draftCards}

      <script>
        function authHeader(){ return ''; } // login cookie is sent automatically
        async function addDraft(e){
          e.preventDefault();
          const text = document.getElementById('newText').value;
          const imageUrl = document.getElementById('newImage').value;
          await fetch('/api/drafts', {
            method:'POST',
            headers:{'Content-Type':'application/json','Authorization':authHeader()},
            body: JSON.stringify({text, imageUrl})
          });
          location.reload();
        }
        async function saveDraft(id){
          const text = document.querySelector('textarea[data-id="'+id+'"]').value;
          const vpEl = document.querySelector('textarea[data-vp="'+id+'"]');
          await fetch('/api/drafts/'+id, {
            method:'PATCH',
            headers:{'Content-Type':'application/json','Authorization':authHeader()},
            body: JSON.stringify({text, visualPrompt: vpEl ? vpEl.value : undefined, texturePrompt: (document.querySelector('textarea[data-tp="'+id+'"]')||{}).value})
          });
          alert('Saved.');
        }
        async function getPrompt(id, btn){
          btn.disabled = true; btn.textContent = 'Working...';
          const res = await fetch('/api/drafts/'+id+'/visual-prompt', {method:'POST'});
          const data = await res.json();
          if(data.error){ alert('Failed: ' + data.error); btn.disabled = false; btn.textContent = 'Get visual prompt'; return; }
          location.reload();
        }
        async function copyPrompt(id, btn){
          const t = document.querySelector('textarea[data-vp="'+id+'"]').value;
          try { await navigator.clipboard.writeText(t); btn.textContent = 'Copied'; }
          catch(e){ prompt('Copy this prompt:', t); }
        }
        async function copyTexture(id, btn){
          const t = document.querySelector('textarea[data-tp="'+id+'"]').value;
          try { await navigator.clipboard.writeText(t); btn.textContent = 'Copied'; }
          catch(e){ prompt('Copy this prompt:', t); }
        }
        function pickTwo(id){ alert('Select exactly 2 photos: the MISTAKE photo first, then the CORRECT photo.'); document.getElementById('two-'+id).click(); }
        function loadImg(f){ return new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = URL.createObjectURL(f); }); }
        async function joinImages(id, input){
          const files = Array.from(input.files);
          if(files.length !== 2){ alert('Please select exactly 2 photos.'); return; }
          const imgs = await Promise.all(files.map(loadImg));
          const c = document.createElement('canvas'); c.width = 1600; c.height = 800;
          const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 1600, 800);
          imgs.forEach((im, k) => {
            const side = Math.min(im.width, im.height);
            x.drawImage(im, (im.width - side) / 2, (im.height - side) / 2, side, side, k * 800 + (k ? 2 : 0), 0, 798, 800);
          });
          const res = await fetch('/api/drafts/'+id+'/upload-image', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({data: c.toDataURL('image/png')})});
          const data = await res.json();
          if(data.error){ alert('Failed: ' + data.error); return; }
          location.reload();
        }
        async function checkImage(id, btn){
          btn.disabled = true; btn.textContent = 'Checking...';
          const res = await fetch('/api/drafts/'+id+'/check-image', {method:'POST'});
          const data = await res.json();
          btn.disabled = false; btn.textContent = 'Check image';
          if(data.error){ alert('Failed: ' + data.error); return; }
          alert(data.verdict + (data.issues && data.issues.length ? '\\n\\n- ' + data.issues.join('\\n- ') : ''));
          if(data.verdict === 'FAIL' && data.stronger_prompt){
            const t = document.querySelector('textarea[data-vp="'+id+'"]');
            if(t){ t.value = data.stronger_prompt; alert('A corrected prompt was placed in the Visual Prompt box. Click Save edits to keep it.'); }
          }
        }
        function pickImage(id){ document.getElementById('file-'+id).click(); }
        async function uploadImage(id, input){
          const f = input.files[0]; if(!f) return;
          const img = new Image();
          img.onload = async () => {
            const max = 1600, sc = Math.min(1, max / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            const res = await fetch('/api/drafts/'+id+'/upload-image', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({data: c.toDataURL('image/png')})});
            const data = await res.json();
            if(data.error){ alert('Failed: ' + data.error); return; }
            location.reload();
          };
          img.src = URL.createObjectURL(f);
        }
        async function generateImage(id, btn){
          btn.disabled = true; btn.textContent = 'Generating (30-60s)...';
          const res = await fetch('/api/drafts/'+id+'/generate-image', {method:'POST', headers:{'Authorization':authHeader()}});
          const data = await res.json();
          if(data.error){ alert('Failed: ' + data.error); btn.disabled = false; btn.textContent = 'Generate image'; return; }
          location.reload();
        }
        async function postDraft(id){
          if(!confirm('Post this to LinkedIn now?')) return;
          const res = await fetch('/api/drafts/'+id+'/post', {method:'POST', headers:{'Authorization':authHeader()}});
          const data = await res.json();
          if(data.error){ alert('Failed: ' + JSON.stringify(data)); return; }
          location.reload();
        }
        async function deleteDraft(id){
          if(!confirm('Delete this draft?')) return;
          await fetch('/api/drafts/'+id, {method:'DELETE', headers:{'Authorization':authHeader()}});
          location.reload();
        }
      </script>
    </body>
    </html>
  `);
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

initStorage().then(() => {
  app.listen(PORT, () => {
    console.log(`LinkedIn Poster running on port ${PORT}`);
  });
});
