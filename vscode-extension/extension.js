const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { choosePixCapture, buildPixPrompt } = require("./pix.cjs");
const {
  getConfiguredServer,
  isServerConfigured,
  resolveServerEntryFromDirectory,
  updateVsCodeUserMcpConfig,
  vsCodeUserMcpConfigPath,
} = require("./mcp-config");

const VIEW_ID = "sm6ToSm5.dashboard";
const PIX_VIEW_ID = "sm6ToSm5.pix";
const SERVER_ROOT_KEY = "sm6ToSm5.serverRoot";
const PIX_TOOLCHAIN_KEY = "sm6ToSm5.pixToolchain";

function activate(context) {
  const developmentRoot = path.basename(context.extensionPath).toLowerCase() === "vscode-extension"
    ? path.resolve(context.extensionPath, "..")
    : undefined;

  const provider = new ShaderLabViewProvider(context, developmentRoot);
  const pixProvider = new ShaderLabViewProvider(context, developmentRoot, true);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(PIX_VIEW_ID, pixProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("sm6ToSm5.configureMcp", () => provider.configureMcp()),
    vscode.commands.registerCommand("sm6ToSm5.configurePixTools", () => pixProvider.configurePixTools()),
    vscode.commands.registerCommand("sm6ToSm5.openDashboard", () =>
      vscode.commands.executeCommand("workbench.view.extension.sm6ToSm5")),
  );
}

