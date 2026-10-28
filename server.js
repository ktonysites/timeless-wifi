/**
 * Timeless WiFi — Payment & HotSpot backend
 *
 *  Portal (login.html on the MikroTik)  ──POST /api/v1/pay──►  this server  ──STK Push──►  Safaricom Daraja
 *                                       ◄─GET /api/v1/status─┘      ▲                          │
 *                                                                    └──── /mpesa/callback ◄────┘
 *  MikroTik scheduler ──GET /api/v1/router/sync──► pulls paid vouchers, creates hotspot users, removes expired ones
 *
 *  Prices live in packages.js on the server — the browser only sends a package id.
 */

require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { getPackage, publicList, toRouterUptime, rateLimit, displayName } = require('./packages');

let RouterOSAPI = null;
try { ({ RouterOSAPI } = require('node-routeros')); } catch (_) { /* optional */ }

// ==========================================
// CONFIG
// ==========================================
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const bool = (k, d = false) => (process.env[k] === undefined ? d : env(k).toLowerCase() === 'true');

const MPESA_ENV = env('MPESA_ENV', 'sandbox').toLowerCase(); // sandbox | production | mock
const config = {
    port: Number(env('PORT', '5000')),
    isProd: env('NODE_ENV') === 'production',
    publicUrl: env('PUBLIC_URL').replace(/\/+$/, ''),
    brand: env('BRAND_NAME', 'Timeless WiFi'),
    supportPhone: env('SUPPORT_PHONE'),
    routerSecret: env('ROUTER_SECRET'),
    admin: { user: env('ADMIN_USERNAME'), pass: env('ADMIN_PASSWORD') },
    mpesa: {
        enabled: bool('MPESA_ENABLED'),
        env: MPESA_ENV,
        consumerKey: env('MPESA_CONSUMER_KEY'),
        consumerSecret: env('MPESA_CONSUMER_SECRET'),
        shortcode: env('MPESA_SHORTCODE'),            // BusinessShortCode (PayBill, or Store number for Till)
        partyB: env('MPESA_PARTY_B') || env('MPESA_TILL_NUMBER') || env('MPESA_SHORTCODE'),
        passkey: env('MPESA_PASSKEY'),
        callbackUrl: env('MPESA_CALLBACK_URL'),
        callbackSecret: env('MPESA_CALLBACK_SECRET'),
        transactionType: env('MPESA_TRANSACTION_TYPE', 'CustomerPayBillOnline'),
        accountRef: env('MPESA_ACCOUNT_REFERENCE', 'TimelessWiFi').slice(0, 12),
        baseUrl: MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke',
        mockDelayMs: Number(env('MOCK_DELAY_MS', '6000'))
    },
    mikrotik: {
        enabled: bool('MIKROTIK_ENABLED'),
        host: env('MIKROTIK_HOST'),
        port: Number(env('MIKROTIK_PORT', '8728')),
        user: env('MIKROTIK_USER', 'admin'),
        password: env('MIKROTIK_PASSWORD')
    }
};

// Callback URL Safaricom will hit. If a secret is set it becomes part of the path so random POSTs are ignored.
function callbackUrl() {
    let base = config.mpesa.callbackUrl || (config.publicUrl ? `${config.publicUrl}/api/v1/mpesa/callback` : '');
    if (base && config.mpesa.callbackSecret && !base.includes(config.mpesa.callbackSecret)) {
        base = `${base.replace(/\/+$/, '')}/${config.mpesa.callbackSecret}`;
    }
    return base;
}

function configProblems() {
    const p = [];
    const m = config.mpesa;
    if (!m.enabled) p.push('MPESA_ENABLED is not true — payments are switched off.');
    if (m.env !== 'mock') {
        for (const k of ['consumerKey', 'consumerSecret', 'shortcode', 'passkey']) if (!m[k]) p.push(`M-Pesa ${k} missing.`);
        const cb = callbackUrl();
        if (!/^https:\/\//.test(cb)) p.push('MPESA_CALLBACK_URL (or PUBLIC_URL) must be a public https:// URL.');
        if (/ngrok|trycloudflare/i.test(cb) && config.isProd) p.push('Callback URL is a temporary tunnel; it changes on restart.');
    }
    if (m.transactionType === 'CustomerBuyGoodsOnline' && m.partyB === m.shortcode)
        p.push('Till payments: set MPESA_TILL_NUMBER (PartyB) — MPESA_SHORTCODE should be the Store number.');
    if (!config.routerSecret) p.push('ROUTER_SECRET not set — router sync endpoints are locked.');
    if (!config.admin.user || !config.admin.pass) p.push('ADMIN_USERNAME / ADMIN_PASSWORD not set — dashboard disabled.');
    if (!supabase) p.push('Supabase not configured — transactions are kept in memory only and lost on restart.');
    return p;
}

// ==========================================
// STORAGE (Supabase with in-memory cache / fallback)
// ==========================================
const supabaseUrl = env('SUPABASE_URL');
const supabaseKey = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY');
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } }) : null;
const TABLE = env('SUPABASE_TABLE', 'transactions');
const mem = new Map();

