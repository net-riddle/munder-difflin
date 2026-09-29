---
name: pulizia_residui_lavorazione
description: Cancella i file CONSUMATI di un pavimento di agenti, senza mai cancellare l'unica copia. Comando, non dialogo: esce con un codice, stampa un elenco, e di default non cancella niente.
---

# pulizia_residui_lavorazione

> **UN FILE CHE ESISTE IN UN POSTO SOLO NON È UN RESIDUO: È L'UNICA COPIA.**

Il nome dice «residui di lavorazione» e la parola pericolosa è *residui*. Un file
che sembra vecchio è un residuo solo se nessuno lo usa, e **nessuno lo usa non si
sa guardando il nome**: si sa guardando se esiste da un'altra parte. Se non esiste
da un'altra parte, non lo si sa — quindi non si cancella.

## Perché è un comando e non un dialogo

L'umano vuole **schedularla**. A un orario schedulato non c'è nessuno a cui
chiedere il permesso, e una richiesta che non trova nessuno o viene saltata o
blocca tutto — e in entrambi i casi non pulisce. Quindi: nessuna domanda, nessuna
conferma per file, un codice di uscita e un elenco.

```
node pulizia.mjs              # --dry-run: scrive il manifesto, NON cancella, esce 0
node pulizia.mjs --applica --manifest <file>
```

`--applica` cancella **solo** le voci del manifesto indicate, non più vecchio di
`MAX_AGE_GIORNI`, e **rivalida** ciascun file prima di cancellarlo: se nel
frattempo il contenuto è cambiato, o il file è diventato protetto, o non esiste
più, viene **saltato e detto**. Un comando che cancella ciò che «ha trovato al
momento» cancella qualcosa di diverso da ciò che è stato approvato, e il divario
fra le due cose è esattamente dove si perde il lavoro.

## LA PRIMA ESECUZIONE NON CANCELLA NULLA, E NON ESISTE UN FLAG CHE LO PERMETTA

Uno strumento distruttivo che diventa distruttivo al primo uso non è uno strumento
che si è sbagliato a configurare: è uno strumento che non è stato provato prima
di fare il suo mestiere. **La seconda esecuzione la preme l'umano, guardando il
manifesto.** Io posso scrivere la riga che cancella; il diritto di premere quel
tasto è suo.

## LE PROVE, e perché una terza non ne autorizza

> **Alla prova può autorizzare; il giudizio va dall'umano.**

| prova | cosa deve essere vero | autorizza? |
|---|---|---|
| `gemello` | stesso sha in un altro file, almeno uno in una directory di copia, **e questo non è il custode del gruppo** | **sì** |
| `rigenerabile` | il file sta in una **directory d'uscita dichiarata** qui dentro, **il repository stesso lo dichiara generato**, e **il comando che lo rifà esiste** fra gli script di quel `package.json` | **sì** |
| `fuori uso` | nessuna card aperta lo dichiara, nessuno strumento lo nomina | **NO — non è una prova** |

`fuori uso` è nella lista della card e **non autorizza niente**, perché è vero di
quasi ogni file di un repository, **incluso il codice sorgente**. La prima
esecuzione reale lo ha dimostrato: proponeva **4 218 file su 4 218 trovati**,
`docs/media/hero.mp4` compreso, tutti etichettati «fuori uso». *L'assenza di un
riferimento non è una derivazione: è lo stato normale di ogni file, e una prova
vera di tutto non prova niente.* La regola che comanda tutto dice «solo ciò che è
dimostrabilmente derivato», e quella vince.

### `rigenerabile`, e perché è la prova che mancava

Con la sola prova `gemello` la skill **si ferma ai gemelli**: un artefatto di build
non ha quasi mai un gemello, quindi la prova più comune di un residuo non la
vedeva. `rigenerabile` è la seconda delle due cose che autorizzano, e l'altra
esiste già scritta in questa skill: «the same content exists elsewhere, **or a
command that still rebuilds it**».

Tre fatti, e il terzo è quello che la rende una prova e non un'asserzione:

1. il file è dentro una **directory d'uscita dichiarata** nel contratto in
   `pulizia.mjs` (`USCITE_DICHIARATE`), non dentro una che *sembra* un'uscita;
