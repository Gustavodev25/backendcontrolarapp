require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pluggyRoutes = require('./api/pluggy');

const app = express();
const PORT = process.env.PORT || 8080;
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

app.use('/api/pluggy', pluggyRoutes);
app.use('/api/asaas', require('./api/asaas'));

app.use((err, req, res, next) => {
    console.error('[Error]', err);
    res.status(500).json({
        success: false,
        error: err.message || 'Internal server error'
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Servidor] Rodando na porta ${PORT} (Railway Ready) 🚂`);
    console.log(`
    Endpoints rodando:
    • POST /api/pluggy/sync
    • GET  /api/pluggy/items/:id
    • POST /api/pluggy/create-item
    • GET  /api/pluggy/connectors 
    • POST /api/asaas/webhook
    • GET  /health  
  `);
});

module.exports = app;