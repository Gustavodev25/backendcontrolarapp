/**
 * server/api/stripe.js
 * Stripe integration for mobile subscriptions (Apple Pay + Card)
 *
 * Endpoints:
 *   POST /api/stripe/create-checkout       → Cria Payment Intent para assinatura
 *   POST /api/stripe/create-subscription   → Cria assinatura com Payment Method
 *   POST /api/stripe/webhook               → Webhook do Stripe (signature verified)
 *   GET  /api/stripe/subscription-status   → Consulta status da assinatura
 *   POST /api/stripe/cancel-subscription   → Cancela assinatura
 *   POST /api/stripe/restore-purchase      → Busca compra anterior pelo email
 *
 * Variáveis de ambiente necessárias:
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET
 *   STRIPE_PRO_MONTHLY_PRICE_ID
 */

const express = require('express');
const router = express.Router();
const { getFirebaseAdmin } = require('../lib/firebaseAdmin');

// ---------------------------------------------------------------------------
// Stripe Init (lazy — prevents module load failure when env var is missing)
// ---------------------------------------------------------------------------

let _stripe = null;
function getStripe() {
    if (!_stripe) {
        if (!process.env.STRIPE_SECRET_KEY) {
            throw new Error('STRIPE_SECRET_KEY não configurado nas variáveis de ambiente do servidor');
        }
        _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    }
    return _stripe;
}
const stripe = new Proxy({}, {
    get(_, prop) {
        return getStripe()[prop];
    }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function updateSubscriptionInFirebase(userId, subscriptionData) {
    const admin = getFirebaseAdmin();
    const db = admin.firestore();
    const userRef = db.collection('users').doc(userId);

    await userRef.set(
        { subscription: subscriptionData },
        { merge: true }
    );

    console.log(`[Stripe] Firestore atualizado para usuário ${userId}:`, subscriptionData);
}

/**
 * Busca o Firebase UID a partir do Stripe customer metadata ou email
 */
async function resolveFirebaseUid(customerId) {
    try {
        const customer = await stripe.customers.retrieve(customerId);
        if (customer.deleted) return null;

        // Primeiro tenta metadata
        if (customer.metadata?.firebaseUid) {
            return customer.metadata.firebaseUid;
        }

        // Fallback: busca por email no Firebase Auth
        if (customer.email) {
            const admin = getFirebaseAdmin();
            try {
                const userRecord = await admin.auth().getUserByEmail(customer.email);
                return userRecord.uid;
            } catch {
                // Usuário não encontrado no Firebase Auth
            }
        }

        return null;
    } catch (error) {
        console.error('[Stripe] Erro ao resolver UID:', error.message);
        return null;
    }
}

/**
 * Busca ou cria um Stripe Customer para o Firebase user
 */
async function getOrCreateStripeCustomer(firebaseUid, email, name) {
    // Busca customer existente por metadata
    const existing = await stripe.customers.list({
        limit: 1,
        email: email,
    });

    if (existing.data.length > 0) {
        const customer = existing.data[0];
        // Garante que metadata contém o UID
        if (!customer.metadata?.firebaseUid) {
            await stripe.customers.update(customer.id, {
                metadata: { firebaseUid },
            });
        }
        return customer;
    }

    // Cria novo customer
    return await stripe.customers.create({
        email,
        name: name || undefined,
        metadata: { firebaseUid },
    });
}

// ---------------------------------------------------------------------------
// POST /validate-coupon
// Valida um cupom ou código promocional do Stripe
// Body: { code }
// ---------------------------------------------------------------------------

router.post('/validate-coupon', async (req, res) => {
    try {
        const { code } = req.body;

        if (!code || typeof code !== 'string') {
            return res.status(400).json({ error: 'Código inválido' });
        }

        const normalizedCode = code.trim().toUpperCase();

        // Tenta como promotion code (código visível ao usuário, ex: "DESCONTO20")
        const promoCodes = await stripe.promotionCodes.list({
            code: normalizedCode,
            active: true,
            limit: 1,
        });

        if (promoCodes.data.length > 0) {
            const promo = promoCodes.data[0];
            const coupon = promo.coupon;

            if (!coupon.valid) {
                return res.status(400).json({ valid: false, error: 'Cupom expirado ou inválido' });
            }

            return res.json({
                valid: true,
                promotionCodeId: promo.id,
                couponId: coupon.id,
                percentOff: coupon.percent_off || null,
                amountOff: coupon.amount_off ? coupon.amount_off / 100 : null,
                currency: coupon.currency || null,
                name: coupon.name || normalizedCode,
            });
        }

        // Tenta como coupon ID direto
        try {
            const coupon = await stripe.coupons.retrieve(normalizedCode);
            if (!coupon.valid) {
                return res.status(400).json({ valid: false, error: 'Cupom expirado ou inválido' });
            }

            return res.json({
                valid: true,
                couponId: coupon.id,
                percentOff: coupon.percent_off || null,
                amountOff: coupon.amount_off ? coupon.amount_off / 100 : null,
                currency: coupon.currency || null,
                name: coupon.name || normalizedCode,
            });
        } catch {
            // Coupon não encontrado
        }

        return res.status(404).json({ valid: false, error: 'Cupom não encontrado' });
    } catch (error) {
        console.error('[Stripe] Erro ao validar cupom:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------------------------
// POST /create-subscription
// Cria uma assinatura Stripe com Payment Method (para Apple Pay / Card)
// Body: { firebaseUid, email, name?, paymentMethodId, promotionCodeId?, couponId? }
// ---------------------------------------------------------------------------

router.post('/create-subscription', async (req, res) => {
    try {
        const { firebaseUid, email, paymentMethodId: rawPaymentMethodId, name, promotionCodeId, couponId } = req.body;

        if (!firebaseUid || !email || !rawPaymentMethodId) {
            return res.status(400).json({
                error: 'firebaseUid, email e paymentMethodId são obrigatórios',
            });
        }

        const priceId = process.env.STRIPE_PRO_MONTHLY_PRICE_ID;
        if (!priceId) {
            return res.status(500).json({ error: 'STRIPE_PRO_MONTHLY_PRICE_ID não configurado' });
        }

        // 1. Busca ou cria customer
        const customer = await getOrCreateStripeCustomer(firebaseUid, email, name);

        // 2. Resolve o paymentMethodId
        //    Se o frontend enviou um setupIntentId (seti_xxx), extrai o PM dele
        let paymentMethodId = rawPaymentMethodId;

        if (paymentMethodId.startsWith('seti_')) {
            const setupIntent = await stripe.setupIntents.retrieve(paymentMethodId);
            if (!setupIntent.payment_method) {
                return res.status(400).json({ error: 'SetupIntent não possui payment method confirmado' });
            }
            paymentMethodId = setupIntent.payment_method;
            console.log(`[Stripe] Resolvido PM do SetupIntent: ${paymentMethodId}`);
        }

        // 3. Attach payment method ao customer
        try {
            await stripe.paymentMethods.attach(paymentMethodId, {
                customer: customer.id,
            });
        } catch (attachError) {
            // Já attached? Ignora
            if (attachError.code !== 'resource_already_exists') {
                throw attachError;
            }
        }

        // 3. Define como default payment method
        await stripe.customers.update(customer.id, {
            invoice_settings: {
                default_payment_method: paymentMethodId,
            },
        });

        // 4. Verifica se já tem assinatura ativa
        const existingSubs = await stripe.subscriptions.list({
            customer: customer.id,
            status: 'active',
            limit: 1,
        });

        if (existingSubs.data.length > 0) {
            return res.json({
                success: true,
                alreadyActive: true,
                subscriptionId: existingSubs.data[0].id,
                message: 'Assinatura já está ativa',
            });
        }

        // Cancela assinaturas incompletas anteriores para evitar duplicatas
        const incompleteSubs = await stripe.subscriptions.list({
            customer: customer.id,
            status: 'incomplete',
            limit: 5,
        });
        for (const sub of incompleteSubs.data) {
            await stripe.subscriptions.cancel(sub.id);
            console.log(`[Stripe] Assinatura incompleta cancelada: ${sub.id}`);
        }

        // 5. Cria a assinatura
        const subscriptionParams = {
            customer: customer.id,
            items: [{ price: priceId }],
            default_payment_method: paymentMethodId,
            payment_behavior: 'default_incomplete',
            payment_settings: {
                save_default_payment_method: 'on_subscription',
            },
            expand: ['latest_invoice.payment_intent'],
            metadata: { firebaseUid },
        };

        if (promotionCodeId) {
            subscriptionParams.discounts = [{ promotion_code: promotionCodeId }];
        } else if (couponId) {
            subscriptionParams.discounts = [{ coupon: couponId }];
        }

        const subscription = await stripe.subscriptions.create(subscriptionParams);

        const invoice = subscription.latest_invoice;
        const paymentIntent = invoice?.payment_intent;

        // Se a assinatura já está ativa (pagamento instantâneo com Apple Pay)
        if (subscription.status === 'active') {
            await updateSubscriptionInFirebase(firebaseUid, {
                plan: 'pro',
                status: 'active',
                billingCycle: 'monthly',
                price: 35.90,
                startedAt: new Date(subscription.start_date * 1000),
                expiresAt: new Date(subscription.current_period_end * 1000),
                nextBillingDate: new Date(subscription.current_period_end * 1000).toISOString().split('T')[0],
                iapSource: 'stripe_apple_pay',
                stripeCustomerId: customer.id,
                stripeSubscriptionId: subscription.id,
                cancelledAt: null,
            });

            return res.json({
                success: true,
                status: 'active',
                subscriptionId: subscription.id,
            });
        }

        // Se precisa de confirmação adicional (3D Secure, etc)
        if (paymentIntent) {
            return res.json({
                success: true,
                status: subscription.status,
                subscriptionId: subscription.id,
                clientSecret: paymentIntent.client_secret,
                requiresAction: paymentIntent.status === 'requires_action',
            });
        }

        return res.json({
            success: true,
            status: subscription.status,
            subscriptionId: subscription.id,
        });
    } catch (error) {
        console.error('[Stripe] Erro ao criar assinatura:', error);

        // Erro específico de cupom não aplicável ao cliente
        if (error.param === 'promotion_code' || error.param === 'coupon') {
            return res.status(400).json({
                error: 'Este cupom não pode ser usado nesta conta. Verifique as condições de uso do cupom.',
            });
        }

        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------------------------
// POST /create-payment-intent
// Cria um Payment Intent para pagamentos one-off ou Apple Pay setup
// Body: { firebaseUid, email, name? }
// ---------------------------------------------------------------------------

router.post('/create-payment-intent', async (req, res) => {
    try {
        const { firebaseUid, email, name } = req.body;

        if (!firebaseUid || !email) {
            return res.status(400).json({
                error: 'firebaseUid e email são obrigatórios',
            });
        }

        // Busca ou cria customer
        const customer = await getOrCreateStripeCustomer(firebaseUid, email, name);

        // Cria ephemeral key para o SDK mobile
        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer: customer.id },
            { apiVersion: '2024-06-20' }
        );

        // Cria setup intent para salvar payment method
        // automatic_payment_methods é necessário para Apple Pay aparecer no Payment Sheet
        const setupIntent = await stripe.setupIntents.create({
            customer: customer.id,
            automatic_payment_methods: { enabled: true },
            metadata: { firebaseUid },
        });

        res.json({
            success: true,
            setupIntentClientSecret: setupIntent.client_secret,
            ephemeralKey: ephemeralKey.secret,
            customerId: customer.id,
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
        });
    } catch (error) {
        console.error('[Stripe] Erro ao criar payment intent:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------------------------
// GET /subscription-status?firebaseUid=xxx
// ---------------------------------------------------------------------------

router.get('/subscription-status', async (req, res) => {
    try {
        const { firebaseUid } = req.query;

        if (!firebaseUid) {
            return res.status(400).json({ error: 'firebaseUid é obrigatório' });
        }

        // Busca no Firebase
        const admin = getFirebaseAdmin();
        const db = admin.firestore();
        const userDoc = await db.collection('users').doc(firebaseUid).get();
        const subscription = userDoc.data()?.subscription;

        if (!subscription || !subscription.stripeSubscriptionId) {
            return res.json({ hasSubscription: false, plan: 'free' });
        }

        // Verifica status atualizado no Stripe
        try {
            const stripeSub = await stripe.subscriptions.retrieve(
                subscription.stripeSubscriptionId
            );

            return res.json({
                hasSubscription: true,
                plan: 'pro',
                status: stripeSub.status,
                currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
                cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
            });
        } catch {
            // Subscription not found in Stripe
            return res.json({
                hasSubscription: true,
                plan: subscription.plan || 'free',
                status: subscription.status || 'unknown',
            });
        }
    } catch (error) {
        console.error('[Stripe] Erro ao buscar status:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------------------------
// POST /cancel-subscription
// Body: { firebaseUid }
// ---------------------------------------------------------------------------

router.post('/cancel-subscription', async (req, res) => {
    try {
        const { firebaseUid } = req.body;

        if (!firebaseUid) {
            return res.status(400).json({ error: 'firebaseUid é obrigatório' });
        }

        // Busca no Firebase
        const admin = getFirebaseAdmin();
        const db = admin.firestore();
        const userDoc = await db.collection('users').doc(firebaseUid).get();
        const subscription = userDoc.data()?.subscription;

        if (!subscription?.stripeSubscriptionId) {
            return res.status(404).json({ error: 'Nenhuma assinatura encontrada' });
        }

        // Cancela no final do período
        const cancelled = await stripe.subscriptions.update(
            subscription.stripeSubscriptionId,
            { cancel_at_period_end: true }
        );

        await updateSubscriptionInFirebase(firebaseUid, {
            plan: 'pro',
            status: 'cancelled',
            cancelledAt: new Date(),
            expiresAt: new Date(cancelled.current_period_end * 1000),
            iapSource: 'stripe_apple_pay',
        });

        res.json({ success: true, cancelAt: new Date(cancelled.current_period_end * 1000) });
    } catch (error) {
        console.error('[Stripe] Erro ao cancelar:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------------------------
// POST /restore-purchase
// Body: { firebaseUid, email }
// ---------------------------------------------------------------------------

router.post('/restore-purchase', async (req, res) => {
    try {
        const { firebaseUid, email } = req.body;

        if (!firebaseUid || !email) {
            return res.status(400).json({ error: 'firebaseUid e email são obrigatórios' });
        }

        // Busca customers com esse email
        const customers = await stripe.customers.list({ email, limit: 5 });

        for (const customer of customers.data) {
            const subs = await stripe.subscriptions.list({
                customer: customer.id,
                status: 'active',
                limit: 1,
            });

            if (subs.data.length > 0) {
                const sub = subs.data[0];

                // Atualiza metadata do customer
                await stripe.customers.update(customer.id, {
                    metadata: { firebaseUid },
                });

                // Salva no Firebase
                await updateSubscriptionInFirebase(firebaseUid, {
                    plan: 'pro',
                    status: 'active',
                    billingCycle: 'monthly',
                    price: 35.90,
                    startedAt: new Date(sub.start_date * 1000),
                    expiresAt: new Date(sub.current_period_end * 1000),
                    nextBillingDate: new Date(sub.current_period_end * 1000).toISOString().split('T')[0],
                    iapSource: 'stripe_apple_pay',
                    stripeCustomerId: customer.id,
                    stripeSubscriptionId: sub.id,
                    cancelledAt: null,
                });

                return res.json({
                    success: true,
                    hasPro: true,
                    message: 'Assinatura restaurada com sucesso',
                });
            }
        }

        return res.json({ success: true, hasPro: false, message: 'Nenhuma assinatura ativa encontrada' });
    } catch (error) {
        console.error('[Stripe] Erro ao restaurar:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------------------------
// POST /webhook
// Stripe Webhook — precisa de raw body para validar assinatura
// ---------------------------------------------------------------------------

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        if (webhookSecret && sig) {
            event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        } else {
            event = JSON.parse(req.body.toString());
            console.warn('[Stripe Webhook] Sem verificação de assinatura (dev mode)');
        }
    } catch (err) {
        console.error('[Stripe Webhook] Assinatura inválida:', err.message);
        return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    }

    console.log(`[Stripe Webhook] Evento: ${event.type}`);

    try {
        switch (event.type) {
            // Assinatura criada com sucesso
            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                const userId = await resolveFirebaseUid(subscription.customer);

                if (!userId) {
                    console.warn('[Stripe Webhook] UID não encontrado para customer:', subscription.customer);
                    break;
                }

                if (subscription.status === 'active') {
                    await updateSubscriptionInFirebase(userId, {
                        plan: 'pro',
                        status: 'active',
                        billingCycle: 'monthly',
                        price: 35.90,
                        startedAt: new Date(subscription.start_date * 1000),
                        expiresAt: new Date(subscription.current_period_end * 1000),
                        nextBillingDate: new Date(subscription.current_period_end * 1000).toISOString().split('T')[0],
                        iapSource: 'stripe_apple_pay',
                        stripeCustomerId: subscription.customer,
                        stripeSubscriptionId: subscription.id,
                        cancelledAt: subscription.cancel_at_period_end ? new Date() : null,
                    });
                } else if (subscription.status === 'past_due') {
                    await updateSubscriptionInFirebase(userId, {
                        plan: 'pro',
                        status: 'past_due',
                        iapSource: 'stripe_apple_pay',
                    });
                } else if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
                    await updateSubscriptionInFirebase(userId, {
                        plan: 'free',
                        status: 'expired',
                        iapSource: 'stripe_apple_pay',
                        cancelledAt: new Date(),
                    });
                }
                break;
            }

            // Assinatura deletada
            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                const userId = await resolveFirebaseUid(subscription.customer);

                if (userId) {
                    await updateSubscriptionInFirebase(userId, {
                        plan: 'free',
                        status: 'expired',
                        cancelledAt: new Date(),
                        iapSource: 'stripe_apple_pay',
                    });
                }
                break;
            }

            // Pagamento bem-sucedido
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                if (invoice.subscription) {
                    const userId = await resolveFirebaseUid(invoice.customer);
                    if (userId) {
                        // Busca a subscription para pegar datas atualizadas
                        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
                        await updateSubscriptionInFirebase(userId, {
                            plan: 'pro',
                            status: 'active',
                            billingCycle: 'monthly',
                            price: 35.90,
                            expiresAt: new Date(sub.current_period_end * 1000),
                            nextBillingDate: new Date(sub.current_period_end * 1000).toISOString().split('T')[0],
                            iapSource: 'stripe_apple_pay',
                            stripeCustomerId: invoice.customer,
                            stripeSubscriptionId: invoice.subscription,
                            cancelledAt: null,
                        });
                    }
                }
                break;
            }

            // Falha no pagamento
            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                if (invoice.subscription) {
                    const userId = await resolveFirebaseUid(invoice.customer);
                    if (userId) {
                        await updateSubscriptionInFirebase(userId, {
                            plan: 'pro',
                            status: 'past_due',
                            iapSource: 'stripe_apple_pay',
                        });
                    }
                }
                break;
            }

            default:
                console.log(`[Stripe Webhook] Evento não tratado: ${event.type}`);
        }

        res.json({ received: true });
    } catch (error) {
        console.error('[Stripe Webhook] Erro ao processar evento:', error);
        // Retorna 200 para o Stripe não retentar infinitamente
        res.json({ received: true, warning: 'Processing error logged' });
    }
});

// ---------------------------------------------------------------------------
// GET /config
// Retorna publishable key para o frontend (seguro)
// ---------------------------------------------------------------------------

router.get('/config', (req, res) => {
    res.json({
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    });
});

module.exports = router;
