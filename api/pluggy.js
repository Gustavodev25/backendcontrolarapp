const express = require('express');
const fetch = require('node-fetch');
const { z } = require('zod');
const { getFirebaseAdmin, isFirebaseConfigured } = require('../lib/firebaseAdmin');

const router = express.Router();

// ====================== VALIDAÇÃO DE AMBIENTE ======================
const envSchema = z.object({
    PLUGGY_CLIENT_ID: z.string().min(1, 'PLUGGY_CLIENT_ID obrigatório'),
    PLUGGY_CLIENT_SECRET: z.string().min(1, 'PLUGGY_CLIENT_SECRET obrigatório'),
    PLUGGY_SANDBOX: z.enum(['true', 'false']).optional().default('false'),
});

const env = envSchema.parse(process.env);

const PLUGGY_API_URL = 'https://api.pluggy.ai';
const DEFAULT_BACKEND_URL = 'https://backendcontrolarapp-production.up.railway.app';
const DEFAULT_APP_REDIRECT_URI = 'controlarapp://open-finance/callback';
const PLUGGY_WEBHOOK_IPS = ['177.71.238.212'];
const PUBLIC_ROUTES = ['/webhook', '/ping', '/connectors', '/oauth-callback'];
const TRANSACTIONS_PAGE_SIZE = 500;
const MAX_TRANSACTION_PAGES_DEFAULT = 2; // 1.000 transações
const MAX_TRANSACTION_PAGES_FULL_HISTORY = 6; // 3.000 transações por conta (aprox. 5+ anos para usuário normal) - Evita Explosão de Memória/JSON
const FULL_HISTORY_FROM_DATE = '1970-01-01';
const FETCH_TIMEOUT_MS = 25000;

const normalizeUrlBase = (value) => String(value || '').trim().replace(/\/+$/, '');

const getQueryValue = (value) => {
    if (Array.isArray(value)) return value[0];
    if (typeof value === 'string') return value;
    return undefined;
};

const getRequestBaseUrl = (req) => {
    const configured = normalizeUrlBase(process.env.PUBLIC_BASE_URL || process.env.RAILWAY_STATIC_URL);
    if (configured) {
        return configured.startsWith('http://') || configured.startsWith('https://')
            ? configured
            : `https://${configured}`;
    }

    const forwardedProto = getQueryValue(req.headers['x-forwarded-proto']) || 'https';
    const forwardedHost = getQueryValue(req.headers['x-forwarded-host']) || req.headers.host;
    if (forwardedHost) return `${forwardedProto}://${forwardedHost}`;

    return DEFAULT_BACKEND_URL;
};

const toValidAppRedirectUri = (candidate) => {
    if (!candidate) return DEFAULT_APP_REDIRECT_URI;
    try {
        const parsed = new URL(candidate);
        return parsed.toString();
    } catch {
        return DEFAULT_APP_REDIRECT_URI;
    }
};

const buildBackendOAuthCallbackUrl = (req, appRedirectUri) => {
    const callbackUrl = new URL('/api/pluggy/oauth-callback', getRequestBaseUrl(req));
    callbackUrl.searchParams.set('appRedirectUri', toValidAppRedirectUri(appRedirectUri));
    return callbackUrl.toString();
};

const escapeHtml = (unsafe = '') => String(unsafe).replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
}[match]));

const renderOAuthRedirectPage = (redirectUrl) => `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Retornando ao aplicativo</title>
  <meta http-equiv="refresh" content="0;url=${escapeHtml(redirectUrl)}" />
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f0f10; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { width: min(92vw, 460px); background: #19191b; border: 1px solid #2a2a2f; border-radius: 16px; padding: 24px; text-align: center; }
    .spinner { width: 34px; height: 34px; border-radius: 999px; border: 3px solid #3a3a40; border-top-color: #d97757; margin: 0 auto 16px; animation: spin 0.9s linear infinite; }
    a { color: #f29f7d; word-break: break-all; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h2>Autorização recebida</h2>
    <p>Estamos retornando você para o app.</p>
    <p>Se não abrir automaticamente, toque no link:</p>
    <p><a href="${escapeHtml(redirectUrl)}">${escapeHtml(redirectUrl)}</a></p>
  </div>
  <script>
    setTimeout(function() { window.location.href = ${JSON.stringify(redirectUrl)}; }, 400);
  </script>
</body>
</html>`;

