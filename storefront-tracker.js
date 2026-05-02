/**
 * storefront-tracker.js
 * =====================
 * ضع هذا الملف في قالب Easy Orders أو أضفه كـ Custom Script
 * من Dashboard → Settings → Custom Code → Before </body>
 *
 * المهمة: يقرأ _fbp و _fbc من cookies المتصفح
 * ويحفظهم في localStorage قبل أن يكمل العميل الطلب،
 * ثم يبعتهم لسيرفرك عبر endpoint خفي.
 */

(function () {
  'use strict';

  // ─── 1. قراءة Meta Cookies ───────────────────────────────
  function getCookie(name) {
    const match = document.cookie.match(
      new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)')
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  // ─── 2. استخراج fbclid من URL (مصدر _fbc) ───────────────
  function getFbclidFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('fbclid') || null;
  }

  // ─── 3. بناء _fbc يدوياً لو الـ cookie مش موجود ─────────
  // الصيغة: fb.1.{timestamp}.{fbclid}
  function buildFbc(fbclid) {
    if (!fbclid) return null;
    return 'fb.1.' + Date.now() + '.' + fbclid;
  }

  // ─── 4. جمع كل الـ Signals ──────────────────────────────
  function collectSignals() {
    const fbclid = getFbclidFromUrl();
    const signals = {
      fbp:        getCookie('_fbp'),
      fbc:        getCookie('_fbc') || buildFbc(fbclid),
      fbclid:     fbclid,
      ip:         null,   // السيرفر يأخذه تلقائياً
      userAgent:  navigator.userAgent,
      pageUrl:    window.location.href,
      referrer:   document.referrer || null,
      ts:         Date.now(),
    };
    return signals;
  }

  // ─── 5. حفظ في localStorage كـ fallback ─────────────────
  function saveLocally(signals) {
    try {
      localStorage.setItem('_meta_signals', JSON.stringify(signals));
    } catch (e) {}
  }

  // ─── 6. إرسال للسيرفر عند تحميل الصفحة ─────────────────
  // السيرفر يخزنهم مع session ID مؤقت
  function sendToServer(signals) {
    // إنشاء session ID فريد للزيارة
    let sessionId = sessionStorage.getItem('_msid');
    if (!sessionId) {
      sessionId = 'ms_' + Math.random().toString(36).substr(2, 12) + '_' + Date.now();
      sessionStorage.setItem('_msid', sessionId);
    }
    signals.sessionId = sessionId;

    // إرسال بـ sendBeacon (لا يوقف الصفحة، يكمل حتى لو أغلق المتصفح)
    const blob = new Blob([JSON.stringify(signals)], { type: 'application/json' });
    const sent = navigator.sendBeacon(
      'https://your-server.com/collect-signals',  // ← غيّر لـ URL سيرفرك
      blob
    );

    // fallback لو sendBeacon مش مدعوم
    if (!sent) {
      fetch('https://your-server.com/collect-signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signals),
        keepalive: true,
      }).catch(() => {});
    }

    return sessionId;
  }

  // ─── 7. حقن sessionId في فورم الطلب ────────────────────
  // Easy Orders بيستخدم فورم HTML عادي — نضيف hidden input
  function injectSessionIdIntoForms(sessionId) {
    // انتظر تحميل DOM
    function inject() {
      // ابحث عن كل فورمات الطلب في الصفحة
      const forms = document.querySelectorAll(
        'form[action*="order"], form[action*="checkout"], form.order-form, #order-form, .checkout-form'
      );
      forms.forEach(function (form) {
        if (!form.querySelector('[name="_msid"]')) {
          const input = document.createElement('input');
          input.type  = 'hidden';
          input.name  = '_msid';
          input.value = sessionId;
          form.appendChild(input);
        }
      });

      // أيضاً: اعترض أي fetch/XHR لـ Easy Orders API
      interceptOrderSubmit(sessionId);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', inject);
    } else {
      inject();
      // أحياناً الفورم بيتحمل بعد setTimeout
      setTimeout(inject, 1000);
      setTimeout(inject, 2500);
    }
  }

  // ─── 8. اعتراض Order Submit ─────────────────────────────
  // لو Easy Orders بيستخدم fetch أو XHR للطلب
  function interceptOrderSubmit(sessionId) {
    // اعتراض fetch
    const originalFetch = window.fetch;
    window.fetch = function (url, options) {
      try {
        if (url && String(url).includes('order')) {
          if (options && options.body) {
            let body;
            try { body = JSON.parse(options.body); } catch (e) {}
            if (body && typeof body === 'object') {
              body._msid = sessionId;
              body.meta_fbp = getCookie('_fbp');
              body.meta_fbc = getCookie('_fbc') || buildFbc(getFbclidFromUrl());
              options = Object.assign({}, options, { body: JSON.stringify(body) });
            }
          }
        }
      } catch (e) {}
      return originalFetch.apply(this, [url, options]);
    };
  }

  // ─── 9. تشغيل كل شيء ───────────────────────────────────
  const signals   = collectSignals();
  saveLocally(signals);
  const sessionId = sendToServer(signals);
  injectSessionIdIntoForms(sessionId);

  // تصدير للاستخدام من أي مكان في الصفحة
  window._MetaTracker = {
    getSignals:   collectSignals,
    getSessionId: function () { return sessionStorage.getItem('_msid'); },
  };

})();