2. **il repository lo dichiara generato** — e la domanda va posta a
   `git check-ignore`, non a un regex scritto qui: *un elenco di protezione che
   non aggancia i percorsi che riceve non è un elenco di protezione, è un
   commento*, ed è il bug che ha già fatto scivolare ~500 messaggi archiviati;
3. **il comando esiste** come script in quel `package.json`. Ogni voce del
   contratto che nomina uno script inesistente viene **scartata all'avvio**: un
   contratto falso non cancella, toglie solo la qualità di prova a una
   cancellazione, quindi **la direzione in cui questa skill deve sbagliare è
   «non cancellare»**.

**Il comando NON viene rilanciato dall'esecuzione.** Un comando schedulato che
cancella è già una cosa seria; rilanciare una build dentro è un'altra, e rompere
l'albero per poi ricostruirlo è il contrario di una prova. Quindi la verifica
empirica è **fuori dal comando**, una volta, a mano, e la sua **data sta scritta
nel contratto**: per `out/`, il 2026-09-30, `out/` rimossa e `npm run build`
rilanciato → 115 file, 31 669 367 byte. *«Sembra generato» è un giudizio; «non
c'era più, ed è tornato» è un fatto.*

**Le due falsificazioni, e senza di loro questa non è una prova ma una regola:**

- **ignorato da git non vuol dire rigenerabile.** Un `.log`, un `.env`, una
  cartella `blog-preview` sono ignorati e nessun comando li rifà. Se la prova
  rispondesse sì su quelli, sarebbe `fuori uso` con un nome nuovo, un livello più
  su: «ignorato» non è «rigenerabile» come «non referenziato» non era «derivato».
- **un file che git traccia è contenuto**, in qualunque directory viva. Per questo
  `check-ignore` va chiamato **senza** `--no-index`. E non è una clausola: sono le
  quattro copie `.opencode` in `hive/agents/<id>/`, che il repository traccia, e
  questa prova le lascia stare **senza che nessuno debba deciderlo**.

Il **custode** dei gemelli vale ancora e non è una clausola: `rigenerabile` non si
applica a un file che ne ha uno identico altrove, perché in quel caso l'onesto
padrone è l'altro. Su un gruppo di file identici ne resta **uno**. Una prova
gemella aperta controlla «esiste ancora qualcosa di identico», che resta vero fino
a quando è vero di niente. *Due testimoni che ognuno pensa che l'altro sia la
riserva è il modo in cui un intero insieme scompare.*

## NON SI CANCELLA MAI — elenco scritto qui, non in un messaggio

Un contratto scritto in un messaggio sparisce quando il messaggio viene archiviato.


- `tasks.json`, `tasks.archive.json`, `log.jsonl`, `registry.json`, `fleet.json` — il
  piano, l'archivio, la prova, chi esiste. Cancellarli non è pulizia, è **amnesia**
- `identity.md`, `memory.md` — **aggiunta mia, dichiarata come mia**: un agente
  senza la sua memoria è un agente nuovo
- qualunque `*.patch` e `*.diff` — stanotte `093-claim.patch` era **l'unica copia**
  di 217 righe mai committate. *Il file più identico a uno script inutile è quello
  che nessuno ha ancora eseguito*
- tutto ciò che sta sotto `inbox/.done/` — un messaggio archiviato è la prova che
  qualcuno ha risposto
- `*.receipt.json`, `msg-*.json`, tutto ciò che sta sotto `.claim/` — **e qui il
  numero è 0**: stanotte misurati 0 ricevute, 0 envelope vocali, 0 `.claim`. La
  pulizia non deve creare l'impressione che quei file esistessero
- `node_modules`, `.git` — rigenerati, non residui
- **qualunque percorso che una card APERTA nomina**, letto da `tasks.json`, non
  indovinato
- **la skill stessa**: se la pulizia includesse le skill, la prossima esecuzione
  cercherebbe di cancellare sé stessa, ed è l'unico errore divertente che non va
  permesso

## L'età non decide niente

