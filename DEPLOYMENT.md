# Timeless WiFi — Setup & Go-Live Guide

```
Phone ──► MikroTik hotspot (hotspot/login.html) ──► Backend (Koyeb / Fly.io / Railway / VPS) ──► Safaricom Daraja (STK Push)
                     ▲                                   │   ▲
                     │                                   │   └── M-Pesa callback (+ STK Query fallback)
                     └──── router pulls paid codes ──────┘  (mikrotik/timeless-sync.rsc, every 10s)
```

How a sale works: the customer picks a package and enters their number. The backend looks up the price **on the server**
and sends an STK Push. When M-Pesa confirms, the backend issues a 6-character access code. The router script pulls
the code within about 10 seconds and creates a hotspot user. The portal then logs the customer in automatically.
When the package expires the router removes the user.

## Folder map

| Path | What it is |
|---|---|
| `server.js` | Backend: payments, status, recovery, router sync, admin API |
| `packages.js` | **Package names, prices & speed caps — edit here** (or `PACKAGES_JSON` env) |
| `public/admin.html` | Admin dashboard served at `/admin` |
| `hotspot/login.html`, `hotspot/index.html` | Upload to the router's `hotspot/` folder |
| `mikrotik/timeless-sync.rsc` | Router script that creates/removes users |
| `mikrotik/setup.rsc` | Walled garden, user profiles, scheduler |
| `supabase/schema.sql` | Database table |
| `test/e2e.js` | `npm test` — full flow in mock mode |

## 1. Database (Supabase, about 2 minutes)

1. Create a project at supabase.com, then go to **SQL Editor** and run `supabase/schema.sql`. It's safe to run on your existing table.
2. Go to **Project Settings → API** and copy the `URL` and the `service_role` key.

## 2. Host the backend

Any host that runs Node or Docker and gives you a public **https** URL will work. This folder includes a `Dockerfile` that works anywhere
and a `fly.toml` for Fly.io. Pick one:

| Option | Cost | Notes |
|---|---|---|
| **A. Koyeb** (recommended free) | Free: 1 service, 512 MB | Frankfurt region. Card check at signup (temporary hold, released). Sleeps after 1 h without traffic, but the router polls every 10 s so it stays awake. |
| **B. Fly.io** | ~$2–3 / month | Johannesburg region (closest to Kenya), never sleeps. Card required after a short trial. |
| **C. Railway** | Hobby $5 / month | Easiest dashboard, deploys from GitHub. Card required. |
| **D. Your own PC / mini-PC** | Free | Must stay on 24/7. Needs a stable https URL (Cloudflare named tunnel + your own domain), **not** a `trycloudflare.com` quick tunnel. |

Whichever you choose, set the environment variables from `.env.example`. Generate the three secrets with:

```bash
node -e "for (const k of ['MPESA_CALLBACK_SECRET','ROUTER_SECRET','ADMIN_PASSWORD']) console.log(k + '=' + require('crypto').randomBytes(16).toString('hex'))"
```

After deploying, set `PUBLIC_URL` and `MPESA_CALLBACK_URL` to your new URL. Open `https://<your-url>/health`: it should show `"ok": true`.
Then open `/admin`, where the **Setup checks** panel lists anything still missing.

### A. Koyeb (free)
1. Push this folder to a **private** GitHub repo. `.env` is git-ignored, so never commit it.
2. In koyeb.com, go to **Create Web Service → GitHub**, pick the repo and choose **Builder: Dockerfile**.
3. Set **Instance: Free**, **Region: Frankfurt** and **Port: 8080**. Under **Health check**, use HTTP path `/health`.
4. Under **Environment variables**, add everything from `.env.example` (mark keys and passwords as *Secret*), then deploy.
5. Your URL looks like `https://timeless-wifi-<org>.koyeb.app`.

### B. Fly.io (you already have the `fly` CLI)
```bash
fly auth login
fly launch --copy-config --no-deploy        # pick a unique app name when asked
fly secrets set MPESA_ENABLED=true MPESA_ENV=sandbox MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... \
  MPESA_SHORTCODE=174379 MPESA_PASSKEY=... MPESA_CALLBACK_SECRET=... ROUTER_SECRET=... \
  ADMIN_USERNAME=admin ADMIN_PASSWORD=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
fly deploy
fly secrets set PUBLIC_URL=https://<app>.fly.dev MPESA_CALLBACK_URL=https://<app>.fly.dev/api/v1/mpesa/callback
```
Logs: `fly logs`.

### C. Railway
**New Project → Deploy from GitHub repo.** Railway detects the Dockerfile. Add the variables, then **Settings → Networking → Generate Domain**.

### D. Your own machine
Install Node 18+, copy `.env.example` to `.env` and fill it in, then run `npm install` and `npm start`.
Keep it running with `pm2` (`npm i -g pm2 && pm2 start server.js --name timeless && pm2 save`).
Expose it with a **named** Cloudflare Tunnel on your own domain, such as `api.yourdomain.co.ke`.
The free `trycloudflare.com` URLs change on every restart, which breaks M-Pesa callbacks and the portal.
On the same network as the router, you can also set `MIKROTIK_ENABLED=true` for instant activation.

