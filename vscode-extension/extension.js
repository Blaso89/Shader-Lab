const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vscode = require("vscode");
const { choosePixCapture, buildPixPrompt, buildPixEventListPrompt, buildPixResourcePrompt } = require("./pix.cjs");
const { createMcpServerLogMonitor } = require("./mcp-log-monitor.cjs");
const {
  getConfiguredServer,
  isServerConfigured,
  resolveServerEntryFromDirectory,
  SERVER_ID,
  updateVsCodeUserMcpConfig,
  vsCodeUserMcpConfigPath,
} = require("./mcp-config");

const VIEW_ID = "sm6ToSm5.dashboard";
const SERVER_ROOT_KEY = "sm6ToSm5.serverRoot";
const PIX_TOOLCHAIN_KEY = "sm6ToSm5.pixToolchain";
let mcpConnectionState = "unknown";
let mcpServerDefinitionId;
const viewProviders = new Set();

function setMcpConnectionState(state) {
  mcpConnectionState = state;
  for (const provider of viewProviders) provider.postStatus();
}

function activate(context) {
  const developmentRoot = path.basename(context.extensionPath).toLowerCase() === "vscode-extension"
    ? path.resolve(context.extensionPath, "..")
    : undefined;

  const provider = new ShaderLabViewProvider(context, developmentRoot);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("sm6ToSm5.configureMcp", () => provider.configureMcp()),
    vscode.commands.registerCommand("sm6ToSm5.configurePixTools", () => provider.configurePixTools()),
    vscode.commands.registerCommand("sm6ToSm5.openDashboard", () =>
      vscode.commands.executeCommand("workbench.view.extension.sm6ToSm5")),
  );

  let logMonitorWarningShown = false;
  const reportLogMonitorError = (error) => {
    if (logMonitorWarningShown) return;
    logMonitorWarningShown = true;
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(`Shader Lab: impossibile osservare lo stato MCP: ${detail}`);
  };
  try {
    context.subscriptions.push(createMcpServerLogMonitor(
      context.logUri.fsPath,
      SERVER_ID,
      (state, definitionId) => {
        mcpServerDefinitionId = definitionId;
        setMcpConnectionState(state);
      },
      reportLogMonitorError,
    ));
  } catch (error) {
    reportLogMonitorError(error);
  }
}

