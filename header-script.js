/**
 * header-script.js v2 — Client-side signals collector
 * =====================================================
 * تحسينات مبنية على Meta's Parameter Builder Library:
 *   1. حفظ _fbc كـ cookie بعد بنائه من fbclid (Always Save Cookies pattern)
 *   2. تطبيق ETLD+1 على الـ cookie domain للـ subdomains coverage
 *   3. capture الـ event_source_url مع query params كاملة
 */
(function () {
  // ⚠️  استبدل القيمة دي بالـ URL بتاع السيرفر الفعلي قبل الرفع
  var SERVER = 'https://delivery-state.up.railway.app';
  var COOKIE_TTL_DAYS = 90;

  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function getEtldPlusOne() {
    var host = window.location.hostname;
    var parts = host.split('.');
    if (parts.length <= 2) return host;
    return '.' + parts.slice(-2).join('.');
  }

  function setCookie(name, value, days) {
    try {
      var d = new Date();
      d.setTime(d.getTime() + (days * 86400000));
      var domain = getEtldPlusOne();
      document.cookie = name + '=' + encodeURIComponent(value) +
        '; expires=' + d.toUTCString() +
        '; domain=' + domain +
        '; path=/; SameSite=Lax';
    } catch (e) { }
  }

  function getFbclid() {
    return new URLSearchParams(window.location.search).get('fbclid');
  }

  function buildFbc(fbclid) {
    return fbclid ? 'fb.1.' + Date.now() + '.' + fbclid : null;
  }

  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { } }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (e) { } }

  function getOrCreateSession() {
    var sid = lsGet('_msid');
    if (!sid) {
      sid = 'ms_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now();
      lsSet('_msid', sid);
    }
    return sid;
  }

  function post(endpoint, data) {
    var body = JSON.stringify(data);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(SERVER + endpoint, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(SERVER + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () { });
    }
  }

  var fbclid    = getFbclid();
  var sessionId = getOrCreateSession();

  // ✓ التحسين الأهم: حفظ _fbc cookie لو fbclid موجود وما فيش _fbc
  var existingFbc = getCookie('_fbc');
  var fbcToUse    = existingFbc;
  if (!existingFbc && fbclid) {
    fbcToUse = buildFbc(fbclid);
    setCookie('_fbc', fbcToUse, COOKIE_TTL_DAYS);
  }

  post('/collect-signals', {
    sessionId:      sessionId,
    fbp:            getCookie('_fbp'),
    fbc:            fbcToUse,
    userAgent:      navigator.userAgent,
    pageUrl:        window.location.href,
    eventSourceUrl: window.location.href,
  });

  var isThankYou = window.location.pathname.indexOf('thanks') !== -1;
  var orderId    = new URLSearchParams(window.location.search).get('order_id');

  if (isThankYou && orderId) {
    post('/link-session', { orderId: orderId, sessionId: sessionId });
    setTimeout(function () { lsDel('_msid'); }, 5000);
  }
})();
