/**
 * index.js — COD Meta Tracking System v6.0 — Multi-Store
 * =========================================================
 * يدعم متاجر متعددة على نفس السيرفر:
 *   - كل متجر له Easy Orders Secret خاص (يحدد المتجر)
 *   - كل متجر له Meta Pixel + CAPI Token خاص (يحدد لمن نبعت)
 *   - Bosta API + Redis مشتركة بين كل المتاجر
 *
 * Environment Variables Format:
 *   STORE_1_NAME, STORE_1_DOMAINS, STORE_1_EASY_ORDERS_SECRET,
 *   STORE_1_META_PIXEL_ID, STORE_1_META_CAPI_TOKEN
 *   (نفس النمط لـ STORE_2_*, STORE_3_*, ...)
 *
 * Backward compatible: لو ENV vars القديمة موجودة (META_PIXEL_ID, EASY_ORDERS_SECRET)
 * بدون STORE_1_*, ستعمل كمتجر واحد افتراضي.
 */

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const path    = require('path');
const Redis   = require('ioredis');

// ══════════════════════════════════════════════════════════
// MULTI-STORE CONFIG
// ══════════════════════════════════════════════════════════
function loadStores() {
  const list = [];
  for (let i = 1; i <= 20; i++) {
    const name = process.env[`STORE_${i}_NAME`];
    if (!name) break;
    list.push({
      index:     i - 1,
      name:      name,
      secret:    process.env[`STORE_${i}_EASY_ORDERS_SECRET`] || '',
      pixelId:   process.env[`STORE_${i}_META_PIXEL_ID`]      || '',
      capiToken: process.env[`STORE_${i}_META_CAPI_TOKEN`]    || '',
      domains:   (process.env[`STORE_${i}_DOMAINS`] || '')
                  .split(',').map(s => s.trim()).filter(Boolean),
    });
  }
  // Backward compat: متجر افتراضي من env vars القديمة
  if (list.length === 0 && process.env.META_PIXEL_ID) {
    list.push({
      index:     0,
      name:      'default',
      secret:    process.env.EASY_ORDERS_SECRET || '',
      pixelId:   process.env.META_PIXEL_ID      || '',
      capiToken: process.env.META_CAPI_TOKEN    || '',
      domains:   (process.env.ALLOWED_ORIGINS || '')
                  .split(',').map(s => s.trim()).filter(Boolean),
    });
  }
  return list;
}

const STORES           = loadStores();
const SECRET_TO_STORE  = Object.fromEntries(STORES.filter(s => s.secret).map(s => [s.secret, s]));
const ALLOWED_ORIGINS  = new Set(STORES.flatMap(s => s.domains));
const DEFAULT_STORE    = STORES[0];

const CONFIG = {
  BOSTA_API_KEY:  process.env.BOSTA_API_KEY  || '',
  BOSTA_BASE:     'https://app.bosta.co/api/v2',
  META_CAPI_BASE: 'https://graph.facebook.com/v19.0',
  REDIS_URL:      process.env.REDIS_URL      || '',
  SIGNAL_TTL:     4  * 60 * 60,
  ORDER_TTL:      30 * 24 * 60 * 60,
  TRACKING_TTL:   30 * 24 * 60 * 60,
  PROCESSED_TTL:  30 * 24 * 60 * 60,
};

// ══════════════════════════════════════════════════════════
// APP + MIDDLEWARE
// ══════════════════════════════════════════════════════════
const app = express();
app.use(express.json());

