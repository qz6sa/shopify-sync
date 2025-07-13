require('dotenv').config();
const fs    = require('fs');
const fetch = require('node-fetch');
const cron  = require('node-cron');

// —————————————————————————————
// 1) دوال المزامنة
// —————————————————————————————

// 1.1) قراءة/كتابة آخر مزامنة
function readLastSync() {
  try {
    const raw = fs.readFileSync(process.env.LAST_SYNC_FILE, 'utf8').trim();
    const date = new Date(raw);
    return isNaN(date) ? new Date(0) : date;
  } catch {
    return new Date(0);
  }
}
function writeLastSync(date) {
  if (date instanceof Date && !isNaN(date)) {
    fs.writeFileSync(process.env.LAST_SYNC_FILE, date.toISOString());
  } else {
    console.warn('⚠️ Attempted to write invalid date:', date);
  }
}

// 1.2) جلب المنتجات من المتجر الخارجي
async function fetchAllExternalProducts() {
  const perPage = 250;
  let page = 1, all = [];
  while (true) {
    const url = `https://${process.env.EXTERNAL_STORE}/products.json?limit=${perPage}&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Page ${page} failed: ${res.status}`);
    const { products } = await res.json();
    if (!products.length) break;
    all.push(...products);
    page++;
  }
  return all;
}

// 1.3) إنشاء المنتج في متجرك
const ADMIN_HEADERS = {
  'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
  'Content-Type': 'application/json'
};
async function createProductInMyStore(ext) {
  const url = `https://${process.env.MY_STORE}/admin/api/2024-07/products.json`;
  const body = { product: {
    title: ext.title,
    body_html: ext.body_html,
    vendor: ext.vendor,
    images: (ext.images || []).map(i => ({ src: i.src })),
    variants: (ext.variants || []).map(v => ({
      option1: v.option1, price: v.price, sku: v.sku
    }))
  }};
  const res = await fetch(url, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Create failed: ${res.status}`);
  return (await res.json()).product.id;
}

// 1.4) ربط المنتج بالكولكشن
async function addProductToCollection(productId, collectionId) {
  const url = `https://${process.env.MY_STORE}/admin/api/2024-07/collects.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      collect: { product_id: productId, collection_id: collectionId }
    })
  });
  if (!res.ok) throw new Error(`Collect failed: ${res.status}`);
}

// 1.5) الدالة الرئيسية runSync
async function runSync() {
  try {
    const lastSync = readLastSync();
    console.log("🔄 Fetching all external products…");
    const all = await fetchAllExternalProducts();

    // فلترة جديدة: فقط منتجات لها created_at صالح وأحدث من lastSync
    const newItems = all
      .filter(p => p.created_at)
      .map(p => ({ ...p, _created: new Date(p.created_at) }))
      .filter(p => !isNaN(p._created) && p._created > lastSync);

    console.log(`Found ${newItems.length} new products since ${lastSync.toISOString()}`);

    for (const ext of newItems) {
      try {
        const newId = await createProductInMyStore(ext);
        await addProductToCollection(newId, process.env.MY_COLLECTION_ID);
        console.log(`✅ Synced "${ext.title}" → ${newId}`);
      } catch(err) {
        console.error(`❌ Error on "${ext.title}":`, err.message);
      }
    }

    if (newItems.length) {
      // أحدث تاريخ
      const newest = newItems.reduce((a,b) =>
        a._created > b._created ? a : b
      );
      writeLastSync(newest._created);
      console.log("🎉 Updated last sync to", newest._created.toISOString());
    } else {
      console.log("🎉 No new products, last sync remains", lastSync.toISOString());
    }
  } catch(err) {
    console.error("❌ Fatal error:", err);
  }
}

// —————————————————————————————
// 2) جدولة التشغيل
// —————————————————————————————

// شغل عند البدء
runSync();

// شغل كل ساعة
cron.schedule('0 * * * *', () => {
  console.log("⏰ Running scheduled sync…");
  runSync();
});
