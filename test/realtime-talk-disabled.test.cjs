// test/realtime-talk-disabled.test.cjs - il bottone Talk e' grigio da 68 giorni e nessuno poteva guardarlo.
//
// 107. Il condizionamento e' UNA RIGA in `RealtimeMichaelToggle.tsx`:
//
//     const noKey = localVoice ? false : !hasOpenAiKey;
//     <PixelButton disabled={noKey} ...>
//
// e fino a stanotte non c'era UN SOLO test che lo toccasse. *Un difetto di 68 giorni
// che nessuno ha visto non e' un difetto che nessuno guardava: e' un difetto che
// nessuno poteva guardare.*
//
// NON ESISTE UN HARNESS REACT IN QUESTO REPO — non c'e' un solo `*.test.ts` / `*.test.tsx`,
// i test sono `.cjs` con `node --test test/*.test.cjs`. Quindi qui NON si renderizza il
// componente: **si legge il sorgente e se ne ricava la condizione**, e la si valuta.
//
// PERCHE' DERIVARE DALLESPRESSIONE E NON RISCRIVERLA QUI: un test che copia la
// condizione nella sua propria costante verifica se se stesso, e resta verde per sempre.
// *Una prova che puo' passare senza toccare la cosa che dichiara di provare non copre
// niente.* Qui l'espressione viene LETTA dal file, quindi riportare `disabled={...}` a
// una costante sbagliata — o togliere la guardia `if (noKey) return` — mette questo
// file rosso.
//
//   node --test test/realtime-talk-disabled.test.cjs
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LEGGI = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TOGGLE = 'src/renderer/src/components/RealtimeMichaelToggle.tsx';
const SESSION = 'src/renderer/src/realtime/session.ts';
const ANNOUNCER = 'src/renderer/src/realtime/announcer.ts';
const CONFIG = 'src/main/config.ts';
const REALTIME = 'src/shared/realtimeVoice.ts';

/** La riga `const noKey = ...`, presa dal sorgente e non riscritta. */
function espressioneNoKey() {
  const src = LEGGI(TOGGLE);
  const m = src.match(/const\s+noKey\s*=\s*([^;]+);/);
  assert.ok(m, 'non trovo `const noKey = ...` in ' + TOGGLE + ': se il nome e\' cambiato questo test va aggiornato, e\' una cosa che si dichiara');
  return m[1].trim();
}

/**
 * Valuta l'espressione del sorgente sulla matrice, risolvendo i due simboli che
 * compaiono. E' una valutazione, non una ricostruzione: se l'espressione cambia, la
 * matrice cambia con lei, e questo e' il punto.
 */
function disabilitato(espr, { voiceBackend, hasOpenAiKey }) {
  const localVoice = voiceBackend === 'local-tts';
  // eslint-disable-next-line no-new-func
  const f = new Function('localVoice', 'hasOpenAiKey', 'return (' + espr + ');');
  return !!f(localVoice, hasOpenAiKey);
}

// ── 1. LA TABELLA, DERIVATA DALL'ESPRESSIONE VERA ──────────────────────────

test('107: the disabled truth table, read from the component, not from this file', () => {
  const e = espressioneNoKey();

  assert.equal(disabilitato(e, { voiceBackend: 'openai', hasOpenAiKey: false }), true,
    'openai SENZA chiave: grigio. E\' il caso di default di un\'installazione nuova.');
  assert.equal(disabilitato(e, { voiceBackend: 'openai', hasOpenAiKey: true }), false,
    'openai CON chiave: acceso.');
  assert.equal(disabilitato(e, { voiceBackend: 'local-tts', hasOpenAiKey: false }), false,
    'local-tts: acceso anche SENZA chiave, perche\' la chiave non serve. *E\' per questo che la risposta «imposta local-tts» sembrava la soluzione — ed e\' il motivo per cui va verificata che il server ci sia.*');
});

