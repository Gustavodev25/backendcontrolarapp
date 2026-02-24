require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin'); // ADICIONADO: Necessário para validar tokens

// Inicializa o Firebase Admin se ainda não estiver inicializado pelas envs do Railway
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.applicationDefault()
        });
        console.log('[Firebase] Admin inicializado com sucesso.');
    } catch (e) {
        console.warn('[Firebase] Aviso de inicialização:', e.message);
    }
}

const pluggyRoutes = require('./api/pluggy');
const app = express();
const PORT = process.env.PORT || 3001;

console.log('[Server] PORT from env:', process.env.PORT);
console.log('[Server] Using PORT:', PORT);

// Se os middlewares não existirem no seu projeto, remova as próximas duas linhas
try {
    const { limiter, securityHeaders } = require('./middleware/security');
    app.use(securityHeaders);
    app.use(limiter);
} catch (e) {
    console.warn('[Aviso] Middlewares de segurança não encontrados, ignorando.');
}

app.set('trust proxy', 1);

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning']
}));

// Importante: Isso transforma o body em JSON para TODAS as rotas
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/diagnostics', (req, res) => {
    res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        environment: { port: PORT },
        config: {
            pluggyClientId: !!process.env.PLUGGY_CLIENT_ID,
            pluggyClientSecret: !!process.env.PLUGGY_CLIENT_SECRET,
            pluggySandbox: process.env.PLUGGY_SANDBOX || 'false',
        }
    });
});

app.use('/api/pluggy', pluggyRoutes);

// Tenta carregar a rota do asaas, se existir
try {
    app.use('/api/asaas', require('./api/asaas'));
} catch (e) { }

app.use((err, req, res, next) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ❌ ERROR:`, err.message);
    res.status(500).json({ success: false, error: err.message || 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Servidor] Rodando na porta ${PORT} (Railway Ready) 🚂`);
});