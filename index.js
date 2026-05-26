/**
 * index.js — COD Meta Tracking System v5.0
 * ============================================
 * فلسفة جديدة: Bosta = مصدر التسليم، Redis = طبقة التحسين
 *
 * - كل شحنة في Bosta تبعت Event لـ Meta (سواء عرفنا الأوردر أم لا)
 * - Easy Orders Webhook يحفظ بيانات إضافية (email, fbp, fbc, content_ids) في Redis
 * - لما تتسلّم الشحنة: نأخذ phone/name/city/value من Bosta + email/fbp/fbc من Redis
 * - نتيجة: تغطية 100% + EMQ عالي لما نملك بيانات إضافية
 */

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const path    = require('path');
const Redis   = require('ioredis');

const app = express();
app.use(express.json());

app.get('/header-script.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'header-script.js'));
});

const ALLOWED_ORIGINS = [
  'https://www.cosmoeg.shop','https://cosmoeg.shop',
  'https://www.eecm.shop','https://eecm.shop',
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const CONFIG = {
  EASY_ORDERS_SECRET:   process.env.EASY_ORDERS_SECRET   || '',
  BOSTA_API_KEY:        process.env.BOSTA_API_KEY        || '',
  BOSTA_BASE:           'https://app.bosta.co/api/v2',
  META_PIXEL_ID:        process.env.META_PIXEL_ID        || '',
  META_CAPI_TOKEN:      process.env.META_CAPI_TOKEN      || '',
  META_CAPI_BASE:       'https://graph.facebook.com/v19.0',
  REDIS_URL:            process.env.REDIS_URL            || '',
  SIGNAL_TTL:    4  * 60 * 60,        // 4 ساعات
  ORDER_TTL:     30 * 24 * 60 * 60,   // 30 يوم (أطول لأن دورة التسليم قد تطول)
  TRACKING_TTL:  30 * 24 * 60 * 60,
  PROCESSED_TTL: 30 * 24 * 60 * 60,
};

// ──────────────────────────────────────────────────────────
// Redis
// ──────────────────────────────────────────────────────────
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

// Memory fallback
const mem = { signals: new Map(), orders: new Map(), tracking: new Map() };
setInterval(() => {
  const cutoff = Date.now() - CONFIG.SIGNAL_TTL * 1000;
  for (const [k,v] of mem.signals) if (v.ts && v.ts < cutoff) mem.signals.delete(k);
}, 30 * 60 * 1000);

const store = {
  async setSignal(k, v)    { getRedis() ? await rSet(`sig:${k}`, v, CONFIG.SIGNAL_TTL)    : mem.signals.set(k, v); },
  async getSignal(k)       { return getRedis() ? await rGet(`sig:${k}`)                   : (mem.signals.get(k) || null); },
  async delSignal(k)       { getRedis() ? await rDel(`sig:${k}`)                          : mem.signals.delete(k); },
  async setOrder(id, v)    { getRedis() ? await rSet(`order:${id}`, v, CONFIG.ORDER_TTL)   : mem.orders.set(id, v); },
  async getOrder(id)       { return getRedis() ? await rGet(`order:${id}`)                : (mem.orders.get(id) || null); },
  async setTracking(k, v)  { getRedis() ? await rSet(`track:${k}`, v, CONFIG.TRACKING_TTL): mem.tracking.set(k, v); },
  async getTracking(k)     { return getRedis() ? await rGet(`track:${k}`)                 : (mem.tracking.get(k) || null); },

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
  async orderCount()   { return getRedis() ? (await rKeys('order:*')).length   : mem.orders.size; },
  async trackingCount(){ return getRedis() ? (await rKeys('track:*')).length   : mem.tracking.size; },
};

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────
const sha256 = v => v ? crypto.createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex') : undefined;

// طبّع لرقم محلي 01xxx للمقارنة
const normalizePhone = p => {
  if (!p) return p;
  let d = p.replace(/\D/g, '');
  if (d.startsWith('20') && d.length === 12) d = d.slice(2);
  if (!d.startsWith('0') && d.length === 10) d = '0' + d;
  return d;
};

// E.164 لـ Meta (201xxxxxxxxx بدون +)
const phoneForMeta = p => {
  const n = normalizePhone(p);
  if (!n) return n;
  return n.startsWith('0') ? '2' + n : n;
};

const isDelivered = s => [45, '45', 'delivered', 'DELIVERED'].includes(s);
const isReturned  = s => [46, '46', 48, '48', 49, '49', 100, '100', 101, '101', 'returned', 'RETURNED'].includes(s);

const getClientIp = req =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
  req.headers['x-real-ip'] ||
  req.socket?.remoteAddress || null;

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

// 1) /collect-signals — يستقبل fbp/fbc من المتصفح
app.post('/collect-signals', async (req, res) => {
  const { sessionId, fbp, fbc, userAgent, pageUrl } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  await store.setSignal(sessionId, {
    fbp: fbp || null,
    fbc: fbc || null,
    clientIp:  getClientIp(req),
    userAgent: userAgent || req.headers['user-agent'] || null,
    pageUrl:   pageUrl   || null,
    ts:        Date.now(),
  });
  console.log(`[Signals] ${sessionId.slice(-8)} fbp:${fbp?'v':'x'} fbc:${fbc?'v':'x'}`);
  res.json({ ok: true });
});

// 2) /link-session — يربط session بـ orderId
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

// 3) /webhook/easy-orders — يحفظ بيانات الأوردر مع signals
app.post('/webhook/easy-orders', async (req, res) => {
  if (req.headers['secret'] !== CONFIG.EASY_ORDERS_SECRET) {
    console.warn('[EasyOrders] Secret wrong');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ received: true });

  const p = req.body;
  if (p.status === 'pending' && p.id) await handleNewOrder(p);
  else if (p.event_type === 'order-status-update') console.log(`[EasyOrders] ${p.order_id} ${p.old_status} -> ${p.new_status}`);
});