const normalizeIp = (value) => String(value || '').trim().replace(/^::ffff:/, '');

const getClientIp = (req) => {
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (typeof xForwardedFor === 'string' && xForwardedFor.trim()) {
        return normalizeIp(xForwardedFor.split(',')[0].trim());
    }
    if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
        return normalizeIp(String(xForwardedFor[0]).split(',')[0].trim());
    }
    return normalizeIp(req.ip || req.connection?.remoteAddress || '');
};

const isLocalIp = (ip) => ['127.0.0.1', '::1', 'localhost'].includes(ip);

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
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

const pluggy = PluggyClient.getInstance();

// ====================== SCHEMAS ======================
const createItemSchema = z.object({
    connectorId: z.union([z.string(), z.number()]),
    credentials: z.record(z.string(), z.any()).optional(),
    oauthRedirectUri: z.string().optional(),
    appRedirectUri: z.string().optional(),
    products: z.array(z.string().toUpperCase()).optional(),
    webhookUrl: z.string().optional(),
});

const syncSchema = z.object({
    itemId: z.string().uuid(),
    from: z.string().datetime({ offset: true }).optional(),
    fullHistory: z.boolean().optional().default(false),
    autoRefresh: z.boolean().optional().default(false),
});

const paramIdSchema = z.object({ id: z.string().uuid() });

const mapItemOwnershipError = (err) => {
    if (err && typeof err === 'object' && 'status' in err && 'message' in err) {
        return err;
    }
    return { status: 500, message: 'Erro ao validar item' };
};

const extractItemErrorSnapshot = (item) => {
    const error = item?.error && typeof item.error === 'object' ? item.error : {};
    return {
        status: item?.status || null,
        executionStatus: item?.executionStatus || null,
        errorCode: error?.code || null,
        errorMessage: error?.message || null,
        providerMessage: error?.providerMessage || null,
        connector: item?.connector?.name || null,
        updatedAt: item?.updatedAt || null,
    };
};

const logItemDiagnostics = async (source, event, itemId) => {
    if (!itemId) return;
    try {
        const itemRes = await pluggy.safeFetch(`${PLUGGY_API_URL}/items/${itemId}`);
        if (!itemRes.ok) {
            console.warn(`[${source}] Event: ${event} | Item: ${itemId} | Snapshot unavailable (HTTP ${itemRes.status})`);
            return;
        }

        const item = await itemRes.json();
        const snapshot = extractItemErrorSnapshot(item);

        console.warn(
            `[${source}] Event: ${event} | Item: ${itemId} | Status: ${snapshot.status || 'N/A'} | Exec: ${snapshot.executionStatus || 'N/A'} | ErrorCode: ${snapshot.errorCode || 'N/A'} | ErrorMessage: ${snapshot.errorMessage || 'N/A'}`
        );
        if (snapshot.providerMessage) {
            console.warn(`[${source}] Provider detail | Item: ${itemId} | ${snapshot.providerMessage}`);
        }
    } catch (error) {
        console.warn(`[${source}] Event: ${event} | Item: ${itemId} | Failed to fetch diagnostics: ${error?.message || error}`);
    }
};

const ensureItemOwnership = async (itemId, expectedUserId) => {
    const itemRes = await pluggy.safeFetch(`${PLUGGY_API_URL}/items/${itemId}`);
    if (!itemRes.ok) {
        const status = itemRes.status === 404 ? 404 : 502;
        throw { status, message: 'Item não encontrado' };
    }

    const item = await itemRes.json();
    if (!item?.clientUserId || item.clientUserId !== expectedUserId) {
        throw { status: 403, message: 'Acesso negado para este item' };
    }

    return item;
};

