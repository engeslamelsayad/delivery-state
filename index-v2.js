/**
 * index-v2.js — النسخة المحدثة مع دعم _fbp و _fbc
 * =================================================
 * التحديثات عن النسخة الأولى:
 *   1. endpoint جديد POST /collect-signals — يستقبل الـ cookies من المتصفح
 *   2. signalStore — يربط sessionId بـ fbp/fbc/ip/userAgent
 *   3. handleNewOrder — يجلب الـ signals بـ sessionId ويضيفهم للـ CAPI
 *   4. sendMetaEvent — يدعم fbp و fbc و client_ip_address
 *   5. endpoint لحفظ sessionId في Easy Orders Order Notes
 */

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');

const app = express();
app.use(express.json());

// السماح بـ CORS لصفحات Easy Orders (sendBeacon)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Config ────────────────────────────────────────────────
const CONFIG = {
  EASY_ORDERS_SECRET:  process.env.EASY_ORDERS_SECRET  || 'YOUR_EASY_ORDERS_WEBHOOK_SECRET',
  EASY_ORDERS_API_KEY: process.env.EASY_ORDERS_API_KEY || 'YOUR_EASY_ORDERS_API_KEY',
  EASY_ORDERS_STORE_ID:process.env.EASY_ORDERS_STORE_ID|| 'YOUR_STORE_ID',
  EASY_ORDERS_BASE:    'https://api.easy-orders.net/api/v1',

  BOSTA_API_KEY:       process.env.BOSTA_API_KEY        || 'YOUR_BOSTA_API_KEY',
  BOSTA_BASE:          'https://app.bosta.co/api/v2',

  META_PIXEL_ID:       process.env.META_PIXEL_ID        || 'YOUR_PIXEL_ID',
  META_CAPI_TOKEN:     process.env.META_CAPI_TOKEN       || 'YOUR_CAPI_ACCESS_TOKEN',
  META_CAPI_BASE:      'https://graph.facebook.com/v19.0',

  // مدة صلاحية الـ signal في الذاكرة (ساعتين)
  SIGNAL_TTL_MS:       2 * 60 * 60 * 1000,
};

// ─── Stores (في Production استخدم Redis) ───────────────────
// sessionId → { fbp, fbc, ip, userAgent, pageUrl, ts }
const signalStore = new Map();

// trackingNumber → orderData كاملة (مع signals)
const orderStore = new Map();

// ─── Cleanup تلقائي للـ signals القديمة ────────────────────
setInterval(() => {
  const cutoff = Date.now() - CONFIG.SIGNAL_TTL_MS;
  for (const [key, val] of signalStore) {
    if (val.ts < cutoff) signalStore.delete(key);
  }
}, 30 * 60 * 1000); // كل 30 دقيقة

// ─── Utils ─────────────────────────────────────────────────
function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256')
    .update(String(value).toLowerCase().trim())
    .digest('hex');
}

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
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════
// ENDPOINT 1: استقبال Signals من المتصفح
// يُستدعى من storefront-tracker.js عند تحميل صفحة المتجر
// ═══════════════════════════════════════════════════════════
app.post('/collect-signals', (req, res) => {
  const {
    sessionId, fbp, fbc, fbclid,
    userAgent, pageUrl, referrer, ts,
  } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required' });
  }

  // IP الحقيقي من الـ request (أدق من IP المُرسل)
  const clientIp =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    null;

  const signal = {
    fbp:       fbp       || null,
    fbc:       fbc       || null,
    fbclid:    fbclid    || null,
    clientIp,
    userAgent: userAgent || req.headers['user-agent'] || null,
    pageUrl:   pageUrl   || null,
    referrer:  referrer  || null,
    ts:        ts        || Date.now(),
  };

  signalStore.set(sessionId, signal);
  console.log(`[Signals] Saved for session ${sessionId}:`, {
    fbp: signal.fbp ? '✓' : '✗',
    fbc: signal.fbc ? '✓' : '✗',
    ip:  signal.clientIp ? '✓' : '✗',
  });

  res.json({ ok: true, sessionId });
});

