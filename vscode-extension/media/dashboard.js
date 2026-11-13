(function () {
  const vscode = acquireVsCodeApi();
  const status = document.getElementById("server-status");

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      vscode.postMessage({ command: button.dataset.action });
    });
  });

  document.getElementById("refresh").addEventListener("click", () => {
    vscode.postMessage({ command: "refresh" });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.command !== "status") return;

    setText("server-entry", message.serverReady ? "Compilato" : "Non trovato");
    setText("mcp-config", message.mcpConfigured ? "Allineato" : "Da configurare");
    setText("server-root", message.serverRoot || "Non selezionato");
    setText("mcp-config-path", message.mcpConfigPath || "Non rilevato");
    const toolchain = message.pixToolchain || {};
    setText("pix-tool-path", toolchain.pixToolPath || "Autodiscovery");
    setText("dxc-path", toolchain.dxcPath || "Autodiscovery");
    setText("powershell-path", toolchain.powerShellPath || "Autodiscovery");

    status.textContent = message.serverReady && message.mcpConfigured
      ? "Server allineato"
      : "MCP da configurare";
    status.className = "status " + (message.serverReady && message.mcpConfigured ? "ready" : "warning");
  });

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }

  vscode.postMessage({ command: "refresh" });
})();
