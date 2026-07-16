// ==UserScript==
// @name         BOM-Line Stamper
// @namespace    https://greenshoegarage.com/
// @version      0.2.2
// @description  Grab MPN, description, and the price-break ladder off a distributor product page and copy it straight into TALLY, either as a BOM CSV (Bill) or a job JSON with the vendor offer already attached (Load job). Collects a batch across pages.
// @author       Green Shoe Garage
// @match        https://*.mouser.com/*
// @match        https://*.digikey.com/*
// @match        https://*.lcsc.com/*
// @include      /^https?:\/\/([^/]+\.)?mouser\.[a-z.]+\/.*/
// @include      /^https?:\/\/([^/]+\.)?digikey\.[a-z.]+\/.*/
// @include      /^https?:\/\/([^/]+\.)?lcsc\.[a-z.]+\/.*/
// @run-at       document-idle
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

/*
 * BOM-Line Stamper :: bom-stamper.user.js :: v0.2.2
 * License: GPL-3.0
 *
 * v0.2.1: button moved to bottom-left (Mouser parks its own chat widget bottom-right).
 * Match broadened to the whole vendor site plus regional TLDs, and re-asserted across
  * single-page navigations, so the button shows on a product page however you arrived at it.
 * A one-line console note on load (BOM-Line Stamper active) tells you the script ran at all.
 *
 * v0.2.2: export buttons now SAVE a named file (.csv / .json) and also copy to the
 * clipboard, so the download feeds straight into TALLY's Import file picker.
 *
 * A companion to TALLY (FI-094). It reads a distributor product page and produces
 * data shaped to TALLY's own importers, verified against tally.html:
 *
 *   BOM CSV  -> TALLY "Import CSV" button. Header is exactly ref,mpn,description,qty,
 *              the tokens importBOM() matches. Appends parts (no price) to the CURRENT bill.
 *
 *   TALLY job JSON -> TALLY "Load job" button. Shape is { meta, buildQty, bom:[ line ] }
 *              where each line is { ref, mpn, desc, qtyPer, offers:[ offer ] } and each
 *              offer is { vendor, sku, moq, pack, leadDays, stock, breaks:[{qty,price}] }.
 *              sanitizeJob() coerces this and defaults everything else, so a new job lands
 *              with the whole price ladder attached. This is the paste-free path.
 *
 * TALLY is single-currency, so currency is kept for your reference but is not written into
 * the job. Extraction runs in layers (JSON-LD, meta, per-site adapters, labeled-DOM
 * heuristic); the per-site selectors are best-effort and every field is editable in the
 * panel, with anything not found flagged. No em dashes anywhere by house rule.
 */

