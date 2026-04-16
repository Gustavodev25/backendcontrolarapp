/**
 * server/api/revenuecat.js
 * Webhook do RevenueCat → atualiza assinatura no Firebase
 *
 * Configure no dashboard RevenueCat:
 *   Integrations → Webhooks → URL: https://SEU_SERVIDOR/api/revenuecat/webhook
 *   Authorization Header: Bearer SEU_REVENUECAT_WEBHOOK_SECRET
 *
 * Defina no .env do servidor:
 *   REVENUECAT_WEBHOOK_SECRET=seu_secret_aqui
 */

const express = require('express');
const router = express.Router();
const { getFirebaseAdmin } = require('../lib/firebaseAdmin');

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

/** Converte timestamp em ms (RevenueCat) para Date */
function msToDate(ms) {
    return ms ? new Date(ms) : null;
}

/** Calcula a próxima data de cobrança a partir de expirationAtMs */
function formatNextBillingDate(ms) {
    const d = msToDate(ms);
    if (!d) return null;
    return d.toISOString().split('T')[0]; // "YYYY-MM-DD"
}

// ---------------------------------------------------------------------------
// Atualização do Firestore
// ---------------------------------------------------------------------------

async function updateSubscriptionInFirebase(userId, subscriptionData) {
    const admin = getFirebaseAdmin();
    const db = admin.firestore();

    const userRef = db.collection('users').doc(userId);

    await userRef.set(
        { subscription: subscriptionData },
        { merge: true }
    );

    console.log(`[RC Webhook] Firestore atualizado para usuário ${userId}:`, subscriptionData);
}

// ---------------------------------------------------------------------------
// Handlers por tipo de evento
// ---------------------------------------------------------------------------

async function handleInitialPurchase(event) {
    const userId = event.app_user_id;
    if (!userId) return;

    await updateSubscriptionInFirebase(userId, {
        plan: 'pro',
        status: 'active',
        billingCycle: 'monthly',
        price: 35.90,
        startedAt: msToDate(event.purchased_at_ms),
        expiresAt: msToDate(event.expiration_at_ms),
        nextBillingDate: formatNextBillingDate(event.expiration_at_ms),
        iapSource: 'apple',
        productId: event.product_id,
        rcOriginalAppUserId: event.original_app_user_id,
        cancelledAt: null,
    });
}

async function handleRenewal(event) {
    const userId = event.app_user_id;
    if (!userId) return;

    await updateSubscriptionInFirebase(userId, {
        plan: 'pro',
        status: 'active',
        billingCycle: 'monthly',
        price: 35.90,
        expiresAt: msToDate(event.expiration_at_ms),
        nextBillingDate: formatNextBillingDate(event.expiration_at_ms),
        iapSource: 'apple',
        productId: event.product_id,
        cancelledAt: null,
    });
}

async function handleCancellation(event) {
    const userId = event.app_user_id;
    if (!userId) return;

    await updateSubscriptionInFirebase(userId, {
        plan: 'pro',
        status: 'cancelled',
        cancelledAt: msToDate(event.cancel_reason ? Date.now() : event.purchased_at_ms),
        expiresAt: msToDate(event.expiration_at_ms),
        iapSource: 'apple',
    });
}

async function handleExpiration(event) {
    const userId = event.app_user_id;
    if (!userId) return;

    await updateSubscriptionInFirebase(userId, {
        plan: 'free',
        status: 'expired',
        expiresAt: msToDate(event.expiration_at_ms),
        iapSource: 'apple',
    });
}

async function handleBillingIssue(event) {
    const userId = event.app_user_id;
    if (!userId) return;

    await updateSubscriptionInFirebase(userId, {
        plan: 'pro',
        status: 'past_due',
        iapSource: 'apple',
    });
}

async function handleUncancellation(event) {
    const userId = event.app_user_id;
    if (!userId) return;

    await updateSubscriptionInFirebase(userId, {
        plan: 'pro',
        status: 'active',
        cancelledAt: null,
        expiresAt: msToDate(event.expiration_at_ms),
        nextBillingDate: formatNextBillingDate(event.expiration_at_ms),
        iapSource: 'apple',
    });
}

// ---------------------------------------------------------------------------
// Verificação de autenticidade do webhook
// ---------------------------------------------------------------------------

function verifyWebhookSecret(req) {
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    if (!secret) return true; // Sem secret configurado, aceita (dev)

    const authHeader = req.headers['authorization'] || '';
    return authHeader === `Bearer ${secret}`;
}

// ---------------------------------------------------------------------------
// Rota do Webhook
// ---------------------------------------------------------------------------

router.post('/webhook', async (req, res) => {
    // 1. Verifica autenticidade
    if (!verifyWebhookSecret(req)) {
        console.warn('[RC Webhook] Requisição rejeitada: secret inválido');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { event } = req.body;

    if (!event) {
        return res.status(400).json({ error: 'Missing event' });
    }

    console.log(`[RC Webhook] Evento recebido: ${event.type} | User: ${event.app_user_id}`);

    try {
        switch (event.type) {
            case 'INITIAL_PURCHASE':
                await handleInitialPurchase(event);
                break;

            case 'RENEWAL':
                await handleRenewal(event);
                break;

            case 'CANCELLATION':
                await handleCancellation(event);
                break;

            case 'EXPIRATION':
                await handleExpiration(event);
                break;

            case 'BILLING_ISSUE':
            case 'BILLING_ISSUE_DETECTED_WITHOUT_GRACE_PERIOD':
                await handleBillingIssue(event);
                break;

            case 'UNCANCELLATION':
                await handleUncancellation(event);
                break;

            case 'PRODUCT_CHANGE':
            case 'TRANSFER':
                console.log(`[RC Webhook] Evento ${event.type} recebido (sem ação)`);
                break;

            default:
                console.log(`[RC Webhook] Evento não tratado: ${event.type}`);
        }

        res.json({ received: true });
    } catch (error) {
        console.error('[RC Webhook] Erro ao processar evento:', error);
        // Retorna 200 para o RevenueCat não retentar infinitamente
        res.json({ received: true, warning: 'Processing error logged' });
    }
});

// ---------------------------------------------------------------------------
// Rota de teste (só em desenvolvimento)
// ---------------------------------------------------------------------------

router.post('/test-event', async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ error: 'Not found' });
    }

    const { userId, eventType } = req.body;

    if (!userId || !eventType) {
        return res.status(400).json({ error: 'userId e eventType são obrigatórios' });
    }

    const now = Date.now();
    const nextMonth = now + 30 * 24 * 60 * 60 * 1000;

    const mockEvent = {
        type: eventType,
        app_user_id: userId,
        original_app_user_id: userId,
        product_id: 'pro_monthly',
        purchased_at_ms: now,
        expiration_at_ms: nextMonth,
        store: 'APP_STORE',
        environment: 'SANDBOX',
        entitlement_ids: ['pro'],
    };

    try {
        switch (eventType) {
            case 'INITIAL_PURCHASE': await handleInitialPurchase(mockEvent); break;
            case 'RENEWAL': await handleRenewal(mockEvent); break;
            case 'CANCELLATION': await handleCancellation(mockEvent); break;
            case 'EXPIRATION': await handleExpiration(mockEvent); break;
            case 'BILLING_ISSUE': await handleBillingIssue(mockEvent); break;
            case 'UNCANCELLATION': await handleUncancellation(mockEvent); break;
            default:
                return res.status(400).json({ error: `Tipo desconhecido: ${eventType}` });
        }

        res.json({ success: true, message: `Evento ${eventType} simulado para ${userId}` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