const db = {
    async save(tx) {
        mem.set(tx.id, tx);
        if (supabase) {
            const { error } = await supabase.from(TABLE).insert(tx);
            if (error) console.error('❌ Supabase insert:', error.message);
        }
    },
    async update(id, updates) {
        updates.updated_at = new Date().toISOString();
        if (mem.has(id)) mem.set(id, { ...mem.get(id), ...updates });
        if (supabase) {
            const { error } = await supabase.from(TABLE).update(updates).eq('id', id);
            if (error) console.error('❌ Supabase update:', error.message);
        }
        return mem.get(id) || (await this.get(id));
    },
    async get(id) {
        if (mem.has(id)) return mem.get(id);
        if (!supabase) return null;
        const { data } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
        if (data) mem.set(id, data);
        return data || null;
    },
    async findOne(filter) {
        if (supabase) {
            let q = supabase.from(TABLE).select('*');
            for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
            const { data } = await q.order('created_at', { ascending: false }).limit(1);
            return data?.[0] || null;
        }
        return [...mem.values()].filter(t => Object.entries(filter).every(([k, v]) => t[k] === v))
            .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
    },
    async nextRouterJob() {
        const now = new Date().toISOString();
        if (supabase) {
            const add = await supabase.from(TABLE).select('*').eq('status', 'SUCCESS').eq('mikrotik_sync', 'PENDING')
                .order('created_at', { ascending: true }).limit(1);
            if (add.data?.[0]) return { action: 'ADD', tx: add.data[0] };
            const del = await supabase.from(TABLE).select('*').eq('status', 'SUCCESS').eq('mikrotik_sync', 'DONE')
                .lt('expires_at', now).order('expires_at', { ascending: true }).limit(1);
            if (del.data?.[0]) return { action: 'DEL', tx: del.data[0] };
            return null;
        }
        const all = [...mem.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
        const add = all.find(t => t.status === 'SUCCESS' && t.mikrotik_sync === 'PENDING');
        if (add) return { action: 'ADD', tx: add };
        const del = all.find(t => t.status === 'SUCCESS' && t.mikrotik_sync === 'DONE' && t.expires_at && t.expires_at < now);
        return del ? { action: 'DEL', tx: del } : null;
    },
    async list({ status, q, since, limit = 200 } = {}) {
        let rows;
        if (supabase) {
            let query = supabase.from(TABLE).select('*').order('created_at', { ascending: false }).limit(Math.min(limit, 1000));
            if (status) query = query.eq('status', status);
            if (since) query = query.gte('created_at', since);
            const { data, error } = await query;
            if (error) console.error('❌ Supabase list:', error.message);
            rows = data || [];
        } else {
            rows = [...mem.values()].filter(t => (!status || t.status === status) && (!since || t.created_at >= since))
                .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
        }
        if (q) {
            const s = q.toLowerCase();
            rows = rows.filter(t => [t.id, t.phone, t.receipt, t.username, t.mac].some(v => v && String(v).toLowerCase().includes(s)));
        }
        return rows;
    }
};

// ==========================================
// HELPERS
// ==========================================
function formatPhone(phone) {
    let p = String(phone || '').replace(/\D/g, '');
    if (p.startsWith('0')) p = `254${p.slice(1)}`;
    else if (p.length === 9) p = `254${p}`;
    return p;
}
const maskPhone = p => (p ? `${p.slice(0, 6)}***${p.slice(-3)}` : '');

/** Daraja wants YYYYMMDDHHmmss in Kenyan time (EAT, UTC+3). */
function darajaTimestamp(d = new Date()) {
    const eat = new Date(d.getTime() + 3 * 3600 * 1000);
    return eat.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
function voucherCode(len = 6) {
    const bytes = crypto.randomBytes(len);
    return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Tiny fixed-window rate limiter. Note: all hotspot users share the router's public IP,
// so limits are keyed on phone / device, with only a generous IP ceiling.
const buckets = new Map();
function limited(key, max, windowMs) {
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now > b.reset) { buckets.set(key, { n: 1, reset: now + windowMs }); return false; }
    b.n += 1;
    return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60_000).unref();

// ==========================================
// DARAJA (M-PESA)
// ==========================================
let tokenCache = { value: null, exp: 0 };
async function darajaToken() {
    if (tokenCache.value && Date.now() < tokenCache.exp - 120_000) return tokenCache.value;
    const basic = Buffer.from(`${config.mpesa.consumerKey}:${config.mpesa.consumerSecret}`).toString('base64');
    try {
        const r = await axios.get(`${config.mpesa.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
            headers: { Authorization: `Basic ${basic}` }, timeout: 10_000
        });
        tokenCache = { value: r.data.access_token, exp: Date.now() + Number(r.data.expires_in || 3599) * 1000 };
        return tokenCache.value;
    } catch (e) {
        console.error('❌ Daraja auth:', e?.response?.status, e?.response?.data || e.message);
        throw new Error('Could not authenticate with M-Pesa. Check consumer key/secret and MPESA_ENV.');
    }
}

function stkPassword(ts) {
    return Buffer.from(`${config.mpesa.shortcode}${config.mpesa.passkey}${ts}`).toString('base64');
}

async function stkPush({ phone, amount, pkg }) {
    if (config.mpesa.env === 'mock') return mock.push({ phone, amount });
    const token = await darajaToken();
    const ts = darajaTimestamp();
    const payload = {
        BusinessShortCode: config.mpesa.shortcode,
        Password: stkPassword(ts),
        Timestamp: ts,
        TransactionType: config.mpesa.transactionType,
        Amount: amount,
        PartyA: phone,
        PartyB: config.mpesa.partyB,
        PhoneNumber: phone,
        CallBackURL: callbackUrl(),
        AccountReference: config.mpesa.accountRef,
        TransactionDesc: `${pkg.tier === 'lite' ? 'Lite ' : ''}${pkg.name}`.slice(0, 13)
    };
    try {
        const r = await axios.post(`${config.mpesa.baseUrl}/mpesa/stkpush/v1/processrequest`, payload, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 15_000
        });
        if (String(r.data.ResponseCode) !== '0') throw new Error(r.data.ResponseDescription || 'M-Pesa rejected the request.');
        return { checkoutId: r.data.CheckoutRequestID, merchantId: r.data.MerchantRequestID };
    } catch (e) {
        const d = e?.response?.data;
        console.error('❌ STK push:', e?.response?.status, d || e.message);
        if (e?.response?.status === 401 || e?.response?.status === 404) tokenCache = { value: null, exp: 0 };
        throw new Error(d?.errorMessage || d?.ResponseDescription || e.message || 'M-Pesa is unreachable right now.');
    }
}

/** Ask Daraja directly — used when the callback is late or lost (e.g. the server was asleep). */
async function stkQuery(checkoutId) {
    if (config.mpesa.env === 'mock') return mock.query(checkoutId);
    const token = await darajaToken();
    const ts = darajaTimestamp();
    try {
        const r = await axios.post(`${config.mpesa.baseUrl}/mpesa/stkpushquery/v1/query`, {
            BusinessShortCode: config.mpesa.shortcode, Password: stkPassword(ts), Timestamp: ts, CheckoutRequestID: checkoutId
        }, { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 });
        return { resultCode: Number(r.data.ResultCode), resultDesc: r.data.ResultDesc };
    } catch (e) {
        const d = e?.response?.data;
        // "The transaction is being processed" comes back as an HTTP 500 with errorCode 500.001.1001
        if (d?.errorCode === '500.001.1001') return { pending: true };
        console.warn('⚠️ STK query:', d || e.message);
        return { pending: true };
    }
}

// Mock gateway: full flow without Safaricom. Phone numbers ending in 0000 simulate a cancelled prompt.
const mock = {
    pending: new Map(),
    push({ phone, amount }) {
        const checkoutId = `ws_CO_MOCK_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const cancel = phone.endsWith('0000');
        setTimeout(() => {
            const body = cancel
                ? { Body: { stkCallback: { CheckoutRequestID: checkoutId, ResultCode: 1032, ResultDesc: 'Request cancelled by user' } } }
                : { Body: { stkCallback: { CheckoutRequestID: checkoutId, ResultCode: 0, ResultDesc: 'The service request is processed successfully.',
                    CallbackMetadata: { Item: [
                        { Name: 'Amount', Value: amount },
                        { Name: 'MpesaReceiptNumber', Value: `MCK${voucherCode(7)}` },
                        { Name: 'TransactionDate', Value: Number(darajaTimestamp()) },
                        { Name: 'PhoneNumber', Value: Number(phone) }
                    ] } } } };
            handleCallback(body).catch(e => console.error('mock callback', e));
        }, config.mpesa.mockDelayMs).unref();
        return { checkoutId, merchantId: 'MOCK' };
    },
    query() { return { pending: true }; }
};

// ==========================================
// MIKROTIK (optional direct API — only when the router is reachable, e.g. over VPN)
// ==========================================
async function routerAddUser(tx) {
    if (!config.mikrotik.enabled || !config.mikrotik.host || !RouterOSAPI) return false;
    const pkg = getPackage(tx.package_id);
    const ros = new RouterOSAPI({
        host: config.mikrotik.host, port: config.mikrotik.port,
        user: config.mikrotik.user, password: config.mikrotik.password, timeout: 4
    });
    try {
        await ros.connect();
        // make sure the profile exists with the package's speed cap
        const prof = pkg?.profile || 'default', rl = rateLimit(pkg);
        if (prof !== 'default') {
            const pf = await ros.write('/ip/hotspot/user/profile/print', [`?name=${prof}`]);
            if (!pf.length) await ros.write('/ip/hotspot/user/profile/add', [`=name=${prof}`, '=shared-users=1', ...(rl ? [`=rate-limit=${rl}`] : [])]);
            else if (rl && pf[0]['rate-limit'] !== rl) await ros.write('/ip/hotspot/user/profile/set', [`=.id=${pf[0]['.id']}`, `=rate-limit=${rl}`]);
        }
        const existing = await ros.write('/ip/hotspot/user/print', [`?name=${tx.username}`]);
        const fields = [`=profile=${pkg?.profile || 'default'}`, `=limit-uptime=${toRouterUptime(pkg?.minutes || 60)}`,
            `=comment=TW ${tx.id} exp ${tx.expires_at}`];
        if (existing.length) await ros.write('/ip/hotspot/user/set', [`=.id=${existing[0]['.id']}`, `=password=${tx.password}`, ...fields]);
        else await ros.write('/ip/hotspot/user/add', [`=name=${tx.username}`, `=password=${tx.password}`, ...fields]);
        console.log(`✅ Router user ${tx.username} ready (direct API)`);
        return true;
    } catch (e) {
        console.warn(`⚠️ Direct router API failed (${e.message}); the router sync script will pick it up.`);
        return false;
    } finally {
        try { ros.close(); } catch (_) {}
    }
}

// ==========================================
// PAYMENT STATE MACHINE
// ==========================================
async function markPaid(tx, { receipt, paidAmount, source }) {
    if (tx.status === 'SUCCESS') {
        if (receipt && (!tx.receipt || tx.receipt === 'N/A')) await db.update(tx.id, { receipt });
        return db.get(tx.id);
    }
    const pkg = getPackage(tx.package_id);
    const now = new Date();
    const updated = await db.update(tx.id, {
        status: 'SUCCESS',
        receipt: receipt || null,
        paid_amount: paidAmount ?? tx.amount,
        paid_at: now.toISOString(),
        expires_at: new Date(now.getTime() + (pkg?.minutes || 60) * 60_000).toISOString(),
        reason: null,
        confirmed_by: source
    });
    console.log(`✅ Paid ${tx.amount} KES · ${maskPhone(tx.phone)} · ${tx.package_id} · ${receipt || 'no receipt yet'} (${source})`);
    if (tx.package_id === 'admin_test') return updated; // test payments never touch the router
    const direct = await routerAddUser(updated);
    if (direct) return db.update(tx.id, { mikrotik_sync: 'DONE' });
    return updated;
}

async function markFailed(tx, reason) {
    if (tx.status !== 'PENDING') return tx;
    console.log(`✖ Payment failed · ${maskPhone(tx.phone)} · ${reason}`);
    return db.update(tx.id, { status: 'FAILED', reason });
}

const FRIENDLY = {
    1: 'Insufficient M-Pesa balance.',
    1032: 'You cancelled the M-Pesa prompt.',
    1037: 'The M-Pesa prompt timed out. Make sure your phone is on and try again.',
    2001: 'Wrong M-Pesa PIN entered.',
    1001: 'Another M-Pesa transaction is in progress on your phone. Wait a moment and retry.',
    1019: 'The M-Pesa request expired. Please try again.'
};

async function handleCallback(body) {
    const cb = body?.Body?.stkCallback;
    if (!cb?.CheckoutRequestID) return;
    const tx = await db.get(cb.CheckoutRequestID);
    if (!tx) { console.warn(`⚠️ Callback for unknown checkout ${cb.CheckoutRequestID}`); return; }
    const code = Number(cb.ResultCode);
    if (code === 0) {
        const items = Object.fromEntries((cb.CallbackMetadata?.Item || []).map(i => [i.Name, i.Value]));
        const paidAmount = Number(items.Amount);
        if (Number.isFinite(paidAmount) && paidAmount < tx.amount) {
            await db.update(tx.id, { status: 'FAILED', reason: `Amount mismatch: paid ${paidAmount}, expected ${tx.amount}`, receipt: items.MpesaReceiptNumber });
            return;
        }
        await markPaid(tx, { receipt: items.MpesaReceiptNumber, paidAmount, source: 'callback' });
    } else {
        await markFailed(tx, FRIENDLY[code] || cb.ResultDesc || 'Payment was not completed.');
    }
}

// Reconcile a pending transaction with Daraja when the callback hasn't arrived.
const PENDING_GIVE_UP_MS = 4 * 60_000;
async function reconcile(tx) {
    if (tx.status !== 'PENDING') return tx;
    const age = Date.now() - new Date(tx.created_at).getTime();
    const sinceQuery = tx.last_query_at ? Date.now() - new Date(tx.last_query_at).getTime() : Infinity;
    if (age < 25_000 || sinceQuery < 12_000) return tx;
    await db.update(tx.id, { last_query_at: new Date().toISOString() });
    const r = await stkQuery(tx.id);
    if (r.pending) {
        if (age > PENDING_GIVE_UP_MS) return markFailed(tx, 'No confirmation from M-Pesa. If money left your account, use "Already paid" with your M-Pesa code.');
        return db.get(tx.id);
    }
    if (r.resultCode === 0) return markPaid(tx, { source: 'query' });
    return markFailed(tx, FRIENDLY[r.resultCode] || r.resultDesc || 'Payment was not completed.');
}

function credentials(tx) {
    const pkg = getPackage(tx.package_id);
    return { username: tx.username, password: tx.password, package: pkg ? displayName(pkg) : tx.package_id,
        expiresAt: tx.expires_at, receipt: tx.receipt || null };
}

// ==========================================
// APP
// ==========================================
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const origins = env('PORTAL_ORIGIN').split(',').map(s => s.trim()).filter(Boolean);
// Captive portals are served from the router's own address, so default to allowing any origin.
app.use('/api/v1', cors({ origin: origins.length ? origins : true }));
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

app.get('/', (req, res) => res.json({ ok: true, service: 'timeless-wifi-backend', portal: 'served by your MikroTik', admin: '/admin' }));
app.get('/health', (req, res) => res.json({
    ok: true, service: 'timeless-wifi-backend', mpesa: config.mpesa.enabled ? config.mpesa.env : 'disabled',
    storage: supabase ? 'supabase' : 'memory', uptime: Math.round(process.uptime())
}));

app.get('/api/v1/packages', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ success: true, brand: config.brand, supportPhone: config.supportPhone || null,
        paymentsEnabled: config.mpesa.enabled, packages: publicList() });
});

