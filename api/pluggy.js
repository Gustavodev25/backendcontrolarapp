const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();
const verifyAuth = require('../middleware/auth');
const validate = require('../middleware/validate');
const { z } = require('zod');

// Schemas
const createItemSchema = z.object({
    userId: z.string().min(1, 'User ID required'),
    connectorId: z.union([z.string(), z.number()]),
    credentials: z.record(z.any()).optional(),
    oauthRedirectUri: z.string().url().optional()
});

const syncSchema = z.object({
    userId: z.string().min(1),
    itemId: z.string().min(1)
});

// Middleware to ensure user matches token
const ensureUserMatch = (req, res, next) => {
    // If body has userId, check it
    if (req.body && req.body.userId && req.body.userId !== req.user.uid) {
        console.warn(`[Security] User ID mismatch: Token(${req.user.uid}) vs Body(${req.body.userId})`);
        return res.status(403).json({ success: false, error: 'Acesso não autorizado para este usuário' });
    }
    next();
};

// Apply Auth globally for this router? Or per route? Per route is safer for visibility.
// Actually, ALL pluggy routes should be protected.
router.use(verifyAuth);


// Pluggy API Configuration
const PLUGGY_API_URL = 'https://api.pluggy.ai';
const CLIENT_ID = process.env.PLUGGY_CLIENT_ID;
const CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET;
const PLUGGY_SANDBOX = String(process.env.PLUGGY_SANDBOX ?? 'true').toLowerCase() === 'true';

// Token cache
let accessToken = null;
let tokenExpiry = null;

const resolveConnectorId = (connector) => {
    if (!connector) return null;

    if (typeof connector === 'object') {
        return connector.id || connector.connectorId || null;
    }

    return connector;
};

const fetchConnectorById = async (token, connectorId) => {
    if (!connectorId) return null;

    const connectorResponse = await fetch(
        `${PLUGGY_API_URL}/connectors/${connectorId}`,
        { headers: { 'X-API-KEY': token } }
    );

    if (!connectorResponse.ok) {
        return null;
    }

    return connectorResponse.json();
};

/**
 * Get or refresh Pluggy API access token
 */
