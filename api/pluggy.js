const express = require('express');
const fetch = require('node-fetch');
const { z } = require('zod');
const admin = require('firebase-admin'); // Importando para verificar a autenticação

const router = express.Router();

// ====================== VALIDAÇÃO DE AMBIENTE ======================
const envSchema = z.object({
    PLUGGY_CLIENT_ID: z.string().min(1, 'PLUGGY_CLIENT_ID obrigatório'),
    PLUGGY_CLIENT_SECRET: z.string().min(1, 'PLUGGY_CLIENT_SECRET obrigatório'),
    PLUGGY_SANDBOX: z.enum(['true', 'false']).optional().default('false'),
});

const env = envSchema.parse(process.env);

const PLUGGY_API_URL = 'https://api.pluggy.ai';
const PLUGGY_WEBHOOK_IPS = ['177.71.238.212'];
const TRANSACTIONS_PAGE_SIZE = 500;
const MAX_TRANSACTION_PAGES = 10;
const FETCH_TIMEOUT_MS = 25000;

// ====================== CLIENT PLUGGY ======================
class PluggyClient {
    static instance;
    token = null;
    expiry = null;
    refreshing = null;

    static getInstance() {
        if (!PluggyClient.instance) PluggyClient.instance = new PluggyClient();
        return PluggyClient.instance;
    }

