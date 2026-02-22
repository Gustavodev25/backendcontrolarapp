const { z } = require('zod');

/**
 * Zod Validation Middleware
 * Validates req.body, req.query, and req.params against a schema
 */
const validate = (schema) => (req, res, next) => {
    try {
        // Resolve object schema shape for wrapper detection.
        const shape =
            schema.shape ||
            (typeof schema._def?.shape === 'function' ? schema._def.shape() : schema._def?.shape) ||
            {};

        // Check if this is a wrapper schema with body/query/params
        const hasBodyWrapper = 'body' in shape;
        const hasQueryWrapper = 'query' in shape;
        const hasParamsWrapper = 'params' in shape;
        const isWrapperSchema = hasBodyWrapper || hasQueryWrapper || hasParamsWrapper;

        if (isWrapperSchema) {
            // Schema already has body/query/params structure
            schema.parse({
                ...(hasBodyWrapper && { body: req.body }),
                ...(hasQueryWrapper && { query: req.query }),
                ...(hasParamsWrapper && { params: req.params })
            });
        } else {
            // Simple schema - validate against body directly
            schema.parse(req.body);
        }

        next();
    } catch (err) {
        if (err instanceof z.ZodError) {
            // Zod v4 uses `issues`; older code may still expose `errors`.
            const issues = Array.isArray(err.issues) ? err.issues : (Array.isArray(err.errors) ? err.errors : []);

            console.warn('[Validation] Invalid request:', req.path, JSON.stringify(issues));
            return res.status(400).json({
                success: false,
                error: 'Dados invalidos',
                details: issues.map((e) => ({
                    path: e.path.join('.'),
                    code: e.code,
                    message: e.message
                }))
            });
        }

        next(err);
    }
};

module.exports = validate;