app.get('/header-script.js', (req, res) => {
  res.setHeader('Content-Type',  'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'header-script.js'));
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods',     'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',     'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ══════════════════════════════════════════════════════════
// REDIS
// ══════════════════════════════════════════════════════════
let redis = null;
function getRedis() {
  if (!redis && CONFIG.REDIS_URL) {
    redis = new Redis(CONFIG.REDIS_URL, { maxRetriesPerRequest: 3 });
    redis.on('connect', () => console.log('[Redis] connected'));
    redis.on('error',   (e) => console.error('[Redis] error:', e.message));
  }
  return redis;
}
async function rSet(key, value, ttl) {
  try { await getRedis()?.set(key, JSON.stringify(value), 'EX', ttl); } catch(e) {}
}
async function rGet(key) {
  try { const v = await getRedis()?.get(key); return v ? JSON.parse(v) : null; } catch(e) { return null; }
}
async function rDel(key) {
  try { await getRedis()?.del(key); } catch(e) {}
}
async function rKeys(pattern) {
  try { return await getRedis()?.keys(pattern) || []; } catch(e) { return []; }
}

const mem = { signals: new Map(), orders: new Map(), tracking: new Map() };
setInterval(() => {
  const cutoff = Date.now() - CONFIG.SIGNAL_TTL * 1000;
  for (const [k, v] of mem.signals) if (v.ts && v.ts < cutoff) mem.signals.delete(k);
}, 30 * 60 * 1000);

const store = {
  async setSignal(k, v)   { getRedis() ? await rSet(`sig:${k}`,    v, CONFIG.SIGNAL_TTL)    : mem.signals.set(k, v); },
  async getSignal(k)      { return getRedis() ? await rGet(`sig:${k}`)    : (mem.signals.get(k)  || null); },
  async delSignal(k)      { getRedis() ? await rDel(`sig:${k}`)           : mem.signals.delete(k); },
  async setOrder(id, v)   { getRedis() ? await rSet(`order:${id}`, v, CONFIG.ORDER_TTL)    : mem.orders.set(id, v); },
  async getOrder(id)      { return getRedis() ? await rGet(`order:${id}`) : (mem.orders.get(id) || null); },
  async setTracking(k, v) { getRedis() ? await rSet(`track:${k}`,  v, CONFIG.TRACKING_TTL) : mem.tracking.set(k, v); },
  async getTracking(k)    { return getRedis() ? await rGet(`track:${k}`)  : (mem.tracking.get(k) || null); },

  async getAllOrders() {
    if (getRedis()) {
      const keys = await rKeys('order:*');
      const res = [];
      for (const k of keys) { const v = await rGet(k); if (v) res.push(v); }
      return res;
    }
    return Array.from(mem.orders.values());
  },
  async getAllSignals() {
    if (getRedis()) {
      const keys = await rKeys('sig:*');
      const res = [];
      for (const k of keys) { const v = await rGet(k); if (v) res.push({ key: k.replace('sig:',''), val: v }); }
      return res;
    }
    return Array.from(mem.signals.entries()).map(([key, val]) => ({ key, val }));
  },
  async orderCount()    { return getRedis() ? (await rKeys('order:*')).length : mem.orders.size; },
  async trackingCount() { return getRedis() ? (await rKeys('track:*')).length : mem.tracking.size; },
};

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════
const sha256 = v => v ? crypto.createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex') : undefined;

const normalizePhone = p => {
  if (!p) return p;
  let d = p.replace(/\D/g, '');
  if (d.startsWith('20') && d.length === 12) d = d.slice(2);
  if (!d.startsWith('0') && d.length === 10) d = '0' + d;
  return d;
};

const phoneForMeta = p => {
  const n = normalizePhone(p);
  if (!n) return n;
  return n.startsWith('0') ? '2' + n : n;
};

const isDelivered = s => [45, '45', 'delivered', 'DELIVERED'].includes(s);
const isReturned  = s => [46, '46', 48, '48', 49, '49', 100, '100', 101, '101', 'returned', 'RETURNED'].includes(s);

const getClientIp = req =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
  req.headers['x-real-ip'] || req.socket?.remoteAddress || null;

function apiCall(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search, method,
      headers: { 'Content-Type': 'application/json', ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, body: raw }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════
// ENDPOINTS
// ══════════════════════════════════════════════════════════

app.post('/collect-signals', async (req, res) => {
  const { sessionId, fbp, fbc, userAgent, pageUrl } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  await store.setSignal(sessionId, {
    fbp: fbp || null, fbc: fbc || null,
    clientIp: getClientIp(req),
    userAgent: userAgent || req.headers['user-agent'] || null,
    pageUrl: pageUrl || null, ts: Date.now(),
  });
  console.log(`[Signals] ${sessionId.slice(-8)} fbp:${fbp?'v':'x'} fbc:${fbc?'v':'x'}`);
  res.json({ ok: true });
});

app.post('/link-session', async (req, res) => {
  const { orderId, sessionId } = req.body;
  if (!orderId || !sessionId) return res.status(400).json({ error: 'orderId and sessionId required' });
  const order = await store.getOrder(orderId);
  if (order) {
    order.signals = await store.getSignal(sessionId) || {};
    await store.setOrder(orderId, order);
    console.log(`[Link] late-link -> order ${orderId.slice(-8)}`);
  }
  await store.setSignal('link_' + orderId, { sessionId, ts: Date.now() });
  console.log(`[Link] session -> order ${orderId.slice(-8)}`);
  res.json({ ok: true });
});

// Easy Orders Webhook — يحدد المتجر من الـ secret
app.post('/webhook/easy-orders', async (req, res) => {
  const secret = req.headers['secret'];
  const fromStore = SECRET_TO_STORE[secret];

  if (!fromStore) {
    console.warn(`[EasyOrders] Unknown secret (got: "${secret?.slice(0, 8)}...")`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({ received: true, store: fromStore.name });

  const p = req.body;
  if (p.status === 'pending' && p.id) await handleNewOrder(p, fromStore);
  else if (p.event_type === 'order-status-update') console.log(`[EasyOrders/${fromStore.name}] ${p.order_id} ${p.old_status} -> ${p.new_status}`);
});

// Bosta Webhook — مشترك بين كل المتاجر
app.post('/webhook/bosta', async (req, res) => {
  res.json({ received: true });
  const p = req.body;
  const tracking = String(p.tracking_number || p.trackingNumber || p._id || '');
  const stateRaw = p.state || p.status || p.currentStatus?.state || '';
  if (!tracking || !stateRaw) { console.warn('[Bosta] payload missing'); return; }

  console.log(`[Bosta] ${tracking} -> ${stateRaw}`);

  // سجّل الـ tracking للمتابعة المستقبلية (مهما كانت الحالة)
  await addToTracked(tracking, null);

  if (!isDelivered(stateRaw) && !isReturned(stateRaw)) return;

  const processedKey = `processed_${tracking}_${stateRaw}`;
  if (await store.getSignal(processedKey)) {
    console.log(`[Bosta] already processed`);
    await removeFromTracked(tracking);
    return;
  }

  await processBostaShipment(tracking, stateRaw, processedKey);
  await removeFromTracked(tracking);
});

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    version: '6.0-multi-store',
    storage: getRedis() ? 'redis' : 'memory',
    stores:  STORES.map(s => ({ name: s.name, domains: s.domains.length, hasSecret: !!s.secret, hasPixel: !!s.pixelId })),
    orders: await store.orderCount(),
    tracking: await store.trackingCount(),
    tracked: getRedis() ? (await rKeys('tracked:*')).length : 0,
    uptime: Math.floor(process.uptime()) + 's',
  });
});

app.post('/admin/poll', (req, res) => {
  res.json({ started: true, alreadyRunning: pollRunning });
  pollBostaDeliveries();
});

// ══════════════════════════════════════════════════════════
// CORE LOGIC
// ══════════════════════════════════════════════════════════

async function handleNewOrder(order, fromStore) {
  console.log(`[New Order/${fromStore.name}] ${order.id.slice(-8)} -- ${order.full_name} -- ${order.total_cost} EGP`);

  const linkRecord = await store.getSignal('link_' + order.id);
  const sessionId  = linkRecord?.sessionId || null;
  let signals      = sessionId ? (await store.getSignal(sessionId) || {}) : {};

  if (!signals.fbp && !signals.fbc) {
    const cutoff = Date.now() - (3 * 60 * 1000);
    let latest = null, latestTs = 0;
    const allSigs = await store.getAllSignals();
    for (const { key, val } of allSigs) {
      if (key.startsWith('link_') || key.startsWith('bosta_') || key.startsWith('processed_')) continue;
      if (val.ts && val.ts > cutoff && val.ts > latestTs) { latest = val; latestTs = val.ts; }
    }
    if (latest) { signals = latest; console.log(`[Signals] time-match: ${Math.round((Date.now()-latestTs)/1000)}s ago`); }
  }

  console.log(`[Signals] fbp:${signals.fbp?'v':'x'} fbc:${signals.fbc?'v':'x'} ip:${signals.clientIp?'v':'x'}`);

  await store.setOrder(order.id, {
    orderId:    order.id,
    storeIndex: fromStore.index,
    storeName:  fromStore.name,
    totalCost:  order.total_cost,
    phone:      order.phone,
    email:      order.email || null,
    fullName:   order.full_name || '',
    city:       order.government || '',
    cartItems:  order.cart_items || [],
    createdAt:  order.created_at || new Date().toISOString(),
    signals,
  });
}

async function processBostaShipment(tracking, stateRaw, processedKey) {
  const bosta = await fetchBostaDelivery(tracking);
  if (!bosta) {
    console.warn(`[Bosta] couldn't fetch delivery for ${tracking}`);
    return;
  }

  console.log(`[Bosta API] phone:${bosta.phone} city:${bosta.city} cod:${bosta.cod}`);
  await rSet(`sig:${processedKey}`, { ts: Date.now() }, CONFIG.PROCESSED_TTL);

  let enrichment = null;
  let orderId = await store.getTracking(tracking);
  if (orderId) enrichment = await store.getOrder(orderId);

  if (!enrichment && bosta.businessReference) {
    const byRef = await store.getOrder(bosta.businessReference);
    if (byRef) {
      enrichment = byRef; orderId = bosta.businessReference;
      await store.setTracking(tracking, orderId);
      console.log(`[Match] by businessReference -> ${orderId.slice(-8)} (store ${byRef.storeName})`);
    }
  }

  if (!enrichment && bosta.phone) {
    const normPhone = normalizePhone(bosta.phone);
    const allOrders = await store.getAllOrders();
    // اختر الأحدث لو موجود في أكثر من متجر
    let latest = null, latestTs = 0;
    for (const o of allOrders) {
      if (normalizePhone(o.phone) === normPhone) {
        const ts = new Date(o.createdAt).getTime();
        if (ts > latestTs) { latest = o; latestTs = ts; }
      }
    }
    if (latest) {
      enrichment = latest; orderId = latest.orderId;
      await store.setTracking(tracking, orderId);
      console.log(`[Match] by phone -> ${orderId.slice(-8)} (store ${latest.storeName})`);
    }
  }

  // حدد المتجر اللي هنبعت لـ Pixel بتاعه
  const targetStore = (enrichment?.storeIndex !== undefined && STORES[enrichment.storeIndex])
    ? STORES[enrichment.storeIndex]
    : DEFAULT_STORE;

  if (enrichment) {
    console.log(`[Enrich/${targetStore.name}] email:${enrichment.email?'v':'x'} fbp:${enrichment.signals?.fbp?'v':'x'} content_ids:${enrichment.cartItems?.length || 0}`);
  } else {
    console.log(`[Enrich/${targetStore.name}] no Redis match -- Bosta data only`);
  }

  if (isDelivered(stateRaw)) {
    await sendMetaEvent('Delivery', bosta, enrichment, tracking, null, targetStore);
  } else if (isReturned(stateRaw)) {
    await sendMetaEvent('OrderReturned', bosta, enrichment, tracking, stateRaw, targetStore);
  }
}

async function fetchBostaDelivery(trackingNumber) {
  try {
    const url = `${CONFIG.BOSTA_BASE}/deliveries/business/${trackingNumber}`;
    const res = await apiCall('GET', url, null, { 'Authorization': CONFIG.BOSTA_API_KEY });
    if (res.status !== 200) {
      console.warn(`[Bosta API] ${trackingNumber} -> ${res.status}`);
      return null;
    }
    const d = res.body?.data || res.body;
    return {
      trackingNumber:    trackingNumber,
      phone:             d?.receiver?.phone || d?.receiver?.secondPhone || null,
      firstName:         d?.receiver?.firstName || '',
      lastName:          d?.receiver?.lastName  || '',
      fullName:          (d?.receiver?.firstName || '') + ' ' + (d?.receiver?.lastName || ''),
      city:              d?.dropOffAddress?.city?.name || d?.dropOffAddress?.city || '',
      zone:              d?.dropOffAddress?.zone?.name || '',
      cod:               d?.cod ?? null,
      businessReference: d?.businessReference || null,
      creationDate:      d?.creationTimestamp || d?.createdAt || null,
    };
  } catch (e) {
    console.error('[Bosta API] error:', e.message);
    return null;
  }
}

async function sendMetaEvent(eventName, bosta, enrichment, tracking, returnReason, targetStore) {
  if (!targetStore?.pixelId || !targetStore?.capiToken) {
    console.warn(`[Meta] store "${targetStore?.name}" بدون pixel/token -- skipped`);
    return;
  }

  const phone     = bosta.phone || enrichment?.phone;
  const firstName = bosta.firstName || enrichment?.fullName?.split(' ')[0] || '';
  const lastName  = bosta.lastName  || enrichment?.fullName?.split(' ').slice(1).join(' ') || '';
  const city      = bosta.city      || enrichment?.city;
  const email     = enrichment?.email;
  const fbp       = enrichment?.signals?.fbp;
  const fbc       = enrichment?.signals?.fbc;
  const clientIp  = enrichment?.signals?.clientIp;
  const userAgent = enrichment?.signals?.userAgent;

  const value       = bosta.cod || enrichment?.totalCost;
  const contentIds  = enrichment?.cartItems?.map(i => i.product_id) || [];
  const orderId     = enrichment?.orderId || bosta.businessReference || tracking;
  const deliveryDays = enrichment?.createdAt
    ? Math.round((Date.now() - new Date(enrichment.createdAt).getTime()) / 86400000)
    : null;

  const eventId = `${eventName.toLowerCase()}_${orderId}`;

  const payload = {
    data: [{
      event_name:    eventName,
      event_time:    Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id:      eventId,
      user_data: {
        em:                email     ? [sha256(email)]                  : undefined,
        ph:                phone     ? [sha256(phoneForMeta(phone))]    : undefined,
        fn:                firstName ? [sha256(firstName)]              : undefined,
        ln:                lastName  ? [sha256(lastName)]               : undefined,
        ct:                city      ? [sha256(city.toLowerCase())]     : undefined,
        country:           [sha256('eg')],
        external_id:       orderId   ? [sha256(orderId)]                : undefined,
        fbp:               fbp       || undefined,
        fbc:               fbc       || undefined,
        client_ip_address: clientIp  || undefined,
        client_user_agent: userAgent || undefined,
      },
      custom_data: {
        order_id:       orderId,
        currency:       'EGP',
        value:          value,
        content_ids:    contentIds,
        content_type:   contentIds.length ? 'product' : undefined,
        tracking_number: tracking,
        payment_method: 'cod',
        delivery_city:  city,
        delivery_days:  deliveryDays,
        store_name:     targetStore.name,
        ...(returnReason ? { return_reason: String(returnReason) } : {}),
      },
    }],
  };

  try {
    const url = `${CONFIG.META_CAPI_BASE}/${targetStore.pixelId}/events?access_token=${targetStore.capiToken}`;
    const res = await apiCall('POST', url, JSON.parse(JSON.stringify(payload)));
    console.log(`[Meta/${targetStore.name}] ${eventName} -> ${res.status} events_received:${res.body?.events_received ?? '?'} event_id:${eventId}`);
    if (res.status !== 200) {
      console.warn(`[Meta] response body:`, JSON.stringify(res.body).slice(0, 300));
    }
  } catch (e) {
    console.error(`[Meta/${targetStore.name}] ${eventName} error:`, e.message);
  }
}

// ══════════════════════════════════════════════════════════
// POLLING — Hybrid Strategy:
//   A) Recent: آخر 50 شحنة (page 0 only - الـ API لا يدعم pagination)
//   B) Tracked: كل tracking معروف لسه pending
// ══════════════════════════════════════════════════════════
const POLL_INTERVAL_MS    = 60 * 60 * 1000;          // كل ساعة
const POLL_PAGE_LIMIT     = 50;
const TRACKED_KEY         = 'tracked';               // قائمة الـ trackings المعروفة
const TRACKED_TTL         = 30 * 24 * 60 * 60;
let pollRunning = false;

// إضافة tracking للقائمة المُتابَعة في Redis
async function addToTracked(tracking, storeIndex) {
  await rSet(`tracked:${tracking}`, {
    tracking,
    storeIndex: storeIndex ?? null,
    addedAt: Date.now(),
  }, TRACKED_TTL);
}

// حذف tracking من القائمة (لما يتسلّم أو يُرجع)
async function removeFromTracked(tracking) {
  await rDel(`tracked:${tracking}`);
}

// جلب كل الـ trackings المتابَعة
async function getTrackedList() {
  if (!getRedis()) return [];
  const keys = await rKeys('tracked:*');
  const results = [];
  for (const k of keys) {
    const v = await rGet(k);
    if (v) results.push(v);
  }
  return results;
}

async function pollBostaDeliveries() {
  if (pollRunning) { console.log('[Poll] dropped - previous running'); return; }
  pollRunning = true;
  console.log('[Poll] ===== Starting Bosta poll =====');
  let recentScanned = 0, recentSent = 0, trackedScanned = 0, trackedSent = 0;

  try {
    // ── PART A: آخر 50 شحنة ──────────────────────────────
    console.log('[Poll/A] Fetching latest 50 deliveries...');
    const url  = `${CONFIG.BOSTA_BASE}/deliveries/search`;
    const body = { pageLimit: POLL_PAGE_LIMIT };
    const res  = await apiCall('POST', url, body, { 'Authorization': CONFIG.BOSTA_API_KEY });

    if (res.status === 200) {
      const deliveries = res.body?.data?.deliveries || [];
      console.log(`[Poll/A] Got ${deliveries.length} recent deliveries`);

      for (const d of deliveries) {
        recentScanned++;
        const tracking = d.trackingNumber || d._id;
        const state    = d.state?.code ?? d.state?.value ?? d.state ?? 0;

        // سجّل الـ tracking للمتابعة المستقبلية (سواء تسلّم أو لا)
        await addToTracked(tracking, null);

        if (!isDelivered(state) && !isReturned(state)) continue;

        const processedKey = `processed_${tracking}_${state}`;
        if (await store.getSignal(processedKey)) {
          await removeFromTracked(tracking); // معالج → اشطبه من المتابعة
          continue;
        }
        await processBostaShipment(tracking, state, processedKey);
        await removeFromTracked(tracking);
        recentSent++;
      }
    } else {
      console.warn(`[Poll/A] returned ${res.status}`);
    }

    // ── PART B: كل tracking في القائمة المتابعة ──────────
    const tracked = await getTrackedList();
    console.log(`[Poll/B] Checking ${tracked.length} tracked shipments...`);

    for (const t of tracked) {
      trackedScanned++;
      const bosta = await fetchBostaDelivery(t.tracking);
      if (!bosta) continue;

      const state = await getTrackingState(t.tracking);
      if (state === null) continue;

      if (isDelivered(state) || isReturned(state)) {
        const processedKey = `processed_${t.tracking}_${state}`;
        if (await store.getSignal(processedKey)) {
          await removeFromTracked(t.tracking);
          continue;
        }
        await processBostaShipment(t.tracking, state, processedKey);
        await removeFromTracked(t.tracking);
        trackedSent++;
      }
    }
  } catch (e) {
    console.error('[Poll] error:', e.message);
  } finally {
    pollRunning = false;
  }

  console.log(`[Poll] ===== Done: recent ${recentScanned}/${recentSent}, tracked ${trackedScanned}/${trackedSent} =====`);
}

// مساعدة: جلب state من Bosta API
async function getTrackingState(tracking) {
  try {
    const url = `${CONFIG.BOSTA_BASE}/deliveries/business/${tracking}`;
    const res = await apiCall('GET', url, null, { 'Authorization': CONFIG.BOSTA_API_KEY });
    if (res.status !== 200) return null;
    const d = res.body?.data || res.body;
    return d?.state?.code ?? d?.state?.value ?? d?.state ?? null;
  } catch (e) {
    return null;
  }
}

setInterval(pollBostaDeliveries, POLL_INTERVAL_MS);
setTimeout(pollBostaDeliveries, 2 * 60 * 1000);

// ══════════════════════════════════════════════════════════
// START
/**
 * test-bosta-deep-discovery.js
 * ==============================
 * اختبار شامل لكل التراكيب الممكنة بناءً على اقتراح Gemini:
 *
 * - 2 subdomains: app.bosta.co + api.bosta.co
 * - 3 versions: v0, v1, v2
 * - Endpoints: /deliveries, /deliveries/list, /business/deliveries
 * - Methods: GET (query) + POST (body)
 * - Verify pagination بمقارنة page 0 vs page 1
 *
 * Usage: /admin/test-deep-discovery
 */

app.get('/admin/test-deep-discovery', async (req, res) => {
  const headers = { 'Authorization': CONFIG.BOSTA_API_KEY };
  const subdomains = ['app.bosta.co', 'api.bosta.co'];
  const versions   = ['v0', 'v1', 'v2'];
  const paths      = ['/deliveries', '/deliveries/list', '/business/deliveries'];

  const results   = [];
  const working   = [];

  console.log(`\n===== [DEEP DISCOVERY] =====`);

  for (const sub of subdomains) {
    for (const v of versions) {
      for (const path of paths) {
        const base = `https://${sub}/api/${v}${path}`;

        // GET بـ query params
        const getUrls = [
          `${base}?pageNumber=0&limit=10`,
          `${base}?pageNumber=0&pageLimit=10`,
          `${base}?page=0&limit=10`,
          `${base}?offset=0&limit=10`,
        ];

        for (const url of getUrls) {
          try {
            const r = await apiCall('GET', url, null, headers);
            const status = r.status;
            const isHTML = typeof r.body === 'string' && r.body.includes('<!DOCTYPE');
            const isError = status >= 400;

            if (!isError && !isHTML) {
              const deliveries = r.body?.data?.deliveries || r.body?.deliveries || r.body?.data || (Array.isArray(r.body) ? r.body : null);
              if (Array.isArray(deliveries) && deliveries.length) {
                const firstId = deliveries[0]?._id || deliveries[0]?.trackingNumber;
                console.log(`[DISCOVERY] ✓ GET ${url} → ${status} count:${deliveries.length} first:${firstId}`);
                working.push({ method: 'GET', url, status, count: deliveries.length, firstId });

                // اختبر pagination
                const page1Url = url.replace('pageNumber=0', 'pageNumber=1')
                                    .replace('page=0', 'page=1')
                                    .replace('offset=0', 'offset=10');
                if (page1Url !== url) {
                  const r2 = await apiCall('GET', page1Url, null, headers);
                  const d2 = r2.body?.data?.deliveries || r2.body?.deliveries || r2.body?.data || [];
                  const firstId2 = d2[0]?._id || d2[0]?.trackingNumber;
                  const paginationWorks = firstId && firstId2 && firstId !== firstId2;
                  console.log(`[DISCOVERY]   page1: first:${firstId2} pagination:${paginationWorks ? '✓ WORKS' : '✗ SAME'}`);
                  working[working.length - 1].paginationWorks = paginationWorks;
                  working[working.length - 1].page1FirstId = firstId2;
                }
              } else {
                results.push({ method: 'GET', url, status, note: 'no deliveries array' });
              }
            } else {
              results.push({ method: 'GET', url, status, note: isHTML ? 'HTML error' : 'error' });
            }
          } catch (e) {
            results.push({ method: 'GET', url, error: e.message });
          }
        }

        // POST بـ body
        try {
          const r = await apiCall('POST', base, { pageNumber: 0, limit: 10, pageLimit: 10 }, headers);
          const isHTML = typeof r.body === 'string' && r.body.includes('<!DOCTYPE');
          if (r.status < 400 && !isHTML) {
            const deliveries = r.body?.data?.deliveries || r.body?.deliveries || r.body?.data || [];
            if (Array.isArray(deliveries) && deliveries.length) {
              const firstId = deliveries[0]?._id || deliveries[0]?.trackingNumber;
              console.log(`[DISCOVERY] ✓ POST ${base} → ${r.status} count:${deliveries.length} first:${firstId}`);
              working.push({ method: 'POST', url: base, status: r.status, count: deliveries.length, firstId });

              // pagination test
              const r2 = await apiCall('POST', base, { pageNumber: 1, limit: 10, pageLimit: 10 }, headers);
              const d2 = r2.body?.data?.deliveries || r2.body?.deliveries || r2.body?.data || [];
              const firstId2 = d2[0]?._id || d2[0]?.trackingNumber;
              const paginationWorks = firstId && firstId2 && firstId !== firstId2;
              console.log(`[DISCOVERY]   POST page1: first:${firstId2} pagination:${paginationWorks ? '✓ WORKS' : '✗ SAME'}`);
              working[working.length - 1].paginationWorks = paginationWorks;
            }
          }
        } catch (e) {}
      }
    }
  }

  console.log(`\n===== VERDICT =====`);
  console.log(`Working endpoints: ${working.length}`);
  const withPagination = working.filter(w => w.paginationWorks);
  console.log(`Endpoints with WORKING pagination: ${withPagination.length}`);
  for (const w of withPagination) {
    console.log(`  🎯 ${w.method} ${w.url}`);
  }
  console.log(`===================\n`);

  res.json({
    summary: {
      totalWorking:    working.length,
      withPagination:  withPagination.length,
    },
    workingEndpoints:      working,
    paginationEndpoints:   withPagination,
    failedCount:           results.length,
  });
});

// ══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║   COD Meta Tracking v6.0 — Multi-Store    ║`);
  console.log(`╠════════════════════════════════════════════╣`);
  console.log(`║  Port    : ${String(PORT).padEnd(32)}║`);
  console.log(`║  Storage : ${(getRedis() ? 'Redis ✓' : 'Memory ⚠').padEnd(32)}║`);
  console.log(`║  Stores  : ${String(STORES.length).padEnd(32)}║`);
  console.log(`║  Origins : ${String(ALLOWED_ORIGINS.size).padEnd(32)}║`);
  console.log(`╠════════════════════════════════════════════╣`);
  for (const s of STORES) {
    console.log(`║  • ${s.name.padEnd(12)} pixel:${s.pixelId ? '✓' : '✗'} secret:${s.secret ? '✓' : '✗'} dom:${String(s.domains.length).padEnd(2)} ║`);
  }
  console.log(`╚════════════════════════════════════════════╝\n`);
});

module.exports = app;