test('107: the button really is wired to that expression', () => {
  const src = LEGGI(TOGGLE);
  assert.match(src, /disabled=\{noKey\}/,
    'il bottone deve prendere `noKey`. Se non lo prende piu\', l\'espressione resta giusta e il bottone fa un\'altra cosa: *una prova che passa mentre il difetto e\' stato spostato e\' una prova che ha smesso di guardare.*');
  // La seconda guardia, in `PixelButton`: senza, un `onClick` ancora agganciato
  // chiamerebbe `connect()` da un bottone disabilitato.
  const btn = LEGGI('src/renderer/src/components/PixelButton.tsx');
  assert.match(btn, /onClick=\{disabled \? undefined : onClick\}/,
    'PixelButton deve staccare `onClick` quando e\' disabilitato: e\' la guardia che rende il grigio piu\' forte di un colore');
});

// ── 2. LA CLICCATURA: NESSUN AUDIO SE E' GRIGIO ─────────────────────────────

test('107: a disabled Talk starts no audio — the click returns before connect()', () => {
  const src = LEGGI(TOGGLE);
  assert.match(src, /if \(noKey\) return;/,
    'IL CLICK DEVE USCIRE PRIMA. `connect()` e\' la porta da cui passano il mic, il WebRTC e l\'annunciatore: senza questo `return`, un bottone grigio che si clicca lo si sente lo stesso. *Questa e\' la prova che puo\' fallire toccando `noKey`, che era esattamente quello che mancava.*');
});

test('107: the announcer — the only source of spoken task updates — is armed ONLY by that button', () => {
  const ann = LEGGI(ANNOUNCER);
  const ses = LEGGI(SESSION);

  // 1) il file lo dichiara
  assert.match(ann, /ONLY by the Talk button/i,
    'announcer.ts deve dire da cosa e\' armato: e\' l\'informazione che rende leggibile il silenzio');
  // 2) e il codice lo conferma: l'unica sottoscrizione nasce dentro `connect()`
  const abbonamenti = (ses.match(/startTaskAnnouncer\(\)/g) || []).length;
  assert.equal(abbonamenti, 1,
    '`startTaskAnnouncer()` deve essere chiamata UNA volta sola dentro `connect()`. Se compare altrove — un avvio automatico, un init — allora l\'annunciatore suona con il bottone grigio, e la promessa «a bottone disabilitato non parte nessun audio» e\' falsa.');
  assert.match(ses, /getUserMedia/,
    'e il mic si chiede in `session.ts`, quindi anche il microfono e\' dietro lo stesso pulsante');
});

// ── 3. IL VAGGIO CHE IL TEST PUO' FALLIRE ─────────────────────────────────

test('107: the BITE — the truth table changes if the source expression changes', () => {
  const e = espressioneNoKey();
  assert.notEqual(e, 'true',
    'questa e\' la prova che il test non sta guardando una copia sua: l\'espressione arriva dal sorgente, quindi sostituirla con `true` in `RealtimeMichaelToggle.tsx` — e il bottone diventa SEMPRE grigio — deve cambiare la tabella qui.');
  // La dimostrazione che la valutazione dipende dall'espressione, non da una tabella
  // scritta qui: la stessa espressione, valutata su un altro backend.
  assert.equal(disabilitato('!hasOpenAiKey', { voiceBackend: 'openai', hasOpenAiKey: false }), true);
  assert.equal(disabilitato('!hasOpenAiKey', { voiceBackend: 'openai', hasOpenAiKey: true }), false);
  assert.equal(disabilitato('!hasOpenAiKey', { voiceBackend: 'local-tts', hasOpenAiKey: false }), true,
    'ATTENZIONE: questa riga e\' quella che distingue `localVoice ? false : !hasOpenAiKey` da `!hasOpenAiKey`. Il primo apre il bottone senza chiave, il secondo no. Se qualcuno semplifica l\'espressione e perde il ramo `localVoice`, **la perdita e\' silenziosa**: il bottone resta grigio, nessun errore, e l\'unica differenza e\' che la strada di uscita sparisce.');
});

// ── 4. LA PORTA D'USCITA DEVE ESISTERE, E IL TEST LO DICE ──────────────────

