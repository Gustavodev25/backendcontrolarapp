const express = require('express');
const fetch = require('node-fetch'); 
const router = express.Router();
const verifyAuth = require('../middleware/auth');
const validate = require('../middleware/validate');
const { z } = require('zod');

// ==========================================
// SCHEMAS DE VALIDAÇÃO (ZOD)
// ==========================================
const createItemSchema = z.object({
    userId: z.string().min(1, 'User ID required'),
    connectorId: z.union([z.string(), z.number()]),
    credentials: z.record(z.string(), z.any()).optional(),
    oauthRedirectUri: z.string().url().optional()
});

const syncSchema = z.object({
    userId: z.string().min(1, 'User ID required'),
    itemId: z.string().min(1, 'Item ID required'),
    from: z.string().trim().min(1).optional()
});

// ==========================================
// MIDDLEWARES E SEGURANÇA
// ==========================================
const ensureUserMatch = (req, res, next) => {
    const requestUserId = req.body?.userId || req.query?.userId || req.params?.userId;
    
    if (requestUserId && requestUserId !== req.user.uid) {
        console.warn(`[Security] Tentativa de IDOR evitada: Token(${req.user.uid}) vs Requisição(${requestUserId})`);
        return res.status(403).json({ success: false, error: 'Acesso não autorizado para este usuário' });
    }
    next();
};

router.use(verifyAuth);

// ==========================================
// CONFIGURAÇÕES PLUGGY
// ==========================================
const PLUGGY_API_URL = 'https://api.pluggy.ai';
const CLIENT_ID = process.env.PLUGGY_CLIENT_ID;
const CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET;
const PLUGGY_SANDBOX = String(process.env.PLUGGY_SANDBOX ?? 'true').toLowerCase() === 'true';

let accessToken = null;
let tokenExpiry = null;
let tokenPromise = null; 

const TRANSACTIONS_PAGE_SIZE = 500;
const MAX_TRANSACTION_PAGES = 50; 
const FETCH_TIMEOUT_MS = 25000; 

// ==========================================
// UTILS DE REDE (COM RETRY PARA RATE LIMIT)
// ==========================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const safeFetch = async (url, options = {}, retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            
            // Tratamento de Rate Limit (429) e Erros Internos da API
            if (!response.ok && (response.status === 429 || response.status >= 500)) {
                if (attempt === retries) return response; 
                
                const backoff = attempt * 1500;
                console.warn(`[Pluggy API] Limit/Erro ${response.status}. Tentativa ${attempt}/${retries}. Aguardando ${backoff}ms...`);
                await delay(backoff);
                continue; 
            }
            
            return response;
        } catch (error) {
            const isTimeout = error.name === 'AbortError' || error.message.includes('Tempo de requisição');
            if (attempt === retries) {
                if (isTimeout) throw new Error(`Tempo de requisição esgotado (${url})`);
                throw error;
            }

            const backoff = attempt * 1500;
            console.warn(`[Pluggy API] Falha de rede. Tentativa ${attempt}/${retries}. Aguardando ${backoff}ms...`);
            await delay(backoff);
        } finally {
            clearTimeout(timeout);
        }
    }
};

