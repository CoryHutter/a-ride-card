/* TapLog Shop middleman (Cloudflare Worker)
 *
 * Why this exists: the WPS API key must never sit inside a web page, because
 * anyone can open a page's source and copy it. This small service holds the key
 * and talks to WPS for the shop's invoice page. It also stores saved tickets and
 * each bike's service history.
 *
 * Secrets (set in Cloudflare, never in this file):
 *   WPS_TOKEN  - the shop's WPS API token
 *   SHOP_KEY   - a password the shop's iPad sends; keeps strangers off the proxy
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
        const idx = (await env.TICKETS.get('bike:' + m[1], 'json')) || [];
        return json({ tag: m[1], visits: idx }, 200, cors);
      }
      if (req.method === 'GET' && p === '/api/ping') {
        return json({ ok: true, wps: !!env.WPS_TOKEN, storage: !!env.TICKETS }, 200, cors);
      }

      // ---- Everything else is shop-only ----
      if (!env.SHOP_KEY || req.headers.get('X-Shop-Key') !== env.SHOP_KEY) {
        return json({ error: 'Shop key missing or wrong' }, 401, cors);
      }

      if (req.method === 'GET' && p === '/api/check') return json({ ok: true }, 200, cors);

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
          const t = await env.TICKETS.get('t:' + b.ticketId, 'json');
          if (t) { t.wpsCart = cart; await env.TICKETS.put('t:' + t.id, JSON.stringify(t)); }
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
        if (!t.no) {
          const n = parseInt((await env.TICKETS.get('seq')) || '1000', 10) + 1;
          await env.TICKETS.put('seq', String(n));
          t.no = 'INV-' + n;
        }
        t.saved = new Date().toISOString();
        await env.TICKETS.put('t:' + t.id, JSON.stringify(t));

        // Recent list for the shop
        const recent = ((await env.TICKETS.get('recent', 'json')) || []).filter(x => x.id !== t.id);
        recent.unshift(summary(t));
        await env.TICKETS.put('recent', JSON.stringify(recent.slice(0, 300)));

        // Bike history, keyed by the TapLog tag on that bike
        if (t.tag && /^[A-Za-z0-9_-]{4,40}$/.test(t.tag)) {
          const idx = ((await env.TICKETS.get('bike:' + t.tag, 'json')) || []).filter(x => x.id !== t.id);
          idx.unshift(publicSummary(t));
          await env.TICKETS.put('bike:' + t.tag, JSON.stringify(idx.slice(0, 200)));
        }
        return json({ id: t.id, no: t.no }, 200, cors);
      }
      if (req.method === 'GET' && p === '/api/tickets') {
        return json((await env.TICKETS.get('recent', 'json')) || [], 200, cors);
      }
      if (req.method === 'GET' && (m = p.match(/^\/api\/tickets\/([A-Za-z0-9]{6,24})$/))) {
        const t = await env.TICKETS.get('t:' + m[1], 'json');
        return t ? json(t, 200, cors) : json({ error: 'Not found' }, 404, cors);
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Shop-Key',
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
  if (!env.WPS_TOKEN) throw new Error('WPS key not set on the middleman');
  const r = await fetch(WPS + path, {
    headers: { Authorization: 'Bearer ' + env.WPS_TOKEN, Accept: 'application/json' }
  });
  let body = null;
  try { body = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, body };
}

async function wpsSend(env, method, path, body) {
  if (!env.WPS_TOKEN) throw new Error('WPS key not set on the middleman');
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
  const key = 'c:' + path;
  if (ttl) { const hit = await env.TICKETS.get(key, 'json'); if (hit) return hit; }
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
  if (ttl) ctx.waitUntil(env.TICKETS.put(key, JSON.stringify(out), { expirationTtl: ttl }));
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
  const key = 'fit:' + vehicle;
  const hit = await env.TICKETS.get(key, 'json');
  if (hit) return hit;
  const rows = await wpsAll(env, ctx, '/vehicles/' + vehicle + '/items?page[size]=1000', 0);
  const brands = await brandMap(env, ctx);
  const list = rows.map(compact).filter(r => r.st !== 'NLA' && r.st !== 'DSC');
  list.forEach(r => { r.bn = brands[r.b] || ''; });
  ctx.waitUntil(env.TICKETS.put(key, JSON.stringify(list), { expirationTtl: 86400 }));
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
function publicSummary(t) {
  return { id: t.id, no: t.no, saved: t.saved, bike: t.bike || '',
           work: (t.lines || []).map(l => l.d).slice(0, 8), status: t.status || '' };
}

/* WPS brand names by id, kept for a day */
async function brandMap(env, ctx) {
  const hit = await env.TICKETS.get('brands', 'json');
  if (hit) return hit;
  const rows = await wpsAll(env, ctx, '/brands?page[size]=1000', 0);
  const map = {};
  rows.forEach(b => { map[b.id] = b.name; });
  ctx.waitUntil(env.TICKETS.put('brands', JSON.stringify(map), { expirationTtl: 86400 }));
  return map;
}