// ═══════════════════════════════════════════════════════════
// ENDPOINT 2: Easy Orders Webhook
// يُطلق عند إنشاء طلب جديد أو تغيير حالته
// ═══════════════════════════════════════════════════════════
app.post('/webhook/easy-orders', async (req, res) => {
  const secret = req.headers['secret'];
  if (secret !== CONFIG.EASY_ORDERS_SECRET) {
    console.warn('[EasyOrders] Invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;

  // طلب جديد
  if (payload.status === 'pending' && payload.id) {
    await handleNewOrder(payload, req);
  }

  // تغيير حالة
  if (payload.event_type === 'order-status-update') {
    await handleOrderStatusChange(payload);
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════
// ENDPOINT 3: Bosta Webhook
// يُطلق عند كل تحديث حالة شحنة
// ═══════════════════════════════════════════════════════════
app.post('/webhook/bosta', async (req, res) => {
  const payload        = req.body;
  const trackingNumber = payload.tracking_number || payload.trackingNumber;
  const state          = payload.state || payload.status;

  if (!trackingNumber || !state) return res.json({ received: true });

  const orderData = orderStore.get(trackingNumber);
  if (!orderData) {
    console.warn('[Bosta] No order for tracking:', trackingNumber);
    return res.json({ received: true });
  }

  await handleBostaStatusUpdate(state, orderData);
  res.json({ received: true });
});

// ─── Health Check ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    signals: signalStore.size,
    orders:  orderStore.size,
    time:    new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════

async function handleNewOrder(order, req) {
  console.log(`[System] New order: ${order.id}`);

  // ─ محاولة جلب الـ sessionId من الـ Order ─
  // Easy Orders بيبعت الـ notes في الـ webhook payload أحياناً
  // أو نحاول نجيبها من الـ order notes عبر API
  const sessionId = await getSessionIdFromOrder(order);
  const signals   = sessionId ? (signalStore.get(sessionId) || {}) : {};

  console.log(`[System] Signals for order ${order.id}:`, {
    sessionId: sessionId || 'NOT FOUND',
    fbp: signals.fbp ? '✓' : '✗',
    fbc: signals.fbc ? '✓' : '✗',
  });

  // IP الاحتياطي من الـ request الحالي لو مفيش signals
  const fallbackIp =
    req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
    req?.socket?.remoteAddress;

  // إرسال Purchase Event لـ Meta
  await sendMetaEvent('Purchase', {
    order_id:       order.id,
    value:          order.total_cost,
    currency:       'EGP',
    content_ids:    order.cart_items?.map(i => i.product_id) || [],
    content_type:   'product',
    payment_method: 'cod',
  }, {
    phone:     order.phone,
    email:     order.email,
    name:      order.full_name,
    city:      order.government,
    fbp:       signals.fbp,
    fbc:       signals.fbc,
    clientIp:  signals.clientIp || fallbackIp,
    userAgent: signals.userAgent,
  }, `purchase_${order.id}`);

  // إنشاء شحنة في Bosta
  const shipment = await createBostaShipment(order);
  if (shipment?.trackingNumber) {
    orderStore.set(shipment.trackingNumber, {
      orderId:   order.id,
      totalCost: order.total_cost,
      phone:     order.phone,
      email:     order.email,
      fullName:  order.full_name,
      city:      order.government,
      cartItems: order.cart_items,
      createdAt: new Date().toISOString(),
      // حفظ الـ signals مع الأوردر لاستخدامها عند التسليم
      signals:   signals,
    });
    console.log(`[System] Shipment: ${shipment.trackingNumber}`);
  }
}

async function handleOrderStatusChange(payload) {
  console.log(`[System] Order ${payload.order_id} → ${payload.new_status}`);
}

async function handleBostaStatusUpdate(state, orderData) {
  console.log(`[System] Bosta: ${state} → order ${orderData.orderId}`);
  const signals = orderData.signals || {};

  if (isDelivered(state)) {
    await sendMetaEvent('OrderDelivered', {
      order_id:       orderData.orderId,
      value:          orderData.totalCost,
      currency:       'EGP',
      content_ids:    orderData.cartItems?.map(i => i.product_id) || [],
      content_type:   'product',
      payment_method: 'cod',
      delivery_city:  orderData.city,
      delivery_days:  calcDeliveryDays(orderData.createdAt),
    }, {
      phone:     orderData.phone,
      email:     orderData.email,
      name:      orderData.fullName,
      city:      orderData.city,
      fbp:       signals.fbp,
      fbc:       signals.fbc,
      clientIp:  signals.clientIp,
      userAgent: signals.userAgent,
    }, `delivered_${orderData.orderId}`);

    await updateEasyOrdersStatus(orderData.orderId, 'delivered');

  } else if (isReturned(state)) {
    await sendMetaEvent('OrderReturned', {
      order_id:      orderData.orderId,
      value:         orderData.totalCost,
      currency:      'EGP',
      return_reason: state,
    }, {
      phone:     orderData.phone,
      email:     orderData.email,
      fbp:       signals.fbp,
      fbc:       signals.fbc,
      clientIp:  signals.clientIp,
      userAgent: signals.userAgent,
    }, `returned_${orderData.orderId}`);

    await updateEasyOrdersStatus(orderData.orderId, 'returned');
  }
}

// ═══════════════════════════════════════════════════════════
// SESSION ID ← ORDER LINK
// الحيلة: نحفظ sessionId كـ Order Note في Easy Orders
// لما الـ Webhook يوصل نجيبه منها
// ═══════════════════════════════════════════════════════════
async function getSessionIdFromOrder(order) {
  // محاولة 1: موجود في الـ payload مباشرة (لو Easy Orders بعته)
  if (order._msid)     return order._msid;
  if (order.meta_msid) return order.meta_msid;

  // محاولة 2: موجود في notes الطلب عبر API
  try {
    const res = await apiCall(
      'GET',
      `${CONFIG.EASY_ORDERS_BASE}/external-apps/orders/${order.id}`,
      null,
      { 'Api-Key': CONFIG.EASY_ORDERS_API_KEY }
    );
    const notes = res.body?.notes || [];
    for (const note of notes) {
      const match = String(note.note || '').match(/META_MSID:(\S+)/);
      if (match) return match[1];
    }
  } catch (e) {
    console.warn('[System] Could not fetch order notes:', e.message);
  }

  return null;
}

// ─── دالة مساعدة: احفظ sessionId كـ note على الأوردر ───────
// استدعيها من storefront لما العميل يكمل الطلب
async function saveSessionIdToOrder(orderId, sessionId) {
  try {
    await apiCall(
      'POST',
      `${CONFIG.EASY_ORDERS_BASE}/external-apps/order-notes`,
      {
        order_id: orderId,
        store_id: CONFIG.EASY_ORDERS_STORE_ID,
        note:     `META_MSID:${sessionId}`,
        type:     'private',
      },
      { 'Api-Key': CONFIG.EASY_ORDERS_API_KEY }
    );
    console.log(`[System] SessionId saved to order ${orderId}`);
  } catch (e) {
    console.error('[System] Error saving sessionId:', e.message);
  }
}

// ENDPOINT 4: الصفحة بتستدعي هذا بعد تأكيد الطلب
// POST /link-session  { orderId, sessionId }
app.post('/link-session', async (req, res) => {
  const { orderId, sessionId } = req.body;
  if (!orderId || !sessionId) {
    return res.status(400).json({ error: 'orderId and sessionId required' });
  }
  await saveSessionIdToOrder(orderId, sessionId);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// INTEGRATIONS
// ═══════════════════════════════════════════════════════════

async function createBostaShipment(order) {
  const body = {
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
      city:      mapCityToBosta(order.government),
      firstLine: order.address,
      phone:     order.phone,
    },
    receiver: {
      firstName: order.full_name?.split(' ')[0]             || order.full_name,
      lastName:  order.full_name?.split(' ').slice(1).join(' ') || '',
      phone:     order.phone,
    },
    notes: `Easy Orders ID: ${order.id}`,
  };
  try {
    const res = await apiCall('POST', `${CONFIG.BOSTA_BASE}/deliveries`, body,
      { Authorization: CONFIG.BOSTA_API_KEY });
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

// ─── Meta CAPI — المحدّثة ────────────────────────────────
async function sendMetaEvent(eventName, customData, userData, eventId) {
  const payload = {
    data: [{
      event_name:    eventName,
      event_time:    Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id:      eventId,
      user_data: {
        // PII — لازم SHA-256
        em:      userData.email     ? [sha256(userData.email)]                         : undefined,
        ph:      userData.phone     ? [sha256(normalizePhone(userData.phone))]          : undefined,
        fn:      userData.name      ? [sha256(userData.name.split(' ')[0])]             : undefined,
        ln:      userData.name      ? [sha256(userData.name.split(' ').slice(1).join(' '))] : undefined,
        ct:      userData.city      ? [sha256(userData.city.toLowerCase())]             : undefined,
        country: [sha256('eg')],
        // Cookies — بدون هاش
        fbp:     userData.fbp       || undefined,
        fbc:     userData.fbc       || undefined,
        // Network
        client_ip_address: userData.clientIp  || undefined,
        client_user_agent: userData.userAgent || undefined,
      },
      custom_data: customData,
    }],
  };

  const clean = JSON.parse(JSON.stringify(payload)); // أزل undefined
  try {
    const url = `${CONFIG.META_CAPI_BASE}/${CONFIG.META_PIXEL_ID}/events?access_token=${CONFIG.META_CAPI_TOKEN}`;
    const res = await apiCall('POST', url, clean);
    const emq = res.body?.events_received;
    console.log(`[Meta CAPI] ${eventName} → status:${res.status} events_received:${emq}`);
    return res;
  } catch (e) {
    console.error(`[Meta CAPI] ${eventName} error:`, e.message);
  }
}

// ─── Helpers ────────────────────────────────────────────────
function isDelivered(s) {
  return ['delivered','DELIVERED','45',45,'RECEIVED_BY_CUSTOMER'].includes(s);
}
function isReturned(s) {
  return ['returned','RETURNED','NOT_RECEIVED','WAITING_TO_RETURN',
          '46',46,'47',47,'RETURN_VERIFIED'].includes(s);
}
function calcDeliveryDays(createdAt) {
  return Math.round((Date.now() - new Date(createdAt).getTime()) / 86400000);
}
function normalizePhone(phone) {
  if (!phone) return phone;
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('01'))  return '2' + d;
  if (d.startsWith('201')) return d;
  return d;
}
function mapCityToBosta(city) {
  const map = {
    'القاهرة':'Cairo','الجيزة':'Giza','الإسكندرية':'Alex',
    'المنصورة':'Mansoura','أسيوط':'Assiut','المنيا':'Minya',
    'سوهاج':'Sohag','أسوان':'Aswan','الأقصر':'Luxor',
    'الإسماعيلية':'Ismailia','السويس':'Suez','بورسعيد':'PortSaid',
    'الشرقية':'Sharqia','الدقهلية':'Dakahlia',
    'الغربية':'Gharbia','القليوبية':'Qalyubia',
  };
  return map[city] || city;
}

// ─── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[System] v2 running on port ${PORT}`);
  console.log('  POST /collect-signals   ← من المتصفح');
  console.log('  POST /link-session      ← بعد تأكيد الطلب');
  console.log('  POST /webhook/easy-orders');
  console.log('  POST /webhook/bosta');
});

module.exports = app;