async function getAccessToken() {
    // Return cached token if still valid (with 5 min buffer)
    if (accessToken && tokenExpiry && Date.now() < tokenExpiry - 300000) {
        return accessToken;
    }

    console.log('[Pluggy] Fetching new access token...');

    const response = await fetch(`${PLUGGY_API_URL}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET
        })
    });

    if (!response.ok) {
        const error = await response.text();
        console.error('[Pluggy] Auth error:', error);
        throw new Error('Failed to authenticate with Pluggy API');
    }

    const data = await response.json();
    accessToken = data.apiKey;
    // Token valid for 2 hours, cache it
    tokenExpiry = Date.now() + (2 * 60 * 60 * 1000);

    console.log('[Pluggy] Access token obtained successfully');
    return accessToken;
}

/**
 * GET /api/pluggy/connectors
 * List available bank connectors
 */
router.get('/connectors', async (req, res) => {
    try {
        const token = await getAccessToken();
        const sandbox = PLUGGY_SANDBOX ? 'true' : 'false';

        const response = await fetch(`${PLUGGY_API_URL}/connectors?sandbox=${sandbox}&types=PERSONAL_BANK,BUSINESS_BANK`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': token
            }
        });

        if (!response.ok) {
            throw new Error(`Pluggy API error: ${response.status}`);
        }

        const data = await response.json();
        console.log(`[Pluggy] Found ${data.results?.length || 0} connectors`);

        res.json(data);
    } catch (error) {
        console.error('[Pluggy] Connectors error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/pluggy/create-item
 * Create a new connection item
 */
router.post('/create-item', validate(createItemSchema), ensureUserMatch, async (req, res) => {
    try {
        const { userId, connectorId, credentials, oauthRedirectUri } = req.body;

        if (!userId || !connectorId) {
            return res.status(400).json({
                success: false,
                error: 'userId and connectorId are required'
            });
        }

        const token = await getAccessToken();

        console.log(`[Pluggy] Creating item for connector ${connectorId}, user ${userId}`);

        const payload = {
            connectorId: connectorId,
            parameters: credentials || {}
        };

        // Add OAuth redirect if provided
        if (oauthRedirectUri) {
            payload.redirectUrl = oauthRedirectUri;
        }

        const response = await fetch(`${PLUGGY_API_URL}/items`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': token
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('[Pluggy] Create item error:', data);
            return res.status(response.status).json({
                success: false,
                error: data.message || 'Failed to create item',
                details: data
            });
        }

        console.log(`[Pluggy] Item created: ${data.id}, status: ${data.status}`);

        // Check for OAuth URL in response
        const oauthUrl = data.parameter?.oauthUrl || data.oauthUrl || data.userAction?.url;

        res.json({
            success: true,
            item: data,
            oauthUrl: oauthUrl
        });
    } catch (error) {
        console.error('[Pluggy] Create item error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/pluggy/items/:id
 * Get item status and details
 */
router.get('/items/:id', async (req, res) => {
    // TODO: Verify item ownership (IDOR check) - requires DB lookup

    try {
        const { id } = req.params;
        const token = await getAccessToken();

        console.log(`[Pluggy] Fetching item ${id}`);

        const response = await fetch(`${PLUGGY_API_URL}/items/${id}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': token
            }
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('[Pluggy] Get item error:', error);
            return res.status(response.status).json({
                success: false,
                error: 'Item not found'
            });
        }

        const data = await response.json();
        console.log(`[Pluggy] Item ${id} status: ${data.status}`);

        res.json({ success: true, item: data });
    } catch (error) {
        console.error('[Pluggy] Get item error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/pluggy/sync
 * Sync item data (accounts, transactions) to Firebase
 */
router.post('/sync', validate(syncSchema), ensureUserMatch, async (req, res) => {
    try {
        const { userId, itemId } = req.body;

        if (!userId || !itemId) {
            return res.status(400).json({
                success: false,
                error: 'userId and itemId are required'
            });
        }

        const token = await getAccessToken();

        console.log(`[Pluggy] Syncing item ${itemId} for user ${userId}`);

        // 1. Get item details
        const itemResponse = await fetch(`${PLUGGY_API_URL}/items/${itemId}`, {
            headers: { 'X-API-KEY': token }
        });

        if (!itemResponse.ok) {
            throw new Error('Failed to fetch item');
        }

        const item = await itemResponse.json();

        // 2. Get accounts for this item
        const accountsResponse = await fetch(`${PLUGGY_API_URL}/accounts?itemId=${itemId}`, {
            headers: { 'X-API-KEY': token }
        });

        if (!accountsResponse.ok) {
            throw new Error('Failed to fetch accounts');
        }

        const accountsData = await accountsResponse.json();
        const accounts = accountsData.results || [];

        console.log(`[Pluggy] Found ${accounts.length} accounts for item ${itemId}`);

        // Log details of each account
        accounts.forEach((acc, idx) => {
            console.log(`[Pluggy] Account ${idx + 1}: type=${acc.type}, subtype=${acc.subtype}, name=${acc.name}, balance=${acc.balance}`);
        });

        // 3. Get transactions for each account and add itemId
        // Also get bills for credit card accounts
        const accountsWithTransactions = await Promise.all(
            accounts.map(async (account) => {
                // Add itemId to account for reference
                account.itemId = itemId;
                if (!account.connector && item.connector) {
                    account.connector = item.connector;
                }

                // Fetch transactions
                try {
                    const txResponse = await fetch(
                        `${PLUGGY_API_URL}/transactions?accountId=${account.id}&pageSize=500`,
                        { headers: { 'X-API-KEY': token } }
                    );

                    if (txResponse.ok) {
                        const txData = await txResponse.json();
                        account.transactions = txData.results || [];
                        console.log(`[Pluggy] Account ${account.id}: ${account.transactions.length} transactions`);
                    }
                } catch (_error) {
                    console.warn(`[Pluggy] Failed to fetch transactions for account ${account.id}`);
                    account.transactions = [];
                }

                // Fetch bills for credit card accounts
                if (account.type === 'CREDIT') {
                    try {
                        const billsResponse = await fetch(
                            `${PLUGGY_API_URL}/accounts/${account.id}/bills`,
                            { headers: { 'X-API-KEY': token } }
                        );

                        if (billsResponse.ok) {
                            const billsData = await billsResponse.json();
                            account.bills = billsData.results || [];
                            console.log(`[Pluggy] Account ${account.id}: ${account.bills.length} bills (faturas)`);

                            // Log details of bills for debugging
                            if (account.bills.length > 0) {
                                account.bills.forEach((bill, idx) => {
                                    console.log(`[Pluggy] Bill ${idx + 1}: dueDate=${bill.dueDate}, totalAmount=${bill.totalAmount}, periodStart=${bill.periodStart}, periodEnd=${bill.periodEnd}, date=${bill.date}`);
                                });
                            }
                        }
                    } catch (error) {
                        console.warn(`[Pluggy] Failed to fetch bills for credit card ${account.id}:`, error.message);
                        account.bills = [];
                    }
                }

                return account;
            })
        );

        // 4. Keep compatibility field `connector` without losing per-account connector
        let connector = null;
        const firstAccountConnector = accountsWithTransactions.find(acc => acc?.connector)?.connector || null;

        if (firstAccountConnector && typeof firstAccountConnector === 'object') {
            connector = firstAccountConnector;
        }

        const connectorId =
            resolveConnectorId(firstAccountConnector) ||
            resolveConnectorId(item.connector);

        if ((!connector || !connector.imageUrl) && connectorId) {
            try {
                const connectorDetails = await fetchConnectorById(token, connectorId);
                if (connectorDetails) {
                    if (connector) {
                        connector = { ...connectorDetails, ...connector };
                        if (!connector.imageUrl && connectorDetails.imageUrl) {
                            connector.imageUrl = connectorDetails.imageUrl;
                        }
                    } else {
                        connector = connectorDetails;
                    }
                }
            } catch (_error) {
                console.warn('[Pluggy] Failed to fetch connector details');
            }
        }

        if (connector) {
            accountsWithTransactions.forEach((account) => {
                const accountConnectorId = resolveConnectorId(account.connector);
                const topConnectorId = resolveConnectorId(connector);

                if (!account.connector) {
                    account.connector = connector;
                    return;
                }

                if (typeof account.connector !== 'object' && accountConnectorId && topConnectorId && accountConnectorId.toString() === topConnectorId.toString()) {
                    account.connector = connector;
                    return;
                }

                if (typeof account.connector === 'object' && !account.connector.imageUrl && accountConnectorId && topConnectorId && accountConnectorId.toString() === topConnectorId.toString()) {
                    account.connector = {
                        ...connector,
                        ...account.connector,
                        imageUrl: account.connector.imageUrl || connector.imageUrl
                    };
                }
            });
        }

        res.json({
            success: true,
            item: item,
            connector: connector,
            accounts: accountsWithTransactions,
            syncedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('[Pluggy] Sync error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/pluggy/items/:id
 * Delete a connection item
 */
router.delete('/items/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getAccessToken();

        console.log(`[Pluggy] Deleting item ${id}`);

        const response = await fetch(`${PLUGGY_API_URL}/items/${id}`, {
            method: 'DELETE',
            headers: { 'X-API-KEY': token }
        });

        if (!response.ok) {
            throw new Error('Failed to delete item');
        }

        res.json({ success: true, message: 'Item deleted successfully' });
    } catch (error) {
        console.error('[Pluggy] Delete item error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/pluggy/update-item/:id
 * Trigger a refresh of item data
 */
router.post('/update-item/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getAccessToken();

        console.log(`[Pluggy] Updating item ${id}`);

        const response = await fetch(`${PLUGGY_API_URL}/items/${id}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': token
            },
            body: JSON.stringify({})
        });

        if (!response.ok) {
            throw new Error('Failed to update item');
        }

        const data = await response.json();
        res.json({ success: true, item: data });
    } catch (error) {
        console.error('[Pluggy] Update item error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