L'età è al massimo un **ordine di presentazione** del piano. Un file vecchio che
nessuno usa è un residuo; **un file di ieri che è l'unica copia del lavoro di
stanotte è il lavoro di stanotte.** Il test 1 mette `utimes` a 400 giorni e il file
resta intatto.

## Il rapporto esce anche quando non ha cancellato nulla

Tre numeri, sempre, con `0` scritti come `0`: **byte trovati, byte proposti, byte
effettivamente cancellati.** Un numero che descrive una cosa diversa da quella che
dice è la peggior forma di bug, perché non si contraddice con niente.

## Idempotente, e non può aumentare

Due esecuzioni consecutive: la seconda dice **zero** e non aggiunge un byte. Il
manifesto ha un nome per giorno e viene **sovrascritto**, non affiancato — un file
nuovo per ogni esecuzione sarebbe esso stesso un residuo che la skill crea.

## Cosa è costato scriverla, e cosa non va rifatto

- La prima versione **non terminava in 30 minuti**: la prova `fuori uso` rileggeva
  strumenti e sorgenti **per ogni candidato**. Ora è un indice letto una volta.
  *Una prova che costa una scansione intera per file è un blocco con una giustificazione attaccata.*
- La prima esecuzione reale ha protetto quasi nulla: i motivi erano scritti con `/`
  e i percorsi arrivano con `\`, quindi **la regola `.done` non ha mai agganciato** e
  ~500 messaggi archiviati sono stati scansionati e hashati come candidati. L'unica
  ragione per cui niente è stato cancellato è un secondo bug che per caso l'ha
  fermato. *Una lista di protezione che non aggancia i percorsi che riceve non è una
  lista di protezione: è un commento.*
- Il filtro iniziale era `if (prova)` su un oggetto il cui `prova` era `null`: un
  oggetto truthy. Il piano elencava 4 219 file con `[null]` accanto — un piano che
  dice «proponi tutto, e questa è la ragione». *Una guardia sul campo sbagliato non è
  una guardia.*
- I percorsi protetti vengono normalizzati **prima** di ogni regex, e gli alberi
  protetti non vengono nemmeno percorsi.
- `build/` **era** in elenco fra le directory di copia, perché si chiama `build`. In
  `munder-difflin` contiene **8 file tracciati** (`icon.icns`, `notarize.cjs`,
  `SIGNING.md`…) e **0 non tracciati**: è sorgente, non un'uscita. Tolto, e la
  vera uscita è `out/`, che ha 0 file tracciati ed è nominata da `.gitignore`.
  *Un nome non è una derivazione, e un elenco costruito sui nomi è un elenco di
  supposizioni con un ciclo.*

## Limiti dichiarati

1. **`rigenerabile` è implementata e verificata, ma il comando NON viene rilanciato
   dentro l'esecuzione.** La verifica empirica sta **fuori**, una volta, a mano, e la
   sua data è **nel contratto** (`USCITE_DICHIARATE[].verificatoIl`). Il difetto che
   resta dichiarato: se il `package.json` dichiarasse uno script che produce
   qualcos'altro, questa skill lo crede. Il riparo è che la voce è **eliminata** se lo
   script non esiste, e la direzione dell'errore resta «non cancellare».
2. **Un contratto dichiarato a mano è ancora una dichiarazione.** Nessuna prova può
   accorgersi che `out/` non è davvero l'uscita di `build` se qualcuno lo scrive
   così. Quindi la voce va tenuta corta e datata, e va riletta quando i nomi degli
   script cambiano.
3. **I 210 MB di `.opencode` restano fuori, e non per una scelta mia.** Quattro
   alberi da 52,5 MB in `hive/agents/<id>/`, 76,6 % dei file identici byte per byte.
   Sono **tracciati** dal repository `hive`, quindi `rigenerabile` non li tocca e
   `gemello` non li completa: **non è più una domanda aperta, è una misura** — non
   sono derivati, sono contenuto. Ripulirli è un'altra card, e cancellare copie
   tracciate è distruttivo, quindi è dell'umano.
4. **Il `fuori uso` resta indicativo.** È scritto nel manifesto come nota e non come
   prova, perché usarlo autorizzerebbe a cancellare il repository.
