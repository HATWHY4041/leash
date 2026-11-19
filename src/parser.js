// Intent parsing: try the AI endpoint first, fall back to a local rule-based parser.
// Whatever comes back is re-validated here against the real payee list before anything happens.

export async function parseIntent(message, payeeNames) {
  let intent = null;
  let source = 'local';
  try {
    const r = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, payees: payeeNames }),
      signal: AbortSignal.timeout(9000),
    });
    const j = await r.json();
    if (j.ok && j.intent?.intent) { intent = j.intent; source = 'ai'; }
  } catch { /* offline or no AI: use local */ }
  if (!intent) intent = localParse(message, payeeNames);
  return { ...sanitize(intent, payeeNames, message), source };
}

function sanitize(i, names, message) {
  const out = { intent: i.intent || 'unknown', payee: null, amount: null, memo: null, note: i.note || null, mentioned: null };
  if (i.payee) {
    const hit = names.find((n) => n.toLowerCase() === String(i.payee).toLowerCase());
    if (hit) out.payee = hit; else out.mentioned = String(i.payee);
  }
  const amt = Number(i.amount);
  if (Number.isFinite(amt) && amt > 0) out.amount = Math.round(amt * 1e6) / 1e6;
  if (i.memo) out.memo = String(i.memo).replace(/[\u0000-\u001f]/g, '').slice(0, 60);
  if (out.intent === 'pay' && !out.payee && !out.mentioned) out.mentioned = guessName(message);
  return out;
}

function guessName(msg) {
  const m = msg.match(/(?:pay|send|to|give)\s+([a-z][\w'-]{1,20})/i);
  if (!m) return null;
  const w = m[1].toLowerCase();
  return ['me', 'my', 'the', 'him', 'her', 'them', 'usd', 'tusd8', 'some'].includes(w) ? null : m[1];
}

export function localParse(message, names) {
  const t = message.toLowerCase().trim();
  const amountMatch = t.match(/\$?\s?(\d+(?:\.\d+)?)/);
  const amount = amountMatch ? Number(amountMatch[1]) : null;
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const payee = sorted.find((n) => new RegExp(`\\b${escape(n.toLowerCase())}\\b`).test(t)) || null;
  const memoMatch = message.match(/\bfor\s+(.+)$/i);
  const memo = memoMatch ? memoMatch[1].trim() : null;

  if (!amount && /\b(who can|who do|payees|contacts)\b/.test(t)) return { intent: 'payees' };
  if (/\b(pay|send|transfer|give|tip|settle)\b/.test(t) || (amount && payee)) {
    return { intent: 'pay', payee, amount, memo };
  }
  if (/\b(pause|freeze|stop|kill|lock)\b/.test(t)) return { intent: 'pause' };
  if (/\b(pending|approv|request|waiting)/.test(t)) return { intent: 'pending' };
  if (/\b(spent|spend|limit|remaining|left today|today)\b/.test(t)) return { intent: 'spent' };
  if (/\b(balance|how much (do i|have i|is)|funds|wallet)\b/.test(t)) return { intent: 'balance' };
  if (/\b(who can|payees|contacts|people)\b/.test(t)) return { intent: 'payees' };
  if (/\b(help|what can you|how do)\b/.test(t)) return { intent: 'help' };
  return { intent: 'unknown' };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
