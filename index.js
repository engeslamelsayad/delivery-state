// ============================================================
// COD Meta Tracking System
// Easy Orders + Bosta + Meta CAPI
// ============================================================

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');

const app = express();
app.use(express.json());

// ─── Config ─────────────────────────────────────────────────
const CONFIG = {
  EASY_ORDERS_SECRET: process.env.EASY_ORDERS_SECRET || 'YOUR_EASY_ORDERS_WEBHOOK_SECRET',
  EASY_ORDERS_API_KEY: process.env.EASY_ORDERS_API_KEY || 'YOUR_EASY_ORDERS_API_KEY',
  EASY_ORDERS_BASE: 'https://api.easy-orders.net/v1',

  BOSTA_API_KEY: process.env.BOSTA_API_KEY || 'YOUR_BOSTA_API_KEY',
  BOSTA_BASE: 'https://app.bosta.co/api/v2',

  META_PIXEL_ID: process.env.META_PIXEL_ID || 'YOUR_PIXEL_ID',
  META_CAPI_TOKEN: process.env.META_CAPI_TOKEN || 'YOUR_CAPI_ACCESS_TOKEN',
  META_CAPI_BASE: 'https://graph.facebook.com/v19.0',
};

// In-memory store — في Production استخدم Redis أو DB
const orderStore = new Map();

