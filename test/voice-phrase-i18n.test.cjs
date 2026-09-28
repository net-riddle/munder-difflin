'use strict';

// The spoken voice, localized.
//
// The action layer used to build every sentence as an English literal in MAIN.
// That cannot be fixed from main — the chosen language lives in the renderer's
// localStorage and main never sees it — so it now returns a KEY plus variables
// and the renderer resolves it with the i18next instance it already holds.
//
// What this test protects:
//   (1) every phrase key main can emit has a translation, in every language;
//   (2) a missing translation degrades to readable English, NEVER to the bare
//       dotted key — which would be read ALOUD;
//   (3) the confirm echo-back (the whole safety surface for a destructive op)
//       keeps its structure, including the slot-substituted consequences.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const loadTs = require('./load-ts.cjs');
const { VOICE_PHRASES, renderVoicePhrase, interpolate } = loadTs('src/shared/voicePhrases.ts');

const LOCALES = path.join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', 'locales');
const readLocale = (f) => JSON.parse(fs.readFileSync(path.join(LOCALES, f), 'utf8'));

/** An i18n-shaped translator over a locale file, with the same missing-key
 *  behaviour i18next has (it returns the key it was given). */
function translatorFor(lang) {
  const bundle = readLocale(`${lang}.json`);
  return (key, vars) => {
    const v = key.split('.').reduce((a, b) => (a == null ? a : a[b]), bundle);
    if (typeof v !== 'string') return key; // i18next's missing-key behaviour
    return interpolate(v, vars ?? {});
  };
}

const LANGS = ['en', 'it', 'ar', 'zh-CN'];

// ── (1) coverage ────────────────────────────────────────────────────────────

/**
 * Where a phrase's translation lives.
 *
 * Two keyspaces, and conflating them is a silent failure: `voice.*` is the
 * ACTION layer (main's phrase keys) and `rt.*` is the READ-TOOL layer (the
 * sentences tools.ts builds). Both are mirrored into VOICE_PHRASES so a missing
 * translation falls back to English, but their translations live under their own
 * top-level block.
 */
const bundleFor = (lang, key) => {
  const j = readLocale(`${lang}.json`);
  return key.startsWith('rt.') ? j.rt?.[key.slice(3)] : j.voice?.[key];
};

test('(1) every phrase key has a translation in every language', () => {
  // A missing key does not fail the build or the app: the resolver falls back to
  // English. The only symptom is one sentence in the wrong language, spoken
  // aloud, in a voice with no visual context to check it against.
  const keys = Object.keys(VOICE_PHRASES);
  assert.ok(keys.length >= 150, `expected the full surface, got ${keys.length}`);
  for (const lang of LANGS) {
    const missing = keys.filter((k) => typeof bundleFor(lang, k) !== 'string' || !bundleFor(lang, k));
    assert.deepEqual(missing, [], `${lang} is missing voice phrases`);
  }
});

test('(1) every translation keeps the English placeholders', () => {
  const ph = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
  for (const lang of LANGS) {
    for (const [k, en] of Object.entries(VOICE_PHRASES)) {
      const got = bundleFor(lang, k);
      assert.equal(typeof got, 'string', `${lang}.${k} is missing`);
      assert.equal(ph(got), ph(en), `${lang}.${k} placeholders differ`);
    }
  }
});

test('(1) a language is a real translation, not a copy of the English table', () => {
  for (const lang of LANGS.filter((l) => l !== 'en')) {
    const same = Object.keys(VOICE_PHRASES).filter((k) => bundleFor(lang, k) === bundleFor('en', k));
    // Names, units and command words legitimately stay identical; a whole table
    // cannot — that would mean the locale was registered untranslated.
    assert.ok(same.length < Object.keys(VOICE_PHRASES).length * 0.35,
      `${lang} looks untranslated: ${same.length}/${Object.keys(VOICE_PHRASES).length} identical`);
  }
});

// ── (2) the resolver never speaks a key ─────────────────────────────────────

test('(2) an unknown key is the one thing that degrades safely', () => {
  // A typo'd key is a bug worth seeing, but it must be a WORD, not a dotted
  // identifier — otherwise the TTS server reads "voice.dispact.nobjctive" aloud.
  const t = translatorFor('it');
  const out = renderVoicePhrase(t, { key: 'dispatch.nobjctive', vars: { who: 'Oscar' } });
  assert.ok(!out.startsWith('voice.'), `would be read aloud: ${out}`);
});

