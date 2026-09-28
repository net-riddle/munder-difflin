'use strict';

// Two guards for the language work.
//
// (1) PARITY. Every registered language must have the same key tree as English.
//     A missing key does not fail the build or the app: i18next falls back to
//     English, so the symptom is one label silently in the wrong language and
//     nobody notices until a user reports it. A test is the only thing that
//     catches it at the moment the key is added.
//
// (2) THE SPOKEN SENTENCE FOLLOWS THE APP LANGUAGE. The announcer used to get a
//     ready-made English sentence from main. Main cannot localize it — the
//     chosen language lives in the renderer's localStorage — so the voice spoke
//     English to a user whose entire UI was in Italian.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const LOCALES = path.join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', 'locales');
const read = (f) => JSON.parse(fs.readFileSync(path.join(LOCALES, f), 'utf8'));

/** Every leaf key, dotted. Arrays count as leaves — a translated list has the
 *  same length, and a short one is a broken translation, not a style choice. */
const leaves = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) => {
    const key = p + k;
    return v && typeof v === 'object' && !Array.isArray(v) ? leaves(v, key + '.') : [key];
  });

// ── (1) parity ──────────────────────────────────────────────────────────────

test('(1) every language has exactly the English key set', () => {
  const en = new Set(leaves(read('en.json')));
  for (const file of ['it.json', 'ar.json', 'zh-CN.json']) {
    const other = new Set(leaves(read(file)));
    const missing = [...en].filter((k) => !other.has(k));
    const extra = [...other].filter((k) => !en.has(k));
    assert.deepEqual(missing, [], `${file} is missing keys`);
    assert.deepEqual(extra, [], `${file} has keys English does not`);
  }
});

test('(1) every language translates every one of the 12 spoken sentences', () => {
  // These are the only strings the voice ever says. A missing one means the TTS
  // server receives the raw key ("announce.finished") and reads it out loud.
  //
  // COUNT CORRECTED, 8 -> 12, by task-jim-057. The four `blocked` sentences were
  // added when a card that needs a human started making a sound, and this
  // assertion was the thing that noticed — the voice had been asked for it and
  // every other check still passed, because the other checks compare languages
  // to each other and the four new keys went into ALL of them at once. A guard
  // that only compares peers cannot see a change that was made everywhere.
  // The count is kept precisely because it is the one check that is not a
  // comparison: it says how many strings the voice is allowed to have.
  const en = read('en.json').announce;
  const keys = Object.keys(en);
  assert.equal(keys.length, 12, 'eight start/finish sentences plus four for `blocked`');
  for (const file of ['it.json', 'ar.json', 'zh-CN.json']) {
    const a = read(file).announce;
    assert.deepEqual(Object.keys(a).sort(), keys.slice().sort(), `${file} announce keys differ`);
    for (const k of keys) {
      assert.ok(typeof a[k] === 'string' && a[k].length > 0, `${file}.announce.${k} is empty`);
    }
  }
});

test('(1) the spoken sentences keep their placeholders in every language', () => {
  // A translation that drops {{who}} or {{title}} renders as "ha finito: ." —
  // spoken out loud, so it would never be reported by a text-based test.
  const ph = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
  const en = read('en.json').announce;
  for (const file of ['it.json', 'ar.json', 'zh-CN.json']) {
    const a = read(file).announce;
    for (const k of Object.keys(en)) {
      assert.equal(ph(a[k]), ph(en[k]), `${file}.announce.${k} placeholders differ`);
    }
  }
});

test('(1) Italian is a real translation, not a copy of the English file', () => {
  // The failure a parity test alone cannot see: a locale registered with the
  // English strings, so every key exists and every check passes while the
  // language selector is a no-op.
  const en = read('en.json');
  const it = read('it.json');
  const same = leaves(en).filter((k) => {
    const pick = (o, p) => p.split('.').reduce((a, b) => (a == null ? a : a[b]), o);
    const a = pick(en, k);
    const b = pick(it, k);
    return typeof a === 'string' && a === b;
  });
  // Names, units and commands legitimately stay identical; a whole UI cannot.
  assert.ok(same.length < leaves(en).length * 0.2,
    `Italian looks untranslated: ${same.length}/${leaves(en).length} keys identical to English`);
});

// ── (2) the spoken sentence follows the app language ────────────────────────

/** Load the announcer with a real i18next configured for one language. */
function announcerFor(lang) {
  const i18next = require('i18next');
  const i = i18next.createInstance();
  i.init({
    resources: {
      en: { translation: read('en.json') },
      it: { translation: read('it.json') },
      ar: { translation: read('ar.json') },
      'zh-CN': { translation: read('zh-CN.json') }
    },
    lng: lang,
    fallbackLng: 'en',
    initImmediate: false
  });
  // The module imports the shared 'i18next' singleton; point the same object at
  // this instance's language and resources rather than booting a second copy.
  const shared = require('i18next');
  shared.__instance = shared.__instance ?? shared;
  Object.assign(shared, { t: i.t.bind(i), language: i.language });
  return loadAnnouncer();
}

let _mod;
function loadAnnouncer() {
  if (_mod) return _mod;
  const loadTs = require('./load-ts.cjs');
  _mod = loadTs('src/renderer/src/realtime/announcer.ts');
  return _mod;
}

test('(2) the finished sentence is Italian when the app is Italian', () => {
  const { announceSentence } = announcerFor('it');
  const s = announceSentence({ kind: 'done', who: 'Oscar', title: 'fix del login' });
  assert.match(s, /Oscar ha finito: fix del login\./);
  assert.ok(!/finished/.test(s), 'the English wording leaked through');
});

test('(2) the started sentence is Italian when the app is Italian', () => {
  const { announceSentence } = announcerFor('it');
  const s = announceSentence({ kind: 'start', who: 'Oscar', title: 'fix del login' });
  assert.match(s, /Oscar ha iniziato: fix del login\./);
});

test('(2) the title is never translated — it is somebody\'s own words', () => {
  // The agent wrote this. Changing it would put words in its mouth, and it is
  // also the part the user most wants verbatim.
  const { announceSentence } = announcerFor('it');
  const title = 'fix del login';
  assert.ok(announceSentence({ kind: 'done', who: 'Oscar', title }).includes(title));
});

test('(2) a task with no assignee still gets a complete sentence', () => {
  const { announceSentence } = announcerFor('it');
  const s = announceSentence({ kind: 'done', who: '', title: 'pulizia' });
  assert.match(s, /Un task è finito: pulizia\./);
  const bare = announceSentence({ kind: 'done', who: '', title: '' });
  assert.ok(bare.length > 0, 'never an empty string for the TTS server');
  assert.doesNotMatch(bare, /announce\./, 'a raw key would be read out loud');
});

test('(2) switching the app language changes the next announcement', () => {
  const { announceSentence } = announcerFor('en');
  assert.match(announceSentence({ kind: 'done', who: 'Oscar', title: 'x' }), /finished/);
  announcerFor('it');
  assert.match(announceSentence({ kind: 'done', who: 'Oscar', title: 'x' }), /ha finito/);
  announcerFor('ar');
  assert.doesNotMatch(announceSentence({ kind: 'done', who: 'Oscar', title: 'x' }), /finished/);
});
