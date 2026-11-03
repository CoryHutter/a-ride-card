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
          const hay = (r.s + ' ' + r.n).toLowerCase();
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
        if (!rows.length) {
          // Name contains; fall back to part-number prefix if the API rejects the operator
          let r = await wpsGet(env, '/items?filter[name][con]=' + encodeURIComponent(q) + '&page[size]=40');
          if (!r.ok) r = await wpsGet(env, '/items?filter[sku][pre]=' + encodeURIComponent(q) + '&page[size]=40');
          if (r.ok) rows = r.body.data || [];
        }
        const top = rows.map(compact).slice(0, 40);
        await addStock(env, top);
        return json({ parts: top.map(shape) }, 200, cors);
      }

      // The shop's real cost for one part (their own discounts included)
      if (req.method === 'GET' && (m = p.match(/^\/api\/cost\/(\d+)$/))) {
        const r = await wpsGet(env, '/dealer-pricing/' + m[1]);
        if (!r.ok) return json({ cost: null }, 200, cors);
        return json({ cost: findCost(r.body) }, 200, cors);
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
  i: r.id, s: r.sku, n: r.name,
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
  const list = rows.map(compact).filter(r => r.st !== 'NLA' && r.st !== 'DSC');
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

const shape = r => ({ id: r.i, sku: r.s, name: r.n, retail: r.l, dealer: r.d, status: r.st, stock: r.stk || null });

function findCost(body) {
  const d = body && (body.data || body);
  const row = Array.isArray(d) ? d[0] : d;
  if (!row) return null;
  for (const k of ['dealer_price', 'price', 'cost', 'dealer_cost', 'your_price', 'net_price']) {
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
