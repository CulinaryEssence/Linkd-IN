// =====================================================================
// Dynamic Infographic & Chart Prompt Transformer (LLM Step)
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
    2. Culinary Science & Food Chemistry (e.g., starch gelatinization, emulsions, Maillard reaction):
       Render a modern molecular or structural infographic showing visual cross-sections, chemical process stages, and key technical icons.
    3. Kitchen Management & Operations (e.g., prep workflow, FIFO, kitchen layout):
       Render a clean vector workflow diagram, station layout blueprint, or process control checklist graphic.
    4. Culinary Techniques & Equipment Mechanics:
       Render a step-by-step vector instructional diagram showing angles, technique cutaways, thermal gradients, or tool mechanics.

    STYLE & FORMATTING:
    - Aesthetics: Clean typography hierarchy, modern vector illustration, technical blueprint/infographic layout, high contrast, professional engineering manual style.
    - Format: 1:1 square aspect ratio.
    - Negative Constraints: NO plain food photography, NO plated meals, NO stylized lifestyle shots.

    Output ONLY the final descriptive image generator prompt text.
  `;

  try {
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
          { role: 'user', content: `Generate a dynamic technical chart/infographic visual prompt for this post:\n"${postText}"` }
        ]
      })
    });

    const data = await response.json();
    return data.choices[0]?.message?.content || postText;
  } catch (e) {
    console.error('LLM prompt transformation failed, falling back to original text:', e);
    return postText;
  }
}

// =====================================================================
// Dynamic LinkedIn Post Formatting Engine (LLM Step)
// =====================================================================
async function formatLinkedInPost(rawInput) {
  const systemInstruction = `
    You are an elite technical culinary AI collaborator formatting content for LinkedIn.
    Refine the provided raw input into a highly structured, professional technical post adhering strictly to the following rules:

    STRICT FORMATTING RULES:
    1. ZERO EMOJIS OR SMILEYS: Do not include any emojis under any circumstances. Keep typography clean and strictly professional.
    2. SCROLL-STOPPING HOOK: Start immediately with a counterintuitive operational truth or a common industry mistake in line 1.
    3. HARD TERMS EXPLAINED SIMPLY: Break down complex food science terms, chemical reactions, or metrics using real-world analogies (e.g., thermal mass, amylose ratio, gelatinization threshold).
    4. CONCRETE KITCHEN EXAMPLES: Include specific equipment names, exact temperatures, dimensions, or precise ingredient specs (e.g., shallow hotel pans, 40°F–140°F danger zone, waxy maize starch).
    5. SCANNABLE LAYOUT: Use bold section titles, horizontal rules (---), concise bullet points, and LaTeX notation where appropriate (e.g., $Q = mc\\Delta T$ or $pH < 4.6$).
    6. ACTIONABLE STEPS & PITFALLS: Provide clear numbered execution steps and explicit common operational errors to avoid.
    7. THE GOLDEN RULE: Include a distinct 1-line process formula near the bottom (e.g., Portion -> Chill -> Measure -> Record -> Verify).
    8. ENGAGEMENT QUESTION: End with a specific operational question targeted at culinary directors, food scientists, and operations managers.
  `;

  try {
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
          { role: 'user', content: `Format the following draft into a compliant technical LinkedIn post:\n"${rawInput}"` }
        ]
      })
    });

    const data = await response.json();
    return data.choices[0]?.message?.content || rawInput;
  } catch (e) {
    console.error('LinkedIn post formatting failed, using raw text:', e);
    return rawInput;
  }
}

// ---------- list drafts (used by the Ops Hub app to show queue status) ----------
app.get('/api/drafts', requireDashboardAuth, (req, res) => {
  res.json(getDrafts());
});

// ---------- add a draft (formats LinkedIn post text and generates dynamic visual prompt) ----------
app.post('/api/drafts', requireDashboardAuth, async (req, res) => {
  const { text, imageUrl } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  // 1. Format raw post into strict technical LinkedIn structure
  const formattedPostText = await formatLinkedInPost(text);

  // 2. Transform formatted post text into an infographic/chart prompt if no direct image URL is provided
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

// ---------- bulk upgrade queued posts endpoint ----------
app.post('/api/admin/upgrade-all-posts', requireDashboardAuth, async (req, res) => {
  try {
    let drafts = getDrafts();
    let updatedCount = 0;

    for (let i = 0; i < drafts.length; i++) {
      if (drafts[i].status === 'pending') {
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
    res.status(500).json({ error: 'Failed to bulk upgrade posts' });
  }
});
