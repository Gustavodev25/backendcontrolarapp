const express = require('express');
const router = express.Router();
const { getFirebaseAdmin } = require('../lib/firebaseAdmin');

const fetch = global.fetch || require('node-fetch');

const PRO_PRODUCT_ID = 'com.gustavodev25.controlarapp.pro.monthly';
const PRO_PRICE = 35.90;
const PRO_CURRENCY = 'BRL';
const APPLE_PRODUCTION_VERIFY_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_VERIFY_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';
const VALID_APPLE_RECEIPT_STATUSES = new Set([0, 21006]);
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trial', 'trialing']);

function parseAppleMillis(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function dateValueToMillis(value) {
    if (!value) return null;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (typeof value._seconds === 'number') return value._seconds * 1000;
    if (typeof value.seconds === 'number') return value.seconds * 1000;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
}

function getLatestProReceipt(receipts) {
    return receipts
        .filter((receipt) => receipt?.product_id === PRO_PRODUCT_ID)
        .sort((a, b) => {
            const bExpires = parseAppleMillis(b.expires_date_ms) || 0;
            const aExpires = parseAppleMillis(a.expires_date_ms) || 0;
            if (bExpires !== aExpires) return bExpires - aExpires;

            const bPurchase = parseAppleMillis(b.purchase_date_ms) || 0;
            const aPurchase = parseAppleMillis(a.purchase_date_ms) || 0;
            return bPurchase - aPurchase;
        })[0] || null;
}

function getRenewalInfo(result, receipt) {
    const renewalItems = Array.isArray(result.pending_renewal_info)
        ? result.pending_renewal_info
        : [];

    return renewalItems.find((item) =>
        item?.product_id === PRO_PRODUCT_ID &&
        (!receipt?.original_transaction_id || item.original_transaction_id === receipt.original_transaction_id)
    ) || null;
}

async function validateAppleReceipt(receiptData, useSandbox = false) {
    const response = await fetch(useSandbox ? APPLE_SANDBOX_VERIFY_URL : APPLE_PRODUCTION_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            'receipt-data': receiptData,
            'password': process.env.APPLE_SHARED_SECRET,
            'exclude-old-transactions': true,
        }),
    });

    if (!response.ok) {
        throw new Error(`Apple verifyReceipt HTTP ${response.status}`);
    }

    return response.json();
}

function mirrorSubscriptionField(update, field, value) {
    if (value === undefined) return;
    update[`subscription.${field}`] = value;
    update[`profile.subscription.${field}`] = value;
}

function mirrorPaymentField(update, field, value) {
    if (value === undefined) return;
    update[`paymentMethod.${field}`] = value;
    update[`profile.paymentMethod.${field}`] = value;
}

async function persistAppleSubscription({ firebaseUid, result, latestReceipt, renewalInfo, requestBody }) {
    const admin = getFirebaseAdmin();
    const db = admin.firestore();
    const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
    const userRef = db.collection('users').doc(firebaseUid);

    const now = Date.now();
    const expiresMs = parseAppleMillis(latestReceipt.expires_date_ms);
    const purchaseMs = parseAppleMillis(latestReceipt.purchase_date_ms);
    const startedMs =
        parseAppleMillis(latestReceipt.original_purchase_date_ms) ||
        purchaseMs ||
        now;
    const cancellationMs = parseAppleMillis(latestReceipt.cancellation_date_ms);
    const hasPro = !!expiresMs && expiresMs > now && !cancellationMs;
    const willRenew = renewalInfo?.auto_renew_status === '1';
    const transactionId = requestBody.transactionId || latestReceipt.transaction_id || null;
    const originalTransactionId =
        requestBody.originalTransactionId ||
        latestReceipt.original_transaction_id ||
        null;

    const status = hasPro
        ? 'active'
        : cancellationMs
            ? 'cancelled'
            : 'expired';

    const update = {};
    mirrorSubscriptionField(update, 'plan', 'pro');
    mirrorSubscriptionField(update, 'status', status);
    mirrorSubscriptionField(update, 'provider', 'apple');
    mirrorSubscriptionField(update, 'paymentProvider', 'apple');
    mirrorSubscriptionField(update, 'iapSource', 'app_store');
    mirrorSubscriptionField(update, 'productId', PRO_PRODUCT_ID);
    mirrorSubscriptionField(update, 'billingCycle', 'monthly');
    mirrorSubscriptionField(update, 'price', PRO_PRICE);
    mirrorSubscriptionField(update, 'currency', PRO_CURRENCY);
    mirrorSubscriptionField(update, 'updatedAt', serverTimestamp);
    mirrorSubscriptionField(update, 'storeEnvironment', result.environment || null);
    mirrorSubscriptionField(update, 'transactionId', transactionId);
    mirrorSubscriptionField(update, 'originalTransactionId', originalTransactionId);
    mirrorSubscriptionField(update, 'appleTransactionId', latestReceipt.transaction_id || null);
    mirrorSubscriptionField(update, 'appleOriginalTransactionId', latestReceipt.original_transaction_id || null);
    mirrorSubscriptionField(update, 'autoRenewStatus', willRenew ? 'enabled' : 'disabled');
    mirrorSubscriptionField(update, 'cancelAtPeriodEnd', hasPro && !willRenew);
    mirrorSubscriptionField(update, 'startedAt', new Date(startedMs));
    if (expiresMs) {
        const expiresAt = new Date(expiresMs);
        mirrorSubscriptionField(update, 'expiresAt', expiresAt);
        mirrorSubscriptionField(update, 'nextBillingDate', expiresAt);
        mirrorSubscriptionField(update, 'renewalDate', expiresAt);
    }
    if (cancellationMs) {
        mirrorSubscriptionField(update, 'cancelledAt', new Date(cancellationMs));
    }

    mirrorPaymentField(update, 'type', 'app_store');
    mirrorPaymentField(update, 'brand', 'App Store');
    mirrorPaymentField(update, 'provider', 'apple');
    mirrorPaymentField(update, 'updatedAt', serverTimestamp);

    await userRef.set(update, { merge: true });

    if (hasPro && transactionId) {
        await userRef.collection('payments').doc(`apple_${transactionId}`).set({
            id: `apple_${transactionId}`,
            provider: 'apple',
            paymentMethod: { type: 'app_store', brand: 'App Store' },
            productId: PRO_PRODUCT_ID,
            transactionId,
            originalTransactionId,
            amount: PRO_PRICE,
            currency: PRO_CURRENCY,
            status: 'paid',
            createdAt: purchaseMs ? new Date(purchaseMs) : serverTimestamp,
            paidAt: purchaseMs ? new Date(purchaseMs) : serverTimestamp,
            expiresAt: expiresMs ? new Date(expiresMs) : null,
            updatedAt: serverTimestamp,
        }, { merge: true });
    }

    return { hasPro, status, expiresMs };
}