// 4) /webhook/bosta — مصدر الـ Delivery / Returned events
app.post('/webhook/bosta', async (req, res) => {
  res.json({ received: true });

  const p = req.body;
  const tracking = String(p.tracking_number || p.trackingNumber || p._id || '');
  const state    = p.state || p.status || p.currentStatus?.state || '';
  if (!tracking || !state) { console.warn('[Bosta] payload missing'); return; }

  console.log(`[Bosta] ${tracking} -> ${state}`);

  // فقط الحالات النهائية تهمنا
  if (!isDelivered(state) && !isReturned(state)) return;

  // dedup: منعنا re-processing لنفس tracking+state
  const processedKey = `processed_${tracking}_${state}`;
  if (await store.getSignal(processedKey)) {
    console.log(`[Bosta] already processed`);
    return;
  }

  await processBostaShipment(tracking, state, processedKey);
});

// 5) /health
app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    storage: getRedis() ? 'redis' : 'memory',
    orders: await store.orderCount(),
    tracking: await store.trackingCount(),
    uptime: Math.floor(process.uptime()) + 's',
  });
});

// ══════════════════════════════════════════════════════════
// CORE LOGIC
// ══════════════════════════════════════════════════════════

async function handleNewOrder(order) {
  console.log(`[New Order] ${order.id.slice(-8)} -- ${order.full_name} -- ${order.total_cost} EGP`);

  // اجلب signals (من link-session أو time-based)
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

  // احفظ الأوردر بكل البيانات التحسينية
  await store.setOrder(order.id, {
    orderId:    order.id,
    totalCost:  order.total_cost,
    phone:      order.phone,
    email:      order.email      || null,         // ✓ يحسّن EMQ
    fullName:   order.full_name  || '',
    city:       order.government || '',
    cartItems:  order.cart_items || [],           // ✓ content_ids
    createdAt:  order.created_at || new Date().toISOString(),
    signals,                                       // ✓ fbp/fbc/ip/userAgent
  });
}

/**
 * المنطق الجوهري الجديد:
 * - نسأل Bosta API للحصول على كل البيانات
 * - نحاول إيجاد الأوردر في Redis لتحسين البيانات (fbp/fbc/email/content_ids/order_id)
 * - نبعت Event لـ Meta مهما كان
 */
