require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pluggyRoutes = require('./api/pluggy');
const { isFirebaseConfigured, getFirebaseInitStatus } = require('./lib/firebaseAdmin');

const app = express();
const PORT = process.env.PORT || 3001;
console.log('[Server] PORT from env:', process.env.PORT);
console.log('[Server] Using PORT:', PORT);

// O seu middleware original já inicializa o Firebase com sucesso lendo o FIREBASE_SERVICE_ACCOUNT
const { limiter, securityHeaders } = require('./middleware/security');

app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(limiter);

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning']
}));

// Importante: garante a leitura correta do body em JSON (inclusive para os webhooks)
// Stripe webhook precisa de raw body — NÃO parsear JSON no /api/stripe/webhook
app.use((req, res, next) => {
    if (req.originalUrl === '/api/stripe/webhook') {
        return next();
    }
    express.json({ limit: '10kb' })(req, res, next);
});

app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing',
        firebase: require('./lib/firebaseAdmin').isFirebaseConfigured() ? 'connected' : 'missing',
    });
});

app.get('/api/diagnostics', (req, res) => {
    const firebaseStatus = getFirebaseInitStatus();
    const pluggyAuthConfigured = !!process.env.PLUGGY_CLIENT_ID && !!process.env.PLUGGY_CLIENT_SECRET;

    res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        environment: { port: PORT },
        config: {
            pluggyClientId: !!process.env.PLUGGY_CLIENT_ID,
            pluggyClientSecret: !!process.env.PLUGGY_CLIENT_SECRET,
            pluggySandbox: process.env.PLUGGY_SANDBOX || 'false',
            pluggyAuthConfigured,
            firebaseConfigured: isFirebaseConfigured(),
            firebaseInitError: firebaseStatus.error,
            oauthCallbackEnabled: true,
        }
    });
});

app.use('/api/pluggy', pluggyRoutes);

try {
    app.use('/api/asaas', require('./api/asaas'));
} catch (e) {
    // Ignora silenciosamente caso a rota asaas não exista
}

try {
    app.use('/api/stripe', require('./api/stripe'));
    console.log('[Server] Rota Stripe carregada com sucesso ✅');
} catch (e) {
    console.error('[Server] ❌ Rota Stripe NÃO carregada:', e.message);
    console.error('[Server] Verifique se STRIPE_SECRET_KEY está configurado nas variáveis de ambiente');
}

// Legacy: manter rota RevenueCat se existir (retrocompatibilidade)
try {
    app.use('/api/revenuecat', require('./api/revenuecat'));
} catch (e) {
    // Silenciosamente ignora se não existe
}

app.use((err, req, res, next) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ❌ ERROR:`, err.message);
    res.status(500).json({ success: false, error: err.message || 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Servidor] Rodando na porta ${PORT} (Railway Ready) 🚂`);
});