app.post('/api/v1/pay', async (req, res) => {
    try {
        if (!config.mpesa.enabled) return res.status(503).json({ success: false, message: 'M-Pesa payments are temporarily unavailable.' });
        const { phone, packageId, mac, ip } = req.body || {};
        const pkg = getPackage(packageId);
        if (!pkg) return res.status(400).json({ success: false, message: 'Please choose a valid package.' });
        const msisdn = formatPhone(phone);
        if (!/^254(7|1)\d{8}$/.test(msisdn)) return res.status(400).json({ success: false, message: 'Enter a valid Safaricom number, e.g. 0712 345 678.' });
        const device = String(mac || '').trim().slice(0, 80);
        if (device && !/^[A-Za-z0-9:.\-]{2,80}$/.test(device)) return res.status(400).json({ success: false, message: 'Invalid device identifier.' });

        if (limited(`phone:${msisdn}`, 3, 2 * 60_000)) return res.status(429).json({ success: false, message: 'Too many attempts for this number. Wait 2 minutes and try again.' });
        if (device && limited(`mac:${device}`, 5, 5 * 60_000)) return res.status(429).json({ success: false, message: 'Too many attempts from this device. Please wait a few minutes.' });
        if (limited(`ip:${req.ip}`, 120, 60_000)) return res.status(429).json({ success: false, message: 'The network is busy. Please try again shortly.' });

        const { checkoutId, merchantId } = await stkPush({ phone: msisdn, amount: pkg.price, pkg });
        const code = voucherCode();
        await db.save({
            id: checkoutId, merchant_request_id: merchantId, status: 'PENDING',
            phone: msisdn, mac: device || null, client_ip: String(ip || '').slice(0, 45) || null,
            package_id: pkg.id, amount: pkg.price,
            username: code, password: code,
            created_at: new Date().toISOString(), mikrotik_sync: 'PENDING'
        });
        console.log(`📤 STK sent · ${pkg.price} KES · ${maskPhone(msisdn)} · ${pkg.id}`);
        res.json({ success: true, transactionId: checkoutId, amount: pkg.price, package: displayName(pkg), speedMbps: pkg.speed || null });
    } catch (e) {
        res.status(502).json({ success: false, message: e.message || 'Payment service is currently unreachable.' });
    }
});

