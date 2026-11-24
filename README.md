# sm6-to-sm5-mcp

Server MCP per VS Code (Copilot Agent mode / qualsiasi client MCP) che aiuta a portare shader
**HLSL Shader Model 6.x → Shader Model 5.0**, per un backend **D3D11** al posto di D3D12.

## Installazione

```bash
npm ci
npm run build
npm test          # include test offline del job di precompilazione (FXC simulato)
npm run test:hela-package # gate offline di package Hela, senza DLL reali/rete
```

Apri la cartella in VS Code: `.vscode/mcp.json` è già pronto. Avvia il server da
*Comando: "MCP: List Servers" → sm6-to-sm5 → Start*, poi usa la chat in **Agent mode**.
Per usarlo in un altro workspace copia il blocco `servers` nel tuo `.vscode/mcp.json`
(con il percorso assoluto di `dist/index.js`).

## Dashboard laterale VS Code

Il progetto include anche `vscode-extension/`, un'estensione UI separata che aggiunge
MCP Dashboard alla Activity Bar con le schede **Shader Lab** e **Cattura PIX**. Per provarla:

1. Compila il server MCP con `npm ci` e `npm run build` dalla cartella principale.
2. Apri in VS Code la cartella principale `sm6-to-sm5-mcp`, così viene caricata la
   configurazione workspace `.vscode/mcp.json`.
3. Avvia `MCP: List Servers` → `sm6-to-sm5` → `Start Server`.
4. Installa il VSIX Shader Lab generato per questa versione oppure esegui
   `F5` nella cartella `vscode-extension/` per usare l'Extension Development Host.
5. Apri Shader Lab dalla Activity Bar e usa Copilot Chat in modalità Agent.

Il dashboard usa la configurazione MCP utente di VS Code (`User/mcp.json` o quella del profilo attivo);
il file workspace `.vscode/mcp.json` serve invece per avviare il server dal workspace. In caso di
percorso server memorizzato obsoleto, la root ricavata dal server effettivamente configurato nel profilo
ha priorità sul valore locale salvato dall'estensione.

Le azioni di analisi/conversione esistenti selezionano gli input e preparano una richiesta per il tool MCP
corrispondente in Copilot Chat. **Precompilazione DXIL locale** è invece un job posseduto dall'extension host:
seleziona una cartella di input, una base di staging separata e una mappa binding JSON opzionale, poi mostra
avanzamento e permette l'annullamento cooperativo. Gli output `.cso` sono scritti in una nuova sottocartella
`ShaderLab-Staging-*` e nominati con FNV-1a64 dei byte del container DXIL originale, come nel proxy.
File senza disassemblato, stage non riconosciuto, blocker SM6, entry point non identificato o register space
senza mappa non vengono compilati. FXC conferma solo la compilazione: non l'equivalenza, la compatibilità
della firma PS con il VS abbinato o il rendering. Gli output restano staging; la UI non li pubblica negli
override attivi e non avvia il gioco.

Il pill mostra se il server è compilato e associato al profilo; il controllo Live osserva il log MCP della finestra,
ricava l'ID completo usato da VS Code e apre le stesse opzioni server di
**MCP: List Servers** per `sm6-to-sm5`. Le righe di connessione aggiornano il pallino
senza aprire pannelli; se il log non esiste ancora, il primo clic apre l'elenco MCP.
La lettura dipende dal formato dei log della versione VS Code installata.

## Strumenti esterni (opzionali)

| Strumento | Serve per | Impostazione |
|---|---|---|
| `fxc.exe` (Windows SDK) | `compile_sm5` e precompilazione locale: compilazione reale SM5 | `FXC_PATH` (auto-rilevato su Windows) |
| `pixtool.exe` (PIX) | Analisi PIX completa ed export locale | Auto-rilevato o selezionato nella scheda Cattura PIX |
| `dxc.exe` (Windows SDK) | Disassemblaggio e analisi dei payload PIX | Auto-rilevato o selezionato nella scheda Cattura PIX |
| PowerShell | Decompressione locale dei payload PIX | PowerShell di Windows o percorso selezionato nella scheda |
| `dxil-spirv` | `dxil_to_sm5_hlsl` (shader senza sorgente) | `DXIL_SPIRV_PATH` |
| `spirv-cross` | idem | `SPIRV_CROSS_PATH` |

