// api/license-check.js

export const config = {
  runtime: 'nodejs18.x',
};

const ALLOWED_ORIGINS = ['*']; // metti il tuo dominio se vuoi restringere
const DEFAULT_TIMEOUT_MS = 15000;

function corsHeaders(origin) {
  const allowOrigin =
    ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)
      ? origin || '*'
      : ALLOWED_ORIGINS[0];

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
  };
}

// fetch con timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// segue manualmente i redirect (max 3 hop)
async function followRedirects(url, options, timeoutMs, maxHops = 3) {
  let currentUrl = url;
  let lastRes = null;

  for (let i = 0; i <= maxHops; i++) {
    lastRes = await fetchWithTimeout(currentUrl, { ...options, redirect: 'manual' }, timeoutMs);

    // status 200-299 → ok
    if (lastRes.status >= 200 && lastRes.status < 300) {
      return lastRes;
    }

    // redirect?
    if (lastRes.status >= 300 && lastRes.status < 400) {
      const location = lastRes.headers.get('location');
      if (!location) return lastRes;
      currentUrl = location;
      continue;
    }

    // altri status → restituisci
    return lastRes;
  }

  return lastRes;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '*';
  const headersCORS = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', headersCORS['Access-Control-Allow-Origin']);
    res.setHeader('Access-Control-Allow-Methods', headersCORS['Access-Control-Allow-Methods']);
    res.setHeader('Access-Control-Allow-Headers', headersCORS['Access-Control-Allow-Headers']);
    res.setHeader('Access-Control-Max-Age', headersCORS['Access-Control-Max-Age']);
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Access-Control-Allow-Origin', headersCORS['Access-Control-Allow-Origin']);
    return res.status(405).json({ status: 'error', message: 'Method Not Allowed. Use POST.' });
  }

  const target = process.env.LICENSE_WEBHOOK_URL;
  if (!target) {
    res.setHeader('Access-Control-Allow-Origin', headersCORS['Access-Control-Allow-Origin']);
    return res.status(500).json({ status: 'error', message: 'LICENSE_WEBHOOK_URL not configured' });
  }

  try {
    // Prova a leggere il corpo come testo per inoltrarlo 1:1
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const contentType = req.headers['content-type'] || 'application/json';

    const forwardHeaders = {
      'Content-Type': contentType,
      'Accept': 'application/json, text/plain, */*',
      // un UA semplice, MT5 passa il suo; qui mettiamo qualcosa di neutro
      'User-Agent': 'VercelRelay/1.0',
    };

    // inoltro POST (redirect manuale, timeout)
    const response = await followRedirects(
      target,
      {
        method: 'POST',
        headers: forwardHeaders,
        body: rawBody,
      },
      DEFAULT_TIMEOUT_MS,
      3
    );

    // leggi body come testo (potrebbe essere JSON o testo semplice)
    const responseBodyText = await response.text();
    const contentTypeDown = response.headers.get('content-type') || 'application/json; charset=utf-8';

    // passa CORS e content-type a valle
    res.setHeader('Access-Control-Allow-Origin', headersCORS['Access-Control-Allow-Origin']);
    res.setHeader('Content-Type', contentTypeDown);

    // inoltra status e body
    return res.status(response.status).send(responseBodyText);
  } catch (err) {
    // errori (timeout/abort/etc.)
    res.setHeader('Access-Control-Allow-Origin', headersCORS['Access-Control-Allow-Origin']);
    return res.status(502).json({
      status: 'error',
      message: 'Upstream relay error',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
