/**
 * header-script.js v4 — Client-side signals collector
 * =====================================================
 * إصلاح Race Condition للـ _fbp:
 *   - Polling حتى 4 مرات (max 2 ثانية)
 *   - يُرسَل مرة واحدة فقط (flag يمنع التكرار)
 *   - لو _fbp وُجد مبكراً → يُرسَل فوراً ويلغي بقية المحاولات
 *   - لو ما وُجدش بعد 2 ثانية → يُرسَل بدونه (الواقع مقبول)
 *
 * + Always Save Cookies (_fbc)
 * + ETLD+1 domain scoping
 * + Cross-domain sessionId via URL param
 */
(function () {
  var SERVER         = 'https://delivery-state.up.railway.app';
  var COOKIE_TTL     = 90;
  var POLL_INTERVAL  = 500;   // كل 500ms
  var POLL_MAX       = 8;   // أقصى 8 محاولات = 4 ثوانٍ

  // ─── Helpers ────────────────────────────────────────────────────
  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function getEtldPlusOne() {
    var parts = window.location.hostname.split('.');
    return parts.length <= 2 ? window.location.hostname : '.' + parts.slice(-2).join('.');
  }

  function setCookie(name, value, days) {
    try {
      var d = new Date();
      d.setTime(d.getTime() + days * 86400000);
      document.cookie = name + '=' + encodeURIComponent(value) +
        '; expires=' + d.toUTCString() +
        '; domain=' + getEtldPlusOne() +
        '; path=/; SameSite=Lax';
    } catch (e) {}
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function getOrCreateSession() {
    var urlSid = new URLSearchParams(window.location.search).get('_msid');
    if (urlSid) { lsSet('_msid', urlSid); return urlSid; }
    var sid = lsGet('_msid');
    if (!sid) { sid = 'ms_' + Math.random().toString(36).slice(2,10) + '_' + Date.now(); lsSet('_msid', sid); }
    return sid;
  }

  function post(endpoint, data) {
    var body = JSON.stringify(data);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(SERVER + endpoint, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(SERVER + endpoint, { method:'POST', headers:{'Content-Type':'application/json'}, body:body, keepalive:true }).catch(function(){});
    }
  }

  function decorateCheckoutLinks(sid) {
    try {
      var links = document.querySelectorAll('a[href*="checkout"], a[href*="easyorders"], a[href*="payment"]');
      for (var i = 0; i < links.length; i++) {
        var h = links[i].href;
        if (h.indexOf('_msid=') === -1) links[i].href = h + (h.indexOf('?') === -1 ? '?' : '&') + '_msid=' + encodeURIComponent(sid);
      }
    } catch(e) {}
  }

  // ─── Init ────────────────────────────────────────────────────────
  var fbclid    = new URLSearchParams(window.location.search).get('fbclid');
  var sessionId = getOrCreateSession();

  // Always Save Cookies: ابني _fbc واحفظه لو fbclid موجود
  var fbc = getCookie('_fbc');
  if (!fbc && fbclid) {
    fbc = 'fb.1.' + Date.now() + '.' + fbclid;
    setCookie('_fbc', fbc, COOKIE_TTL);
  }

  // ─── Race Condition Fix: Polling للـ _fbp ─────────────────────
  var sent     = false;   // ← Flag يضمن الإرسال مرة واحدة فقط
  var attempts = 0;
  var pollTimer;

  function tryCapture() {
    if (sent) return;  // لو بُعِت بالفعل، وقف
    attempts++;
    var fbp = getCookie('_fbp');

    if (fbp || attempts >= POLL_MAX) {
      // إما وجدنا fbp، أو استنفدنا المحاولات → أرسل مرة واحدة
      sent = true;
      if (pollTimer) clearTimeout(pollTimer);

      post('/collect-signals', {
        sessionId:      sessionId,
        fbp:            fbp  || null,
        fbc:            fbc  || null,
        userAgent:      navigator.userAgent,
        pageUrl:        window.location.href,
        eventSourceUrl: window.location.href,
        fbpDelay:       attempts > 1 ? (attempts - 1) * POLL_INTERVAL : 0,  // للديباغ
      });
    } else {
      // لسه ما وجدناش → استنى وحاول تاني
      pollTimer = setTimeout(tryCapture, POLL_INTERVAL);
    }
  }

  tryCapture();  // ابدأ فوراً

  // زخرف الـ checkout links
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { decorateCheckoutLinks(sessionId); });
  } else {
    decorateCheckoutLinks(sessionId);
  }

  // ─── Phone Capture: اربط الهاتف بالـ session لحظة إدخاله ─────────
  // العميل يكتب هاتفه في فورم الطلب → نرسله مع sessionId للسيرفر
  // → السيرفر يربط الطلب القادم (بنفس الهاتف) بهذه الجلسة بدقة 100%
  var lastSentPhone = '';

  function normalizeEgPhone(raw) {
    var digits = String(raw || '').replace(/\D/g, '');
    if (digits.indexOf('20') === 0 && digits.length === 12) digits = '0' + digits.slice(2);
    if (digits.indexOf('1') === 0 && digits.length === 10) digits = '0' + digits;
    return digits;
  }

  function maybeSendPhone(raw) {
    var phone = normalizeEgPhone(raw);
    // رقم مصري صالح: 11 خانة يبدأ بـ 01
    if (phone.length === 11 && phone.indexOf('01') === 0 && phone !== lastSentPhone) {
      lastSentPhone = phone;
      post('/link-phone', { phone: phone, sessionId: sessionId });
    }
  }

  function isPhoneField(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    var t = (el.type || '').toLowerCase();
    var n = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '')).toLowerCase();
    return t === 'tel' || /phone|mobile|whats|هاتف|موبايل|جوال|رقم/.test(n);
  }

  // استمع لكل الصفحة (يشمل الحقول المُضافة ديناميكياً)
  document.addEventListener('change', function (e) {
    if (isPhoneField(e.target)) maybeSendPhone(e.target.value);
  }, true);
  document.addEventListener('blur', function (e) {
    if (isPhoneField(e.target)) maybeSendPhone(e.target.value);
  }, true);
  // عند الضغط على أي زر submit — امسح كل حقول الهاتف الموجودة
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('button, [type=submit], a') : null;
    if (!el) return;
    var inputs = document.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      if (isPhoneField(inputs[i]) && inputs[i].value) maybeSendPhone(inputs[i].value);
    }
  }, true);

  // ─── Thank You page ──────────────────────────────────────────────
  var isThankYou = window.location.pathname.indexOf('thanks') !== -1;
  var orderId    = new URLSearchParams(window.location.search).get('order_id');

  if (isThankYou && orderId) {
    post('/link-session', { orderId: orderId, sessionId: sessionId });
    setTimeout(function() { lsDel('_msid'); }, 5000);
  }
})();