Non sono incorporati percorsi assoluti specifici di una workstation. Su ogni Windows Shader Lab
prova a rilevare PIX, DXC e PowerShell localmente; nella vista dedicata **Cattura PIX** si possono
selezionare gli `.exe` installati e salvare gli override nel profilo VS Code dell'utente.
Gli override non vengono condivisi con altri PC né scritti nel repository. `dxil-spirv` e
`spirv-cross` restano configurabili con le variabili MCP indicate sopra.

`check_toolchain` mostra cosa è raggiungibile. Le opzioni CLI di dxil-spirv possono cambiare
tra versioni: se il tool fallisce, controlla `dxil-spirv --help`.

## Tool MCP

- `analyze_shader` / `analyze_directory`: HLSL sorgente, report bloccanti / avvisi / correzioni automatiche.
- `analyze_dxil`: analisi statica di **DXIL compilato** (`.dxil` + disassemblato DXC): stadio, binding, register space, wave/64-bit/barycentrics/DXR/mesh, limiti D3D11, verdetto.
- `convert_shader` / `convert_directory`: riscrittura SM6→SM5 + `binding_map.json`.
- `compile_sm5`: compila con FXC per confermare che l'output è valido.
- `validate_pair`: confronta le firme output/input di un `.cso` VS e un `.cso` PS tramite `fxc /dumpbin`, verificando semantiche, maschere e tipi e restituendo PASS/FAIL.
- `dxil_to_sm5_hlsl`: DXIL → SPIR-V → HLSL 5.0 + post-processing (registri duplicati, register space, base instance, semantiche dei vertex input, entry point e `[numthreads]` compute ripresi dal disassemblato). Per un PS, `vsOutputDisasmPath` applica le semantiche della firma output del VS abbinato. Si ferma se l'analisi trova bloccanti. Output = *candidato*, da validare con fxc.
- `analyze_pix_capture`: `mode=scan` ispeziona il `.wpix` in sola lettura e con limiti espliciti; `mode=full` usa pixtool, estrae PSO e payload shader, li disassembla con DXC e salva report/manifest nella cartella scelta. La modalità completa può avviare un replay/export PIX, non modifica la cattura originale e non esegue il C++ generato.
- `list_pix_events`: esporta l'event list non filtrato con pixtool o legge un CSV/TSV locale; supporta paginazione, filtro sul nome e filtro esatto per il `Queue ID` di una singola riga. `Queue ID` non identifica la queue.
- `export_pix_draw_resource`: verifica che il `Global ID` identifichi una sola draw event e che la stessa riga abbia il `Queue ID` richiesto prima di invocare `save-resource`. Non esporta se l'identificazione è ambigua, il Queue ID non coincide o la riga non è una draw.
- `check_toolchain`.

### Integrazione con il proxy Hela

- `inspect_hela_proxy_log` analizza in sola lettura i log del proxy e separa shader/PSO, draw e readback; le correlazioni draw→backbuffer restano candidate e non sono una prova causale.
- `build_hela_override_stage` riusa la pipeline DXIL→HLSL→FXC e scrive solo in una nuova cartella di staging. Con un manifest baseline richiede tutti gli override baseline e ne verifica gli SHA-256; non installa file e non avvia Hela.
- Se `runtimeDir` è indicato al tool di staging, Shader Lab copia in staging `d3d12.dll` e `dxgi.dll`, aggiorna gli hash runtime solo nel manifest candidato, genera `candidate-package.json` ed esegue il gate offline `tools/hela-package/package-gate.mjs`. Il manifest baseline resta invariato; il gate verifica runtime/override, scrive `override-inventory.json` e `package-report.json` e mantiene sempre `lifecycle: staged-only`.
- `plan_hela_manifest_patch` produce un manifest candidato separato, preservando gli override baseline e rifiutando percorsi esistenti o protetti.
- `verify_hela_run` legge una run archiviata, usa il contatore readback per il target richiesto e considera solo BMP nominati per quel `Present`. Pixel non neri non dimostrano che il menu sia corretto: `menuValidated` rimane sempre `false`.
- `build_hela_run_evidence` collega offline package, manifest, run, log e BMP in una nuova cartella, applicando il package gate staged-only. Mantiene il verdetto menu `unverified`; non avvia Hela o non installa DLL/override.

