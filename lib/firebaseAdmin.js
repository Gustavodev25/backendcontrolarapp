const admin = require('firebase-admin');

let initialized = false;
let initError = null;

const parseServiceAccountFromEnv = () => {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) return null;

    const trimmed = raw.trim();
    if (!trimmed) return null;

    try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
        return JSON.parse(decoded);
    } catch {
        // Fallback for environments that provide raw JSON instead of base64.
        return JSON.parse(trimmed);
    }
};

const initializeFirebaseAdmin = () => {
    if (initialized || admin.apps.length > 0) {
        initialized = true;
        return admin;
    }

    try {
        const serviceAccount = parseServiceAccountFromEnv();
        if (serviceAccount) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            initialized = true;
            return admin;
        }

        if (
            process.env.FIREBASE_PROJECT_ID &&
            process.env.FIREBASE_PRIVATE_KEY &&
            process.env.FIREBASE_CLIENT_EMAIL
        ) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL
                })
            });
            initialized = true;
            return admin;
        }

        if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            admin.initializeApp();
            initialized = true;
            return admin;
        }

        try {
            // Optional local fallback for development.
            // eslint-disable-next-line global-require, import/no-dynamic-require
            const serviceAccountKey = require('../serviceAccountKey.json');
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccountKey)
            });
            initialized = true;
            return admin;
        } catch {
            initialized = false;
            initError = new Error('Firebase Service Account not configured');
            return admin;
        }
    } catch (error) {
        initialized = false;
        initError = error;
        return admin;
    }
};

const getFirebaseAdmin = () => {
    initializeFirebaseAdmin();
    if (!initialized || admin.apps.length === 0) {
        throw initError || new Error('Firebase Admin not initialized');
    }
    return admin;
};

const isFirebaseConfigured = () => {
    initializeFirebaseAdmin();
    return initialized && admin.apps.length > 0;
};

const getFirebaseInitStatus = () => {
    initializeFirebaseAdmin();
    return {
        configured: initialized && admin.apps.length > 0,
        error: initError ? initError.message : null
    };
};

initializeFirebaseAdmin();

module.exports = {
    initializeFirebaseAdmin,
    getFirebaseAdmin,
    isFirebaseConfigured,
    getFirebaseInitStatus
};
