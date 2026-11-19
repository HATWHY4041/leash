// Receives client-side error reports so wallet problems can be diagnosed from Vercel runtime logs.
// Stores nothing; never receives keys (the client only sends error text).
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  console.error('[leash-client-error]', JSON.stringify({
    where: String(b.where || '').slice(0, 60),
    msg: String(b.msg || '').slice(0, 1500),
    code: b.code ?? null,
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
  }));
  res.status(204).end();
}
