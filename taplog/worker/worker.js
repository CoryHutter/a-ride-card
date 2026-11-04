/* TapLog Shop middleman (Cloudflare Worker)
 *
 * Why this exists: the WPS API key must never sit inside a web page, because
 * anyone can open a page's source and copy it. This small service holds the key
 * and talks to WPS for the shop's invoice page. It also stores saved tickets and
 * each bike's service history.
 *
 * One middleman serves every shop. Each shop has its own record (name, shop ID,
 * password, WPS key, Parts Unlimited key). Keys are stored encrypted, and each shop
 * only ever reaches its own key, tickets and history. Shops are added on admin.html.
 *
 * Secrets (set in Cloudflare, never in this file):
 *   ADMIN_KEY  - Cory's password for the admin page (adding and editing shops)
 *   MASTER_KEY - a long random phrase; locks the shops' keys and passwords. Never change it,
 *                or every saved shop key has to be entered again.
 *   WPS_TOKEN, SHOP_KEY - optional, the original one-shop setup. Still works; that shop
 *                signs in with the password alone, no shop ID.
 * Storage binding:
 *   TICKETS    - a Workers KV namespace
 * Plain setting (wrangler.toml [vars]):
 *   ALLOWED_ORIGIN - the site allowed to call this, e.g. https://coryhutter.github.io
 */