## Catture PIX

La scheda **Cattura PIX** nel dashboard consente di scegliere il `.wpix`, la cartella di output,
un export C++ già esistente o l'export automatico con pixtool, e un event list PIX già esportato.
Include anche azioni per cercare eventi nell'event list ed esportare il render target di una draw.
Gli eseguibili sono rilevati sul PC corrente o collegati con i selettori nativi di VS Code.
La configurazione è per utente, quindi installare il plugin su un altro Windows non riutilizza
percorsi assoluti della workstation originale.

La modalità `scan` resta read-only: legge header e blocchi limitati, non decodifica il formato e non avvia PIX/pixtool. La modalità `full` scrive gli artefatti solo nella cartella selezionata; l'analisi dei payload è statica e non dimostra equivalenza visiva o compatibilità runtime D3D11. I marker `GFXA`/`GFXB`/`GFXC` e `DXBC` trovati dalla scansione non sono prova di chunk, PSO o shader. Pixtool esporta l'event list senza filtro queue; il `Queue ID` identifica la riga/evento nella queue, non la queue stessa. La label (per esempio `Graphics Queue 1`) resta un'attestazione visiva dell'utente e un event list manuale non prova la propria cattura o queue di origine. Prima di `save-resource`, il gate richiede una singola riga con `Global ID`, `Queue ID` coincidente e nome di evento draw.

## Cosa converte automaticamente

- `[shader("...")]`, `[WaveSize]`, `[[vk::...]]` rimossi
- `register(x, spaceN)` → slot univoci (con mappa dei binding da riportare nel C++)
- `ConstantBuffer<T>` → `cbuffer`
- `float16_t/uint16_t/int16_t` → `min16float/min16uint/min16int`
- `NonUniformResourceIndex(x)` → `x`
- `select(c,a,b)` → `c ? a : b`
- `dot4add_*8packed`, `dot2add` → funzioni helper di emulazione
- Negazioni unarie di scalari `uint` generati da SPIRV-Cross → sottrazione unsigned modulo 2^32 (evita warning FXC senza cambiare il risultato).

## Cosa NON è convertibile (viene segnalato come bloccante)

Wave/Quad intrinsics, DXR (ray tracing), mesh/amplification shader, `ResourceDescriptorHeap`,
interi/atomiche 64-bit, `SV_ViewID/Barycentrics/ShadingRate`, `GetAttributeAtVertex`,
`pack_*/unpack_*` 8-bit, `SampleCmpLevel/Bias/Grad`, feature HLSL 2021 (template, operator, ...),
array di risorse unbounded.

## Limiti da conoscere

1. **Gli shader sono solo una parte**: il gioco deve avere (o avere un wrapper con) un backend D3D11.
   Root signature, descriptor heap, barrier, command list e PSO non sono toccati da questo plugin.
2. Il converter lavora a livello di **sorgente testuale** (regex + parsing delle parentesi), non su un
   AST completo. `#include` e macro non vengono espansi: preprocessa prima (`fxc /P`, `dxc -P`).
3. I tipi `min16*` su D3D11 sono solo hint: la precisione può differire dall'originale a 16 bit nativi.
4. Limiti D3D11 non verificati automaticamente: 32 KB di groupshared, 8 UAV (pixel/compute 64 con FL11.1),
   dimensione dei cbuffer. `compile_sm5` ne intercetta alcuni.
5. La pipeline DXIL→HLSL produce codice decompilato: nomi persi, register derivati dai binding SPIR-V.
6. La precompilazione in batch richiede i disassemblati DXC associati ai file DXIL. La cancellazione è cooperativa e attende il processo esterno attivo; i test automatici simulano FXC e non provano il caricamento dal proxy.
7. `compile_sm5`, la precompilazione locale e il rilevamento automatico di fxc funzionano su Windows; su Linux/macOS serve Wine o un fxc esterno.
8. Testati: analyzer, converter, protocollo MCP, test offline del job con runner simulato e rigenerazione/validazione FXC dei campioni Hela.
   In questa workstation i due convertitori sono installati e configurati nel profilo MCP.

