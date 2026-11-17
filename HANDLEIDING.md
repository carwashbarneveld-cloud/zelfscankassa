# Zelfscankassa Carwash Barneveld

iPad + SumUp Solo. De klant kiest een wasprogramma op de iPad, het bedrag verschijnt vanzelf op de Solo, de klant pint, en de iPad laat zien dat het gelukt is.

## Hoe het werkt

1. **iPad** toont de kassapagina (`index.html`), online via GitHub Pages.
2. **Tussenstuk** (`server/worker.js`) draait gratis bij Cloudflare. Hier staat de geheime SumUp sleutel. Die mag nooit op de iPad staan, anders kan iedereen hem uitlezen.
3. **SumUp** stuurt het bedrag naar de Solo en meldt daarna aan het tussenstuk of de betaling gelukt is.

Zonder koppeling draait de kassa als **proefstand**: je ziet een gele balk en na 6 seconden komt er vanzelf "betaald". Zo kun je het scherm alvast testen.

---

## Stap 1. Sleutels ophalen bij SumUp

Log in op **me.sumup.com** en ga naar het onderdeel voor ontwikkelaars.

1. Maak een **API sleutel** aan. Bewaar die goed, je ziet hem maar één keer.
2. Maak een **Affiliate Key** aan. Daarbij hoort een **App ID** (een naam die je zelf kiest, bijvoorbeeld `nl.carwashbarneveld.kassa`).
3. Noteer je **merchant code** (staat bij je profiel, begint vaak met een M).

Krijg je de API sleutel niet te zien? Mail dan SumUp en vraag om toegang tot de "Cloud API" voor de Solo.

## Stap 2. Tussenstuk online zetten (Cloudflare)

1. Maak een gratis account op **cloudflare.com**.
2. Installeer Node.js op je computer (nodejs.org).
3. Open een terminal in de map `server` en voer uit:

```
npx wrangler login
npx wrangler deploy
```

4. Je krijgt een adres, bijvoorbeeld `https://zelfscankassa.jouwnaam.workers.dev`. Noteer dat.
5. Zet de geheimen er één voor één in (je krijgt steeds de vraag om de waarde te plakken):

```
npx wrangler secret put SUMUP_API_KEY
npx wrangler secret put SUMUP_MERCHANT_CODE
npx wrangler secret put SUMUP_AFFILIATE_KEY
npx wrangler secret put SUMUP_APP_ID
npx wrangler secret put KASSA_SLEUTEL
npx wrangler secret put BEHEER_SLEUTEL
npx wrangler secret put WEBHOOK_GEHEIM
```

Voor `KASSA_SLEUTEL`, `BEHEER_SLEUTEL` en `WEBHOOK_GEHEIM` verzin je zelf drie lange willekeurige wachtwoorden (minstens 30 tekens, alleen letters en cijfers).

## Stap 3. De Solo koppelen

1. Zorg dat de Solo op wifi zit en aan de stroom hangt.
2. **Log uit** op de Solo.
3. Ga op de Solo naar **Verbindingen → API → Verbinden**. Je ziet een koppelcode (5 minuten geldig).
4. Stuur die code naar het tussenstuk (vervang de drie dingen tussen < >):

```
curl -X POST https://<jouw-worker-adres>/api/koppel \
  -H "X-Beheer-Sleutel: <BEHEER_SLEUTEL>" \
  -H "Content-Type: application/json" \
  -d '{"code":"<KOPPELCODE>","naam":"Zelfscankassa"}'
```

5. Je krijgt een antwoord met een `id` (begint met `rdr_`). Zet die erin:

```
npx wrangler secret put SUMUP_READER_ID
```

6. Zet op de Solo de **menuvergrendeling** aan (code van 4 cijfers), zodat klanten niet in de instellingen kunnen.

## Stap 4. Kassapagina online zetten

1. Zet `index.html` in een GitHub repository (bijvoorbeeld `zelfscankassa`) en zet GitHub Pages aan, net als bij Pakketpunt Barneveld.
2. Zet in `wrangler.toml` bij `TOEGESTANE_SITE` het adres van je GitHub site, bijvoorbeeld `https://jouwnaam.github.io`, en doe nog een keer `npx wrangler deploy`.

## Stap 5. iPad instellen

1. Open in Safari één keer deze link (alles op één regel):

```
https://jouwnaam.github.io/zelfscankassa/?api=https://<jouw-worker-adres>&sleutel=<KASSA_SLEUTEL>
```

De iPad onthoudt dit. De gele proefbalk is nu weg.

2. Tik op **Deel → Zet op beginscherm**. Open de kassa voortaan via dat icoon (volledig scherm).
3. Zet **Begeleide toegang** aan: Instellingen → Toegankelijkheid → Begeleide toegang. Open de kassa en druk drie keer op de zijknop. Nu kan de klant de kassa niet verlaten.
4. Instellingen → Beeldscherm en helderheid → **Automatische vergrendeling: Nooit**.
5. Laat de iPad aan de lader hangen.

## Stap 6. Testen

Doe een echte betaling van het goedkoopste programma met je eigen pas, kijk of "Betaald" verschijnt, en zet het bedrag daarna terug via het SumUp dashboard.

---

## Prijzen aanpassen

Prijzen staan op **twee** plekken en moeten gelijk zijn:

1. `index.html`, bovenin bij `PROGRAMMAS` (wat de klant ziet).
2. `server/worker.js`, bovenin bij `PROGRAMMAS` (wat echt wordt afgerekend).

Bedragen staan in centen: 895 is € 8,95. Na het aanpassen van de server: `npx wrangler deploy`.

## Wat de klant ziet na betalen

Staat in `index.html` bij `STAPPEN_NA_BETALEN`. Pas dit aan zodra duidelijk is hoe de wasbeurt na betaling gestart wordt.

## Als er iets misgaat

| Probleem | Oplossing |
|---|---|
| "Het pinapparaat is nu niet bereikbaar" | Solo staat uit, zit niet op wifi, of is nog bezig met de vorige klant. Wacht 1 minuut. |
| Blijft hangen op "Betaal op het pinapparaat" | Na 2,5 minuut breekt de kassa zelf af. Kijk of de Solo online is. |
| Gele proefbalk komt terug | De iPad is de instellingen vergeten. Open de link uit stap 5 opnieuw. |
| Foutmeldingen bekijken | `npx wrangler tail` in de map `server` toont live wat er gebeurt. |
