// End-to-end test of the payment + router flow using MPESA_ENV=mock. Run: npm test
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const PORT = 5099, B = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PORT, NODE_ENV: 'test', MPESA_ENABLED: 'true', MPESA_ENV: 'mock', MOCK_DELAY_MS: '400',
  ROUTER_SECRET: 'rkey', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'pw', MPESA_CALLBACK_SECRET: 'cbsecret',
  SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', MIKROTIK_ENABLED: 'false', DOTENV_CONFIG_PATH: '/dev/null' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (p, o = {}) => { const r = await fetch(B + p, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) } });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d }; };
const adminH = { authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };
const rk = { 'x-router-key': 'rkey' };

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(B + '/health'); break; } catch { await sleep(100); } }
    let r = await j('/api/v1/packages'); assert.equal(r.s, 200); assert(r.d.packages.length >= 5);
    const pkg = r.d.packages.find(p => p.id === 'pkg_24h');

    // price is server-side: a tampered amount is ignored
    r = await j('/api/v1/pay', { method: 'POST', body: JSON.stringify({ phone: '0712345678', packageId: 'pkg_24h', amount: 1, mac: 'AA:BB:CC:DD:EE:01' }) });
    assert.equal(r.s, 200, JSON.stringify(r.d)); assert.equal(r.d.amount, pkg.price);
    const tx = r.d.transactionId;

    r = await j('/api/v1/status/' + tx); assert.equal(r.d.status, 'PENDING'); assert(!r.d.username, 'code must not leak before payment');
    await sleep(700);
    r = await j('/api/v1/status/' + tx); assert.equal(r.d.status, 'SUCCESS'); assert.match(r.d.username, /^[A-Z2-9]{6}$/);
    assert.equal(r.d.routerReady, false); const code = r.d.username, receipt = r.d.receipt;

    // router auth
    assert.equal((await j('/api/v1/router/sync')).s, 401);
    r = await j('/api/v1/router/sync', { headers: rk });
    const parts = r.d.split(','); assert.equal(parts[0], 'ADD'); assert.equal(parts[1], tx); assert.equal(parts[2], code);
    assert.equal(parts[4], 'Profile_24H'); assert.equal(parts[5], '1d00:00:00');
    assert.equal(parts[6], '5M/5M');
    assert.equal((await j(`/api/v1/router/confirm/${tx}?action=add`, { headers: rk })).d, 'OK');
    assert.equal((await j('/api/v1/router/sync', { headers: rk })).d, 'NONE');
    r = await j('/api/v1/status/' + tx); assert.equal(r.d.routerReady, true);

    // Lite: Ksh 10, speed-capped
    const lite = (await j('/api/v1/packages')).d.packages.find(p => p.id === 'lite_2h');
    assert.equal(lite.price, 10); assert.equal(lite.tier, 'lite'); assert.equal(lite.speed, 3);
    r = await j('/api/v1/pay', { method: 'POST', body: JSON.stringify({ phone: '0798765432', packageId: 'lite_2h', amount: 9999 }) });
    assert.equal(r.d.amount, 10); assert.match(r.d.package, /Lite 2 Hours · 3 Mbps/);
    const txL = r.d.transactionId; await sleep(700);
    r = await j('/api/v1/router/sync', { headers: rk });
    assert.equal(r.d, `ADD,${txL},${r.d.split(',')[2]},${r.d.split(',')[3]},Lite_3M,02:00:00,3M/3M`);
    await j(`/api/v1/router/confirm/${txL}?action=add`, { headers: rk });

    // recover by receipt
    r = await j('/api/v1/recover', { method: 'POST', body: JSON.stringify({ receipt: receipt.toLowerCase() }) });
    assert.equal(r.s, 200); assert.equal(r.d.username, code);
    assert.equal((await j('/api/v1/recover', { method: 'POST', body: JSON.stringify({ receipt: 'ZZZZZZZZZZ' }) })).s, 404);

    // cancelled prompt
    r = await j('/api/v1/pay', { method: 'POST', body: JSON.stringify({ phone: '254711110000', packageId: 'pkg_1h', mac: 'AA:BB:CC:DD:EE:02' }) });
    const tx2 = r.d.transactionId; await sleep(700);
    r = await j('/api/v1/status/' + tx2); assert.equal(r.d.status, 'FAILED'); assert.match(r.d.reason, /cancelled/);

    // validation
    assert.equal((await j('/api/v1/pay', { method: 'POST', body: JSON.stringify({ phone: '0712345678', packageId: 'nope' }) })).s, 400);
    assert.equal((await j('/api/v1/pay', { method: 'POST', body: JSON.stringify({ phone: '12345', packageId: 'pkg_1h' }) })).s, 400);
    // rate limit: 3 per phone per 2 min (one used above)
    let codes = [];
    for (let i = 0; i < 3; i++) codes.push((await j('/api/v1/pay', { method: 'POST', body: JSON.stringify({ phone: '0712345678', packageId: 'pkg_1h' }) })).s);
    assert.deepEqual(codes, [200, 200, 429]);

    // callback secret: posting to the bare URL is ignored
    r = await j('/api/v1/pay', { method: 'POST', body: JSON.stringify({ phone: '0722000111', packageId: 'pkg_1h' }) });
    const tx3 = r.d.transactionId;
    await j('/api/v1/mpesa/callback', { method: 'POST', body: JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: tx3, ResultCode: 1, ResultDesc: 'forged' } } }) });
    await sleep(100); r = await j('/api/v1/status/' + tx3); assert.notEqual(r.d.reason, 'forged');
    // underpayment via (secret) callback is rejected — race the mock by sending first
    r = await j('/api/v1/pay', { method: 'POST', body: JSON.stringify({ phone: '0733000222', packageId: 'pkg_1w' }) });
    const tx4 = r.d.transactionId;
    await j('/api/v1/mpesa/callback/cbsecret', { method: 'POST', body: JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: tx4, ResultCode: 0, ResultDesc: 'ok',
      CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1 }, { Name: 'MpesaReceiptNumber', Value: 'UNDERPAY01' }] } } } }) });
    await sleep(100); r = await j('/api/v1/status/' + tx4); assert.equal(r.d.status, 'FAILED'); assert.match(r.d.reason, /mismatch/);

    // admin
    assert.equal((await j('/api/v1/admin/summary')).s, 401);
    r = await j('/api/v1/admin/summary', { headers: adminH }); assert.equal(r.s, 200); assert(r.d.revenue.today >= pkg.price);
    r = await j('/api/v1/admin/transactions?q=' + code, { headers: adminH }); assert.equal(r.d.rows.length, 1);
    r = await j(`/api/v1/admin/transactions/${tx4}/mark-paid`, { method: 'POST', headers: adminH, body: JSON.stringify({ receipt: 'manual123x' }) });
    assert.equal(r.d.status, 'SUCCESS');
    const adminPage = await fetch(B + '/admin', { headers: adminH }); assert.equal(adminPage.status, 200);
    console.log('✅ all e2e checks passed');
  } catch (e) { console.error('❌', e); console.error(log); process.exitCode = 1; }
  finally { srv.kill(); }
})();