class ShaderLabViewProvider {
  constructor(context, developmentRoot, isPixView = false) {
    this.context = context;
    this.isPixView = isPixView;
    this.mcpConfig = vsCodeUserMcpConfigPath(vscode.env.appName, context.globalStorageUri.fsPath);
    let configuredServer;
    try {
      configuredServer = getConfiguredServer(this.mcpConfig);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Shader Lab: ${detail}`);
    }
    this.serverRoot = context.globalState.get(SERVER_ROOT_KEY) || configuredServer?.root || developmentRoot;
    this.serverEntry = this.serverRoot ? path.join(this.serverRoot, "dist", "index.js") : undefined;
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
      serverRoot: this.serverRoot || "",
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
        prompt: "Etichetta facoltativa della queue selezionata in PIX; non è verificabile se l'export non la include.",
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
    if (this.isPixView) {
      return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
  <title>Cattura PIX - Shader Lab</title>
</head>
<body>
  <header class="hero">
    <div class="eyebrow">ANALISI LOCALE · D3D12</div>
    <h1>Cattura PIX</h1>
    <p>Analisi statica read-only oppure estrazione completa di PSO e shader.</p>
    <div class="status-row"><span id="server-status" class="status pending">Verifica MCP…</span></div>
  </header>
  <section class="notice">
    <strong>Toolchain portabile</strong>
    <p>Su Windows rileva automaticamente PIX, DXC e PowerShell. Se non li trova, collega gli eseguibili installati su questo PC; i percorsi restano locali al profilo VS Code.</p>
  </section>
  <section class="section">
    <h2>Eseguibili collegati</h2>
    <div class="kv"><span>pixtool.exe</span><strong id="pix-tool-path">Autodiscovery</strong></div>
    <div class="kv"><span>dxc.exe</span><strong id="dxc-path">Autodiscovery</strong></div>
    <div class="kv"><span>PowerShell</span><strong id="powershell-path">Autodiscovery</strong></div>
    <button class="secondary config-button" data-action="configurePixTools">Seleziona / modifica eseguibili</button>
  </section>
  <section class="section">
    <h2>Pipeline PIX</h2>
    <article class="step-card">
      <div class="step-number">00</div>
      <div class="step-copy"><h3>Scansione statica read-only</h3><p>Legge header e blocchi limitati del .wpix, senza avviare PIX/pixtool e senza scrivere output.</p></div>
      <button class="secondary" data-action="scanPix">Scansiona .wpix</button>
    </article>
    <article class="step-card">
      <div class="step-number">01</div>
      <div class="step-copy"><h3>Analisi completa</h3><p>Estrae il progetto PIX, decomprime i payload shader, correla i PSO, disassembla DXIL e salva report/manifest nella cartella scelta.</p></div>
      <button data-action="analyzePix">Seleziona .wpix e avvia</button>
    </article>
  </section>
  <section class="section">
    <h2>Note operative</h2>
    <p class="muted-copy">La modalità completa scrive solo nella cartella output e può avviare un replay/export tramite pixtool. La cattura originale resta intatta; il C++ esportato non viene eseguito. L'event list può essere selezionato separatamente per preservare l'export della queue desiderata.</p>
  </section>
  <footer><button class="link-button" data-action="configureMcp">Configura server MCP VS Code</button></footer>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
    return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
  <title>SM6 to SM5 Shader Lab</title>
</head>
<body>
  <header class="hero">
    <div class="eyebrow">UNREAL · D3D12 → D3D11</div>
    <h1>Shader Lab</h1>
    <p>Analisi e conversione sperimentale SM6 → SM5</p>
    <div class="status-row">
      <span id="server-status" class="status pending">Verifica MCP…</span>
      <button id="refresh" class="icon-button" title="Aggiorna stato" aria-label="Aggiorna stato">↻</button>
    </div>
    <button class="secondary config-button" data-action="configureMcp">Configura server MCP VS Code</button>
  </header>

  <section class="notice">
    <strong>Laboratorio sperimentale</strong>
    <p>La conversione DXIL produce HLSL decompilato candidato: non garantisce equivalenza, compilazione o compatibilità del renderer D3D11.</p>
  </section>

  <section class="section">
    <h2>Pipeline shader</h2>
    <article class="step-card">
      <div class="step-number">01</div>
      <div class="step-copy"><h3>Analizza sorgente HLSL</h3><p>Trova feature SM6, bloccanti e correzioni automatiche.</p></div>
      <button data-action="analyzeHlsl">Seleziona HLSL</button>
    </article>
    <article class="step-card">
      <div class="step-number">02</div>
      <div class="step-copy"><h3>Analizza bytecode DXIL</h3><p>Esamina stage, binding, wave ops e feature non SM5.</p></div>
      <button data-action="analyzeDxil">Seleziona DXIL</button>
    </article>
    <article class="step-card">
      <div class="step-number">03</div>
      <div class="step-copy"><h3>Converti HLSL → SM5</h3><p>Applica riscritture testuali e salva un candidato.</p></div>
      <button data-action="convertHlsl">Converti sorgente</button>
    </article>
    <article class="step-card">
      <div class="step-number">04</div>
      <div class="step-copy"><h3>DXIL → HLSL candidato</h3><p>Pipeline sperimentale via SPIR-V; può fermarsi sui bloccanti.</p></div>
      <button data-action="convertDxil">Prova decompilazione</button>
    </article>
  </section>

  <section class="section">
    <h2>Verifica</h2>
    <div class="button-grid">
      <button class="secondary" data-action="analyzeDirectory">Analizza cartella HLSL</button>
      <button class="secondary" data-action="compileSm5">Compila con FXC</button>
      <button class="secondary" data-action="checkToolchain">Controlla toolchain</button>
    </div>
  </section>

  <section class="section">
    <h2>Stato progetto</h2>
    <div class="kv"><span>Server MCP</span><strong id="server-entry">Controllo…</strong></div>
    <div class="kv"><span>Profilo MCP VS Code</span><strong id="mcp-config">Controllo…</strong></div>
    <div class="kv"><span>Progetto server</span><strong id="server-root">Controllo…</strong></div>
    <div class="kv"><span>File profilo</span><strong id="mcp-config-path">Controllo…</strong></div>
  </section>

  <footer>
    <button class="link-button" data-action="showMcpHelp">Come avviare MCP in VS Code</button>
    <p>Per provare i tool: Copilot Chat → modalità Agent.</p>
  </footer>
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
