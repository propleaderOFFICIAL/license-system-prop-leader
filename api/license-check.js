// api/license-check.js
export const config = {
  runtime: 'nodejs',
  // maxDuration: 30, // decommentare solo se hai Vercel Pro
};

// Configurazione
const ALLOWED_ORIGINS = ['*'];
const DEFAULT_TIMEOUT_MS = 9000; // 9 secondi per stare sotto il limite Vercel Hobby (10s)
const MAX_REDIRECTS = 5;

/**
 * Genera header CORS appropriati
 */
function getCorsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)
    ? origin || '*'
    : ALLOWED_ORIGINS[0] || '*';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, User-Agent',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Allow-Credentials': 'true',
  };
}

/**
 * Fetch con timeout
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

/**
 * Segue i redirect manualmente (necessario per Google Apps Script)
 */
async function followRedirects(url, options, timeoutMs, maxRedirects = MAX_REDIRECTS) {
  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount <= maxRedirects) {
    const response = await fetchWithTimeout(
      currentUrl,
      { ...options, redirect: 'manual' },
      timeoutMs
    );

    // Status 2xx = successo
    if (response.status >= 200 && response.status < 300) {
      return response;
    }

    // Status 3xx = redirect
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      
      if (!location) {
        return response;
      }

      currentUrl = location.startsWith('http') 
        ? location 
        : new URL(location, currentUrl).toString();
      
      redirectCount++;
      console.log(`Redirect ${redirectCount}: ${currentUrl}`);
      continue;
    }

    // Altri status (4xx, 5xx)
    return response;
  }

  throw new Error(`Too many redirects (max: ${maxRedirects})`);
}

/**
 * Handler principale
 */
export default async function handler(req, res) {
  const startTime = Date.now();
  const origin = req.headers.origin || req.headers.referer || '*';
  const corsHeaders = getCorsHeaders(origin);

  // Applica header CORS
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  // Gestione preflight OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Accetta solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({
      status: 'error',
      message: 'Method Not Allowed. Only POST requests are accepted.',
    });
  }

  // Verifica environment variable
  const targetUrl = process.env.LICENSE_WEBHOOK_URL;
  
  if (!targetUrl) {
    console.error('LICENSE_WEBHOOK_URL not configured');
    return res.status(500).json({
      status: 'error',
      message: 'Server configuration error',
    });
  }

  try {
    // Prepara body
    let bodyToForward;
    const contentType = req.headers['content-type'] || 'application/json';

    if (typeof req.body === 'string') {
      bodyToForward = req.body;
    } else if (req.body && typeof req.body === 'object') {
      bodyToForward = JSON.stringify(req.body);
    } else {
      bodyToForward = JSON.stringify({});
    }

    console.log('Forwarding to:', targetUrl);
    console.log('Body length:', bodyToForward.length);

    // Header da inoltrare
    const forwardHeaders = {
      'Content-Type': contentType,
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': req.headers['user-agent'] || 'MT5-VercelRelay/2.0',
    };

    // Inoltra richiesta
    const upstreamResponse = await followRedirects(
      targetUrl,
      {
        method: 'POST',
        headers: forwardHeaders,
        body: bodyToForward,
      },
      DEFAULT_TIMEOUT_MS,
      MAX_REDIRECTS
    );

    // Leggi risposta
    const responseBody = await upstreamResponse.text();
    const responseContentType = upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8';

    const duration = Date.now() - startTime;
    console.log('Status:', upstreamResponse.status, 'Duration:', duration, 'ms');

    res.setHeader('Content-Type', responseContentType);
    res.setHeader('X-Relay-Duration', duration.toString());

    return res.status(upstreamResponse.status).send(responseBody);

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('Error:', error.message);

    let statusCode = 502;
    let errorMessage = 'Upstream relay error';

    if (error.message.includes('timeout')) {
      statusCode = 504;
      errorMessage = 'Request timeout';
    }

    res.setHeader('X-Relay-Duration', duration.toString());

    return res.status(statusCode).json({
      status: 'error',
      message: errorMessage,
      detail: error.message,
    });
  }
}
