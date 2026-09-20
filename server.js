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
function getToken() { return readJSON(TOKEN_FILE, null); }
function saveToken(token) { writeJSON(TOKEN_FILE, token); }
function getDrafts() { return readJSON(DRAFTS_FILE, []); }
function saveDrafts(drafts) { writeJSON(DRAFTS_FILE, drafts); }

// ---------- Basic Auth ----------
function requireDashboardAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (pass === DASHBOARD_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="LinkedIn Poster"');
  return res.status(401).send('Authentication required.');
}

// =====================================================================
// AI Transformation Step 1: Technical Visual Prompt Generator
// =====================================================================
async function createVisualPrompt(postText) {
  const systemInstruction = `
    You are an expert technical visual graphic designer for professional culinary, food science, and hospitality management content.
    Analyze the provided post text and construct an explicit visual prompt for an image generator.

    CORE MANDATE:
    - NEVER generate generic plated food photography, aesthetic restaurant dish photos, or stock photos of chefs holding plates.
    - Focus exclusively on technical graphics: 2-panel comparison diagrams, molecular cross-sections, workflow blueprints, or equipment cutaways.
    - Match the precise technical, scientific, or procedural topic of the post.

    CATEGORIZATION & VISUAL DIRECTIVES:
    1. Food Safety & Temperature Control:
       Render a 2-panel technical comparison diagram, flow chart, or temperature zone graph showing equipment, temperature callouts, and process warnings.
    2. Culinary Science & Food Chemistry:
       Render a modern molecular or structural infographic showing visual cross-sections, chemical process stages, and key technical icons.
    3. Kitchen Management & Operations:
       Render a clean vector workflow diagram, station layout blueprint, or process control checklist graphic.
    4. Culinary Techniques & Equipment Mechanics:
       Render a step-by-step vector instructional diagram showing angles, technique cutaways, thermal gradients, or tool mechanics.

    STYLE & FORMATTING:
    - Aesthetics: Clean typography hierarchy, modern vector illustration, technical blueprint layout, high contrast.
    - Format: 1:1 square aspect ratio.
    - Negative Constraints: NO plain food photography, NO plated meals.

    Output ONLY the final descriptive image generator prompt text.
  `;

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
async function requestImage(model, prompt) {
  const body = { model, prompt: prompt.slice(0, 3900), size: '1024x1024', n: 1 };
  if (model === 'dall-e-3') body.response_format = 'b64_json';
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

app.use('/images', requireDashboardAuth, express.static(IMAGES_DIR));

app.post('/api/drafts/:id/generate-image', requireDashboardAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'OPENAI_API_KEY is not set on the server.' });
  const drafts = getDrafts();
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'not found' });

  try {
    const prompt = draft.visualPrompt || await createVisualPrompt(draft.text);
    const primary = process.env.IMAGE_MODEL || 'gpt-image-1';
    let buf;
    try {
      buf = await requestImage(primary, prompt);
    } catch (e) {
      if (primary === 'dall-e-3') throw e;
      console.error(`${primary} failed (${e.message}), falling back to dall-e-3`);
      buf = await requestImage('dall-e-3', prompt);
    }
    const name = `${draft.id}-${Date.now()}.png`;
    fs.writeFileSync(path.join(IMAGES_DIR, name), buf);
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
    imgBuffer = fs.readFileSync(path.join(IMAGES_DIR, path.basename(imageUrl)));
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
      ${d.visualPrompt ? `<div class="meta" style="margin-top:4px;color:#2b6cb0;"><strong>Visual Prompt:</strong> ${escapeHtml(d.visualPrompt)}</div>` : ''}
      ${d.imageUrl ? `<img src="${d.imageUrl}" style="max-width:320px;display:block;margin:8px 0;">` : ''}
      <div class="meta">${d.status === 'posted' ? '✓ Posted ' + d.postedAt : 'Pending review'}</div>
      ${d.status !== 'posted' ? `
        <button onclick="generateImage('${d.id}', this)">${d.imageUrl ? 'Regenerate image' : 'Generate image'}</button>
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
        function authHeader(){
          const pass = sessionStorage.getItem('dashPass') || prompt('Dashboard password:');
          sessionStorage.setItem('dashPass', pass);
          return 'Basic ' + btoa(':' + pass);
        }
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
          await fetch('/api/drafts/'+id, {
            method:'PATCH',
            headers:{'Content-Type':'application/json','Authorization':authHeader()},
            body: JSON.stringify({text})
          });
          alert('Saved.');
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

app.listen(PORT, () => {
  console.log(`LinkedIn Poster running on port ${PORT}`);
});
