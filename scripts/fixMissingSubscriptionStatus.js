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

const normalizePlan = (plan) => String(plan || '').trim().toLowerCase();

const normalizeStatus = (status) => {
    const normalized = String(status || '').trim().toLowerCase();
    if (!normalized || normalized === '-') return '';
    if (normalized === 'canceled') return 'cancelled';
    return normalized;
};

const inferMissingStatus = (subscription, plan) => {
    if (!subscription || typeof subscription !== 'object') return '';
    if (subscription.cancelledAt || subscription.cancellationDate || subscription.cancelReason) {
        return 'cancelled';
    }
    if (plan === 'pro' || plan === 'premium') {
        return 'active';
    }
    return '';
};

const getSubscriptionPatch = (subscription, prefix) => {
    if (!subscription || typeof subscription !== 'object') return null;

    const plan = normalizePlan(subscription.plan);
    if (plan !== 'pro' && plan !== 'premium') return null;

    const currentStatus = normalizeStatus(subscription.status);
    if (currentStatus) return null;

    const inferredStatus = inferMissingStatus(subscription, plan);
    if (!inferredStatus) return null;

    return {
        updates: {
            [`${prefix}.status`]: inferredStatus,
            [`${prefix}.updatedAt`]: new Date().toISOString(),
        },
        fromStatus: String(subscription.status ?? '').trim() || '-',
        toStatus: inferredStatus,
        plan,
        prefix,
    };
};

async function run() {
    console.log(`[FixMissingSubscriptionStatus] Mode: ${APPLY_CHANGES ? 'APPLY' : 'DRY-RUN'}`);
    const snapshot = await db.collection('users').get();

    let scanned = 0;
    let affectedUsers = 0;
    let updatedDocs = 0;
    let updatedRoot = 0;
    let updatedProfile = 0;
    const samples = [];

    for (const docSnap of snapshot.docs) {
        scanned++;
        const data = docSnap.data() || {};
        const email = data.email || data.profile?.email || '';

        const rootPatch = getSubscriptionPatch(data.subscription, 'subscription');
        const profilePatch = getSubscriptionPatch(data.profile?.subscription, 'profile.subscription');

        if (!rootPatch && !profilePatch) continue;

        affectedUsers++;
        const updates = {
            ...(rootPatch?.updates || {}),
            ...(profilePatch?.updates || {}),
        };

        if (rootPatch) updatedRoot++;
        if (profilePatch) updatedProfile++;

        if (samples.length < 30) {
            samples.push({
                userId: docSnap.id,
                email,
                root: rootPatch ? `${rootPatch.fromStatus} -> ${rootPatch.toStatus}` : '-',
                profile: profilePatch ? `${profilePatch.fromStatus} -> ${profilePatch.toStatus}` : '-',
            });
        }

        if (APPLY_CHANGES) {
            await docSnap.ref.update(updates);
            updatedDocs++;
        }
    }

    console.log(`[FixMissingSubscriptionStatus] Scanned users: ${scanned}`);
    console.log(`[FixMissingSubscriptionStatus] Users with status fix: ${affectedUsers}`);
    console.log(`[FixMissingSubscriptionStatus] Root subscription fixes: ${updatedRoot}`);
    console.log(`[FixMissingSubscriptionStatus] Profile subscription fixes: ${updatedProfile}`);
    if (APPLY_CHANGES) {
        console.log(`[FixMissingSubscriptionStatus] Documents updated: ${updatedDocs}`);
    }

    if (samples.length > 0) {
        console.log('[FixMissingSubscriptionStatus] Sample affected users:');
        console.table(samples);
    }
}

run()
    .then(() => {
        console.log('[FixMissingSubscriptionStatus] Done.');
        process.exit(0);
    })
    .catch((error) => {
        console.error('[FixMissingSubscriptionStatus] Failed:', error);
        process.exit(1);
    });
