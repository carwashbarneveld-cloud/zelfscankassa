// Zelfscankassa Carwash Barneveld: tussenstuk tussen iPad, dashboard en SumUp Solo.
// Draait op Cloudflare Workers. De geheime SumUp sleutel staat alleen hier.

import { DurableObject } from 'cloudflare:workers';

const SUMUP = 'https://api.sumup.com/v0.1';

// Startwaarden. Zodra je in het dashboard op Opslaan klikt, gelden die van het dashboard.
const STANDAARD = {
  koffie: 'Even wachten? De koffie staat klaar en is altijd gratis.',
  programmas: {
    basis:     { naam: 'Basis',     prijs: 700,  kort: '2x wassen en drogen', actief: true,
      inhoud: ['2x wassen', 'Drogen'] },
    normaal:   { naam: 'Normaal',   prijs: 895,  kort: 'Met HD reiniger en velgen', actief: true,
      inhoud: ['HD reiniger', 'Velgenreiniging', '2x wassen', 'GlansWas of onderkant', 'Drogen'] },
    intensief: { naam: 'Intensief', prijs: 1100, kort: 'Met insecten, actief schuim en GlansWas', actief: true,
      inhoud: ['HD reiniger', 'Velgenreiniging', 'Insectverwijderaar', 'Actief schuim', '2x wassen', 'GlansWas', 'Onderkant wassen', 'Drogen'] },
    premium:   { naam: 'Premium',   prijs: 1395, kort: 'Alles erop en eraan, met Wax Polish', actief: true,
      inhoud: ['HD reiniger', 'Velgenreiniging', 'Insectverwijderaar', 'Actief schuim', '2x wassen', 'Onderkant wassen', 'Wax Polish', 'Drogen'],
      cadeau: 'Gratis Carwash Barneveld geurhanger' },
  },
  producten: [],
};
const PROGRAMMA_IDS = Object.keys(STANDAARD.programmas);

// ---------- Opslag ----------
export class Statusopslag extends DurableObject {
  async zet(id, data) {
    const k = 'tx:' + id;
    const oud = (await this.ctx.storage.get(k)) || {};
    await this.ctx.storage.put(k, { ...oud, ...data, bijgewerkt: Date.now() });
  }
  async haal(id) { return (await this.ctx.storage.get('tx:' + id)) || null; }
  async catalogus() { return (await this.ctx.storage.get('catalogus')) || STANDAARD; }
  async bewaarCatalogus(c) { await this.ctx.storage.put('catalogus', c); }
  async verkopen() {
    const lijst = await this.ctx.storage.list({ prefix: 'tx:', reverse: true, limit: 300 });
    return [...lijst.values()].filter(v => v.gestart).sort((a, b) => b.gestart - a.gestart).slice(0, 100);
  }
  async opruimen() {
    const grens = Date.now() - 90 * 24 * 3600 * 1000;
    const alles = await this.ctx.storage.list({ prefix: 'tx:' });
    for (const [k, v] of alles) if (v && v.bijgewerkt < grens) await this.ctx.storage.delete(k);
  }
}

// ---------- Hulpjes ----------
function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.TOEGESTANE_SITE || '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Kassa-Sleutel, X-Beheer-Sleutel',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}
function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors(env) } });
}
async function sumup(env, pad, body) {
  const r = await fetch(SUMUP + pad, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.SUMUP_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const tekst = await r.text();
  let data = {};
  try { data = tekst ? JSON.parse(tekst) : {}; } catch (e) { data = { ruw: tekst }; }
  return { ok: r.ok, status: r.status, data };
}
const opslag = env => env.STATUS.get(env.STATUS.idFromName('kassa'));
const tekst = (v, max) => String(v == null ? '' : v).slice(0, max).trim();
const centen = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= 100000 ? n : null; };

// Controleer en schoon wat het dashboard opstuurt
function schoonCatalogus(c) {
  if (!c || typeof c !== 'object') throw new Error('Onbekend formaat');
  const uit = { koffie: tekst(c.koffie, 200), programmas: {}, producten: [] };
  for (const id of PROGRAMMA_IDS) {
    const p = (c.programmas || {})[id] || STANDAARD.programmas[id];
    const prijs = centen(p.prijs);
    if (prijs === null) throw new Error('Prijs van ' + id + ' klopt niet');
    uit.programmas[id] = {
      naam: tekst(p.naam, 40) || STANDAARD.programmas[id].naam, prijs,
      kort: tekst(p.kort, 120), actief: p.actief !== false,
      inhoud: (Array.isArray(p.inhoud) ? p.inhoud : []).map(x => tekst(x, 40)).filter(Boolean).slice(0, 15),
      cadeau: tekst(p.cadeau, 80),
    };
  }
  const producten = Array.isArray(c.producten) ? c.producten.slice(0, 24) : [];
  for (const p of producten) {
    const prijs = centen(p.prijs);
    if (prijs === null || prijs === 0) throw new Error('Prijs van product "' + tekst(p.naam, 40) + '" klopt niet');
    const foto = typeof p.foto === 'string' && p.foto.startsWith('data:image/') && p.foto.length < 400000 ? p.foto : '';
    uit.producten.push({
      id: tekst(p.id, 40) || ('p' + Date.now() + Math.random().toString(36).slice(2, 6)),
      naam: tekst(p.naam, 50) || 'Product', prijs, omschrijving: tekst(p.omschrijving, 140),
      foto, actief: p.actief !== false,
    });
  }
  return uit;
}