(function () {
  'use strict';

  const STORE_KEY = 'bom_stamper_cart_v1';

  // ---- Record shape (panel-friendly; mapped to TALLY keys at export) ------
  function blankRecord() {
    return {
      ref: '',
      mpn: '',
      manufacturer: '',
      description: '',
      qty: '1',
      distributor: '',
      distributorPartNumber: '',
      currency: '',
      unitPrice: '',
      priceBreaks: [],
      moq: '',
      packMultiple: '',
      leadDays: '',
      stock: '',
      datasheetUrl: '',
      productUrl: location.href,
      capturedAt: new Date().toISOString()
    };
  }

  // ---- Small helpers ------------------------------------------------------
  const txt = (el) => (el && el.textContent ? el.textContent.trim() : '');

  function toNumber(s) {
    if (s === null || s === undefined) return '';
    const m = String(s).replace(/[, ]/g, '').match(/-?\d+(\.\d+)?/);
    return m ? m[0] : '';
  }

  function currencyOf(s) {
    if (!s) return '';
    if (/\$|USD/i.test(s)) return 'USD';
    if (/\u20ac|EUR/i.test(s)) return 'EUR';
    if (/\u00a3|GBP/i.test(s)) return 'GBP';
    if (/\u00a5|CNY|RMB/i.test(s)) return 'CNY';
    return '';
  }

  function valueByLabel(labelRe) {
    for (const dt of document.querySelectorAll('dt, th, [class*="label" i], [class*="attr" i]')) {
      if (labelRe.test(txt(dt))) {
        const dd = dt.nextElementSibling;
        if (dd && txt(dd)) return txt(dd);
      }
    }
    for (const row of document.querySelectorAll('tr, li, div')) {
      const cells = row.children;
      if (cells.length >= 2 && labelRe.test(txt(cells[0]))) {
        const v = txt(cells[1]);
        if (v) return v;
      }
    }
    return '';
  }

  // ---- Layer 1: JSON-LD ---------------------------------------------------
  function fromJsonLd(rec) {
    const blocks = document.querySelectorAll('script[type="application/ld+json"]');
    for (const b of blocks) {
      let data;
      try { data = JSON.parse(b.textContent); } catch (e) { continue; }
      const arr = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const node of arr) {
        if (!node || typeof node !== 'object') continue;
        const type = node['@type'];
        const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
        if (!isProduct) continue;
        if (!rec.description && node.name) rec.description = String(node.name).trim();
        if (!rec.mpn && (node.mpn || node.sku || node.productID)) {
          rec.mpn = String(node.mpn || node.sku || node.productID).trim();
        }
        if (!rec.manufacturer && node.brand) {
          rec.manufacturer = String(node.brand.name || node.brand).trim();
        }
        const offers = node.offers ? (Array.isArray(node.offers) ? node.offers : [node.offers]) : [];
        for (const off of offers) {
          if (!off) continue;
          if (!rec.unitPrice && (off.price || off.lowPrice)) {
            rec.unitPrice = toNumber(off.price || off.lowPrice);
          }
          if (!rec.currency && off.priceCurrency) rec.currency = off.priceCurrency;
        }
      }
    }
  }

  // ---- Layer 2: meta tags -------------------------------------------------
  function metaContent(sel) {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  function fromMeta(rec) {
    if (!rec.description) {
      rec.description = metaContent('meta[property="og:title"]') || metaContent('meta[name="title"]');
    }
    if (!rec.unitPrice) {
      const p = metaContent('meta[property="product:price:amount"]') || metaContent('meta[itemprop="price"]');
      if (p) rec.unitPrice = toNumber(p);
    }
    if (!rec.currency) {
      rec.currency = metaContent('meta[property="product:price:currency"]') || rec.currency;
    }
  }

  // ---- Layer 4: price-break table heuristic -------------------------------
  function harvestPriceBreaks() {
    const breaks = [];
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      let hits = 0;
      const local = [];
      for (const r of rows) {
        const cells = Array.from(r.children).map(txt);
        let qty = '', price = '';
        for (const c of cells) {
          if (!qty && /^\s*[\d,]+\s*\+?\s*$/.test(c)) qty = toNumber(c);
          else if (!price && /[\$\u20ac\u00a3\u00a5]|\bUSD|\bEUR|\bCNY/i.test(c)) price = toNumber(c);
        }
        if (qty && price) { local.push({ qty: Number(qty), price: Number(price) }); hits++; }
      }
      if (hits >= 2) { breaks.push(...local); break; }
    }
    const seen = new Set();
    return breaks
      .sort((a, b) => a.qty - b.qty)
      .filter((x) => { const k = x.qty + ':' + x.price; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // ---- Per-site adapters --------------------------------------------------
  const ADAPTERS = [
    {
      name: 'Mouser',
      test: () => /mouser\.com/i.test(location.host),
      apply(rec) {
        rec.distributor = 'Mouser';
        rec.mpn = rec.mpn || valueByLabel(/manufacturer part\s*(no|number)/i);
        rec.manufacturer = rec.manufacturer || valueByLabel(/^manufacturer$/i);
        rec.distributorPartNumber = rec.distributorPartNumber || valueByLabel(/mouser part\s*(no|number)/i);
        rec.description = rec.description || valueByLabel(/^description$/i);
        rec.stock = rec.stock || toNumber(valueByLabel(/in stock|availability/i));
        rec.datasheetUrl = rec.datasheetUrl || datasheetHref(/datasheet/i);
      }
    },
    {
      name: 'DigiKey',
      test: () => /digikey\./i.test(location.host),
      apply(rec) {
        rec.distributor = 'Digi-Key';
        rec.mpn = rec.mpn || valueByLabel(/manufacturer product number|mfr\.?\s*part/i);
        rec.manufacturer = rec.manufacturer || valueByLabel(/^manufacturer$/i);
        rec.distributorPartNumber = rec.distributorPartNumber || valueByLabel(/digi-?key part\s*(number|#)/i);
        rec.description = rec.description || valueByLabel(/^description$/i);
        rec.stock = rec.stock || toNumber(valueByLabel(/quantity available|in stock/i));
        rec.moq = rec.moq || toNumber(valueByLabel(/minimum quantity|minimum order/i));
        rec.datasheetUrl = rec.datasheetUrl || datasheetHref(/datasheet/i);
      }
    },
    {
      name: 'LCSC',
      test: () => /lcsc\.com/i.test(location.host),
      apply(rec) {
        rec.distributor = 'LCSC';
        rec.mpn = rec.mpn || valueByLabel(/mfr\.?\s*part|manufacturer part/i);
        rec.manufacturer = rec.manufacturer || valueByLabel(/^(mfr|manufacturer|brand)$/i);
        rec.distributorPartNumber = rec.distributorPartNumber || valueByLabel(/lcsc part\s*(number|#)?/i);
        rec.description = rec.description || valueByLabel(/^description$/i);
        rec.stock = rec.stock || toNumber(valueByLabel(/stock/i));
        rec.datasheetUrl = rec.datasheetUrl || datasheetHref(/datasheet/i);
      }
    }
  ];

  function datasheetHref(re) {
    for (const a of document.querySelectorAll('a[href]')) {
      if (re.test(txt(a)) || re.test(a.getAttribute('href') || '')) {
        try { return new URL(a.getAttribute('href'), location.href).href; } catch (e) { /* ignore */ }
      }
    }
    return '';
  }

  // ---- Orchestration ------------------------------------------------------
  function extract() {
    const rec = blankRecord();
    fromJsonLd(rec);
    fromMeta(rec);
    const adapter = ADAPTERS.find((a) => a.test());
    if (adapter) adapter.apply(rec);
    if (!rec.distributor) rec.distributor = location.host.replace(/^www\./, '');

    rec.priceBreaks = harvestPriceBreaks();
    if (rec.priceBreaks.length) {
      if (!rec.unitPrice) rec.unitPrice = String(rec.priceBreaks[0].price);
      if (!rec.moq) rec.moq = String(rec.priceBreaks[0].qty);
    }
    if (!rec.currency) rec.currency = currencyOf(document.body.innerText.slice(0, 5000)) || 'USD';
    return rec;
  }

  // ---- Serialization: BOM CSV (Bill) --------------------------------------
  const BOM_COLUMNS = ['ref', 'mpn', 'description', 'qty'];

  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function recToBomRow(rec) {
    return [csvCell(rec.ref), csvCell(rec.mpn), csvCell(rec.description), csvCell(Number(toNumber(rec.qty)) || 1)].join(',');
  }

  function toBomCsv(records) {
    return [BOM_COLUMNS.join(',')].concat(records.map(recToBomRow)).join('\n');
  }

  // ---- Serialization: TALLY job JSON (Load job) ---------------------------
  function recToLine(rec) {
    let breaks = (rec.priceBreaks || [])
      .filter((b) => b.qty || b.price)
      .map((b) => ({ qty: Number(toNumber(b.qty)) || 1, price: Number(toNumber(b.price)) || 0 }));
    if (!breaks.length && rec.unitPrice) {
      breaks = [{ qty: Number(toNumber(rec.moq)) || 1, price: Number(toNumber(rec.unitPrice)) || 0 }];
    }
    const offer = {
      vendor: rec.distributor || '',
      sku: rec.distributorPartNumber || '',
      moq: Number(toNumber(rec.moq)) || 0,
      pack: Number(toNumber(rec.packMultiple)) || 1,
      leadDays: Number(toNumber(rec.leadDays)) || 0,
      stock: Number(toNumber(rec.stock)) || 0,
      breaks: breaks
    };
    const hasOffer = offer.vendor || offer.breaks.length;
    return {
      ref: rec.ref || '',
      mpn: rec.mpn || '',
      desc: rec.description || '',
      qtyPer: Number(toNumber(rec.qty)) || 1,
      offers: hasOffer ? [offer] : []
    };
  }

  function toTallyJob(records) {
    const day = new Date().toISOString().slice(0, 10);
    return JSON.stringify({
      meta: { title: 'Stamped BOM ' + day },
      buildQty: 1,
      bom: records.map(recToLine)
    }, null, 2);
  }

  // ---- Cart (batch across pages) -----------------------------------------
  async function getCart() {
    const raw = await GM_getValue(STORE_KEY, '[]');
    try { return JSON.parse(raw); } catch (e) { return []; }
  }
  async function setCart(list) { await GM_setValue(STORE_KEY, JSON.stringify(list)); }

  // ---- UI (isolated in a shadow root) ------------------------------------
  let host, root, panel;

  const CSS = `
    :host { all: initial; }
    .fab {
      position: fixed; left: 18px; bottom: 18px; z-index: 2147483647;
      font: 600 13px/1.2 ui-monospace, Menlo, Consolas, monospace;
      background: #14202b; color: #e7eef5; border: 1px solid #2c4053;
      border-radius: 10px; padding: 10px 14px; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.35); min-height: 44px;
    }
    .fab:hover { background: #1b2d3c; }
    .fab .n { color: #7fd1b9; }
    .panel {
      position: fixed; left: 18px; bottom: 74px; z-index: 2147483647; width: 384px;
      max-height: 80vh; overflow: auto; background: #0f1922; color: #e7eef5;
      border: 1px solid #2c4053; border-radius: 12px; padding: 14px;
      font: 13px/1.4 ui-monospace, Menlo, Consolas, monospace;
      box-shadow: 0 8px 28px rgba(0,0,0,.5);
    }
    .panel h2 { font-size: 13px; margin: 0 0 4px; color: #7fd1b9; letter-spacing: .04em; }
    .panel .sub { color: #9fb3c4; font-size: 11px; margin: 0 0 10px; }
    .row { display: grid; grid-template-columns: 96px 1fr; gap: 6px; align-items: center; margin-bottom: 6px; }
    .row label { color: #9fb3c4; font-size: 11px; }
    .row input {
      width: 100%; box-sizing: border-box; background: #142230; color: #e7eef5;
      border: 1px solid #2c4053; border-radius: 6px; padding: 6px 8px; font: inherit;
    }
    .row input:focus { outline: 2px solid #7fd1b9; outline-offset: 1px; }
    .row.missing input { border-color: #c46a5a; }
    .breaks { margin: 8px 0; }
    .breaks .b { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; margin-bottom: 4px; }
    .breaks button.x { background: #2a1a1a; border: 1px solid #5a3630; color: #e0b4ac; border-radius: 6px; cursor: pointer; }
    .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .btns button {
      flex: 1 1 auto; min-height: 40px; background: #14202b; color: #e7eef5;
      border: 1px solid #2c4053; border-radius: 8px; padding: 8px 10px; cursor: pointer; font: inherit;
    }
    .btns button.primary { background: #1c3a30; border-color: #2f6a55; color: #b8f0dd; }
    .btns button:hover { filter: brightness(1.15); }
    .foot { margin-top: 10px; display: flex; justify-content: space-between; align-items: center; color: #9fb3c4; font-size: 11px; }
    .foot a { color: #7fd1b9; cursor: pointer; text-decoration: underline; }
    .toast { margin-top: 8px; color: #7fd1b9; font-size: 11px; min-height: 14px; }
    .addbreak { background: #142230; border: 1px dashed #2c4053; color: #9fb3c4; border-radius: 6px; cursor: pointer; padding: 4px; width: 100%; }
  `;

  const FIELDS = [
    ['ref', 'Ref'], ['mpn', 'MPN'], ['manufacturer', 'Mfr'], ['description', 'Desc'],
    ['qty', 'Qty/unit'], ['distributor', 'Vendor'], ['distributorPartNumber', 'Vendor #'],
    ['currency', 'Cur'], ['unitPrice', 'Unit'], ['moq', 'MOQ'],
    ['packMultiple', 'Pack'], ['leadDays', 'Lead d'], ['stock', 'Stock'], ['datasheetUrl', 'Datasheet']
  ];

  const REQUIRED = ['mpn', 'description'];

  function mount() {
    if (host && document.body && document.body.contains(host)) return;
    console.info('BOM-Line Stamper v0.2.2 active on ' + location.host);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.innerHTML = 'Stamp BOM <span class="n">(0)</span>';
    fab.addEventListener('click', togglePanel);
    root.appendChild(fab);
    refreshCount();
  }

  async function refreshCount() {
    const cart = await getCart();
    const n = root.querySelector('.fab .n');
    if (n) n.textContent = '(' + cart.length + ')';
  }

  let current = null;

  async function togglePanel() {
    if (panel) { panel.remove(); panel = null; return; }
    current = extract();
    panel = document.createElement('div');
    panel.className = 'panel';
    render();
    root.appendChild(panel);
  }

  function fieldRow(key, label) {
    const missing = REQUIRED.indexOf(key) >= 0 && !current[key];
    const div = document.createElement('div');
    div.className = 'row' + (missing ? ' missing' : '');
    const l = document.createElement('label');
    l.textContent = label;
    const input = document.createElement('input');
    input.value = current[key] || '';
    input.addEventListener('input', () => { current[key] = input.value; });
    div.appendChild(l);
    div.appendChild(input);
    return div;
  }

  function breaksEditor() {
    const wrap = document.createElement('div');
    wrap.className = 'breaks';
    const title = document.createElement('div');
    title.className = 'row';
    title.innerHTML = '<label>Breaks</label><span style="color:#9fb3c4;font-size:11px">qty / price</span>';
    wrap.appendChild(title);

    function drawRows() {
      wrap.querySelectorAll('.b').forEach((n) => n.remove());
      const adder = wrap.querySelector('.addbreak');
      current.priceBreaks.forEach((brk, i) => {
        const b = document.createElement('div');
        b.className = 'b';
        const q = document.createElement('input'); q.value = brk.qty; q.placeholder = 'qty';
        const p = document.createElement('input'); p.value = brk.price; p.placeholder = 'price';
        q.addEventListener('input', () => { current.priceBreaks[i].qty = Number(toNumber(q.value)) || 0; });
        p.addEventListener('input', () => { current.priceBreaks[i].price = Number(toNumber(p.value)) || 0; });
        const x = document.createElement('button'); x.className = 'x'; x.textContent = 'x';
        x.addEventListener('click', () => { current.priceBreaks.splice(i, 1); drawRows(); });
        b.appendChild(q); b.appendChild(p); b.appendChild(x);
        wrap.insertBefore(b, adder);
      });
    }

    const add = document.createElement('button');
    add.className = 'addbreak';
    add.textContent = '+ add break';
    add.addEventListener('click', () => { current.priceBreaks.push({ qty: 0, price: 0 }); drawRows(); });
    wrap.appendChild(add);
    drawRows();
    return wrap;
  }

  function render() {
    panel.innerHTML = '';
    const h = document.createElement('h2');
    h.textContent = 'BOM-LINE STAMPER';
    panel.appendChild(h);
    const sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = 'Buttons save a file and copy it. CSV imports to the Bill, job JSON loads a new job.';
    panel.appendChild(sub);

    FIELDS.forEach(([k, lbl]) => panel.appendChild(fieldRow(k, lbl)));
    panel.appendChild(breaksEditor());

    const btns = document.createElement('div');
    btns.className = 'btns';
    btns.appendChild(button('Add to cart', 'primary', addToCart));
    btns.appendChild(button('BOM CSV', '', () => deliver(toBomCsv([normalize(current)]), 'bom-' + slug(current.mpn) + '.csv', 'text/csv')));
    btns.appendChild(button('TALLY job', '', () => deliver(toTallyJob([normalize(current)]), 'tally-job-' + slug(current.mpn) + '.json', 'application/json')));
    panel.appendChild(btns);

    const cartBtns = document.createElement('div');
    cartBtns.className = 'btns';
    cartBtns.appendChild(button('Cart to BOM CSV', '', () => deliverCart(toBomCsv, 'bom-cart-' + today() + '.csv', 'text/csv')));
    cartBtns.appendChild(button('Cart to TALLY job', '', () => deliverCart(toTallyJob, 'tally-job-' + today() + '.json', 'application/json')));
    panel.appendChild(cartBtns);

    const toast = document.createElement('div');
    toast.className = 'toast';
    panel.appendChild(toast);

    const foot = document.createElement('div');
    foot.className = 'foot';
    foot.innerHTML = '<span>v0.2.2 GPL-3.0</span>';
    const clear = document.createElement('a');
    clear.textContent = 'clear cart';
    clear.addEventListener('click', async () => { await setCart([]); refreshCount(); flash('cart cleared'); });
    foot.appendChild(clear);
    panel.appendChild(foot);
  }

  function button(label, cls, fn) {
    const b = document.createElement('button');
    if (cls) b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  function normalize(rec) {
    const r = Object.assign({}, rec);
    r.priceBreaks = (r.priceBreaks || []).filter((b) => b.qty || b.price);
    return r;
  }

  async function addToCart() {
    const cart = await getCart();
    cart.push(normalize(current));
    await setCart(cart);
    refreshCount();
    flash('added, cart has ' + cart.length);
  }

  async function deliverCart(serializer, filename, mime) {
    const cart = await getCart();
    if (!cart.length) return flash('cart is empty');
    deliver(serializer(cart), filename, mime);
  }

  // A userscript cannot write straight to disk, so we hand the browser a Blob and
  // click a temporary link. TALLY reads this file through its own Import file picker.
  function slug(s) {
    return String(s || 'part').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'part';
  }
  function today() { return new Date().toISOString().slice(0, 10); }

  function saveFile(text, filename, mime) {
    try {
      const blob = new Blob([text], { type: mime || 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
      return true;
    } catch (e) { return false; }
  }

  // One click gives you both: a file for TALLY, and the same text on the clipboard.
  function deliver(text, filename, mime) {
    GM_setClipboard(text, 'text');
    const saved = saveFile(text, filename, mime);
    flash(saved ? 'saved ' + filename + ' (also copied)' : 'download blocked, copied to clipboard');
  }

  function flash(msg) {
    const t = panel && panel.querySelector('.toast');
    if (t) { t.textContent = msg; setTimeout(() => { if (t) t.textContent = ''; }, 2500); }
  }

  GM_registerMenuCommand('Open / close panel', () => { ensureMounted(); togglePanel(); });
  GM_registerMenuCommand('Save cart as BOM CSV', () => deliverCart(toBomCsv, 'bom-cart-' + today() + '.csv', 'text/csv'));
  GM_registerMenuCommand('Save cart as TALLY job', () => deliverCart(toTallyJob, 'tally-job-' + today() + '.json', 'application/json'));
  GM_registerMenuCommand('Clear cart', async () => { await setCart([]); refreshCount(); });

  function ensureMounted() {
    if (!host || !document.body || !document.body.contains(host)) mount();
  }

  // These vendors sometimes swap pages without a full reload. Re-assert the button
  // and drop any stale panel so the next Stamp reads the page you are actually on.
  function onNav() {
    if (panel) { panel.remove(); panel = null; }
    setTimeout(ensureMounted, 300);
  }
  ['pushState', 'replaceState'].forEach((m) => {
    const orig = history[m];
    history[m] = function () { const r = orig.apply(this, arguments); onNav(); return r; };
  });
  window.addEventListener('popstate', onNav);
  window.addEventListener('hashchange', onNav);

  if (document.body) mount();
  else window.addEventListener('DOMContentLoaded', mount);
})();
