#!/usr/bin/env node
/**
 * M-Pesa connection check.
 *
 *   npm run check-mpesa                      -> checks config + Daraja login (no prompt sent)
 *   npm run check-mpesa -- 0712345678        -> also sends a Ksh 1 STK prompt to that phone and waits for the result
 *   npm run check-mpesa -- 0712345678 10     -> same, Ksh 10
 *
 * Reads the same .env as the server. Sandbox prompts cost nothing; in production this charges real money.
 */
require('dotenv').config({ quiet: true });
const axios = require('axios');

const env = k => (process.env[k] || '').trim();
const MODE = env('MPESA_ENV') || 'sandbox';
const BASE = MODE === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const ok = m => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = m => console.log(`  \x1b[31m✖\x1b[0m ${m}`);
const warn = m => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date(Date.now() + 3 * 3600_000).toISOString().replace(/[^0-9]/g, '').slice(0, 14);

const CODES = {
    0: 'PAID ✅', 1: 'Insufficient balance', 1032: 'Cancelled on the phone', 1037: 'Phone unreachable / prompt timed out',
    2001: 'Wrong PIN', 1001: 'Another transaction in progress', 1019: 'Transaction expired', 1025: 'Prompt could not be sent (try again)',
    9999: 'Prompt could not be sent (try again)'
};

const HINTS = {
    'Invalid Access Token': 'Key/secret are for a different environment than MPESA_ENV, or the app lacks M-Pesa Express.',
    'Bad Request - Invalid BusinessShortCode': 'MPESA_SHORTCODE is wrong for this environment (sandbox uses 174379).',
    'Bad Request - Invalid PhoneNumber': 'Phone must be 2547XXXXXXXX / 2541XXXXXXXX.',
    'Bad Request - Invalid CallBackURL': 'MPESA_CALLBACK_URL must be a public https URL.',
    'Merchant does not exist': 'Shortcode is not enabled for STK Push in production (go-live not complete for this shortcode).',
    'Wrong credentials': 'MPESA_PASSKEY does not match MPESA_SHORTCODE, or the shortcode/till pairing is wrong.'
};
const hint = msg => Object.entries(HINTS).find(([k]) => String(msg).includes(k))?.[1];

