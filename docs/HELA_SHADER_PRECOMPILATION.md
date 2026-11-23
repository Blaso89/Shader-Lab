# Precompilazione locale DXIL-to-SM5 integrata in Shader Lab

**Stato:** prima milestone implementata localmente; cache, pairing automatico VS/PS e smoke test proxy restano da fare
**Repository di riferimento:** `Blaso89/Shader-Lab`, branch `main`, commit `23b73f61cdd2a22fef6e5bbf109d8b280d5de3d8`

Questa implementazione riguarda una pipeline locale di precompilazione di shader DXIL già disponibili su disco, controllata dal pannello esistente di Shader Lab. Non avvia Hela, non genera traffico di prova e non include shader catturati o log del gioco. Il problema egress rimane un vincolo separato: questa funzionalità non tocca firewall o configurazioni di rete.

## 1. Scopo e limiti

- L'azione **Precompilazione DXIL locale** nel pannello seleziona input, cartella base di staging e mappa binding JSON opzionale; il job enumera `.dxil`/`.cso`, mostra progressi e accetta cancellazione cooperativa.
- Riutilizza la pipeline DXIL-to-HLSL e compila con FXC, scrivendo candidati `.cso` DXBC/SM5 in una sottocartella `ShaderLab-Staging-<timestamp>`.
- Mostrare conteggi e avanzamento riferiti esclusivamente ai file enumerati nel job. Non dichiarare copertura o compatibilità complessiva del gioco: la sorgente contiene solo shader già disponibili.
- Un esito FXC positivo dimostra la compilazione, non l'equivalenza funzionale né il rendering corretto.

Fuori ambito: injector, bridge runtime col proxy, conversione durante il gioco, modifiche al proxy o al repository Hela e avvio del gioco.

## 2. Architettura implementata

### Punto d'integrazione

Il server MCP usa stdio. L'estensione VS Code non agisce da client MCP: molte azioni inoltrano richieste a Copilot Chat, ma il job batch è gestito localmente dall'extension host. Lo stato “Live” deriva dal monitor dei log MCP, non dal protocollo di progress batch.

Di conseguenza, l'**extension host** possiede il job e lo stato: avvio, progress e cancellazione. La Webview invia comandi all'host e riceve messaggi di progress usando il canale `postMessage` esistente. Non c'è cache o ripresa tra job.

### Core condiviso

Per evitare una seconda implementazione della conversione, la logica condivisa è in `src/dxil-precompile.ts`: il tool MCP `dxil_to_sm5_hlsl` la usa per la conversione singola e l'extension host importa il build `dist/dxil-precompile.js` per il batch. Non è stato aggiunto un tool MCP batch.

Il core dovrebbe comporre i primitivi già presenti:

- analisi e firme da `src/dxil-analyzer.ts`;
- post-processing da `src/hlsl-post.ts`;
- esecuzione dei tool esterni da `src/external.ts`.

Il server MCP e l'extension host sono consumatori distinti: la condivisione del codice non implica un canale runtime tra i due. L'import dinamico ESM da CJS è passato in un test Node locale; resta da validare nel VS Code Extension Development Host.

## 3. Job, progress e cancellazione

### Avvio e snapshot

La Webview invia `startPrecompile`; l'host chiede input, directory base di staging e mappa binding opzionale. Il core congela all'avvio i file `.dxil` e `.cso` (escludendo `node_modules` e `.git`) e ne registra SHA-256; verifica che i byte non cambino prima della conversione.

La percentuale è `settled / total` per quello snapshot, con contatori `compiled`, `blocked`, `failed`, `skipped`, `cancelled`, file corrente e stato. Le aggiunte successive alla directory non entrano nel job corrente. Un `.cso` valido senza payload DXIL è ignorato; un `.dxil` senza payload DXIL o un container malformato è un errore.

### Messaggi Webview

La Webview riceve un messaggio di progress per file con questa forma:

```json
{
  "command": "precompileProgress",
  "total": 40,
  "settled": 12,
  "counts": { "compiled": 8, "blocked": 1, "failed": 1, "skipped": 1, "cancelled": 1 },
  "currentFile": "shader.dxil",
  "currentStatus": "converting"
}
```

Durante la costruzione dello snapshot arrivano messaggi separati `precompileSnapshotProgress`; in quella fase la barra è indeterminata.

La Webview passa a una schermata dedicata per la preparazione e l'esecuzione del job. La schermata mostra rapporto `settled / total`, file/stato corrente, contatori, output staging e una finestra mobile degli ultimi 12 risultati; il riepilogo terminale mostra fino a 30 blocker/errori. La scansione e l'hashing dello snapshot hanno una barra distinta da quella di compilazione. Tornando al dashboard mentre il job è attivo, un banner permette di riaprire l'avanzamento; il job continua nell'extension host. Il riepilogo finale resta consultabile finché l'utente non torna al dashboard.

### Cancellazione ed errori

`cancelPrecompile` imposta un segnale cooperativo controllato tra file e tra i processi esterni. L'attuale `run()` usa `execFile` con timeout e non espone un `AbortSignal`: la v1 non interrompe un processo già in esecuzione, ma controlla la richiesta al suo termine e prima del processo successivo. La UI dichiara che l'annullamento attende il passaggio esterno attivo.

Gli errori e i blocker per singolo file vengono mostrati in UI; il job continua sugli altri file. Errori di enumerazione, directory non separata o staging non vuoto interrompono il job esplicitamente. La UI limita a 30 le righe di dettaglio mostrate nel riepilogo finale.

## 4. Pipeline per file e metadati

`convert_directory` converte sorgente HLSL testuale e produce anche `binding_map.json`; non è il convertitore binario DXIL. La pipeline candidata per DXIL usa `dxil-spirv`, `spirv-cross` e `postprocessHlsl`, poi FXC.

Per ogni file, il batch:

- **Stage e profilo FXC:** ricava lo stage dal disassemblato DXC associato e lo confronta con quello del container, se disponibile; stage mancante o non supportato è `blocked`.
- **Entry point:** usa solo l'entry point riconosciuto nell'HLSL generato; se manca, non invoca FXC.
- **Disassembly e binding map:** cerca `<base>_dxil.txt` o `<nome>.dxil.txt`. Se register space restano rimappati localmente senza binding map, non invoca FXC.
- **Pixel shader:** segnala che l'abbinamento/firma VS-PS non è verificato automaticamente.
- **Feature non supportate:** non passa `force=true`; i blocker SM6 sono `blocked`.

## 5. Stati del job

Stati terminali implementati: `compiled`, `blocked`, `failed`, `skipped`, `cancelled`. `compiled` richiede FXC con exit code 0 e un container DXBC legacy privo di chunk DXIL. Il profilo FXC è scelto dallo stage disassemblato; i blocker, lo stage sconosciuto, l'entry point non riconosciuto e i register space senza mappa fermano il file prima della scrittura. I pixel shader sono candidati con avviso esplicito perché il pairing/firma VS-PS non è verificato automaticamente. Nessuno stato prova equivalenza o rendering.

## 6. Naming degli override e prerequisito di parità hash

Nel proxy, `LoadShader` calcola `Fnv1a64(data, size)` sul bytecode ricevuto (`d3d12on11/src/pipeline.cpp:37`), ne formatta il testo (`:38`) e cerca `<hash>.cso` nella directory override (`:57`). L'override viene accettato solo se il container è DXBC legacy e il modello è al massimo SM5 (`:60`). Il dump salva gli stessi byte ricevuti (`:83`, `:85`).

Quindi il nome del `.cso` è calcolato dall'esatto container originale hashato dal proxy, non dall'HLSL candidato né da un contenitore estratto o normalizzato. `Fnv1a64` e `Hex64` sono stati verificati direttamente in `d3d12on11/src/util.cpp`: offset basis `14695981039346656037`, prime `1099511628211`, wrap uint64 e output lowercase zero-padded a 16 cifre. Il test locale controlla il vettore noto `"hello" → a430d84680aabd0b` e il nome output.