const WPS = 'https://api.wps-inc.com';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const p = url.pathname.replace(/\/+$/, '');

      // ---- Public: a customer opening their invoice link, or tapping a bike's tag ----
      let m;
      if (req.method === 'GET' && (m = p.match(/^\/api\/invoice\/([A-Za-z0-9]{6,24})$/))) {
        const t = await env.TICKETS.get('t:' + m[1], 'json');
        if (!t) return json({ error: 'Invoice not found' }, 404, cors);
        return json(customerCopy(t), 200, cors);
      }
      if (req.method === 'GET' && (m = p.match(/^\/api\/bike\/([A-Za-z0-9_-]{4,40})$/))) {
        // Anyone can tap a tag, so this shows the work only: no prices, no customer, and no
        // invoice ID (that ID is what opens the customer's invoice).
        const idx = (await env.TICKETS.get('bike:' + m[1], 'json')) || [];
        return json({ tag: m[1], visits: idx.map(v => ({ no: v.no, saved: v.saved, bike: v.bike, work: v.work, status: v.status, shop: v.shop || '' })) }, 200, cors);
      }
      if (req.method === 'GET' && p === '/api/ping') {
        return json({ ok: true, wps: !!env.WPS_TOKEN, storage: !!env.TICKETS, multi: !!env.MASTER_KEY }, 200, cors);
      }

      // ---- Admin (Cory): add and edit shops ----
      if (p.startsWith('/api/admin/')) return await admin(req, env, p, cors);

      // ---- Everything else is shop-only, and runs with that shop's own key and storage ----
      const shop = await shopAuth(req, env);
      if (!shop) return json({ error: 'Shop ID or password is wrong' }, 401, cors);
      env = shopEnv(env, shop);

      if (req.method === 'GET' && p === '/api/check') {
        return json({ ok: true, shop: shop.name, id: shop.id, wps: !!shop.wps, pu: !!shop.pu, storage: !!env.GLOBAL }, 200, cors);
      }

      // Bike picker: make -> model -> year
      if (req.method === 'GET' && p === '/api/makes') {
        const rows = await wpsAll(env, ctx, '/vehiclemakes?page[size]=500', 86400);
        return json(rows.map(r => ({ id: r.id, name: r.name })).sort(byName), 200, cors);
      }
      if (req.method === 'GET' && p === '/api/models') {
        const make = num(url.searchParams.get('make'));
        const rows = await wpsAll(env, ctx, '/vehiclemodels?filter[vehiclemake_id]=' + make + '&page[size]=1000', 86400);
        return json(rows.map(r => ({ id: r.id, name: r.name })).sort(byName), 200, cors);
      }
      if (req.method === 'GET' && p === '/api/years') {
        const model = num(url.searchParams.get('model'));
        const rows = await wpsAll(env, ctx,
          '/vehicles?filter[vehiclemodel_id]=' + model + '&include=vehicleyear&page[size]=200', 86400, true);
        const out = rows.map(r => ({ vehicle: r.id, year: yearOf(r) }))
          .filter(r => r.year).sort((a, b) => b.year - a.year);
        return json(out, 200, cors);
      }

      // Parts that fit one bike, searched by words ("rear tire", "pads", "chain 520")
      if (req.method === 'GET' && p === '/api/parts') {
        const vehicle = num(url.searchParams.get('vehicle'));
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        const list = await fitList(env, ctx, vehicle);
        const words = q.split(/\s+/).filter(Boolean);
        const hits = list.filter(r => {
          const hay = (r.s + ' ' + r.n + ' ' + r.pt + ' ' + r.bn).toLowerCase();
          return words.every(w => hay.includes(w));
        });
        const top = hits.slice(0, 40);
        await addStock(env, top);
        return json({ total: list.length, matches: hits.length, parts: top.map(shape) }, 200, cors);
      }

      // Any WPS part by part number or words, no fitment (tires, oil, universal stuff)
      if (req.method === 'GET' && p === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (q.length < 2) return json({ parts: [] }, 200, cors);
        let rows = [];
        const exact = await wpsGet(env, '/items?filter[sku]=' + encodeURIComponent(q) + '&page[size]=10');
        if (exact.ok) rows = (exact.body.data || []);
        if (!rows.length && /^[0-9][0-9A-Za-z-]{1,}$/.test(q)) {
          const r = await wpsGet(env, '/items?filter[sku][pre]=' + encodeURIComponent(q) + '&page[size]=60');
          if (r.ok) rows = r.body.data || [];
        }
        if (!rows.length) {
          // Words in order, anything between them: "rear 110/90-19" -> %rear%110/90-19%
          const like = '%' + q.split(/\s+/).join('%') + '%';
          const r = await wpsGet(env, '/items?filter[name][like]=' + encodeURIComponent(like) + '&page[size]=80');
          if (r.ok) rows = r.body.data || [];
        }
        const brands = await brandMap(env, ctx);
        const top = rows.map(compact).filter(r => r.st !== 'NLA' && r.st !== 'DSC').slice(0, 40);
        top.forEach(r => { r.bn = brands[r.b] || ''; });
        await addStock(env, top);
        return json({ parts: top.map(shape) }, 200, cors);
      }

      // The shop's real cost for one part (their own discounts included)
      if (req.method === 'GET' && (m = p.match(/^\/api\/cost\/(\d+)$/))) {
        const r = await wpsGet(env, '/dealer-pricing/' + m[1]);
        if (!r.ok) return json({ cost: null }, 200, cors);
        return json({ cost: findCost(r.body) }, 200, cors);
      }

      // ---- WPS cart: puts the ticket's parts in a cart on the shop's WPS account.
      //      Nothing is ordered until someone submits that cart at wpsorders.com. ----
      if (req.method === 'POST' && p === '/api/wps-cart') {
        const b = await req.json();
        const po = String(b.po || '').trim();
        if (!/^[A-Za-z0-9 _.\-]{3,20}$/.test(po)) return json({ error: 'PO number must be 3 to 20 letters, numbers or dashes' }, 400, cors);
        const items = (Array.isArray(b.items) ? b.items : [])
          .map(i => ({ sku: String(i.sku || '').trim(), qty: parseInt(i.qty, 10), d: String(i.d || '').slice(0, 120), cost: parseFloat(i.cost) || null }))
          .filter(i => i.sku && i.qty > 0 && i.qty < 100).slice(0, 60);
        if (!items.length) return json({ error: 'No WPS parts to put in the cart' }, 400, cors);

        if (b.replace) await wpsSend(env, 'DELETE', '/carts/' + encodeURIComponent(po));
        const c = await wpsSend(env, 'POST', '/carts', { po_number: po });
        if (!c.ok) return json({ error: 'WPS wouldn’t start the cart: ' + wpsMsg(c.body) }, 400, cors);
        const cartNo = c.body && c.body.data && c.body.data.cart_number;

        const lines = [];
        for (const it of items) {
          const r = await wpsSend(env, 'POST', '/carts/' + encodeURIComponent(po) + '/items', { item_sku: it.sku, quantity: it.qty });
          const d = r.body && r.body.data;
          lines.push(r.ok && d
            ? { sku: it.sku, qty: it.qty, ok: true, available: d.available_quantity, backorder: d.backorder_quantity, price: d.dealer_price }
            : { sku: it.sku, qty: it.qty, ok: false, error: wpsMsg(r.body) });
        }
        const cart = { po, cartNo, at: new Date().toISOString(), lines, stock: !!b.stock };

        // Special-order log: every part ordered for a customer job (not stock orders).
        // Keyed by PO + part so sending the same cart again doesn't double count.
        if (!b.stock) {
          const log = (await env.TICKETS.get('solog', 'json')) || {};
          lines.filter(l => l.ok).forEach(l => {
            const src = items.find(i => i.sku === l.sku) || {};
            log[po + '|' + l.sku] = { sku: l.sku, d: src.d || '', qty: l.qty, cost: l.price != null ? l.price : src.cost,
              po, ticket: b.ticketNo || po, bike: String(b.bike || '').slice(0, 80), at: cart.at };
          });
          const keys = Object.keys(log);
          if (keys.length > 3000) keys.sort((a, c) => log[a].at < log[c].at ? -1 : 1).slice(0, keys.length - 3000).forEach(k => delete log[k]);
          await env.TICKETS.put('solog', JSON.stringify(log));
        }

        if (b.ticketId && /^[A-Za-z0-9]{6,24}$/.test(b.ticketId)) {
          const t = await env.GLOBAL.get('t:' + b.ticketId, 'json');
          if (t && ownsTicket(t, env.SHOP)) { t.wpsCart = cart; await env.GLOBAL.put('t:' + t.id, JSON.stringify(t)); }
        }
        return json(cart, 200, cors);
      }
      // Parts the shop keeps special-ordering for jobs, most-ordered first
      if (req.method === 'GET' && p === '/api/special-orders') {
        const days = Math.min(730, Math.max(7, parseInt(url.searchParams.get('days'), 10) || 365));
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const log = (await env.TICKETS.get('solog', 'json')) || {};
        return json({ days, entries: Object.values(log).filter(e => e.at >= since) }, 200, cors);
      }
      if (req.method === 'POST' && (m = p.match(/^\/api\/wps-cart\/([A-Za-z0-9 _.\-]{3,20})\/delete$/))) {
        const r = await wpsSend(env, 'DELETE', '/carts/' + encodeURIComponent(decodeURIComponent(m[1])));
        return json({ ok: r.ok || r.status === 204 }, 200, cors);
      }
      if (req.method === 'GET' && (m = p.match(/^\/api\/wps-order\/(.{3,40})$/))) {
        const po = decodeURIComponent(m[1]);
        const r = await wpsGet(env, '/orders/' + encodeURIComponent(po));
        if (!r.ok) return json({ found: false }, 200, cors);
        const o = r.body.data || {};
        return json({
          found: true,
          orders: (o.order_details || []).map(d => ({
            number: d.order_number, status: d.order_status, warehouse: d.warehouse, shipVia: d.ship_via,
            orderDate: d.order_date, shipDate: d.ship_date, total: d.order_total, tracking: d.tracking_numbers || [],
            items: (d.items || []).map(i => ({ sku: i.sku, ordered: i.order_quantity, shipped: i.ship_quantity, backorder: i.backorder_quantity }))
          }))
        }, 200, cors);
      }

      // ---- Tickets ----
      if (req.method === 'POST' && p === '/api/tickets') {
        const t = await req.json();
        if (!t || typeof t !== 'object') return json({ error: 'Bad ticket' }, 400, cors);
        if (!t.id) t.id = rid(10);
        if (!/^[A-Za-z0-9]{6,24}$/.test(t.id)) return json({ error: 'Bad id' }, 400, cors);
        const prev = await env.GLOBAL.get('t:' + t.id, 'json');
        if (prev && !ownsTicket(prev, env.SHOP)) return json({ error: 'That ticket belongs to another shop' }, 403, cors);
        t.shopId = env.SHOP.id;
        if (!t.no) {
          const n = parseInt((await env.TICKETS.get('seq')) || '1000', 10) + 1;
          await env.TICKETS.put('seq', String(n));
          t.no = 'INV-' + n;
        }
        t.saved = new Date().toISOString();
        await env.GLOBAL.put('t:' + t.id, JSON.stringify(t));

        // Recent list for the shop
        const recent = ((await env.TICKETS.get('recent', 'json')) || []).filter(x => x.id !== t.id);
        recent.unshift(summary(t));
        await env.TICKETS.put('recent', JSON.stringify(recent.slice(0, 300)));

        // Bike history, keyed by the TapLog tag on that bike
        if (t.tag && /^[A-Za-z0-9_-]{4,40}$/.test(t.tag)) {
          const idx = ((await env.GLOBAL.get('bike:' + t.tag, 'json')) || []).filter(x => x.id !== t.id);
          idx.unshift(publicSummary(t, env.SHOP));
          await env.GLOBAL.put('bike:' + t.tag, JSON.stringify(idx.slice(0, 200)));
        }
        return json({ id: t.id, no: t.no }, 200, cors);
      }
      if (req.method === 'GET' && p === '/api/tickets') {
        return json((await env.TICKETS.get('recent', 'json')) || [], 200, cors);
      }
      if (req.method === 'GET' && (m = p.match(/^\/api\/tickets\/([A-Za-z0-9]{6,24})$/))) {
        const t = await env.GLOBAL.get('t:' + m[1], 'json');
        return t && ownsTicket(t, env.SHOP) ? json(t, 200, cors) : json({ error: 'Not found' }, 404, cors);
      }

      return json({ error: 'Unknown route' }, 404, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, cors);
    }
  }
};

