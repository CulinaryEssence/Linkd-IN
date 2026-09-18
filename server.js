// =====================================================================
// Dynamic Infographic & Chart Prompt Transformer (LLM Step)
// =====================================================================
async function createVisualPrompt(postText) {
 const systemInstruction = `
    You are an expert technical visual graphic designer for professional culinary, food science, and hospitality management content.
    Analyze the provided post text and construct an explicit visual prompt for an image generator.

    CORE MANDATE:
    - Never generate generic plated food photography or aesthetic restaurant dish photos unless explicitly requested.
    - Match the precise technical, scientific, or procedural topic of the post.

    CATEGORIZATION & VISUAL DIRECTIVES:
    1. Food Safety & Temperature Control:
       Render a 2-panel technical comparison diagram, flow chart, or temperature zone graph showing equipment, temperature callouts, and process warnings.
    2. Culinary Science & Food Chemistry (e.g., gluten, emulsions, maillard reaction):
       Render a modern molecular or structural infographic showing visual cross-sections, chemical process stages, and key technical icons.
    3. Kitchen Management & Operations (e.g., prep workflow, FIFO, kitchen design):
       Render a clean vector workflow diagram, station layout blueprint, or process control checklist graphic.
    4. Culinary Techniques & Knife Skills:
       Render a step-by-step vector instructional diagram showing angles, technique cutaways, or tool mechanics.

    STYLE & FORMATTING:
    - Aesthetics: Clean typography hierarchy, modern vector illustration, technical blueprint/infographic layout, high contrast, professional manual style.
    - Format: 1:1 square aspect ratio.
    - Negative Constraints: NO plain food photography, NO stock photos of chefs holding plates.

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
          { role: 'user', content: `Generate a dynamic chart/infographic visual prompt for this post:\n"${postText}"` }
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

// ---------- list drafts (used by the Ops Hub app to show queue status) ----------
app.get('/api/drafts', requireDashboardAuth, (req, res) => {
  res.json(getDrafts());
});

// ---------- add a draft (now uses dynamic LLM prompt transformation) ----------
app.post('/api/drafts', requireDashboardAuth, async (req, res) => {
  const { text, imageUrl } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  // 1. Transform post text into an infographic/chart prompt if no direct image URL is provided
  let finalPrompt = text;
  if (!imageUrl) {
    finalPrompt = await createVisualPrompt(text);
  }

  const drafts = getDrafts();
  const draft = {
    id: crypto.randomUUID(),
    text,
    visualPrompt: finalPrompt, // Attached dynamic chart/infographic instructions
    imageUrl: imageUrl || null,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  drafts.unshift(draft);
  saveDrafts(drafts);
  res.json(draft);
});
