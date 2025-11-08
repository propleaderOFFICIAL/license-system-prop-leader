# Vercel Relay per Google Apps Script (POST)

Un endpoint serverless che riceve POST dal tuo EA MT5 e li inoltra alla Web App di Google Apps Script, restituendo la risposta così com'è. Gestisce redirect verso `script.googleusercontent.com` e imposta CORS permissivi.

## Deploy

1. **Fork/Importa** questa repo su GitHub.
2. Su **Vercel**, crea un nuovo progetto collegato alla repo.
3. Aggiungi una **Environment Variable**:
   - `LICENSE_WEBHOOK_URL` → l'URL della tua Web App di Apps Script, ad es.  
     `https://script.google.com/macros/s/AKfycb.../exec`
4. Deploy.

## Uso da MT5

Nel tuo `LicenseSystem.mqh`, imposta:
```cpp
string LicenseWebhookURL = "https://<tuo-progetto>.vercel.app/api/license-check";
