#!/usr/bin/env node
/**
hela-package-gate — gate offline di completezza del package candidato Hela (P0-1).
Contratto: un package e' consumabile da ProxyManager solo se
runtime/d3d12.dll e runtime/dxgi.dll esistono su disco E sono dichiarati nel manifest;
l'inventario degli override corrisponde ESATTAMENTE al manifest
(biiezione path/id, hash SHA-256 uguali, nessun file extra in overrides/).
Garanzie:
solo staging: scrive esclusivamente dentro la directory di staging;
nessun install, nessun caricamento di DLL, nessun processo figlio, nessuna rete;
lifecycle sempre "staged-only": la promozione a runtime richiede autorizzazione separata;
fallimento atomico: inventario scritto solo se ok; inventario stale rimosso se il gate fallisce.
Node >= 18 (consigliato >= 20). ESM, zero dipendenze.
*/
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const TOOL_VERSION = "0.1.0";
export const MANIFEST_FILE = "candidate-package.json";
export const INVENTORY_FILE = "override-inventory.json";
export const REPORT_FILE = "package-report.json";
export const REQUIRED_RUNTIME = Object.freeze(["runtime/d3d12.dll", "runtime/dxgi.dll"]);
export const OVERRIDES_PREFIX = "overrides/";
const SHA256_RE = /^[0-9a-f]{64}$/;
/** Normalizza un path relativo del manifest (accetta backslash Windows); rifiuta path non sicuri. */
export function normalizeRelPath(raw) {
if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "empty" };
if (raw.includes("\u0000")) return { ok: false, reason: "nul" };
const p = raw.replaceAll("\\", "/");
if (p.startsWith("/")) return { ok: false, reason: "absolute" };
if (/^[A-Za-z]:/.test(p)) return { ok: false, reason: "drive-letter" };
const segs = p.split("/");
if (segs.some((s) => s.length === 0 || s === "." || s === "..")) {
return { ok: false, reason: "unsafe-segment" };
}
return { ok: true, value: segs.join("/") };
}
export function sha256Bytes(buf) {
return createHash("sha256").update(buf).digest("hex");
}
async function measureFile(absPath) {
const buf = await readFile(absPath);
return { sha256: sha256Bytes(buf), bytes: buf.length };
}
/** Elenca ricorsivamente i file sotto absDir (rel paths con prefisso); false se la dir non esiste. */
async function walkFiles(absDir, relPrefix, out) {
let entries;
try {
entries = await readdir(absDir, { withFileTypes: true });
} catch (err) {
if (err && err.code === "ENOENT") return false;
throw err;
}
entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
for (const e of entries) {
const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
const abs = path.join(absDir, e.name);
if (e.isDirectory()) await walkFiles(abs, rel, out);
else if (e.isFile()) out.push(rel);
}
return true;
}
function byPath(a, b) {
return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
/** JSON deterministico dell'inventario: nessun timestamp, ordinamento a monte. */
function inventoryJson(entries, packageId) {
return JSON.stringify({ schemaVersion: 1, packageId, overrides: entries }, null, 2) + "\n";
}
/** Confronto semantico inventario esistente vs atteso (biiezione path/id + hash + bytes). */
function sameInventory(existing, expected, packageId) {
if (typeof existing !== "object" || existing === null) return false;
if (existing.schemaVersion !== 1 || existing.packageId !== packageId) return false;
if (!Array.isArray(existing.overrides) || existing.overrides.length !== expected.length) return false;
if (existing.overrides.some((x) => typeof x !== "object" || x === null)) return false;
const sorted = [...existing.overrides].sort(byPath);
for (let i = 0; i < expected.length; i++) {
const a = sorted[i];
const b = expected[i];
if (a.id !== b.id || a.path !== b.path || a.sha256 !== b.sha256 || a.bytes !== b.bytes) return false;
}
return true;
}
/**
Esegue il gate sullo staging.
mode "build" (default): scrive override-inventory.json (solo se ok) e package-report.json.
mode "check": read-only; verifica anche che l'inventario esistente corrisponda al manifest.
Non scrive mai fuori da stagingDir, non carica DLL, non avvia processi, non usa rete.
*/
export async function runPackageGate(stagingDir, opts = {}) {
const mode = opts.mode === "check" ? "check" : "build";
const absStage = path.resolve(stagingDir);
const issues = [];
const warnings = [];
const add = (code, message, extra = {}) => issues.push({ code, message, ...extra });
const warn = (code, message, extra = {}) => warnings.push({ code, message, ...extra });
const report = {
schemaVersion: 1,
tool: "hela-package-gate",
toolVersion: TOOL_VERSION,
mode,
stagingDir: absStage,
packageId: null,
ok: false,
lifecycle: "staged-only",
installed: false,
networkUsed: false,
generatedAt: new Date().toISOString(),
manifestSha256: null,
runtime: [],
inventory: null,
issues,
warnings,
};
let expectedInventory = null;
async function finalize() {
if (mode === "check" && expectedInventory && issues.length === 0) {
let existingRaw = null;
try {
existingRaw = await readFile(path.join(absStage, INVENTORY_FILE), "utf8");
} catch (err) {
if (!err || err.code !== "ENOENT") throw err;
}
if (existingRaw === null) {
add("INVENTORY_MISSING", `${INVENTORY_FILE} assente: package non verificabile`);
} else {
let parsed = null;
try { parsed = JSON.parse(existingRaw); } catch { /* trattato come mismatch */ }
if (!parsed || !sameInventory(parsed, expectedInventory, report.packageId)) {
add("INVENTORY_MISMATCH", "l'inventario esistente non e' valido o non corrisponde esattamente al manifest");
} else {
report.inventory = {
path: INVENTORY_FILE,
sha256: sha256Bytes(Buffer.from(existingRaw, "utf8")),
entryCount: expectedInventory.length,
};
}
}
}
report.ok = issues.length === 0;
if (mode === "build") {
const invPath = path.join(absStage, INVENTORY_FILE);
if (report.ok) {
const json = inventoryJson(expectedInventory ?? [], report.packageId);
await writeFile(invPath, json, "utf8");
report.inventory = {
path: INVENTORY_FILE,
sha256: sha256Bytes(Buffer.from(json, "utf8")),
entryCount: (expectedInventory ?? []).length,
};
} else {
// Mai lasciare un inventario consumabile quando il gate fallisce.
try {
await rm(invPath);
report.staleInventoryRemoved = true;
} catch (err) {
if (!err || err.code !== "ENOENT") throw err;
}
}
try {
await writeFile(path.join(absStage, REPORT_FILE), JSON.stringify(report, null, 2) + "\n", "utf8");
} catch (err) {
if (!err || err.code !== "ENOENT") throw err;
}
}
return report;
}
// 1) Manifest.
let manifestRaw;
try {
manifestRaw = await readFile(path.join(absStage, MANIFEST_FILE));
} catch (err) {
if (err && err.code === "ENOENT") add("MANIFEST_MISSING", `${MANIFEST_FILE} assente nello staging`);
else add("IO_ERROR", `lettura manifest fallita: ${err && err.message ? err.message : err}`);
return finalize();
}
report.manifestSha256 = sha256Bytes(manifestRaw);
let manifest;
try {
manifest = JSON.parse(manifestRaw.toString("utf8"));
} catch {
add("MANIFEST_INVALID", "manifest non e' JSON valido");
return finalize();
}
if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
add("MANIFEST_INVALID", "manifest deve essere un oggetto");
return finalize();
}
if (manifest.schemaVersion !== 1) add("MANIFEST_INVALID", "schemaVersion deve essere 1");
if (typeof manifest.packageId !== "string" || manifest.packageId.length === 0) {
add("MANIFEST_INVALID", "packageId mancante");
} else {
report.packageId = manifest.packageId;
}
if (!Array.isArray(manifest.runtime)) add("MANIFEST_INVALID", "runtime deve essere un array");
if (!Array.isArray(manifest.overrides)) add("MANIFEST_INVALID", "overrides deve essere un array");
if (issues.length > 0) return finalize();
// 2) Normalizzazione entry (path safety, hash/bytes opzionali ben formati, unicita').
const seenPaths = new Set();
const seenIds = new Set();
function normalizeEntry(e, label) {
if (typeof e !== "object" || e === null) {
add("MANIFEST_INVALID", `${label}: entry non valida`);
return null;
}
const n = normalizeRelPath(e.path);
if (!n.ok) {
add("UNSAFE_PATH", `${label}: path non sicuro (${n.reason})`, { path: String(e.path) });
return null;
}
if (seenPaths.has(n.value)) add("DUPLICATE_PATH", `${label}: path duplicato`, { path: n.value });
seenPaths.add(n.value);
if (e.sha256 !== undefined && (typeof e.sha256 !== "string" || !SHA256_RE.test(e.sha256))) {
add("MANIFEST_INVALID", `${label}: sha256 deve essere hex lowercase di 64 caratteri`, { path: n.value });
return null;
}
if (e.bytes !== undefined && (!Number.isInteger(e.bytes) || e.bytes < 0)) {
add("MANIFEST_INVALID", `${label}: bytes deve essere un intero >= 0`, { path: n.value });
return null;
}
return { path: n.value, declaredSha256: e.sha256 ?? null, declaredBytes: e.bytes ?? null };
}
const runtimeEntries = [];
manifest.runtime.forEach((e, i) => {
const en = normalizeEntry(e, `runtime[${i}]`);
if (en) runtimeEntries.push(en);
});
const overrideEntries = [];
manifest.overrides.forEach((e, i) => {
const en = normalizeEntry(e, `overrides[${i}]`);
if (!en) return;
if (typeof e.id !== "string" || e.id.length === 0) {
add("MANIFEST_INVALID", `overrides[${i}]: id mancante`, { path: en.path });
return;
}
if (seenIds.has(e.id)) {
add("DUPLICATE_ID", `overrides[${i}]: id duplicato`, { id: e.id });
return;
}
seenIds.add(e.id);
if (!en.path.startsWith(OVERRIDES_PREFIX)) {
add("INVALID_OVERRIDE_LOCATION", `gli override devono stare sotto ${OVERRIDES_PREFIX}`, { path: en.path });
return;
}
en.id = e.id;
overrideEntries.push(en);
});
// 3) I runtime richiesti dal contratto ProxyManager devono essere dichiarati.
const runtimeByPath = new Set(runtimeEntries.map((e) => e.path));
for (const req of REQUIRED_RUNTIME) {
if (!runtimeByPath.has(req)) {
add("RUNTIME_NOT_DECLARED", `manifest.runtime non dichiara ${req}`, { path: req });
}
}
// 4) Misura su disco: presenza, hash, dimensione.
async function measure(entry, kind) {
let m;
try {
m = await measureFile(path.join(absStage, entry.path));
} catch (err) {
if (err && err.code === "ENOENT") {
add(kind === "runtime" ? "MISSING_RUNTIME" : "MISSING_OVERRIDE",
`file richiesto assente: ${entry.path}`, { path: entry.path });
} else {
add("IO_ERROR", `lettura fallita: ${entry.path} (${err && err.message ? err.message : err})`, { path: entry.path });
}
return null;
}
if (entry.declaredSha256 !== null && entry.declaredSha256 !== m.sha256) {
add("HASH_MISMATCH", `hash diverso dal manifest: ${entry.path}`,
{ path: entry.path, expected: entry.declaredSha256, actual: m.sha256 });
}
if (entry.declaredBytes !== null && entry.declaredBytes !== m.bytes) {
add("SIZE_MISMATCH", `dimensione diversa dal manifest: ${entry.path}`,
{ path: entry.path, expected: entry.declaredBytes, actual: m.bytes });
}
return m;
}
for (const e of runtimeEntries) {
const m = await measure(e, "runtime");
if (m) report.runtime.push({ path: e.path, sha256: m.sha256, bytes: m.bytes });
}
report.runtime.sort(byPath);
const expected = [];
for (const e of overrideEntries) {
const m = await measure(e, "override");
if (m) expected.push({ id: e.id, path: e.path, sha256: m.sha256, bytes: m.bytes });
}
expected.sort(byPath);
expectedInventory = expected;
// 5) Corrispondenza esatta: nessun file in overrides/ fuori manifest.
const diskOverrides = [];
await walkFiles(path.join(absStage, "overrides"), "overrides", diskOverrides);
const declaredOverrides = new Set(overrideEntries.map((e) => e.path));
for (const rel of diskOverrides) {
if (!declaredOverrides.has(rel)) {
add("INVENTORY_EXTRA", `file in overrides/ non dichiarato nel manifest: ${rel}`, { path: rel });
}
}
if (overrideEntries.length === 0) {
warn("EMPTY_OVERRIDES", "package senza override: valido solo come baseline runtime-only");
}
// Extra in runtime/ non dichiarati: warning non bloccante (es. pdb).
const diskRuntime = [];
await walkFiles(path.join(absStage, "runtime"), "runtime", diskRuntime);
for (const rel of diskRuntime) {
if (!runtimeByPath.has(rel)) {
warn("RUNTIME_UNDECLARED", `file in runtime/ non dichiarato nel manifest: ${rel}`, { path: rel });
}
}
return finalize();
}
// CLI minimale: nessun processo figlio, nessuna rete.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
const args = process.argv.slice(2);
const check = args.includes("--check");
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) {
console.error("uso: node package-gate.mjs <stagingDir> [--check]");
process.exit(2);
}
runPackageGate(dir, { mode: check ? "check" : "build" })
.then((r) => {
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
})
.catch((err) => {
console.error(`errore: ${err && err.message ? err.message : err}`);
process.exit(2);
});
}