test('(2) a missing translation falls back to English, not to the key', () => {
  const en = translatorFor('en');
  // Simulate a language that has the key stripped.
  const broken = (key, vars) => (key === 'voice.ping.done' ? key : en(key, vars));
  const out = renderVoicePhrase(broken, { key: 'ping.done', vars: { who: 'Oscar' } });
  assert.equal(out, 'Pinged Oscar.');
  assert.doesNotMatch(out, /voice\./);
});

test('(2) a phrase with no vars still renders', () => {
  for (const lang of LANGS) {
    const t = translatorFor(lang);
    const out = renderVoicePhrase(t, { key: 'dispatch.no_objective' });
    assert.ok(out.trim().length > 0, `${lang} produced nothing`);
    assert.doesNotMatch(out, /\{\{/, 'an unfilled placeholder would be read aloud');
  }
});

// ── (3) the confirm echo-back keeps its structure ───────────────────────────

test('(3) the destructive confirm reads as a full sentence in every language', () => {
  // This is the ENTIRE safety surface for a kill: the human declined on-screen
  // cards, so this text is what they hear before authorizing. Losing a clause
  // in translation would hide a consequence.
  for (const lang of LANGS) {
    const t = translatorFor(lang);
    for (const consequence of ['confirm.consequence_clear', 'confirm.consequence_archive', 'confirm.consequence_generic']) {
      const out = renderVoicePhrase(t, {
        key: 'confirm.destructive',
        vars: { verb: 'kill', who: 'Oscar', note: `{{confirm.note_paused}}`, consequence: `{{${consequence}}}`, confirmWord: 'kill' }
      });
      assert.ok(out.length > 20, `${lang}/${consequence} too short: ${out}`);
      assert.ok(!out.includes('{{'), `${lang}/${consequence} left a slot unresolved: ${out}`);
      assert.ok(!out.includes('voice.'), `${lang}/${consequence} leaked a key: ${out}`);
      // The authorization word must survive, or the user cannot confirm.
      assert.ok(/kill/.test(out), `${lang}/${consequence} lost the confirm word: ${out}`);
    }
  }
});

test('(3) a slot inherits the frame variables', () => {
  // "that wipes HER memory" needs the name, and the slot key carries no vars of
  // its own — without inheritance the sentence would say "that wipes  memory".
  const t = translatorFor('en');
  const out = renderVoicePhrase(t, {
    key: 'confirm.destructive',
    vars: { verb: 'clear context', who: 'Oscar', note: '{{confirm.note_none}}', consequence: '{{confirm.consequence_clear}}', confirmWord: 'clear' }
  });
  assert.match(out, /Oscar/);
  assert.doesNotMatch(out, /wipes\s+memory/, 'the name did not reach the slot');
});

test('(3) the refusal sentence is complete in every language', () => {
  // The mirror image: this is what the user hears when they said only "yes".
  for (const lang of LANGS) {
    const t = translatorFor(lang);
    const out = renderVoicePhrase(t, { key: 'confirm.refused', vars: { verb: 'kill', who: 'Oscar', confirmWord: 'kill' } });
    assert.ok(out.includes('Oscar'), `${lang} lost the target: ${out}`);
    assert.ok(!out.includes('{{'), `${lang} left a placeholder: ${out}`);
  }
});

test('(3) a boolean setting state is a word, not a boolean', () => {
  // 'on'/'off' were being produced in main and glued into a sentence; a locale
  // has to be able to say them in its own words.
  for (const lang of LANGS) {
    const t = translatorFor(lang);
    const on = renderVoicePhrase(t, { key: 'setting.unchanged', vars: { key: 'freeflowEnabled', onoff: '{{setting.state_on}}' } });
    const off = renderVoicePhrase(t, { key: 'setting.unchanged', vars: { key: 'freeflowEnabled', onoff: '{{setting.state_off}}' } });
    assert.notEqual(on, off, `${lang} renders on and off identically`);
    assert.doesNotMatch(on, /\{\{/);
  }
});