async function processBostaShipment(tracking, state, processedKey) {
  // اجلب البيانات الكاملة من Bosta API
  const bosta = await fetchBostaDelivery(tracking);
  if (!bosta) {
    console.warn(`[Bosta] couldn't fetch delivery for ${tracking}`);
    return;
  }

  console.log(`[Bosta API] phone:${bosta.phone} city:${bosta.city} cod:${bosta.cod}`);

  // طبّق dedup هنا (أنشأناه بعد جلب البيانات لأن الـ Bosta API call قد يفشل)
  await rSet(`sig:${processedKey}`, { ts: Date.now() }, CONFIG.PROCESSED_TTL);

  // ابحث عن الأوردر في Redis لإضافة بيانات تحسينية
  let enrichment = null;
  const normPhone = normalizePhone(bosta.phone);

  // أولاً: عبر tracking number (لو ربطناه قبل)
  let orderId = await store.getTracking(tracking);
  if (orderId) enrichment = await store.getOrder(orderId);

  // ثانياً: عبر businessReference (لو Bosta بيرجعها كـ Easy Orders order_id)
  if (!enrichment && bosta.businessReference) {
    const byRef = await store.getOrder(bosta.businessReference);
    if (byRef) {
      enrichment = byRef;
      orderId = bosta.businessReference;
      await store.setTracking(tracking, orderId);
      console.log(`[Match] by businessReference -> ${orderId.slice(-8)}`);
    }
  }

  // ثالثاً: عبر phone (للأوردرات اللي مالهاش tracking مسجل)
  if (!enrichment && normPhone) {
    const allOrders = await store.getAllOrders();
    for (const o of allOrders) {
      if (normalizePhone(o.phone) === normPhone) {
        enrichment = o;
        orderId = o.orderId;
        await store.setTracking(tracking, orderId);
        console.log(`[Match] by phone -> ${orderId.slice(-8)}`);
        break;
      }
    }
  }

  if (enrichment) {
    console.log(`[Enrich] email:${enrichment.email?'v':'x'} fbp:${enrichment.signals?.fbp?'v':'x'} content_ids:${enrichment.cartItems?.length || 0}`);
  } else {
    console.log(`[Enrich] no Redis match -- will send Bosta data only`);
  }

  // ابعت Event لـ Meta
  if (isDelivered(state)) {
    await sendMetaEvent('Delivery', bosta, enrichment, tracking);
  } else if (isReturned(state)) {
    await sendMetaEvent('OrderReturned', bosta, enrichment, tracking, state);
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
      updateDate:        d?.updatedAt || null,
    };
  } catch (e) {
    console.error('[Bosta API] error:', e.message);
    return null;
  }
}

async function sendMetaEvent(eventName, bosta, enrichment, tracking, returnReason) {
  // ─── User Data: Bosta + enrichment ───
  const phone     = bosta.phone || enrichment?.phone;
  const firstName = bosta.firstName || enrichment?.fullName?.split(' ')[0]              || '';
  const lastName  = bosta.lastName  || enrichment?.fullName?.split(' ').slice(1).join(' ') || '';
  const city      = bosta.city      || enrichment?.city;
  const email     = enrichment?.email; // Email من Easy Orders فقط
  const fbp       = enrichment?.signals?.fbp;
  const fbc       = enrichment?.signals?.fbc;
  const clientIp  = enrichment?.signals?.clientIp;
  const userAgent = enrichment?.signals?.userAgent;

  // ─── Custom Data: Bosta + enrichment ───
  const value       = bosta.cod || enrichment?.totalCost;
  const contentIds  = enrichment?.cartItems?.map(i => i.product_id) || [];
  const orderId     = enrichment?.orderId || bosta.businessReference || tracking;
  const deliveryDays = enrichment?.createdAt
    ? Math.round((Date.now() - new Date(enrichment.createdAt).getTime()) / 86400000)
    : null;

  // ─── Event ID للـ deduplication ───
  // نستخدم order_id لو متوفر، وإلا tracking
  const eventId = `${eventName.toLowerCase()}_${orderId}`;

  const payload = {
    data: [{
      event_name:    eventName,
      event_time:    Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id:      eventId,
      user_data: {
        em:                email     ? [sha256(email)]                     : undefined,
        ph:                phone     ? [sha256(phoneForMeta(phone))]       : undefined,
        fn:                firstName ? [sha256(firstName)]                 : undefined,
        ln:                lastName  ? [sha256(lastName)]                  : undefined,
        ct:                city      ? [sha256(city.toLowerCase())]        : undefined,
        country:           [sha256('eg')],
        external_id:       orderId   ? [sha256(orderId)]                   : undefined,  // ✓ extra EMQ
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
        ...(returnReason ? { return_reason: String(returnReason) } : {}),
      },
    }],
  };

  try {
    const url = `${CONFIG.META_CAPI_BASE}/${CONFIG.META_PIXEL_ID}/events?access_token=${CONFIG.META_CAPI_TOKEN}`;
    const res = await apiCall('POST', url, JSON.parse(JSON.stringify(payload)));
    console.log(`[Meta] ${eventName} -> ${res.status} events_received:${res.body?.events_received ?? '?'} event_id:${eventId}`);
    if (res.status !== 200) {
      console.warn(`[Meta] response body:`, JSON.stringify(res.body).slice(0, 300));
    }
  } catch (e) {
    console.error(`[Meta] ${eventName} error:`, e.message);
  }
}

// ──────────────────────────────────────────────────────────
// Polling: كل ساعة، فحص آخر الشحنات من Bosta
// ──────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 60 * 60 * 1000;
const POLL_PAGE_LIMIT  = 50;
const POLL_MAX_PAGES   = 10;
let pollRunning = false;

