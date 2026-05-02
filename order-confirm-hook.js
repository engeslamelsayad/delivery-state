/**
 * order-confirm-hook.js
 * =====================
 * أضف هذا الكود في صفحة تأكيد الطلب في Easy Orders
 * (Thank You Page / Order Confirmation Page)
 *
 * المهمة: بعد ما الطلب يتأكد، يربط الـ sessionId بالـ orderId
 * عن طريق POST /link-session للسيرفر
 */

(function () {
  'use strict';

  var SERVER_URL = 'https://your-server.com'; // ← غيّر لـ URL سيرفرك

  // ─── استخراج orderId من الصفحة ──────────────────────────
  // Easy Orders بيحط order ID في الصفحة بأشكال مختلفة
  function getOrderId() {
    // محاولة 1: من URL params
    var params = new URLSearchParams(window.location.search);
    var fromUrl = params.get('order_id') || params.get('orderId') || params.get('id');
    if (fromUrl) return fromUrl;

    // محاولة 2: من data attributes في الصفحة
    var el = document.querySelector('[data-order-id]');
    if (el) return el.getAttribute('data-order-id');

    // محاولة 3: من نص الصفحة (رقم الطلب)
    var match = document.body.innerText.match(/order[_\s-]?id[:\s]+([a-f0-9-]{36})/i);
    if (match) return match[1];

    // محاولة 4: من localStorage لو Easy Orders حفظه
    try {
      var stored = localStorage.getItem('last_order_id') ||
                   localStorage.getItem('easy_orders_last_order');
      if (stored) return stored;
    } catch (e) {}

    return null;
  }

  // ─── ربط الـ session بالأوردر ────────────────────────────
  function linkSessionToOrder() {
    var sessionId = sessionStorage.getItem('_msid');
    var orderId   = getOrderId();

    if (!sessionId || !orderId) {
      console.warn('[MetaTracker] Cannot link — sessionId:', sessionId, 'orderId:', orderId);
      return;
    }

    console.log('[MetaTracker] Linking session', sessionId, '→ order', orderId);

    fetch(SERVER_URL + '/link-session', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ orderId: orderId, sessionId: sessionId }),
      keepalive: true,
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.ok) {
        console.log('[MetaTracker] Session linked successfully');
        // امسح الـ sessionId من sessionStorage بعد الربط
        sessionStorage.removeItem('_msid');
      }
    })
    .catch(function (err) {
      console.warn('[MetaTracker] Link failed:', err.message);
    });
  }

  // تشغيل عند تحميل الصفحة
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', linkSessionToOrder);
  } else {
    linkSessionToOrder();
  }

})();
