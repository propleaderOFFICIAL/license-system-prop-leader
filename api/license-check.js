// api/license-check.js
export const config = {
  runtime: 'nodejs18.x',
  maxDuration: 30, // Max 30 secondi per Vercel Hobby (10 per default)
};

// Configurazione
const ALLOWED_ORIGINS = ['*']; // Cambia con il tuo dominio se vuoi restringere
const DEFAULT_TIMEOUT_MS = 25000; // 25 secondi (sotto il limite Vercel)
const MAX_REDIRECTS = 5; // Google Apps Script può fare più redirect

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
        // Redirect senza Location header
        return response;
      }

      // URL assoluto o relativo
      currentUrl = location.startsWith('http') 
        ? location 
        : new URL(location, currentUrl).toString();
      
      redirectCount++;
      
      // Log per debug (visibile nei log Vercel)
      console.log(`Redirect ${redirectCount}: ${currentUrl}`);
      
      continue;
    }

    // Altri status (4xx, 5xx) = restituisci la risposta così com'è
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

  // Applica header CORS a tutte le risposte
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
      allowedMethods: ['POST', 'OPTIONS'],
    });
  }

  // Verifica che l'environment variable sia configurata
  const targetUrl = process.env.LICENSE_WEBHOOK_URL;
  
  if (!targetUrl) {
    console.error('LICENSE_WEBHOOK_URL not configured');
    return res.status(500).json({
      status: 'error',
      message: 'Server configuration error: LICENSE_WEBHOOK_URL not set',
    });
  }

  try {
    // Prepara il body da inoltrare
    let bodyToForward;
    const contentType = req.headers['content-type'] || 'application/json';

    if (typeof req.body === 'string') {
      bodyToForward = req.body;
    } else if (req.body && typeof req.body === 'object') {
      bodyToForward = JSON.stringify(req.body);
    } else {
      bodyToForward = JSON.stringify({});
    }

    // Log request (utile per debug)
    console.log('Forwarding request to:', targetUrl);
    console.log('Content-Type:', contentType);
    console.log('Body length:', bodyToForward.length);

    // Header da inoltrare
    const forwardHeaders = {
      'Content-Type': contentType,
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': req.headers['user-agent'] || 'MT5-VercelRelay/2.0',
      'Accept-Encoding': 'gzip, deflate',
    };

    // Inoltra la richiesta con gestione redirect
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

    // Leggi la risposta
    const responseBody = await upstreamResponse.text();
    const responseContentType = upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8';

    // Log response
    const duration = Date.now() - startTime;
    console.log('Response status:', upstreamResponse.status);
    console.log('Response length:', responseBody.length);
    console.log('Duration:', duration, 'ms');

    // Imposta Content-Type della risposta
    res.setHeader('Content-Type', responseContentType);
    
    // Aggiungi header custom per debug
    res.setHeader('X-Relay-Duration', duration.toString());
    res.setHeader('X-Relay-Status', 'success');

    // Restituisci la risposta con lo stesso status code
    return res.status(upstreamResponse.status).send(responseBody);

  } catch (error) {
    const duration = Date.now() - startTime;
    
    // Log errore dettagliato
    console.error('Relay error:', error);
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Duration:', duration, 'ms');

    // Determina il tipo di errore
    let errorMessage = 'Upstream relay error';
    let errorDetail = error.message;
    let statusCode = 502;

    if (error.message.includes('timeout')) {
      errorMessage = 'Request timeout';
      statusCode = 504;
    } else if (error.message.includes('DNS')) {
      errorMessage = 'DNS resolution failed';
      statusCode = 502;
    } else if (error.message.includes('ECONNREFUSED')) {
      errorMessage = 'Connection refused';
      statusCode = 502;
    } else if (error.message.includes('redirect')) {
      errorMessage = 'Too many redirects';
      statusCode = 508;
    }

    res.setHeader('X-Relay-Duration', duration.toString());
    res.setHeader('X-Relay-Status', 'error');

    return res.status(statusCode).json({
      status: 'error',
      message: errorMessage,
      detail: errorDetail,
      timestamp: new Date().toISOString(),
      duration: duration,
    });
  }
}
