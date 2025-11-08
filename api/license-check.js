// api/license-check.js
export const config = {
  runtime: 'nodejs',
};

const ALLOWED_ORIGINS = ['*'];
const DEFAULT_TIMEOUT_MS = 9000;
const MAX_REDIRECTS = 5;

function getCorsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)
    ? origin || '*'
    : ALLOWED_ORIGINS[0] || '*';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, User-Agent',
    'Access-Control-Max-Age': '86400',
  };
}

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
 * Segue redirect convertendo POST->GET al primo redirect
 */
async function handleGoogleAppsScriptRedirect(initialUrl, jsonBody, timeoutMs, maxRedirects = MAX_REDIRECTS) {
  let redirectCount = 0;
  
  // STEP 1: Prima richiesta POST all'URL originale
  console.log(`[1] POST ${initialUrl}`);
  
  const firstResponse = await fetchWithTimeout(
    initialUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'MT5-VercelRelay/2.0',
      },
      body: jsonBody,
      redirect: 'manual',
    },
    timeoutMs
  );

  // Se la prima richiesta ha successo (nessun redirect)
  if (firstResponse.status >= 200 && firstResponse.status < 300) {
    console.log(`[1] Direct success: ${firstResponse.status}`);
    return firstResponse;
  }

  // Se non è un redirect, ritorna l'errore
  if (firstResponse.status < 300 || firstResponse.status >= 400) {
    console.log(`[1] Non-redirect response: ${firstResponse.status}`);
    return firstResponse;
  }

  // STEP 2: Ottieni l'URL del redirect
  const redirectLocation = firstResponse.headers.get('location');
  if (!redirectLocation) {
    console.log('[1] Redirect without location header');
    return firstResponse;
  }

  const redirectUrl = redirectLocation.startsWith('http')
    ? redirectLocation
    : new URL(redirectLocation, initialUrl).toString();

  console.log(`[1] Redirected to: ${redirectUrl}`);
  redirectCount++;

  // STEP 3: Converti il JSON in query parameters
  let finalUrl = redirectUrl;
  try {
    const data = JSON.parse(jsonBody);
    const params = new URLSearchParams();
    
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && value !== undefined) {
        const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
        params.append(key, stringValue);
      }
    }
    
    // Aggiungi i parametri all'URL
    const paramString = params.toString();
    if (paramString) {
      finalUrl = redirectUrl.includes('?')
        ? `${redirectUrl}&${paramString}`
        : `${redirectUrl}?${paramString}`;
    }
  } catch (e) {
    console.error('[2] Error parsing JSON:', e);
  }

  // STEP 4: Fai la richiesta GET finale
  console.log(`[2] GET ${finalUrl.substring(0, 150)}...`);

  const finalResponse = await fetchWithTimeout(
    finalUrl,
    {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'MT5-VercelRelay/2.0',
      },
      redirect: 'manual',
    },
    timeoutMs
  );

  console.log(`[2] Response status: ${finalResponse.status}`);

  // Se otteniamo un successo, ritorna
  if (finalResponse.status >= 200 && finalResponse.status < 300) {
    return finalResponse;
  }

  // Se c'è un altro redirect, seguilo (max 3 ulteriori hop)
  let currentUrl = finalUrl;
  let currentResponse = finalResponse;

  while (redirectCount < maxRedirects) {
    if (currentResponse.status < 300 || currentResponse.status >= 400) {
      break;
    }

    const nextLocation = currentResponse.headers.get('location');
    if (!nextLocation) {
      break;
    }

    currentUrl = nextLocation.startsWith('http')
      ? nextLocation
      : new URL(nextLocation, currentUrl).toString();

    redirectCount++;
    console.log(`[${redirectCount + 1}] GET redirect to: ${currentUrl}`);

    currentResponse = await fetchWithTimeout(
      currentUrl,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'MT5-VercelRelay/2.0',
        },
        redirect: 'manual',
      },
      timeoutMs
    );

    console.log(`[${redirectCount + 1}] Response status: ${currentResponse.status}`);

    if (currentResponse.status >= 200 && currentResponse.status < 300) {
      return currentResponse;
    }
  }

  if (redirectCount >= maxRedirects) {
    throw new Error(`Too many redirects (${redirectCount})`);
  }

  return currentResponse;
}

export default async function handler(req, res) {
  const startTime = Date.now();
  const origin = req.headers.origin || req.headers.referer || '*';
  const corsHeaders = getCorsHeaders(origin);

  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      status: 'error',
      message: 'Only POST method is allowed',
    });
  }

  const targetUrl = process.env.LICENSE_WEBHOOK_URL;
  
  if (!targetUrl) {
    console.error('LICENSE_WEBHOOK_URL not configured');
    return res.status(500).json({
      status: 'error',
      message: 'Server misconfiguration',
    });
  }

  try {
    let bodyToForward;
    
    if (typeof req.body === 'string') {
      bodyToForward = req.body;
    } else if (req.body && typeof req.body === 'object') {
      bodyToForward = JSON.stringify(req.body);
    } else {
      bodyToForward = JSON.stringify({});
    }

    console.log('=== Request Start ===');
    console.log('Target:', targetUrl);
    console.log('Body:', bodyToForward);

    const upstreamResponse = await handleGoogleAppsScriptRedirect(
      targetUrl,
      bodyToForward,
      DEFAULT_TIMEOUT_MS,
      MAX_REDIRECTS
    );

    const responseBody = await upstreamResponse.text();
    const responseContentType = upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8';
    const duration = Date.now() - startTime;

    console.log('=== Response ===');
    console.log('Status:', upstreamResponse.status);
    console.log('Duration:', duration, 'ms');
    console.log('Body preview:', responseBody.substring(0, 300));

    res.setHeader('Content-Type', responseContentType);
    res.setHeader('X-Relay-Duration', duration.toString());

    return res.status(upstreamResponse.status).send(responseBody);

  } catch (error) {
    const duration = Date.now() - startTime;
    
    console.error('=== Error ===');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
    console.error('Duration:', duration, 'ms');

    let statusCode = 502;
    let errorMessage = 'Relay error';

    if (error.message.includes('timeout')) {
      statusCode = 504;
      errorMessage = 'Request timeout';
    } else if (error.message.includes('redirect')) {
      statusCode = 508;
      errorMessage = 'Too many redirects';
    }

    res.setHeader('X-Relay-Duration', duration.toString());

    return res.status(statusCode).json({
      status: 'error',
      message: errorMessage,
      detail: error.message,
    });
  }
}
