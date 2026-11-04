/* iMotorsports out-the-door price demo: shared settings, sample bikes and the price math.
   EVERY rate, fee and value here is a PLACEHOLDER for the demo, not a real tax rate or fee.
   Real numbers come from iMotorsports' finance office and go in on the Settings page. */
(function () {
  const DEFAULTS = {
    v: 1,
    buyers: {
      IL: { name: 'Illinois', tax: 7.00, local: 1.00, title: 150, reg: 100, checked: '' },
      FL: { name: 'Florida', tax: 6.00, local: 1.00, title: 200, reg: 225, checked: '' }
    },
    stores: {
      IL: { name: 'Chicago, IL store', doc: 300, checked: '' },
      FL: { name: 'Florida store', doc: 900, checked: '' }
    },
    makes: {
      'Harley-Davidson': { freight: 650, setup: 450 },
      'Honda': { freight: 450, setup: 250 },
      'Indian': { freight: 650, setup: 450 },
      'Kawasaki': { freight: 495, setup: 300 },
      'KTM': { freight: 595, setup: 350 },
      'Yamaha': { freight: 550, setup: 300 }
    },
    usedPrep: 199,
    rebates: [
      { make: 'Yamaha', model: '', amount: 500, label: 'Yamaha year-end savings', ends: '2026-12-31' },
      { make: 'Kawasaki', model: 'KX450', amount: 750, label: 'Kawasaki race-ready cash', ends: '2026-11-30' }
    ],
    apr: 9.99,
    shopPhone: '',
    placeholder: true
  };

  const BIKES = [
    { stock: 'A11776', year: 2024, make: 'Harley-Davidson', model: 'Pan America 1250 Special', cond: 'used', store: 'IL',
      price: 16995, miles: 4300, vin6: 'B04117', color: 'Vivid Black',
      features: ['Adaptive ride height', 'Cornering lights', 'Tubeless spoked wheels', 'Heated grips'],
      report: { date: '2026-10-28', tech: 'Service dept.',
        items: [
          ['Front tire', 'good', '6/32" tread · made Aug 2023 · came in 31 psi, set to 36'],
          ['Rear tire', 'watch', '4/32" tread · made Aug 2023 · came in 33 psi, set to 42'],
          ['Front brake pads', 'good', '80% left'], ['Rear brake pads', 'good', '70% left'],
          ['Brake fluid', 'good', 'Changed at prep'], ['Final drive / chain', 'good', 'Slack in spec'],
          ['Battery', 'good', '12.7 V'], ['Engine oil & filter', 'good', 'Changed at prep'],
          ['Coolant', 'good', ''], ['Lights, horn & controls', 'good', ''], ['Fork seals & bearings', 'good', 'No leaks, no play']
        ],
        work: ['Oil and filter change', 'Brake fluid flush'] } },
    { stock: 'N24091', year: 2026, make: 'Yamaha', model: 'MT-09', cond: 'new', store: 'IL', price: 10999, color: 'Matte Raven',
      features: ['890cc CP3 triple', 'Quickshifter', '5" TFT display', 'Cruise control'] },
    { stock: 'N24133', year: 2026, make: 'Kawasaki', model: 'KX450', cond: 'new', store: 'FL', price: 10599, color: 'Lime Green',
      features: ['Electric start', 'Launch control', 'Showa suspension', 'Hydraulic clutch'] },
    { stock: 'U31408', year: 2024, make: 'Indian', model: 'Chief Dark Horse', cond: 'used', store: 'FL', price: 14499, miles: 6100,
      vin6: 'R22904', color: 'Black Smoke', features: ['Thunderstroke 116', 'Ride modes', 'Keyless ignition', 'Cruise control'],
      report: { date: '2026-10-21', tech: 'Service dept.',
        items: [
          ['Front tire', 'good', '7/32" tread · made Jan 2024 · came in 30 psi, set to 36'],
          ['Rear tire', 'good', '7/32" tread · made Jan 2024 · came in 32 psi, set to 40'],
          ['Front brake pads', 'good', '85% left'], ['Rear brake pads', 'replace', '15% left · replaced before sale'],
          ['Brake fluid', 'good', ''], ['Final drive belt', 'good', 'No cracks'],
          ['Battery', 'good', '12.8 V'], ['Engine oil & filter', 'good', 'Changed at prep'],
          ['Lights, horn & controls', 'good', ''], ['Fork seals & bearings', 'good', '']
        ],
        work: ['New rear brake pads', 'Oil and filter change'] } },
    { stock: 'U31377', year: 2019, make: 'Yamaha', model: 'MT-07', cond: 'used', store: 'IL', price: 6999, miles: 8200, vin6: 'K10566',
      color: 'Ice Fluo', features: ['689cc CP2 twin', 'ABS', 'Light, nimble commuter'],
      report: { date: '2026-10-30', tech: 'Service dept.',
        items: [
          ['Front tire', 'good', '5/32" tread · made Mar 2022 · came in 26 psi, set to 36'],
          ['Rear tire', 'watch', '3/32" tread · made Mar 2022 · came in 30 psi, set to 42'],
          ['Front brake pads', 'good', '60% left'], ['Rear brake pads', 'good', '55% left'],
          ['Brake fluid', 'watch', 'Dark, due within 6 months'], ['Chain & sprockets', 'good', 'Cleaned and adjusted'],
          ['Battery', 'replace', '11.9 V · replaced before sale'], ['Engine oil & filter', 'good', 'Changed at prep'],
          ['Coolant', 'good', ''], ['Lights, horn & controls', 'good', ''], ['Fork seals & bearings', 'good', '']
        ],
        work: ['New battery', 'Oil and filter change', 'Chain clean and adjust'] } },
    { stock: 'N24150', year: 2026, make: 'Honda', model: 'CRF250F', cond: 'new', store: 'IL', price: 5299, color: 'Red',
      features: ['Fuel injected', 'Electric start', 'Trail-ready suspension'] }
  ];

  const KEY = 'imoto_settings_v1', SKEY = 'imoto_status_v1';
  const mem = {};
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return mem[k] || null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } };
  const clone = o => JSON.parse(JSON.stringify(o));

  function settings() {
    let s = null;
    try { s = JSON.parse(get(KEY) || 'null'); } catch (e) {}
    if (!s || s.v !== DEFAULTS.v) return clone(DEFAULTS);
    return s;
  }
  function saveSettings(s) { set(KEY, JSON.stringify(s)); }
  function resetSettings() { set(KEY, ''); }

  function statusMap() { try { return JSON.parse(get(SKEY) || '{}'); } catch (e) { return {}; } }
  function status(stock) { return statusMap()[stock] || 'available'; }
  function setStatus(stock, st) { const m = statusMap(); if (st === 'available') delete m[stock]; else m[stock] = st; set(SKEY, JSON.stringify(m)); }

  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  function activeRebates(bike, s) {
    if (bike.cond !== 'new') return [];
    return (s.rebates || []).filter(r => r.make === bike.make && (!r.model || bike.model.toLowerCase().includes(r.model.toLowerCase())) &&
      (!r.ends || r.ends >= today()) && Number(r.amount) > 0);
  }

  /* The out-the-door math. buyer = 'IL' or 'FL' (the buyer's state, which sets tax and title). */
  function otd(bike, buyer, s) {
    s = s || settings();
    const b = s.buyers[buyer], st = s.stores[bike.store] || { doc: 0 }, mk = s.makes[bike.make] || { freight: 0, setup: 0 };
    const lines = [];
    const add = (label, amt, note, kind) => lines.push({ label, amt: Math.round(amt * 100) / 100, note, kind: kind || '' });
    add('Vehicle price', bike.price, bike.cond === 'new' ? 'Our sale price for this bike.' : 'Our price for this pre-owned bike.');
    activeRebates(bike, s).forEach(r => add(r.label, -Number(r.amount), 'Manufacturer rebate' + (r.ends ? ', ends ' + fmtDate(r.ends) : '') + '.', 'rebate'));
    if (bike.cond === 'new') {
      add('Freight / destination', Number(mk.freight) || 0, 'What the manufacturer charges to ship this bike to us.');
      add('Setup / PDI', Number(mk.setup) || 0, 'Uncrating, assembly and pre-delivery inspection by our techs.');
    } else {
      add('Inspection & prep', Number(s.usedPrep) || 0, 'Full service inspection, fluids and safety check before sale.');
    }
    add('Doc fee', Number(st.doc) || 0, 'Paperwork and processing at the ' + (st.name || 'selling store') + '.');
    const sub = lines.reduce((a, l) => a + l.amt, 0);
    const rate = (Number(b.tax) || 0) + (Number(b.local) || 0);
    const tax = Math.round(sub * rate) / 100;
    const title = Number(b.title) || 0, reg = Number(b.reg) || 0;
    return {
      lines, sub, rate, tax, title, reg,
      total: Math.round((sub + tax + title + reg) * 100) / 100,
      buyer: b, store: st
    };
  }

  function payment(amount, down, months, apr) {
    const p = Math.max(0, amount - down), r = apr / 100 / 12;
    if (!months) return 0;
    if (!r) return p / months;
    return p * r / (1 - Math.pow(1 + r, -months));
  }

  /* Trade-in: DEMO MATH ONLY, not market values. Real numbers need a licensed valuation source. */
  const TRADE_REF = { 'yamaha|mt-07|2019': [4100, 4600] };
  function tradeIn(year, make, model, miles, cond) {
    const key = (make + '|' + model + '|' + year).toLowerCase().replace(/\s+/g, '');
    let lo, hi;
    const ref = TRADE_REF[key.replace(/\s/g, '')];
    if (ref && cond === 'good' && Math.abs(miles - 8200) < 2000) { [lo, hi] = ref; }
    else {
      const age = Math.max(0, new Date().getFullYear() - year);
      let base = 11000 * Math.pow(0.86, age) - (miles || 0) * 0.06;
      base *= ({ excellent: 1.08, good: 1, fair: 0.85, rough: 0.65 })[cond] || 1;
      base = Math.max(500, base);
      lo = Math.round(base * 0.94 / 50) * 50; hi = Math.round(base * 1.06 / 50) * 50;
    }
    return [lo, hi];
  }

  const money = n => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money0 = n => '$' + Math.round(n).toLocaleString('en-US');
  function fmtDate(d) { if (!d) return ''; const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const art = w => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + esc(w);
  const title = b => b.year + ' ' + b.make + ' ' + b.model;
  const find = stock => BIKES.find(b => b.stock.toLowerCase() === String(stock || '').trim().toLowerCase());

  /* A simple drawn bike for the photo spot (no real photos in the demo) */
  function bikeArt(b) {
    const hue = { 'Harley-Davidson': 20, Honda: 0, Indian: 350, Kawasaki: 95, KTM: 28, Yamaha: 220 }[b.make] || 210;
    return '<svg viewBox="0 0 320 180" role="img" aria-label="Photo placeholder for ' + esc(title(b)) + '" style="width:100%;height:100%;display:block">' +
      '<rect width="320" height="180" fill="hsl(' + hue + ' 25% 92%)"/>' +
      '<g fill="none" stroke="hsl(' + hue + ' 45% 32%)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="82" cy="122" r="32"/><circle cx="238" cy="122" r="32"/>' +
      '<path d="M82 122 L124 82 L190 82 L238 122 M124 82 L150 122 L190 82 M190 82 L206 58 L226 58 M150 74 L178 74"/></g>' +
      '<text x="160" y="170" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="hsl(' + hue + ' 30% 35%)">Photo placeholder</text></svg>';
  }

  window.IMOTO = { DEFAULTS, BIKES, settings, saveSettings, resetSettings, status, setStatus, otd, activeRebates, payment, tradeIn,
    money, money0, fmtDate, esc, art, title, find, bikeArt, today };
})();