// Safaricom callback. Always answer 200 quickly; process afterwards.
async function callbackRoute(req, res) {
    if (config.mpesa.callbackSecret && !safeEqual(req.params.secret || '', config.mpesa.callbackSecret)) {
        console.warn('⚠️ Callback with bad/missing secret ignored');
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    handleCallback(req.body).catch(e => console.error('❌ Callback processing:', e));
}
app.post('/api/v1/mpesa/callback', callbackRoute);
app.post('/api/v1/mpesa/callback/:secret', callbackRoute);

app.get('/api/v1/status/:id', async (req, res) => {
    let tx = await db.get(req.params.id);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found.' });
    try { tx = await reconcile(tx); } catch (e) { console.warn('reconcile', e.message); }
    const out = { success: true, status: tx.status, reason: tx.reason || null };
    if (tx.status === 'SUCCESS') Object.assign(out, credentials(tx), { routerReady: tx.mikrotik_sync === 'DONE' }); // never reveal the code before payment
    res.json(out);
});

// "Already paid?" — recover the voucher with the M-Pesa confirmation code from the SMS.
app.post('/api/v1/recover', async (req, res) => {
    const receipt = String(req.body?.receipt || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z0-9]{8,12}$/.test(receipt)) return res.status(400).json({ success: false, message: 'Enter the 10-character M-Pesa code from your SMS, e.g. SJK4ABC12D.' });
    if (limited(`recover:${req.ip}`, 30, 10 * 60_000)) return res.status(429).json({ success: false, message: 'Too many attempts. Please wait a few minutes.' });
    const tx = await db.findOne({ receipt, status: 'SUCCESS' });
    if (!tx) return res.status(404).json({ success: false, message: 'We could not find a payment with that code yet. If you just paid, wait a minute and try again.' });
    if (tx.expires_at && new Date(tx.expires_at) < new Date()) return res.status(410).json({ success: false, message: 'That package has already expired.' });
    res.json({ success: true, ...credentials(tx) });
});

