/**
 * index.js — COD Meta Tracking System v4.0
 * ==========================================
 * Easy Orders + Bosta + Meta CAPI + Redis
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
  EASY_ORDERS_API_KEY:  process.env.EASY_ORDERS_API_KEY  || '',
  EASY_ORDERS_STORE_ID: process.env.EASY_ORDERS_STORE_ID || '',
  EASY_ORDERS_BASE:     'https://api.easy-orders.net/api/v1',
  BOSTA_API_KEY:        process.env.BOSTA_API_KEY        || '',
  BOSTA_BASE:           'https://app.bosta.co/api/v2',
  META_PIXEL_ID:        process.env.META_PIXEL_ID        || '',
  META_CAPI_TOKEN:      process.env.META_CAPI_TOKEN      || '',
  META_CAPI_BASE:       'https://graph.facebook.com/v19.0',
  REDIS_URL:            process.env.REDIS_URL            || '',
  SIGNAL_TTL:    4  * 60 * 60,
  ORDER_TTL:     10 * 24 * 60 * 60,
  TRACKING_TTL:  10 * 24 * 60 * 60,
};

// Redis
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

// In-Memory Fallback
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
  async scanSignals(prefix) {
    const all = await this.getAllSignals();
    return all.filter(({ key }) => key.startsWith(prefix));
  },
  async orderCount()   { return getRedis() ? (await rKeys('order:*')).length   : mem.orders.size; },
  async trackingCount(){ return getRedis() ? (await rKeys('track:*')).length   : mem.tracking.size; },
};

// Helpers
const sha256 = v => v ? crypto.createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex') : undefined;
const normalizePhone = p => { if (!p) return p; let d = p.replace(/\D/g,''); if (d.startsWith('20') && d.length === 12) d = d.slice(2); if (!d.startsWith('0') && d.length === 10) d = '0' + d; return d; };
const phoneForMeta = p => { const n = normalizePhone(p); if (!n) return n; return n.startsWith('0') ? '2' + n : n; };
const isDelivered = s => [45, '45', 'delivered', 'DELIVERED'].includes(s);
const isReturned  = s => [46, '46', 48, '48', 49, '49', 100, '100', 101, '101', 'returned', 'RETURNED'].includes(s);
const calcDeliveryDays = c => Math.round((Date.now() - new Date(c).getTime()) / 86400000);
const getClientIp = req => req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.socket?.remoteAddress || null;

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

// ENDPOINTS
app.post('/collect-signals', async (req, res) => {
  const { sessionId, fbp, fbc, userAgent, pageUrl } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  await store.setSignal(sessionId, { fbp: fbp||null, fbc: fbc||null, clientIp: getClientIp(req), userAgent: userAgent||req.headers['user-agent']||null, pageUrl: pageUrl||null, ts: Date.now() });
  console.log(`[Signals] ${sessionId.slice(-8)} fbp:${fbp?'v':'x'} fbc:${fbc?'v':'x'}`);
  res.json({ ok: true });
});

app.post('/link-session', async (req, res) => {
  const { orderId, sessionId } = req.body;
  if (!orderId || !sessionId) return res.status(400).json({ error: 'orderId and sessionId required' });
  const order = await store.getOrder(orderId);
  if (order) { order.signals = await store.getSignal(sessionId) || {}; await store.setOrder(orderId, order); console.log(`[Link] Late-link → order ${orderId.slice(-8)}`); }
  await store.setSignal('link_' + orderId, { sessionId, ts: Date.now() });
  console.log(`[Link] session → order ${orderId.slice(-8)}`);
  res.json({ ok: true });
});

app.post('/webhook/easy-orders', async (req, res) => {
  if (req.headers['secret'] !== CONFIG.EASY_ORDERS_SECRET) { console.warn('[EasyOrders] Secret wrong'); return res.status(401).json({ error: 'Unauthorized' }); }
  res.json({ received: true });
  const payload = req.body;
  if (payload.status === 'pending' && payload.id) await handleNewOrder(payload, req);
  else if (payload.event_type === 'order-status-update') console.log(`[EasyOrders] ${payload.order_id} ${payload.old_status} -> ${payload.new_status}`);
});

app.post('/webhook/bosta', async (req, res) => {
  res.json({ received: true });
  const p = req.body;
  const trackingNumber = String(p.tracking_number || p.trackingNumber || p._id || '');
  const state = p.state || p.status || p.currentStatus?.state || '';
  if (!trackingNumber || !state) { console.warn('[Bosta] payload missing'); return; }
  console.log(`[Bosta] ${trackingNumber} -> ${state}`);

  let orderId   = await store.getTracking(trackingNumber);
  let orderData = orderId ? await store.getOrder(orderId) : null;

  // Bosta webhook لا يحتوي على رقم الهاتف — نستدعي Bosta API
  if (!orderData) {
    const bostaDelivery = await fetchBostaDelivery(trackingNumber);
    if (bostaDelivery) {
      const bostaPhone = normalizePhone(bostaDelivery.phone);
      console.log(`[Bosta API] phone: ${bostaPhone}`);

      if (bostaPhone) {
        // محاولة 1: ابحث في Redis
        const allOrders = await store.getAllOrders();
        for (const data of allOrders) {
          if (normalizePhone(data.phone) === bostaPhone) {
            orderData = data;
            orderId   = data.orderId;
            await store.setTracking(trackingNumber, orderId);
            console.log(`[Bosta] ربط من Redis: ${bostaPhone} -> order ${orderId.slice(-8)}`);
            break;
          }
        }

        // محاولة 2: لو مش موجود في Redis، اسأل Easy Orders API
        if (!orderData) {
          console.log(`[Bosta] البحث في Easy Orders بالهاتف: ${bostaPhone}`);
          orderData = await fetchOrderFromEasyOrders(bostaPhone);
          if (orderData) {
            orderId = orderData.orderId;
            await store.setOrder(orderId, orderData);
            await store.setTracking(trackingNumber, orderId);
            console.log(`[Bosta] وجد من Easy Orders: ${orderId.slice(-8)}`);
          }
        }
      }
    }
  }

  if (!orderData) {
    console.warn(`[Bosta] no order for tracking: ${trackingNumber}`);
    await store.setSignal('bosta_pending_' + trackingNumber, { p, state, ts: Date.now() });
    return;
  }
  await handleBostaStatusUpdate(state, orderData);
});

app.get('/health', async (req, res) => {
  res.json({ ok: true, storage: getRedis() ? 'redis' : 'memory', orders: await store.orderCount(), tracking: await store.trackingCount(), uptime: Math.floor(process.uptime()) + 's' });
});

// HANDLERS
async function handleNewOrder(order, req) {
  console.log(`[New Order] ${order.id.slice(-8)} -- ${order.full_name} -- ${order.total_cost} EGP`);

  const linkRecord = await store.getSignal('link_' + order.id);
  const sessionId  = linkRecord?.sessionId || null;
  let signals      = sessionId ? (await store.getSignal(sessionId) || {}) : {};

  if (!signals.fbp && !signals.fbc) {
    const cutoff = Date.now() - (3 * 60 * 1000);
    let latest = null, latestTs = 0;
    const allSigs = await store.getAllSignals();
    for (const { key, val } of allSigs) {
      if (key.startsWith('link_') || key.startsWith('bosta_')) continue;
      if (val.ts && val.ts > cutoff && val.ts > latestTs) { latest = val; latestTs = val.ts; }
    }
    if (latest) { signals = latest; console.log(`[Signals] time-match: ${Math.round((Date.now()-latestTs)/1000)}s ago`); }
  }

  console.log(`[Signals] fbp:${signals.fbp?'v':'x'} fbc:${signals.fbc?'v':'x'} ip:${signals.clientIp?'v':'x'}`);

  await store.setOrder(order.id, {
    orderId: order.id, totalCost: order.total_cost, phone: order.phone,
    email: order.email, fullName: order.full_name, city: order.government,
    cartItems: order.cart_items || [], createdAt: new Date().toISOString(), signals,
  });

  console.log(`[System] waiting for Bosta shipment for order ${order.id.slice(-8)}`);

  const phone = normalizePhone(order.phone);
  const pending = await store.scanSignals('bosta_pending_');
  for (const { key, val } of pending) {
    const pp = normalizePhone(val.p?.receiver?.phone || val.p?.dropOffAddress?.phone || val.p?.phone || '');
    if (pp && pp === phone) {
      console.log(`[Bosta] processing pending webhook for order ${order.id.slice(-8)}`);
      await store.delSignal(key);
      await handleBostaStatusUpdate(val.state, await store.getOrder(order.id));
      break;
    }
  }
}

async function handleBostaStatusUpdate(state, orderData) {
  const { orderId, totalCost, phone, email, fullName, city, cartItems, createdAt, signals = {} } = orderData;
  const userData = { phone, email, name: fullName, city, fbp: signals.fbp, fbc: signals.fbc, clientIp: signals.clientIp, userAgent: signals.userAgent };

  if (isDelivered(state)) {
    console.log(`[Delivered] order ${orderId.slice(-8)} -- ${totalCost} EGP`);
    await sendMetaEvent('Delivery', { order_id: orderId, value: totalCost, currency: 'EGP', content_ids: cartItems?.map(i => i.product_id)||[], content_type: 'product', payment_method: 'cod', delivery_city: city, delivery_days: calcDeliveryDays(createdAt) }, userData, `delivered_${orderId}`);
    await updateEasyOrdersStatus(orderId, 'delivered');
  } else if (isReturned(state)) {
    console.log(`[Returned] order ${orderId.slice(-8)}`);
    await sendMetaEvent('OrderReturned', { order_id: orderId, value: totalCost, currency: 'EGP', return_reason: state }, userData, `returned_${orderId}`);
    await updateEasyOrdersStatus(orderId, 'returned');
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
      phone: d?.receiver?.phone || d?.receiver?.secondPhone || null,
      receiver: d?.receiver || null,
      businessReference: d?.businessReference || null,
      cod: d?.cod || null,
    };
  } catch (e) {
    console.error('[Bosta API] fetchDelivery error:', e.message);
    return null;
  }
}

async function fetchOrderFromEasyOrders(phone) {
  try {
    const url = `${CONFIG.EASY_ORDERS_BASE}/external-apps/orders?store_id=${CONFIG.EASY_ORDERS_STORE_ID}&phone=${encodeURIComponent(phone)}&limit=5&sort=created_at&direction=desc`;
    console.log(`[EasyOrders DEBUG] URL: ${url}`);
    const res = await apiCall('GET', url, null, { 'Api-Key': CONFIG.EASY_ORDERS_API_KEY });
    console.log(`[EasyOrders DEBUG] status: ${res.status}`);
    console.log(`[EasyOrders DEBUG] body: ${JSON.stringify(res.body).slice(0, 500)}`);
    if (res.status !== 200) return null;

    // الـ API قد يرجع البيانات في data أو orders أو نفس الـ root
    const orders = res.body?.data || res.body?.orders || res.body?.results || (Array.isArray(res.body) ? res.body : null);
    if (!orders || !orders.length) {
      console.warn('[EasyOrders DEBUG] لا توجد أوردرات بهذا الرقم');
      return null;
    }
    console.log(`[EasyOrders DEBUG] عدد الأوردرات: ${orders.length}`);

    const order = orders[0];
    return {
      orderId:   order.id,
      totalCost: order.total_cost,
      phone:     order.phone,
      email:     order.email     || null,
      fullName:  order.full_name || '',
      city:      order.government || '',
      cartItems: order.cart_items || [],
      createdAt: order.created_at || new Date().toISOString(),
      signals:   {},
    };
  } catch (e) {
    console.error('[EasyOrders] fetchOrder error:', e.message);
    return null;
  }
}

async function updateEasyOrdersStatus(orderId, status) {
  try { await apiCall('PATCH', `${CONFIG.EASY_ORDERS_BASE}/external-apps/orders/${orderId}`, { status }, { 'Api-Key': CONFIG.EASY_ORDERS_API_KEY }); }
  catch (e) { console.error('[EasyOrders] Update error:', e.message); }
}

async function sendMetaEvent(eventName, customData, userData, eventId) {
  const payload = { data: [{ event_name: eventName, event_time: Math.floor(Date.now()/1000), action_source: 'website', event_id: eventId,
    user_data: {
      em: userData.email ? [sha256(userData.email)] : undefined,
      ph: userData.phone ? [sha256(phoneForMeta(userData.phone))] : undefined,
      fn: userData.name  ? [sha256(userData.name.split(' ')[0])] : undefined,
      ln: userData.name  ? [sha256(userData.name.split(' ').slice(1).join(' '))] : undefined,
      ct: userData.city  ? [sha256(userData.city.toLowerCase())] : undefined,
      country: [sha256('eg')],
      fbp: userData.fbp || undefined,
      fbc: userData.fbc || undefined,
      client_ip_address: userData.clientIp  || undefined,
      client_user_agent: userData.userAgent || undefined,
    }, custom_data: customData,
  }]};
  try {
    const url = `${CONFIG.META_CAPI_BASE}/${CONFIG.META_PIXEL_ID}/events?access_token=${CONFIG.META_CAPI_TOKEN}`;
    const res = await apiCall('POST', url, JSON.parse(JSON.stringify(payload)));
    console.log(`[Meta] ${eventName} -> ${res.status} events_received:${res.body?.events_received ?? '?'}`);
  } catch (e) { console.error(`[Meta] ${eventName} error:`, e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nCOD Meta Tracking v4.0 -- Port ${PORT}`);
  console.log(`Storage: ${getRedis() ? 'Redis' : 'Memory'}`);
});

module.exports = app;
