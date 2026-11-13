const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SERVER_ID,
  getConfiguredServer,
  isServerConfigured,
  resolveServerEntryFromDirectory,
  updateVsCodeUserMcpConfig,
  vsCodeUserMcpConfigPath,
} = require("../mcp-config");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sm6-to-sm5-mcp-"));

try {
  const projectRoot = path.join(temporaryRoot, "sm6-to-sm5-mcp");
  const entry = path.join(projectRoot, "dist", "index.js");
  const configPath = path.join(temporaryRoot, "Code", "User", "mcp.json");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "process.exit(0);\n");

  assert.deepEqual(resolveServerEntryFromDirectory(projectRoot), { root: projectRoot, entry });
  assert.deepEqual(resolveServerEntryFromDirectory(path.dirname(entry)), { root: projectRoot, entry });

  const original = {
    customSetting: true,
    servers: {
      "ghidra-analysis-manager": { type: "stdio", command: "node", args: ["ghidra.js"] },
    },
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(original, null, 2));
  const result = updateVsCodeUserMcpConfig(configPath, projectRoot, entry);
  const updated = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(result.changed, true);
  assert.ok(result.backupPath);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backupPath, "utf8")), original);
  assert.deepEqual(updated.servers["ghidra-analysis-manager"], original.servers["ghidra-analysis-manager"]);
  assert.equal(updated.customSetting, true);
  assert.deepEqual(updated.servers[SERVER_ID], {
    type: "stdio",
    command: "node",
    args: [entry],
    cwd: projectRoot,
    env: { DXIL_SPIRV_PATH: "dxil-spirv", SPIRV_CROSS_PATH: "spirv-cross" },
  });
  assert.equal(isServerConfigured(configPath, entry), true);
  assert.deepEqual(getConfiguredServer(configPath), { root: projectRoot, entry });

  const repeat = updateVsCodeUserMcpConfig(configPath, projectRoot, entry);
  assert.equal(repeat.changed, false);
  assert.equal(repeat.backupPath, undefined);

  const malformedPath = path.join(temporaryRoot, "malformed.json");
  fs.writeFileSync(malformedPath, "{invalid");
  assert.throws(() => updateVsCodeUserMcpConfig(malformedPath, projectRoot, entry), /non è JSON valido/);
  assert.throws(() => getConfiguredServer(malformedPath), /non è JSON valido/);
  assert.equal(fs.readFileSync(malformedPath, "utf8"), "{invalid");

  const profileStorage = path.join(temporaryRoot, "User", "profiles", "profile-a", "globalStorage", "publisher.extension");
  assert.equal(
    vsCodeUserMcpConfigPath("Visual Studio Code", profileStorage),
    path.join(temporaryRoot, "User", "profiles", "profile-a", "mcp.json"),
  );
  assert.equal(
    vsCodeUserMcpConfigPath(
      "Visual Studio Code",
      undefined,
      { APPDATA: path.join(temporaryRoot, "Roaming") },
      temporaryRoot,
    ),
    path.join(temporaryRoot, "Roaming", "Code", "User", "mcp.json"),
  );

  assert.throws(
    () => resolveServerEntryFromDirectory(path.join(temporaryRoot, "missing")),
    /dist\\index.js/,
  );
  console.log("TUTTI I TEST MCP CONFIG OK");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
