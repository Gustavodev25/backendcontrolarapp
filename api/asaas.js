const express = require('express');
const axios = require('axios');
const router = express.Router();
const verifyAuth = require('../middleware/auth');
const validate = require('../middleware/validate');
const { z } = require('zod');

const paymentSchema = z.object({
    customerInfo: z.object({
        name: z.string(),
        email: z.string().email(),
        cpfCnpj: z.string(),
        phone: z.string(),
        postalCode: z.string().optional(),
        addressNumber: z.string().optional()
    }),
    creditCard: z.object({
        holderName: z.string(),
        number: z.string(),
        expiryMonth: z.string(),
        expiryYear: z.string(),
        ccv: z.string()
    }),
    planValue: z.number().optional(),
    remoteIp: z.string().optional()
});


const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_API_URL = process.env.ASAAS_API_URL || 'https://sandbox.asaas.com/api/v3';

const asaas = axios.create({
    baseURL: ASAAS_API_URL,
    headers: {
        'access_token': ASAAS_API_KEY,
        'Content-Type': 'application/json'
    }
});

// Helper: Get or Create Customer
async function getOrCreateCustomer(customerData) {
    try {
        // Search by CPF/CNPJ
        const { cpfCnpj, email, name, mobilePhone } = customerData;
        const searchResponse = await asaas.get(`/customers?cpfCnpj=${cpfCnpj}`);

        if (searchResponse.data.data && searchResponse.data.data.length > 0) {
            return searchResponse.data.data[0].id; // Return existing customer ID
        }

        // Create new customer
        const createResponse = await asaas.post('/customers', {
            name,
            email,
            cpfCnpj,
            mobilePhone
        });

        return createResponse.data.id;
    } catch (error) {
        console.error('Error finding/creating customer:', error.response?.data || error.message);
        throw new Error('Falha ao registrar cliente no sistema de pagamento.');
    }
}

// Protected route: User must be authenticated to process payment
router.post('/process-payment', verifyAuth, validate(paymentSchema), async (req, res) => {
    try {
        const {
            customerInfo, // { name, email, cpfCnpj, phone, postalCode, addressNumber }
            creditCard, // { holderName, number, expiryMonth, expiryYear, ccv }
            planValue,
            remoteIp
        } = req.body;

        console.log('Processing payment for:', customerInfo.email);

        // 1. Get/Create Customer
        const customerId = await getOrCreateCustomer({
            name: customerInfo.name,
            email: customerInfo.email,
            cpfCnpj: customerInfo.cpfCnpj,
            mobilePhone: customerInfo.phone
        });

        // 2. Create Subscription
        // Note: Asaas requires creditCardHolderInfo matching the card holder
        const subscriptionData = {
            customer: customerId,
            billingType: 'CREDIT_CARD',
            value: planValue || 35.90,
            nextDueDate: new Date().toISOString().split('T')[0], // Today
            cycle: 'MONTHLY',
            description: 'Assinatura Controlar+ Pro',
            creditCard: {
                holderName: creditCard.holderName,
                number: creditCard.number,
                expiryMonth: creditCard.expiryMonth,
                expiryYear: creditCard.expiryYear,
                ccv: creditCard.ccv
            },
            creditCardHolderInfo: {
                name: customerInfo.name,
                email: customerInfo.email,
                cpfCnpj: customerInfo.cpfCnpj,
                postalCode: customerInfo.postalCode || '00000-000', // Default if missing
                addressNumber: customerInfo.addressNumber || '0',
                phone: customerInfo.phone
            },
            remoteIp: remoteIp
        };

        const response = await asaas.post('/subscriptions', subscriptionData);

        res.json({
            success: true,
            subscriptionId: response.data.id,
            status: response.data.status
        });

    } catch (error) {
        console.error('Payment Error:', error.response?.data || error.message);
        res.status(400).json({
            success: false,
            error: error.response?.data?.errors?.[0]?.description || 'Erro ao processar pagamento.'
        });
    }
});

// Public Webhook (TODO: Add signature verification)
router.post('/webhook', (req, res) => {
    // Log webhook events (e.g., PAYMENT_CONFIRMED, PAYMENT_RECEIVED)
    console.log('Asaas Webhook Received:', JSON.stringify(req.body, null, 2));

    // Here you would check the event type and update the user's subscription status in your database
    if (req.body.event === 'PAYMENT_RECEIVED' || req.body.event === 'PAYMENT_CONFIRMED') {
        // TODO: Update user subscription in Firebase
        console.log('Payment confirmed/received for subscription:', req.body.payment.subscription);
    }

    res.json({ received: true });
});

module.exports = router;