async function getAccessToken() {
    if (accessToken && tokenExpiry && Date.now() < tokenExpiry - 300000) return accessToken;
    if (tokenPromise) return tokenPromise;

    console.log('[Pluggy] Buscando novo access token...');
    tokenPromise = (async () => {
        try {
            const response = await safeFetch(`${PLUGGY_API_URL}/auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
            });

            if (!response.ok) throw new Error(`Pluggy Auth falhou: ${response.status}`);

            const data = await response.json();
            accessToken = data.apiKey;
            tokenExpiry = Date.now() + (2 * 60 * 60 * 1000); 
            console.log('[Pluggy] Access token obtido com sucesso');
            return accessToken;
        } finally {
            tokenPromise = null;
        }
    })();

    return tokenPromise;
}

// ==========================================
// FUNÇÕES AUXILIARES DE ALTA PERFORMANCE
// ==========================================
const resolveConnectorId = (connector) => {
    if (!connector) return null;
    if (typeof connector === 'object') return connector.id || connector.connectorId || null;
    return connector;
};

const fetchTransactionsForAccount = async (token, accountId, fromDate) => {
    const transactions = [];
    const params = new URLSearchParams({
        accountId: String(accountId),
        pageSize: String(TRANSACTIONS_PAGE_SIZE),
        page: '1'
    });
    if (fromDate) params.set('from', fromDate);

    // 1. Busca primeira página
    const firstPageRes = await safeFetch(`${PLUGGY_API_URL}/transactions?${params.toString()}`, { headers: { 'X-API-KEY': token } });
    if (!firstPageRes.ok) return [];

    const firstPageData = await firstPageRes.json();
    const page1Results = Array.isArray(firstPageData.results) ? firstPageData.results : [];
    transactions.push(...page1Results);

    const totalFromApi = Number(firstPageData.total);
    
    // 2. Busca o restante das páginas em paralelo se houverem muitas transações
    if (totalFromApi > TRANSACTIONS_PAGE_SIZE && page1Results.length > 0) {
        const totalPages = Math.ceil(totalFromApi / TRANSACTIONS_PAGE_SIZE);
        const maxPages = Math.min(totalPages, MAX_TRANSACTION_PAGES);
        
        const pagesPromises = [];
        for (let p = 2; p <= maxPages; p++) {
            const pParams = new URLSearchParams(params);
            pParams.set('page', String(p));
            pagesPromises.push(
                safeFetch(`${PLUGGY_API_URL}/transactions?${pParams.toString()}`, { headers: { 'X-API-KEY': token } })
                    .then(res => res.ok ? res.json() : null)
                    .then(data => data && Array.isArray(data.results) ? data.results : [])
                    .catch(() => [])
            );
        }

        // Resolve em mini-lotes de 3 para não estressar a API
        for (let i = 0; i < pagesPromises.length; i += 3) {
            const batch = pagesPromises.slice(i, i + 3);
            const batchResults = await Promise.all(batch);
            batchResults.forEach(res => transactions.push(...res));
            await delay(150); 
        }
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
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('[Pluggy] Connectors error:', error.message);
        res.status(500).json({ success: false, error: 'Falha ao buscar conectores bancários' });
    }
});

router.post('/create-item', validate(createItemSchema), ensureUserMatch, async (req, res) => {
    try {
        const { connectorId, credentials, oauthRedirectUri } = req.body;
        const token = await getAccessToken();
        const payload = { connectorId, parameters: credentials || {} };
        if (oauthRedirectUri) payload.redirectUrl = oauthRedirectUri;

        const response = await safeFetch(`${PLUGGY_API_URL}/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': token },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        
        if (!response.ok) {
            let errorMessage = 'Falha ao conectar na instituição';
            
            // Tratamento específico para evitar duplicação ou processos travados (ITEM_IS_ALREADY_UPDATING)
            if (data.codeDescription === 'ITEM_IS_ALREADY_UPDATING') {
                errorMessage = 'Uma conexão com estas credenciais já está em andamento. Aguarde alguns segundos antes de tentar novamente.';
            } else if (data.message) {
                errorMessage = data.message;
            } else if (data.error) {
                errorMessage = data.error;
            }
            
            const errorDetails = {
                message: errorMessage,
                code: data.code,
                codeDescription: data.codeDescription,
                status: response.status,
                details: data
            };
            
            console.error('[Pluggy] Create item failed:', errorDetails);
            
            return res.status(response.status).json({ 
                success: false, 
                error: errorMessage, 
                details: errorDetails 
            });
        }

        const oauthUrl = data.parameter?.oauthUrl || data.oauthUrl || data.userAction?.url;
        res.json({ success: true, item: data, oauthUrl });
    } catch (error) {
        console.error('[Pluggy] Create item error:', error.message);
        res.status(500).json({ success: false, error: 'Erro interno ao criar conexão' });
    }
});

router.get('/items/:id', ensureUserMatch, async (req, res) => {
    try {
        const { id } = req.params;
        if (!req.query.userId && !req.body.userId) return res.status(400).json({ success: false, error: 'userId obrigatório' });
        
        const token = await getAccessToken();
        const response = await safeFetch(`${PLUGGY_API_URL}/items/${id}`, { headers: { 'X-API-KEY': token } });
        if (!response.ok) return res.status(response.status === 404 ? 404 : 500).json({ success: false, error: 'Conexão não encontrada' });
        
        const data = await response.json();
        
        // Log do status para debug (silenciando um pouco o UPDATED que acontece muito)
        if (data.status && data.status !== 'UPDATED') {
            console.log(`[Pluggy] Item ${id} status: ${data.status}`);
        }
        
        res.json({ success: true, item: data });
    } catch (error) {
        console.error('[Pluggy] Get item error:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao buscar status' });
    }
});

router.post('/sync', validate(syncSchema), ensureUserMatch, async (req, res) => {
    try {
        const { itemId, from } = req.body;
        const fromDate = typeof from === 'string' && from.trim() ? from.trim() : null;
        const token = await getAccessToken();

        const itemResponse = await safeFetch(`${PLUGGY_API_URL}/items/${itemId}`, { headers: { 'X-API-KEY': token } });
        if (!itemResponse.ok) throw new Error('Item não encontrado ou acesso negado');
        const item = await itemResponse.json();

        const accountsResponse = await safeFetch(`${PLUGGY_API_URL}/accounts?itemId=${itemId}`, { headers: { 'X-API-KEY': token } });
        if (!accountsResponse.ok) throw new Error('Falha ao buscar contas');
        const accountsData = await accountsResponse.json();
        const accounts = accountsData.results || [];

        const accountsWithTransactions = [];
        const BATCH_SIZE = 2; 
        
        for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
            const batch = accounts.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (account) => {
                account.itemId = itemId;
                if (!account.connector && item.connector) account.connector = item.connector;

                const [transactions, billsData] = await Promise.all([
                    fetchTransactionsForAccount(token, account.id, fromDate)
                        .catch(err => {
                            console.warn(`[Pluggy] Exceção transações conta ${account.id}:`, err.message);
                            return [];
                        }),
                        
                    account.type === 'CREDIT' 
                        ? safeFetch(`${PLUGGY_API_URL}/accounts/${account.id}/bills`, { headers: { 'X-API-KEY': token } })
                            .then(res => res.ok ? res.json() : { results: [] })
                            .catch(err => {
                                console.warn(`[Pluggy] Exceção faturas cartão ${account.id}:`, err.message);
                                return { results: [] };
                            })
                        : Promise.resolve({ results: [] })
                ]);

                account.transactions = transactions || [];
                account.bills = billsData?.results || [];
                
                return account;
            });

            const completedBatch = await Promise.all(batchPromises);
            accountsWithTransactions.push(...completedBatch);
        }

        let connector = accountsWithTransactions.find(acc => acc?.connector)?.connector || item.connector || null;

        res.json({
            success: true,
            item: item,
            connector: connector,
            accounts: accountsWithTransactions,
            syncedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('[Pluggy] Sync error:', error.message);
        res.status(500).json({ success: false, error: 'Erro durante a sincronização de dados' });
    }
});

router.delete('/items/:id', ensureUserMatch, async (req, res) => {
    try {
        const { id } = req.params;
        if (!req.query.userId && !req.body.userId) return res.status(400).json({ success: false, error: 'userId obrigatório' });
        
        const token = await getAccessToken();
        const response = await safeFetch(`${PLUGGY_API_URL}/items/${id}`, { method: 'DELETE', headers: { 'X-API-KEY': token } });
        if (!response.ok) throw new Error(`Falha ao excluir item: ${response.status}`);
        res.json({ success: true, message: 'Conexão removida com sucesso' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Não foi possível remover a conexão' });
    }
});

router.post('/update-item/:id', ensureUserMatch, async (req, res) => {
    try {
        const { id } = req.params;
        if (!req.query.userId && !req.body.userId) return res.status(400).json({ success: false, error: 'userId obrigatório' });
        
        const token = await getAccessToken();
        const response = await safeFetch(`${PLUGGY_API_URL}/items/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-API-KEY': token }, body: JSON.stringify({}) });
        if (!response.ok) throw new Error(`Falha ao solicitar atualização: ${response.status}`);
        const data = await response.json();
        res.json({ success: true, item: data });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Falha ao solicitar atualização dos dados' });
    }
});

module.exports = router;