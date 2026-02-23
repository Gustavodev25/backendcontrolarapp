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

// Wrapper schema para rotas que validam apenas params
const paramIdWrapperSchema = z.object({
    params: paramIdSchema
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

// Sync polling config
const SYNC_POLL_INTERVAL_MS = 3000;       // Intervalo entre cada poll
const SYNC_POLL_MAX_ATTEMPTS = 60;        // Máximo de tentativas (60 * 3s = 3 min)
const SYNC_INITIAL_WAIT_MS = 2000;        // Espera inicial antes do primeiro poll
const ITEM_TERMINAL_STATUSES = ['UPDATED', 'LOGIN_ERROR', 'OUTDATED', 'ERROR'];

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
// HELPER: Aguardar atualização do Item Pluggy
// ==========================================
/**
 * Dispara um PATCH no item Pluggy para forçar re-extração de dados
 * do banco real, e faz polling até o status ser terminal.
 * Retorna o item atualizado ou lança erro se falhar.
 */
const waitForItemUpdate = async (token, itemId) => {
    console.info(`[Sync] 🔄 Disparando atualização real para item ${itemId}...`);

    // 1. Verifica status atual do item antes de disparar PATCH
    const preCheckResponse = await safeFetch(`${PLUGGY_API_URL}/items/${itemId}`, {
        headers: { 'X-API-KEY': token }
    });
    if (!preCheckResponse.ok) {
        throw new Error(`Item ${itemId} não encontrado (HTTP ${preCheckResponse.status})`);
    }
    const preItem = await preCheckResponse.json();
    console.info(`[Sync] 📋 Status atual do item: ${preItem.status} | Última execução: ${preItem.lastUpdatedAt || preItem.executionStatus || 'N/A'}`);

    // Se o item já está atualizando, não disparamos outro PATCH
    if (preItem.status === 'UPDATING') {
        console.info(`[Sync] ⏳ Item já está atualizando. Aguardando conclusão...`);
    } else {
        // 2. Dispara PATCH para forçar nova extração de dados do banco
        try {
            const patchResponse = await safeFetch(`${PLUGGY_API_URL}/items/${itemId}`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-KEY': token
                },
                body: JSON.stringify({})
            });

            if (!patchResponse.ok) {
                const patchError = await patchResponse.json().catch(() => ({}));
                const errorDesc = patchError.codeDescription || patchError.message || `HTTP ${patchResponse.status}`;

                // Se o item já está atualizando (race condition), continue com polling
                if (errorDesc === 'ITEM_IS_ALREADY_UPDATING' || patchResponse.status === 400) {
                    console.warn(`[Sync] ⚠️ Item já em atualização (${errorDesc}). Aguardando...`);
                } else {
                    throw new Error(`Falha ao disparar atualização: ${errorDesc}`);
                }
            } else {
                const patchResult = await patchResponse.json();
                console.info(`[Sync] ✅ PATCH disparado com sucesso. Novo status: ${patchResult.status}`);
            }
        } catch (patchErr) {
            // Se a mensagem contém "already updating", continua
            if (patchErr.message && patchErr.message.includes('already')) {
                console.warn(`[Sync] ⚠️ Item já em atualização. Prosseguindo com polling...`);
            } else {
                throw patchErr;
            }
        }
    }

    // 3. Polling: esperar o item chegar a um status terminal
    console.info(`[Sync] ⏳ Iniciando polling de status (max ${SYNC_POLL_MAX_ATTEMPTS} tentativas, intervalo ${SYNC_POLL_INTERVAL_MS}ms)...`);
    await delay(SYNC_INITIAL_WAIT_MS);

    for (let attempt = 1; attempt <= SYNC_POLL_MAX_ATTEMPTS; attempt++) {
        try {
            const pollResponse = await safeFetch(`${PLUGGY_API_URL}/items/${itemId}`, {
                headers: { 'X-API-KEY': token }
            });

            if (!pollResponse.ok) {
                console.warn(`[Sync] ⚠️ Poll attempt ${attempt}: HTTP ${pollResponse.status}`);
                await delay(SYNC_POLL_INTERVAL_MS);
                continue;
            }

            const pollItem = await pollResponse.json();
            const status = pollItem.status;

            if (attempt % 5 === 0 || ITEM_TERMINAL_STATUSES.includes(status)) {
                console.info(`[Sync] 🔍 Poll #${attempt}: status=${status}`);
            }

            if (ITEM_TERMINAL_STATUSES.includes(status)) {
                // Status terminal alcançado
                if (status === 'UPDATED') {
                    console.info(`[Sync] ✅ Item atualizado com sucesso após ${attempt} tentativas!`);
                    return pollItem;
                }

                // Erros de autenticação/conexão
                const errorInfo = pollItem.error || pollItem.executionErrorResult || {};
                const errorMessage = errorInfo.message || errorInfo.description || status;

                if (status === 'LOGIN_ERROR') {
                    console.error(`[Sync] ❌ Erro de login bancário: ${errorMessage}`);
                    throw new Error(`BANK_LOGIN_ERROR: Credenciais bancárias expiradas ou inválidas. Reconecte sua conta. Detalhe: ${errorMessage}`);
                }

                if (status === 'OUTDATED') {
                    console.error(`[Sync] ❌ Conexão bancária expirada: ${errorMessage}`);
                    throw new Error(`BANK_OUTDATED: Conexão com o banco expirou. É necessário reconectar a conta bancária.`);
                }

                if (status === 'ERROR') {
                    console.error(`[Sync] ❌ Erro do banco: ${errorMessage}`);
                    throw new Error(`BANK_ERROR: O banco retornou um erro durante a atualização. Detalhe: ${errorMessage}`);
                }
            }
        } catch (pollError) {
            // Se é um erro que lançamos propositalmente, propaga
            if (pollError.message && (pollError.message.startsWith('BANK_') || pollError.message.includes('Falha ao disparar'))) {
                throw pollError;
            }
            console.warn(`[Sync] ⚠️ Erro no poll #${attempt}: ${pollError.message}`);
        }

        await delay(SYNC_POLL_INTERVAL_MS);
    }

    // Timeout - o item não chegou a um status terminal
    console.error(`[Sync] ⏰ Timeout: item ${itemId} não finalizou após ${SYNC_POLL_MAX_ATTEMPTS} tentativas`);
    throw new Error(`SYNC_TIMEOUT: O banco demorou muito para responder. Tente novamente em alguns minutos.`);
};

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

