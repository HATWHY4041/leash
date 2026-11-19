// One place to call the LLM.
// Option A: any OpenAI-compatible API (e.g. Groq's free tier) via LLM_API_KEY (+ LLM_BASE_URL, LLM_MODEL).
//           If LLM_MODEL is not set, a suitable model is picked from the provider's live /models list.
// Option B: Vercel AI Gateway (OIDC on Vercel, or AI_GATEWAY_API_KEY), model LEASH_MODEL.
import { generateText } from 'ai';

const PREFERRED = [
  /gpt-oss-120b/, /llama-4-maverick/, /llama-3\.3-70b/, /llama-4-scout/, /qwen.*32b/, /gpt-oss-20b/, /llama-3\.1-8b/, /llama/,
];
let cachedModel = null;

async function pickModel(base, key) {
  if (process.env.LLM_MODEL) return process.env.LLM_MODEL;
  if (cachedModel) return cachedModel;
  const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`LLM models ${r.status}`);
  const ids = ((await r.json()).data || [])
    .filter((m) => m.active !== false)
    .map((m) => m.id)
    .filter((id) => !/whisper|tts|guard|embed|vision|audio|playai|orpheus/i.test(id));
  for (const re of PREFERRED) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return (cachedModel = hit);
  }
  if (!ids.length) throw new Error('no chat models available');
  return (cachedModel = ids[0]);
}

export async function complete({ system, prompt, maxTokens = 300, timeoutMs = 9000 }) {
  if (process.env.LLM_API_KEY) {
    const key = process.env.LLM_API_KEY;
    const base = (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
    const model = await pickModel(base, key);
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: maxTokens,
        messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) { cachedModel = null; throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 150)}`); }
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content || '';
    return { text: text.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), model };
  }
  const model = process.env.LEASH_MODEL || 'openai/gpt-4.1-mini';
  const { text } = await generateText({
    model, system, prompt, temperature: 0, maxOutputTokens: maxTokens, abortSignal: AbortSignal.timeout(timeoutMs),
  });
  return { text, model };
}
