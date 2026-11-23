# Hela / Shader Lab — completamento del ciclo: gap, architettura, primo slice


Proposta via BridgeCode. Stato: non applicata. Questo changeset crea solo file nuovi:
non modifica il proxy, non avvia Hela, non installa DLL/override attivi, non genera traffico.
0. Perimetro, vincoli, onestà dello stato
Vincoli rispettati: nessun lancio di Hela; nessuna installazione di DLL/override attivi;
nessun traffico; nessun uso di log Sentry, payload, DSN o network capture; nessun verdetto
"menu corretto" basato su compilazione, PSO ready, Present o pixel non neri.
Il pre-menu osservato in passato non ha readback BMP validi: il menu resta da verificare.
L'enforcement egress non è provato: resta un limite residuo (§6); proposta di prova statica in §1 (P1-3).
Gli estratti dei file esistenti (commands.cpp, pipeline.cpp, hela-pipeline.ts,
ProxyManager.ps1) non erano inclusi nella delega. Il protocollo richiede contenuto
completo per file: per non sovrascrivere codice ignoto, questo changeset non tocca i file
esistenti; le loro modifiche sono specificate come change-spec (§3.3), da applicare in un
passo successivo con i contenuti reali.
I percorsi dei file nuovi sono proposti in cartelle isolate (docs/, tools/hela-package/)
per evitare collisioni; BridgeCode può rimapparli.
1. Gap tecnici
P0 — bloccano il ciclo o falsano le evidenze
ID

Gap

Motivazione


P0-1

Package candidato incompleto rispetto al contratto ProxyManager

build_hela_override_stage produce staging, ma il contratto di ProxyManager è congiuntivo: runtime\d3d12.dll + runtime\dxgi.dll + inventario override esattamente corrispondente al manifest. Un anello mancante produce load falliti o, peggio, sottoinsiemi silenziosi (comportamento ibrido non riproducibile) che invalidano ogni evidenza raccolta nella run. Serve un gate atomico di completezza + corrispondenza, con esito staged-only.


P0-2

Correlazione draw→backbuffer basata su puntatori e coppie diagnostiche

I puntatori sono effimeri: riuso degli allocatori e indirizzi riciclati dopo release rendono ambigua l'identità delle risorse tra frame. Senza ID stabili (generazionali) e senza ordine temporale (frame index, command list ordinal, fence/timeline) tra draw, copy e readback, non si può dimostrare che il BMP derivi dalla draw con gli override attivi. Rischio concreto: falso positivo "menu" da pixel non neri di un'altra catena (clear, UI legacy, frame precedente).


P0-3

Evidenze di run non collegate

manager-run.json, report monitor, manifest, log e BMP non condividono un run-id né hash reciproci. Impossibile distinguere configurazione richiesta, override effettivamente caricati, target di readback ed evidenza visiva. Senza bundle con classi di evidenza separate, il verdetto di default deve essere menu: unverified.
P1 — rafforzano il ciclo dopo i P0
ID

Gap

Motivazione


P1-1

Validazione grafica oltre la conversione shader

DXIL→HLSL→SM5 prova solo il compilabile. Il proxy richiede correttezza di risorse (dimensioni/formati/mip), binding (root signature ↔ reflection DXIL, slot/space/ranges), sincronizzazione e barriere (state tracking, transizioni prima di copy/readback, UAV barrier). Servono gate offline statici separati (reflection + analisi statica del proxy) e test GPU separati e autorizzati: i due livelli non vanno confusi.


P1-2

Verifica run incompleta lato harness

Anche con bundle completo servono scene note deterministiche (seed, stato di gioco), checklist menu esplicita e confronti con baseline. Present raggiunto o pixel non neri restano evidenza di catena, non di menu funzionante.


P1-3

Enforcement egress non provato

