import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

// KSP LEGO outlet monitor.
const URL = 'https://ksp.co.il/web/cat/42..1215..3605';
const OUT = 'monitoring/ksp-lego-latest.json';
const forceRun = process.env.FORCE_RUN === 'true';

function jerusalemParts() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

const now = jerusalemParts();
const currentHour = Number(now.hour);
const shouldRunScheduled = currentHour === 10 || currentHour === 20;
if (!forceRun && !shouldRunScheduled) {
  console.log(`Skipping: Jerusalem hour is ${currentHour}; scheduled fetches run shortly before 11:00 and 21:00.`);
  process.exit(0);
}

const checkedAt = `${now.year}-${now.month}-${now.day}T${now.hour}:${now.minute}:${now.second}+03:00`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });

function writeResult(obj) {
  fs.writeFileSync(OUT, JSON.stringify({ source: URL, checkedAt, ...obj }, null, 2) + '\n');
}

function normalizePrice(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^\d.,]/g, '').replace(/,/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function absoluteUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try { return new URL(value, 'https://ksp.co.il').href.replace(/[?#].*$/, ''); }
  catch { return null; }
}

function firstString(obj, keys) {
  for (const key of keys) {
    const v = obj?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function firstPrice(obj, keys) {
  for (const key of keys) {
    const v = obj?.[key];
    const p = normalizePrice(v);
    if (p) return p;
  }
  return null;
}

function productFromObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const name = firstString(obj, [
    'name', 'title', 'productName', 'product_name', 'description',
    'itemName', 'item_name', 'seoTitle', 'seo_title'
  ]);
  const price = firstPrice(obj, [
    'price', 'finalPrice', 'final_price', 'salePrice', 'sale_price',
    'currentPrice', 'current_price', 'priceAfterDiscount', 'price_after_discount'
  ]);
  const url = absoluteUrl(firstString(obj, [
    'url', 'href', 'link', 'productUrl', 'product_url', 'itemUrl', 'item_url'
  ]));
  const sku = firstString(obj, ['sku', 'catalogNumber', 'catalog_number', 'model', 'mpn', 'id']);

  const combined = `${name} ${sku}`.trim();
  if (!/LEGO|לגו|\b\d{5}\b/i.test(combined)) return null;
  if (!name || !price) return null;

  return {
    name: name.replace(/\s+/g, ' ').trim(),
    price,
    currency: 'ILS',
    url
  };
}

function walkJson(value, visit, depth = 0) {
  if (depth > 10 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  visit(value);
  for (const v of Object.values(value)) walkJson(v, visit, depth + 1);
}

let browser;
try {
  const executableCandidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  const executablePath = executableCandidates.find(p => fs.existsSync(p));
  if (!executablePath) throw new Error('Chrome/Chromium executable not found on runner');

  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    viewport: { width: 1440, height: 1200 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  });

  const page = await context.newPage();
  const networkProducts = [];
  const categorySignals = [];

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const type = response.request().resourceType();
      const contentType = (response.headers()['content-type'] || '').toLowerCase();
      if (!(type === 'xhr' || type === 'fetch' || contentType.includes('json'))) return;

      const status = response.status();
      const isKspApiish = /ksp\.co\.il\/.*(?:api|category|cat|product|item)/i.test(url);
      if (isKspApiish) categorySignals.push({ url, status });

      if (status < 200 || status >= 300 || !contentType.includes('json')) return;
      const json = await response.json();

      let objectCount = 0;
      let productCount = 0;
      walkJson(json, (obj) => {
        objectCount++;
        const p = productFromObject(obj);
        if (p) {
          productCount++;
          networkProducts.push(p);
        }
      });

      if (isKspApiish) categorySignals.push({ url, status, objectCount, productCount, jsonLoaded: true });
    } catch {}
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(10000);

  for (const label of ['אישור', 'מאשר', 'קראתי', 'Accept', 'OK']) {
    const btn = page.getByRole('button', { name: label, exact: false }).first();
    if (await btn.count()) {
      try { await btn.click({ timeout: 1500 }); } catch {}
    }
  }

  for (let round = 0; round < 18; round++) {
    const before = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    const more = page.getByText(/SHOW_MORE_PRODUCTS|הצג עוד|טען עוד|עוד מוצרים/i).last();
    if (await more.count()) {
      try {
        await more.click({ timeout: 1200 });
        await page.waitForTimeout(1500);
      } catch {}
    }

    const after = await page.evaluate(() => document.body.scrollHeight);
    if (after === before && round >= 5) break;
  }

  await page.waitForTimeout(2500);

  const pageInfo = await page.evaluate(() => ({
    title: document.title,
    body: (document.body?.innerText || '').slice(0, 160000),
    htmlLength: document.documentElement?.outerHTML?.length || 0,
    url: location.href
  }));

  const obviousFailure = /ERROR_API|Failed to fetch|ארעה שגיאה בהבאת נתונים|Access Denied|Forbidden|captcha|robot|שגיאה בטעינת/i.test(pageInfo.body);
  if (obviousFailure) {
    writeResult({
      status: 'error',
      reason: 'KSP page loaded but reported an API/access error',
      diagnostics: { title: pageInfo.title, htmlLength: pageInfo.htmlLength, categorySignals: categorySignals.slice(-20) },
      products: []
    });
    process.exit(0);
  }

  const domProducts = await page.evaluate(() => {
    const moneyRe = /₪\s*([\d,.]+)|([\d,.]+)\s*₪/;
    const seen = new Map();

    const nodes = [...document.querySelectorAll('a[href]')];
    for (const a of nodes) {
      let node = a;
      let best = '';
      for (let i = 0; i < 9 && node; i++, node = node.parentElement) {
        const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
        if (moneyRe.test(t) && t.length >= 10 && t.length < 2500) {
          best = t;
          break;
        }
      }
      if (!best) continue;

      const href = (() => {
        try { return new URL(a.getAttribute('href'), location.origin).href.replace(/[?#].*$/, ''); }
        catch { return ''; }
      })();
      const anchorText = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
      const imgAlt = [...a.querySelectorAll('img[alt]')].map(i => i.alt).join(' ').replace(/\s+/g, ' ').trim();
      const combined = `${anchorText} ${imgAlt} ${best}`.trim();

      if (!/LEGO|לגו|\b\d{5}\b/i.test(combined)) continue;

      const m = best.match(moneyRe);
      const priceRaw = (m?.[1] || m?.[2] || '').replace(/,/g, '');
      const price = Number(priceRaw);
      if (!Number.isFinite(price) || price <= 0) continue;

      const candidates = [anchorText, imgAlt]
        .concat(best.split(/(?:₪\s*[\d,.]+|[\d,.]+\s*₪)/).map(s => s.trim()))
        .map(s => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      let name = candidates.find(s => /LEGO|לגו/i.test(s) && s.length >= 8 && s.length <= 300);
      if (!name) name = candidates.find(s => /\b\d{5}\b/.test(s) && s.length >= 8 && s.length <= 300);
      if (!name) continue;

      const key = href || `${name}|${price}`;
      if (!seen.has(key)) seen.set(key, { name, price, currency: 'ILS', url: href || null });
    }
    return [...seen.values()];
  });

  const all = [...networkProducts, ...domProducts];
  const byKey = new Map();
  for (const p of all) {
    const key = (p.url || `${p.name}|${p.price}`).toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, p);
    } else if (!existing.url && p.url) {
      byKey.set(key, p);
    }
  }

  const products = [...byKey.values()]
    .filter(p => /LEGO|לגו|\b\d{5}\b/i.test(p.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'));

  const looksLikeKsp = /KSP|קיי\.אס\.פי/i.test(`${pageInfo.title} ${pageInfo.body}`);
  if (!looksLikeKsp) {
    writeResult({
      status: 'error',
      reason: 'Page did not look like a valid KSP page',
      diagnostics: { title: pageInfo.title, htmlLength: pageInfo.htmlLength, categorySignals: categorySignals.slice(-20) },
      products: []
    });
  } else if (products.length > 0) {
    writeResult({
      status: 'ok',
      count: products.length,
      products,
      diagnostics: { networkMatches: networkProducts.length, domMatches: domProducts.length }
    });
  } else {
    const explicitEmpty = /אין\s+(?:כרגע\s+)?מוצרים|לא\s+נמצאו\s+מוצרים|לא\s+נמצאו\s+תוצאות|0\s+מוצרים|NO_PRODUCTS|NO_RESULTS/i.test(pageInfo.body);
    if (explicitEmpty) {
      writeResult({
        status: 'empty',
        emptyVerified: true,
        emptyEvidence: 'Explicit empty-category message was present in the rendered KSP page',
        products: [],
        diagnostics: { networkMatches: networkProducts.length, domMatches: domProducts.length }
      });
    } else {
      writeResult({
        status: 'error',
        reason: 'KSP loaded, but no products were parsed and there was no explicit empty-category message. Refusing to report an empty store.',
        diagnostics: {
          title: pageInfo.title,
          htmlLength: pageInfo.htmlLength,
          networkMatches: networkProducts.length,
          domMatches: domProducts.length,
          categorySignals: categorySignals.slice(-20)
        },
        products: []
      });
    }
  }
} catch (err) {
  writeResult({ status: 'error', reason: String(err?.stack || err), products: [] });
} finally {
  if (browser) await browser.close();
}