**Esito offline del 17/11/2026:** T-N2 ha confrontato quattro bytecode DXIL dumpati dal proxy; hash TypeScript e nomi/hash del proxy hanno coinciso in 4/4 casi. T-N3 ha usato il candidato compute `bb592abf5ce2bad1` (`cs_6_6`): Shader Lab 0.1.7 ha prodotto un `.cso` da 1288 byte, verificato come DXBC legacy senza chunk DXIL e modello `5_0`. Il test smoke isolato, ricompilato per richiedere esattamente `S_OK` e un PSO non nullo, è terminato con exit code 0; il log del proxy riporta `source=SM5-override`, `PSO COMPUTE ... status=ready`, `missing_mask=0x00` e `d11_cs=1`, senza errori di creazione o placeholder. Hela non è stato avviato.

Questi risultati verificano il naming e il caricamento/creazione del PSO per questa fixture; non verificano dispatch, completamento GPU, equivalenza semantica o rendering di Hela. Il `.cso` non è stato pubblicato nella directory override attiva e gli output restano in staging.

Gate offline obbligatori:

1. **T-N1:** vettori noti FNV-1a64 in TypeScript e test del formatter contro il formato del proxy.
2. **T-N2 — superato (4/4):** per quattro fixture DXIL, hash TypeScript uguale al nome/hash registrato dal proxy per gli stessi byte.
3. **T-N3 — superato per la fixture compute:** test smoke del proxy carica il `.cso` prodotto e nominato con l'hash TypeScript; il test richiede esattamente `S_OK` e un PSO non nullo.

T-N2 e T-N3 superati non dimostrano equivalenza o rendering. Gli artefatti restano candidati in staging; la pubblicazione nella directory attiva del proxy non è stata eseguita.

## 7. Staging, atomicità e cache futura

Ogni avvio usa una sottocartella `ShaderLab-Staging-<timestamp>` nuova, separata dall'input e senza sovrascrivere una destinazione preesistente. FXC scrive un temporaneo nella stessa directory; solo dopo exit code 0 e verifica del container viene creato atomicamente il link `<fnv1a64-originale>.cso`, poi rimosso il temporaneo. Errori prima del link eliminano il temporaneo.

Non esistono ancora manifest, cache o ripresa tra job. Per introdurli, la chiave dovrà includere almeno l'hash del byte originale, toolchain, profilo, entry point, buffer mode e binding map; riutilizzare output solo dopo aver verificato chiave e container. La pubblicazione nella directory attiva del proxy resta fuori dalla UI.

## 8. Test e criteri di accettazione

Il runner esistente è `npm test` (`package.json:10`); i test in `src/test.ts` coprono conversione/analisi, disassembly, post-processing, firme e monitoraggio (contenuto verificato).

Test aggiuntivi, offline, attualmente eseguiti con runner FXC simulato:

- **T-E1:** contatori del progresso aggiornati sullo snapshot.
- **T-S1:** file senza disassemblato bloccato; blocker rifiutato senza `force`; compile mock riuscita porta a `compiled`.
- **T-N1:** vettore noto FNV-1a64 e naming `<hash>.cso`.
- **T-A1:** errore FXC simulato non lascia `.cso` parziali visibili.
- **T-X1:** cancellazione dopo la snapshot è osservata prima del file o dopo la conversione, prima di FXC; nessun output parziale resta visibile.
- **T-P1:** caricamento dinamico ESM da CJS verificato con Node; JS host/webview passa `node --check`.
- **T-N2/T-N3:** superati offline il 17/11/2026 per quattro fixture hash e una fixture compute; smoke manuale isolato, non registrato come test CTest.
- **Da fare:** mutation dopo snapshot, cancel durante una fase esterna attiva, UI nel VS Code Extension Development Host, automazione del fixture smoke, cache.

Criteri misurabili:

- **A1:** tutti i fixture senza blocker e con metadati completi raggiungono `compiled` solo dopo FXC e verifica DXBC/SM5.
- **A2:** nessun file con blocker viene convertito automaticamente senza un'azione esplicita dell'utente.
- **A3:** la scrittura di override compatibili resta disabilitata finché T-N2 non passa.
- **A4:** non ancora applicabile; cache non implementata.
- **A5:** la cancellazione si propaga al primo checkpoint utile dopo la fase corrente; il tempo massimo è limitato dal timeout documentato del processo attivo finché non esiste terminazione mid-processo.
- **A6:** progress e percentuale usano sempre lo snapshot del job; non compare alcuna affermazione di copertura totale del gioco.

## 9. Roadmap incrementale

1. **Completato — Core e prima UI:** conversione condivisa, batch sequenziale, progress, stati, cancellazione cooperativa e staging atomico.
2. **Da fare — Runtime UI:** validare il flusso completo nel VS Code Extension Development Host con toolchain reale.
3. **Completato — Gate hash:** T-N2 (4/4) e T-N3 (fixture compute, esito esatto `S_OK`) verificano il matching e il caricamento nel proxy isolato; non attestano equivalenza o rendering.
4. **Da fare — Manifest e ripresa:** cache e riavvio controllato, dopo test della chiave.
5. **Da fare — Automazione smoke proxy:** rendere ripetibile tramite test runner il fixture usato da `d3d12on11_shader_override_smoke`; la prova manuale isolata è riuscita senza avviare Hela.

Ogni milestone è fail-closed rispetto ai propri prerequisiti; nessuna avvia Hela o genera traffico.

## 10. Rischi e prerequisiti aperti

- **Parità FNV e formato Hex64:** implementazione verificata in `util.cpp`; T-N2/T-N3 superati per i fixture indicati, ma non provano equivalenza né rendering.
- **Interop ESM/CommonJS:** import dinamico verificato con Node, non ancora nel runtime VS Code.
- **Progress:** l'extension host invia il progresso per file alla Webview; non dipende dal protocollo MCP.
- **Cancellazione:** `run()` non è interrompibile a metà processo nella v1; documentare il limite del timeout o implementare terminazione testata.
- **Toolchain e semantica:** FXC è Windows-only; il DXIL decompilato può non essere equivalente; limiti SM6/D3D11 e mappature vanno esposti all'utente.
- **Copertura:** il job enumera soltanto i file forniti; non scopre shader che non sono stati catturati o altrimenti resi disponibili.
- **Egress:** vincolo separato, non modificato da questa feature.
- **Riproducibilità:** includere versioni/commit toolchain nella chiave di cache.

## 11. Riferimenti e stato di verifica

Implementazione corrente: `src/dxil-precompile.ts`, `src/index.ts`, `src/hlsl-post.ts`, `src/test.ts`, `src/precompile-test.ts`, `vscode-extension/extension.js`, `vscode-extension/media/dashboard.js` e `vscode-extension/media/dashboard.css`. La base architetturale era `main` al commit `23b73f61cdd2a22fef6e5bbf109d8b280d5de3d8`; le modifiche descritte qui sono nel worktree locale e non sono incluse in quel commit.

Il formato hash è stato confrontato con `d3d12on11/src/util.cpp` e il nome output ha un test locale FNV-1a64. Test passati: `npm run build`, `npm test`, `node --check` per host e Webview, import dinamico ESM da CJS con Node e `git diff --check`. In aggiunta, T-N2 ha dato 4/4 hash coincidenti; la conversione reale della fixture `bb592abf5ce2bad1` è riuscita con Shader Lab 0.1.7 e T-N3 ha creato il PSO nel proxy isolato con controllo stretto `S_OK`. I test batch con toolchain simulata non attestano una conversione reale; il caricamento smoke non prova dispatch, completamento GPU, compatibilità visiva, equivalenza semantica o funzionamento in Hela. Hela non è stato avviato.
