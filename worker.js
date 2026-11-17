// Zelfscankassa Carwash Barneveld: tussenstuk tussen iPad en SumUp Solo.
// Draait gratis op Cloudflare Workers. De geheime SumUp sleutel staat alleen hier,
// nooit op de iPad.

import { DurableObject } from 'cloudflare:workers';

// Prijzen in centen. De server rekent ALTIJD met deze prijzen, niet met wat de iPad stuurt.
const PROGRAMMAS = {
  basis:     { naam: 'Basis',     prijs: 700 },
  normaal:   { naam: 'Normaal',   prijs: 895 },
  intensief: { naam: 'Intensief', prijs: 1100 },
  premium:   { naam: 'Premium',   prijs: 1395 },
};

const SUMUP = 'https://api.sumup.com/v0.1';

// ---------- Opslag van betaalstatus ----------
export class Statusopslag extends DurableObject {
  async zet(id, data) {
    const oud = (await this.ctx.storage.get(id)) || {};
    await this.ctx.storage.put(id, { ...oud, ...data, bijgewerkt: Date.now() });
    await this.ctx.storage.put('laatste', id);
  }
  async haal(id) { return (await this.ctx.storage.get(id)) || null; }
  async laatste() { return (await this.ctx.storage.get('laatste')) || null; }
  async opruimen() {
    const grens = Date.now() - 7 * 24 * 3600 * 1000;
    const alles = await this.ctx.storage.list();
    for (const [k, v] of alles) {
      if (k !== 'laatste' && v && v.bijgewerkt < grens) await this.ctx.storage.delete(k);
    }
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
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...cors(env) },
  });
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
function opslag(env) {
  return env.STATUS.get(env.STATUS.idFromName('kassa'));
}

// ---------- Routes ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    // 1. Uitslag van SumUp (webhook). Beveiligd met een geheim stukje in de link.
    if (url.pathname === '/api/sumup-uitslag' && request.method === 'POST') {
      if (url.searchParams.get('t') !== env.WEBHOOK_GEHEIM) return json(env, { fout: 'geen toegang' }, 403);
      const bericht = await request.json().catch(() => null);
      const p = bericht && bericht.payload;
      if (p && p.client_transaction_id && p.status) {
        await opslag(env).zet(p.client_transaction_id, {
          status: p.status,                       // 'successful' of 'failed'
          reden: p.failure_reason || null,
        });
      }
      return json(env, { ok: true });
    }

    // 2. Eenmalig: pinapparaat koppelen (alleen met beheersleutel).
    if (url.pathname === '/api/koppel' && request.method === 'POST') {
      if (request.headers.get('X-Beheer-Sleutel') !== env.BEHEER_SLEUTEL) return json(env, { fout: 'geen toegang' }, 403);
      const { code, naam } = await request.json().catch(() => ({}));
      if (!code) return json(env, { fout: 'koppelcode ontbreekt' }, 400);
      const r = await sumup(env, `/merchants/${env.SUMUP_MERCHANT_CODE}/readers`, {
        pairing_code: code, name: naam || 'Zelfscankassa',
      });
      return json(env, r.data, r.ok ? 200 : r.status);
    }

    // Alles hieronder alleen voor de iPad met de juiste kassasleutel.
    if (request.headers.get('X-Kassa-Sleutel') !== env.KASSA_SLEUTEL) {
      return json(env, { fout: 'geen toegang' }, 403);
    }

    // 3. Afrekenen: bedrag naar het pinapparaat sturen.
    if (url.pathname === '/api/afrekenen' && request.method === 'POST') {
      const { programma } = await request.json().catch(() => ({}));
      const p = PROGRAMMAS[programma];
      if (!p) return json(env, { fout: 'onbekend programma' }, 400);

      const r = await sumup(env, `/merchants/${env.SUMUP_MERCHANT_CODE}/readers/${env.SUMUP_READER_ID}/checkout`, {
        total_amount: { currency: 'EUR', minor_unit: 2, value: p.prijs },
        description: 'Wasprogramma ' + p.naam,
        return_url: `${url.origin}/api/sumup-uitslag?t=${env.WEBHOOK_GEHEIM}`,
        affiliate: {
          app_id: env.SUMUP_APP_ID,
          key: env.SUMUP_AFFILIATE_KEY,
          foreign_transaction_id: 'kassa-' + Date.now(),
        },
      });
      if (!r.ok) {
        console.log('SumUp fout', r.status, JSON.stringify(r.data));
        return json(env, { fout: 'pinapparaat niet bereikbaar' }, 502);
      }
      const id = (r.data.data && r.data.data.client_transaction_id) || r.data.client_transaction_id;
      if (!id) return json(env, { fout: 'onverwacht antwoord van SumUp' }, 502);

      await opslag(env).zet(id, { status: 'pending', programma, bedrag: p.prijs, gestart: Date.now() });
      ctx.waitUntil(opslag(env).opruimen());
      return json(env, { id });
    }

    // 4. Status opvragen (de iPad vraagt dit elke anderhalve seconde).
    if (url.pathname === '/api/status' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      const s = id ? await opslag(env).haal(id) : null;
      return json(env, { status: s ? s.status : 'onbekend' });
    }

    // 5. Annuleren op het pinapparaat.
    if (url.pathname === '/api/annuleren' && request.method === 'POST') {
      const r = await sumup(env, `/merchants/${env.SUMUP_MERCHANT_CODE}/readers/${env.SUMUP_READER_ID}/terminate`);
      return json(env, { ok: r.ok });
    }

    return json(env, { fout: 'niet gevonden' }, 404);
  },
};
