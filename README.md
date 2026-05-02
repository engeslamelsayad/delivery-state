# نظام تتبع التسليم COD → Meta CAPI

## الفكرة
ربط Easy Orders + Bosta + Meta Ads لإرسال Event حقيقي عند تسليم الطلب لا عند إنشائه.

## التثبيت
```bash
npm install
cp .env.example .env
# عدّل .env بقيمك الحقيقية
npm start
```

## Webhooks التي تحتاج تسجيلها

### 1. Easy Orders
- اذهب لـ: Dashboard → Public API → Webhooks
- أضف URL: `https://your-server.com/webhook/easy-orders`
- احفظ الـ Secret وضعه في .env كـ EASY_ORDERS_SECRET

### 2. Bosta
- اذهب لـ: Bosta Dashboard → Settings → API Integration
- أضف Notification Endpoint: `https://your-server.com/webhook/bosta`

## Events المُرسلة لـ Meta

| Event | متى |
|-------|-----|
| Purchase | عند إنشاء طلب COD جديد |
| OrderDelivered | عند تأكيد التسليم من Bosta |
| OrderReturned | عند الإرجاع أو عدم الاستلام |

## Deploy على Railway / Render
```bash
# Railway
railway up

# أو Render: اربط GitHub repo وضع env variables
```
