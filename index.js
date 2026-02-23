require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pluggyRoutes = require('./api/pluggy');

const app = express();
const PORT = process.env.PORT || 3001;
console.log('[Server] PORT from env:', process.env.PORT);
console.log('[Server] Using PORT:', PORT);
const { limiter, securityHeaders } = require('./middleware/security');

app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(limiter);

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning']
}));
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    console.log(`[${timestamp}] Headers:`, JSON.stringify({
        authorization: req.headers.authorization ? 'Bearer ***' : 'none',
        'content-type': req.headers['content-type'],
        origin: req.headers.origin
    }));
    if (req.method === 'POST' || req.method === 'PUT') {
        const bodyCopy = { ...req.body };
        if (bodyCopy.password) bodyCopy.password = '***';
        if (bodyCopy.credentials) bodyCopy.credentials = '***';
        console.log(`[${timestamp}] Body:`, JSON.stringify(bodyCopy));
    }
    next();
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/diagnostics', (req, res) => {
    const diagnostics = {
        status: 'running',
        timestamp: new Date().toISOString(),
        environment: {
            nodeVersion: process.version,
            platform: process.platform,
            port: PORT
        },
        config: {
            pluggyClientId: !!process.env.PLUGGY_CLIENT_ID,
            pluggyClientSecret: !!process.env.PLUGGY_CLIENT_SECRET,
            pluggySandbox: process.env.PLUGGY_SANDBOX || 'false',
            firebaseConfigured: !!(
                process.env.FIREBASE_SERVICE_ACCOUNT ||
                (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY)
            )
        },
        endpoints: [
            'GET /health',
            'GET /api/diagnostics',
            'GET /api/pluggy/connectors',
            'POST /api/pluggy/create-item',
            'GET /api/pluggy/items/:id',
            'POST /api/pluggy/sync',
            'DELETE /api/pluggy/items/:id',
            'POST /api/pluggy/update-item/:id',
            'POST /api/asaas/webhook'
        ]
    };

    res.json(diagnostics);
});

app.use('/api/pluggy', pluggyRoutes);
app.use('/api/asaas', require('./api/asaas'));

app.use((err, req, res, next) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ❌ ERROR:`, err.message);
    console.error(`[${timestamp}] Stack:`, err.stack);
    console.error(`[${timestamp}] Path:`, req.path);
    console.error(`[${timestamp}] Method:`, req.method);

    res.status(500).json({
        success: false,
        error: err.message || 'Internal server error',
        path: req.path
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Servidor] Rodando na porta ${PORT} (Railway Ready) 🚂`);
    console.log(`
    ========================================
    🚀 ControlarApp Backend - ONLINE
    ========================================
    Porta: ${PORT}
    Ambiente: ${process.env.NODE_ENV || 'production'}
    Pluggy Sandbox: ${process.env.PLUGGY_SANDBOX || 'false'}
    
    Endpoints disponíveis:
    • GET  /health
    • GET  /api/pluggy/connectors
    • POST /api/pluggy/create-item
    • GET  /api/pluggy/items/:id
    • POST /api/pluggy/sync
    • DELETE /api/pluggy/items/:id
    • POST /api/pluggy/update-item/:id
    • POST /api/asaas/webhook
    
    ⚠️  Verificações importantes:
    ${process.env.PLUGGY_CLIENT_ID ? '✅' : '❌'} PLUGGY_CLIENT_ID
    ${process.env.PLUGGY_CLIENT_SECRET ? '✅' : '❌'} PLUGGY_CLIENT_SECRET
    ${process.env.FIREBASE_SERVICE_ACCOUNT || (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) ? '✅' : '❌'} Firebase Config
    ========================================
  `);
});

module.exports = app;