(async () => {
    console.log(`\nTimeless WiFi · M-Pesa check (${MODE.toUpperCase()} → ${BASE})\n`);
    let fail = false;

    // 1. config
    console.log('1. Configuration');
    for (const k of ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY']) {
        if (env(k)) ok(`${k} set`); else { bad(`${k} missing`); fail = true; }
    }
    const cbBase = env('MPESA_CALLBACK_URL') || (env('PUBLIC_URL') ? env('PUBLIC_URL').replace(/\/+$/, '') + '/api/v1/mpesa/callback' : '');
    const cb = cbBase && env('MPESA_CALLBACK_SECRET') && !cbBase.includes(env('MPESA_CALLBACK_SECRET'))
        ? `${cbBase.replace(/\/+$/, '')}/${env('MPESA_CALLBACK_SECRET')}` : cbBase;
    if (/^https:\/\//.test(cb)) ok(`Callback URL: ${cb.replace(env('MPESA_CALLBACK_SECRET') || '\u0000', '••••')}`);
    else { bad('MPESA_CALLBACK_URL / PUBLIC_URL must be https'); fail = true; }
    if (/trycloudflare|ngrok/.test(cb)) warn('Callback uses a temporary tunnel — it changes every restart. Use your permanent backend URL.');
    const type = env('MPESA_TRANSACTION_TYPE') || 'CustomerPayBillOnline';
    const partyB = env('MPESA_PARTY_B') || env('MPESA_TILL_NUMBER') || env('MPESA_SHORTCODE');
    ok(`${type} · BusinessShortCode ${env('MPESA_SHORTCODE')} · PartyB ${partyB}`);
    if (type === 'CustomerBuyGoodsOnline' && partyB === env('MPESA_SHORTCODE')) warn('Till: set MPESA_TILL_NUMBER; MPESA_SHORTCODE should be the store number.');
    if (fail) { console.log('\nFix the items above and run again.\n'); process.exit(1); }

    // 2. callback reachability
    console.log('\n2. Your backend (callback target)');
    try {
        const health = cbBase.replace(/\/api\/v1\/mpesa\/callback.*$/, '') + '/health';
        const r = await axios.get(health, { timeout: 60_000, validateStatus: () => true });
        if (r.status === 200 && r.data?.ok) ok(`${health} → ok (mpesa: ${r.data.mpesa}, storage: ${r.data.storage})`);
        else if (r.status === 404) warn(`${health} → 404. The deployed server is an old version — redeploy this code.`);
        else warn(`${health} → HTTP ${r.status}`);
    } catch (e) { warn(`Backend not reachable (${e.code || e.message}). Safaricom won't be able to deliver results; the status poll fallback still works.`); }

    // 3. OAuth
    console.log('\n3. Daraja login');
    let token;
    try {
        const basic = Buffer.from(`${env('MPESA_CONSUMER_KEY')}:${env('MPESA_CONSUMER_SECRET')}`).toString('base64');
        const r = await axios.get(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` }, timeout: 15_000 });
        token = r.data.access_token;
        ok(`Got access token (expires in ${r.data.expires_in}s)`);
    } catch (e) {
        bad(`Login failed: HTTP ${e.response?.status || ''} ${JSON.stringify(e.response?.data || e.code || e.message)}`);
        const st = e.response?.status;
        if (st === 400 || st === 401) console.log(`    → Consumer key/secret don't match MPESA_ENV=${MODE}. Sandbox keys only work with sandbox, production keys with production.\n`);
        else console.log(`    → Couldn't reach Safaricom from this machine (network/firewall/proxy). Run this on your PC or in your host's console.\n`);
        process.exit(1);
    }

    const phoneArg = process.argv[2];
    if (!phoneArg) { console.log('\nLogin works. To send a real test prompt: npm run check-mpesa -- 07XXXXXXXX\n'); return; }

    // 4. STK push
    let phone = phoneArg.replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1); else if (phone.length === 9) phone = '254' + phone;
    const amount = Math.max(1, parseInt(process.argv[3] || '1', 10));
    console.log(`\n4. STK Push — Ksh ${amount} to ${phone}${MODE === 'production' ? '  (REAL MONEY)' : '  (sandbox, no money moves)'}`);
    const t = ts();
    const password = Buffer.from(`${env('MPESA_SHORTCODE')}${env('MPESA_PASSKEY')}${t}`).toString('base64');
    let checkout;
    try {
        const r = await axios.post(`${BASE}/mpesa/stkpush/v1/processrequest`, {
            BusinessShortCode: env('MPESA_SHORTCODE'), Password: password, Timestamp: t, TransactionType: type,
            Amount: amount, PartyA: phone, PartyB: partyB, PhoneNumber: phone, CallBackURL: cb,
            AccountReference: (env('MPESA_ACCOUNT_REFERENCE') || 'TimelessWiFi').slice(0, 12), TransactionDesc: 'Test'
        }, { headers: { Authorization: `Bearer ${token}` }, timeout: 20_000 });
        checkout = r.data.CheckoutRequestID;
        ok(`Prompt sent: ${r.data.CustomerMessage || r.data.ResponseDescription} (${checkout})`);
    } catch (e) {
        const d = e.response?.data || {};
        bad(`Rejected: ${d.errorMessage || d.ResponseDescription || e.message} ${d.errorCode ? '(' + d.errorCode + ')' : ''}`);
        const h = hint(d.errorMessage || d.ResponseDescription); if (h) console.log(`    → ${h}`);
        process.exit(1);
    }

    // 5. wait for result via STK Query
    console.log('\n5. Waiting for you to enter your PIN… (up to 2 minutes)');
    for (let i = 0; i < 24; i++) {
        await sleep(5000);
        const q = ts();
        try {
            const r = await axios.post(`${BASE}/mpesa/stkpushquery/v1/query`, {
                BusinessShortCode: env('MPESA_SHORTCODE'), CheckoutRequestID: checkout, Timestamp: q,
                Password: Buffer.from(`${env('MPESA_SHORTCODE')}${env('MPESA_PASSKEY')}${q}`).toString('base64')
            }, { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 });
            const code = Number(r.data.ResultCode);
            if (code === 0) { ok(`Result: ${CODES[0]} — ${r.data.ResultDesc}`); console.log('\nPayments go through. 🎉 Check /admin: if the callback reached your server it shows as confirmed by "callback".\n'); return; }
            bad(`Result: ${CODES[code] || r.data.ResultDesc} (code ${code})`);
            console.log(code === 1032 || code === 2001 || code === 1
                ? '\nThe integration works (Safaricom processed the prompt) — the payment itself was not completed on the phone.\n'
                : '\nTry again.\n');
            return;
        } catch (e) {
            const d = e.response?.data || {};
            if (d.errorCode === '500.001.1001') { process.stdout.write('.'); continue; } // still processing
            if (e.response?.status === 403 || e.response?.status === 429) { process.stdout.write('·'); continue; } // sandbox rate limit
            process.stdout.write('?');
        }
    }
    console.log('\n  ! No final result after 2 minutes. Check the phone and /admin.\n');
})();
