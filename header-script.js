/**
 * header-script.js
 * ================
 * يُضاف في Easy Orders: الإعدادات ← Custom Code ← Header
 *
 * يعمل على كل صفحة:
 *   1. يقرأ _fbp و _fbc من cookies المتصفح
 *   2. ينشئ sessionId فريد للزيارة
 *   3. يبعتهم للسيرفر عبر /collect-signals
 *   4. لو الصفحة /thanks?order_id=xxx — يربط الأوردر بالـ session تلقائياً
 */
(function () {
  var SERVER = 'https://YOUR-RAILWAY-URL.railway.app'; // ← غيّر بعد الـ Deploy

  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function getFbclid() {
    return new URLSearchParams(window.location.search).get('fbclid');
  }

  function buildFbc(fbclid) {
    return fbclid ? 'fb.1.' + Date.now() + '.' + fbclid : null;
  }

  function getOrCreateSession() {
    var sid = sessionStorage.getItem('_msid');
    if (!sid) {
      sid = 'ms_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now();
      sessionStorage.setItem('_msid', sid);
    }
    return sid;
  }

  function post(endpoint, data) {
    var body = JSON.stringify(data);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(SERVER + endpoint,
        new Blob([body], { type: 'application/json' }));
    } else {
      fetch(SERVER + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body, keepalive: true
      }).catch(function () {});
    }
  }

  // ── جمع الـ Signals وإرسالها (كل الصفحات) ──────────────
  var fbclid    = getFbclid();
  var sessionId = getOrCreateSession();

  post('/collect-signals', {
    sessionId: sessionId,
    fbp:       getCookie('_fbp'),
    fbc:       getCookie('_fbc') || buildFbc(fbclid),
    userAgent: navigator.userAgent,
    pageUrl:   window.location.href,
  });

  // ── ربط الأوردر (صفحة /thanks فقط) ─────────────────────
  var isThankYou = window.location.pathname.indexOf('thanks') !== -1;
  var orderId    = new URLSearchParams(window.location.search).get('order_id');

  if (isThankYou && orderId) {
    post('/link-session', { orderId: orderId, sessionId: sessionId });
    setTimeout(function () { sessionStorage.removeItem('_msid'); }, 3000);
  }

})();
