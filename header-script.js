(function () {
  var SERVER = 'https://delivery-state.up.railway.app';

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
    var sid = localStorage.getItem('_msid');
    if (!sid) {
      sid = 'ms_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now();
      localStorage.setItem('_msid', sid);
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
        body: body,
        keepalive: true
      }).catch(function () {});
    }
  }

  var fbclid    = getFbclid();
  var sessionId = getOrCreateSession();

  post('/collect-signals', {
    sessionId: sessionId,
    fbp:       getCookie('_fbp'),
    fbc:       getCookie('_fbc') || buildFbc(fbclid),
    userAgent: navigator.userAgent,
    pageUrl:   window.location.href,
  });

  var isThankYou = window.location.pathname.indexOf('thanks') !== -1;
  var orderId    = new URLSearchParams(window.location.search).get('order_id');

  if (isThankYou && orderId) {
    post('/link-session', { orderId: orderId, sessionId: sessionId });
    setTimeout(function () { localStorage.removeItem('_msid'); }, 5000);
  }

})();
