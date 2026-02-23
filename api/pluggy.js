const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();
const verifyAuth = require('../middleware/auth');
const validate = require('../middleware/validate');
const { z } = require('zod');

// ==========================================
// HEALTH CHECK (RAILWAY SPECIFIC)
// ==========================================
// Rota pública para o Railway monitorar a saúde da API
router.get('/ping', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'pluggy-integration'
    });
});

// ==========================================
// SCHEMAS DE VALIDAÇÃO (ZOD)
// ==========================================
const createItemSchema = z.object({
    connectorId: z.union([z.string(), z.number()]),
    credentials: z.record(z.string(), z.any()).optional(),
    oauthRedirectUri: z.string().url('A URI de redirecionamento deve ser uma URL válida').optional()
});

const syncSchema = z.object({
    itemId: z.string().uuid('ID do item inválido'),
    from: z.string().trim().optional()
});

const paramIdSchema = z.object({
    id: z.string().uuid('ID inválido')
});

// ==========================================
// MIDDLEWARES E SEGURANÇA FINTECH
// ==========================================
const injectAndEnforceUser = (req, res, next) => {
    // Libera as rotas de callback e ping da checagem de usuário
    if (req.path.includes('/oauth-callback') || req.path.includes('/ping')) {
        return next();
    }

    if (!req.user || !req.user.uid) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado no contexto' });
    }

    const requestUserId = req.body?.userId || req.query?.userId;
    if (requestUserId && requestUserId !== req.user.uid) {
        console.error(`[SECURITY] Tentativa de IDOR bloqueada. Token: ${req.user.uid} | IP: ${req.ip}`);
        return res.status(403).json({ success: false, error: 'Acesso negado: Incompatibilidade de credenciais' });
    }

    req.currentUser = req.user.uid;
    next();
};

// Aplica autenticação do Firebase, EXCETO no callback (GET/POST) e no ping
router.use((req, res, next) => {
    if (req.path.includes('/oauth-callback') || req.path.includes('/ping')) {
        return next();
    }
    verifyAuth(req, res, next);
});

router.use(injectAndEnforceUser);

// ==========================================
// CONFIGURAÇÕES PLUGGY
// ==========================================
const PLUGGY_API_URL = 'https://api.pluggy.ai';
const CLIENT_ID = process.env.PLUGGY_CLIENT_ID;
const CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET;
const PLUGGY_SANDBOX = String(process.env.PLUGGY_SANDBOX ?? 'false').toLowerCase() === 'true';

// Estado em memória (Ideal para 1 réplica no Railway)
let accessToken = null;
let tokenExpiry = null;
let tokenPromise = null;

const TRANSACTIONS_PAGE_SIZE = 500;
const MAX_TRANSACTION_PAGES = 50;
const FETCH_TIMEOUT_MS = 45000;
const MAX_CONCURRENT_REQUESTS = 3;

// ==========================================
// UTILS DE REDE E CONCORRÊNCIA
// ==========================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const safeFetch = async (url, options = {}, retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
            const response = await fetch(url, { ...options, signal: controller.signal });

            if (!response.ok && (response.status === 429 || response.status >= 500)) {
                if (attempt === retries) return response;
                const backoff = (attempt * 1500) + Math.floor(Math.random() * 500);
                console.warn(`[Pluggy API] HTTP ${response.status} em ${url}. Tentativa ${attempt}/${retries}...`);
                await delay(backoff);
                continue;
            }

            return response;
        } catch (error) {
            const isTimeout = error.name === 'AbortError' || error.message.includes('Tempo de requisição');
            if (attempt === retries) {
                if (isTimeout) throw new Error(`Timeout de comunicação com o banco (${url})`);
                throw error;
            }
            const backoff = (attempt * 1500) + Math.floor(Math.random() * 500);
            await delay(backoff);
        } finally {
            clearTimeout(timeout);
        }
    }
};

