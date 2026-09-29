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

## LE PROVE, e perché solo una ne autorizza

| prova | cosa deve essere vero | autorizza? |
|---|---|---|
| `gemello` | stesso sha in un altro file, almeno uno in una directory di copia, **e questo non è il custode del gruppo** | **sì** |
| `rigenerabile` | il comando che lo rifà esiste ed è stato **girato in questa esecuzione** | non implementata, e dichiarata |
| `fuori uso` | nessuna card aperta lo dichiara, nessuno strumento lo nomina | **NO — non è una prova** |

`fuori uso` è nella lista della card e **non autorizza niente**, perché è vero di
quasi ogni file di un repository, **incluso il codice sorgente**. La prima
esecuzione reale lo ha dimostato: proponeva **4 218 file su 4 218 trovati**,
`docs/media/hero.mp4` compreso, tutti etichettati «fuori uso». *L'assenza di un
riferimento non è una derivazione: è lo stato normale di ogni file, e una prova
vera di tutto non prova niente.* La regola che comanda tutto dice «solo ciò che è
dimostrabilmente derivato», e quella vince.

**Il custode.** Su un gruppo di file identici ne resta **uno**. Una prova gemella
aperta controlla «esiste ancora qualcosa di identico», che resta vero fino a quando
è vero di niente. *Due testimoni che ognuno pensa che l'altro sia la riserva è il
modo in cui un intero insieme scompare.*

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

## Limiti dichiarati

1. **`rigenerabile` non è implementata.** È la prova che servirebbe per le copie
   enormi, e non l'ho fatta perché un comando è una prova solo se è stato girato e
   ha rifatto il file. Dichiarata, non simulata.
2. **I 210 MB di `.opencode` non sono un caso per-file.** Quattro alberi da 52,5 MB,
   76,6 % dei file identici byte per byte, 158,1 MB nominalmente recuperabili — ma il
   grosso è `node_modules` annidato, e **cancellare file singoli dentro un
   `node_modules` non è un'unità sicura**. L'unità giusta è l'albero intero, e
   quello è un'altra card.
3. **Il `fuori uso` resta indicativo.** È scritto nel manifesto come nota e non come
   prova, perché usarlo autorizzerebbe a cancellare il repository.