router.post('/validate-receipt', async (req, res) => {
    const { firebaseUid, receiptData } = req.body;

    if (!firebaseUid || !receiptData) {
        return res.status(400).json({ error: 'Missing firebaseUid or receiptData' });
    }

    if (!process.env.APPLE_SHARED_SECRET) {
        console.error('[Apple IAP] APPLE_SHARED_SECRET not configured');
        return res.status(500).json({ error: 'Apple IAP not configured on server' });
    }

    try {
        let result = await validateAppleReceipt(receiptData, false);

        // 21007 = sandbox receipt sent to production. App Review also uses sandbox.
        if (result.status === 21007) {
            result = await validateAppleReceipt(receiptData, true);
        }

        if (!VALID_APPLE_RECEIPT_STATUSES.has(result.status)) {
            console.error('[Apple IAP] Apple returned status:', result.status);
            return res.status(400).json({
                hasPro: false,
                error: `Apple validation failed (status ${result.status})`,
            });
        }

        const latestReceipts = Array.isArray(result.latest_receipt_info)
            ? result.latest_receipt_info
            : [];
        const latestReceipt = getLatestProReceipt(latestReceipts);

        if (!latestReceipt) {
            console.warn(`[Apple IAP] No ${PRO_PRODUCT_ID} transaction found for uid=${firebaseUid}`);
            return res.json({ hasPro: false, status: 'not_found' });
        }

        const renewalInfo = getRenewalInfo(result, latestReceipt);
        const persisted = await persistAppleSubscription({
            firebaseUid,
            result,
            latestReceipt,
            renewalInfo,
            requestBody: req.body,
        });

        console.log(`[Apple IAP] validate-receipt: uid=${firebaseUid} hasPro=${persisted.hasPro} status=${persisted.status}`);
        return res.json({
            hasPro: persisted.hasPro,
            status: persisted.status,
            productId: PRO_PRODUCT_ID,
            expiresAt: persisted.expiresMs ? new Date(persisted.expiresMs).toISOString() : null,
        });
    } catch (e) {
        console.error('[Apple IAP] validate-receipt error:', e);
        return res.status(500).json({ error: e.message });
    }
});

router.get('/subscription-status', async (req, res) => {
    const { firebaseUid } = req.query;
    if (!firebaseUid) return res.status(400).json({ error: 'Missing firebaseUid' });

    try {
        const admin = getFirebaseAdmin();
        const db = admin.firestore();
        const doc = await db.collection('users').doc(firebaseUid).get();
        if (!doc.exists) return res.json({ hasPro: false });

        const data = doc.data() || {};
        const sub = data.subscription || data.profile?.subscription;
        const plan = String(sub?.plan || '').trim().toLowerCase();
        const status = String(sub?.status || '').trim().toLowerCase();
        const provider = String(sub?.provider || sub?.paymentProvider || sub?.iapSource || '').trim().toLowerCase();
        const expiresMs = dateValueToMillis(sub?.expiresAt || sub?.renewalDate || sub?.nextBillingDate);

        let hasPro =
            (plan === 'pro' || plan === 'premium') &&
            ACTIVE_SUBSCRIPTION_STATUSES.has(status);

        if (hasPro && ['apple', 'app_store', 'storekit'].includes(provider) && expiresMs) {
            hasPro = expiresMs > Date.now();
        }

        return res.json({
            hasPro,
            status: status || 'inactive',
            provider: provider || null,
            expiresAt: expiresMs ? new Date(expiresMs).toISOString() : null,
        });
    } catch (e) {
        console.error('[Apple IAP] subscription-status error:', e);
        return res.status(500).json({ error: e.message });
    }
});

module.exports = router;
