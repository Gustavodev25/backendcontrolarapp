const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Rate Limiter: max 100 requests per 15 min per IP
// Adjusted for mobile app usage patterns (many API calls on sync)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300, // Increased to 300 to allow bulk sync operations
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Muitas requisições. Aguarde 15 minutos.' }
});

// Helmet Configuration
const securityHeaders = helmet();

module.exports = {
    limiter,
    securityHeaders
};