Oggi è un'affermazione, non un test. Proposta compatibile coi vincoli: gate statico sugli import dei DLL proxy (winhttp/wininet/ws2_32/dnsapi) + scansione sorgenti per endpoint/DSN/client HTTP. Nessuna cattura di rete, nessun traffico. Limite: il caricamento dinamico via GetProcAddress evade la import-table; copertura completa solo con harness autorizzato futuro.


P1-4

Allineamento hash gate ↔ loader

Il gate usa SHA-256 hex lowercase; algoritmo e normalizzazione in pipeline.cpp non sono verificabili senza estratti. Un disallacciamento rende inaffidabili i confronti hash tra offline e load: va allineato prima di fidarsi della corrispondenza.
P2 — qualità e riproducibilità
P2-1: pin delle versioni toolchain (dxc/SM5), hash degli strumenti nel manifest, packaging
deterministico (ordinamento stabile, timestamp esclusi dagli hash).
P2-2: report markdown generato dal bundle di run, retention e diff tra run.
P2-3: CI offline dei gate (node --test, validazione schema) senza GPU e senza rete.
P2-4: tassonomia errori azionabile e messaggi di rifiuto atomico coerenti tra gate e ProxyManager.
2. Architettura incrementale
Stadi e gate: ogni stadio produce artefatti verificabili; nessuno stadio successivo è implicito.
convert (esistente) — DXIL→HLSL→SM5. Gate G0 offline: compile + reflection sanity.
stage (esistente, build_hela_override_stage) — staging directory.
package (questo slice) — gate G1 offline: runtime DLLs presenti e dichiarate;
inventario ≡ manifest (biiezione path/id + hash); path safety; nessun file extra.
Output: override-inventory.json, package-report.json con lifecycle: "staged-only".
authorize (futuro, manuale, fuori banda) — promozione staged→authorized con
registrazione esplicita di scope/ambiente. Nessun automatismo in questo changeset.
run (futuro, autorizzato) — ProxyManager carica; run-id comune; loader log con hash;
timeline risorse (P0-2); readback BMP della catena verificata.
verify (futuro) — G2 offline sul bundle (schema + hash incrociati) e G3 GPU/visuale
(checklist menu, scene note). Verdetto composito per classi di evidenza.
Confine netto: G1 non dimostra nulla sul runtime; G2 non dimostra il menu; solo G3 con
criteri espliciti può sostenerlo.
3. Primo vertical slice
3.1 File nuovi (questo changeset)
tools/hela-package/package-gate.mjs — gate G1 + CLI (build / --check), zero dipendenze, solo fs + crypto.
tools/hela-package/package-gate.test.mjs — test offline con node:test (tmpdir; DLL fittizie come byte, mai caricati).
tools/hela-package/run-evidence.schema.json — contratto del bundle di run (P0-3); design artifact, non ancora enforced dal codice.
docs/hela-cycle-plan.md — questo documento.
3.2 Contratti dati e stato
candidate-package.json (manifest, nuovo contratto):
{ schemaVersion: 1, packageId, runtime: [{path, sha256?, bytes?}], overrides: [{id, path, sha256?, bytes?}] }.
Path relativi normalizzati /, override sotto overrides/, hash hex lowercase.
Nota di integrazione: lo staging attuale potrebbe emettere un manifest con nome/shape
diversi (non verificabile senza estratti); il wiring in hela-pipeline.ts deve emettere
questo contratto tramite adapter, oppure il gate si usa standalone su staging che lo adotta.
override-inventory.json (generato): {schemaVersion, packageId, overrides: [{id, path, sha256, bytes}]}
ordinato per path, deterministico, scritto solo se il gate passa; rimosso se un gate
successivo fallisce (mai inventario stale consumabile).
package-report.json: esito, issues/warnings con codici, hash di manifest/inventario/runtime,
lifecycle: "staged-only", installed: false, networkUsed: false sempre.
Stati del ciclo: converted → staged → packaged-staged → (authorized) → run → verified.
packaged-staged è distinto da qualunque stato che implichi prontezza runtime.
Bundle di run (schema): runId comune; package (manifest/inventory/report + hash),
configuration (manager-run + override richiesti), loadedOverrides (loader log + esiti
loaded/skipped/failed), readback (BMP + targetResourceId + frameIndex + copyChainRef),
visual (menuChecklist, default null), verdict.menu default unverified. Lo schema vieta
verified-with-checklist senza readback ≥ 1, checklist tutta pass e override caricati ≥ 1.
3.3 Change-spec per i file esistenti (follow-up, NON in questo changeset)
Da applicare solo dopo aver ricevuto i contenuti reali; i nomi interni sono ipotesi da verificare.
hela-pipeline.ts:
import di runPackageGate da tools/hela-package/package-gate.mjs (percorso da adattare);
dopo il successo di build_hela_override_stage, await runPackageGate(stagingDir, {mode:"build"});
estendere lo stato pipeline con packageGate: {ok, reportPath, inventoryPath, issues} e un
nuovo stato terminale packaged-staged;
la pipeline fallisce se il gate fallisce; nessuna invocazione di ProxyManager, nessuna copia
fuori staging, nessun processo figlio.
pipeline.cpp:
allineare l'hash override a SHA-256 hex lowercase (stesso del gate); se oggi usa altro
algoritmo, aggiungere il campo sha256 senza rimuovere quello esistente (compatibilità);
log strutturato JSONL per decisione di load:
{runId, id, path, expectedSha256, actualSha256, result: loaded|skipped|failed} —
è la fonte di loadedOverrides del bundle (configurazione richiesta ≠ override caricati);
rifiuto atomico: se un override richiesto fallisce hash/presenza, marcare la run
override-set-incomplete invece di caricare un sottoinsieme silenzioso (policy da
confermare con ProxyManager).
commands.cpp:
StableResourceId { uint64 index; uint32 generation; } assegnato alla creazione risorsa;
mappa void* → StableResourceId con invalidazione su release/destroy, per eliminare
l'ambiguità da riuso dei puntatori;
eventi JSONL taggati:
{runId, frameIndex, clOrdinal, queue, fenceValue, op: draw|copy|readback, src, dst};
catena draw→copy→readback valida solo se gli ID coincidono lungo la catena e l'ordine
temporale (fence/timeline) è monotono; il BMP referenzia targetResourceId + copyChainRef;
sola osservabilità: nessuna modifica al comportamento GPU.
ProxyManager.ps1:
prima di qualunque load, verificare che override-inventory.json corrisponda esattamente
al manifest (stessa regola del gate: biiezione path/id, hash uguali, runtime DLLs presenti)
e che package-report.json.ok == true; rifiuto atomico con messaggio azionabile;
nessuna modifica che installi o avvii nulla ora: resta specifica.
3.4 Test minimi (offline, verificabili)
normalizeRelPath: normalizza backslash; rifiuta .., assoluti, drive letter, segmenti vuoti/./NUL.
Happy path: inventario generato e ordinato, lifecycle staged-only, installed/networkUsed false, check-mode ok.
Runtime DLL mancante → MISSING_RUNTIME, nessun inventario consumabile, report scritto con ok:false.
Hash diverso dal manifest → HASH_MISMATCH.
File extra in overrides/ → INVENTORY_EXTRA.
Override dichiarato ma assente → MISSING_OVERRIDE.
Path non sicuro / location invalida → UNSAFE_PATH, INVALID_OVERRIDE_LOCATION.
Determinismo: due build → inventario identico byte-per-byte.
Gate fallito dopo build ok → inventario stale rimosso (staleInventoryRemoved:true).
Check-mode su inventario manomesso → INVENTORY_MISMATCH.
Check-mode senza inventario → INVENTORY_MISSING, read-only (nessun file scritto).
Runtime richiesto non dichiarato → RUNTIME_NOT_DECLARED.
Id/path duplicati → DUPLICATE_ID, DUPLICATE_PATH.
Manifest assente → MANIFEST_MISSING; package senza override → ok con warning EMPTY_OVERRIDES;
smoke dello schema run-evidence (parse + guardrail sul verdetto menu).
3.5 Criteri di accettazione
node --test tools/hela-package/ verde, offline, senza GPU, senza processi figli, senza rete.
Corrispondenza inventario/manifest verificata in entrambe le direzioni (build + check);
fallimento atomico: nessun output parziale marcato ok, nessun inventario stale left behind.
Nessun file scritto fuori dalla staging dir; nessun percorso di gioco/proxy toccato.
package-report.json.lifecycle === "staged-only" sempre; nessun claim di install o di menu.
Doc e schema dichiarano il menu non verificato di default.
4. Tassonomia delle prove (distinzione netta)
Classe