// ====================== MIDDLEWARE DE AUTENTICAÇÃO ======================
const enforceUser = async (req, res, next) => {
    if (PUBLIC_ROUTES.some((route) => req.path.startsWith(route))) {
        return next();
    }

    if (!isFirebaseConfigured()) {
        return res.status(500).json({
            success: false,
            error: 'Firebase Admin não configurado no servidor'
        });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Token de autenticação ausente' });
    }

    try {
        const token = authHeader.split('Bearer ')[1];
        const firebaseAdmin = getFirebaseAdmin();
        const decodedToken = await firebaseAdmin.auth().verifyIdToken(token);
        req.user = decodedToken;
        req.currentUser = decodedToken.uid;
        return next();
    } catch (error) {
        return res.status(401).json({ success: false, error: 'Token inválido ou expirado' });
    }
};

router.use(enforceUser);

// ====================== ROTAS PÚBLICAS ======================
router.get('/ping', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.get('/connectors', async (req, res) => {
    try {
        const resp = await pluggy.safeFetch(`${PLUGGY_API_URL}/connectors?sandbox=${env.PLUGGY_SANDBOX}&types=PERSONAL_BANK,BUSINESS_BANK`);
        if (!resp.ok) {
            const errData = await resp.text();
            throw new Error(`HTTP ${resp.status} - ${errData}`);
        }
        res.json(await resp.json());
    } catch (err) {
        res.status(502).json({ success: false, error: 'Serviço temporariamente indisponível' });
    }
});

router.get('/oauth-callback', async (req, res) => {
    try {
        const itemId = getQueryValue(req.query.itemId);
        const status = getQueryValue(req.query.status);
        const error = getQueryValue(req.query.error);
        const appRedirectUri = toValidAppRedirectUri(getQueryValue(req.query.appRedirectUri));

        const redirectUrl = new URL(appRedirectUri);
        if (itemId) redirectUrl.searchParams.set('itemId', itemId);
        if (status) redirectUrl.searchParams.set('status', status);
        if (error) redirectUrl.searchParams.set('error', error);

        const finalUrl = redirectUrl.toString();
        res.status(200).send(renderOAuthRedirectPage(finalUrl));
    } catch (err) {
        res.status(500).json({ success: false, error: 'Falha ao processar callback OAuth' });
    }
});

router.post('/oauth-callback', async (req, res) => {
    const body = req.body || {};
    const event = body.event || 'OAUTH_CALLBACK';
    const itemId = body.itemId || getQueryValue(req.query.itemId) || null;
    const bodyErrorCode = body?.error?.code || null;
    const bodyErrorMessage = body?.error?.message || null;

    console.info(
        `[Pluggy OAuth Callback] Event: ${event} | Item: ${itemId} | ErrorCode: ${bodyErrorCode || 'N/A'} | ErrorMessage: ${bodyErrorMessage || 'N/A'}`
    );
    res.status(200).json({ received: true });

    if (event === 'item/error' && itemId) {
        logItemDiagnostics('Pluggy OAuth Callback', event, itemId).catch(() => null);
    }
});

router.post('/webhook', async (req, res) => {
    const clientIp = getClientIp(req);

    if (!PLUGGY_WEBHOOK_IPS.includes(clientIp) && !isLocalIp(clientIp)) {
        return res.status(403).send('Forbidden');
    }

    const body = req.body;
    if (!body || !body.event) {
        return res.status(400).send('Bad Request');
    }

    const bodyErrorCode = body?.error?.code || null;
    const bodyErrorMessage = body?.error?.message || null;
    console.info(
        `[WEBHOOK] Evento: ${body.event} | Item: ${body.itemId} | User: ${body.clientUserId} | ErrorCode: ${bodyErrorCode || 'N/A'} | ErrorMessage: ${bodyErrorMessage || 'N/A'}`
    );
    res.status(200).json({ received: true });

    if (body.event === 'item/error' && body.itemId) {
        logItemDiagnostics('Pluggy Webhook', body.event, body.itemId).catch(() => null);
    }
});

// ====================== ROTAS AUTENTICADAS ======================
router.post('/create-item', async (req, res) => {
    try {
        const body = createItemSchema.parse(req.body);
        const appRedirectUri = body.appRedirectUri || body.oauthRedirectUri || DEFAULT_APP_REDIRECT_URI;
        const callbackUrl = buildBackendOAuthCallbackUrl(req, appRedirectUri);

        const reqCredentials = body.credentials || {};
        const safeParameters = {};
        for (const [key, value] of Object.entries(reqCredentials)) {
            if (value !== null && value !== undefined && value !== '') {
                safeParameters[key] = value;
            }
        }

        const payload = {
            connectorId: body.connectorId,
            parameters: safeParameters,
            clientUserId: req.currentUser,
            clientUrl: callbackUrl,
            ...(body.products && { products: body.products }),
            ...(body.webhookUrl && { webhookUrl: body.webhookUrl }),
        };

        const resp = await pluggy.safeFetch(`${PLUGGY_API_URL}/items`, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await resp.json();
        if (!resp.ok) {
            const alreadyUpdating =
                data.codeDescription?.includes('ALREADY_UPDATING') ||
                data.message?.includes('ALREADY_UPDATING');
            console.warn(
                `[Pluggy Create Item] HTTP ${resp.status} | Connector: ${body.connectorId} | User: ${req.currentUser} | Code: ${data?.code || data?.codeDescription || 'N/A'} | Message: ${data?.message || 'N/A'}`
            );

            return res.status(resp.status).json({
                success: false,
                error: alreadyUpdating
                    ? 'Conexão já em andamento. Aguarde o webhook.'
                    : (data.message || 'Falha ao conectar'),
            });
        }

        const oauthUrl =
            data.oauthUrl ||
            data.parameter?.oauthUrl ||
            data.parameter?.data ||
            data.userAction?.url ||
            data.userAction?.attributes?.url ||
            null;

        return res.json({
            success: true,
            item: data,
            oauthUrl,
            callbackUrl
        });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

router.post('/force-refresh/:id', async (req, res) => {
    try {
        const { id } = paramIdSchema.parse({ id: req.params.id });
        await ensureItemOwnership(id, req.currentUser);

        const refreshRes = await pluggy.safeFetch(`${PLUGGY_API_URL}/items/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });

        if (!refreshRes.ok) {
            return res.status(502).json({ success: false, error: 'Falha ao iniciar atualização do item' });
        }

        return res.status(202).json({
            success: true,
            message: 'Sincronização iniciada!',
            itemId: id
        });
    } catch (err) {
        const mapped = mapItemOwnershipError(err);
        return res.status(mapped.status).json({ success: false, error: mapped.message });
    }
});

router.post('/sync', async (req, res) => {
    try {
        const { itemId, from, fullHistory = false, autoRefresh = false } = syncSchema.parse(req.body);
        const itemData = await ensureItemOwnership(itemId, req.currentUser);

        if (autoRefresh) {
            pluggy.safeFetch(`${PLUGGY_API_URL}/items/${itemId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }).catch(() => null);
        }

        const accountsRes = await pluggy.safeFetch(`${PLUGGY_API_URL}/accounts?itemId=${itemId}`);
        if (!accountsRes.ok) {
            return res.status(502).json({ success: false, error: 'Erro ao buscar contas do item' });
        }

        const { results: accountsList = [] } = await accountsRes.json();
        const fromDate = from || (
            fullHistory
                ? FULL_HISTORY_FROM_DATE
                : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        );
        const maxTransactionPages = fullHistory
            ? MAX_TRANSACTION_PAGES_FULL_HISTORY
            : MAX_TRANSACTION_PAGES_DEFAULT;

        const enrichedAccounts = [];
        const CONCURRENT_ACCOUNTS = 3;

        for (let i = 0; i < accountsList.length; i += CONCURRENT_ACCOUNTS) {
            const batch = accountsList.slice(i, i + CONCURRENT_ACCOUNTS);
            const batchResults = await Promise.all(batch.map(async (account) => {
                let allTx = [];
                let page = 1;
                let hasMore = true;

                while (hasMore && page <= maxTransactionPages) {
                    const params = new URLSearchParams({
                        accountId: account.id,
                        pageSize: TRANSACTIONS_PAGE_SIZE.toString(),
                        page: page.toString(),
                        from: fromDate,
                    });

                    const txRes = await pluggy.safeFetch(`${PLUGGY_API_URL}/transactions?${params}`);
                    const txData = txRes.ok ? await txRes.json() : { results: [], totalPages: page };
                    allTx = [...allTx, ...(txData.results || [])];

                    if (Number(txData.totalPages || 0) <= page) hasMore = false;
                    page += 1;
                }
                const truncatedByPageLimit = hasMore;

                let bills = [];
                if (account.type === 'CREDIT') {
                    const billsRes = await pluggy.safeFetch(`${PLUGGY_API_URL}/accounts/${account.id}/bills`);
                    if (billsRes.ok) {
                        const billsPayload = await billsRes.json();
                        bills = billsPayload.results || [];
                    }
                }

                return { ...account, transactions: allTx, bills, truncatedByPageLimit };
            }));

            enrichedAccounts.push(...batchResults);

            if (i + CONCURRENT_ACCOUNTS < accountsList.length) {
                // Pequena pausa entre os lotes para aliviar a API
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }

        return res.json({
            success: true,
            itemStatus: itemData.status,
            lastUpdatedAt: itemData.updatedAt,
            isRefreshing: itemData.status === 'UPDATING' || autoRefresh,
            connector: itemData.connector || null,
            accounts: enrichedAccounts,
            totalTransactions: enrichedAccounts.reduce((sum, account) => sum + (account.transactions?.length || 0), 0),
            truncatedByPageLimit: enrichedAccounts.some((account) => account.truncatedByPageLimit === true),
            syncWindow: {
                from: fromDate,
                fullHistory,
            },
            syncedAt: new Date().toISOString(),
        });
    } catch (err) {
        const mapped = mapItemOwnershipError(err);
        return res.status(mapped.status).json({
            success: false,
            error: mapped.message || 'Erro ao buscar dados sincronizados.'
        });
    }
});

router.get('/items', async (req, res) => {
    try {
        const resp = await pluggy.safeFetch(`${PLUGGY_API_URL}/items?clientUserId=${req.currentUser}`);
        if (!resp.ok) {
            return res.status(502).json({ success: false, error: 'Erro ao listar items' });
        }
        return res.json(await resp.json());
    } catch (err) {
        return res.status(502).json({ success: false, error: 'Erro ao listar items' });
    }
});

router.get('/items/:id', async (req, res) => {
    try {
        const { id } = paramIdSchema.parse({ id: req.params.id });
        const item = await ensureItemOwnership(id, req.currentUser);
        return res.json({ success: true, item });
    } catch (err) {
        const mapped = mapItemOwnershipError(err);
        return res.status(mapped.status).json({ success: false, error: mapped.message });
    }
});

router.delete('/items/:id', async (req, res) => {
    try {
        const { id } = paramIdSchema.parse({ id: req.params.id });
        await ensureItemOwnership(id, req.currentUser);

        const deleteRes = await pluggy.safeFetch(`${PLUGGY_API_URL}/items/${id}`, { method: 'DELETE' });
        if (!deleteRes.ok) {
            return res.status(502).json({ success: false, error: 'Falha ao desconectar item' });
        }

        return res.json({ success: true, message: 'Item desconectado com sucesso' });
    } catch (err) {
        const mapped = mapItemOwnershipError(err);
        return res.status(mapped.status).json({ success: false, error: mapped.message });
    }
});

module.exports = router;