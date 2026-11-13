const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER_ID = "sm6-to-sm5";

function resolveServerEntryFromDirectory(selectedDirectory) {
  const resolved = path.resolve(selectedDirectory);
  const root = path.basename(resolved).toLowerCase() === "dist"
    ? path.dirname(resolved)
    : resolved;
  const entry = path.join(root, "dist", "index.js");
  if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
    throw new Error("Server MCP compilato non trovato. Seleziona la cartella del progetto che contiene dist\\index.js.");
  }
  return { root, entry };
}

function vsCodeUserMcpConfigPath(appName, globalStorageDirectory, environment = process.env, homeDirectory = os.homedir()) {
  if (globalStorageDirectory) {
    let directory = path.resolve(globalStorageDirectory);
    while (path.dirname(directory) !== directory) {
      if (path.basename(directory).toLowerCase() === "globalstorage") {
        return path.join(path.dirname(directory), "mcp.json");
      }
      directory = path.dirname(directory);
    }
  }

  const appDirectory = appName.toLowerCase().includes("insiders") ? "Code - Insiders" : "Code";
  if (process.platform === "win32") {
    if (!environment.APPDATA) {
      throw new Error("APPDATA non disponibile. Impossibile determinare il profilo MCP di VS Code.");
    }
    return path.join(environment.APPDATA, appDirectory, "User", "mcp.json");
  }
  if (process.platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", appDirectory, "User", "mcp.json");
  }
  return path.join(environment.XDG_CONFIG_HOME || path.join(homeDirectory, ".config"), appDirectory, "User", "mcp.json");
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Il file MCP non è JSON valido; non è stato modificato: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("Il file MCP deve contenere un oggetto JSON; non è stato modificato.");
  if (parsed.servers !== undefined && !isRecord(parsed.servers)) {
    throw new Error("La proprietà servers non è un oggetto; il file MCP non è stato modificato.");
  }
  return parsed;
}

function isServerConfigured(configPath, serverEntry) {
  try {
    const config = readConfig(configPath);
    const args = config.servers?.[SERVER_ID]?.args;
    return Array.isArray(args) && args.some(
      (arg) => typeof arg === "string" && path.resolve(arg) === path.resolve(serverEntry),
    );
  } catch {
    return false;
  }
}

function getConfiguredServer(configPath) {
  const config = readConfig(configPath);
  const args = config.servers?.[SERVER_ID]?.args;
  const entry = Array.isArray(args)
    ? args.find((arg) => typeof arg === "string" && path.isAbsolute(arg))
    : undefined;
  if (!entry || !fs.existsSync(entry) || !fs.statSync(entry).isFile()) return undefined;
  const directory = path.dirname(entry);
  if (path.basename(directory).toLowerCase() !== "dist") return undefined;
  return resolveServerEntryFromDirectory(directory);
}

function updateVsCodeUserMcpConfig(configPath, serverRoot, serverEntry) {
  const resolvedConfig = path.resolve(configPath);
  const resolvedRoot = path.resolve(serverRoot);
  const resolvedEntry = path.resolve(serverEntry);
  if (!fs.existsSync(resolvedEntry) || !fs.statSync(resolvedEntry).isFile()) {
    throw new Error(`Server MCP non trovato: ${resolvedEntry}`);
  }

  const config = readConfig(resolvedConfig);
  const servers = isRecord(config.servers) ? config.servers : {};
  const previous = isRecord(servers[SERVER_ID]) ? servers[SERVER_ID] : {};
  const previousEnv = isRecord(previous.env) ? previous.env : {};
  const env = {};
  for (const [key, value] of Object.entries(previousEnv)) {
    if (typeof value === "string" && value.trim()) env[key] = value;
  }
  env.DXIL_SPIRV_PATH ||= "dxil-spirv";
  env.SPIRV_CROSS_PATH ||= "spirv-cross";

  const updated = {
    ...config,
    servers: {
      ...servers,
      [SERVER_ID]: {
        ...previous,
        type: "stdio",
        command: "node",
        args: [resolvedEntry],
        cwd: resolvedRoot,
        env,
      },
    },
  };
  const output = `${JSON.stringify(updated, null, 2)}\n`;
  const oldOutput = fs.existsSync(resolvedConfig) ? fs.readFileSync(resolvedConfig, "utf8") : undefined;
  if (oldOutput === output) {
    return { configPath: resolvedConfig, serverEntry: resolvedEntry, changed: false };
  }

  fs.mkdirSync(path.dirname(resolvedConfig), { recursive: true });
  let backupPath;
  if (oldOutput !== undefined) {
    backupPath = `${resolvedConfig}.bak-${new Date().toISOString().replace(/[-:.]/g, "")}`;
    fs.copyFileSync(resolvedConfig, backupPath, fs.constants.COPYFILE_EXCL);
  }
  const temporaryPath = `${resolvedConfig}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, output, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryPath, resolvedConfig);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
  return { configPath: resolvedConfig, serverEntry: resolvedEntry, backupPath, changed: true };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

module.exports = {
  SERVER_ID,
  getConfiguredServer,
  isServerConfigured,
  resolveServerEntryFromDirectory,
  updateVsCodeUserMcpConfig,
  vsCodeUserMcpConfigPath,
};
