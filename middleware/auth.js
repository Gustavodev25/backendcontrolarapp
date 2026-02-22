const admin = require('firebase-admin');

// Initialize Firebase Admin (Singleton)
let isInitialized = false;

try {
    const requiredVars = [
        'FIREBASE_PROJECT_ID',
        'FIREBASE_PRIVATE_KEY',
        'FIREBASE_CLIENT_EMAIL'
    ];

    const missingVars = requiredVars.filter(v => !process.env[v]);

    // 1. Try individual environment variables (Railway Manual Entry) - HIGHEST PRIORITY
    if (missingVars.length === 0) {
        const serviceAccount = {
            type: process.env.FIREBASE_TYPE || 'service_account',
            project_id: process.env.FIREBASE_PROJECT_ID,
            private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
            private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, ''),
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
            client_id: process.env.FIREBASE_CLIENT_ID,
            auth_uri: process.env.FIREBASE_AUTH_URI || 'https://accounts.google.com/o/oauth2/auth',
            token_uri: process.env.FIREBASE_TOKEN_URI || 'https://oauth2.googleapis.com/token',
            auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL || 'https://www.googleapis.com/oauth2/v1/certs',
            client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
            universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN || 'googleapis.com'
        };

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        isInitialized = true;
        console.log('[Auth] Firebase Admin initialized via individual env vars');
    }
    // 2. Try environment variable (Base64 JSON)
    else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(
            Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('ascii')
        );
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        isInitialized = true;
        console.log('[Auth] Firebase Admin initialized via Base64 env var');
    }
    // 3. Diagnostics / Fallback
    else {
        if (missingVars.length > 0 && missingVars.length < requiredVars.length) {
            console.warn('[Auth] Missing some Firebase vars:', missingVars.join(', '));
        }

        try {
            const serviceAccount = require('../serviceAccountKey.json');
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            isInitialized = true;
            console.log('[Auth] Firebase Admin initialized via local serviceAccountKey.json');
        } catch (ignored) {
            console.warn('[Auth] Firebase not configured (No JSON and missing env vars)');
        }
    }
} catch (e) {
    console.error('[Auth] Initialization error:', e.message);
}

const verifyAuth = async (req, res, next) => {
    // If not initialized, everything fails (Fail Secure)
    // Unless in explicit Development Bypass Mode (not recommended)
    if (!isInitialized) {
        if (process.env.NODE_ENV === 'development') {
            // console.warn('[Auth] WARNING: Bypassing auth check because Admin SDK is not configured (Dev Mode)');
            // return next(); // Uncomment to allow dev without auth (Insecure)
        }

        console.error('[Auth] Denying request: Firebase Admin not configured');
        return res.status(500).json({
            success: false,
            error: 'Erro de configuração do servidor (Auth)',
            details: 'Firebase Service Account not configured'
        });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'Token de autenticação não fornecido' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);

        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('[Auth] Verification failed:', error.code || error.message);

        if (error.code === 'auth/id-token-expired') {
            return res.status(403).json({ success: false, error: 'Token expirado', code: 'auth/token-expired' });
        }

        return res.status(403).json({ success: false, error: 'Acesso negado', code: 'auth/invalid-token' });
    }
};

module.exports = verifyAuth;
