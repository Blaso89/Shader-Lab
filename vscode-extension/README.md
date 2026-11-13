# SM6 to SM5 Shader Lab for VS Code

Questa estensione aggiunge Shader Lab e una vista PIX dedicata per pilotare il server MCP
`sm6-to-sm5` incluso nella cartella principale del progetto. Le azioni selezionano
un file/cartella e predispongono in Copilot Chat una richiesta per lo strumento MCP
corrispondente.

## Avvio dal sorgente

1. Dalla cartella `sm6-to-sm5-mcp`, eseguire `npm ci` e `npm run build`.
2. Aprire in VS Code la cartella `sm6-to-sm5-mcp` (non solo `vscode-extension`):
   `.vscode/mcp.json` avvia `dist/index.js` come server MCP del workspace.
3. Eseguire `MCP: List Servers` → avviare `sm6-to-sm5`.
4. Installare il VSIX della dashboard oppure avviare l'estensione da una finestra
   Extension Development Host.
5. Se `sm6-to-sm5` non compare in MCP: List Servers, usare **SM6 to SM5: Configura
   server MCP VS Code** e selezionare la cartella `sm6-to-sm5-mcp` che contiene
   `dist/index.js`. L'estensione aggiunge il server al profilo MCP attivo con il
   percorso assoluto, conserva gli altri server e crea un backup del file esistente.
6. Ricaricare la finestra, avviare `sm6-to-sm5` da MCP: List Servers e in Copilot
   Chat scegliere Agent mode per verificare la disponibilità degli strumenti MCP.

## Dashboard e Cattura PIX

- Analisi sorgente HLSL: `analyze_shader`
- Analisi DXIL/disassemblato: `analyze_dxil`
- Analisi batch HLSL: `analyze_directory`
- Conversione sorgente HLSL: `convert_shader`
- DXIL a HLSL decompilato candidato: `dxil_to_sm5_hlsl`
- Validazione con FXC: `compile_sm5`
- Verifica degli strumenti esterni: `check_toolchain`

La vista **Cattura PIX** separa la scansione statica read-only dall'analisi completa.
La modalità completa seleziona il `.wpix`, la cartella output, un export C++ esistente
oppure l'export tramite pixtool, e un event list opzionale. Estrae i payload shader,
li disassembla con DXC e salva report e manifest localmente. Può avviare un replay/export
PIX, ma non modifica il `.wpix` e non esegue il C++ generato.

PIX, DXC e PowerShell vengono rilevati sul PC corrente. Se l'autodiscovery non riesce,
il pulsante **Seleziona / modifica eseguibili** apre il selettore Windows per collegare
gli `.exe`; i percorsi sono salvati solo nel profilo VS Code dell'utente e possono essere
azzerati per ripristinare l'autodiscovery. Non sono inclusi percorsi assoluti macchina-specifici
nel VSIX. Il server MCP resta un componente separato: su un nuovo PC selezionare la cartella
del progetto compilato con **Configura server MCP VS Code**.

Le azioni che coinvolgono Copilot preparano una richiesta con i percorsi selezionati.
Il server MCP è quello autonomo `sm6-to-sm5`, non il Ghidra Analysis Manager. Se la
richiesta non apre Copilot Chat automaticamente, avviare il server MCP e usare Agent
Chat manualmente.

## Limiti

DXIL → SPIR-V → HLSL è sperimentale. Il risultato è decompilato, non necessariamente
equivalente al programma originale, e non prova che il gioco o un renderer D3D11
possano usarlo. Un passaggio FXC convalida la sintassi/profilo dello shader, non
l'equivalenza visiva o l'integrazione con l'engine.

La scansione statica `.wpix` è limitata a header e blocchi. L'analisi completa usa
l'export C++ documentato da PIX, non decodifica direttamente il formato `.wpix`; gli
eventuali event list non attestano la queue se il formato non ne include il nome. I
verdetti shader sono statici e non dimostrano equivalenza visiva o compatibilità runtime.
