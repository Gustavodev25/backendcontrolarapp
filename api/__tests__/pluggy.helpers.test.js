/* global describe, expect, test */

const {
    isActionRequiredPluggyError,
    isRetryablePluggyError,
    normalizePluggyError,
} = require('../pluggy.helpers');

describe('pluggy helpers', () => {
    test('marks rate limit and server errors as retryable', () => {
        expect(isRetryablePluggyError(429, 'TOO_MANY_REQUESTS')).toBe(true);
        expect(isRetryablePluggyError(503, 'SERVICE_UNAVAILABLE')).toBe(true);
    });

    test('marks credential and MFA errors as action required', () => {
        expect(isActionRequiredPluggyError('INVALID_CREDENTIALS')).toBe(true);
        expect(isActionRequiredPluggyError('MFA_REQUIRED')).toBe(true);
    });

    test('normalizes details and retry metadata', () => {
        const result = normalizePluggyError({
            status: 409,
            payload: {
                codeDescription: 'ALREADY_UPDATING',
                details: [{ message: 'Item is already updating' }],
            },
            fallbackMessage: 'Fallback',
        });

        expect(result).toMatchObject({
            success: false,
            error: 'Item is already updating',
            errorCode: 'ALREADY_UPDATING',
            retryable: true,
            actionRequired: false,
        });
    });
});
