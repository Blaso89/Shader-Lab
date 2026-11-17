const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = path.join(__dirname, "..", "media", "dashboard.js");
const source = fs.readFileSync(sourcePath, "utf8");
const elements = new Map();
const postedMessages = [];
let messageHandler;

function createElement(id) {
  const listeners = new Map();
  const attributes = new Map();
  return {
    id,
    textContent: "",
    hidden: id === "precompile-screen" || id === "precompile-reopen",
    disabled: false,
    max: 1,
    value: 0,
    dataset: { action: id === "cancel-precompile" ? "cancelPrecompile" : undefined },
    className: "",
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    click() { listeners.get("click")?.(); },
    getAttribute(name) { return attributes.get(name); },
  };
}

const document = {
  querySelectorAll(selector) {
    if (selector === "[data-action]") return [getElement("cancel-precompile")];
    return [];
  },
  getElementById(id) { return getElement(id); },
};

function getElement(id) {
  if (!elements.has(id)) elements.set(id, createElement(id));
  return elements.get(id);
}

const window = {
  addEventListener(type, listener) {
    if (type === "message") messageHandler = listener;
  },
};

vm.runInNewContext(source, {
  acquireVsCodeApi: () => ({ postMessage: (message) => postedMessages.push(message) }),
  document,
  window,
  Math,
  Number,
});

function send(message) {
  messageHandler({ data: message });
}

assert.equal(postedMessages.length, 1);
assert.equal(postedMessages[0].command, "refresh");
send({ command: "precompileSelecting" });
assert.equal(getElement("shaderlab-dashboard").hidden, true);
assert.equal(getElement("precompile-screen").hidden, false);
assert.equal(getElement("start-precompile").disabled, true);
assert.equal(getElement("cancel-precompile").disabled, true);

send({ command: "precompileStarted", outputDir: "D:\\staging\\job-1" });
assert.match(getElement("precompile-details").textContent, /Output staging: D:\\staging\\job-1/);
send({ command: "precompileSnapshotProgress", phase: "hashing", scanned: 2, total: 4 });
assert.equal(getElement("snapshot-progress").max, 4);
assert.equal(getElement("snapshot-progress").value, 2);
assert.match(getElement("snapshot-status").textContent, /Hash 2\/4/);

const result = { file: "shader.dxil", status: "compiled", message: "Output verificato." };
const progress = {
  command: "precompileProgress",
  total: 4,
  settled: 1,
  currentFile: "shader.dxil",
  currentStatus: "compiled",
  latestResult: result,
  counts: { compiled: 1, blocked: 0, failed: 0, skipped: 0, cancelled: 0 },
};
send(progress);
send({ ...progress, currentStatus: "converting" });
assert.equal(getElement("precompile-ratio").textContent, "1 / 4");
assert.equal(getElement("precompile-progress").max, 4);
assert.equal(getElement("precompile-progress").value, 1);
assert.equal(getElement("pc-compiled").textContent, 1);
assert.equal((getElement("precompile-details").textContent.match(/shader\.dxil/g) || []).length, 1);

getElement("precompile-return").click();
assert.equal(getElement("shaderlab-dashboard").hidden, false);
assert.equal(getElement("precompile-reopen").hidden, false);
getElement("precompile-reopen-button").click();
assert.equal(getElement("precompile-screen").hidden, false);
getElement("cancel-precompile").click();
assert.equal(postedMessages.at(-1).command, "cancelPrecompile");
send({ command: "precompileCancellationRequested", message: "Annullamento richiesto." });
assert.equal(getElement("cancel-precompile").disabled, true);

send({
  command: "precompileComplete",
  report: {
    outputDir: "D:\\staging\\job-1",
    total: 4,
    compiled: 1,
    blocked: 1,
    failed: 0,
    skipped: 2,
    cancelled: 0,
    issues: [{ file: "blocked.dxil", status: "blocked", message: "Stage non supportato." }],
    omittedIssues: 0,
  },
});
assert.equal(getElement("start-precompile").disabled, false);
assert.equal(getElement("cancel-precompile").disabled, true);
assert.equal(getElement("precompile-title").textContent, "Precompilazione completata");
assert.match(getElement("precompile-details").textContent, /blocked\.dxil/);

getElement("precompile-return").click();
assert.equal(getElement("precompile-screen").hidden, true);
assert.equal(getElement("precompile-reopen").hidden, true);
send({ command: "precompileSelecting" });
send({ command: "precompileSelectionCancelled" });
assert.equal(getElement("shaderlab-dashboard").hidden, false);
assert.equal(getElement("precompile-reopen").hidden, true);
console.log("TUTTI I TEST DASHBOARD PRECOMPILAZIONE OK");