// ==========================================
// ROUTER SYNC (MikroTik pulls work — no inbound access to the router needed)
// ==========================================
function routerAuth(req, res, next) {
    if (!config.routerSecret) return res.status(503).type('text').send('ERROR,ROUTER_SECRET not configured');
    const key = req.get('x-router-key') || req.query.key || '';
    if (!safeEqual(key, config.routerSecret)) return res.status(401).type('text').send('ERROR,unauthorized');
    next();
}

// Response (plain text, one job per call):
//   ADD,<txid>,<username>,<password>,<profile>,<limit-uptime>,<rate-limit or empty>
//   DEL,<txid>,<username>
//   NONE
app.get('/api/v1/router/sync', routerAuth, async (req, res) => {
    const job = await db.nextRouterJob();
    res.type('text');
    if (!job) return res.send('NONE');
    const { tx } = job;
    if (job.action === 'DEL') return res.send(`DEL,${tx.id},${tx.username}`);
    const pkg = getPackage(tx.package_id);
    res.send(`ADD,${tx.id},${tx.username},${tx.password},${pkg?.profile || 'default'},${toRouterUptime(pkg?.minutes || 60)},${rateLimit(pkg)}`);
});

app.get('/api/v1/router/confirm/:id', routerAuth, async (req, res) => {
    const tx = await db.get(req.params.id);
    res.type('text');
    if (!tx) return res.status(404).send('ERROR,not found');
    const action = String(req.query.action || 'add').toLowerCase();
    await db.update(tx.id, { mikrotik_sync: action === 'del' ? 'REMOVED' : 'DONE' });
    console.log(`🔌 Router ${action === 'del' ? 'removed' : 'activated'} ${tx.username}`);
    res.send('OK');
});