async function pollBostaDeliveries() {
  if (pollRunning) { console.log('[Poll] dropped - previous cycle running'); return; }
  pollRunning = true;
  console.log('[Poll] ===== Starting Bosta poll =====');
  let totalScanned = 0, totalSent = 0;

  try {
    for (let page = 0; page < POLL_MAX_PAGES; page++) {
      const url = `${CONFIG.BOSTA_BASE}/deliveries/search`;
      const body = { pageNumber: page, pageLimit: POLL_PAGE_LIMIT };
      const res = await apiCall('POST', url, body, { 'Authorization': CONFIG.BOSTA_API_KEY });
      if (res.status !== 200) { console.warn(`[Poll] page ${page} -> ${res.status}`); break; }

      const deliveries = res.body?.data?.deliveries || [];
      if (!deliveries.length) break;
      console.log(`[Poll] Page ${page}: ${deliveries.length} deliveries`);

      for (const d of deliveries) {
        totalScanned++;
        const tracking = d.trackingNumber || d._id;
        const state    = d.state?.code ?? d.state?.value ?? d.state ?? 0;

        if (!isDelivered(state) && !isReturned(state)) continue;

        const processedKey = `processed_${tracking}_${state}`;
        if (await store.getSignal(processedKey)) continue;

        await processBostaShipment(tracking, state, processedKey);
        totalSent++;
      }
    }
  } catch (e) {
    console.error('[Poll] error:', e.message);
  } finally {
    pollRunning = false;
  }

  console.log(`[Poll] ===== Done: scanned ${totalScanned}, sent ${totalSent} =====`);
}

setInterval(pollBostaDeliveries, POLL_INTERVAL_MS);
setTimeout(pollBostaDeliveries, 2 * 60 * 1000);

app.post('/admin/poll', (req, res) => {
  res.json({ started: true, alreadyRunning: pollRunning });
  pollBostaDeliveries();
});

// ──────────────────────────────────────────────────────────

/**
 * test-pagination.js
 * ===================
 * يثبت قطعياً: هل Bosta pagination يعمل أم لا؟
 *
 * Usage: GET /admin/test-pagination
 */

app.get('/admin/test-pagination', async (req, res) => {
  const url = `${CONFIG.BOSTA_BASE}/deliveries/search`;
  const headers = { 'Authorization': CONFIG.BOSTA_API_KEY };

  console.log(`\n===== [PAGINATION TEST] =====`);

  const tests = [
    { name: 'pageNumber:0',  body: { pageNumber: 0, pageLimit: 10 } },
    { name: 'pageNumber:1',  body: { pageNumber: 1, pageLimit: 10 } },
    { name: 'pageNumber:2',  body: { pageNumber: 2, pageLimit: 10 } },
    { name: 'page:0',        body: { page: 0, limit: 10 } },
    { name: 'page:1',        body: { page: 1, limit: 10 } },
    { name: 'offset:0',      body: { offset: 0, limit: 10 } },
    { name: 'offset:10',     body: { offset: 10, limit: 10 } },
    { name: 'offset:20',     body: { offset: 20, limit: 10 } },
    { name: 'skip:0',        body: { skip: 0, limit: 10 } },
    { name: 'skip:10',       body: { skip: 10, limit: 10 } },
    { name: 'from:0',        body: { from: 0, size: 10 } },
    { name: 'from:10',       body: { from: 10, size: 10 } },
  ];

  const results = [];
  for (const t of tests) {
    try {
      const r = await apiCall('POST', url, t.body, headers);
      const deliveries = r.body?.data?.deliveries || [];
      const firstIds = deliveries.slice(0, 3).map(d => d._id || d.trackingNumber);
      console.log(`[PAG] ${t.name.padEnd(18)} count:${deliveries.length} first3: ${firstIds.join(', ')}`);
      results.push({ name: t.name, body: t.body, count: deliveries.length, firstIds });
    } catch (e) {
      console.log(`[PAG] ${t.name} ERROR: ${e.message}`);
    }
  }

  // مقارنة: هل الـ first IDs مختلفة بين الصفحات؟
  const findById = (name) => results.find(r => r.name === name)?.firstIds?.[0];
  const pageNum0 = findById('pageNumber:0');
  const pageNum1 = findById('pageNumber:1');
  const offset0  = findById('offset:0');
  const offset10 = findById('offset:10');

  const verdict = {
    pageNumber_works: pageNum0 && pageNum1 && pageNum0 !== pageNum1,
    offset_works:     offset0  && offset10 && offset0  !== offset10,
  };

  console.log(`\n===== VERDICT =====`);
  console.log(`pageNumber works: ${verdict.pageNumber_works ? '✓ YES' : '✗ NO'}`);
  console.log(`offset works:     ${verdict.offset_works     ? '✓ YES' : '✗ NO'}`);
  console.log(`===================\n`);

  res.json({ verdict, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nCOD Meta Tracking v5.0 -- Port ${PORT}`);
  console.log(`Storage: ${getRedis() ? 'Redis' : 'Memory'}`);
  console.log(`Bosta = source of truth, Redis = enrichment\n`);
});

module.exports = app;