class ShaderLabViewProvider {
  constructor(context, developmentRoot) {
    this.context = context;
    this.extensionVersion = context.extension.packageJSON.version;
    this.mcpConfig = vsCodeUserMcpConfigPath(vscode.env.appName, context.globalStorageUri.fsPath);
    let configuredServer;
    try {
      configuredServer = getConfiguredServer(this.mcpConfig);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Shader Lab: ${detail}`);
    }
    this.serverRoot = configuredServer?.root || context.globalState.get(SERVER_ROOT_KEY) || developmentRoot;
    this.serverEntry = this.serverRoot ? path.join(this.serverRoot, "dist", "index.js") : undefined;
    viewProviders.add(this);
    context.subscriptions.push({ dispose: () => viewProviders.delete(this) });
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    }, undefined, this.context.subscriptions);
    this.postStatus();
  }

  postStatus() {
    if (!this.view) return;
    void this.view.webview.postMessage({
      command: "status",
      serverReady: Boolean(this.serverEntry && fs.existsSync(this.serverEntry)),
      mcpConfigured: Boolean(this.serverEntry && isServerConfigured(this.mcpConfig, this.serverEntry)),
      mcpConnectionState,
      serverRoot: this.serverRoot || "",
      serverEntry: this.serverEntry || "",
      mcpConfigPath: this.mcpConfig,
      pixToolchain: this.getPixToolchain(),
      workspaceOpen: vscode.workspace.workspaceFolders?.some(
        (folder) => this.serverRoot && path.resolve(folder.uri.fsPath) === this.serverRoot,
      ) === true,
    });
  }

  async handleMessage(message) {
    if (!message || typeof message.command !== "string") return;
    try {
      switch (message.command) {
        case "refresh":
          this.postStatus();
          return;
        case "openMcpServerOptions":
          await this.openMcpServerOptions();
          return;
        case "analyzeHlsl":
          await this.analyzeHlsl();
          return;
        case "analyzeDxil":
          await this.analyzeDxil();
          return;
        case "analyzePix":
          await this.analyzePix();
          return;
        case "scanPix":
          await this.scanPix();
          return;
        case "listPixEvents":
          await this.listPixEvents();
          return;
        case "exportPixResource":
          await this.exportPixResource();
          return;
        case "configurePixTools":
          await this.configurePixTools();
          return;
        case "analyzeDirectory":
          await this.analyzeDirectory();
          return;
        case "convertHlsl":
          await this.convertHlsl();
          return;
        case "convertDxil":
          await this.convertDxil();
          return;
        case "compileSm5":
          await this.compileSm5();
          return;
        case "startPrecompile":
          await this.startPrecompile();
          return;
        case "cancelPrecompile":
          this.cancelPrecompile();
          return;
        case "checkToolchain":
          await this.openChat("Usa il tool MCP `check_toolchain` del server `sm6-to-sm5` e riassumi quali strumenti sono disponibili e quali mancano.");
          return;
        case "showMcpHelp":
          await vscode.window.showInformationMessage(
            "In MCP: List Servers avvia 'sm6-to-sm5'. Se non compare, usa prima 'Configura server MCP VS Code' e poi ricarica la finestra.",
          );
          return;
        case "configureMcp":
          await this.configureMcp();
          return;
        default:
          return;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Shader Lab: ${detail}`);
    }
  }

  async openMcpServerOptions() {
    if (!this.serverEntry || !fs.existsSync(this.serverEntry) || !isServerConfigured(this.mcpConfig, this.serverEntry)) {
      setMcpConnectionState("unknown");
      throw new Error("Server MCP non configurato o non compilato. Configuralo prima e ricarica la finestra.");
    }

    const commandId = mcpServerDefinitionId
      ? "workbench.mcp.serverOptions"
      : "workbench.mcp.listServer";
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes(commandId)) {
      setMcpConnectionState("unknown");
      throw new Error("Questa versione di VS Code non espone il menu MCP. Usa MCP: List Servers.");
    }

    const previousState = mcpConnectionState;
    setMcpConnectionState("opening");
    try {
      if (mcpServerDefinitionId) {
        await vscode.commands.executeCommand(commandId, mcpServerDefinitionId);
      } else {
        await vscode.commands.executeCommand(commandId);
      }
    } finally {
      if (mcpConnectionState === "opening") setMcpConnectionState(previousState);
    }
  }

  async configureMcp() {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: this.serverRoot ? vscode.Uri.file(this.serverRoot) : undefined,
      openLabel: "Seleziona progetto server",
      title: "Seleziona sm6-to-sm5-mcp (la cartella che contiene dist\\index.js)",
    });
    if (!selected?.[0]) return;

    const { root, entry } = resolveServerEntryFromDirectory(selected[0].fsPath);
    const result = updateVsCodeUserMcpConfig(this.mcpConfig, root, entry);
    this.serverRoot = root;
    this.serverEntry = entry;
    setMcpConnectionState("unknown");
    await this.context.globalState.update(SERVER_ROOT_KEY, root);
    this.postStatus();
    const message = result.backupPath
      ? `Configurazione precedente salvata in ${result.backupPath}. `
      : "";
    await vscode.window.showInformationMessage(
      `${result.changed ? "Server MCP sm6-to-sm5 configurato" : "Server MCP sm6-to-sm5 già configurato"}.\n${message}Ricarica la finestra, poi apri MCP: List Servers e avvia "sm6-to-sm5".`,
      "Ricarica finestra",
    ).then((action) => {
      if (action === "Ricarica finestra") return vscode.commands.executeCommand("workbench.action.reloadWindow");
      return undefined;
    });
  }

  async chooseShaderFile(extensions, title) {
    const files = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Seleziona shader",
      title,
      filters: { "Shader": extensions },
    });
    return files?.[0]?.fsPath;
  }

  async chooseOutput(defaultName, title) {
    const defaultDirectory = this.serverRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require("node:os").homedir();
    const file = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(defaultDirectory, defaultName)),
      saveLabel: "Scegli output",
      title,
    });
    return file?.fsPath;
  }

  async analyzeHlsl() {
    const file = await this.chooseShaderFile(["hlsl", "hlsli", "fx"], "Seleziona sorgente HLSL da analizzare");
    if (!file) return;
    await this.openChat(`Chiama il tool MCP \`analyze_shader\` con ${JSON.stringify({ path: file })}. Riassumi bloccanti, avvisi e auto-fix senza dichiarare convertibile ciò che il report marca come bloccante.`);
  }

  async analyzeDxil() {
    const file = await this.chooseShaderFile(["dxil", "cso", "txt"], "Seleziona DXIL o disassemblato DXC da analizzare");
    if (!file) return;
    const args = file.toLowerCase().endsWith(".txt")
      ? { disasmPath: file }
      : { dxilPath: file };
    await this.openChat(`Chiama il tool MCP \`analyze_dxil\` con ${JSON.stringify(args)}. Spiega quali feature SM6 sono bloccanti per SM5 e separa i fatti dalle ipotesi.`);
  }

  async analyzePix() {
    const file = await choosePixCapture();
    if (!file) return;

    const output = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Usa cartella output",
      title: "Scegli dove salvare report, manifest e shader estratti",
    });
    if (!output?.[0]) return;

    const mode = await vscode.window.showQuickPick([
      { label: "Genera export C++ da .wpix con pixtool.exe", value: "generate" },
      { label: "Usa un export C++ PIX già esistente", value: "existing" },
    ], { title: "Sorgente per estrazione PSO e shader" });
    if (!mode) return;

    const args = {
      pixPath: file,
      mode: "full",
      outputDir: output[0].fsPath,
      ...this.getPixToolchain(),
    };
    if (mode.value === "existing") {
      const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Seleziona export PIX",
        title: "Seleziona l'export C++ PIX che contiene resources.bin e CreatePSOs.cpp",
      });
      if (!folders?.[0]) return;
      args.pixExportDir = folders[0].fsPath;
    }

    const eventChoice = await vscode.window.showQuickPick([
      { label: "Seleziona un event list PIX già esportato", value: "select" },
      { label: "Continua senza event list manuale", value: "skip" },
    ], { title: "Event list per correlare eventi e PSO" });
    if (!eventChoice) return;
    if (eventChoice.value === "select") {
      const eventFiles = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Usa event list",
        title: "Seleziona event list esportato da PIX (CSV, TSV o TXT)",
        filters: { "Event list": ["csv", "tsv", "txt"], "Tutti i file": ["*"] },
      });
      if (!eventFiles?.[0]) return;
      args.eventListPath = eventFiles[0].fsPath;
      const queueName = await vscode.window.showInputBox({
        prompt: "Etichetta facoltativa della queue selezionata in PIX; è un'attestazione UI e non è verificata dal CSV.",
        placeHolder: "Graphics Queue 1 (3D Queue (GPU 0))",
      });
      if (queueName?.trim()) args.queueName = queueName.trim();
    }

    const confirmed = await vscode.window.showWarningMessage(
      "L'analisi completa scrive nella cartella scelta e, se necessario, può avviare il replay/export locale di PIX tramite pixtool.exe. La cattura originale non viene modificata e il C++ generato non viene eseguito.",
      { modal: true },
      "Avvia analisi",
    );
    if (confirmed !== "Avvia analisi") return;
    await this.openChat(buildPixPrompt(file, args));
  }

  async scanPix() {
    const file = await choosePixCapture();
    if (!file) return;
    await this.openChat(buildPixPrompt(file, { mode: "scan" }));
  }

  async chooseEventList() {
    const choice = await vscode.window.showQuickPick([
      { label: "Seleziona un event list già esportato da PIX", value: "select" },
      { label: "Prova l'export locale con pixtool", value: "auto" },
    ], { title: "Origine event list PIX" });
    if (!choice) return null;
    if (choice.value === "auto") return { eventListPath: undefined };
    const files = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Usa event list",
      title: "Seleziona event list esportato da PIX (CSV, TSV o TXT)",
      filters: { "Event list": ["csv", "tsv", "txt"], "Tutti i file": ["*"] },
    });
    return files?.[0] ? { eventListPath: files[0].fsPath } : null;
  }

  async askPixInteger(prompt, placeHolder) {
    const value = await vscode.window.showInputBox({
      prompt,
      placeHolder,
      validateInput: (input) => /^\d+$/.test(input.trim()) ? undefined : "Inserisci un intero non negativo.",
    });
    if (value === undefined) return null;
    const parsed = Number(value.trim());
    if (!Number.isSafeInteger(parsed)) {
      void vscode.window.showErrorMessage("Il valore supera l'intervallo di interi supportato.");
      return null;
    }
    return parsed;
  }

  async listPixEvents() {
    const file = await choosePixCapture();
    if (!file) return;
    const eventList = await this.chooseEventList();
    if (!eventList) return;
    const queueIdText = await vscode.window.showInputBox({
      prompt: "Filtro facoltativo per l'ID esatto di una riga (colonna Queue ID); lascialo vuoto per elencare gli eventi del file.",
      placeHolder: "70",
      validateInput: (value) => value.trim() && !/^\d+$/.test(value.trim()) ? "Inserisci un intero non negativo." : undefined,
    });
    if (queueIdText === undefined) return;
    const queueLabel = await vscode.window.showInputBox({
      prompt: "Etichetta opzionale copiata dalla UI PIX; è solo un'attestazione dell'utente.",
      placeHolder: "Graphics Queue 1",
    });
    if (queueLabel === undefined) return;
    const contains = await vscode.window.showInputBox({
      prompt: "Filtro facoltativo sul nome evento (es. DrawIndexedInstanced).",
      placeHolder: "Draw",
    });
    if (contains === undefined) return;

    await this.openChat(buildPixEventListPrompt({
      pixPath: file,
      queueId: queueIdText.trim() ? Number(queueIdText.trim()) : undefined,
      queueLabel: queueLabel.trim() || undefined,
      eventListPath: eventList.eventListPath,
      contains: contains.trim() || undefined,
      ...this.getPixToolchain(),
    }));
  }

  async exportPixResource() {
    const file = await choosePixCapture();
    if (!file) return;
    const globalId = await this.askPixInteger("Inserisci il Global ID della draw event.", "34");
    if (globalId === null) return;
    const queueId = await this.askPixInteger("Inserisci il Queue ID numerico della stessa riga event list.", "70");
    if (queueId === null) return;
    const eventList = await this.chooseEventList();
    if (!eventList) return;
    const output = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Usa cartella output",
      title: "Scegli dove salvare il render target esportato",
    });
    if (!output?.[0]) return;
    const rtvIndex = await this.askPixInteger("Indice RTV da esportare (da 0 a 7).", "0");
    if (rtvIndex === null || rtvIndex > 7) {
      if (rtvIndex !== null) void vscode.window.showErrorMessage("L'indice RTV deve essere compreso tra 0 e 7.");
      return;
    }
    const queueLabel = await vscode.window.showInputBox({
      prompt: "Etichetta opzionale copiata dalla UI PIX; non è verificata dal CSV.",
      placeHolder: "Graphics Queue 1",
    });
    if (queueLabel === undefined) return;

    const confirmed = await vscode.window.showWarningMessage(
      "Il tool verificherà Global ID, Queue ID e tipo draw nella stessa riga prima di chiamare pixtool. L'export salva un PNG locale e non modifica la cattura.",
      { modal: true },
      "Verifica ed esporta",
    );
    if (confirmed !== "Verifica ed esporta") return;
    await this.openChat(buildPixResourcePrompt({
      pixPath: file,
      globalId,
      queueId,
      queueLabel: queueLabel.trim() || undefined,
      eventListPath: eventList.eventListPath,
      outputDir: output[0].fsPath,
      rtvIndex,
      ...this.getPixToolchain(),
    }));
  }

  getPixToolchain() {
    const stored = this.context.globalState.get(PIX_TOOLCHAIN_KEY, {});
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(
      ["pixToolPath", "dxcPath", "powerShellPath"]
        .filter((key) => typeof stored[key] === "string" && stored[key].trim())
        .map((key) => [key, stored[key].trim()]),
    );
  }

  async configurePixTools() {
    const current = this.getPixToolchain();
    const selected = await vscode.window.showQuickPick([
      { label: "Seleziona pixtool.exe", key: "pixToolPath", expected: ["pixtool.exe"], description: current.pixToolPath || "Autodiscovery" },
      { label: "Seleziona dxc.exe", key: "dxcPath", expected: ["dxc.exe"], description: current.dxcPath || "Autodiscovery" },
      { label: "Seleziona PowerShell", key: "powerShellPath", expected: ["powershell.exe", "pwsh.exe"], description: current.powerShellPath || "Autodiscovery" },
      { label: "Ripristina autodiscovery per tutti gli strumenti", key: "reset" },
    ], { title: "Configura eseguibili PIX locali" });
    if (!selected) return;

    if (selected.key === "reset") {
      await this.context.globalState.update(PIX_TOOLCHAIN_KEY, {});
      this.postStatus();
      await vscode.window.showInformationMessage("Percorsi personalizzati rimossi; Shader Lab userà l'autodiscovery.");
      return;
    }

    const files = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: current[selected.key] ? vscode.Uri.file(path.dirname(current[selected.key])) : undefined,
      openLabel: "Collega eseguibile",
      title: `Seleziona ${selected.expected.join(" o ")}`,
      filters: { "Programmi Windows": ["exe"] },
    });
    if (!files?.[0]) return;

    const executable = files[0].fsPath;
    if (!selected.expected.includes(path.basename(executable).toLowerCase())) {
      throw new Error(`Seleziona ${selected.expected.join(" o ")}; ricevuto: ${path.basename(executable)}.`);
    }
    await this.context.globalState.update(PIX_TOOLCHAIN_KEY, { ...current, [selected.key]: executable });
    this.postStatus();
    await vscode.window.showInformationMessage(`${path.basename(executable)} collegato: ${executable}`);
  }

  async analyzeDirectory() {
    const folders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Seleziona cartella",
      title: "Seleziona la cartella con gli shader HLSL",
    });
    const dir = folders?.[0]?.fsPath;
    if (!dir) return;
    await this.openChat(`Chiama il tool MCP \`analyze_directory\` con ${JSON.stringify({ dir, recursive: true })}. Riassumi quanti shader sono compatibili, convertibili con avvisi o bloccati.`);
  }

  async convertHlsl() {
    const file = await this.chooseShaderFile(["hlsl", "hlsli", "fx"], "Seleziona sorgente HLSL SM6");
    if (!file) return;
    const outPath = await this.chooseOutput(`${path.basename(file, path.extname(file))}.sm5.hlsl`, "Salva candidato HLSL SM5");
    if (!outPath) return;
    await this.openChat(`Chiama il tool MCP \`convert_shader\` con ${JSON.stringify({ path: file, outPath })}. Mostra le trasformazioni, la mappa binding e ogni incompatibilità residua. Non presentare l'output come validato finché non passa FXC.`);
  }

  async convertDxil() {
    const file = await this.chooseShaderFile(["dxil", "cso"], "Seleziona contenitore DXIL compilato");
    if (!file) return;
    const outPath = await this.chooseOutput(`${path.basename(file, path.extname(file))}.sm5candidate.hlsl`, "Salva candidato HLSL SM5 decompilato");
    if (!outPath) return;
    await this.openChat(`Prova la conversione sperimentale con il tool MCP \`dxil_to_sm5_hlsl\` usando ${JSON.stringify({ inputPath: file, outPath, force: false, bufferMode: "raw" })}. Non forzare bloccanti; dichiara chiaramente che l'output è decompilato e non garantisce equivalenza o supporto D3D11.`);
  }

  async compileSm5() {
    const file = await this.chooseShaderFile(["hlsl", "fx"], "Seleziona HLSL candidato da validare con FXC");
    if (!file) return;
    const profile = await vscode.window.showQuickPick(
      ["vs_5_0", "ps_5_0", "gs_5_0", "hs_5_0", "ds_5_0", "cs_5_0"],
      { title: "Profilo shader SM5", placeHolder: "Seleziona lo stage corretto" },
    );
    if (!profile) return;
    await this.openChat(`Chiama il tool MCP \`compile_sm5\` con ${JSON.stringify({ path: file, profile, entry: "main" })}. Se l'entry point non è main, chiedimi il nome corretto prima di concludere.`);
  }

  async startPrecompile() {
    if (this.precompileJob || this.precompileStarting) throw new Error("È già attivo un job di precompilazione.");
    const corePath = this.serverRoot && path.join(this.serverRoot, "dist", "dxil-precompile.js");
    if (!corePath || !fs.existsSync(corePath))
      throw new Error("Core non compilato: esegui npm run build nel progetto Shader Lab e ricarica la finestra.");

    this.precompileStarting = true;
    this.postPrecompileMessage({ command: "precompileSelecting" });
    let inputDir;
    let outputDir;
    let bindingMapPath;
    let job;
    try {
      const inputSelection = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Seleziona cartella DXIL",
        title: "Seleziona la cartella con shader DXIL e disassemblati DXC",
      });
      inputDir = inputSelection?.[0]?.fsPath;
      if (!inputDir) return;

      const outputSelection = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Seleziona destinazione staging",
        title: "Seleziona una cartella base separata dall'input; gli output resteranno in una nuova sottocartella staging",
      });
      const outputParent = outputSelection?.[0]?.fsPath;
      if (!outputParent) return;

      const bindingSelection = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { "JSON binding map": ["json"] },
        openLabel: "Usa mappa",
        title: "Mappa binding opzionale (Annulla per continuare senza mappa)",
      });
      bindingMapPath = bindingSelection?.[0]?.fsPath;
      outputDir = path.join(outputParent, `ShaderLab-Staging-${Date.now()}`);
      job = { cancelRequested: false };
      this.precompileJob = job;
      this.postPrecompileMessage({ command: "precompileStarted", inputDir, outputDir });
    } finally {
      this.precompileStarting = false;
      if (!job) this.postPrecompileMessage({ command: "precompileSelectionCancelled" });
    }

    try {
      const { precompileDxilDirectory } = await import(pathToFileURL(corePath).href);
      const report = await precompileDxilDirectory({
        inputDir,
        outputDir,
        bindingMapPath,
        shouldCancel: () => job.cancelRequested,
        onProgress: (progress) => this.postPrecompileMessage({ command: "precompileProgress", ...progress }),
        onSnapshotProgress: (phase, scanned, total) =>
          this.postPrecompileMessage({ command: "precompileSnapshotProgress", phase, scanned, total }),
      });
      this.postPrecompileMessage({
        command: "precompileComplete",
        report: {
          outputDir: report.outputDir,
          total: report.total,
          compiled: report.compiled,
          blocked: report.blocked,
          failed: report.failed,
          skipped: report.skipped,
          cancelled: report.cancelled,
          issues: report.results.filter((result) => result.status !== "compiled").slice(0, 30),
          omittedIssues: Math.max(0, report.results.filter((result) => result.status !== "compiled").length - 30),
        },
      });
      await vscode.window.showInformationMessage(
        `Precompilazione completata: ${report.compiled} compilati, ${report.blocked} bloccati, ${report.failed} errori, ${report.skipped} ignorati, ${report.cancelled} annullati. Output in staging.`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (job.cancelRequested && error && error.name === "PrecompileCancelledError") {
        this.postPrecompileMessage({ command: "precompileCancelled", message: detail });
        return;
      }
      this.postPrecompileMessage({ command: "precompileFailed", message: detail });
      throw error;
    } finally {
      this.precompileJob = undefined;
    }
  }

  cancelPrecompile() {
    if (!this.precompileJob) return;
    this.precompileJob.cancelRequested = true;
    this.postPrecompileMessage({
      command: "precompileCancellationRequested",
      message: "Annullamento richiesto; il file in elaborazione terminerà il passaggio esterno attivo.",
    });
  }

  postPrecompileMessage(message) {
    if (this.view) void this.view.webview.postMessage(message);
  }

  async openChat(query) {
    if (!this.serverEntry || !fs.existsSync(this.serverEntry)) {
      throw new Error("Server MCP non configurato o non compilato. Usa prima 'Configura server MCP VS Code' e seleziona il progetto con dist\\index.js.");
    }
    if (!isServerConfigured(this.mcpConfig, this.serverEntry)) {
      throw new Error(`Server non allineato al profilo MCP di VS Code. Configura "${this.serverEntry}" con il pulsante in Shader Lab.`);
    }
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", { query });
    } catch {
      await vscode.window.showWarningMessage(
        "Copilot Chat non è disponibile. Avvia il server sm6-to-sm5 da MCP: List Servers e incolla la richiesta nella chat Agent.",
      );
    }
  }

  getHtml(webview) {
    const nonce = getNonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "dashboard.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "dashboard.css"));
    return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
  <title>SM6 to SM5 Shader Lab v${this.extensionVersion}</title>
</head>
<body>
  <main class="dashboard-panel">
    <header class="dashboard-header">
    <div class="eyebrow">Shader Forge</div>
    <h1>MCP Dashboard <span class="version-badge" aria-label="Versione plugin ${this.extensionVersion}">v${this.extensionVersion}</span></h1>
    <p class="dashboard-subtitle">Compilazione HLSL/DXIL con server MCP integrato</p>
    <div class="status-row">
      <span id="server-status" class="status server-status pending">Verifica MCP…</span>
      <button id="mcp-live" class="live-control mcp-live unknown" data-action="openMcpServerOptions" type="button" title="Apri le stesse opzioni server MCP mostrate da MCP: List Servers"><span class="live-dot" aria-hidden="true"></span><span id="mcp-live-label" class="mcp-live-label" aria-live="polite">Live: stato non verificato</span></button>
      <button id="refresh" class="icon-button" title="Aggiorna stato" aria-label="Aggiorna stato">↻</button>
    </div>
    </header>

    <nav class="tab-bar" role="tablist" aria-label="Sezioni Shader Lab">
      <button class="tab-btn active" id="tab-shaderlab" role="tab" aria-selected="true" aria-controls="pane-shaderlab" data-tab="shaderlab"><span class="tab-tag">UNREAL · D3D12 → D3D11</span>Shader Lab</button>
      <button class="tab-btn" id="tab-pix" role="tab" aria-selected="false" aria-controls="pane-pix" data-tab="pix"><span class="tab-tag">ANALISI LOCALE · D3D12</span>Cattura PIX</button>
    </nav>

    <div id="pane-shaderlab" class="tab-pane active" role="tabpanel" aria-labelledby="tab-shaderlab">
      <div id="shaderlab-dashboard">
        <div id="precompile-reopen" class="precompile-reopen" hidden>
          <span id="precompile-reopen-status" role="status" aria-live="polite">Job di precompilazione disponibile.</span>
          <button id="precompile-reopen-button" class="link-button" type="button">Mostra avanzamento</button>
        </div>
      <section class="section">
        <p class="section-label">Configurazione</p>
        <article class="dashboard-card">
          <span class="card-number">1</span>
          <div class="card-content"><h2>Seleziona progetto server</h2><p>Collega la cartella Shader Lab che contiene <code>dist\\index.js</code>.</p><button class="card-btn" data-action="configureMcp">Apri cartella</button></div>
        </article>
        <article class="dashboard-card">
          <span class="card-number">2</span>
          <div class="card-content"><h2>Avvia o controlla MCP</h2><p>Apri MCP: List Servers per avviare il server associato o verificarne lo stato.</p><button class="card-btn" data-action="openMcpServerOptions">Apri opzioni MCP</button></div>
        </article>
        <article class="dashboard-card">
          <span class="card-number">3</span>
          <div class="card-content"><h2>Precompila shader DXIL</h2><p>Compila candidati SM5 in una cartella di staging separata.</p><button id="start-precompile" class="card-btn" data-action="startPrecompile">Avvia precompilazione</button></div>
        </article>
      </section>

      <section class="section">
        <p class="section-label">Strumenti shader</p>
        <div class="button-grid">
          <button class="secondary" data-action="analyzeHlsl">Analizza sorgente HLSL</button>
          <button class="secondary" data-action="analyzeDxil">Analizza bytecode DXIL</button>
          <button class="secondary" data-action="convertHlsl">Converti sorgente HLSL</button>
          <button class="secondary" data-action="convertDxil">DXIL → HLSL candidato</button>
          <button class="secondary" data-action="analyzeDirectory">Analizza cartella HLSL</button>
          <button class="secondary" data-action="compileSm5">Compila con FXC</button>
          <button class="secondary" data-action="checkToolchain">Controlla toolchain</button>
        </div>
      </section>

      <section class="section">
        <p class="section-label">Stato toolchain</p>
        <div class="toolchain-block">
          <div class="kv"><span>Server entry</span><strong id="server-entry">Controllo…</strong></div>
          <div class="kv"><span>Config MCP</span><strong id="mcp-config">Controllo…</strong></div>
          <div class="kv"><span>Root progetto</span><strong id="server-root">Controllo…</strong></div>
          <div class="kv"><span>Config profile</span><strong id="mcp-config-path">Controllo…</strong></div>
          <div class="kv"><span>DXIL → SPIR-V</span><strong id="dxc-path">Autodiscovery</strong></div>
          <div class="kv"><span>PowerShell</span><strong id="powershell-path">Autodiscovery</strong></div>
        </div>
      </section>
      </div>

      <section id="precompile-screen" class="precompile-screen" hidden aria-labelledby="precompile-title">
        <div class="precompile-screen-heading">
          <p class="section-label">Job locale</p>
          <h2 id="precompile-title">Precompilazione in corso</h2>
        </div>
        <div id="precompile-ratio" class="precompile-ratio" aria-live="polite">0 / 0</div>
        <p id="precompile-status" class="precompile-phase" aria-live="polite">In attesa di selezione…</p>
        <progress id="precompile-progress" max="1" value="0" aria-label="Avanzamento precompilazione"></progress>
        <div class="precompile-counters" aria-live="polite">
          <div class="pc-counter compiled"><strong class="pc-n" id="pc-compiled">0</strong><span class="pc-l">Compilati</span></div>
          <div class="pc-counter blocked"><strong class="pc-n" id="pc-blocked">0</strong><span class="pc-l">Bloccati</span></div>
          <div class="pc-counter failed"><strong class="pc-n" id="pc-failed">0</strong><span class="pc-l">Errori</span></div>
          <div class="pc-counter skipped"><strong class="pc-n" id="pc-skipped">0</strong><span class="pc-l">Ignorati</span></div>
        </div>
        <pre id="precompile-details" class="precompile-log" aria-live="polite"></pre>
        <section class="snapshot-progress" aria-labelledby="snapshot-progress-title">
          <p id="snapshot-progress-title" class="section-label">Avanzamento snapshot</p>
          <p id="snapshot-status" class="snapshot-status" aria-live="polite">In attesa…</p>
          <progress id="snapshot-progress" max="1" aria-label="Avanzamento dello snapshot"></progress>
        </section>
        <div class="precompile-actions">
          <button id="cancel-precompile" class="cancel-job" data-action="cancelPrecompile" disabled>Annulla</button>
          <button id="precompile-return" class="secondary" type="button">Torna al dashboard</button>
        </div>
      </section>
    </div>

    <div id="pane-pix" class="tab-pane" role="tabpanel" aria-labelledby="tab-pix">
      <section class="section">
        <p class="section-label">Cattura PIX</p>
        <article class="dashboard-card">
          <span class="card-number">1</span>
          <div class="card-content"><h2>Scansione statica</h2><p>Legge header e blocchi limitati del .wpix senza avviare PIX/pixtool o scrivere output.</p><button class="card-btn" data-action="scanPix">Scansiona .wpix</button></div>
        </article>
        <article class="dashboard-card">
          <span class="card-number">2</span>
          <div class="card-content"><h2>Analisi completa</h2><p>Estrae shader e PSO; il replay/export locale con pixtool può essere avviato su conferma.</p><button class="card-btn" data-action="analyzePix">Seleziona .wpix</button></div>
        </article>
        <article class="dashboard-card">
          <span class="card-number">3</span>
          <div class="card-content"><h2>Eventi e risorse</h2><p>Consulta event list o esporta un render target dopo aver verificato draw, Global ID e Queue ID.</p><div class="pix-actions"><button class="secondary" data-action="listPixEvents">Elenca eventi</button><button class="secondary" data-action="exportPixResource">Esporta render target</button></div></div>
        </article>
      </section>
      <section class="section">
        <p class="section-label">Eseguibili collegati</p>
        <div class="toolchain-block">
          <div class="kv"><span>pixtool.exe</span><strong id="pix-tool-path">Autodiscovery</strong></div>
          <div class="kv"><span>dxc.exe</span><strong id="pix-dxc-path">Autodiscovery</strong></div>
          <div class="kv"><span>PowerShell</span><strong id="pix-powershell-path">Autodiscovery</strong></div>
        </div>
        <button class="secondary config-button" data-action="configurePixTools">Seleziona / modifica eseguibili</button>
        <p class="muted-copy">I percorsi tool restano nel profilo VS Code locale. La cattura originale non viene modificata e il C++ esportato non viene eseguito.</p>
      </section>
    </div>

    <footer><button class="link-button" data-action="showMcpHelp">Come avviare il server MCP</button><p>Per provare i tool MCP: Copilot Chat → modalità Agent.</p></footer>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function getNonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return value;
}

function deactivate() {}

module.exports = { activate, deactivate };
