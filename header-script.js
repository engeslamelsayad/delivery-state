/**
 * index.js — COD Meta Tracking System
 * =====================================
 * Easy Orders + Bosta + Meta CAPI
 * الملف الرئيسي — يخدّم header-script.js كـ static file
 */

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const path    = require('path');

const app = express();

// ── Static Files — يخدّم header-script.js مباشرة ──────────
// URL: https://your-server.com/header-script.js
app.use(express.static(path.join(__dirname), {
  // اخدم .js files فقط من الجذر
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'public, max-age=3600'); // cache ساعة
    }
  }
}));

app.use(express.json());

// ── CORS ──────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://www.cosmoeg.shop',
  'https://cosmoeg.shop',
  'https://www.eecm.shop',
  'https://eecm.shop',
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Config ─────────────────────────────────────────────────
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

  SIGNAL_TTL_MS:        4 * 60 * 60 * 1000,
};

// ── In-Memory Stores ───────────────────────────────────────
const signalStore  = new Map(); // sessionId   → signals
const orderStore   = new Map(); // orderId     → orderData
const trackingMap  = new Map(); // trackingNum → orderId

// cleanup كل 30 دقيقة
setInterval(() => {
  const cutoff = Date.now() - CONFIG.SIGNAL_TTL_MS;
  for (const [k, v] of signalStore) {
    if (v.ts && v.ts < cutoff) signalStore.delete(k);
  }
}, 30 * 60 * 1000);

// ── Helpers ────────────────────────────────────────────────
const sha256 = v =>
  v ? crypto.createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex') : undefined;

const normalizePhone = p => {
  if (!p) return p;
  const d = p.replace(/\D/g, '');
  if (d.startsWith('01'))  return '2' + d;
  if (d.startsWith('201')) return d;
  return d;
};

const isDelivered = s =>
  ['delivered','DELIVERED','45',45,'RECEIVED_BY_CUSTOMER'].includes(s);

const isReturned = s =>
  ['returned','RETURNED','NOT_RECEIVED','WAITING_TO_RETURN',
   '46',46,'47',47,'RETURN_VERIFIED'].includes(s);

const calcDeliveryDays = createdAt =>
  Math.round((Date.now() - new Date(createdAt).getTime()) / 86400000);

const getClientIp = req =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim()
  || req.headers['x-real-ip']
  || req.socket?.remoteAddress
  || null;

const mapCity = city => ({
  'القاهرة':'Cairo','الجيزة':'Giza','الإسكندرية':'Alex',
  'المنصورة':'Mansoura','أسيوط':'Assiut','المنيا':'Minya',
  'سوهاج':'Sohag','أسوان':'Aswan','الأقصر':'Luxor',
  'الإسماعيلية':'Ismailia','السويس':'Suez','بورسعيد':'PortSaid',
  'الشرقية':'Sharqia','الدقهلية':'Dakahlia',
  'الغربية':'Gharbia','القليوبية':'Qalyubia',
}[city] || city);

