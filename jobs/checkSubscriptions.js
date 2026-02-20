const admin = require('firebase-admin');

// Initialize Firebase Admin
if (!admin.apps.length) {
    try {
        const serviceAccount = require('../serviceAccountKey.json');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } catch (e) {
        console.error('Failed to load serviceAccountKey.json. Make sure it exists in the server root.');
        process.exit(1);
    }
}

const db = admin.firestore();
const ACTIVE_STATUSES = new Set(['active', 'trial', 'trialing']);

const normalizeStatus = (status) => {
    const normalized = String(status || '').trim().toLowerCase();
    if (!normalized || normalized === '-') return '';
    if (normalized === 'canceled') return 'cancelled';
    if (normalized === 'trial_expired' || normalized === 'trial-expired') return 'expired';
    return normalized;
};

const normalizePlan = (plan) => {
    return String(plan || '').trim().toLowerCase();
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

const parseDateValue = (value) => {
    if (!value) return null;

    if (typeof value?.toDate === 'function') {
        const date = value.toDate();
        return Number.isNaN(date?.getTime?.()) ? null : date;
    }

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const asString = String(value).trim();
    if (!asString) return null;

    if (/^\d{2}\/\d{2}\/\d{4}$/.test(asString)) {
        const [dd, mm, yyyy] = asString.split('/').map(Number);
        const date = new Date(yyyy, mm - 1, dd);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(asString)) {
        const [yyyy, mm, dd] = asString.split('-').map(Number);
        const date = new Date(yyyy, mm - 1, dd);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const parsed = new Date(asString);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const scoreSubscription = (subscription) => {
    if (!subscription || typeof subscription !== 'object') return -1;

    let score = 0;
    if (String(subscription.plan || '').trim()) score += 4;
    if (String(subscription.status || '').trim()) score += 3;
    if (subscription.nextBillingDate || subscription.renewalDate || subscription.expiresAt) score += 3;
    if (subscription.updatedAt || subscription.lastUpdatedAt) score += 1;
    return score;
};

const mergeSubscriptions = (primary, fallback) => {
    const merged = {
        ...(fallback && typeof fallback === 'object' ? fallback : {}),
        ...(primary && typeof primary === 'object' ? primary : {}),
    };

    const normalizedPlan = normalizePlan(primary?.plan) || normalizePlan(fallback?.plan);
    const normalizedStatus = (
        normalizeStatus(primary?.status) ||
        normalizeStatus(fallback?.status) ||
        inferMissingStatus(primary, normalizedPlan) ||
        inferMissingStatus(fallback, normalizedPlan)
    );
    if (normalizedStatus) {
        merged.status = normalizedStatus;
    } else {
        delete merged.status;
    }

    if (!String(merged.plan || '').trim()) {
        merged.plan = String(primary?.plan || fallback?.plan || '').trim();
        if (!merged.plan) delete merged.plan;
    }

    return merged;
};

const resolveSubscription = (userData) => {
    const rootSub = userData?.subscription;
    const profileSub = userData?.profile?.subscription;

    if (!rootSub && !profileSub) return null;
    if (rootSub && !profileSub) return rootSub;
    if (!rootSub && profileSub) return profileSub;

    const rootScore = scoreSubscription(rootSub);
    const profileScore = scoreSubscription(profileSub);

    if (profileScore > rootScore) {
        return mergeSubscriptions(profileSub, rootSub);
    }

    if (rootScore > profileScore) {
        return mergeSubscriptions(rootSub, profileSub);
    }

    const rootUpdatedAt = parseDateValue(rootSub?.updatedAt || rootSub?.lastUpdatedAt)?.getTime() || 0;
    const profileUpdatedAt = parseDateValue(profileSub?.updatedAt || profileSub?.lastUpdatedAt)?.getTime() || 0;

    if (profileUpdatedAt > rootUpdatedAt) {
        return mergeSubscriptions(profileSub, rootSub);
    }

    return mergeSubscriptions(rootSub, profileSub);
};

const parseDueDate = (subscription) => {
    return (
        parseDateValue(subscription?.nextBillingDate) ||
        parseDateValue(subscription?.renewalDate) ||
        parseDateValue(subscription?.expiresAt) ||
        null
    );
};

/**
 * Daily Job to check plan due dates and emit reminders.
 * Safety: this job no longer auto-cancels active/trial users based only on due date,
 * because billing dates can be stale until gateway/webhook reconciliation.
 */
async function checkSubscriptions() {
    console.log(`[Job] Starting Daily Subscription Check at ${new Date().toISOString()}...`);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    try {
        const usersRef = db.collection('users');
        const snapshot = await usersRef.get();

        if (snapshot.empty) {
            console.log('[Job] No users found.');
            return;
        }

        let processedCount = 0;
        let warningCount = 0;
        let overdueCount = 0;

        for (const doc of snapshot.docs) {
            const userData = doc.data();
            const subscription = resolveSubscription(userData);
            const status = normalizeStatus(subscription?.status);

            if (!subscription || !ACTIVE_STATUSES.has(status)) {
                continue;
            }

            const dueDate = parseDueDate(subscription);
            if (!dueDate) {
                continue;
            }

            dueDate.setHours(0, 0, 0, 0);

            const diffTime = dueDate.getTime() - today.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            processedCount++;

            if (diffDays === 7) {
                console.log(`[Notification] User ${doc.id}: Plan expires in 7 days.`);
                warningCount++;
            } else if (diffDays === 3) {
                console.log(`[Notification] User ${doc.id}: Plan expires in 3 days.`);
                warningCount++;
            } else if (diffDays === 1) {
                console.log(`[CRITICAL] User ${doc.id}: Plan expires TOMORROW!`);
                warningCount++;
            } else if (diffDays === 0) {
                console.log(`[DUE DATE] User ${doc.id}: Plan expires TODAY!`);
                warningCount++;
            } else if (diffDays < 0) {
                overdueCount++;
                console.log(`[Overdue] User ${doc.id} is overdue by ${Math.abs(diffDays)} days (no auto-cancel by date).`);
            }
        }

        console.log(`[Job] Finished. Checked ${processedCount} active users.`);
        console.log(`[Stats] Warnings Sent: ${warningCount}, Overdue Active: ${overdueCount}`);
    } catch (error) {
        console.error('[Job] Error executing subscription check:', error);
    }
}

// Allow running directly via `node server/jobs/checkSubscriptions.js`
if (require.main === module) {
    checkSubscriptions()
        .then(() => {
            console.log('Done.');
            process.exit(0);
        })
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = checkSubscriptions;