async function getAccessToken() {
    if (accessToken && tokenExpiry && Date.now() < tokenExpiry - 300000) return accessToken;
    if (tokenPromise) return tokenPromise;

    tokenPromise = (async () => {
        try {
            const response = await safeFetch(`${PLUGGY_API_URL}/auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
            });

            if (!response.ok) throw new Error(`Auth falhou (${response.status})`);

            const data = await response.json();
            accessToken = data.apiKey;
            tokenExpiry = Date.now() + (2 * 60 * 60 * 1000);
            console.info('[Pluggy] Novo Access Token gerado com sucesso.');
            return accessToken;
        } finally {
            tokenPromise = null;
        }
    })();

    return tokenPromise;
}

const runWithConcurrencyLimit = async (tasks, limit) => {
    const results = [];
    const executing = [];
    for (const task of tasks) {
        const p = Promise.resolve().then(() => task());
        results.push(p);
        if (limit <= tasks.length) {
            const e = p.then(() => executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            if (executing.length >= limit) await Promise.race(executing);
        }
    }
    return Promise.all(results);
};

const fetchTransactionsForAccount = async (token, accountId, fromDate) => {
    const transactions = [];
    const params = new URLSearchParams({ accountId: String(accountId), pageSize: String(TRANSACTIONS_PAGE_SIZE), page: '1' });
    if (fromDate) params.set('from', fromDate);

    const firstPageRes = await safeFetch(`${PLUGGY_API_URL}/transactions?${params.toString()}`, { headers: { 'X-API-KEY': token } });
    if (!firstPageRes.ok) return [];

    const firstPageData = await firstPageRes.json();
    const page1Results = Array.isArray(firstPageData.results) ? firstPageData.results : [];
    transactions.push(...page1Results);

    const totalFromApi = Number(firstPageData.total);

    if (totalFromApi > TRANSACTIONS_PAGE_SIZE && page1Results.length > 0) {
        const totalPages = Math.ceil(totalFromApi / TRANSACTIONS_PAGE_SIZE);
        const maxPages = Math.min(totalPages, MAX_TRANSACTION_PAGES);

        const tasks = [];
        for (let p = 2; p <= maxPages; p++) {
            tasks.push(async () => {
                const pParams = new URLSearchParams(params);
                pParams.set('page', String(p));
                try {
                    const res = await safeFetch(`${PLUGGY_API_URL}/transactions?${pParams.toString()}`, { headers: { 'X-API-KEY': token } });
                    if (!res.ok) return [];
                    const data = await res.json();
                    return Array.isArray(data.results) ? data.results : [];
                } catch (err) {
                    return [];
                }
            });
        }
        const batchResults = await runWithConcurrencyLimit(tasks, MAX_CONCURRENT_REQUESTS);
        batchResults.forEach(res => transactions.push(...res));
    }
    return transactions;
};

// ==========================================
// ROTAS DA API
// ==========================================

router.get('/connectors', async (req, res) => {
    try {
        const token = await getAccessToken();
        const sandbox = PLUGGY_SANDBOX ? 'true' : 'false';
        const response = await safeFetch(`${PLUGGY_API_URL}/connectors?sandbox=${sandbox}&types=PERSONAL_BANK,BUSINESS_BANK`, {
            headers: { 'X-API-KEY': token }
        });
        if (!response.ok) throw new Error(`Pluggy API error: ${response.status}`);
        return res.json(await response.json());
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Falha ao buscar conectores bancários disponíveis.' });
    }
});

router.post('/create-item', validate(createItemSchema), async (req, res) => {
    try {
        const { connectorId, credentials, oauthRedirectUri } = req.body;
        const token = await getAccessToken();

        const payload = {
            connectorId,
            parameters: credentials || {},
            clientUserId: req.currentUser
        };

        if (oauthRedirectUri) {
            payload.clientUrl = oauthRedirectUri;
            payload.webhookUrl = oauthRedirectUri;
        }

        const response = await safeFetch(`${PLUGGY_API_URL}/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': token },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) {
            let errorMessage = 'Falha ao conectar na instituição financeira.';
            if (data.codeDescription === 'ITEM_IS_ALREADY_UPDATING' || (data.details && data.details.description === 'ITEM_IS_ALREADY_UPDATING')) {
                errorMessage = 'Conexão já em andamento. Aguarde.';
            } else if (data.message || data.error) {
                errorMessage = data.message || data.error;
            }

            return res.status(response.status).json({
                success: false, error: errorMessage, details: { code: data.code, description: data.codeDescription || (data.details && data.details.description) }
            });
        }

        const oauthUrl = data.clientUrl || data.parameter?.oauthUrl || data.oauthUrl || data.userAction?.url || data.userAction?.attributes?.url;
        return res.json({ success: true, item: data, oauthUrl });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Erro interno de comunicação bancária.' });
    }
});

router.get('/items/:id', validate({ params: paramIdSchema }), async (req, res) => {
    try {
        const token = await getAccessToken();
        const response = await safeFetch(`${PLUGGY_API_URL}/items/${req.params.id}`, { headers: { 'X-API-KEY': token } });
        if (!response.ok) return res.status(response.status === 404 ? 404 : 500).json({ success: false, error: 'Conexão não encontrada.' });
        return res.json({ success: true, item: await response.json() });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Erro ao buscar o status da conexão.' });
    }
});

router.post('/sync', validate(syncSchema), async (req, res) => {
    try {
        const { itemId, from } = req.body;
        const fromDate = typeof from === 'string' && from.trim() ? from.trim() : null;
        const token = await getAccessToken();

        const itemResponse = await safeFetch(`${PLUGGY_API_URL}/items/${itemId}`, { headers: { 'X-API-KEY': token } });
        if (!itemResponse.ok) throw new Error(`Item não encontrado`);
        const item = await itemResponse.json();

        const accountsResponse = await safeFetch(`${PLUGGY_API_URL}/accounts?itemId=${itemId}`, { headers: { 'X-API-KEY': token } });
        if (!accountsResponse.ok) throw new Error('Falha ao buscar contas');
        const accountsData = await accountsResponse.json();

        const tasks = (accountsData.results || []).map(account => async () => {
            account.itemId = itemId;
            if (!account.connector && item.connector) account.connector = item.connector;

            const [transactions, billsData] = await Promise.all([
                fetchTransactionsForAccount(token, account.id, fromDate).catch(() => []),
                account.type === 'CREDIT'
                    ? safeFetch(`${PLUGGY_API_URL}/accounts/${account.id}/bills`, { headers: { 'X-API-KEY': token } })
                        .then(res => res.ok ? res.json() : { results: [] }).catch(() => ({ results: [] }))
                    : Promise.resolve({ results: [] })
            ]);

            account.transactions = transactions || [];
            account.bills = billsData?.results || [];
            return account;
        });

        const accountsWithTransactions = await runWithConcurrencyLimit(tasks, MAX_CONCURRENT_REQUESTS);
        const connector = accountsWithTransactions.find(acc => acc?.connector)?.connector || item.connector || null;

        return res.json({
            success: true, item: item, connector: connector, accounts: accountsWithTransactions, syncedAt: new Date().toISOString()
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Erro durante a sincronização de dados bancários.' });
    }
});

router.delete('/items/:id', validate({ params: paramIdSchema }), async (req, res) => {
    try {
        const token = await getAccessToken();
        const response = await safeFetch(`${PLUGGY_API_URL}/items/${req.params.id}`, { method: 'DELETE', headers: { 'X-API-KEY': token } });
        if (!response.ok) throw new Error(`Falha HTTP ${response.status}`);
        return res.json({ success: true, message: 'Conexão bancária removida com sucesso.' });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Não foi possível remover a conexão no momento.' });
    }
});

router.post('/update-item/:id', validate({ params: paramIdSchema }), async (req, res) => {
    try {
        const token = await getAccessToken();
        const response = await safeFetch(`${PLUGGY_API_URL}/items/${req.params.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-API-KEY': token }, body: JSON.stringify({})
        });
        if (!response.ok) throw new Error(`Falha HTTP ${response.status}`);
        return res.json({ success: true, item: await response.json() });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Falha ao solicitar a atualização dos dados.' });
    }
});

// ==========================================
// OAUTH CALLBACK ENDPOINT E WEBHOOKS
// ==========================================

// GET: Redireciona o usuário de volta para o app (Navegador)
router.get('/oauth-callback', async (req, res) => {
    try {
        const { itemId, status, error } = req.query;
        const baseUrl = 'controlarapp://open-finance/callback';
        const urlObj = new URL(baseUrl);
        if (itemId) urlObj.searchParams.append('itemId', String(itemId));
        if (status) urlObj.searchParams.append('status', String(status));
        if (error) urlObj.searchParams.append('error', String(error));

        const deepLink = urlObj.toString();
        const escapeHtml = (unsafe) => (unsafe || '').toString().replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);

        res.send(`
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Autorização Bancária</title><meta http-equiv="refresh" content="0;url=${escapeHtml(deepLink)}">
                <style>
                    body { font-family: system-ui, sans-serif; text-align: center; padding: 40px; color: #333; }
                    .loader { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                </style>
            </head>
            <body>
                <div class="loader"></div><h2>Conexão Concluída</h2><p>Redirecionando de volta para o aplicativo...</p>
                <script>setTimeout(() => window.location.href = '${deepLink.replace(/'/g, "\\'")}', 500);</script>
            </body>
            </html>
        `);
    } catch (error) {
        res.status(500).send('Erro interno ao processar o retorno bancário.');
    }
});

// POST: Recebe Webhooks em background da Pluggy (Ex: transações atualizadas)
router.post('/oauth-callback', async (req, res) => {
    try {
        const webhookData = req.body;

        if (webhookData && webhookData.event) {
            console.info(`[Pluggy Webhook] 🔔 Evento recebido: ${webhookData.event} | Item: ${webhookData.itemId}`);
        }

        // Retornamos 200 OK imediatamente para a Pluggy saber que a notificação foi entregue.
        // Se não retornarmos 200, ela ficará enviando repetidas vezes.
        res.status(200).json({ received: true });

    } catch (error) {
        console.error('[Pluggy Webhook] Erro ao processar:', error);
        res.status(500).send('Internal Server Error');
    }
});

module.exports = router;