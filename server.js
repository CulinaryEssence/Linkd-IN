// Culinary Essence storage API.
// Mirrors window.storage's get/set behavior exactly (same key format,
// same {key, value} shape) so the app's existing save/load code only
// needs its fetch target changed — not its whole data model.
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const API_KEY = process.env.API_KEY;
const ORG_SLUG = 'culinary-essence';

// Runs on every startup. Safe to run repeatedly — every statement is
// idempotent, so redeploying never duplicates or breaks anything.
async function ensureSchema() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";

    CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS app_storage (
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, key)
    );

    CREATE INDEX IF NOT EXISTS idx_app_storage_org ON app_storage(organization_id);

    INSERT INTO organizations (name, slug)
    SELECT 'Culinary Essence', 'culinary-essence'
    WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE slug = 'culinary-essence');
  `);
  console.log('Schema check complete — tables exist and Culinary Essence organization is seeded.');
}

let orgIdCache = null;
async function getOrgId() {
  if (orgIdCache) return orgIdCache;
  const { rows } = await pool.query('SELECT id FROM organizations WHERE slug = $1', [ORG_SLUG]);
  if (!rows.length) throw new Error('Organization not found.');
  orgIdCache = rows[0].id;
  return orgIdCache;
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ error: 'Server misconfigured — API_KEY not set.' });
  const supplied = req.get('x-api-key');
  if (supplied !== API_KEY) return res.status(401).json({ error: 'Invalid or missing API key.' });
  next();
}

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/api/storage/:key', requireApiKey, async (req, res) => {
  try {
    const orgId = await getOrgId();
    const { rows } = await pool.query(
      'SELECT key, value, updated_at FROM app_storage WHERE organization_id = $1 AND key = $2',
      [orgId, req.params.key]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ key: rows[0].key, value: rows[0].value, updatedAt: rows[0].updated_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/storage/:key', requireApiKey, async (req, res) => {
  try {
    const orgId = await getOrgId();
    const value = req.body.value;
    if (value === undefined) return res.status(400).json({ error: 'Missing "value" in request body.' });
    await pool.query(
      `INSERT INTO app_storage (organization_id, key, value, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (organization_id, key) DO UPDATE SET value = $3, updated_at = now()`,
      [orgId, req.params.key, JSON.stringify(value)]
    );
    res.json({ key: req.params.key, value, ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/storage', requireApiKey, async (req, res) => {
  try {
    const orgId = await getOrgId();
    const { rows } = await pool.query(
      'SELECT key, updated_at, length(value::text) as size_bytes FROM app_storage WHERE organization_id = $1 ORDER BY key',
      [orgId]
    );
    res.json({ keys: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------
// Purchase order email sending, via Resend's HTTP API. Same requireApiKey
// gate as everything else, so the app.html frontend calls it with the
// x-api-key it already has — no new frontend secret needed, just the new
// RESEND_API_KEY set as a Render environment variable (never in code).
// ---------------------------------------------------------------------
const RESEND_FROM_ADDRESS = 'Kartik Dubey <kartik.dubey@culinaryessence.com>';
const RESEND_API_URL = 'https://api.resend.com/emails';

app.post('/api/purchasing/send-order-email', requireApiKey, async (req, res) => {
  const { to, subject, message } = req.body || {};
  if (!to || !subject || !message) {
    return res.status(400).json({ error: 'Missing to, subject, or message' });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY is not set on this server' });
  }
  try {
    const resendRes = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: RESEND_FROM_ADDRESS, to: [to], subject, text: message })
    });
    const data = await resendRes.json();
    if (!resendRes.ok) {
      console.error('Resend API error:', data);
      return res.status(502).json({ error: 'Resend rejected the email', details: data });
    }
    res.json({ success: true, id: data.id });
  } catch (e) {
    console.error('Failed to send order email:', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log('Culinary Essence API listening on port ' + PORT));
  })
  .catch(e => {
    console.error('Failed to set up database schema on startup:', e);
    process.exit(1);
  });
