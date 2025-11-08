# Vercel Relay per Sistema Licenze MT5

Relay serverless Node.js che inoltra richieste POST da Expert Advisor MT5 verso Google Apps Script, gestendo automaticamente redirect e timeout.

## 🚀 Features

- ✅ Gestione automatica redirect Google Apps Script
- ✅ Timeout configurabile (25s default)
- ✅ CORS permissivi per MT5
- ✅ Logging dettagliato per debug
- ✅ Error handling robusto
- ✅ Header personalizzati per monitoring

## 📦 Deploy su Vercel

### 1. Prepara il progetto
```bash
# Clona o crea la cartella
mkdir vercel-gas-relay
cd vercel-gas-relay

# Crea i file (vedi struttura sopra)
```

### 2. Deploy tramite Vercel CLI
```bash
# Installa Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy
vercel --prod
```

### 3. Oppure deploy tramite GitHub

1. Pusha il codice su GitHub
2. Vai su [vercel.com](https://vercel.com)
3. Click "New Project"
4. Importa la repo GitHub
5. Vercel rileva automaticamente la configurazione

### 4. Configura Environment Variable

Nel dashboard Vercel:

**Settings** → **Environment Variables** → **Add New**
```
Name:  LICENSE_WEBHOOK_URL
Value: https://script.google.com/macros/s/AKfycby1_pxoizxTaRwv5zjyvPJnBM5pu1cmm7ht3vAWKRfxkjUN6k7qwIICO9LvBy6Ty0Kf/exec
```

Salva e rideploy.

## 🔧 Uso nel tuo EA

Nel file `LicenseSystem.mqh`, aggiorna l'URL:
```cpp
// Vecchio (diretto a Google Apps Script)
string LicenseWebhookURL = "https://script.google.com/macros/s/AKfyc.../exec";

// Nuovo (tramite Vercel Relay)
string LicenseWebhookURL = "https://il-tuo-progetto.vercel.app/api/license-check";
```

## 📊 Monitoring

Controlla i log in tempo reale:
```bash
vercel logs https://il-tuo-progetto.vercel.app
```

Oppure nel dashboard Vercel: **Deployments** → **Functions** → **View Logs**

## 🔒 Sicurezza (Opzionale)

Per restringere CORS solo al tuo dominio:
```javascript
// In api/license-check.js
const ALLOWED_ORIGINS = ['https://tuodominio.com'];
```

## 🐛 Troubleshooting

### Timeout errors
- Aumenta `DEFAULT_TIMEOUT_MS` (max 30000 per Vercel Hobby)
- Verifica che Google Apps Script risponda velocemente

### Too many redirects
- Aumenta `MAX_REDIRECTS` se necessario
- Controlla i log Vercel per vedere la catena di redirect

### 502 Bad Gateway
- Verifica che `LICENSE_WEBHOOK_URL` sia corretto
- Controlla che Google Apps Script sia deployed come Web App

## 📈 Performance

- **Cold start**: ~500-1000ms
- **Warm request**: ~200-500ms  
- **Total con GAS**: ~1-3 secondi (dipende da GAS)

## 📝 Note

- Vercel Hobby: max 30s timeout
- Vercel Pro: max 60s timeout
- Google Apps Script: max 30s esecuzione

---

Creato per **Prop Leader** - Sistema Licenze MT5