function apiCall(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data   = body ? JSON.stringify(body) : null;
    const req    = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════
// ENDPOINT 1 — POST /collect-signals
// يستقبل _fbp و _fbc من المتصفح
// ══════════════════════════════════════════════════════════
app.post('/collect-signals', (req, res) => {
  const { sessionId, fbp, fbc, userAgent, pageUrl } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  signalStore.set(sessionId, {
    fbp:       fbp       || null,
    fbc:       fbc       || null,
    clientIp:  getClientIp(req),
    userAgent: userAgent || req.headers['user-agent'] || null,
    pageUrl:   pageUrl   || null,
    ts:        Date.now(),
  });

  console.log(`[Signals] ${sessionId.slice(-8)} fbp:${fbp?'✓':'✗'} fbc:${fbc?'✓':'✗'}`);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
// ENDPOINT 2 — POST /link-session
// يربط sessionId بـ orderId بعد صفحة /thanks
// ══════════════════════════════════════════════════════════
app.post('/link-session', (req, res) => {
  const { orderId, sessionId } = req.body;
  if (!orderId || !sessionId) {
    return res.status(400).json({ error: 'orderId and sessionId required' });
  }

  // لو الـ webhook وصل قبل الـ link — أضف الـ signals للأوردر مباشرة
  if (orderStore.has(orderId)) {
    const order    = orderStore.get(orderId);
    order.signals  = signalStore.get(sessionId) || {};
    console.log(`[Link] Late-link signals → order ${orderId.slice(-8)}`);
  }

  // احفظ الربط للاستخدام لما الـ webhook يوصل بعدين
  signalStore.set('link_' + orderId, { sessionId, ts: Date.now() });
  console.log(`[Link] session → order ${orderId.slice(-8)}`);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
// ENDPOINT 3 — POST /webhook/easy-orders
// يستقبل أحداث Easy Orders (طلب جديد، تغيير حالة)
// ══════════════════════════════════════════════════════════
app.post('/webhook/easy-orders', async (req, res) => {
  // التحقق من الـ Secret
  if (req.headers['secret'] !== CONFIG.EASY_ORDERS_SECRET) {
    console.warn('[EasyOrders] ❌ Secret مش صح');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ردّ فوري على Easy Orders (مهم — لو تأخرنا قد يعيد الإرسال)
  res.json({ received: true });

  const payload = req.body;

  // طلب جديد
  if (payload.status === 'pending' && payload.id) {
    await handleNewOrder(payload, req);
    return;
  }

  // تغيير حالة
  if (payload.event_type === 'order-status-update') {
    console.log(`[EasyOrders] ${payload.order_id} ${payload.old_status} → ${payload.new_status}`);
  }
});

// ══════════════════════════════════════════════════════════
// ENDPOINT 5 — POST /webhook/bosta
// يستقبل تحديثات حالة الشحنة من Bosta
// هذا مصدر OrderDelivered الحقيقي في COD
// ══════════════════════════════════════════════════════════
app.post('/webhook/bosta', async (req, res) => {
  res.json({ received: true }); // ردّ فوري دايماً

  const p = req.body;
  const trackingNumber = String(
    p.tracking_number || p.trackingNumber || p._id || ''
  );
  const state = p.state || p.status || p.currentStatus?.state || '';

  if (!trackingNumber || !state) {
    console.warn('[Bosta] payload ناقص:', JSON.stringify(p).slice(0, 100));
    return;
  }

  console.log(`[Bosta] ${trackingNumber} → ${state}`);

  // ── البحث عن الأوردر ─────────────────────────────────────
  // محاولة 1: عبر trackingNumber (لو ربطناه قبل كده)
  let orderId   = trackingMap.get(trackingNumber);
  let orderData = orderId ? orderStore.get(orderId) : null;

  // محاولة 2: عبر رقم الهاتف (الربط التلقائي)
  if (!orderData) {
    const bostaPhone = normalizePhone(
      p.receiver?.phone ||
      p.dropOffAddress?.phone ||
      p.phone || ''
    );

    if (bostaPhone) {
      for (const [id, data] of orderStore) {
        if (normalizePhone(data.phone) === bostaPhone) {
          orderData = data;
          orderId   = id;
          // احفظ الربط عشان المرة الجاية يكون أسرع
          trackingMap.set(trackingNumber, id);
          console.log(`[Bosta] ربط تلقائي عبر الهاتف: ${bostaPhone} → order ${id.slice(-8)}`);
          break;
        }
      }
    }
  }

  if (!orderData) {
    console.warn(`[Bosta] مفيش أوردر للـ tracking: ${trackingNumber}`);
    // احفظ الـ payload مؤقتاً لو الأوردر لم يصل بعد
    signalStore.set('bosta_pending_' + trackingNumber, { p, state, ts: Date.now() });
    return;
  }

  await handleBostaStatusUpdate(state, orderData);
});

// ── Health Check ───────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  ok:       true,
  signals:  signalStore.size,
  orders:   orderStore.size,
  tracking: trackingMap.size,
  uptime:   Math.floor(process.uptime()) + 's',
}));

// ══════════════════════════════════════════════════════════
// HANDLERS
// ══════════════════════════════════════════════════════════
async function handleNewOrder(order, req) {
  console.log(`[New Order] ${order.id.slice(-8)} — ${order.full_name} — ${order.total_cost} EGP`);

  // ── البحث عن الـ signals بثلاث طرق ──────────────────────

  // طريقة 1: link-session وصل قبل الـ webhook
  const linkRecord = signalStore.get('link_' + order.id);
  const sessionId  = linkRecord?.sessionId || null;
  let signals      = sessionId ? (signalStore.get(sessionId) || {}) : {};

  // طريقة 2: ابحث عن آخر signal وصل خلال آخر 3 دقائق
  // (العميل فتح الصفحة ثم أكمل الطلب مباشرة)
  if (!signals.fbp && !signals.fbc) {
    const cutoff = Date.now() - (3 * 60 * 1000); // 3 دقائق
    let   latest = null;
    let   latestTs = 0;

    for (const [key, val] of signalStore) {
      // تجاهل records الـ link و bosta_pending
      if (key.startsWith('link_') || key.startsWith('bosta_')) continue;
      if (val.ts && val.ts > cutoff && val.ts > latestTs) {
        latest   = val;
        latestTs = val.ts;
      }
    }

    if (latest) {
      signals = latest;
      console.log(`[Signals] تطابق بالوقت — آخر signal: ${Math.round((Date.now()-latestTs)/1000)}s مضت`);
    }
  }

  console.log(`[Signals] fbp:${signals.fbp?'✓':'✗'} fbc:${signals.fbc?'✓':'✗'} ip:${signals.clientIp?'✓':'✗'}`);

  // حفظ الأوردر
  orderStore.set(order.id, {
    orderId:   order.id,
    totalCost: order.total_cost,
    phone:     order.phone,
    email:     order.email,
    fullName:  order.full_name,
    city:      order.government,
    cartItems: order.cart_items || [],
    createdAt: new Date().toISOString(),
    signals,
  });

  // Purchase يُبعث تلقائياً من Easy Orders عبر Pixel — لا نبعته هنا لتجنب التكرار

  // ── الشحنة تُنشأ يدوياً على Bosta ──
  // السيرفر سيستقبل التحديثات تلقائياً عبر /webhook/bosta
  console.log(`[System] انتظار إنشاء الشحنة يدوياً على Bosta للأوردر ${order.id.slice(-8)}`);
}

async function handleBostaStatusUpdate(state, orderData) {
  const { orderId, totalCost, phone, email, fullName, city,
          cartItems, createdAt, signals = {} } = orderData;

  const userData = { phone, email, name: fullName, city,
    fbp: signals.fbp, fbc: signals.fbc,
    clientIp: signals.clientIp, userAgent: signals.userAgent };

  if (isDelivered(state)) {
    console.log(`[Delivered] order ${orderId.slice(-8)} — ${totalCost} EGP محصّلة`);

    await sendMetaEvent('Delivery', {
      order_id:       orderId,
      value:          totalCost,
      currency:       'EGP',
      content_ids:    cartItems?.map(i => i.product_id) || [],
      content_type:   'product',
      payment_method: 'cod',
      delivery_city:  city,
      delivery_days:  calcDeliveryDays(createdAt),
    }, userData, `delivered_${orderId}`);

    await updateEasyOrdersStatus(orderId, 'delivered');

  } else if (isReturned(state)) {
    console.log(`[Returned] order ${orderId.slice(-8)}`);

    await sendMetaEvent('OrderReturned', {
      order_id:      orderId,
      value:         totalCost,
      currency:      'EGP',
      return_reason: state,
    }, userData, `returned_${orderId}`);

    await updateEasyOrdersStatus(orderId, 'returned');
  }
}

// ══════════════════════════════════════════════════════════
// INTEGRATIONS
// ══════════════════════════════════════════════════════════
async function createBostaShipment(order) {
  try {
    const res = await apiCall('POST', `${CONFIG.BOSTA_BASE}/deliveries`, {
      type: 10,
      specs: {
        size: 'SMALL',
        packageDetails: {
          itemsCount:  order.cart_items?.length || 1,
          description: order.cart_items?.map(i => i.product?.name).join(', ') || 'Order',
        },
      },
      cod: order.total_cost,
      dropOffAddress: {
        city:      mapCity(order.government),
        firstLine: order.address,
        phone:     order.phone,
      },
      receiver: {
        firstName: order.full_name?.split(' ')[0]                   || order.full_name,
        lastName:  order.full_name?.split(' ').slice(1).join(' ')   || '',
        phone:     order.phone,
      },
      notes: `EasyOrders: ${order.id}`,
    }, { Authorization: CONFIG.BOSTA_API_KEY });

    console.log('[Bosta] Create:', res.status);
    return res.body?.data || res.body;
  } catch (e) {
    console.error('[Bosta] Error:', e.message);
    return null;
  }
}

async function updateEasyOrdersStatus(orderId, status) {
  try {
    await apiCall(
      'PATCH',
      `${CONFIG.EASY_ORDERS_BASE}/external-apps/orders/${orderId}`,
      { status },
      { 'Api-Key': CONFIG.EASY_ORDERS_API_KEY }
    );
  } catch (e) {
    console.error('[EasyOrders] Update error:', e.message);
  }
}

async function sendMetaEvent(eventName, customData, userData, eventId) {
  const payload = {
    data: [{
      event_name:    eventName,
      event_time:    Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id:      eventId,
      user_data: {
        em:                userData.email     ? [sha256(userData.email)]                               : undefined,
        ph:                userData.phone     ? [sha256(normalizePhone(userData.phone))]               : undefined,
        fn:                userData.name      ? [sha256(userData.name.split(' ')[0])]                  : undefined,
        ln:                userData.name      ? [sha256(userData.name.split(' ').slice(1).join(' '))]  : undefined,
        ct:                userData.city      ? [sha256(userData.city.toLowerCase())]                  : undefined,
        country:           [sha256('eg')],
        fbp:               userData.fbp       || undefined,
        fbc:               userData.fbc       || undefined,
        client_ip_address: userData.clientIp  || undefined,
        client_user_agent: userData.userAgent || undefined,
      },
      custom_data: customData,
    }],
  };

  const clean = JSON.parse(JSON.stringify(payload));

  try {
    const url = `${CONFIG.META_CAPI_BASE}/${CONFIG.META_PIXEL_ID}/events?access_token=${CONFIG.META_CAPI_TOKEN}`;
    const res = await apiCall('POST', url, clean);
    console.log(`[Meta] ${eventName} → ${res.status} events_received:${res.body?.events_received ?? '?'}`);
  } catch (e) {
    console.error(`[Meta] ${eventName} error:`, e.message);
  }
}

// ══════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║   COD Meta Tracking — Running ✓       ║`);
  console.log(`╠═══════════════════════════════════════╣`);
  console.log(`║  Static: /header-script.js             ║`);
  console.log(`║  POST  : /collect-signals              ║`);
  console.log(`║  POST  : /link-session                 ║`);
  console.log(`║  POST  : /webhook/easy-orders          ║`);
  console.log(`║  POST  : /webhook/bosta                ║`);
  console.log(`║  GET   : /health                       ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);
});

module.exports = app;
