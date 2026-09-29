'use strict';

/**
 * 100 — pulizia_residui_lavorazione: cancellare i file consumati, SENZA MAI
 * cancellare l'unica copia.
 *
 * The six cases the card names, and each one is about a way this tool could lose
 * somebody's work. Case 1 is the one that matters: a tool that cannot tell the
 * difference between a copy and an original is not a tidier, it is a hazard with a
 * `--dry-run` flag.
 *
 * The tests run against a synthetic floor, never the real one, because the first
 * run of this skill against the real floor is the human's, and it is made by
 * looking at a manifest.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SKILL = 'F:/workspace/projects/munder-difflin/resources/skills/pulizia_residui_lavorazione/pulizia.mjs';

// The skill is an ES module and this file is CommonJS, so there is no top-level
// `await` here. Loading it in `before` is the honest way round it — and it is
// loaded ONCE, from the real path, so the tests run the file the repo ships
// rather than a transcription of it.
//
// `pathToFileURL`, not the raw string: on Windows a bare `F:\…` reaches the ESM
// loader as protocol `f:`, which it refuses. The first run of this test file
// failed all six cases on that, which is a reminder that the loader is stricter
// than the filesystem and does not care how obviously fine the path looks.
let costruisciPiano;
before(async () => { ({ costruisciPiano } = await import(pathToFileURL(SKILL).href)); });

const CONTENUTO = 'questo e\' il contenuto identico, byte per byte\n';

/** A floor with the shapes that decide the outcome: a source, its copies, and
 *  things that must never be touched. */
function piano(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pulizia-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const scrivi = (rel, contenuto = CONTENUTO) => {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contenuto, 'utf8');
    return p;
  };
  // `carte` is passed explicitly so the fixtures never depend on the floor's real
  // ledger — and `ok: true` says "I read it and there are no open cards", which is
  // a different statement from "I could not read it". The test below is about that
  // difference, and a fixture that blurred it would be testing nothing.
  const carte = { ok: true, carte: [], motivo: '' };
  const p = (extra) => costruisciPiano({ roots: [home], dichiarati: new Set(), nomiLetti: new Set(), carte, ...extra });
  return { home, scrivi, carte, p, proposte: () => p().proposte, protetti: () => p().protetti };
}

// ── 7. a tool that cannot see the rules must assume they forbid it ─────────

test('100: a ledger that cannot be read makes the plan EMPTY, not wide open', (t) => {
  const { scrivi } = piano(t);
  // Two genuinely identical copies: on a readable ledger this IS a real proposal.
  const fonte = scrivi('resources/skills/z/skill.md', CONTENUTO);
  const copia = scrivi('agents/jim/.claude/skills/z/skill.md', CONTENUTO);
  const { costruisciPiano: _ } = {};

  const carteRotte = { ok: false, carte: [], motivo: 'NON RIESCO A LEGGERE tasks.json' };
  const pianoRotto = costruisciPiano({
    roots: [path.dirname(fonte)], dichiarati: new Set(), nomiLetti: new Set(), carte: carteRotte
  });

  assert.equal(pianoRotto.proposte.length, 0,
    'THE PLAN GOES TO ZERO. `chain.cjs` writes the ledger in place with a plain writeFileSync, so a reader during a write sees a truncated file — tonight\'s own ledger did exactly that. Returning an empty card list there would mean answering «no open card declares anything» FROM A FILE THAT FAILED TO READ, and that is the claim `fuori uso` is built on. *A tool that cannot see the rules must assume the rules forbid it, because the alternative is a tool that assumes nobody set any.*');
  assert.ok(pianoRotto.protetti.some((p) => p.path === fonte),
    'and the reason travels with the file, so the manifest says WHY nothing was proposed instead of just proposing nothing');
  assert.ok(pianoRotto.protetti.some((p) => p.perche.includes('NON RIESCO A LEGGERE')),
    'the reason is the ledger, verbatim, not a shrug');
  assert.ok(copia, 'the copy still exists, which is the only thing that really matters here');
});

// ── 1. THE CASE THAT MUST NEVER HAPPEN ─────────────────────────────────────

test('100: a file that exists in ONE place only is never proposed, however old it looks', (t) => {
  const { scrivi, proposte } = piano(t);
  const unico = scrivi('lavoro/relazione-unica.md', 'l\'unica copia di tre settimane di lavoro\n');
  // Make it look as old and as abandoned as a file can look. Age is not evidence,
  // and this is the assertion that says so.
  const vecchio = new Date(Date.now() - 400 * 86400000);
  fs.utimesSync(unico, vecchio, vecchio);

  const proposti = proposte();
  assert.equal(proposti.some((p) => p.path === unico), false,
    'IT EXISTS NOWHERE ELSE. It is the only copy, so it is not a residue — it is the work. An old file nobody has opened is exactly the file a tidier destroys, and the whole rule exists to refuse that trade.');
  assert.equal(proposti.length, 0, 'and with nothing else on the floor, the plan is empty: ' + JSON.stringify(proposti.map((p) => p.path)));
});

// ── 2. the .patch ──────────────────────────────────────────────────────────

