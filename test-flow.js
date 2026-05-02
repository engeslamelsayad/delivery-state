/**
 * سكربت لمحاكاة دورة الطلب والتوصيل بالكامل لاختبار Meta CAPI
 * قم بتشغيله عبر الأمر: node test-flow.js
 */

// ⚠️ قم بتغيير هذا الرابط إلى http://localhost:3000 إذا كنت تختبر على جهازك
const SERVER_URL = 'https://delivery-state.up.railway.app'; 

// ⚠️ ضع نفس الـ Secret الموجود في إعدادات المتجر لديك
const EASY_ORDERS_SECRET = 'bjR2akgzSWkzWQ=='; 

// بيانات العميل الوهمية للاختبار
const testPhone = '01012345678';
const testOrderId = 'TEST_' + Math.floor(Math.random() * 10000);
const trackingNumber = 'BOSTA_' + Math.floor(Math.random() * 10000);

async function simulateFlow() {
  console.log(`🚀 بدء اختبار النظام للأوردر: ${testOrderId}\n`);

  // 1️⃣ محاكاة Webhook من Easy Orders (طلب جديد)
  console.log('📦 1. إرسال طلب جديد من Easy Orders...');
  try {
    const easyOrdersRes = await fetch(`${SERVER_URL}/webhook/easy-orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'secret': EASY_ORDERS_SECRET
      },
      body: JSON.stringify({
        status: 'pending',
        id: testOrderId,
        total_cost: 1250,
        phone: testPhone,
        email: 'test@cosmoeg.shop',
        full_name: 'تجربة اختبار النظام',
        government: 'القاهرة',
        cart_items: [{ product_id: 'PROD_001', price: 1250 }]
      })
    });
    
    const easyOrdersData = await easyOrdersRes.json();
    console.log(`✅ استجابة السيرفر للطلب:`, easyOrdersData);
  } catch (err) {
    console.error('❌ فشل إرسال طلب Easy Orders:', err.message);
    return;
  }

  // انتظار ثانيتين لمحاكاة الوقت الطبيعي لمعالجة البيانات
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 2️⃣ محاكاة Webhook من Bosta (تم التسليم)
  console.log('\n🚚 2. إرسال تحديث "تم التسليم" من Bosta...');
  try {
    const bostaRes = await fetch(`${SERVER_URL}/webhook/bosta`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tracking_number: trackingNumber,
        state: 'delivered', // أو يمكنك تغييرها إلى 'returned' لاختبار المرتجعات
        receiver: {
          phone: testPhone // السيرفر سيعتمد على هذا الرقم للربط التلقائي
        }
      })
    });

    const bostaData = await bostaRes.json();
    console.log(`✅ استجابة السيرفر للتوصيل:`, bostaData);
  } catch (err) {
    console.error('❌ فشل إرسال تحديث Bosta:', err.message);
  }

  console.log('\n🎉 اكتمل الاختبار! راجع الـ Console الخاص بالسيرفر (Railway) لترى إذا كان حدث Delivery قد أُرسل لـ Meta بنجاح.');
}

simulateFlow();
