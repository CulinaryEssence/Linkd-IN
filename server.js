const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

// Set CORS and CSP headers to allow local API requests
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data:; connect-src 'self' https:;"
  );
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// Serve static UI files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const DB_FILE = path.join(__dirname, 'app_storage.json');

function getDrafts() {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveDrafts(drafts) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(drafts, null, 2), 'utf8');
  } catch (e) {}
}

function requireDashboardAuth(req, res, next) {
  next();
}

async function createVisualPrompt(postText) {
  const systemInstruction = `
    You are an expert technical visual graphic designer for professional culinary, food science, and hospitality management content.
    Analyze the provided post text and construct an explicit visual prompt for an image generator.
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
          { role: 'user', content: `Generate visual prompt for: "${postText}"` }
        ]
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || postText;
  } catch (e) {
    return postText;
  }
}

async function formatLinkedInPost(rawInput) {
  const systemInstruction = `
    You are an elite technical culinary AI collaborator formatting content for LinkedIn.
    ZERO EMOJIS OR SMILEYS. Start immediately with a counterintuitive operational truth.
    Break down complex food science terms with real-world analogies. Include concrete kitchen examples.
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
          { role: 'user', content: `Format post: "${rawInput}"` }
        ]
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || rawInput;
  } catch (e) {
    return rawInput;
  }
}

// Fallback home page handler
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else if (fs.existsSync(path.join(__dirname, 'public', 'index.html'))) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.send('Server running. Upgrade endpoint ready at /api/admin/upgrade-all-posts');
  }
});

app.get('/api/drafts', requireDashboardAuth, (req, res) => {
  res.json(getDrafts());
});

app.post('/api/admin/upgrade-all-posts', requireDashboardAuth, async (req, res) => {
  try {
    let drafts = getDrafts();
    let updatedCount = 0;

    for (let i = 0; i < drafts.length; i++) {
      // Upgrades any draft that is not explicitly marked as published
      if (drafts[i].status !== 'published') {
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
    res.status(500).json({ error: 'Failed to upgrade posts' });
  }
});

    saveDrafts(drafts);
    res.json({ success: true, upgraded: updatedCount });
  } catch (e) {
    res.status(500).json({ error: 'Failed to upgrade posts' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