## Versioni usate nei test (vedi `samples/REPORT_Hela_samples.md`)

dxil-spirv commit `788f3e22968ee79d145a680279531389b439cb96` (`--ssbo-srv --ssbo-uav`), SPIRV-Cross commit
`57e4efcc84112abcd426dc5ec248b5339bee04f2` (`--hlsl --shader-model 50`), DXC v1.8.2505.1
(disassemblati forniti) e FXC del Windows SDK `10.0.26100.0`. Risultati per campione in
`samples/REPORT_Hela_samples.md`.
Con `bufferMode: "typed"` i buffer restano `Buffer<uint4>` in stile Vulkan: sconsigliato per D3D11.

## Stato dello Step 2 (proxy D3D12→D3D11) — PROTOTIPO PARZIALE

`d3d12on11/` compila ora due proxy Windows x64, `d3d12.dll` e `dxgi.dll`. Il livello D3D12 crea
un device D3D11, traduce risorse committed di base, heap descriptor e un sottoinsieme di command
list/queue; supporta root signature, binding e PSO quando gli shader sono DXBC SM5 o esistono
override `.cso` corrispondenti. Il livello DXGI inoltra le factory e crea wrapper per le swapchain,
inclusi `GetBuffer`, `Present`, `ResizeBuffers` e `ResizeBuffers1`. Gli altri export DXGI vengono
inoltrati alla DLL di sistema.
`GetTimestampFrequency` e `GetClockCalibration` sono implementati tramite query timestamp D3D11 e
QPC; la frequenza e' verificata con una query disjoint e memorizzata. La calibrazione e' una
correlazione best-effort tra il timestamp GPU e il campione QPC acquisito all'invio della query,
non una sincronizzazione hardware nativa dei clock D3D12.
Per il test del bootstrap, `D3D12CreateDevice` accetta richieste fino a feature level D3D12 12_0
e `CheckFeatureSupport(FEATURE_LEVELS)` riporta 12_0 anche se il backend sottostante è D3D11
11_0/11_1. Questa concessione sperimentale serve al bootstrap diagnostico e non implica che tutte
le feature D3D12 di livello 12_0 siano implementate; le capability non tradotte restano disattivate.
Hela richiede Shader Model 6.7, quindi il bundle locale la dichiara per superare il controllo iniziale.
È un'indicazione di compatibilità diagnostica: non aggiunge supporto SM6.7 al backend D3D11 e ogni
shader DXIL resta inutilizzabile senza un override SM5 valido.
Il proxy esporta inoltre `D3D12CreateDevice` e `D3D12GetDebugInterface` con gli ordinali attesi
dalle app e inoltra al runtime di sistema le due API di serializzazione delle root signature.

I test automatici coprono il dispatch compute con binding CBV/SRV/UAV e root constants, la
creazione di command signature e l'esecuzione di dispatch indiretti senza count buffer, copie
texture e readback, incluso upload/readback con placed footprint (`R32_UINT` e
`R8G8B8A8_UINT`) e copie parziali multi-riga tramite box in entrambe le direzioni, inclusi offset
di destinazione nel readback; una draw graphics SM5 su swapchain nascosta; creazione/query delle
factory DXGI; e il ciclo `GetBuffer` → `Present` → `ResizeBuffers`. Build e test su Windows:

```powershell
cmake -S d3d12on11 -B d3d12on11/build -A x64
cmake --build d3d12on11/build --config Release
ctest --test-dir d3d12on11/build -C Release --output-on-failure
```

`d3d12on11_queue_clock_smoke` verifica la frequenza, due campioni GPU/CPU monotoni e la gestione
dei puntatori nulli nelle API di clock.