/* ---------------- helpers ---------------- */

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !allowed.length || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Shop-Key, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
  });
}
const num = v => { const n = parseInt(v, 10); if (!n) throw new Error('Missing number'); return n; };
const byName = (a, b) => String(a.name).localeCompare(String(b.name));
function rid(n) {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789', b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, x => a[x % a.length]).join('');
}

async function wpsGet(env, path) {
  if (!env.WPS_TOKEN) throw new Error('No WPS key saved for this shop yet');
  const r = await fetch(WPS + path, {
    headers: { Authorization: 'Bearer ' + env.WPS_TOKEN, Accept: 'application/json' }
  });
  let body = null;
  try { body = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, body };
}

async function wpsSend(env, method, path, body) {
  if (!env.WPS_TOKEN) throw new Error('No WPS key saved for this shop yet');
  const r = await fetch(WPS + path, {
    method,
    headers: { Authorization: 'Bearer ' + env.WPS_TOKEN, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  let out = null;
  try { out = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, body: out };
}
function wpsMsg(b) {
  if (!b) return 'no answer';
  if (b.errors) {
    const all = [].concat(...Object.values(b.errors).map(v => Array.isArray(v) ? v : [v]));
    if (all.length) return all.join(' ');
  }
  return b.message || 'unknown error';
}

/* Follow WPS cursor pages (up to a limit) and keep the result for `ttl` seconds. */
async function wpsAll(env, ctx, path, ttl, keepIncluded) {
  const key = 'c:' + path, kv = env.GLOBAL || env.TICKETS;
  if (ttl) { const hit = await kv.get(key, 'json'); if (hit) return hit; }
  let out = [], included = [], cursor = null, pages = 0;
  do {
    const r = await wpsGet(env, path + (cursor ? '&page[cursor]=' + encodeURIComponent(cursor) : ''));
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) throw new Error('WPS said no (' + r.status + '). Fitment may need to be unlocked on this account.');
      throw new Error('WPS error ' + r.status);
    }
    out = out.concat(r.body.data || []);
    if (keepIncluded && r.body.included) included = included.concat(r.body.included);
    cursor = r.body.meta && r.body.meta.cursor && r.body.meta.cursor.next;
    pages++;
  } while (cursor && pages < 8);
  if (keepIncluded) out.forEach(row => { row._included = included; });
  if (ttl) ctx.waitUntil(kv.put(key, JSON.stringify(out), { expirationTtl: ttl }));
  return out;
}

function yearOf(v) {
  // WPS "include" puts the year either nested on the row or in a side list
  const y = v.vehicleyear && (v.vehicleyear.data || v.vehicleyear);
  if (y && y.name) return parseInt(y.name, 10);
  const inc = (v._included || []).find(x => x.type === 'vehicleyears' && x.id == v.vehicleyear_id);
  if (inc) return parseInt(inc.name || (inc.attributes && inc.attributes.name), 10);
  return null;
}

const compact = r => ({
  i: r.id, s: r.sku, n: r.name, b: r.brand_id || null, pt: r.product_type || '',
  l: parseFloat(r.list_price) || 0,
  d: parseFloat(r.standard_dealer_price) || null,
  st: r.status || ''
});

/* Every part WPS lists for one bike, kept for a day so searches are instant. */
async function fitList(env, ctx, vehicle) {
  const key = 'fit:' + vehicle, kv = env.GLOBAL || env.TICKETS;
  const hit = await kv.get(key, 'json');
  if (hit) return hit;
  const rows = await wpsAll(env, ctx, '/vehicles/' + vehicle + '/items?page[size]=1000', 0);
  const brands = await brandMap(env, ctx);
  const list = rows.map(compact).filter(r => r.st !== 'NLA' && r.st !== 'DSC');
  list.forEach(r => { r.bn = brands[r.b] || ''; });
  ctx.waitUntil(kv.put(key, JSON.stringify(list), { expirationTtl: 86400 }));
  return list;
}

/* Live stock. WPS caps any warehouse at 25. Ashley, IN is the closest to Illinois. */
async function addStock(env, rows) {
  if (!rows.length) return;
  const r = await wpsGet(env, '/items/' + rows.map(x => x.i).join(',') + '?include=inventory');
  if (!r.ok) return;
  const data = Array.isArray(r.body.data) ? r.body.data : [r.body.data];
  const byId = {};
  data.forEach(it => {
    const inv = it.inventory && (it.inventory.data || it.inventory);
    if (!inv) return;
    let total = 0, near = 0;
    for (const k in inv) {
      if (/_warehouse$/.test(k)) { const q = parseInt(inv[k], 10) || 0; total += q; if (k === 'in_warehouse') near = q; }
    }
    if (inv.total != null) total = parseInt(inv.total, 10) || total;
    byId[it.id] = { t: total, a: near };
  });
  rows.forEach(x => { if (byId[x.i]) x.stk = byId[x.i]; });
}

const shape = r => ({ id: r.i, sku: r.s, name: r.n, brand: r.bn || '', type: r.pt || '', retail: r.l, dealer: r.d, status: r.st, stock: r.stk || null });

function findCost(body) {
  const d = body && (body.data || body);
  const row = Array.isArray(d) ? d[0] : d;
  if (!row) return null;
  for (const k of ['actual_dealer_price', 'dealer_price', 'price', 'cost', 'dealer_cost', 'your_price', 'net_price']) {
    if (row[k] != null && !isNaN(parseFloat(row[k]))) return parseFloat(row[k]);
  }
  return null;
}

/* What the customer may see: no costs, no margins. */
function customerCopy(t) {
  return {
    id: t.id, no: t.no, saved: t.saved, shop: t.shop, customer: t.customer,
    bike: t.bike, notes: t.notes, status: t.status,
    lines: (t.lines || []).map(l => ({ sku: l.sku, d: l.d, qty: l.qty, unit: l.unit, amt: l.amt, labor: !!l.labor })),
    totals: t.totals, policy: t.policy
  };
}
function summary(t) {
  return { id: t.id, no: t.no, saved: t.saved, name: (t.customer && t.customer.name) || '',
           bike: t.bike || '', total: t.totals && t.totals.total, status: t.status || '' };
}
function publicSummary(t, shop) {
  // id is kept only so a re-saved ticket replaces its old entry; the public route strips it
  return { id: t.id, no: t.no, saved: t.saved, bike: t.bike || '',
           shop: (t.shop && t.shop.name) || (shop && shop.name) || '',
           work: (t.lines || []).map(l => l.d).slice(0, 8), status: t.status || '' };
}

/* WPS brand names by id, kept for a day */
async function brandMap(env, ctx) {
  const kv = env.GLOBAL || env.TICKETS;
  const hit = await kv.get('brands', 'json');
  if (hit) return hit;
  const rows = await wpsAll(env, ctx, '/brands?page[size]=1000', 0);
  const map = {};
  rows.forEach(b => { map[b.id] = b.name; });
  ctx.waitUntil(kv.put('brands', JSON.stringify(map), { expirationTtl: 86400 }));
  return map;
}

/* ---------------- shops ---------------- */

const SHOP_ID = /^[a-z0-9-]{2,30}$/;

/* Which shop is calling. The iPad sends "shopid:password". The original one-shop
   setup sends the SHOP_KEY password alone and keeps using WPS_TOKEN. */
async function shopAuth(req, env) {
  const h = req.headers.get('X-Shop-Key') || '';
  if (env.SHOP_KEY && same(h, env.SHOP_KEY)) {
    return { id: 'default', name: '', wps: env.WPS_TOKEN || '', pu: env.PU_KEY || '' };
  }
  const i = h.indexOf(':');
  if (i < 1 || !env.MASTER_KEY) return null;
  const id = h.slice(0, i).trim().toLowerCase(), pass = h.slice(i + 1);
  if (!SHOP_ID.test(id) || !pass) return null;
  const s = await env.TICKETS.get('shop:' + id, 'json');
  if (!s || s.off) return null;
  if (!same(await passHash(env, id, pass), s.ph)) return null;
  return { id, name: s.name, wps: s.wps ? await unlock(env, s.wps) : '', pu: s.pu ? await unlock(env, s.pu) : '' };
}

/* The same env, but WPS calls use this shop's key and storage is this shop's own drawer.
   Tickets (customer links), bike tags and catalog caches stay in the shared GLOBAL store. */
function shopEnv(env, shop) {
  const kv = env.TICKETS, pre = shop.id === 'default' ? '' : 's:' + shop.id + ':';
  return Object.assign({}, env, {
    WPS_TOKEN: shop.wps, PU_KEY: shop.pu, SHOP: shop, GLOBAL: kv,
    TICKETS: {
      get: (k, t) => kv.get(pre + k, t),
      put: (k, v, o) => kv.put(pre + k, v, o),
      delete: k => kv.delete(pre + k)
    }
  });
}
const ownsTicket = (t, shop) => (t.shopId || 'default') === shop.id;

async function admin(req, env, p, cors) {
  if (!env.ADMIN_KEY || !same(req.headers.get('X-Admin-Key') || '', env.ADMIN_KEY)) {
    return json({ error: 'Admin key missing or wrong' }, 401, cors);
  }
  if (!env.MASTER_KEY) return json({ error: 'MASTER_KEY isn’t set on the middleman yet (setup step 4)' }, 400, cors);
  const kv = env.TICKETS;
  let m;

  if (req.method === 'GET' && p === '/api/admin/shops') {
    const out = [];
    let cursor;
    do {
      const l = await kv.list({ prefix: 'shop:', cursor });
      for (const k of l.keys) { const s = await kv.get(k.name, 'json'); if (s) out.push(shopRow(s)); }
      cursor = l.list_complete ? null : l.cursor;
    } while (cursor);
    return json(out.sort((a, b) => a.name.localeCompare(b.name)), 200, cors);
  }

  if (req.method === 'POST' && p === '/api/admin/shops') {
    const b = await req.json();
    const id = String(b.id || '').trim().toLowerCase();
    if (!SHOP_ID.test(id) || id === 'default') return json({ error: 'Shop ID: 2 to 30 lowercase letters, numbers or dashes' }, 400, cors);
    const old = await kv.get('shop:' + id, 'json');
    const name = String(b.name || (old && old.name) || '').trim().slice(0, 60);
    if (!name) return json({ error: 'Shop name is needed' }, 400, cors);
    const pass = String(b.password || '');
    if (!old && !pass) return json({ error: 'A new shop needs a password' }, 400, cors);
    if (pass && pass.length < 8) return json({ error: 'Password needs at least 8 characters' }, 400, cors);
    if (b.isNew && old) return json({ error: 'There’s already a shop with ID ' + id }, 400, cors);
    const s = Object.assign({ id, created: new Date().toISOString() }, old || {}, { name, updated: new Date().toISOString() });
    if (pass) s.ph = await passHash(env, id, pass);
    const wps = String(b.wps || '').trim(), pu = String(b.pu || '').trim();
    if (wps) { s.wps = await lock(env, wps); s.wpsEnd = wps.slice(-4); }
    if (pu) { s.pu = await lock(env, pu); s.puEnd = pu.slice(-4); }
    if (b.clearPu) { delete s.pu; delete s.puEnd; }
    if (typeof b.off === 'boolean') s.off = b.off;
    await kv.put('shop:' + id, JSON.stringify(s));
    return json(shopRow(s), 200, cors);
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/admin\/shops\/([a-z0-9-]{2,30})\/delete$/))) {
    // Removes the sign-in and keys only. The shop's tickets stay, in case it's added back.
    await kv.delete('shop:' + m[1]);
    return json({ ok: true }, 200, cors);
  }

  if (req.method === 'POST' && p === '/api/admin/test-wps') {
    const b = await req.json();
    let tok = String(b.wps || '').trim();
    if (!tok && b.id) { const s = await kv.get('shop:' + String(b.id).toLowerCase(), 'json'); if (s && s.wps) tok = await unlock(env, s.wps); }
    if (!tok) return json({ ok: false, msg: 'No WPS key to test' }, 200, cors);
    const t = { WPS_TOKEN: tok };
    const a = await wpsGet(t, '/items?page[size]=1');
    if (!a.ok) return json({ ok: false, msg: a.status === 401 ? 'WPS doesn’t accept this key. Check it was copied whole.' : 'WPS answered with error ' + a.status }, 200, cors);
    const f = await wpsGet(t, '/vehiclemakes?page[size]=1');
    const item = a.body && a.body.data && a.body.data[0];
    let priced = null;
    if (item) { const d = await wpsGet(t, '/dealer-pricing/' + item.id); priced = d.ok && findCost(d.body) != null; }
    return json({ ok: true, fitment: f.ok, pricing: priced,
      msg: 'Key works.' + (f.ok ? ' Fitment is on.' : ' Fitment is NOT unlocked on this account yet, so "fits this bike" won’t work.') +
           (priced === false ? ' Dealer pricing didn’t come back, so it will fall back to standard dealer cost.' : '') }, 200, cors);
  }

  return json({ error: 'Unknown admin route' }, 404, cors);
}
function shopRow(s) {
  return { id: s.id, name: s.name, wps: !!s.wps, wpsEnd: s.wpsEnd || '', pu: !!s.pu, puEnd: s.puEnd || '',
           off: !!s.off, created: s.created, updated: s.updated };
}

/* ---------------- locking keys ---------------- */
const te = new TextEncoder();
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function aesKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', te.encode('taplog-lock|' + env.MASTER_KEY));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function lock(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), te.encode(text));
  return b64(iv) + '.' + b64(new Uint8Array(ct));
}
async function unlock(env, box) {
  const [iv, ct] = String(box).split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct));
  return new TextDecoder().decode(pt);
}
async function passHash(env, id, pass) {
  const d = await crypto.subtle.digest('SHA-256', te.encode('taplog-pass|' + env.MASTER_KEY + '|' + id + '|' + pass));
  return b64(new Uint8Array(d));
}
function same(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
