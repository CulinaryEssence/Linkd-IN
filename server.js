// =====================================================================
// Dynamic Infographic & Chart Prompt Transformer (LLM Step)
// =====================================================================
async function createVisualPrompt(postText) {
  const systemInstruction = `
    You are an expert visual graphic designer for professional LinkedIn posts. 
    Analyze the provided post text and output a highly detailed prompt for an image generator.
    
    RULES:
    - If the post text is educational, technical, or scientific (e.g. gluten, nutrition, supply chain, processes): 
      Describe a explicit INFOGRAPHIC, COMPARISON CHART, or STEP-BY-STEP DIAGRAM with clean visual sections, vector icons, and clear typography hierarchy.
    - If the post text is conceptual: 
      Describe a modern editorial vector illustration or clean structural poster representing the concept.
    - DO NOT generate standard food photography or plated dishes unless the text specifically requests a single plate/meal photo.
    - Style guidelines: Clean layout, high-contrast typography hierarchy, professional infographic diagram, vector aesthetics, 1:1 aspect ratio.
    
    Output ONLY the final image generator prompt text.
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
