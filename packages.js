/**
 * Package catalog — the ONLY source of truth for prices and speeds.
 * The portal fetches this from GET /api/v1/packages; the server never trusts an amount sent by the browser.
 *
 * tier     : 'lite' (cheap, speed-capped) or 'standard'
 * speed    : download cap in Mbps; upload : upload cap in Mbps (defaults to speed)
 * minutes  : how long access lasts (limit-uptime on the router + expiry cleanup)
 * profile  : MikroTik Hotspot User Profile. The router script creates it automatically with the
 *            package's rate-limit, and keeps the rate-limit in sync if you change the speed here.
 * PACKAGES_JSON in the environment can override this list without a code change.
 */
const DEFAULT_PACKAGES = [
    // ---- Lite: from Ksh 10, capped speed (browsing, WhatsApp, social) ----
    { id: 'lite_2h',   tier: 'lite',     name: '2 Hours',    price: 10,   minutes: 120,   speed: 3, profile: 'Lite_3M',      icon: 'leaf' },
    { id: 'lite_6h',   tier: 'lite',     name: '6 Hours',    price: 20,   minutes: 360,   speed: 3, profile: 'Lite_3M',      icon: 'leaf' },
    { id: 'lite_24h',  tier: 'lite',     name: '24 Hours',   price: 40,   minutes: 1440,  speed: 3, profile: 'Lite_3M',      icon: 'leaf', popular: true },

    // ---- Standard: full speed (streaming, video calls, downloads) ----
    { id: 'pkg_30m',   tier: 'standard', name: '30 Minutes', price: 10,   minutes: 30,    speed: 5, profile: 'Profile_30M',   icon: 'bolt' },
    { id: 'pkg_1h',    tier: 'standard', name: '1 Hour',     price: 20,   minutes: 60,    speed: 5, profile: 'Profile_1H',    icon: 'clock' },
    { id: 'pkg_3h',    tier: 'standard', name: '3 Hours',    price: 50,   minutes: 180,   speed: 5, profile: 'Profile_3H',    icon: 'clock' },
    { id: 'pkg_night', tier: 'standard', name: 'Night Owl',  price: 30,   minutes: 600,   speed: 5, profile: 'Profile_Night', icon: 'moon', note: '10pm – 8am' },
    { id: 'pkg_24h',   tier: 'standard', name: '24 Hours',   price: 100,  minutes: 1440,  speed: 5, profile: 'Profile_24H',   icon: 'star', popular: true },
    { id: 'pkg_1w',    tier: 'standard', name: '1 Week',     price: 500,  minutes: 10080, speed: 5, profile: 'Profile_1W',    icon: 'calendar' },
    { id: 'pkg_1m',    tier: 'standard', name: '1 Month',    price: 1500, minutes: 43200, speed: 5, profile: 'Profile_1M',    icon: 'building' }
];

function loadPackages() {
    const raw = (process.env.PACKAGES_JSON || '').trim();
    if (!raw) return DEFAULT_PACKAGES;
    try {
        const list = JSON.parse(raw);
        if (!Array.isArray(list) || !list.length) throw new Error('must be a non-empty array');
        for (const p of list) {
            if (!/^[A-Za-z0-9_-]{2,40}$/.test(p.id)) throw new Error(`bad id ${p.id}`);
            if (!Number.isInteger(p.price) || p.price < 1) throw new Error(`bad price for ${p.id}`);
            if (!Number.isInteger(p.minutes) || p.minutes < 1) throw new Error(`bad minutes for ${p.id}`);
            if (!p.name || !p.profile) throw new Error(`name/profile required for ${p.id}`);
            if (!/^[A-Za-z0-9_-]{1,40}$/.test(p.profile)) throw new Error(`bad profile name for ${p.id}`);
            if (p.speed !== undefined && !(Number(p.speed) > 0)) throw new Error(`bad speed for ${p.id}`);
            if (p.upload !== undefined && !(Number(p.upload) > 0)) throw new Error(`bad upload for ${p.id}`);
        }
        // packages sharing a profile must share a speed, otherwise the router would flip-flop the rate-limit
        const seen = {};
        for (const p of list) {
            const rl = rateLimit(p);
            if (seen[p.profile] !== undefined && seen[p.profile] !== rl) throw new Error(`profile ${p.profile} used with two different speeds`);
            seen[p.profile] = rl;
        }
        return list;
    } catch (e) {
        console.error(`❌ PACKAGES_JSON ignored (${e.message}); using defaults.`);
        return DEFAULT_PACKAGES;
    }
}

const PACKAGES = loadPackages();
const byId = new Map(PACKAGES.map(p => [p.id, p]));

/** RouterOS rate-limit "rx/tx" as seen by the router: rx = client upload, tx = client download. '' = unlimited */
function rateLimit(p) {
    if (!p || !p.speed) return '';
    const mb = n => (Number.isInteger(Number(n)) ? `${Number(n)}M` : `${Math.round(Number(n) * 1000)}k`);
    return `${mb(p.upload || p.speed)}/${mb(p.speed)}`;
}

/** RouterOS limit-uptime string, e.g. 1440 -> "1d00:00:00", 90 -> "01:30:00" */
function toRouterUptime(minutes) {
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const m = minutes % 60;
    const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    return d ? `${d}d${hhmm}` : hhmm;
}

module.exports = {
    PACKAGES,
    getPackage: id => byId.get(String(id)),
    toRouterUptime,
    rateLimit,
    displayName: p => (p ? ((p.tier === 'lite' ? 'Lite ' : '') + p.name + (p.speed ? ` · ${p.speed < 1 ? Math.round(p.speed * 1000) + ' kbps' : p.speed + ' Mbps'}` : '')) : ''),
    publicList: () => PACKAGES.map(({ id, tier, name, price, minutes, speed, icon, popular, note }) =>
        ({ id, tier: tier || 'standard', name, price, minutes, speed: speed || null,
           icon: icon || 'clock', popular: !!popular, note: note || null }))
};