test('107: the local TTS exit is declared with an address a person can open', () => {
  const rt = LEGGI(REALTIME);
  const m = rt.match(/DEFAULT_TTS_BASE_URL\s*=\s*'([^']+)'/);
  assert.ok(m, 'realtimeVoice.ts deve dichiarare `DEFAULT_TTS_BASE_URL`');
  const url = new URL(m[1]);
  assert.ok(url.port, 'il default deve avere una porta esplicita: `localhost:8000/v1` dice DOVE, `localhost` dice solo «da qualche parte»');

  // E il testo della UI deve offrire TUTTE E DUE le uscite, perche' una sola e' un
  // vicolo cieco. Verificato sulle quattro locali, perche' l'umano legge l'italiano e
  // *un testo che corregge solo `en` lascia il vicolo cieco nella lingua che lui usa*.
  for (const l of ['en', 'it', 'ar', 'zh-CN']) {
    const j = JSON.parse(LEGGI(`src/renderer/src/i18n/locales/${l}.json`));
    const t = j.realtimeToggle;
    assert.ok(t && t.popoverBody, `${l}: manca realtimeToggle.popoverBody`);
    const b = t.popoverBody.toLowerCase();
    const nominaChiave = /openai/.test(b);
    const nominaLocale = /(tts locale|local tts|خادم tts محلي|本地 tts)/.test(b);
    assert.ok(nominaChiave && nominaLocale,
      `${l}.realtimeToggle.popoverBody deve nominare LE DUE uscite (chiave OpenAI e TTS locale), e lo fa solo se le nomina entrambe: «${t.popoverBody.slice(0, 90)}…». *Un avviso che offre una sola via d'uscita e' un vicolo cieco: l'umano deve poter uscire dal problema senza chiedere.*`);
    assert.ok(/come|how|come attivo|怎么|كيف/.test(t.whyDisabled.toLowerCase()),
      `${l}.whyDisabled deve dire COME si accende, non solo PERCHE' e' spento: «${t.whyDisabled}» e' una domanda che la UI non sa rispondere. *La mia prima versione di questa asserzione cercava solo \`come|how\` e ha messo rosso il cinese, che lo dice con 怎么: un test che sbaglia la lingua non sta guardando il testo, sta guardando la propria tastiera.*`);
  }
});

test('107: the default backend says what it COSTS, not just which backend it is', () => {
  const cfg = LEGGI(CONFIG);
  const m = cfg.match(/realtimeVoiceBackend:\s*'([^']+)'/);
  assert.ok(m, 'config.ts deve dichiarare `realtimeVoiceBackend`');
  // La finestra e' di 1 400 caratteri perche' piu' piccola: con 600 il commento che
  // spiega il costo c'era ma NON entrava, e il test e' andato rosso dicendo che
  // l'informazione mancava mentre era li' a due righe. *Una finestra troppo stretta
  // e' un test che misura la mia costruzione del commento invece del suo testo.*
  const vicino = cfg.slice(Math.max(0, m.index - 1400), m.index + 60);
  assert.match(vicino, /openai|local-tts/,
    'il default deve avere un commento che dice PERCHE\' e\' quello');

  // NON asserisco che il default sia `local-tts`: e' una decisione di prodotto, non
  // un fatto, e misurato adesso (2026-09-30) il server TTS locale su localhost:8000
  // NON risponde — quindi `local-tts` come default accenderebbe il bottone senza
  // produrre suono, che e' peggio di un bottone grigio che si spiega.
  //
  // Quello che asserisco e' che il **default dichiari il suo costo**: un default che
  // spegne una funzione su un'installazione nuova, e non lo dice, e' la causa dei
  // 68 giorni. *Non metto nel test una rossa che non intendo togliere: un rosso che
  // nessuno guarda smette di essere un controllo e diventa un abbaglio.*
  assert.match(vicino, /hasOpenAiKey|chiave|key/i,
    'il commento del default deve dire che cosa succede a chi non ha una chiave: e\' esattamente l\'informazione che mancava per 68 giorni');
});