// ─── Utils ──────────────────────────────────────────────────
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
    const opts   = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, res => {
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

// ─── Easy Orders Webhook ─────────────────────────────────────
// يُطلق عند: إنشاء طلب جديد أو تغيير حالته
app.post('/webhook/easy-orders', async (req, res) => {
  const secret = req.headers['secret'];
  if (secret !== CONFIG.EASY_ORDERS_SECRET) {
    console.warn('[EasyOrders] Invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;
  console.log('[EasyOrders] Event received:', JSON.stringify(payload, null, 2));

  // حالة: طلب جديد تم إنشاؤه
  if (payload.status === 'pending' && payload.id) {
    await handleNewOrder(payload);
  }

  // حالة: تغيير حالة طلب (مثلاً confirmed)
  if (payload.event_type === 'order-status-update') {
    await handleOrderStatusChange(payload);
  }

  res.json({ received: true });
});

// ─── Bosta Webhook ───────────────────────────────────────────
// يُطلق عند كل تحديث حالة شحنة
app.post('/webhook/bosta', async (req, res) => {
  const payload = req.body;
  console.log('[Bosta] Webhook received:', JSON.stringify(payload, null, 2));

  const trackingNumber = payload.tracking_number || payload.trackingNumber;
  const state          = payload.state || payload.status;

  if (!trackingNumber || !state) {
    return res.json({ received: true });
  }

  // استرجاع بيانات الطلب المرتبطة بهذا التراكينج
  const orderData = orderStore.get(trackingNumber);
  if (!orderData) {
    console.warn('[Bosta] No order found for tracking:', trackingNumber);
    return res.json({ received: true });
  }

  await handleBostaStatusUpdate(state, orderData, payload);
  res.json({ received: true });
});

// ─── Handlers ───────────────────────────────────────────────

async function handleNewOrder(order) {
  console.log(`[System] New order: ${order.id}, creating Bosta shipment...`);

  // إرسال لـ Meta: Purchase Event (طلب COD جديد)
  await sendMetaEvent('Purchase', {
    order_id:        order.id,
    value:           order.total_cost,
    currency:        'EGP',
    content_ids:     order.cart_items?.map(i => i.product_id) || [],
    content_type:    'product',
    payment_method:  'cod',
  }, {
    email: order.email,
    phone: order.phone,
    name:  order.full_name,
    city:  order.government,
  }, `purchase_${order.id}`);

  // إنشاء شحنة في Bosta
  const shipment = await createBostaShipment(order);
  if (shipment && shipment.trackingNumber) {
    orderStore.set(shipment.trackingNumber, {
      orderId:     order.id,
      totalCost:   order.total_cost,
      phone:       order.phone,
      email:       order.email,
      fullName:    order.full_name,
      city:        order.government,
      cartItems:   order.cart_items,
      createdAt:   new Date().toISOString(),
    });
    console.log(`[System] Shipment created: ${shipment.trackingNumber}`);
  }
}

async function handleOrderStatusChange(payload) {
  const { order_id, new_status } = payload;
  console.log(`[System] Order ${order_id} → ${new_status}`);
  // يمكن إضافة logic إضافية هنا
}

async function handleBostaStatusUpdate(state, orderData, rawPayload) {
  console.log(`[System] Bosta state: ${state} for order: ${orderData.orderId}`);

  // حالة: تم التسليم وتحصيل الكاش
  if (isDelivered(state)) {
    console.log(`[Meta] Sending OrderDelivered for order ${orderData.orderId}`);

    await sendMetaEvent('OrderDelivered', {
      order_id:        orderData.orderId,
      value:           orderData.totalCost,
      currency:        'EGP',
      content_ids:     orderData.cartItems?.map(i => i.product_id) || [],
      content_type:    'product',
      payment_method:  'cod',
      delivery_city:   orderData.city,
      delivery_days:   calcDeliveryDays(orderData.createdAt),
    }, {
      phone: orderData.phone,
      email: orderData.email,
      name:  orderData.fullName,
      city:  orderData.city,
    }, `delivered_${orderData.orderId}`);

    // تحديث حالة الطلب في Easy Orders
    await updateEasyOrdersStatus(orderData.orderId, 'delivered');

  // حالة: إرجاع أو عدم استلام
  } else if (isReturned(state)) {
    console.log(`[Meta] Sending OrderReturned for order ${orderData.orderId}`);

    await sendMetaEvent('OrderReturned', {
      order_id:       orderData.orderId,
      value:          orderData.totalCost,
      currency:       'EGP',
      return_reason:  state,
    }, {
      phone: orderData.phone,
      email: orderData.email,
    }, `returned_${orderData.orderId}`);

    await updateEasyOrdersStatus(orderData.orderId, 'returned');
  }
}

// ─── Bosta Integration ───────────────────────────────────────

async function createBostaShipment(order) {
  const body = {
    type: 10, // Delivery + Cash collection
    specs: {
      size: 'SMALL',
      packageDetails: {
        itemsCount: order.cart_items?.length || 1,
        description: order.cart_items?.map(i => i.product?.name).join(', ') || 'Order',
      },
    },
    cod: order.total_cost,
    dropOffAddress: {
      city: mapCityToBosta(order.government),
      firstLine: order.address,
      phone: order.phone,
    },
    receiver: {
      firstName: order.full_name?.split(' ')[0] || order.full_name,
      lastName:  order.full_name?.split(' ').slice(1).join(' ') || '',
      phone:     order.phone,
    },
    notes: `Easy Orders ID: ${order.id}`,
  };

  try {
    const res = await apiCall(
      'POST',
      `${CONFIG.BOSTA_BASE}/deliveries`,
      body,
      { Authorization: CONFIG.BOSTA_API_KEY }
    );
    console.log('[Bosta] Create shipment response:', res.status);
    return res.body?.data || res.body;
  } catch (err) {
    console.error('[Bosta] Error creating shipment:', err.message);
    return null;
  }
}

// ─── Easy Orders Integration ─────────────────────────────────

async function updateEasyOrdersStatus(orderId, status) {
  try {
    const res = await apiCall(
      'PATCH',
      `${CONFIG.EASY_ORDERS_BASE}/orders/${orderId}`,
      { status },
      { Authorization: `Bearer ${CONFIG.EASY_ORDERS_API_KEY}` }
    );
    console.log(`[EasyOrders] Updated order ${orderId} → ${status}:`, res.status);
  } catch (err) {
    console.error('[EasyOrders] Error updating order:', err.message);
  }
}

// ─── Meta CAPI Integration ───────────────────────────────────

async function sendMetaEvent(eventName, customData, userData, eventId) {
  const payload = {
    data: [{
      event_name:    eventName,
      event_time:    Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id:      eventId, // لـ Deduplication مع Pixel

      user_data: {
        em:      userData.email ? [sha256(userData.email)] : undefined,
        ph:      userData.phone ? [sha256(normalizePhone(userData.phone))] : undefined,
        fn:      userData.name  ? [sha256(userData.name.split(' ')[0])] : undefined,
        ln:      userData.name  ? [sha256(userData.name.split(' ').slice(1).join(' '))] : undefined,
        ct:      userData.city  ? [sha256(userData.city.toLowerCase())] : undefined,
        country: [sha256('eg')],
      },

      custom_data: customData,
    }],
  };

  // أزل القيم undefined
  const clean = JSON.parse(JSON.stringify(payload));

  try {
    const url = `${CONFIG.META_CAPI_BASE}/${CONFIG.META_PIXEL_ID}/events?access_token=${CONFIG.META_CAPI_TOKEN}`;
    const res = await apiCall('POST', url, clean);
    console.log(`[Meta CAPI] ${eventName} sent. Response:`, res.status, JSON.stringify(res.body));
    return res;
  } catch (err) {
    console.error(`[Meta CAPI] Error sending ${eventName}:`, err.message);
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function isDelivered(state) {
  const delivered = ['delivered', 'DELIVERED', '45', 45, 'RECEIVED_BY_CUSTOMER'];
  return delivered.includes(state);
}

function isReturned(state) {
  const returned = ['returned', 'RETURNED', 'NOT_RECEIVED', 'WAITING_TO_RETURN',
                    '46', 46, '47', 47, 'RETURN_VERIFIED'];
  return returned.includes(state);
}

function calcDeliveryDays(createdAt) {
  const diff = Date.now() - new Date(createdAt).getTime();
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

function normalizePhone(phone) {
  // تحويل 01xxxxxxxxx → 201xxxxxxxxx
  if (!phone) return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('01')) return '2' + digits;
  if (digits.startsWith('201')) return digits;
  return digits;
}

function mapCityToBosta(arabicCity) {
  // خريطة أسماء المحافظات المصرية → Bosta city codes
  const map = {
    'القاهرة': 'Cairo',    'الجيزة': 'Giza',
    'الإسكندرية': 'Alex',  'المنصورة': 'Mansoura',
    'أسيوط': 'Assiut',     'المنيا': 'Minya',
    'سوهاج': 'Sohag',      'أسوان': 'Aswan',
    'الأقصر': 'Luxor',     'الإسماعيلية': 'Ismailia',
    'السويس': 'Suez',       'بورسعيد': 'PortSaid',
    'الشرقية': 'Sharqia',  'الدقهلية': 'Dakahlia',
    'الغربية': 'Gharbia',   'القليوبية': 'Qalyubia',
  };
  return map[arabicCity] || arabicCity;
}

// ─── Health Check ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[System] COD Meta Tracking running on port ${PORT}`);
  console.log(`[System] Webhooks:`);
  console.log(`  Easy Orders → POST /webhook/easy-orders`);
  console.log(`  Bosta       → POST /webhook/bosta`);
});

module.exports = app;