> Data: whichever host you use, set up Supabase (step 1). Cloud hosts lose in-memory data on every redeploy.

## 3. Router (MikroTik)

1. **Files → hotspot/**: replace `login.html` with `hotspot/login.html`. Keep the router's own `md5.js`,
   `alogin.html`, `status.html`, `logout.html` and so on. First edit line `var BACKEND_URL = ...` in `login.html` to your backend URL.
2. **System → Scripts → Add**: name it `timeless-sync`, tick policies read, write, test and policy, and paste the source part of
   `mikrotik/timeless-sync.rsc`. Set `BASE` to your backend URL and `KEY` to your `ROUTER_SECRET`.
3. **New Terminal**: edit the hostname in `mikrotik/setup.rsc` and paste it in. This adds the walled garden (HTTP and HTTPS),
   user profiles `Profile_30M … Profile_1M` and the 10-second scheduler.
4. **IP → Hotspot → Server Profiles → Login**: enable `HTTP CHAP`, `HTTP PAP` and `Cookie`.
5. Test it: run `/system script run timeless-sync`. The log should be silent (nothing to do) or show `TimelessWiFi: …`.

## 4. Testing payments

**Fastest check, after deploying:** open `/admin`, go to **Test a payment**, enter your number and tap **Send test prompt**.
Approve it on your phone. You should see **PAID … confirmed by callback**. If it says *confirmed by polling*, M-Pesa works
but `MPESA_CALLBACK_URL` isn't reaching the server. Test payments never create a router user.

**From your PC (before deploying):** run `npm install`, then `npm run check-mpesa`. This checks your config, the callback target and the Daraja login.
Run `npm run check-mpesa -- 07XXXXXXXX` to also send a Ksh 1 prompt and wait for the result.


- **No Safaricom at all:** set `MPESA_ENV=mock`. Payments auto-succeed after 6 seconds. Numbers ending `0000` simulate a cancelled prompt.
- **Sandbox:** set `MPESA_ENV=sandbox` with shortcode `174379` and the sandbox passkey. Use a real Safaricom number.
  The sandbox sends a real prompt but takes no real money.
- **Locally:** run `npm install && npm test`, which runs the whole flow end to end.

## 5. Going live (production M-Pesa)

1. On developer.safaricom.co.ke, go live with your **own PayBill or Till** (Go Live → M-Pesa Express). Safaricom emails the production passkey.
2. Change these values in your host's environment settings:
   - `MPESA_ENV=production`
   - `MPESA_CONSUMER_KEY` and `MPESA_CONSUMER_SECRET` from the **production** app
   - `MPESA_SHORTCODE` = your PayBill number, *or* your **Store number** for a Till
   - `MPESA_PASSKEY` = the production passkey
   - Till only: `MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline` and `MPESA_TILL_NUMBER=<till>`
3. Make a Ksh 10 purchase, then confirm it shows as **SUCCESS** in `/admin` and the router log shows `activated`.

## Packages & speed tiers

Default packages (edit `packages.js`; the portal and router follow automatically):

| Tier | Package | Price | Speed |
|---|---|---|---|
| Lite | 2 Hours / 6 Hours / 24 Hours | Ksh 10 / 20 / 40 | 3 Mbps (profile `Lite_3M`) |
| Standard | 30 Min / 1 Hr / 3 Hrs / Night Owl / 24 Hrs / 1 Week / 1 Month | Ksh 10 – 1,500 | 5 Mbps |

- `speed` is the download cap in Mbps. `upload` is optional and defaults to the same value. Decimals work, e.g. `0.5` gives 512 kbps.
- Every package names a router `profile`. Packages with the same speed can share one profile.
  The sync script creates missing profiles with the right `rate-limit`, and updates the limit if you change a speed.
- Rate-limit applies **per device**. For a total cap across all Lite users, add a parent queue on the router.

## Support playbook (from /admin)

| Customer says… | Do this |
|---|---|
| "I paid but the page timed out" | They tap **I have a code → Find my payment** and enter the M-Pesa SMS code. |
| Payment shows PENDING | Click **Check M-Pesa** to ask Daraja for the result. |
| Paid but no internet | Click **Re-sync**, then check the router log and that the profile exists. |
| Money taken, nothing in the system | Verify in your M-Pesa statement, then click **Mark paid** and enter the receipt code. |

## Security notes

- Prices are server-side. Changing the amount in the browser has no effect.
- Access codes are only revealed once M-Pesa confirms payment.
- Callbacks need the secret path, and underpaid callbacks are rejected.
- Router endpoints need `X-Router-Key`. The admin dashboard uses HTTP Basic auth with lock-out after repeated failures.
- STK requests are rate-limited per phone and per device.
- Don't expose RouterOS API port 8728 to the internet. Leave `MIKROTIK_ENABLED=false` unless you reach the router over a VPN.
