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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, User-Agent',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Allow-Credentials': 'true',
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
 * Converte POST in GET con query parameters dopo il primo redirect
 */
async function followRedirectsWithMethodSwitch(url, jsonBody, timeoutMs, maxRedirects = MAX_REDIRECTS) {
  let currentUrl = url;
  let redirectCount = 0;
  let usePost = true; // Prima richiesta usa POST

  while (redirectCount <= maxRedirects) {
    let options;

    if (usePost) {
      // Prima richiesta: POST con JSON body
      options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'MT5-VercelRelay/2.0',
        },
        body: jsonBody,
        redirect: 'manual',
      };
      console.log(`Request ${redirectCount + 1}: POST ${currentUrl}`);
    } else {
      // Dopo redirect: GET con query parameters
      try {
        const data = JSON.parse(jsonBody);
        const params = new URLSearchParams();
        
        // Converti ogni campo in query parameter
        for (const [key, value] of Object.entries(data)) {
          if (value !== null && value !== undefined) {
            params.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
          }
        }
        
        // Aggiungi parameters all'URL
        const separator = currentUrl.includes('?') ? '&' : '?';
        currentUrl = `${currentUrl}${separator}${params.toString()}`;
      } catch (e) {
        console.error('Error converting POST to GET:', e);
      }

      options = {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'MT5-VercelRelay/2.0',
        },
        redirect: 'manual',
      };
      console.log(`Request ${redirectCount + 1}: GET ${currentUrl}`);
    }

    const response = await fetchWithTimeout(currentUrl, options, timeoutMs);

    // Status 2xx = successo
    if (response.status >= 200 && response.status < 300) {
      console.log(`Success: ${response.status}`);
      return response;
    }

    // Status 3xx = redirect
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      
      if (!location) {
        console.log('Redirect without location header');
        return response;
      }

      // Risolvi URL relativo o assoluto
      currentUrl = location.startsWith('http') 
        ? location 
        : new URL(location, currentUrl).toString();
      
      redirectCount++;
      usePost = false; // Dopo il primo redirect, usa GET
      
      console.log(`Redirect ${redirectCount} to: ${currentUrl}`);
      continue;
    }

    // Altri status (4xx, 5xx)
    console.log(`Non-redirect status: ${response.status}`);
    return response;
  }

  throw new Error(`Too many redirects (max: ${maxRedirects})`);
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
      message: 'Method Not Allowed. Only POST requests are accepted.',
    });
  }

  const targetUrl = process.env.LICENSE_WEBHOOK_URL;
  
  if (!targetUrl) {
    console.error('LICENSE_WEBHOOK_URL not configured');
    return res.status(500).json({
      status: 'error',
      message: 'Server configuration error',
    });
  }

  try {
    // Prepara body JSON
    let bodyToForward;
    
    if (typeof req.body === 'string') {
      bodyToForward = req.body;
    } else if (req.body && typeof req.body === 'object') {
      bodyToForward = JSON.stringify(req.body);
    } else {
      bodyToForward = JSON.stringify({});
    }

    console.log('=== Incoming Request ===');
    console.log('Target URL:', targetUrl);
    console.log('Body length:', bodyToForward.length);
    console.log('Body preview:', bodyToForward.substring(0, 200));

    // Inoltra con conversione automatica POST→GET
    const upstreamResponse = await followRedirectsWithMethodSwitch(
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
    console.log('Body length:', responseBody.length);
    console.log('Body preview:', responseBody.substring(0, 200));

    res.setHeader('Content-Type', responseContentType);
    res.setHeader('X-Relay-Duration', duration.toString());
    res.setHeader('X-Relay-Method', 'POST-to-GET');

    return res.status(upstreamResponse.status).send(responseBody);

  } catch (error) {
    const duration = Date.now() - startTime;
    
    console.error('=== Error ===');
    console.error('Message:', error.message);
    console.error('Duration:', duration, 'ms');

    let statusCode = 502;
    let errorMessage = 'Upstream relay error';

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
