/**
 * LinkedIn Poster — a small self-hosted approval workflow.
 *
 * What this does:
 *   1. One-time OAuth: you authorize this app to post to YOUR OWN
 *      LinkedIn profile (not a company page, not on anyone else's behalf).
 *   2. Drafts get added (either by you, or pasted in from Claude) to a
 *      simple queue.
 *   3. You open the dashboard, review/edit each draft, and click
 *      "Approve & Post" — nothing goes to LinkedIn until you do that.
 *
 * What this does NOT do:
 *   - Auto-reply to comments. LinkedIn's public API doesn't expose a
 *     reliable way to read/reply to comments for third-party apps, and
 *     automating replies risks your account's standing. Keep replies
 *     manual.
 *   - Store your token anywhere fancy. It's a local JSON file
 *     (token-store.json). Fine for a single personal-use deployment;
 *     if this ever needs to be shared with other people, swap this
 *     for a real secrets manager / database first.
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

// Allow the Ops Hub app (a different origin) to call this service directly —
// e.g. sending a drafted post here to join the approval queue.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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

// ---------- tiny local "database" (JSON files) ----------
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

// ---------- basic auth for the dashboard ----------
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

// ---------- OAuth: step 1, send the user to LinkedIn ----------
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

// ---------- OAuth: step 2, LinkedIn redirects back here with a code ----------
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

    // Get the person's URN (needed as the "author" on every post)
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
      <p>LinkedIn account <strong>${me.name || ''}</strong> is now authorized.</p>
      <p>You can close this tab and go to <a href="/">the dashboard</a>.</p>
    `);
  } catch (e) {
    res.status(500).send('Something went wrong exchanging the token: ' + e.message);
  }
});

// ---------- status check (used by the Ops Hub app to show connection state) ----------
app.get('/api/status', requireDashboardAuth, (req, res) => {
  const token = getToken();
  res.json({
    connected: !!token,
    name: token ? token.name : null
  });
});

// ---------- list drafts (used by the Ops Hub app to show queue status) ----------
app.get('/api/drafts', requireDashboardAuth, (req, res) => {
  res.json(getDrafts());
});

// ---------- add a draft (call this from anywhere, e.g. paste one in from Claude) ----------
app.post('/api/drafts', requireDashboardAuth, (req, res) => {
  const { text, imageUrl, slot } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const drafts = getDrafts();
  const draft = {
    id: crypto.randomUUID(),
    text,
    imageUrl: imageUrl || null,
    slot: slot || 'Anytime', // Morning | Midday | Evening | Anytime
    status: 'pending', // pending | posted
    createdAt: new Date().toISOString()
  };
  drafts.unshift(draft);
  saveDrafts(drafts);
  res.json(draft);
});

// ---------- edit a draft before approving ----------
app.patch('/api/drafts/:id', requireDashboardAuth, (req, res) => {
  const drafts = getDrafts();
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'not found' });
  if (req.body.text !== undefined) draft.text = req.body.text;
  if (req.body.imageUrl !== undefined) draft.imageUrl = req.body.imageUrl;
  if (req.body.slot !== undefined) draft.slot = req.body.slot;
  saveDrafts(drafts);
  res.json(draft);
});

// ---------- delete a draft you don't want ----------
app.delete('/api/drafts/:id', requireDashboardAuth, (req, res) => {
  let drafts = getDrafts();
  drafts = drafts.filter(d => d.id !== req.params.id);
  saveDrafts(drafts);
  res.json({ ok: true });
});

// ---------- register + upload an image to LinkedIn, return its URN ----------
async function uploadImageToLinkedIn(imageUrl, accessToken, personUrn) {
  // Step 1: tell LinkedIn you want to upload an image, get an upload URL back
  const initRes = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST',
    headers: {
      Authorization:/**
 * LinkedIn Poster — a small self-hosted approval workflow.
 *
 * What this does:
 *   1. One-time OAuth: you authorize this app to post to YOUR OWN
 *      LinkedIn profile (not a company page, not on anyone else's behalf).
 *   2. Drafts get added (either by you, or pasted in from Claude) to a
 *      simple queue.
 *   3. You open the dashboard, review/edit each draft, and click
 *      "Approve & Post" — nothing goes to LinkedIn until you do that.
 *
 * What this does NOT do:
 *   - Auto-reply to comments. LinkedIn's public API doesn't expose a
 *     reliable way to read/reply to comments for third-party apps, and
 *     automating replies risks your account's standing. Keep replies
 *     manual.
 *   - Store your token anywhere fancy. It's a local JSON file
 *     (token-store.json). Fine for a single personal-use deployment;
 *     if this ever needs to be shared with other people, swap this
 *     for a real secrets manager / database first.
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

// Allow the Ops Hub app (a different origin) to call this service directly —
// e.g. sending a drafted post here to join the approval queue.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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

// ---------- tiny local "database" (JSON files) ----------
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

// ---------- basic auth for the dashboard ----------
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

// ---------- OAuth: step 1, send the user to LinkedIn ----------
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

// ---------- OAuth: step 2, LinkedIn redirects back here with a code ----------
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

    // Get the person's URN (needed as the "author" on every post)
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
      <p>LinkedIn account <strong>${me.name || ''}</strong> is now authorized.</p>
      <p>You can close this tab and go to <a href="/">the dashboard</a>.</p>
    `);
  } catch (e) {
    res.status(500).send('Something went wrong exchanging the token: ' + e.message);
  }
});

// ---------- status check (used by the Ops Hub app to show connection state) ----------
app.get('/api/status', requireDashboardAuth, (req, res) => {
  const token = getToken();
  res.json({
    connected: !!token,
    name: token ? token.name : null
  });
});

// ---------- list drafts (used by the Ops Hub app to show queue status) ----------
app.get('/api/drafts', requireDashboardAuth, (req, res) => {
  res.json(getDrafts());
});

// ---------- add a draft (call this from anywhere, e.g. paste one in from Claude) ----------
app.post('/api/drafts', requireDashboardAuth, (req, res) => {
  const { text, imageUrl } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const drafts = getDrafts();
  const draft = {
    id: crypto.randomUUID(),
    text,
    imageUrl: imageUrl || null,
    status: 'pending', // pending | posted
    createdAt: new Date().toISOString()
  };
  drafts.unshift(draft);
  saveDrafts(drafts);
  res.json(draft);
});

// ---------- edit a draft before approving ----------
app.patch('/api/drafts/:id', requireDashboardAuth, (req, res) => {
  const drafts = getDrafts();
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'not found' });
  if (req.body.text !== undefined) draft.text = req.body.text;
  if (req.body.imageUrl !== undefined) draft.imageUrl = req.body.imageUrl;
  saveDrafts(drafts);
  res.json(draft);
});

// ---------- delete a draft you don't want ----------
app.delete('/api/drafts/:id', requireDashboardAuth, (req, res) => {
  let drafts = getDrafts();
  drafts = drafts.filter(d => d.id !== req.params.id);
  saveDrafts(drafts);
  res.json({ ok: true });
});

// ---------- register + upload an image to LinkedIn, return its URN ----------
async function uploadImageToLinkedIn(imageUrl, accessToken, personUrn) {
  // Step 1: tell LinkedIn you want to upload an image, get an upload URL back
  const initRes = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': '202504',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify({
      initializeUploadRequest: { owner: personUrn }
    })
  });
  const initData = await initRes.json();
  const uploadUrl = initData.value.uploadUrl;
  const imageUrn = initData.value.image;

  // Step 2: fetch the image bytes from wherever it currently lives...
  const imgRes = await fetch(imageUrl);
  const imgBuffer = await imgRes.buffer();

  // ...and PUT them to the URL LinkedIn just gave you
  await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: imgBuffer
  });

  return imageUrn;
}

// ---------- approve & post a draft to LinkedIn ----------
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
      return res.status(502).json({ error: 'LinkedIn rejected the post', detail: errText });
    }

    draft.status = 'posted';
    draft.postedAt = new Date().toISOString();
    saveDrafts(drafts);
    res.json({ ok: true, draft });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- the approval dashboard itself ----------
app.get('/', requireDashboardAuth, (req, res) => {
  const token = getToken();
  const drafts = getDrafts();

  const draftCards = drafts.map(d => `
    <div class="card ${d.status === 'posted' ? 'posted' : ''}">
      <textarea data-id="${d.id}" ${d.status === 'posted' ? 'readonly' : ''}>${escapeHtml(d.text)}</textarea>
      ${d.imageUrl ? `<img src="${d.imageUrl}" style="max-width:200px;display:block;margin:8px 0;">` : ''}
      <div class="meta">${d.status === 'posted' ? '✓ Posted ' + d.postedAt : 'Pending review'}</div>
      ${d.status !== 'posted' ? `
        <button onclick="saveDraft('${d.id}')">Save edits</button>
        <button onclick="postDraft('${d.id}')" class="post-btn">Approve &amp; Post</button>
        <button onclick="deleteDraft('${d.id}')" class="delete-btn">Delete</button>
      ` : ''}
    </div>
  `).join('') || '<p>No drafts yet.</p>';

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
  console.log(`LinkedIn Poster running on http://localhost:${PORT}`);
  console.log(`If LinkedIn isn't connected yet, visit http://localhost:${PORT}/auth/linkedin`);
});
