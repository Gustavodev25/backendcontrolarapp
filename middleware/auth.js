const admin = require('firebase-admin');

// Initialize Firebase Admin (Singleton)
let isInitialized = false;

try {
    // 1. Try environment variable (Base64 JSON)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            const rawDecoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('ascii');
            const sanitized = rawDecoded.trim();

            console.log('[Auth] Attempting to parse FIREBASE_SERVICE_ACCOUNT. Length:', sanitized.length);
            // DO NOT log the whole raw string to avoid leaking secrets, just first/last chars
            console.log('[Auth] Raw content starts with:', sanitized.substring(0, 20), '...');

            const serviceAccount = JSON.parse(sanitized);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            isInitialized = true;
            console.log('[Auth] Firebase Admin initialized via FIREBASE_SERVICE_ACCOUNT');
        } catch (parseError) {
            console.error('[Auth] JSON Parse error for FIREBASE_SERVICE_ACCOUNT:', parseError.message);
            // Fallback: se falhar o parse do Base64, pode ser que a string não seja base64 (dev local por exemplo)
            throw parseError; // Re-throw to be caught by outer catch
        }
    }
    // 1.5 Try individual environment variables (Railway/Manual config)
    else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL
            })
        });
        isInitialized = true;
        console.log('[Auth] Firebase Admin initialized via individual env vars');
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
    console.log('[Auth] Verificando autenticação...');
    console.log('[Auth] Path:', req.path);
    console.log('[Auth] Method:', req.method);
    
    // If not initialized, everything fails (Fail Secure)
    // Unless in explicit Development Bypass Mode (not recommended)
    if (!isInitialized) {
        console.error('[Auth] Firebase Admin não inicializado!');
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
        console.log('[Auth] Authorization header presente:', !!authHeader);
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.warn('[Auth] Token não fornecido ou formato inválido');
            return res.status(401).json({ success: false, error: 'Token de autenticação não fornecido' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        console.log('[Auth] Token recebido (prefixo):', idToken.substring(0, 15) + '...');

        const decodedToken = await admin.auth().verifyIdToken(idToken);
        console.log('[Auth] ✅ Token validado para UID:', decodedToken.uid);

        req.user = decodedToken;
        next();
    } catch (error) {
        console.error('[Auth] ❌ Verification failed:', error.code || error.message);
        console.error('[Auth] Error details:', error);

        if (error.code === 'auth/id-token-expired') {
            return res.status(403).json({ success: false, error: 'Token expirado', code: 'auth/token-expired' });
        }

        return res.status(403).json({ success: false, error: 'Acesso negado', code: 'auth/invalid-token' });
    }
};

module.exports = verifyAuth;
