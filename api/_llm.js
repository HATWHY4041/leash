// One place to call the LLM.
// Option A: any OpenAI-compatible API (e.g. Groq's free tier) via LLM_API_KEY (+ LLM_BASE_URL, LLM_MODEL).
// Option B: Vercel AI Gateway (OIDC on Vercel, or AI_GATEWAY_API_KEY), model LEASH_MODEL.
import { generateText } from 'ai';

export async function complete({ system, prompt, maxTokens = 200, timeoutMs = 8000 }) {
  if (process.env.LLM_API_KEY) {
    const base = (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
    const model = process.env.LLM_MODEL || 'llama-3.3-70b-versatile';
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY}` },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: maxTokens,
        messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 150)}`);
    const j = await r.json();
    return { text: j.choices?.[0]?.message?.content || '', model };
  }
  const model = process.env.LEASH_MODEL || 'openai/gpt-4.1-mini';
  const { text } = await generateText({
    model, system, prompt, temperature: 0, maxOutputTokens: maxTokens, abortSignal: AbortSignal.timeout(timeoutMs),
  });
  return { text, model };
}