Per i primi test con un'applicazione, il proxy registra le chiamate non implementate come
`UNIMPL`, i fallimenti di creazione delle risorse/PSO e il flusso di selezione degli shader nel file
`d3d12on11.log` accanto alle DLL. Se quella cartella non è scrivibile, usa
`%TEMP%\d3d12on11_<pid>.log`; il percorso scelto è scritto all'inizio del file. Le righe `SHADER`
riportano stadio, hash, formato e dimensione del bytecode, override cercato, eventuale dump DXIL e
risultato della creazione dello shader D3D11. `PSO ... BEGIN/READY/FAILED` delimita la creazione delle
pipeline. Un `SHADER BLOCKED ... no-usable-SM5-bytecode` indica uno shader da convertire o un override
assente/non valido; il file `.dxil` dumpato può essere passato agli strumenti `analyze_dxil` e
`dxil_to_sm5_hlsl` dello Shader Lab. Se il log non contiene `PSO ... BEGIN`, l'applicazione si è
fermata prima di richiedere la creazione di una pipeline e non è ancora possibile stabilire quali
shader restano da convertire. Il proxy non compila DXIL automaticamente: ogni shader DXIL necessita
di un override SM5 valido. Con `diagnostic_render_trace=1`, il proxy emette periodicamente
`[SHADER_USE_SUMMARY]`, `[DRAW_SHADER_USE]` e `[COMPUTE_SHADER_USE]`: registra i draw graphics con
gli hash VS/PS/GS/HS/DS e i dispatch compute con l'hash CS, raggruppati per esito, maschera degli
stadi mancanti e, per i draw, presenza del PSO graphics e RTV del backbuffer. I conteggi sono comandi:
uno `ExecuteIndirect` saltato è pesato con `maxCommandCount`, come il percorso eseguito che conta ogni
comando. La tabella traccia al massimo 512 gruppi complessivi e ogni riepilogo stampa al massimo 64
gruppi, dando precedenza a gruppi saltati o con stadi mancanti e riportando separatamente draw/dispatch
in overflow o omessi. Ogni riepilogo copre la finestra dall'heartbeat precedente; i contatori Present
restano process-wide: `present_calls_process_wide` e gli intervalli
`first/last_observed_present_count_process_wide` non sono identificatori di frame. La telemetria registra
i comandi osservati dal proxy ma non dimostra che uno shader abbia contribuito visivamente all'immagine.
Le chiamate `ExecuteIndirect` rifiutate per range non valido o backing resource indisponibile producono
log di errore ma nessun record shader, perché il proxy non emette quei comandi.
Le risposte `CheckFeatureSupport` riportano nomi, valori ed HRESULT nel log.
Il proxy traduce in modo limitato texture 2D reserved con layout 64 KB undefined-swizzle e buffer reserved
row-major, tile pool e mapping/copy delle tile via D3D11.2. Per i buffer tiled il backing D3D11 puo' essere
piu' piccolo della larghezza virtuale D3D12: il comportamento di tiling/mapping resta da validare sui driver.
L'implementazione corrente abilita questo percorso solo con D3D11 Tiled Resources Tier 2,
`ID3D11Device2` e `ID3D11DeviceContext2`, e riporta al massimo D3D12 Tiled Resources Tier 1. Un tier D3D11
inferiore causa `E_NOTIMPL`; non rimuovere il controllo senza verificare che le API D3D11 sottostanti
soddisfino le semantiche richieste. Texture 3D tiled e gli altri tier restano non supportati.
La V8 aggiunge diagnostica per le root SRV/UAV, limita le viste root alla larghezza del backing nativo
e rimuove i binding UAV/SRV precedenti quando un descriptor non è valido. Le viste raw sono rifiutate
se il backing non supporta `BUFFER_ALLOW_RAW_VIEWS`; le viste structured su risorse tiled sono rifiutate
finché dimensioni, mapping e copie non siano validati. Queste protezioni non rendono equivalente un
backing ridotto al buffer virtuale D3D12 e non costituiscono supporto completo per Hela.
`CreatePlacedResource` supporta risorse non multisample con allineamento e intervallo validi su heap
single-node; ogni risorsa riceve però backing D3D11 separato. Gli intervalli attivi sovrapposti sono rifiutati:
non sono implementati aliasing né backing condiviso dell'heap, e le risorse placed non equivalgono a heap
placement nativo.
`CreateCommandSignature` e `ExecuteIndirect` supportano una sola operazione indiretta di dispatch/draw
per signature, senza argomenti root e senza count buffer; restano non supportate le altre forme di
argomento indiretto.
`D3D12_FEATURE_FORMAT_SUPPORT` interroga il device D3D11 sottostante e converte i flag di supporto
formato; i flag D3D11 senza equivalente D3D12 sono esclusi e il supporto2 non disponibile resta a zero.
Per isolare il percorso NVAPI durante un test diagnostico, l'ambiente `D3D12ON11_DIAGNOSTIC_MASK_NVIDIA=1`
maschera il vendor dell'adapter NVIDIA nelle descrizioni DXGI; il vendor predefinito esposto è Microsoft
(`0x1414`), sostituibile per prove con `D3D12ON11_MASK_VENDOR_ID` (valore esadecimale, ad esempio
`FFFF` o `0`). La creazione del device continua a usare l'adapter D3D11 NVIDIA reale. Sono prove
temporanee, non impostazioni di compatibilità; i log riportano vendor/device ID nativi, vendor esposto
e l'adapter nativo passato alla creazione del device.
Per tracciare il modulo chiamante di alcune API D3D12, impostare `trace_callers=1` in
`d3d12on11.ini` oppure `D3D12ON11_TRACE_CALLERS=1` nell'ambiente del processo. Le righe `TRACE`
riportano API, modulo, RVA e thread nel log e in `OutputDebugString`; l'opzione è disattivata per default.
Il proxy espone anche `ID3D12Device1` e `ID3D12Device2`, richiesti dal controllo iniziale
dell'adapter D3D12 di Hela; questo non implica il supporto completo delle API aggiunte da tali
interfacce. I metodi non tradotti continuano a restituire `E_NOTIMPL` e sono registrati come `UNIMPL`.
L'opzione temporanea `diagnostic_capabilities=1` forza Resource Binding Tier 3, Tiled Resources Tier 3,
Wave Ops e atomiche Int64 su risorse tipizzate per verificare se il gioco supera il controllo iniziale.
È una simulazione deliberata di capability non implementate: usarla solo in test, poi riportarla a `0`;
non distribuirla né considerarla compatibilità reale. `ResourceBarrier` di transizione è ancora ignorato e viene segnalato. Il log
aiuta a individuare il primo blocco, ma non rende sicura l'esecuzione di un renderer non compatibile.
Nel bundle locale `d3d12on11/build/first-test` sono predisposti gli override SM5 per i campioni Hela
VS e CS e la mappa `b:3:0` → `b5`. È un pacchetto di diagnostica limitato: il PS Nanite del report
non è convertibile e gli altri shader non hanno override; non è una build compatibile con il gioco.
Il target `d3d12on11_shader_override_smoke` verifica il lookup degli override CS/VS con i DXIL
originali: copiando l'eseguibile accanto al bundle, lo si invoca con `cs|vs` e il percorso del
campione `.dxil`.

