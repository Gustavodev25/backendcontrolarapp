const admin = require('firebase-admin');

if (!admin.apps.length) {
    try {
        const serviceAccount = require('../serviceAccountKey.json');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } catch (e) {
        console.error('Failed to load serviceAccountKey.json. Make sure it exists in server/.');
        process.exit(1);
    }
}

const db = admin.firestore();
const APPLY_CHANGES = process.argv.includes('--apply');
const FieldValue = admin.firestore.FieldValue;

const normalize = (value) => String(value || '').trim().toLowerCase();

const shouldReactivate = (subscription) => {
    if (!subscription || typeof subscription !== 'object') return false;
    const plan = normalize(subscription.plan);
    const status = normalize(subscription.status);
    const reason = normalize(subscription.cancelReason);

    const isProPlan = plan === 'pro' || plan === 'premium';
    return isProPlan && status === 'cancelled' && reason === 'auto_expired';
};

const buildPatch = (prefix) => {
    const nowIso = new Date().toISOString();
    return {
        [`${prefix}.status`]: 'active',
        [`${prefix}.updatedAt`]: nowIso,
        [`${prefix}.reactivatedAt`]: nowIso,
        [`${prefix}.cancelReason`]: FieldValue.delete(),
        [`${prefix}.cancelledAt`]: FieldValue.delete(),
    };
};

async function run() {
    console.log(`[ReactivateAutoExpired] Mode: ${APPLY_CHANGES ? 'APPLY' : 'DRY-RUN'}`);
    const snapshot = await db.collection('users').get();

    let scanned = 0;
    let affectedUsers = 0;
    let updatedDocs = 0;
    let rootReactivated = 0;
    let profileReactivated = 0;
    const samples = [];

    for (const docSnap of snapshot.docs) {
        scanned++;
        const data = docSnap.data() || {};
        const email = data.email || data.profile?.email || '';
        const updates = {};

        if (shouldReactivate(data.subscription)) {
            Object.assign(updates, buildPatch('subscription'));
            rootReactivated++;
        }

        if (shouldReactivate(data.profile?.subscription)) {
            Object.assign(updates, buildPatch('profile.subscription'));
            profileReactivated++;
        }

        if (Object.keys(updates).length === 0) continue;

        affectedUsers++;
        if (samples.length < 40) {
            samples.push({
                userId: docSnap.id,
                email,
                rootBefore: data.subscription?.status || '-',
                profileBefore: data.profile?.subscription?.status || '-',
                nextBilling: data.subscription?.nextBillingDate || data.profile?.subscription?.nextBillingDate || '-',
            });
        }

        if (APPLY_CHANGES) {
            await docSnap.ref.update(updates);
            updatedDocs++;
        }
    }

    console.log(`[ReactivateAutoExpired] Scanned users: ${scanned}`);
    console.log(`[ReactivateAutoExpired] Users to reactivate: ${affectedUsers}`);
    console.log(`[ReactivateAutoExpired] Root reactivations: ${rootReactivated}`);
    console.log(`[ReactivateAutoExpired] Profile reactivations: ${profileReactivated}`);
    if (APPLY_CHANGES) {
        console.log(`[ReactivateAutoExpired] Documents updated: ${updatedDocs}`);
    }

    if (samples.length > 0) {
        console.log('[ReactivateAutoExpired] Sample affected users:');
        console.table(samples);
    }
}

run()
    .then(() => {
        console.log('[ReactivateAutoExpired] Done.');
        process.exit(0);
    })
    .catch((error) => {
        console.error('[ReactivateAutoExpired] Failed:', error);
        process.exit(1);
    });