    async getToken() {
        if (this.token && this.expiry && Date.now() < this.expiry - 5 * 60 * 1000) return this.token;
        if (this.refreshing) return this.refreshing;

        this.refreshing = (async () => {
            const res = await this.safeFetch(`${PLUGGY_API_URL}/auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    clientId: env.PLUGGY_CLIENT_ID,
                    clientSecret: env.PLUGGY_CLIENT_SECRET,
                }),
            });

            if (!res.ok) throw new Error('Falha na autenticação Pluggy');
            const data = await res.json();

            this.token = data.apiKey;
            this.expiry = Date.now() + 2 * 60 * 60 * 1000;
            this.refreshing = null;
            return this.token;
        })();

        return this.refreshing;
    }

    async safeFetch(url, options = {}, retries = 3) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

            try {
                const token = url.includes('/auth') ? null : await this.getToken();
                const response = await fetch(url, {
                    ...options,
                    signal: controller.signal,
                    headers: {
                        ...options.headers,
                        ...(token ? { 'X-API-KEY': token } : {}),
                    },
                });

                clearTimeout(timeout);

                if (response.status === 429 || response.status >= 500) {
                    if (attempt === retries) return response;
                    await this.delay(attempt * 1000 + Math.random() * 800);
                    continue;
                }
                return response;
            } catch (err) {
                clearTimeout(timeout);
                if (attempt === retries) throw err;
                await this.delay(attempt * 1000);
            }
        }
    }

    delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}

const pluggy = PluggyClient.getInstance();

// ====================== SCHEMAS ======================
const createItemSchema = z.object({
    connectorId: z.union([z.string(), z.number()]),
    credentials: z.record(z.string(), z.any()).optional(),
    oauthRedirectUri: z.string().url().optional(),
    products: z.array(z.string().toUpperCase()).optional(),
    webhookUrl: z.string().url().optional(),
});

const syncSchema = z.object({
    itemId: z.string().uuid(),
    from: z.string().datetime({ offset: true }).optional(),
    fullHistory: z.boolean().optional().default(false),
    autoRefresh: z.boolean().optional().default(false),
});

const paramIdSchema = z.object({ id: z.string().uuid() });

// ====================== MIDDLEWARE DE AUTENTICAÇÃO CORRIGIDO ======================
const enforceUser = async (req, res, next) => {
    // ROTAS PÚBLICAS (não precisam de login)
    if (['/webhook', '/ping', '/connectors'].some(p => req.path.includes(p))) {
        return next();
    }

    // EXTRAIR TOKEN DO HEADER
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn(`[Auth] Falha: Token não fornecido na rota ${req.path}`);
        return res.status(401).json({ success: false, error: 'Token de autenticação ausente' });
    }

    const token = authHeader.split('Bearer ')[1];

    try {
        // VALIDAR TOKEN COM FIREBASE
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        req.currentUser = decodedToken.uid; // Define o UID globalmente para a rota
        next();
    } catch (error) {
        console.error(`[Auth] Falha na validação do token:`, error.message);
        return res.status(401).json({ success: false, error: 'Token inválido ou expirado' });
    }
};

router.use(enforceUser);

// ====================== ROTAS ======================
router.get('/ping', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// LISTAR BANCOS - PÚBLICO
router.get('/connectors', async (req, res) => {
    try {
        const resp = await pluggy.safeFetch(`${PLUGGY_API_URL}/connectors?sandbox=${env.PLUGGY_SANDBOX}&types=PERSONAL_BANK,BUSINESS_BANK`);
        if (!resp.ok) {
            const errData = await resp.text();
            throw new Error(`HTTP ${resp.status} - ${errData}`);
        }
        res.json(await resp.json());
    } catch (err) {
        console.error('[Connectors Error]', err.message);
        res.status(502).json({ success: false, error: 'Serviço temporariamente indisponível' });
    }
});

// Criar Item (Requer Login)
router.post('/create-item', async (req, res) => {
    try {
        const body = createItemSchema.parse(req.body);
        const payload = {
            connectorId: body.connectorId,
            parameters: body.credentials || {},
            clientUserId: req.currentUser, // Extraído do Firebase no Middleware!
            ...(body.products && { products: body.products }),
            ...(body.oauthRedirectUri && { clientUrl: body.oauthRedirectUri }),
            ...(body.webhookUrl && { webhookUrl: body.webhookUrl }),
        };

        const resp = await pluggy.safeFetch(`${PLUGGY_API_URL}/items`, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await resp.json();

        if (!resp.ok) {
            const alreadyUpdating = data.codeDescription?.includes('ALREADY_UPDATING') || data.message?.includes('ALREADY_UPDATING');
            return res.status(resp.status).json({
                success: false,
                error: alreadyUpdating ? 'Conexão já em andamento. Aguarde o webhook.' : (data.message || 'Falha ao conectar'),
            });
        }

        const oauthUrl = data.clientUrl || data.oauthUrl || data.parameter?.oauthUrl;
        res.json({ success: true, item: data, oauthUrl });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Force Refresh
router.post('/force-refresh/:id', async (req, res) => {
    try {
        const { id } = paramIdSchema.parse({ id: req.params.id });
        await pluggy.safeFetch(`${PLUGGY_API_URL}/items/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        res.status(202).json({ success: true, message: 'Sincronização iniciada!', itemId: id });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao forçar atualização.' });
    }
});

// Sync
router.post('/sync', async (req, res) => {
    try {
        const { itemId, from, fullHistory = false, autoRefresh = false } = syncSchema.parse(req.body);

        if (autoRefresh) {
            pluggy.safeFetch(`${PLUGGY_API_URL}/items/${itemId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }).catch(e => console.warn('[AutoRefresh]', e.message));
        }

        const itemRes = await pluggy.safeFetch(`${PLUGGY_API_URL}/items/${itemId}`);
        const itemData = itemRes.ok ? await itemRes.json() : { status: 'UNKNOWN', updatedAt: null };

        const accountsRes = await pluggy.safeFetch(`${PLUGGY_API_URL}/accounts?itemId=${itemId}`);
        const { results: accountsList = [] } = await accountsRes.json();

        const fromDate = from || (fullHistory ? '2020-01-01' : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);

        const enrichedAccounts = await Promise.all(accountsList.map(async (account) => {
            let allTx = [];
            let page = 1;
            let hasMore = true;

            while (hasMore && page <= MAX_TRANSACTION_PAGES) {
                const params = new URLSearchParams({
                    accountId: account.id,
                    pageSize: TRANSACTIONS_PAGE_SIZE.toString(),
                    page: page.toString(),
                    from: fromDate,
                });

                const txRes = await pluggy.safeFetch(`${PLUGGY_API_URL}/transactions?${params}`);
                const txData = txRes.ok ? await txRes.json() : { results: [] };
                allTx = [...allTx, ...txData.results];

                if (txData.totalPages <= page) hasMore = false;
                page++;
            }

            let bills = [];
            if (account.type === 'CREDIT') {
                const billsRes = await pluggy.safeFetch(`${PLUGGY_API_URL}/accounts/${account.id}/bills`);
                if (billsRes.ok) {
                    const b = await billsRes.json();
                    bills = b.results || [];
                }
            }

            return { ...account, transactions: allTx, bills };
        }));

        res.json({
            success: true,
            itemStatus: itemData.status,
            lastUpdatedAt: itemData.updatedAt,
            isRefreshing: itemData.status === 'UPDATING' || autoRefresh,
            accounts: enrichedAccounts,
            totalTransactions: enrichedAccounts.reduce((sum, a) => sum + a.transactions.length, 0),
            syncedAt: new Date().toISOString(),
        });
    } catch (err) {
        console.error('[Sync Error]', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar dados sincronizados.' });
    }
});

// Listar items
router.get('/items', async (req, res) => {
    try {
        const resp = await pluggy.safeFetch(`${PLUGGY_API_URL}/items?clientUserId=${req.currentUser}`);
        res.json(await resp.json());
    } catch (err) {
        res.status(502).json({ success: false, error: 'Erro ao listar items' });
    }
});

// Detalhes de um item
router.get('/items/:id', async (req, res) => {
    try {
        const { id } = paramIdSchema.parse({ id: req.params.id });
        const resp = await pluggy.safeFetch(`${PLUGGY_API_URL}/items/${id}`);
        res.json(await resp.json());
    } catch (err) {
        res.status(404).json({ success: false, error: 'Item não encontrado' });
    }
});

// Disconnect
router.delete('/items/:id', async (req, res) => {
    try {
        const { id } = paramIdSchema.parse({ id: req.params.id });
        await pluggy.safeFetch(`${PLUGGY_API_URL}/items/${id}`, { method: 'DELETE' });
        res.json({ success: true, message: 'Item desconectado com sucesso' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Falha ao desconectar' });
    }
});

// ====================== WEBHOOK CORRIGIDO ======================
// Removido express.raw porque o index.js já faz o express.json()
router.post('/webhook', async (req, res) => {
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    if (!PLUGGY_WEBHOOK_IPS.includes(clientIp) && !clientIp.includes('127.0.0.1')) {
        console.warn(`[SECURITY] Webhook IP inválido: ${clientIp}`);
        return res.status(403).send('Forbidden');
    }

    // req.body JÁ É UM OBJETO devido ao express.json() no index.js
    const body = req.body;

    if (!body || !body.event) {
        console.warn('[WEBHOOK] Corpo vazio ou sem evento');
        return res.status(400).send('Bad Request');
    }

    console.info(`[WEBHOOK] Evento: ${body.event} | Item: ${body.itemId} | User: ${body.clientUserId}`);
    res.status(200).json({ received: true });
});

module.exports = router;