// ==========================================
// ADMIN DASHBOARD
// ==========================================
function adminAuth(req, res, next) {
    if (!config.admin.user || !config.admin.pass) return res.status(503).send('Set ADMIN_USERNAME and ADMIN_PASSWORD to enable the dashboard.');
    const [scheme, b64] = (req.get('authorization') || '').split(' ');
    if (scheme === 'Basic' && b64) {
        const [u, ...rest] = Buffer.from(b64, 'base64').toString().split(':');
        if (safeEqual(u, config.admin.user) && safeEqual(rest.join(':'), config.admin.pass)) return next();
    }
    if (limited(`admin-fail:${req.ip}`, 20, 15 * 60_000)) return res.status(429).send('Too many attempts.');
    res.set('WWW-Authenticate', 'Basic realm="Timeless WiFi Admin"').status(401).send('Authentication required');
}

app.get('/admin', adminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/v1/admin/summary', adminAuth, async (req, res) => {
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const rows = await db.list({ since, limit: 1000 });
    const startOfDay = new Date(); startOfDay.setUTCHours(-3, 0, 0, 0); // midnight EAT
    if (startOfDay > new Date()) startOfDay.setUTCDate(startOfDay.getUTCDate() - 1);
    const paid = rows.filter(r => r.status === 'SUCCESS');
    const sum = list => list.reduce((s, r) => s + Number(r.paid_amount ?? r.amount ?? 0), 0);
    const today = paid.filter(r => new Date(r.paid_at || r.created_at) >= startOfDay);
    const week = paid.filter(r => new Date(r.paid_at || r.created_at) >= new Date(Date.now() - 7 * 86400_000));
    const byDay = {};
    for (let i = 13; i >= 0; i--) {
        const d = new Date(Date.now() + 3 * 3600_000 - i * 86400_000).toISOString().slice(0, 10);
        byDay[d] = 0;
    }
    for (const r of paid) {
        const d = new Date(new Date(r.paid_at || r.created_at).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
        if (d in byDay) byDay[d] += Number(r.paid_amount ?? r.amount ?? 0);
    }
    const byPackage = {};
    for (const r of paid) byPackage[r.package_id] = (byPackage[r.package_id] || 0) + 1;
    const nowIso = new Date().toISOString();
    res.json({
        success: true,
        revenue: { today: sum(today), week: sum(week), month: sum(paid) },
        counts: {
            today: today.length,
            pending: rows.filter(r => r.status === 'PENDING').length,
            failed30d: rows.filter(r => r.status === 'FAILED').length,
            active: paid.filter(r => r.expires_at && r.expires_at > nowIso).length,
            awaitingRouter: paid.filter(r => r.mikrotik_sync === 'PENDING').length
        },
        conversion: rows.length ? Math.round((paid.length / rows.length) * 100) : 0,
        byDay, byPackage,
        config: { mpesaEnv: config.mpesa.enabled ? config.mpesa.env : 'disabled', storage: supabase ? 'supabase' : 'memory',
            transactionType: config.mpesa.transactionType, callbackUrl: callbackUrl().replace(config.mpesa.callbackSecret || '\u0000', '••••'),
            problems: configProblems() }
    });
});

