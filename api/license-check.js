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
  const allResults = [];
  let firstValidResponse = null;
  
  for (let i = 0; i < LICENSE_ENDPOINTS.length; i++) {
    const endpoint = LICENSE_ENDPOINTS[i];
    const endpointNum = i + 1;
    
    try {
      console.log(`[Endpoint ${endpointNum}/${LICENSE_ENDPOINTS.length}] Trying: ${endpoint.substring(0, 60)}...`);
      
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
      
      // Prova a parsare la risposta
      let responseData;
      try {
        responseData = JSON.parse(responseText);
      } catch (e) {
        console.error(`[Endpoint ${endpointNum}] JSON parse error:`, e);
        allResults.push({
          endpoint: endpointNum,
          success: false,
          error: 'Invalid JSON response',
          duration,
        });
        continue;
      }
      
      // Salva il risultato
      allResults.push({
        endpoint: endpointNum,
        success: response.ok,
        status: response.status,
        data: responseData,
        duration,
      });
      
      // Se questo endpoint dice che la licenza è VALIDA, salvalo
      if (response.ok && responseData.status === 'success' && responseData.valid === true) {
        console.log(`[Endpoint ${endpointNum}] ✓ LICENSE VALID - Using this response`);
        firstValidResponse = {
          success: true,
          data: responseData,
          status: response.status,
          endpoint: endpointNum,
          duration,
        };
        // Trovata licenza valida, interrompi il loop
        break;
      } else {
        console.log(`[Endpoint ${endpointNum}] ✗ License not valid or error`);
      }
      
    } catch (error) {
      console.error(`[Endpoint ${endpointNum}] ✗ NETWORK ERROR:`, error.message);
      allResults.push({
        endpoint: endpointNum,
        success: false,
        error: error.message,
      });
    }
  }
  
  // Se almeno un endpoint ha detto che la licenza è valida, usa quella risposta
  if (firstValidResponse) {
    console.log('=== VALID LICENSE FOUND ===');
    return firstValidResponse;
  }
  
  // Se arriviamo qui, NESSUN endpoint ha detto che la licenza è valida
  console.log('=== ALL ENDPOINTS: LICENSE INVALID OR UNREACHABLE ===');
  
  // Controlla se almeno un endpoint ha risposto (anche negativamente)
  const hasAnyResponse = allResults.some(r => r.success === true || (r.data && r.data.status));
  
  if (hasAnyResponse) {
    // Almeno un server ha risposto, anche se ha detto "licenza non valida"
    // Usa l'ultima risposta valida ricevuta
    const lastValidResponse = allResults.find(r => r.data && r.data.status);
    
    if (lastValidResponse) {
      console.log('Using response from endpoint:', lastValidResponse.endpoint);
      return {
        success: true,
        data: lastValidResponse.data,
        status: lastValidResponse.status || 200,
        endpoint: lastValidResponse.endpoint,
        duration: lastValidResponse.duration,
      };
    }
  }
  
  // Nessun endpoint ha risposto correttamente (tutti offline/errore)
  return {
    success: false,
    allResults,
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
    
    console.log('=== LICENSE CHECK REQUEST ===');
    console.log('License Key:', bodyData.licenseKey);
    console.log('Product:', bodyData.product);
    
    // Converti in query string
    const params = new URLSearchParams();
    Object.entries(bodyData).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        params.append(key, String(value));
      }
    });
    
    // Prova tutti gli endpoint
    const result = await tryLicenseEndpoints(params);
    
    const totalDuration = Date.now() - startTime;
    
    if (result.success) {
      console.log('=== RESPONSE OBTAINED ===');
      console.log(`Used endpoint: ${result.endpoint}/${LICENSE_ENDPOINTS.length}`);
      console.log(`License valid: ${result.data.valid}`);
      console.log(`Total duration: ${totalDuration}ms`);
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Response-Time', `${totalDuration}ms`);
      res.setHeader('X-Endpoint-Used', result.endpoint.toString());
      
      return res.status(result.status).json(result.data);
    } else {
      // TUTTI gli endpoint sono offline o irraggiungibili
      console.error('=== ALL ENDPOINTS UNREACHABLE ===');
      console.error(`Total duration: ${totalDuration}ms`);
      
      res.setHeader('X-Response-Time', `${totalDuration}ms`);
      
      return res.status(503).json({
        status: 'error',
        message: 'All license servers unreachable',
        attempts: LICENSE_ENDPOINTS.length,
        results: result.allResults,
      });
    }
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    console.error('=== UNEXPECTED ERROR ===');
    console.error('Message:', error.message);
    console.error('Duration:', duration, 'ms');
    
    res.setHeader('X-Response-Time', `${duration}ms`);
    
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
      detail: error.message,
    });
  }
}
