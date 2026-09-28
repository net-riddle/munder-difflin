'use strict';

// The read-tools' spoken prose.
//
// tools.ts returns SENTENCES, not data. The model repeats them and the voice
// reads them aloud, so an English literal there is an English voice — in a voice
// channel with no visual context, and on an app the user has set to Italian.
//
// What this pins:
//   (1) every sentence the tools build goes through the `rt` keyspace, so it
//       is localizable;
//   (2) every rt key exists in every language, with its placeholders intact;
//   (3) the strings left in English are the ones that MUST be — a task title, a
//       message body, the JSON payload the model reasons over, the changelog.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TOOLS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'realtime', 'tools.ts');
const LOCALES = path.join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', 'locales');
const readLocale = (f) => JSON.parse(fs.readFileSync(path.join(LOCALES, f), 'utf8'));
const LANGS = ['en', 'it', 'ar', 'zh-CN'];

// ── (1) no English prose left in the spoken paths ────────────────────────────

test('(1) tools.ts routes its sentences through the rt keyspace', () => {
  const src = fs.readFileSync(TOOLS, 'utf8');
  // A `return 'I ...'` or `return \`The ...\`` is a sentence handed to the voice
  // without going through i18next. Allow: a bare key, a format placeholder with
  // no English words, and the deliberate data-carrying returns listed below.
  const DATA_RETURNS = [
    'return mem.trim()',              // the agent's own notes, verbatim
    'return clip(res.output.trim()',  // a search result, verbatim
    'return clip(tf',                 // a text-search excerpt, verbatim
    'return \`${summary}'             // the warm-start summary + JSON data
  ];
  const offenders = src
    .split(/\r?\n/)
    .map((l, i) => ({ n: i + 1, l }))
    .filter(({ l }) => /return\s+[`']/.test(l))
    .filter(({ l }) => !/return\s+t\(/.test(l))
    .filter(({ l }) => !DATA_RETURNS.some((d) => l.includes(d)))
    // A single word in quotes is a data default, not a sentence.
    .filter(({ l }) => {
      const m = l.match(/return\s+[`']([^`']*)[`']/);
      if (!m) return false;
      const v = m[1].trim();
      return v.length > 3 && /[a-z]{3,}\s+[a-z]{3,}/i.test(v);
    });
  assert.deepEqual(
    offenders.map((o) => `${o.n}: ${o.l.trim().slice(0, 60)}`),
    [],
    'spoken prose left inline in tools.ts'
  );
});

test('(1) the formatting helpers are localized, not English', () => {
  const src = fs.readFileSync(TOOLS, 'utf8');
  // ago()/every()/tokens() run on every single tool call, so an English literal
  // in any of them colours the whole answer, not one branch.
  for (const fn of ['function ago(', 'function every(', 'function tokens(']) {
    const from = src.indexOf(fn);
    assert.ok(from > 0, `${fn} not found`);
    const body = src.slice(from, src.indexOf('\n}', from));
    // Flag a return only when it is PROSE: two or more English words, or an
    // interpolation containing one. `${Math.round(v)}` is a bare number and
    // `${String(...)}` a cast — neither is English, and both look like words
    // to a naive matcher.
    const prose = /([A-Za-z]{2,}\s+){1,}[A-Za-z]{2,}/;
    const offenders = body.split(/\r?\n/).filter((l) => {
      if (!/return\s+[`']/.test(l)) return false;
      if (/return\s+t\(/.test(l)) return false;
      const m = l.match(/return\s+[`']([\s\S]*?)[`']/);
      if (!m) return false;
      // Strip every ${...} expression, then look for words in what remains.
      const literal = m[1].replace(/\$\{[^}]*\}/g, ' ').replace(/\{\{\w+\}\}/g, ' ').trim();
      return prose.test(literal);
    });
    assert.deepEqual(offenders, [], `${fn} still returns English prose`);
  }
});

// ── (2) coverage ────────────────────────────────────────────────────────────

test('(2) every rt key exists in every language', () => {
  const en = readLocale('en.json').rt;
  const keys = Object.keys(en);
  assert.ok(keys.length >= 75, `expected the full surface, got ${keys.length}`);
  for (const lang of LANGS) {
    const missing = keys.filter((k) => !readLocale(`${lang}.json`).rt?.[k]);
    assert.deepEqual(missing, [], `${lang} is missing rt keys`);
  }
});

test('(2) every rt key keeps its English placeholders', () => {
  const ph = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
  const en = readLocale('en.json').rt;
  for (const lang of LANGS) {
    const rt = readLocale(`${lang}.json`).rt;
    for (const [k, v] of Object.entries(en)) {
      assert.equal(ph(rt[k]), ph(v), `${lang}.rt.${k} placeholders differ`);
    }
  }
});

test('(2) the plural-sensitive keys really change with the count', () => {
  // A translation that lost the count, or that reads the same for 1 and 5, is
  // the failure a placeholder check cannot see.
  const it = readLocale('it.json').rt;
  assert.notEqual(it['tool.fleet_head'].replace('{{count}}', '1'), it['tool.fleet_head'].replace('{{count}}', '5'));
  assert.match(it['ago.minutes'], /{{count}}/);
  assert.match(it['cadence.minutes'], /{{count}}/);
});

test('(2) Italian is a real translation of the tool prose', () => {
  const en = readLocale('en.json').rt;
  const it = readLocale('it.json').rt;
  const same = Object.keys(en).filter((k) => en[k] === it[k]);
  // Proper nouns and bare data words legitimately match; a whole table cannot.
  assert.ok(same.length < Object.keys(en).length * 0.35,
    `it.rt looks untranslated: ${same.length}/${Object.keys(en).length} identical`);
});

// ── (3) the English that must stay ──────────────────────────────────────────

test('(3) the deliberately-English strings are still English', () => {
  // These are NOT sentences: they are a card title, a message body, a JSON
  // payload and a changelog. Translating them would invent words nobody said
  // or ship a second, drifting changelog. So the FRAME is localized and the
  // CONTENT is passed through.
  const src = fs.readFileSync(TOOLS, 'utf8');
  // The changelog text itself is handed to the clip() untouched.
  assert.ok(
    /notes \? t\('tool\.release_notes', \{ notes: clip\(notes, 1600\) \}\)/.test(src),
    'the changelog must be passed through, not translated'
  );
  assert.match(readLocale('en.json').rt['tool.release_notes'], /\{\{notes\}\}/);
  assert.match(readLocale('it.json').rt['tool.release_notes'], /\{\{notes\}\}/);
  // A task title and a message body come from `str(card.title)` / `despan(body)`
  // and are inserted raw — no t() wrapping them.
  assert.ok(src.includes("clip(str(t.title)") || src.includes('clip(str(c.title)'),
    'card titles are still passed through verbatim');
});
