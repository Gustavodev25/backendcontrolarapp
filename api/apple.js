const express = require('express');
const router = express.Router();
const { getFirebaseAdmin } = require('../lib/firebaseAdmin');

const PRO_PRODUCT_ID = 'com.gustavodev25.controlarapp.pro.monthly';

async function validateAppleReceipt(receiptData, useSandbox = false) {
    const url = useSandbox
        ? 'https://sandbox.itunes.apple.com/verifyReceipt'
        : 'https://buy.itunes.apple.com/verifyReceipt';

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            'receipt-data': receiptData,
            'password': process.env.APPLE_SHARED_SECRET,
            'exclude-old-transactions': true,
        }),
    });
    return response.json();
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

        // Status 21007 = sandbox receipt sent to production — retry with sandbox
        if (result.status === 21007) {
            result = await validateAppleReceipt(receiptData, true);
        }

        if (result.status !== 0) {
            console.error('[Apple IAP] Apple returned status:', result.status);
            return res.status(400).json({ hasPro: false, error: `Apple validation failed (status ${result.status})` });
        }

        const latestReceipts = result.latest_receipt_info || [];
        const now = Date.now();
        const activeSub = latestReceipts.find(r => {
            const expiry = parseInt(r.expires_date_ms, 10);
            return r.product_id === PRO_PRODUCT_ID && expiry > now;
        });

        const hasPro = !!activeSub;

        const admin = getFirebaseAdmin();
        const db = admin.firestore();
        const update = {
            'subscription.plan': hasPro ? 'pro' : 'free',
            'subscription.status': hasPro ? 'active' : 'inactive',
            'subscription.provider': 'apple',
            'subscription.updatedAt': admin.firestore.FieldValue.serverTimestamp(),
        };

        if (activeSub) {
            update['subscription.expiresAt'] = new Date(parseInt(activeSub.expires_date_ms, 10));
            update['subscription.productId'] = activeSub.product_id;
        }

        await db.collection('users').doc(firebaseUid).update(update);

        console.log(`[Apple IAP] validate-receipt: uid=${firebaseUid} hasPro=${hasPro}`);
        return res.json({ hasPro });
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

        const sub = doc.data()?.subscription;
        const hasPro =
            (sub?.plan === 'pro' || sub?.plan === 'premium') &&
            (sub?.status === 'active' || sub?.status === 'trialing');

        return res.json({ hasPro });
    } catch (e) {
        console.error('[Apple IAP] subscription-status error:', e);
        return res.status(500).json({ error: e.message });
    }
});

module.exports = router;