app.get('/api/v1/admin/transactions', adminAuth, async (req, res) => {
    const status = ['PENDING', 'SUCCESS', 'FAILED'].includes(req.query.status) ? req.query.status : undefined;
    const rows = await db.list({ status, q: String(req.query.q || '').slice(0, 60), limit: Number(req.query.limit) || 200 });
    res.json({ success: true, rows });
});

app.post('/api/v1/admin/transactions/:id/requeue', adminAuth, async (req, res) => {
    const tx = await db.get(req.params.id);
    if (!tx || tx.status !== 'SUCCESS') return res.status(400).json({ success: false, message: 'Only paid transactions can be re-sent to the router.' });
    await db.update(tx.id, { mikrotik_sync: 'PENDING' });
    res.json({ success: true });
});

app.post('/api/v1/admin/transactions/:id/check', adminAuth, async (req, res) => {
    const tx = await db.get(req.params.id);
    if (!tx) return res.status(404).json({ success: false, message: 'Not found' });
    if (tx.status !== 'PENDING') return res.json({ success: true, status: tx.status });
    await db.update(tx.id, { last_query_at: null });
    const r = await stkQuery(tx.id);
    if (r.pending) return res.json({ success: true, status: 'PENDING', message: 'M-Pesa still reports this as processing.' });
    const t = r.resultCode === 0 ? await markPaid(tx, { source: 'admin-query' }) : await markFailed(tx, FRIENDLY[r.resultCode] || r.resultDesc);
    res.json({ success: true, status: t.status });
});

