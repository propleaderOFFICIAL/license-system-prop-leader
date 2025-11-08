// api/license-check.js
export const config = {
  runtime: 'nodejs',
};

const ALLOWED_ORIGINS = ['*'];
const REQUEST_TIMEOUT_MS = 25000;

function getCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, User-Agent',
    'Access-Control-Max-Age': '86400',
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
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
    throw error;
  }
}

export default async function handler(req, res) {
  const startTime = Date.now();
  const origin = req.headers.origin || '*';
  const corsHeaders = getCorsHeaders(origin);

  // CORS headers
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({
      status: 'error',
      message: 'Only POST allowed',
    });
  }

  const gasUrl = process.env.LICENSE_WEBHOOK_URL;
  
  if (!gasUrl) {
    console.error('LICENSE_WEBHOOK_URL not configured');
    return res.status(500).json({
      status: 'error',
      message: 'Server configuration error',
    });
  }

  try {
    // Parse body
    let bodyData;
    if (typeof req.body === 'string') {
      bodyData = JSON.parse(req.body);
    } else {
      bodyData = req.body || {};
    }

    console.log('=== REQUEST ===');
    console.log('License Key:', bodyData.licenseKey);
    console.log('Product:', bodyData.product);

    // Converti in query string per GET (Google Apps Script gestisce meglio GET dopo redirect)
    const params = new URLSearchParams();
    Object.entries(bodyData).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        params.append(key, String(value));
      }
    });

    const finalUrl = `${gasUrl}?${params.toString()}`;
    
    console.log('Calling:', gasUrl);

    // Fai richiesta GET (evita problemi con redirect)
    const response = await fetchWithTimeout(
      finalUrl,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Vercel-MT5-Relay/3.0',
        },
      },
      REQUEST_TIMEOUT_MS
    );

    const responseText = await response.text();
    const duration = Date.now() - startTime;

    console.log('=== RESPONSE ===');
    console.log('Status:', response.status);
    console.log('Duration:', duration, 'ms');
    console.log('Body:', responseText.substring(0, 200));

    // Parse response
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      console.error('JSON parse error:', e);
      responseData = {
        status: 'error',
        message: 'Invalid response from license server',
        raw: responseText.substring(0, 100),
      };
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Response-Time', `${duration}ms`);

    return res.status(response.status).json(responseData);

  } catch (error) {
    const duration = Date.now() - startTime;
    
    console.error('=== ERROR ===');
    console.error('Message:', error.message);
    console.error('Duration:', duration, 'ms');

    let statusCode = 502;
    let errorMessage = 'License server error';

    if (error.name === 'AbortError' || error.message.includes('timeout')) {
      statusCode = 504;
      errorMessage = 'Request timeout';
    }

    res.setHeader('X-Response-Time', `${duration}ms`);

    return res.status(statusCode).json({
      status: 'error',
      message: errorMessage,
      detail: error.message,
    });
  }
}