router.get('/items/:id', validate(paramIdWrapperSchema), async (req, res) => {
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
    const syncStartTime = Date.now();
    const { itemId, from } = req.body;
    const fromDate = typeof from === 'string' && from.trim() ? from.trim() : null;

    console.info(`\n[Sync] ========================================`);
    console.info(`[Sync] 🚀 Nova sincronização iniciada`);
    console.info(`[Sync]    Item: ${itemId}`);
    console.info(`[Sync]    From: ${fromDate || '(sem filtro de data - buscar tudo)'}`);
    console.info(`[Sync]    Hora: ${new Date().toISOString()}`);
    console.info(`[Sync] ========================================`);

    try {
        const token = await getAccessToken();
        console.info(`[Sync] 🔑 Token de acesso obtido`);

        // ============ PASSO 1: Disparar atualização real e aguardar ============
        const updatedItem = await waitForItemUpdate(token, itemId);
        const updateDuration = ((Date.now() - syncStartTime) / 1000).toFixed(1);
        console.info(`[Sync] ✅ Atualização concluída em ${updateDuration}s`);

        // ============ PASSO 2: Buscar contas atualizadas ============
        console.info(`[Sync] 📂 Buscando contas do item...`);
        const accountsResponse = await safeFetch(`${PLUGGY_API_URL}/accounts?itemId=${itemId}`, {
            headers: { 'X-API-KEY': token }
        });
        if (!accountsResponse.ok) {
            console.error(`[Sync] ❌ Falha ao buscar contas: HTTP ${accountsResponse.status}`);
            throw new Error('Falha ao buscar contas após atualização');
        }
        const accountsData = await accountsResponse.json();
        const accountsList = accountsData.results || [];
        console.info(`[Sync] 📂 ${accountsList.length} conta(s) encontrada(s)`);

        // ============ PASSO 3: Buscar transações e faturas para cada conta ============
        const tasks = accountsList.map(account => async () => {
            account.itemId = itemId;
            if (!account.connector && updatedItem.connector) account.connector = updatedItem.connector;

            console.info(`[Sync] 💳 Buscando dados da conta: ${account.name || account.id} (tipo: ${account.type})`);

            const [transactions, billsData] = await Promise.all([
                fetchTransactionsForAccount(token, account.id, fromDate).catch(err => {
                    console.error(`[Sync] ❌ Erro ao buscar transações da conta ${account.id}: ${err.message}`);
                    return [];
                }),
                account.type === 'CREDIT'
                    ? safeFetch(`${PLUGGY_API_URL}/accounts/${account.id}/bills`, { headers: { 'X-API-KEY': token } })
                        .then(r => r.ok ? r.json() : { results: [] }).catch(err => {
                            console.error(`[Sync] ❌ Erro ao buscar faturas da conta ${account.id}: ${err.message}`);
                            return { results: [] };
                        })
                    : Promise.resolve({ results: [] })
            ]);

            account.transactions = transactions || [];
            account.bills = billsData?.results || [];

            console.info(`[Sync]    ✅ Conta ${account.name || account.id}: ${account.transactions.length} transações, ${account.bills.length} faturas`);
            return account;
        });

        const accountsWithTransactions = await runWithConcurrencyLimit(tasks, MAX_CONCURRENT_REQUESTS);
        const connector = accountsWithTransactions.find(acc => acc?.connector)?.connector || updatedItem.connector || null;

        // ============ PASSO 4: Resumo final ============
        const totalTransactions = accountsWithTransactions.reduce((sum, acc) => sum + (acc.transactions?.length || 0), 0);
        const totalBills = accountsWithTransactions.reduce((sum, acc) => sum + (acc.bills?.length || 0), 0);
        const totalDuration = ((Date.now() - syncStartTime) / 1000).toFixed(1);

        console.info(`[Sync] ========================================`);
        console.info(`[Sync] 🏁 Sincronização concluída!`);
        console.info(`[Sync]    Contas: ${accountsWithTransactions.length}`);
        console.info(`[Sync]    Transações: ${totalTransactions}`);
        console.info(`[Sync]    Faturas: ${totalBills}`);
        console.info(`[Sync]    Duração total: ${totalDuration}s`);
        console.info(`[Sync] ========================================\n`);

        return res.json({
            success: true,
            item: updatedItem,
            connector: connector,
            accounts: accountsWithTransactions,
            syncedAt: new Date().toISOString()
        });
    } catch (error) {
        const totalDuration = ((Date.now() - syncStartTime) / 1000).toFixed(1);
        console.error(`[Sync] ❌ ERRO na sincronização (${totalDuration}s): ${error.message}`);

        // Mapear erros específicos para mensagens amigáveis
        let userMessage = 'Erro durante a sincronização de dados bancários.';
        let statusCode = 500;

        if (error.message.startsWith('BANK_LOGIN_ERROR')) {
            userMessage = 'As credenciais do banco expiraram. É necessário reconectar a conta bancária.';
            statusCode = 401;
        } else if (error.message.startsWith('BANK_OUTDATED')) {
            userMessage = 'A conexão com o banco expirou. Reconecte sua conta para sincronizar novamente.';
            statusCode = 410;
        } else if (error.message.startsWith('BANK_ERROR')) {
            userMessage = 'O banco retornou um erro ao atualizar. Tente novamente em alguns minutos.';
            statusCode = 502;
        } else if (error.message.startsWith('SYNC_TIMEOUT')) {
            userMessage = 'O banco demorou muito para processar a atualização. Tente novamente em alguns minutos.';
            statusCode = 504;
        }

        return res.status(statusCode).json({
            success: false,
            error: userMessage,
            errorCode: error.message.split(':')[0] || 'SYNC_ERROR',
            details: error.message
        });
    }
});

router.delete('/items/:id', validate(paramIdWrapperSchema), async (req, res) => {
    try {
        const token = await getAccessToken();
        const response = await safeFetch(`${PLUGGY_API_URL}/items/${req.params.id}`, { method: 'DELETE', headers: { 'X-API-KEY': token } });
        if (!response.ok) throw new Error(`Falha HTTP ${response.status}`);
        return res.json({ success: true, message: 'Conexão bancária removida com sucesso.' });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Não foi possível remover a conexão no momento.' });
    }
});

router.post('/update-item/:id', validate(paramIdWrapperSchema), async (req, res) => {
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