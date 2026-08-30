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
const { createClient } = require('redis');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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
const REDIS_URL = process.env.REDIS_URL;
const WIX_API_KEY = process.env.WIX_API_KEY;
const WIX_SITE_ID = process.env.WIX_SITE_ID;
const WIX_MEMBER_ID = process.env.WIX_MEMBER_ID;

// ---------- publish a matching post to the culinaryessence.com blog ----------
// Uses a Wix API Key (server-to-server), separate from LinkedIn entirely.
// A blog-publish failure never blocks or undoes the LinkedIn post — it's
// recorded on the draft so you can see it and retry/investigate.
async function publishToWixBlog(draft) {
  if (!WIX_API_KEY || !WIX_SITE_ID || !WIX_MEMBER_ID) {
    throw new Error('Wix blog isn\'t configured — set WIX_API_KEY, WIX_SITE_ID, and WIX_MEMBER_ID.');
  }

  const paragraphs = draft.text.split('\n').filter(p => p.trim().length > 0);
  const richContentNodes = paragraphs.map((p, i) => ({
    type: 'PARAGRAPH',
    id: 'p' + i,
    nodes: [{
      type: 'TEXT',
      id: '',
      nodes: [],
      textData: { text: p, decorations: [] }
    }],
    paragraphData: {}
  }));

  // Title: first ~70 chars of the first line, so the blog post has something
  // sensible in the title field without you having to type it separately.
  const title = (paragraphs[0] || draft.text).slice(0, 70);

  // If there's an image, put it right after the title. Wix-hosted images
  // (static.wixstatic.com — e.g. anything from your Media Manager) render
  // properly when referenced by their internal media ID, not a plain URL —
  // extract that ID from the URL. Other external URLs fall back to a
  // direct URL reference, which may or may not render depending on Wix's
  // resolver.
  if (draft.imageUrl) {
    const wixMediaMatch = draft.imageUrl.match(/static\.wixstatic\.com\/media\/([^?#]+)/);
    const imageSrc = wixMediaMatch ? { id: wixMediaMatch[1] } : { url: draft.imageUrl };
    richContentNodes.unshift({
      type: 'IMAGE',
      id: 'img0',
      nodes: [],
      imageData: {
        image: { src: imageSrc },
        altText: title
      }
    });
  }

  const draftPostBody = {
    draftPost: {
      title,
      memberId: WIX_MEMBER_ID,
      richContent: { nodes: richContentNodes }
    },
    fieldsets: ['URL', 'RICH_CONTENT']
  };

  const res = await fetch('https://www.wixapis.com/blog/v3/draft-posts?publish=true', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': WIX_API_KEY,
      'wix-site-id': WIX_SITE_ID
    },
    body: JSON.stringify(draftPostBody)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Wix rejected the blog post (${res.status}): ${errText}`);
  }

  const data = await res.json();
  if (data.draftPost && data.draftPost.url && data.draftPost.url.base) {
    // url is { base, path } — join them into one real link
    const base = data.draftPost.url.base.replace(/\/$/, '');
    const path = data.draftPost.url.path || '';
    return base + path;
  }
  return null;
}

// ---------- storage backed by Render's Key Value store ----------
// This survives the web service sleeping/restarting on the free tier —
// local files on disk did not. Falls back to in-memory (per-instance,
// not shared, resets on restart) if REDIS_URL isn't set, so the app
// still runs even before that env var is configured.
let redisClient = null;
let memoryFallback = { token: null, drafts: [], replyDrafts: [] };

async function getRedis() {
  if (!REDIS_URL) return null;
  if (redisClient && redisClient.isOpen) return redisClient;
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis error:', err.message));
  await redisClient.connect();
  return redisClient;
}

async function getToken() {
  const r = await getRedis();
  if (!r) return memoryFallback.token;
  const raw = await r.get('li:token');
  return raw ? JSON.parse(raw) : null;
}
async function saveToken(token) {
  const r = await getRedis();
  if (!r) { memoryFallback.token = token; return; }
  await r.set('li:token', JSON.stringify(token));
}
async function getDrafts() {
  const r = await getRedis();
  if (!r) return memoryFallback.drafts;
  const raw = await r.get('li:drafts');
  return raw ? JSON.parse(raw) : [];
}
async function saveDrafts(drafts) {
  const r = await getRedis();
  if (!r) { memoryFallback.drafts = drafts; return; }
  await r.set('li:drafts', JSON.stringify(drafts));
}
async function getReplyDrafts() {
  const r = await getRedis();
  if (!r) return memoryFallback.replyDrafts || [];
  const raw = await r.get('li:reply-drafts');
  return raw ? JSON.parse(raw) : [];
}
async function saveReplyDrafts(replyDrafts) {
  const r = await getRedis();
  if (!r) { memoryFallback.replyDrafts = replyDrafts; return; }
  await r.set('li:reply-drafts', JSON.stringify(replyDrafts));
}

// ---------- session auth for the dashboard ----------
// A long-lived, stateless signed cookie — no repeated browser login
// prompts. Computed from DASHBOARD_PASSWORD, so it needs no separate
// storage and stays valid across restarts as long as the password
// env var doesn't change.
const SESSION_COOKIE = 'ce_session';
function computeSessionToken() {
  return crypto.createHmac('sha256', DASHBOARD_PASSWORD).update('linkedin-poster-session').digest('hex');
}

function requireDashboardAuth(req, res, next) {
  // 1. Valid session cookie (browser, after logging in via /login) — no repeat prompts.
  if (req.cookies && req.cookies[SESSION_COOKIE] === computeSessionToken()) return next();

  // 2. Valid Basic Auth header (used by the Ops Hub app calling the API cross-origin,
  //    where cookies can't be shared across origins/local files).
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (pass === DASHBOARD_PASSWORD) return next();
  }

  // 3. Browser navigating to a page (not a script/API call) — send to a real login
  //    page instead of triggering the native, poorly-remembered Basic Auth popup.
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.redirect('/login');
  }

  res.status(401).json({ error: 'Authentication required.' });
}

// ---------- login page (sets the long-lived cookie) ----------
app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Sign in — LinkedIn Poster</title>
    <style>
      body{font-family:sans-serif;max-width:360px;margin:80px auto;padding:0 16px;}
      input{width:100%;padding:10px;margin:10px 0;box-sizing:border-box;font-size:15px;}
      button{width:100%;padding:10px;background:#1a7f37;color:white;border:none;border-radius:6px;font-size:15px;cursor:pointer;}
      .error{color:#c53030;font-size:13px;}
    </style>
    </head>
    <body>
      <h2>LinkedIn Poster</h2>
      <form method="POST" action="/login">
        <input type="password" name="password" placeholder="Dashboard password" autofocus required>
        <button type="submit">Sign in</button>
      </form>
      ${req.query.error ? '<p class="error">Wrong password — try again.</p>' : ''}
    </body>
    </html>
  `);
});

app.post('/login', (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) {
    res.cookie(SESSION_COOKIE, computeSessionToken(), {
      httpOnly: true,
      maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days — no repeated logins
      sameSite: 'lax'
    });
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

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

    await saveToken({
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
app.get('/api/status', requireDashboardAuth, async (req, res) => {
  const token = await getToken();
  res.json({
    connected: !!token,
    name: token ? token.name : null
  });
});

// ---------- list drafts (used by the Ops Hub app to show queue status) ----------
app.get('/api/drafts', requireDashboardAuth, async (req, res) => {
  res.json(await getDrafts());
});

// ---------- add a draft (call this from anywhere, e.g. paste one in from Claude) ----------
app.post('/api/drafts', requireDashboardAuth, async (req, res) => {
  const { text, imageUrl, slot } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const drafts = await getDrafts();
  const draft = {
    id: crypto.randomUUID(),
    text,
    imageUrl: imageUrl || null,
    slot: slot || 'Anytime', // Morning | Midday | Evening | Anytime
    status: 'pending', // pending | posted
    createdAt: new Date().toISOString()
  };
  drafts.unshift(draft);
  await saveDrafts(drafts);
  res.json(draft);
});

// ---------- edit a draft before approving ----------
app.patch('/api/drafts/:id', requireDashboardAuth, async (req, res) => {
  const drafts = await getDrafts();
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'not found' });
  if (req.body.text !== undefined) draft.text = req.body.text;
  if (req.body.imageUrl !== undefined) draft.imageUrl = req.body.imageUrl;
  if (req.body.slot !== undefined) draft.slot = req.body.slot;
  await saveDrafts(drafts);
  res.json(draft);
});

// ---------- delete a draft you don't want ----------
app.delete('/api/drafts/:id', requireDashboardAuth, async (req, res) => {
  let drafts = await getDrafts();
  drafts = drafts.filter(d => d.id !== req.params.id);
  await saveDrafts(drafts);
  res.json({ ok: true });
});

// ---------- REPLY DRAFTS ----------
// Comment detection stays manual — LinkedIn doesn't grant read access to
// comments (r_member_social) to third-party apps. You see a comment on
// LinkedIn yourself, paste it in here, get/edit a suggested reply, and
// approving it posts the real reply via the API.

// list reply drafts
app.get('/api/reply-drafts', requireDashboardAuth, async (req, res) => {
  res.json(await getReplyDrafts());
});

// add a reply draft (comment you saw + your target post + a suggested reply)
app.post('/api/reply-drafts', requireDashboardAuth, async (req, res) => {
  const { commentText, commentAuthor, targetPostUrn, suggestedReply } = req.body;
  if (!commentText || !targetPostUrn) {
    return res.status(400).json({ error: 'commentText and targetPostUrn are required' });
  }
  const replyDrafts = await getReplyDrafts();
  const draft = {
    id: crypto.randomUUID(),
    commentText,
    commentAuthor: commentAuthor || null,
    targetPostUrn,
    suggestedReply: suggestedReply || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  replyDrafts.unshift(draft);
  await saveReplyDrafts(replyDrafts);
  res.json(draft);
});

// edit a reply draft before approving
app.patch('/api/reply-drafts/:id', requireDashboardAuth, async (req, res) => {
  const replyDrafts = await getReplyDrafts();
  const draft = replyDrafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'not found' });
  if (req.body.suggestedReply !== undefined) draft.suggestedReply = req.body.suggestedReply;
  await saveReplyDrafts(replyDrafts);
  res.json(draft);
});

// delete a reply draft
app.delete('/api/reply-drafts/:id', requireDashboardAuth, async (req, res) => {
  let replyDrafts = await getReplyDrafts();
  replyDrafts = replyDrafts.filter(d => d.id !== req.params.id);
  await saveReplyDrafts(replyDrafts);
  res.json({ ok: true });
});

// approve & post the reply as a real LinkedIn comment
app.post('/api/reply-drafts/:id/post', requireDashboardAuth, async (req, res) => {
  const token = await getToken();
  if (!token) return res.status(400).json({ error: 'LinkedIn is not connected yet. Visit /auth/linkedin first.' });

  const replyDrafts = await getReplyDrafts();
  const draft = replyDrafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'not found' });
  if (!draft.suggestedReply || !draft.suggestedReply.trim()) {
    return res.status(400).json({ error: 'Write a reply before approving.' });
  }

  try {
    const commentRes = await fetch(
      `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(draft.targetPostUrn)}/comments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
          'LinkedIn-Version': '202608',
          'X-Restli-Protocol-Version': '2.0.0'
        },
        body: JSON.stringify({
          actor: token.person_urn,
          message: { text: draft.suggestedReply }
        })
      }
    );

    if (!commentRes.ok) {
      const errText = await commentRes.text();
      return res.status(502).json({ error: `LinkedIn rejected the reply (${commentRes.status})`, detail: errText });
    }

    draft.status = 'posted';
    draft.postedAt = new Date().toISOString();
    await saveReplyDrafts(replyDrafts);
    res.json({ ok: true, draft });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- register + upload an image to LinkedIn, return its URN ----------
async function uploadImageToLinkedIn(imageUrl, accessToken, personUrn) {
  // Step 1: tell LinkedIn you want to upload an image, get an upload URL back
  const initRes = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': '202608',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify({
      initializeUploadRequest: { owner: personUrn }
    })
  });
  if (!initRes.ok) {
    const errText = await initRes.text();
    throw new Error(`LinkedIn rejected the image upload request (${initRes.status}): ${errText}`);
  }
  const initData = await initRes.json();
  if (!initData.value || !initData.value.uploadUrl) {
    throw new Error(`LinkedIn's image upload response was missing expected fields: ${JSON.stringify(initData)}`);
  }
  const uploadUrl = initData.value.uploadUrl;
  const imageUrn = initData.value.image;

  // Step 2: fetch the image bytes from wherever it currently lives...
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Could not fetch the image from ${imageUrl} (status ${imgRes.status}) — check the URL is public and correct.`);
  }
  const imgBuffer = await imgRes.buffer();

  // ...and PUT them to the URL LinkedIn just gave you
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: imgBuffer
  });
  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`Uploading the image bytes to LinkedIn failed (${putRes.status}): ${errText}`);
  }

  return imageUrn;
}

// ---------- retry just the blog publish for an already-LinkedIn-posted draft ----------
app.post('/api/drafts/:id/retry-blog', requireDashboardAuth, async (req, res) => {
  const drafts = await getDrafts();
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'not found' });

  try {
    const blogUrl = await publishToWixBlog(draft);
    draft.blogPublished = true;
    draft.blogUrl = blogUrl;
    draft.blogError = null;
    await saveDrafts(drafts);
    res.json({ ok: true, draft });
  } catch (blogErr) {
    draft.blogPublished = false;
    draft.blogError = (blogErr && blogErr.message) ? blogErr.message : String(blogErr);
    await saveDrafts(drafts);
    res.status(502).json({ error: draft.blogError });
  }
});

// ---------- approve & post a draft to LinkedIn ----------
app.post('/api/drafts/:id/post', requireDashboardAuth, async (req, res) => {
  const token = await getToken();
  if (!token) return res.status(400).json({ error: 'LinkedIn is not connected yet. Visit /auth/linkedin first.' });

  const drafts = await getDrafts();
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
        'LinkedIn-Version': '202608',
        'X-Restli-Protocol-Version': '2.0.0'
      },
      body: JSON.stringify(postBody)
    });

    if (!postRes.ok) {
      const errText = await postRes.text();
      return res.status(502).json({ error: 'LinkedIn rejected the post', detail: errText });
    }

    // LinkedIn returns the created post's URN in this header, not the body.
    // Capture it so we have a real, clickable link to verify — not just a
    // "success" message we're trusting blindly.
    const postUrn = postRes.headers.get('x-restli-id') || postRes.headers.get('x-linkedin-id');
    draft.linkedinPostUrn = postUrn || null;
    draft.linkedinPostUrl = postUrn
      ? `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}/`
      : null;

    draft.status = 'posted';
    draft.postedAt = new Date().toISOString();

    // Blog publishing is best-effort — a failure here is recorded on the
    // draft, but the LinkedIn post above has already succeeded and stays
    // that way regardless of what happens next.
    try {
      const blogUrl = await publishToWixBlog(draft);
      draft.blogPublished = true;
      draft.blogUrl = blogUrl;
    } catch (blogErr) {
      draft.blogPublished = false;
      draft.blogError = (blogErr && blogErr.message) ? blogErr.message : String(blogErr);
      console.error('Blog publish failed for draft', draft.id, ':', blogErr);
    }

    await saveDrafts(drafts);
    res.json({ ok: true, draft });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- the approval dashboard itself ----------
app.get('/', requireDashboardAuth, async (req, res) => {
  const token = await getToken();
  const drafts = await getDrafts();
  const replyDrafts = await getReplyDrafts();

  const SLOTS = ['Morning', 'Midday', 'Evening', 'Anytime'];
  const slotColor = { Morning:'#fff4e5', Midday:'#e5f4ff', Evening:'#f0e5ff', Anytime:'#f0f0f0' };

  function draftCard(d) {
    return `
    <div class="card ${d.status === 'posted' ? 'posted' : ''}" style="border-left:5px solid ${d.status==='posted' ? '#ccc' : (slotColor[d.slot] ? '#00000022' : '#ccc')};">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span class="slot-badge" style="background:${slotColor[d.slot] || '#f0f0f0'};padding:3px 10px;border-radius:12px;font-size:12px;">${d.slot || 'Anytime'}</span>
        ${d.status !== 'posted' ? `
          <select onchange="changeSlot('${d.id}', this.value)" style="font-size:12px;padding:3px 6px;">
            ${SLOTS.map(s => `<option value="${s}" ${d.slot===s?'selected':''}>${s}</option>`).join('')}
          </select>
        ` : ''}
      </div>
      <textarea data-id="${d.id}" ${d.status === 'posted' ? 'readonly' : ''}>${escapeHtml(d.text)}</textarea>
      ${d.imageUrl ? `<img src="${d.imageUrl}" style="max-width:200px;display:block;margin:8px 0;">` : ''}
      <div class="meta">
        ${d.status === 'posted'
          ? '✓ Posted to LinkedIn ' + d.postedAt + (d.linkedinPostUrl ? ' — <a href="' + d.linkedinPostUrl + '" target="_blank">view post</a>' : ' <span style="color:#c53030;">(no post link captured — verify manually)</span>')
          : 'Pending review'}
        ${d.status === 'posted' ? (d.blogPublished
            ? '<br>✓ Blog post live' + (d.blogUrl ? ': <a href="' + d.blogUrl + '" target="_blank">' + d.blogUrl + '</a>' : '')
            : '<br>⚠ Blog publish failed: ' + (d.blogError || 'unknown error'))
          : ''}
      </div>
      ${d.status !== 'posted' ? `
        <button onclick="saveDraft('${d.id}')">Save edits</button>
        <button onclick="postDraft('${d.id}')" class="post-btn">Approve &amp; Post</button>
        <button onclick="deleteDraft('${d.id}')" class="delete-btn">Delete</button>
      ` : ''}
      ${d.status === 'posted' && !d.blogPublished ? `
        <button onclick="retryBlog('${d.id}')" class="post-btn">Retry blog publish</button>
      ` : ''}
    </div>
  `;
  }

  const pending = drafts.filter(d => d.status !== 'posted');
  const posted = drafts.filter(d => d.status === 'posted');

  const pendingBySlot = SLOTS.map(slot => {
    const items = pending.filter(d => (d.slot || 'Anytime') === slot);
    if (items.length === 0) return '';
    return `<h4 style="margin-top:20px;">${slot}</h4>${items.map(draftCard).join('')}`;
  }).join('') || '<p>No pending drafts.</p>';

  const postedHtml = posted.length ? `<h3 style="margin-top:30px;">Posted</h3>${posted.map(draftCard).join('')}` : '';

  const postedWithLinkedInUrn = posted.filter(d => d.linkedinPostUrn);
  const targetOptions = postedWithLinkedInUrn.map(d =>
    `<option value="${escapeHtml(d.linkedinPostUrn)}">${escapeHtml(d.text.slice(0, 60))}...</option>`
  ).join('');

  function replyCard(rd) {
    const targetLabel = postedWithLinkedInUrn.find(d => d.linkedinPostUrn === rd.targetPostUrn);
    return `
    <div class="card ${rd.status === 'posted' ? 'posted' : ''}">
      <div class="meta" style="margin-bottom:8px;">
        <strong>Comment${rd.commentAuthor ? ' from ' + escapeHtml(rd.commentAuthor) : ''}:</strong><br>
        "${escapeHtml(rd.commentText)}"
        <br><span style="font-size:11px;">On: ${targetLabel ? escapeHtml(targetLabel.text.slice(0,50)) : rd.targetPostUrn}</span>
      </div>
      <textarea data-reply-id="${rd.id}" placeholder="Write or edit the reply..." ${rd.status === 'posted' ? 'readonly' : ''}>${escapeHtml(rd.suggestedReply)}</textarea>
      <div class="meta">${rd.status === 'posted' ? '✓ Reply posted ' + rd.postedAt : 'Pending review'}</div>
      ${rd.status !== 'posted' ? `
        <button onclick="saveReply('${rd.id}')">Save edits</button>
        <button onclick="postReply('${rd.id}')" class="post-btn">Approve &amp; Reply</button>
        <button onclick="deleteReply('${rd.id}')" class="delete-btn">Delete</button>
      ` : ''}
    </div>
  `;
  }

  const pendingReplies = replyDrafts.filter(d => d.status !== 'posted');
  const postedReplies = replyDrafts.filter(d => d.status === 'posted');
  const replyDraftsHtml = pendingReplies.map(replyCard).join('') || '<p>No pending reply drafts.</p>';
  const postedRepliesHtml = postedReplies.length ? `<h4 style="margin-top:20px;">Posted replies</h4>${postedReplies.map(replyCard).join('')}` : '';

  const replySection = `
    <h3 style="margin-top:40px;">Reply Drafts</h3>
    <p style="font-size:13px;color:#666;">Comment detection is manual — LinkedIn doesn't allow reading comments via API for this app. Saw a comment worth replying to? Paste it below.</p>
    <form class="new-draft" onsubmit="return addReply(event)">
      <h4>New reply draft</h4>
      ${postedWithLinkedInUrn.length === 0 ? '<p style="color:#c53030;font-size:13px;">No posts with a captured LinkedIn link yet — post something first so there\'s something to reply on.</p>' : `
        <select id="replyTarget" style="width:100%;padding:8px;margin-bottom:8px;">${targetOptions}</select>
        <input id="commentAuthor" type="text" placeholder="Who commented (optional)" style="width:100%;padding:8px;margin-bottom:8px;box-sizing:border-box;">
        <textarea id="commentText" placeholder="Paste the comment text here..." style="min-height:60px;"></textarea>
        <textarea id="suggestedReply" placeholder="Your reply (write it here, or paste a suggestion)..." style="margin-top:8px;min-height:60px;"></textarea>
        <button type="submit">Add to queue</button>
      `}
    </form>
    ${replyDraftsHtml}
    ${postedRepliesHtml}
  `;

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
        <select id="newSlot" style="width:100%;padding:8px;margin-top:8px;box-sizing:border-box;">
          ${SLOTS.map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
        <button type="submit">Add to queue</button>
      </form>

      <h3>Pending, by time slot</h3>
      ${pendingBySlot}
      ${postedHtml}
      ${replySection}

      <script>
        // The session cookie (set once at /login) authenticates these
        // requests automatically — no more password prompts here.
        async function changeSlot(id, slot){
          await fetch('/api/drafts/'+id, {
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({slot})
          });
          location.reload();
        }
        async function addDraft(e){
          e.preventDefault();
          const text = document.getElementById('newText').value;
          const imageUrl = document.getElementById('newImage').value;
          const slot = document.getElementById('newSlot').value;
          await fetch('/api/drafts', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({text, imageUrl, slot})
          });
          location.reload();
        }
        async function saveDraft(id){
          const text = document.querySelector('textarea[data-id="'+id+'"]').value;
          await fetch('/api/drafts/'+id, {
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({text})
          });
          alert('Saved.');
        }
        async function postDraft(id){
          if(!confirm('Post this to LinkedIn now?')) return;
          const res = await fetch('/api/drafts/'+id+'/post', {method:'POST'});
          const data = await res.json();
          if(data.error){ alert('Failed: ' + JSON.stringify(data)); return; }
          location.reload();
        }
        async function deleteDraft(id){
          if(!confirm('Delete this draft?')) return;
          await fetch('/api/drafts/'+id, {method:'DELETE'});
          location.reload();
        }
        async function retryBlog(id){
          const res = await fetch('/api/drafts/'+id+'/retry-blog', {method:'POST'});
          const data = await res.json();
          if(data.error){ alert('Blog retry failed: ' + data.error); }
          location.reload();
        }
        async function addReply(e){
          e.preventDefault();
          const targetPostUrn = document.getElementById('replyTarget').value;
          const commentAuthor = document.getElementById('commentAuthor').value;
          const commentText = document.getElementById('commentText').value;
          const suggestedReply = document.getElementById('suggestedReply').value;
          const res = await fetch('/api/reply-drafts', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({targetPostUrn, commentAuthor, commentText, suggestedReply})
          });
          const data = await res.json();
          if(data.error){ alert('Failed: ' + data.error); return; }
          location.reload();
        }
        async function saveReply(id){
          const suggestedReply = document.querySelector('textarea[data-reply-id="'+id+'"]').value;
          await fetch('/api/reply-drafts/'+id, {
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({suggestedReply})
          });
          alert('Saved.');
        }
        async function postReply(id){
          if(!confirm('Post this reply to LinkedIn now?')) return;
          const res = await fetch('/api/reply-drafts/'+id+'/post', {method:'POST'});
          const data = await res.json();
          if(data.error){ alert('Failed: ' + JSON.stringify(data)); return; }
          location.reload();
        }
        async function deleteReply(id){
          if(!confirm('Delete this reply draft?')) return;
          await fetch('/api/reply-drafts/'+id, {method:'DELETE'});
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