// ---------- Routes ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
    const isBeheer = request.headers.get('X-Beheer-Sleutel') === env.BEHEER_SLEUTEL && !!env.BEHEER_SLEUTEL;
    const isKassa = request.headers.get('X-Kassa-Sleutel') === env.KASSA_SLEUTEL && !!env.KASSA_SLEUTEL;

    // 1. Uitslag van SumUp (webhook)
    if (url.pathname === '/api/sumup-uitslag' && request.method === 'POST') {
      if (url.searchParams.get('t') !== env.WEBHOOK_GEHEIM) return json(env, { fout: 'geen toegang' }, 403);
      const bericht = await request.json().catch(() => null);
      const p = bericht && bericht.payload;
      if (p && p.client_transaction_id && p.status) {
        await opslag(env).zet(p.client_transaction_id, { status: p.status, reden: p.failure_reason || null });
      }
      return json(env, { ok: true });
    }

    // 2. Beheer (dashboard)
    if (url.pathname.startsWith('/api/beheer/') || url.pathname === '/api/koppel') {
      if (!isBeheer) return json(env, { fout: 'geen toegang' }, 403);

      if (url.pathname === '/api/beheer/check') return json(env, { ok: true });

      if (url.pathname === '/api/beheer/catalogus' && request.method === 'GET') {
        return json(env, await opslag(env).catalogus());
      }
      if (url.pathname === '/api/beheer/catalogus' && request.method === 'POST') {
        try {
          const c = schoonCatalogus(await request.json());
          await opslag(env).bewaarCatalogus(c);
          return json(env, { ok: true, catalogus: c });
        } catch (e) { return json(env, { fout: e.message }, 400); }
      }
      if (url.pathname === '/api/beheer/verkopen') {
        return json(env, { verkopen: await opslag(env).verkopen() });
      }
      if (url.pathname === '/api/koppel' && request.method === 'POST') {
        const { code, naam } = await request.json().catch(() => ({}));
        if (!code) return json(env, { fout: 'koppelcode ontbreekt' }, 400);
        const r = await sumup(env, `/merchants/${env.SUMUP_MERCHANT_CODE}/readers`, { pairing_code: code, name: naam || 'Zelfscankassa' });
        return json(env, r.data, r.ok ? 200 : r.status);
      }
      return json(env, { fout: 'niet gevonden' }, 404);
    }

    // Alles hieronder alleen voor de iPad
    if (!isKassa) return json(env, { fout: 'geen toegang' }, 403);

    // 3. Programma's en producten ophalen
    if (url.pathname === '/api/catalogus' && request.method === 'GET') {
      return json(env, await opslag(env).catalogus());
    }

    // 4. Afrekenen
    if (url.pathname === '/api/afrekenen' && request.method === 'POST') {
      const { programma, producten } = await request.json().catch(() => ({}));
      const cat = await opslag(env).catalogus();
      const p = cat.programmas[programma];
      if (!p || p.actief === false) return json(env, { fout: 'onbekend programma' }, 400);
      const extra = (Array.isArray(producten) ? producten : [])
        .map(id => cat.producten.find(x => x.id === id && x.actief !== false)).filter(Boolean);
      const totaal = p.prijs + extra.reduce((s, x) => s + x.prijs, 0);
      const omschrijving = ['Wasprogramma ' + p.naam, ...extra.map(x => x.naam)].join(' + ').slice(0, 200);

      const r = await sumup(env, `/merchants/${env.SUMUP_MERCHANT_CODE}/readers/${env.SUMUP_READER_ID}/checkout`, {
        total_amount: { currency: 'EUR', minor_unit: 2, value: totaal },
        description: omschrijving,
        return_url: `${url.origin}/api/sumup-uitslag?t=${env.WEBHOOK_GEHEIM}`,
        affiliate: { app_id: env.SUMUP_APP_ID, key: env.SUMUP_AFFILIATE_KEY, foreign_transaction_id: 'kassa-' + Date.now() },
      });
      if (!r.ok) {
        console.log('SumUp fout', r.status, JSON.stringify(r.data));
        return json(env, { fout: 'pinapparaat niet bereikbaar' }, 502);
      }
      const id = (r.data.data && r.data.data.client_transaction_id) || r.data.client_transaction_id;
      if (!id) { console.log('Onverwacht antwoord', JSON.stringify(r.data)); return json(env, { fout: 'onverwacht antwoord van SumUp' }, 502); }

      await opslag(env).zet(id, {
        status: 'pending', programma: p.naam, producten: extra.map(x => ({ naam: x.naam, prijs: x.prijs })),
        bedrag: totaal, gestart: Date.now(),
      });
      ctx.waitUntil(opslag(env).opruimen());
      return json(env, { id, totaal });
    }

    // 5. Status
    if (url.pathname === '/api/status' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      const s = id ? await opslag(env).haal(id) : null;
      return json(env, { status: s ? s.status : 'onbekend' });
    }

    // 6. Annuleren
    if (url.pathname === '/api/annuleren' && request.method === 'POST') {
      const r = await sumup(env, `/merchants/${env.SUMUP_MERCHANT_CODE}/readers/${env.SUMUP_READER_ID}/terminate`);
      return json(env, { ok: r.ok });
    }

    return json(env, { fout: 'niet gevonden' }, 404);
  },
};
