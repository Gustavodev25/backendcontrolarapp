const { getFirebaseAdmin, isFirebaseConfigured } = require('../lib/firebaseAdmin');

const verifyAuth = async (req, res, next) => {
    if (!isFirebaseConfigured()) {
        return res.status(500).json({
            success: false,
            error: 'Erro de configuração do servidor (Auth)',
            details: 'Firebase Service Account not configured'
        });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'Token de autenticação não fornecido'
            });
        }

        const idToken = authHeader.split('Bearer ')[1];
        const admin = getFirebaseAdmin();
        const decodedToken = await admin.auth().verifyIdToken(idToken);

        req.user = decodedToken;
        next();
    } catch (error) {
        if (error.code === 'auth/id-token-expired') {
            return res.status(403).json({
                success: false,
                error: 'Token expirado',
                code: 'auth/token-expired'
            });
        }

        return res.status(403).json({
            success: false,
            error: 'Acesso negado',
            code: 'auth/invalid-token'
        });
    }
};

module.exports = verifyAuth;