È ancora **un prototipo incompleto e non va installato come sostituzione delle DLL del gioco**:
transizioni delle resource barrier non sono tradotte; heap placement con aliasing/backing condiviso, i buffer e le
texture 3D tiled, molte interfacce e feature D3D12 recenti, nonché alcune dimensioni di viste/copie,
restano non supportate. Le copie con placed footprint sono implementate solo per formati e layout
validati dal proxy; i test coprono due formati non compressi e una copia parziale multi-riga, non
tutte le casistiche di formati compressi, box, array o texture 3D.
Il codice non converte DXIL in esecuzione: per ogni shader DXIL serve un override SM5 valido, e la
mappa dei register space deve coincidere con quella usata dal convertitore. Il test locale non
carica Hela e non dimostra la compatibilità del renderer reale. Servono ancora analisi dei log del
gioco e test dedicati prima di considerare il proxy utilizzabile.

Vincoli emersi dall'analisi dei campioni reali:
1. Gli shader convertiti usano `ByteAddressBuffer`; sono implementate viste raw per buffer, ma la copertura di tutte le forme di descriptor non è completa.
2. Le semantiche dei vertex input devono coincidere con l'input layout D3D12; il converter le ripristina dalla firma originale, ma vanno verificate con i PSO effettivi del gioco.
3. I register space devono usare la stessa mappa nel wrapper (root signature) e nella conversione (`bindingMapPath`).
4. Nanite, VSM e altre feature con atomiche a 64 bit / wave ops non sono traducibili: vanno disattivate nel motore.