Esempi

Cosa dimostra

Cosa NON dimostra


Offline (questo slice)

compile SM5, reflection, gate package G1, hash, corrispondenza inventario/manifest, schema bundle, scan statico import-table (P1-3)

artefatti completi, coerenti, riproducibili

qualunque comportamento runtime; il menu


Native del proxy (richiede autorizzazione; non in questa patch)

loader log con hash verify, resource-ID timeline draw→copy→readback, validation layer/barriere, catena fino a Present

che il proxy carica gli override previsti ed esegue la catena senza errori

correttezza visiva; menu funzionante


GPU / visuale (richiede autorizzazione + harness; non in questa patch)

BMP della catena verificata, scene note deterministiche, checklist menu, confronto baseline con tolleranze

(solo con criteri espliciti) menu funzionante

nulla oltre i criteri testati
Regola di verdetto: compilazione, PSO ready, Present raggiunto o pixel non neri producono al
più evidenza offline/native/readback. Il verdetto menu resta unverified finché una checklist
esplicita (elementi attesi, ed eventualmente interazione) non passa su readback della catena verificata.
5. Cosa resta in staging fino ad autorizzazione runtime
L'intero package (runtime DLLs, overrides, inventario, report) resta nella staging dir.
Nessuna copia verso directory di gioco/proxy, nessun caricamento, nessun avvio: il changeset
non contiene codice di install né di promozione.
La promozione avverrà solo tramite un passo authorize manuale futuro, con registrazione
esplicita di scope e ambiente; fino ad allora ogni artefatto è staged-only.
6. Limiti residui e rischi
Menu non verificato: il pre-menu storico non ha BMP validi, quindi non esiste baseline visiva.
Egress enforcement non provato: la proposta statica (import-table + scan sorgenti) non copre
il caricamento dinamico (GetProcAddress); nessuna network capture è ammessa dai vincoli.
Estratti dei file esistenti non forniti: le change-spec §3.3 sono ipotesi da validare sul
codice reale; rischio di disallacciamento di nomi/strutture.
Falso senso di sicurezza: package completo (G1) è necessario ma non sufficiente; shader
semanticamente errati possono superare tutti i gate offline.
Hash drift gate ↔ pipeline.cpp: algoritmo/normalizzazione del loader ignoti; allineare (P1-4)
prima di fidarsi dei confronti.
Determinismo GPU (driver, timing, stato di gioco): i test visuali richiederanno seed/scene
note e tolleranze; non inclusi in questo slice.
Path Windows/POSIX: normalizzazione esplicita nel gate, ma il wiring reale va verificato su
entrambi gli ambienti.
Promozione accidentale dello staging: mitigata dal marker staged-only, dall'assenza di
codice di install e dalla rimozione dell'inventario stale; l'autorizzazione resta fuori banda.
7. Esecuzione dei test e della CLI
node --test tools/hela-package/
node tools/hela-package/package-gate.mjs <stagingDir>          # build (scrive solo in staging)
node tools/hela-package/package-gate.mjs <stagingDir> --check  # verifica read-only
Node >= 18 (consigliato >= 20). Exit code CLI: 0 = ok, 1 = gate fallito, 2 = uso/IO.
I test usano byte fittizi per le DLL: nessun file viene mai caricato come libreria.