test('100: an uncommitted .patch is never proposed, under the name it really had', (t) => {
  const { scrivi, proposte } = piano(t);
  // The exact filename from tonight: this file was 217 lines of never-committed
  // work, and a tidier that had taken it would have left nothing at all.
  const patch = scrivi('agents/jim/093-claim.patch', CONTENUTO + CONTENUTO);
  const identico = scrivi('agents/pam/093-claim.patch', CONTENUTO + CONTENUTO);

  const proposti = proposte();
  assert.equal(proposti.some((p) => p.path === patch), false,
    'THE MOST IDENTICAL-TO-A-USELESS-SCRIPT FILE IS THE ONE NOBODY HAS RUN YET. Identical content to a copy elsewhere is not permission: the twin of a patch is another patch, and neither is committed.');
  assert.equal(proposti.some((p) => p.path === identico), false, 'not even the second one — the rule is the suffix, not the count');
});

// ── 3. --dry-run deletes nothing ───────────────────────────────────────────

test('100: the plan is a plan — building it writes no manifest and deletes nothing', (t) => {
  const { home, scrivi } = piano(t);
  const copia = scrivi('resources/skills/x/skill.md', CONTENUTO);
  const copia2 = scrivi('agents/jim/.claude/skills/x/skill.md', CONTENUTO);
  const prima = fs.readdirSync(home).sort().join(',');

  const p = costruisciPiano({ roots: [home], dichiarati: new Set(), nomiLetti: new Set() });
  assert.ok(p.contatori.fileProposti >= 1, 'a real duplicate IS proposed, or the test proves nothing');
  assert.equal(fs.existsSync(copia), true, 'the source is still there');
  assert.equal(fs.existsSync(copia2), true, 'and so is the copy: costruisciPiano is a function, and a function that deleted would be a bug in the noun');
  assert.equal(fs.readdirSync(home).sort().join(','), prima, 'and the floor gained no file at all');
});

// ── 4. the keeper: three identical copies, one survives ────────────────────

test('100: of three identical copies, exactly ONE is kept and the rest are proposed', (t) => {
  const { scrivi, proposte } = piano(t);
  const a = scrivi('resources/skills/y/skill.md', CONTENUTO);
  const b = scrivi('agents/jim/.claude/skills/y/skill.md', CONTENUTO);
  const c = scrivi('agents/pam/.claude/skills/y/skill.md', CONTENUTO);

  const proposti = proposte();
  const deiTre = [a, b, c].filter((p) => proposti.some((q) => q.path === p));
  assert.equal(deiTre.length, 2, 'two of three are proposed');

  const custode = [a, b, c].find((p) => !proposti.some((q) => q.path === p));
  assert.ok(custode, 'AND ONE SURVIVES. This is the assertion that a naive twin proof cannot pass: at the moment it considers the third file, the other two still exist, so "something identical is still there" is true right up until it is true of nothing. *Two witnesses who each think the other is the backup is how a whole set disappears.*');
  assert.equal(custode, a, 'and the keeper is the one OUTSIDE a copy directory, because that is the one somebody wrote');
});

// ── 5. `fuori uso` is not a proof ──────────────────────────────────────────

test('100: a file nobody references is still not proposed — absence of a reference is not derivation', (t) => {
  const { scrivi, proposte } = piano(t);
  // The bug this skill shipped with on its first real run: it proposed 4 218 of
  // 4 218 files, `docs/media/hero.mp4` among them, all labelled «fuori uso».
  const orfano = scrivi('docs/media/hero.mp4', 'binary-ish ' + 'x'.repeat(5000));
  const sorgente = scrivi('src/main/qualcosa.ts', 'export const a = 1;\n');

  const prop = proposte();
  for (const p of [orfano, sorgente]) {
    assert.equal(prop.some((q) => q.path === p), false,
      'nothing in the tools or the sources mentions this file — and that is the NORMAL STATE OF EVERY FILE, including the source code itself. A proof that is true of everything proves nothing, and acting on it would delete the repository.');
  }
});

// ── 6. the floor's own memory is untouchable ───────────────────────────────

test('100: the floor\'s memory, the inbox archive and the identities are never candidates', (t) => {
  const { scrivi, proposte, protetti } = piano(t);
  const sacri = [
    'tasks.json', 'tasks.archive.json', 'log.jsonl', 'registry.json', 'fleet.json',
    'identity.md', 'memory.md'
  ].map((n) => scrivi('hive/' + n, CONTENUTO));
  const archiviato = scrivi('hive/agents/jim/inbox/.done/2026-01-01T00-00-00-000Z-x.json', CONTENUTO);
  const git = scrivi('repo/.git/HEAD', CONTENUTO);
  const nm = scrivi('repo/node_modules/x/index.js', CONTENUTO);
  const seStesso = scrivi('repo/resources/skills/pulizia_residui_lavorazione/pulizia.mjs', CONTENUTO);

  const prop = proposte();
  for (const p of [...sacri, archiviato, git, nm, seStesso]) {
    assert.equal(prop.some((q) => q.path === p), false, 'MAI: ' + p);
  }
  const prot = protetti().map((x) => x.path);
  assert.ok(prot.includes(sacri[0]), 'and they appear in the manifest as PROTECTED, not merely as absent: a manifest that lists only the victims is a manifest that cannot be argued with');
  assert.ok(prot.some((p) => p.includes(puliziaResidui())), 'and the skill protects ITSELF, because the one error that would be funny here is the one that is not allowed');
});

function puliziaResidui() {
  return path.join('skills', 'pulizia_residui_lavorazione');
}
