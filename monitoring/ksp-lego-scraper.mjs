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

const checkedAt = `${now.year}-${now.month}-${now.day}T${now.hour}:${now.minute}:${now.second}+Asia/Jerusalem`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });

function writeResult(obj) {
  fs.writeFileSync(OUT, JSON.stringify({ source: URL, checkedAt, ...obj }, null, 2) + '\n');
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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(8000);

  // Dismiss common cookie dialogs if they appear.
  for (const label of ['אישור', 'מאשר', 'קראתי', 'Accept', 'OK']) {
    const btn = page.getByRole('button', { name: label, exact: false }).first();
    if (await btn.count()) {
      try { await btn.click({ timeout: 1500 }); } catch {}
    }
  }

  // Load lazy content and click "show more" style controls when present.
  for (let round = 0; round < 18; round++) {
    const before = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(900);

    const more = page.getByText(/SHOW_MORE_PRODUCTS|הצג עוד|טען עוד|עוד מוצרים/i).last();
    if (await more.count()) {
      try { await more.click({ timeout: 1200 }); await page.waitForTimeout(1200); } catch {}
    }

    const after = await page.evaluate(() => document.body.scrollHeight);
    if (after === before && round >= 4) break;
  }

  const pageInfo = await page.evaluate(() => ({
    title: document.title,
    body: (document.body?.innerText || '').slice(0, 120000),
    url: location.href
  }));

  const obviousFailure = /ERROR_API|Failed to fetch|ארעה שגיאה בהבאת נתונים|Access Denied|Forbidden|captcha|robot/i.test(pageInfo.body);
  if (obviousFailure) {
    writeResult({ status: 'error', reason: 'KSP page loaded but reported an API/access error', products: [] });
    process.exit(0);
  }

  const raw = await page.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[href]')]
      .filter(a => /\/item\/|\/web\/item\//i.test(a.getAttribute('href') || ''));

    return anchors.map(a => {
      let node = a;
      let block = '';
      for (let i = 0; i < 7 && node; i++, node = node.parentElement) {
        const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
        if ((/₪\s*[\d,.]+|[\d,.]+\s*₪/.test(t)) && t.length < 1800) {
          block = t;
          break;
        }
      }
      return {
        href: new URL(a.getAttribute('href'), location.origin).href,
        anchorText: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim(),
        block
      };
    });
  });

  const byKey = new Map();
  for (const r of raw) {
    const text = `${r.anchorText} ${r.block}`.trim();
    if (!/LEGO|לגו/i.test(text)) continue;

    const p1 = text.match(/₪\s*([\d,.]+)/);
    const p2 = text.match(/([\d,.]+)\s*₪/);
    const priceText = (p1?.[1] || p2?.[1] || '').replace(/,/g, '');
    const price = priceText ? Number(priceText) : null;

    let name = r.anchorText;
    if (!name || name.length < 5 || /^₪|^[\d,.]+\s*₪/.test(name)) {
      const lines = r.block.split(/\n| {2,}/).map(s => s.trim()).filter(Boolean);
      name = lines.find(s => /LEGO|לגו/i.test(s) && !/₪/.test(s)) || lines.find(s => s.length > 15 && !/₪/.test(s)) || '';
    }

    name = name.replace(/\s+/g, ' ').trim();
    if (!name || !price) continue;

    const key = r.href.replace(/[?#].*$/, '');
    if (!byKey.has(key)) byKey.set(key, { name, price, currency: 'ILS', url: key });
  }

  const products = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'he'));

  // A successfully rendered KSP page with no matching item cards is a valid empty result.
  const looksLikeKsp = /KSP|קיי\.אס\.פי/i.test(`${pageInfo.title} ${pageInfo.body}`);
  if (!looksLikeKsp) {
    writeResult({ status: 'error', reason: 'Page did not look like a valid KSP page', products: [] });
  } else if (products.length === 0) {
    writeResult({ status: 'empty', products: [] });
  } else {
    writeResult({ status: 'ok', count: products.length, products });
  }
} catch (err) {
  writeResult({ status: 'error', reason: String(err?.stack || err), products: [] });
} finally {
  if (browser) await browser.close();
}
