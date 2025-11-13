// api/license-check.js
export const config = {
  runtime: 'nodejs',
};

const ALLOWED_ORIGINS = ['*'];
const REQUEST_TIMEOUT_MS = 25000;

// Array di endpoint in ordine di priorità
const LICENSE_ENDPOINTS = [
  'https://script.google.com/macros/s/AKfycbzlQh0WLfLcxc6Rq-kCxbU5U-H9oAQ9sdIS51xGs0HuSuQiTCvWg3KhxzsXY5QfKLTKcw/exec',
  'https://script.google.com/macros/s/AKfycbxUvgbIKKcnJoLl_PJkig5CLr8uRw0NJLLBnR33_RaJN7VNqyNUMVwFnVklOF6AEcUO0A/exec',
  'https://script.google.com/macros/s/AKfycbxYVtMsaP3NyLeRk-chvLibWdv5seoog6cxT5pJGd1bdYfQ_jtw4lopc1lK_RFVTGypBw/exec',
  'https://script.google.com/macros/s/AKfycbzhO9QS2_uVBlNKHiCJWUiTaAt0Azj7FpGla2D5EgCXVZkQwzD-V9_CPoIKJnJ582uEvw/exec',
  'https://script.google.com/macros/s/AKfycbyMtrS4xN1RawrqxioEKNA4VO3mx6MmmykCI7mGpzyW97t4NHaT1lYa1JJJmuLnVsY6Hw/exec',
];

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

async function tryLicenseEndpoints(params) {
  const errors = [];
  
  for (let i = 0; i < LICENSE_ENDPOINTS.length; i++) {
    const endpoint = LICENSE_ENDPOINTS[i];
    const endpointNum = i + 1;
    
    try {
      console.log(`[Endpoint ${endpointNum}/${LICENSE_ENDPOINTS.length}] Calling...`);
      
      const finalUrl = `${endpoint}?${params.toString()}`;
      const startTime = Date.now();
      
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
      
      console.log(`[Endpoint ${endpointNum}] Status: ${response.status}, Duration: ${duration}ms`);
      
      // Parse response
      let responseData;
      try {
        responseData = JSON.parse(responseText);
      } catch (e) {
        console.error(`[Endpoint ${endpointNum}] JSON parse error:`, e);
        throw new Error('Invalid JSON response');
      }
      
      // Risposta ottenuta con successo, restituiscila
      console.log(`[Endpoint ${endpointNum}] SUCCESS`);
      return {
        success: true,
        data: responseData,
        status: response.status,
        endpoint: endpointNum,
        duration,
      };
      
    } catch (error) {
      console.error(`[Endpoint ${endpointNum}] FAILED:`, error.message);
      errors.push({
        endpoint: endpointNum,
        error: error.message,
      });
      
      // Se non è l'ultimo endpoint, continua al prossimo
      if (i < LICENSE_ENDPOINTS.length - 1) {
        console.log(`[Endpoint ${endpointNum}] Trying next endpoint...`);
        continue;
      }
    }
  }
  
  // Tutti gli endpoint hanno fallito
  console.error('ALL ENDPOINTS FAILED');
  
  return {
    success: false,
    errors,
  };
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
    
    // Converti in query string
    const params = new URLSearchParams();
    Object.entries(bodyData).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        params.append(key, String(value));
      }
    });
    
    // Prova tutti gli endpoint con fallback
    const result = await tryLicenseEndpoints(params);
    
    const totalDuration = Date.now() - startTime;
    
    if (result.success) {
      console.log('=== RESPONSE ===');
      console.log('Status:', result.status);
      console.log('Endpoint:', result.endpoint);
      console.log('Duration:', totalDuration, 'ms');
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Response-Time', `${totalDuration}ms`);
      res.setHeader('X-Endpoint-Used', result.endpoint.toString());
      
      return res.status(result.status).json(result.data);
    } else {
      // Tutti gli endpoint hanno fallito
      console.error('=== ERROR ===');
      console.error('All endpoints failed');
      console.error('Duration:', totalDuration, 'ms');
      
      res.setHeader('X-Response-Time', `${totalDuration}ms`);
      
      return res.status(504).json({
        status: 'error',
        message: 'Request timeout',
        detail: 'All license servers unavailable',
      });
    }
    
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
