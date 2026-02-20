const admin = require('firebase-admin');

// Initialize Firebase Admin (Singleton)
let isInitialized = false;

try {
    // 1. Try environment variable (Base64 JSON)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(
            Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('ascii')
        );
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        isInitialized = true;
        console.log('[Auth] Firebase Admin initialized via env var');
    }
    // 2. Try default Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS path)
    else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp();
        isInitialized = true;
        console.log('[Auth] Firebase Admin initialized via GOOGLE_APPLICATION_CREDENTIALS');
    }
    // 3. Try to find 'serviceAccountKey.json' in server root (Dev convenience)
    else {
        try {
            const serviceAccount = require('../serviceAccountKey.json');
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            isInitialized = true;
            console.log('[Auth] Firebase Admin initialized via serviceAccountKey.json');
        } catch (ignored) {
            console.warn('[Auth] No serviceAccountKey.json found and no env vars set.');
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
