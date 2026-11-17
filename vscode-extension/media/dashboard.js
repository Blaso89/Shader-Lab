(function () {
  const vscode = acquireVsCodeApi();

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach((tab) => {
        tab.classList.toggle("active", tab.dataset.tab === target);
        tab.setAttribute("aria-selected", tab.dataset.tab === target ? "true" : "false");
      });
      document.querySelectorAll(".tab-pane").forEach((pane) => {
        pane.classList.toggle("active", pane.id === "pane-" + target);
      });
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      vscode.postMessage({ command: button.dataset.action });
    });
  });

  const refresh = document.getElementById("refresh");
  if (refresh) refresh.addEventListener("click", () => vscode.postMessage({ command: "refresh" }));

  const statusEls = document.querySelectorAll(".server-status");
  const liveEls = document.querySelectorAll(".mcp-live");
  const liveLabelEls = document.querySelectorAll(".mcp-live-label");
  const liveLabels = {
    unknown: "Live: stato non verificato",
    starting: "Live: avvio in corso…",
    connected: "Live: connesso",
    disconnected: "Live: disconnesso",
    opening: "Live: apertura opzioni MCP…",
  };

  const precompileDashboard = document.getElementById("shaderlab-dashboard");
  const precompileScreen = document.getElementById("precompile-screen");
  const precompileTitle = document.getElementById("precompile-title");
  const precompileRatio = document.getElementById("precompile-ratio");
  const precompileProgress = document.getElementById("precompile-progress");
  const precompileStatus = document.getElementById("precompile-status");
  const precompileDetails = document.getElementById("precompile-details");
  const snapshotProgress = document.getElementById("snapshot-progress");
  const snapshotStatus = document.getElementById("snapshot-status");
  const precompileReopen = document.getElementById("precompile-reopen");
  const precompileReopenStatus = document.getElementById("precompile-reopen-status");
  const precompileReopenButton = document.getElementById("precompile-reopen-button");
  const precompileReturn = document.getElementById("precompile-return");
  const startPrecompile = document.getElementById("start-precompile");
  const cancelPrecompile = document.getElementById("cancel-precompile");
  const pcCounters = {
    compiled: document.getElementById("pc-compiled"),
    blocked: document.getElementById("pc-blocked"),
    failed: document.getElementById("pc-failed"),
    skipped: document.getElementById("pc-skipped"),
    cancelled: document.getElementById("pc-cancelled"),
  };
  let precompileInProgress = false;
  let precompileAvailable = false;
  let precompileLogLines = [];
  let lastLoggedSettled = 0;

  if (precompileReopenButton) {
    precompileReopenButton.addEventListener("click", () => showPrecompileScreen(true));
  }
  if (precompileReturn) {
    precompileReturn.addEventListener("click", () => {
      showPrecompileScreen(false);
      if (!precompileInProgress) {
        precompileAvailable = false;
        if (precompileReopen) precompileReopen.hidden = true;
      }
    });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) return;
    if (message.command === "status") {
      handleStatus(message);
      return;
    }
    handlePrecompileMessage(message);
  });

  function handleStatus(message) {
    setText("server-entry", message.serverReady ? "Compilato" : "Non trovato");
    setText("mcp-config", message.mcpConfigured ? "Allineato" : "Non associato");
    setText("server-root", message.serverRoot || "Non selezionato");
    setText("mcp-config-path", message.mcpConfigPath || "Non rilevato");

    const liveState = Object.prototype.hasOwnProperty.call(liveLabels, message.mcpConnectionState)
      ? message.mcpConnectionState
      : "unknown";
    liveLabelEls.forEach((element) => { element.textContent = liveLabels[liveState]; });
    liveEls.forEach((element) => {
      element.className = "live-control " + liveState;
      element.disabled = liveState === "opening";
      element.setAttribute("aria-label", liveLabels[liveState]);
    });

    const toolchain = message.pixToolchain || {};
    setText("pix-tool-path", toolchain.pixToolPath || "Autodiscovery");
    setText("dxc-path", toolchain.dxcPath || "Autodiscovery");
    setText("pix-dxc-path", toolchain.dxcPath || "Autodiscovery");
    setText("powershell-path", toolchain.powerShellPath || "Autodiscovery");
    setText("pix-powershell-path", toolchain.powerShellPath || "Autodiscovery");

    const ready = message.serverReady && message.mcpConfigured;
    statusEls.forEach((element) => {
      element.textContent = ready ? "Server allineato" : message.serverReady ? "Server non associato" : "Server non compilato";
      element.className = "status " + (ready ? "ready" : "warning");
    });
  }

  function setPrecompileRunning(running) {
    precompileInProgress = running;
    if (startPrecompile) startPrecompile.disabled = running;
    if (cancelPrecompile && running) cancelPrecompile.disabled = false;
    if (cancelPrecompile && !running) cancelPrecompile.disabled = true;
    updateReopenStatus();
    updateReopenVisibility();
  }

  function showPrecompileScreen(show) {
    if (show) precompileAvailable = true;
    if (precompileScreen) precompileScreen.hidden = !show;
    if (precompileDashboard) precompileDashboard.hidden = show;
    updateReopenStatus();
    updateReopenVisibility();
  }

  function updateReopenVisibility() {
    if (precompileReopen) precompileReopen.hidden = !precompileAvailable || Boolean(precompileScreen && !precompileScreen.hidden);
  }

  function updateReopenStatus() {
    if (!precompileReopenStatus) return;
    const ratio = precompileRatio ? precompileRatio.textContent : "";
    precompileReopenStatus.textContent = precompileInProgress
      ? `Precompilazione in corso · ${ratio}.`
      : "Ultimo job di precompilazione disponibile.";
  }

  function setProgressBar(element, scanned, total, indeterminate) {
    if (!element) return;
    if (indeterminate || !Number.isFinite(total) || total <= 0) {
      element.removeAttribute("value");
      return;
    }
    element.max = total;
    element.value = Math.min(Math.max(0, scanned || 0), total);
  }

  function setCounter(key, value) {
    const element = pcCounters[key];
    if (element) element.textContent = value === undefined ? 0 : value;
  }

  function renderPrecompileLog() {
    if (precompileDetails) precompileDetails.textContent = precompileLogLines.join("\n");
  }

  function resetPrecompileLog(outputDir) {
    precompileLogLines = outputDir ? [`Output staging: ${outputDir}`] : [];
    lastLoggedSettled = 0;
    renderPrecompileLog();
  }

  function appendPrecompileLog(line) {
    precompileLogLines.push(line);
    while (precompileLogLines.length > 13) precompileLogLines.splice(1, 1);
    renderPrecompileLog();
  }

  function appendResult(result) {
    if (!result) return;
    const labels = {
      compiled: "compilato",
      blocked: "bloccato",
      failed: "errore",
      skipped: "ignorato",
      cancelled: "annullato",
    };
    appendPrecompileLog(`[${labels[result.status] || result.status}] ${result.file}: ${result.message}`);
  }

  function setReportLog(report) {
    precompileLogLines = report.outputDir ? [`Output staging: ${report.outputDir}`] : [];
    (report.issues || []).forEach((item) => {
      precompileLogLines.push(`[${item.status}] ${item.file}: ${item.message}`);
    });
    if (report.omittedIssues) {
      precompileLogLines.push(`… altri ${report.omittedIssues} risultati non mostrati.`);
    }
    renderPrecompileLog();
  }

  function handlePrecompileMessage(message) {
    if (!precompileStatus || !precompileProgress || !precompileDetails) return;

    switch (message.command) {
      case "precompileSelecting":
        setPrecompileRunning(true);
        showPrecompileScreen(true);
        if (cancelPrecompile) cancelPrecompile.disabled = true;
        if (precompileTitle) precompileTitle.textContent = "Prepara precompilazione";
        if (precompileRatio) precompileRatio.textContent = "—";
        precompileStatus.textContent = "Seleziona input e cartella di staging…";
        setProgressBar(precompileProgress, 0, 0, true);
        if (snapshotStatus) snapshotStatus.textContent = "In attesa della selezione…";
        setProgressBar(snapshotProgress, 0, 0, true);
        resetPrecompileLog();
        return;

      case "precompileSelectionCancelled":
        setPrecompileRunning(false);
        precompileAvailable = false;
        showPrecompileScreen(false);
        return;

      case "precompileStarted":
        setPrecompileRunning(true);
        showPrecompileScreen(true);
        if (precompileTitle) precompileTitle.textContent = "Precompilazione in corso";
        if (precompileRatio) precompileRatio.textContent = "0 / 0";
        setProgressBar(precompileProgress, 0, 0, true);
        precompileStatus.textContent = "Preparazione dello snapshot…";
        if (snapshotStatus) snapshotStatus.textContent = "In attesa della scansione…";
        setProgressBar(snapshotProgress, 0, 0, true);
        resetPrecompileLog(message.outputDir);
        ["compiled", "blocked", "failed", "skipped", "cancelled"].forEach((key) => setCounter(key, 0));
        return;

      case "precompileSnapshotProgress":
        setProgressBar(snapshotProgress, message.scanned, message.total, message.phase !== "hashing");
        if (snapshotStatus) {
          snapshotStatus.textContent = message.phase === "hashing"
            ? `Hash ${message.scanned}/${message.total || 0} file esaminati…`
            : `Enumerazione snapshot: ${message.scanned} voci esaminate…`;
        }
        return;

      case "precompileProgress": {
        const total = message.total || 0;
        const settled = message.settled || 0;
        setProgressBar(precompileProgress, settled, Math.max(1, total), false);
        if (precompileRatio) precompileRatio.textContent = `${settled} / ${total}`;
        const statuses = {
          converting: "Compilando",
          compiled: "Compilato",
          blocked: "Bloccato",
          failed: "Errore",
          skipped: "Ignorato",
          cancelled: "Annullato",
        };
        const current = message.currentFile ? `: ${message.currentFile}` : "";
        precompileStatus.textContent = `${statuses[message.currentStatus] || "In elaborazione"}${current}`;
        if (snapshotStatus) snapshotStatus.textContent = `Snapshot pronto: ${total} file acquisiti.`;
        setProgressBar(snapshotProgress, total, Math.max(1, total), false);
        if (settled > lastLoggedSettled && message.latestResult) appendResult(message.latestResult);
        lastLoggedSettled = Math.max(lastLoggedSettled, settled);
        const counts = message.counts || {};
        setCounter("compiled", counts.compiled);
        setCounter("blocked", counts.blocked);
        setCounter("failed", counts.failed);
        setCounter("skipped", counts.skipped);
        setCounter("cancelled", counts.cancelled);
        updateReopenStatus();
        return;
      }

      case "precompileCancellationRequested":
        if (cancelPrecompile) cancelPrecompile.disabled = true;
        precompileStatus.textContent = message.message || "Annullamento richiesto.";
        return;

      case "precompileComplete": {
        const report = message.report || {};
        setPrecompileRunning(false);
        if (precompileTitle) precompileTitle.textContent = "Precompilazione completata";
        if (precompileRatio) precompileRatio.textContent = `${report.total || 0} / ${report.total || 0}`;
        setProgressBar(precompileProgress, report.total || 0, Math.max(1, report.total || 0), false);
        precompileStatus.textContent =
          `Completato: ${report.compiled || 0} compilati · ${report.blocked || 0} bloccati · ` +
          `${report.failed || 0} errori · ${report.skipped || 0} ignorati · ${report.cancelled || 0} annullati.`;
        if (snapshotStatus) snapshotStatus.textContent = `Snapshot completato: ${report.total || 0} file.`;
        setProgressBar(snapshotProgress, report.total || 0, Math.max(1, report.total || 0), false);
        setCounter("compiled", report.compiled);
        setCounter("blocked", report.blocked);
        setCounter("failed", report.failed);
        setCounter("skipped", report.skipped);
        setCounter("cancelled", report.cancelled);
        setReportLog(report);
        return;
      }

      case "precompileFailed":
        setPrecompileRunning(false);
        if (precompileTitle) precompileTitle.textContent = "Precompilazione non completata";
        precompileStatus.textContent = "Il job si è interrotto prima del riepilogo.";
        appendPrecompileLog(`[errore job] ${message.message || "Errore senza dettagli."}`);
        return;

      case "precompileCancelled":
        setPrecompileRunning(false);
        if (precompileTitle) precompileTitle.textContent = "Job annullato";
        precompileStatus.textContent = message.message || "Job annullato durante la preparazione dello snapshot.";
        appendPrecompileLog(`[job annullato] ${message.message || ""}`);
        return;
    }
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }

  vscode.postMessage({ command: "refresh" });
})();
