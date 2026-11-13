const fs = require("node:fs");
const path = require("node:path");

function findWindowLogDirectory(logPath) {
  let directory = path.resolve(logPath);
  while (true) {
    if (/^window\d+$/i.test(path.basename(directory))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function parseMcpServerLogFileName(fileName, serverName) {
  const prefix = "mcpServer.";
  const suffix = ".log";
  if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) return undefined;
  const definitionId = fileName.slice(prefix.length, -suffix.length);
  return definitionId.endsWith(`.${serverName}`) ? definitionId : undefined;
}

function parseMcpConnectionState(contents) {
  let state;
  for (const line of contents.split(/\r?\n/)) {
    const match = /(?:Stato connessione|Connection state):\s*(.+?)\s*$/i.exec(line);
    if (match) {
      const value = match[1].trim().toLowerCase();
      if (value === "arrestato" || value === "stopped") state = "disconnected";
      else if (value === "avvio" || value === "starting") state = "starting";
      else if (value === "in esecuzione" || value === "running") state = "connected";
      else if (value === "errore" || value === "error") state = "disconnected";
    } else if (/Starting server from LocalProcess extension host/i.test(line)) {
      state = "starting";
    } else if (/Discovered \d+ tools/i.test(line)) {
      state = "connected";
    }
  }
  return state;
}

function createMcpServerLogMonitor(logPath, serverName, onState, onError = console.error) {
  const logDirectory = findWindowLogDirectory(logPath);
  if (!logDirectory) {
    throw new Error(`Percorso log VS Code non riconosciuto: ${logPath}`);
  }

  let lastState;
  let lastDefinitionId;
  let refreshTimer;
  let disposed = false;

  function refresh() {
    const candidates = [];
    for (const entry of fs.readdirSync(logDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const definitionId = parseMcpServerLogFileName(entry.name, serverName);
      if (!definitionId) continue;

      try {
        const filePath = path.join(logDirectory, entry.name);
        candidates.push({ definitionId, filePath, modifiedAt: fs.statSync(filePath).mtimeMs });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }

    candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
    const latest = candidates[0];
    if (!latest) {
      if (lastDefinitionId) {
        lastDefinitionId = undefined;
        lastState = "unknown";
        onState(lastState, undefined);
      }
      return;
    }

    let contents;
    try {
      contents = fs.readFileSync(latest.filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    const state = parseMcpConnectionState(contents) || "unknown";
    if (state !== lastState || latest.definitionId !== lastDefinitionId) {
      lastState = state;
      lastDefinitionId = latest.definitionId;
      onState(state, latest.definitionId);
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (disposed) return;
      try {
        refresh();
      } catch (error) {
        onError(error);
      }
    }, 50);
  }

  const watcher = fs.watch(logDirectory, (eventType, fileName) => {
    if (fileName && !parseMcpServerLogFileName(String(fileName), serverName)) return;
    scheduleRefresh();
  });
  watcher.on("error", onError);

  try {
    refresh();
  } catch (error) {
    onError(error);
  }

  return {
    dispose() {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      watcher.close();
    },
  };
}

module.exports = {
  createMcpServerLogMonitor,
  findWindowLogDirectory,
  parseMcpConnectionState,
  parseMcpServerLogFileName,
};