app.post('/api/v1/admin/transactions/:id/mark-paid', adminAuth, async (req, res) => {
    const tx = await db.get(req.params.id);
    if (!tx) return res.status(404).json({ success: false, message: 'Not found' });
    const receipt = String(req.body?.receipt || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
    if (tx.status === 'FAILED') await db.update(tx.id, { status: 'PENDING' });
    const t = await markPaid({ ...tx, status: 'PENDING' }, { receipt, source: 'admin-manual' });
    res.json({ success: true, status: t.status, username: t.username });
});

// Send a real STK prompt from the dashboard to prove the whole payment path (and the callback) works.
app.post('/api/v1/admin/test-payment', adminAuth, async (req, res) => {
    try {
        if (!config.mpesa.enabled) return res.status(503).json({ success: false, message: 'MPESA_ENABLED is not true.' });
        const msisdn = formatPhone(req.body?.phone);
        if (!/^254(7|1)\d{8}$/.test(msisdn)) return res.status(400).json({ success: false, message: 'Enter a valid Safaricom number.' });
        const amount = Math.min(Math.max(parseInt(req.body?.amount, 10) || 1, 1), 100);
        const { checkoutId, merchantId } = await stkPush({ phone: msisdn, amount, pkg: { name: 'Test payment' } });
        await db.save({
            id: checkoutId, merchant_request_id: merchantId, status: 'PENDING', phone: msisdn, package_id: 'admin_test',
            amount, username: voucherCode(), password: 'test', created_at: new Date().toISOString(), mikrotik_sync: 'SKIP'
        });
        console.log(`🧪 Test STK sent · ${amount} KES · ${maskPhone(msisdn)}`);
        res.json({ success: true, transactionId: checkoutId, amount, mode: config.mpesa.env });
    } catch (e) {
        res.status(502).json({ success: false, message: e.message });
    }
});

app.get('/api/v1/admin/test-payment/:id', adminAuth, async (req, res) => {
    let tx = await db.get(req.params.id);
    if (!tx) return res.status(404).json({ success: false, message: 'Not found' });
    try { tx = await reconcile(tx); } catch (_) {}
    res.json({ success: true, status: tx.status, reason: tx.reason || null, receipt: tx.receipt || null,
        confirmedBy: tx.confirmed_by || null, ageSeconds: Math.round((Date.now() - new Date(tx.created_at).getTime()) / 1000) });
});

// Static assets for the dashboard (no secrets in here)
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));
app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'Invalid JSON' });
    console.error('❌ Unhandled:', err);
    res.status(500).json({ success: false, message: 'Server error' });
});

// In-memory housekeeping (Supabase keeps history)
setInterval(() => {
    if (supabase) {
        for (const [k, t] of mem) if (Date.now() - new Date(t.created_at).getTime() > 6 * 3600_000) mem.delete(k);
        return;
    }
    const cutoff = Date.now() - 45 * 86400_000;
    for (const [k, t] of mem) if (new Date(t.created_at).getTime() < cutoff) mem.delete(k);
}, 30 * 60_000).unref();

if (require.main === module) {
    app.listen(config.port, '0.0.0.0', () => {
        console.log(`🚀 ${config.brand} backend on :${config.port}`);
        console.log(`💳 M-Pesa: ${config.mpesa.enabled ? config.mpesa.env.toUpperCase() : 'DISABLED'} · ${config.mpesa.transactionType}`);
        console.log(`🗄️  Storage: ${supabase ? 'Supabase' : 'in-memory (ephemeral!)'}`);
        for (const p of configProblems()) console.warn(`⚠️  ${p}`);
    });
}

module.exports = { app, _internals: { darajaTimestamp, formatPhone, voucherCode, handleCallback, db } };
