import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as dxilAnalyzer from "./dxil-analyzer.js";
import {
  analyzeDisasm,
  analyzeFiles,
  compareShaderSignatures,
  formatReport,
  parseInputSignature,
  parseOutputSignature,
  type SigElement,
} from "./dxil-analyzer.js";
import { convertDxilToHlsl, fnv1a64 } from "./dxil-precompile.js";
import { findFxc, run, type RunResult } from "./external.js";
import { analyzeBmpFile, type BmpPixelAnalysis } from "./hela-bmp.js";
import {
  parseHelaProxyLogFile,
  TARGET_INPUT_LAYOUT_DIAGNOSTIC_VS,
  type ExecutedGraphicsPair,
  type HelaProxyLogReport,
  type RankedPlaceholderShader,
  type ReadbackDrawCorrelationAssessment,
  type SampledReadbackRecord,
  type TargetInputLayoutElement,
} from "./hela-log-parser.js";

export interface HelaLaunchProfile {
  name: string;
  sha256: string;
  environment: Record<string, string>;
  arguments: string[];
  attestation: {
    maskedNvidiaAdapter?: boolean;
    tiledResourcesTier?: number;
    callerTrace?: boolean;
  };
}

export interface HelaRunManifestV1 {
  schema: "hela-run-manifest/v1";
  runtimeAttestation: "module-and-shader-sha256";
  testVersion: string;
  runtime: {
    d3d12: string;
    dxgi: string;
  };
  overrides: Record<string, string>;
  requiredOverrides: string[];
  launchProfile?: HelaLaunchProfile;
}

export type ShaderStageOutcome =
  | "pair-validated"
  | "compiled-candidate"
  | "compiled-unpaired"
  | "pair-incomplete"
  | "pair-conflict"
  | "pair-failed"
  | "input-layout-failed"
  | "blocked"
  | "failed"
  | "skipped";

export interface StagedShaderEntry {
  hash: string;
  stage: string;
  inputPath: string;
  disasmPath?: string;
  autoDisassembled: boolean;
  status: ShaderStageOutcome;
  includedInManifest: boolean;
  csoPath?: string;
  csoSha256?: string;
  sharedByMultipleVs: boolean;
  pairedVsHashes: string[];
  validatedAgainstVs: string[];
  missingPairedVsDisasm: string[];
  missingPairedVsCso: string[];
  inputLayoutCheck: "diagnostic-vs-passed" | "diagnostic-vs-failed" | "not-covered-by-proxy-log";
  registerMap: Array<{ from: string; to: string }>;
  warnings: string[];
  message: string;
}

export interface BuildHelaStageOptions {
  dumpDir: string;
  stagingDir: string;
  logPath?: string;
  baselineManifestPath?: string;
  baselineOverridesDir?: string;
  runtimeDir?: string;
  bindingMapPath?: string;
  testVersion?: string;
  autoDisassemble?: boolean;
  requirePairValidationForPs?: boolean;
  enableDumpInCandidateManifest?: boolean;
  /** Se true, aggiunge i nuovi candidati validati anche a `requiredOverrides` (preservando sempre quelli del baseline). Default: false. */
  addNewCandidatesToRequiredOverrides?: boolean;
  onlyHashes?: string[];
  dxcPath?: string;
}

export interface BuildHelaStageDependencies {
  converter?: typeof convertDxilToHlsl;
  runner?: typeof run;
  fxcPath?: () => string;
  dxcPath?: () => string;
  packageGate?: (stagingDir: string, opts?: { mode?: "build" | "check" }) => Promise<HelaPackageGateReport>;
}

export interface BuildHelaStageReport {
  stagingDir: string;
  overridesDir: string;
  manifestPath?: string;
  reportJsonPath: string;
  reportMarkdownPath: string;
  logAnalyzed: boolean;
  counts: Record<ShaderStageOutcome, number>;
  baselineOverridesPreserved: number;
  newCandidatesIncluded: number;
  unmappedRegisterSpaces: Array<{ hash: string; stage: string; bindings: string[] }>;
  entries: StagedShaderEntry[];
  packageGate?: HelaPackageGateReport;
  disclaimer: string;
}

export interface HelaPackageGateReport {
  schemaVersion: number;
  tool: string;
  toolVersion: string;
  mode: "build" | "check";
  stagingDir: string;
  packageId: string | null;
  ok: boolean;
  lifecycle: "staged-only";
  installed: boolean;
  networkUsed: boolean;
  issues: Array<{ code: string; message: string; [key: string]: unknown }>;
  warnings: Array<{ code: string; message: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface PlanManifestPatchOptions {
  baselineManifestPath: string;
  stagingOverridesDir: string;
  outManifestPath: string;
  testVersion: string;
  dumpShaders?: boolean;
  addNewCandidatesToRequiredOverrides?: boolean;
}

export interface PlanManifestPatchResult {
  written: string;
  testVersion: string;
  baselineOverrideCount: number;
  totalOverrides: number;
  addedOverrides: string[];
  unchangedBaselineOverrides: number;
  requiredOverridesCount: number;
  launchProfileSha256?: string;
  disclaimer: string;
}

export type HelaRunVerdict =
  | "attestation-failed"
  | "present-not-reached"
  | "present-reached-readback-missing"
  | "present-reached-black-readback"
  | "present-reached-nonzero-pixels-observed";

export interface VerifyHelaRunOptions {
  runDir: string;
  logPath?: string;
  manifestPath?: string;
  bmpPaths?: string[];
  targetPresent?: number;
}

export interface VerifyHelaRunReport {
  runDir: string;
  verdict: HelaRunVerdict;
  testVersion?: string;
  attestationPassed: boolean;
  attestationFailures: string[];
  missingRequiredOverrides: string[];
  presentStatus: {
    reached: boolean;
    maxObservedPresent: number;
    maxHeartbeatPresent: number;
    maxReadbackPresent: number;
    targetPresent?: number;
    targetPresentReached?: boolean;
  };
  bmpReadbackStatus: "missing" | "invalid" | "black-readback" | "nonzero-pixels-observed";
  bmpPathsNotMatchingTarget: string[];
  bmps: BmpPixelAnalysis[];
  sampledReadbacksFromLog: SampledReadbackRecord[];
  /**
   * L'analisi BMP automatica non dimostra mai da sola che il menu sia renderizzato correttamente:
   * pixel non neri possono provenire da loghi pre-menu, clear, artefatti o altri pass.
   */
  menuValidated: false;
  menuValidationBoundary: string;
  logSummary: HelaProxyLogReport["summary"];
  executedGraphicsPairs: ExecutedGraphicsPair[];
  readbackCorrelations: ReadbackDrawCorrelationAssessment[];
  placeholdersPreview: RankedPlaceholderShader[];
  explanation: string;
}

const PROFILE_BY_STAGE: Record<string, string> = {
  vs: "vs_5_0",
  ps: "ps_5_0",
  gs: "gs_5_0",
  hs: "hs_5_0",
  ds: "ds_5_0",
  cs: "cs_5_0",
};

const STAGE_ORDER: Record<string, number> = {
  vs: 0,
  cs: 1,
  gs: 2,
  hs: 3,
  ds: 4,
  ps: 5,
};

const CANDIDATE_DISCLAIMER =
  "La compilazione FXC e la validazione delle firme VS/PS non dimostrano equivalenza semantica né rendering corretto: " +
  "gli output restano candidati di staging finché non superano ProxyManager.ps1 e una run Hela autorizzata con readback correlato.";

const MENU_VALIDATION_BOUNDARY =
  "Pixel non neri osservati in un BMP readback NON equivalgono a menu validato: " +
  "occorrono correlazione causale draw/risorsa sul path del backbuffer e ispezione visiva della schermata di menu.";

const HEX64 = /^[0-9a-fA-F]{64}$/;
const CSO_NAME = /^[^\\/:*?"<>|]+\.cso$/i;
const PROTECTED_PATH_SEGMENTS = ["d3d12on11patch", "binaries\\win64", "binaries/win64"];

export function sha256Buffer(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Replica esatta di `Get-LaunchEnvironmentSha256` in `ProxyManager.ps1`:
 * ordina le chiavi `D3D12ON11_*`, formatta `KEY=VALUE\n`, calcola SHA-256 hex lowercase.
 */
export function computeLaunchEnvironmentSha256(environment: Record<string, string>): string {
  const keys = Object.keys(environment).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "case" }));
  const canonical = keys.map((k) => `${k}=${environment[k]}`).join("\n") + "\n";
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Cerca dxc.exe: override esplicito, DXC_PATH, Windows SDK, poi PATH. */
export function findDxc(overridePath?: string): string {
  if (overridePath?.trim()) return overridePath.trim();
  if (process.env.DXC_PATH) return process.env.DXC_PATH;
  if (process.platform === "win32") {
    for (const root of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]) {
      if (!root) continue;
      const bin = path.join(root, "Windows Kits", "10", "bin");
      if (!fs.existsSync(bin)) continue;
      const vers = fs.readdirSync(bin).filter((v) => /^10\./.test(v)).sort().reverse();
      for (const v of vers) {
        const p = path.join(bin, v, "x64", "dxc.exe");
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return "dxc";
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function defaultHelaPackageGate(
  stagingDir: string,
  opts: { mode?: "build" | "check" } = {},
): Promise<HelaPackageGateReport> {
  const gateCandidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tools/hela-package/package-gate.mjs"),
    path.resolve(process.cwd(), "tools/hela-package/package-gate.mjs"),
  ];
  const gatePath = gateCandidates.find((candidate) => fs.existsSync(candidate));
  if (!gatePath) {
    throw new Error("Gate package Hela non trovato: tools/hela-package/package-gate.mjs.");
  }
  const gateModule = await import(pathToFileURL(gatePath).href) as unknown as {
    runPackageGate: (dir: string, options?: { mode?: "build" | "check" }) => Promise<HelaPackageGateReport>;
  };
  return gateModule.runPackageGate(stagingDir, opts);
}

function assertNotProtectedGamePath(targetPath: string, role: string): void {
  const normalized = path.resolve(targetPath).toLowerCase();
  for (const segment of PROTECTED_PATH_SEGMENTS) {
    if (normalized.includes(segment)) {
      throw new Error(`Rifiutato ${role} dentro percorso protetto del gioco/proxy (${segment}): ${targetPath}`);
    }
  }
}

export function readAndValidateManifest(manifestPath: string): HelaRunManifestV1 {
  const resolved = path.resolve(manifestPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Manifest non trovato: ${resolved}`);
  }
  const manifestText = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
  const manifest = JSON.parse(manifestText) as HelaRunManifestV1;
  if (
    manifest.schema !== "hela-run-manifest/v1" ||
    manifest.runtimeAttestation !== "module-and-shader-sha256" ||
    !manifest.testVersion?.trim() ||
    !manifest.runtime ||
    !HEX64.test(manifest.runtime.d3d12 ?? "") ||
    !HEX64.test(manifest.runtime.dxgi ?? "") ||
    !manifest.overrides ||
    !Array.isArray(manifest.requiredOverrides)
  ) {
    throw new Error(`Manifest non valido rispetto a hela-run-manifest/v1: ${resolved}`);
  }
  for (const [name, hash] of Object.entries(manifest.overrides)) {
    if (!CSO_NAME.test(name) || !HEX64.test(hash)) {
      throw new Error(`Voce override non valida nel manifest (${name}): ${resolved}`);
    }
  }
  for (const req of manifest.requiredOverrides) {
    if (!manifest.overrides[req]) {
      throw new Error(`requiredOverride '${req}' non presente in overrides: ${resolved}`);
    }
  }
  if (manifest.launchProfile !== undefined) {
    const profile = manifest.launchProfile;
    if (
      !profile ||
      typeof profile.name !== "string" ||
      !profile.name.trim() ||
      !HEX64.test(profile.sha256 ?? "") ||
      !profile.environment ||
      typeof profile.environment !== "object" ||
      Array.isArray(profile.environment) ||
      Object.entries(profile.environment).some(
        ([name, value]) => !/^D3D12ON11_/i.test(name) || typeof value !== "string",
      ) ||
      !Array.isArray(profile.arguments) ||
      profile.arguments.some((arg) => typeof arg !== "string") ||
      !profile.attestation ||
      typeof profile.attestation !== "object" ||
      Array.isArray(profile.attestation)
    ) {
      throw new Error(`launchProfile non valido nel manifest: ${resolved}`);
    }
    const actualSha = computeLaunchEnvironmentSha256(profile.environment);
    if (actualSha.toLowerCase() !== profile.sha256.toLowerCase()) {
      throw new Error(
        `launchProfile fingerprint mismatch nel manifest: atteso ${profile.sha256}, calcolato ${actualSha}`,
      );
    }
  }
  return manifest;
}

function findExistingDisasm(inputPath: string): string | undefined {
  const parsed = path.parse(inputPath);
  const candidates = [
    path.join(parsed.dir, `${parsed.name}_dxil.txt`),
    `${inputPath}.txt`,
  ];
  return candidates.find((c) => fs.existsSync(c));
}

function walkShaderFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
        stack.push(full);
      } else if (entry.isFile() && [".dxil", ".cso"].includes(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function normalizeVsOutputSigKey(sig: SigElement[]): string {
  return sig
    .filter((e) => e.sysValue.toUpperCase() === "NONE" && e.register !== null)
    .map((e) => `${e.register}:${e.name.toUpperCase()}${e.index}:${(e.mask ?? "").toLowerCase()}:${(e.format ?? "").toLowerCase()}`)
    .sort()
    .join("|");
}

function checkVsAgainstDiagnosticInputLayout(
  vsInputSig: SigElement[],
  targetElements: TargetInputLayoutElement[],
): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const targetSemantics = new Set(
    targetElements.map((e) => `${e.semantic.toUpperCase()}${e.semanticIndex}`),
  );
  for (const input of vsInputSig) {
    if (input.sysValue.toUpperCase() !== "NONE") continue;
    const key = `${input.name.toUpperCase()}${input.index}`;
    if (!targetSemantics.has(key)) {
      mismatches.push(`VS richiede input ${input.name}${input.index}, assente in [TARGET_INPUT_LAYOUT] diagnostico.`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pipeline PSO-aware in staging isolato che riusa `convertDxilToHlsl`, `fnv1a64`,
 * `analyzeFiles`, `compareShaderSignatures`, `findFxc` e `run` di Shader Lab.
 *
 * Regole fail-closed:
 * - Non sovrascrive mai `stagingDir` esistente né scrive dentro percorsi di input o del gioco.
 * - Un PS condiviso da più VS (o abbinato a uno o più VS) è `pair-validated` SOLO se TUTTI
 *   i VS abbinati hanno disassemblato + `.cso` verificati e firme compatibili; altrimenti
 *   diventa `pair-incomplete`, `pair-conflict` o `pair-failed` ed è escluso dal manifest.
 * - Preserva sempre 100% degli hash `overrides` e `requiredOverrides` del baseline manifest.
 */
export async function buildHelaOverrideStage(
  options: BuildHelaStageOptions,
  deps: BuildHelaStageDependencies = {},
): Promise<BuildHelaStageReport> {
  const dumpDir = path.resolve(options.dumpDir);
  const stagingDir = path.resolve(options.stagingDir);
  assertNotProtectedGamePath(stagingDir, "stagingDir");

  if (!fs.existsSync(dumpDir) || !fs.statSync(dumpDir).isDirectory()) {
    throw new Error(`Cartella dump DXIL non valida: ${dumpDir}`);
  }
  if (isWithin(dumpDir, stagingDir) || isWithin(stagingDir, dumpDir)) {
    throw new Error("stagingDir deve essere completamente separata da dumpDir.");
  }
  if (options.baselineManifestPath) {
    const baseDir = path.dirname(path.resolve(options.baselineManifestPath));
    if (isWithin(baseDir, stagingDir)) {
      throw new Error("stagingDir non può risiedere dentro la cartella del baseline manifest.");
    }
  }
  if (options.baselineOverridesDir && isWithin(path.resolve(options.baselineOverridesDir), stagingDir)) {
    throw new Error("stagingDir non può risiedere dentro baselineOverridesDir.");
  }
  if (fs.existsSync(stagingDir)) {
    throw new Error(`stagingDir esiste già (rifiuto sovrascrittura): ${stagingDir}`);
  }

  const baselineManifest = options.baselineManifestPath
    ? readAndValidateManifest(options.baselineManifestPath)
    : undefined;
  if (baselineManifest && Object.keys(baselineManifest.overrides).length > 0) {
    const baselineOverridesDir = options.baselineOverridesDir
      ? path.resolve(options.baselineOverridesDir)
      : undefined;
    if (!baselineOverridesDir || !fs.existsSync(baselineOverridesDir) || !fs.statSync(baselineOverridesDir).isDirectory()) {
      throw new Error("baselineOverridesDir è obbligatoria e deve contenere tutti gli override elencati nel manifest baseline.");
    }
    for (const [name, expectedSha] of Object.entries(baselineManifest.overrides)) {
      const source = path.join(baselineOverridesDir, name);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        throw new Error(`Override baseline mancante: ${source}`);
      }
      const actualSha = sha256Buffer(fs.readFileSync(source));
      if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
        throw new Error(`Hash override baseline non corrispondente per ${name}: atteso ${expectedSha}, trovato ${actualSha}`);
      }
    }
  }

  const overridesDir = path.join(stagingDir, "overrides");
  const rejectedDir = path.join(stagingDir, "rejected");
  const disasmDir = path.join(stagingDir, "disasm");
  const hlslDir = path.join(stagingDir, "hlsl");
  fs.mkdirSync(overridesDir, { recursive: true });
  fs.mkdirSync(rejectedDir, { recursive: true });
  fs.mkdirSync(disasmDir, { recursive: true });
  fs.mkdirSync(hlslDir, { recursive: true });

  const converter = deps.converter ?? convertDxilToHlsl;
  const runner = deps.runner ?? run;
  const getFxc = deps.fxcPath ?? findFxc;
  const getDxc = deps.dxcPath ?? (() => findDxc(options.dxcPath));
  const autoDisassemble = options.autoDisassemble ?? true;
  const requirePairValidationForPs = options.requirePairValidationForPs ?? true;

  const logReport = options.logPath ? parseHelaProxyLogFile(path.resolve(options.logPath)) : undefined;
  const onlySet = options.onlyHashes?.length
    ? new Set(options.onlyHashes.map((h) => h.toLowerCase().replace(/^0x/, "")))
    : undefined;

  interface DiscoveredShader {
    hash: string;
    filePath: string;
    stage: string;
    disasmPath?: string;
    autoDisassembled: boolean;
    report?: ReturnType<typeof analyzeFiles>;
    error?: string;
  }

  const discoveredByHash = new Map<string, DiscoveredShader>();
  const rawFiles = walkShaderFiles(dumpDir);

  for (const filePath of rawFiles) {
    const bytes = fs.readFileSync(filePath);
    const container = dxilAnalyzer.parseContainer(bytes);
    if (!container?.hasDxil) continue;
    const hash = fnv1a64(bytes);
    if (onlySet && !onlySet.has(hash)) continue;
    if (discoveredByHash.has(hash)) continue;

    let disasmPath = findExistingDisasm(filePath);
    let autoDisassembled = false;
    let error: string | undefined;

    if (!disasmPath && autoDisassemble) {
      const targetDisasm = path.join(disasmDir, `${hash}_dxil.txt`);
      const dxcRes: RunResult = await runner(getDxc(), ["-dumpbin", filePath]);
      if (dxcRes.missing) {
        error = `DXC non trovato (${getDxc()}): impossibile disassemblare ${path.basename(filePath)}.`;
      } else if (dxcRes.code !== 0 || !dxcRes.stdout.trim()) {
        error = `dxc -dumpbin fallito per ${path.basename(filePath)}: ${dxcRes.stderr || dxcRes.stdout}`;
      } else {
        fs.writeFileSync(targetDisasm, dxcRes.stdout, "utf8");
        disasmPath = targetDisasm;
        autoDisassembled = true;
      }
    }

    const report = disasmPath ? analyzeFiles(filePath, disasmPath) : analyzeFiles(filePath);
    const stage = (report.stage ?? container.program?.type ?? "unknown").toLowerCase();
    discoveredByHash.set(hash, {
      hash,
      filePath,
      stage,
      disasmPath,
      autoDisassembled,
      report,
      error,
    });
  }

  const ordered = [...discoveredByHash.values()].sort((a, b) => {
    const oa = STAGE_ORDER[a.stage] ?? 99;
    const ob = STAGE_ORDER[b.stage] ?? 99;
    return oa - ob || a.hash.localeCompare(b.hash);
  });

  const compiledCsoByHash = new Map<string, string>();
  const unmappedRegisterSpaces: Array<{ hash: string; stage: string; bindings: string[] }> = [];
  const entries: StagedShaderEntry[] = [];

  const findVsCsoPath = (vsHash: string): string | undefined => {
    const staged = compiledCsoByHash.get(vsHash);
    if (staged && fs.existsSync(staged)) return staged;
    if (options.baselineOverridesDir) {
      const base = path.join(path.resolve(options.baselineOverridesDir), `${vsHash}.cso`);
      if (fs.existsSync(base)) return base;
    }
    return undefined;
  };

  for (const item of ordered) {
    const pairedVsHashes = item.stage === "ps" ? (logReport?.psToVsMap[item.hash] ?? []) : [];
    const baseEntry: Omit<StagedShaderEntry, "status" | "includedInManifest" | "message"> = {
      hash: item.hash,
      stage: item.stage,
      inputPath: item.filePath,
      disasmPath: item.disasmPath,
      autoDisassembled: item.autoDisassembled,
      sharedByMultipleVs: pairedVsHashes.length > 1,
      pairedVsHashes,
      validatedAgainstVs: [],
      missingPairedVsDisasm: [],
      missingPairedVsCso: [],
      inputLayoutCheck: "not-covered-by-proxy-log",
      registerMap: [],
      warnings: [],
    };

    if (item.error) {
      entries.push({ ...baseEntry, status: "failed", includedInManifest: false, message: item.error });
      continue;
    }
    if (!item.disasmPath || !item.report) {
      entries.push({
        ...baseEntry,
        status: "blocked",
        includedInManifest: false,
        message: "Disassemblato DXC assente; abilita autoDisassemble o fornisci *_dxil.txt.",
      });
      continue;
    }

    const report = item.report;
    if (report.container?.program && report.stage && report.container.program.type !== report.stage) {
      entries.push({
        ...baseEntry,
        status: "blocked",
        includedInManifest: false,
        message: `Stage disassemblato (${report.stage}) diverso da container (${report.container.program.type}).`,
      });
      continue;
    }
    const blockers = report.findings.filter((f) => f.sev === "blocker");
    if (blockers.length) {
      entries.push({
        ...baseEntry,
        status: "blocked",
        includedInManifest: false,
        message: `Feature SM6 bloccanti: ${blockers.map((b) => `[${b.code}] ${b.message}`).join(" | ")}`,
      });
      continue;
    }
    const profile = PROFILE_BY_STAGE[item.stage];
    if (!profile) {
      entries.push({
        ...baseEntry,
        status: "blocked",
        includedInManifest: false,
        message: `Stage non supportato per SM5: ${item.stage}`,
      });
      continue;
    }

    // Per i PS: verifica rigorosa di TUTTI i VS abbinati (incluso fan-in multi-VS e VS mancanti)
    let vsOutputDisasmPath: string | undefined;
    if (item.stage === "ps" && pairedVsHashes.length > 0) {
      const vsDisasms: Array<{ vsHash: string; path: string; sigKey: string }> = [];
      for (const vsHash of pairedVsHashes) {
        const vsDiscovered = discoveredByHash.get(vsHash);
        const candidateDisasm =
          vsDiscovered?.disasmPath ??
          findExistingDisasm(path.join(dumpDir, `${vsHash}.dxil`));
        if (!candidateDisasm || !fs.existsSync(candidateDisasm)) {
          baseEntry.missingPairedVsDisasm.push(vsHash);
          continue;
        }
        const vsText = fs.readFileSync(candidateDisasm, "utf8");
        if (analyzeDisasm(vsText).stage !== "vs") {
          baseEntry.missingPairedVsDisasm.push(vsHash);
          continue;
        }
        const sig = parseOutputSignature(vsText);
        if (!sig.length) {
          baseEntry.missingPairedVsDisasm.push(vsHash);
          continue;
        }
        vsDisasms.push({ vsHash, path: candidateDisasm, sigKey: normalizeVsOutputSigKey(sig) });
      }

      const distinctSigs = new Set(vsDisasms.map((d) => d.sigKey));
      if (distinctSigs.size > 1) {
        entries.push({
          ...baseEntry,
          status: "pair-conflict",
          includedInManifest: false,
          message:
            `PS condiviso da più VS con firme output incompatibili (${vsDisasms.map((d) => d.vsHash).join(", ")}). ` +
            "Rifiutato fail-closed: serve specializzazione o riallineamento manuale.",
        });
        continue;
      }

      if (baseEntry.missingPairedVsDisasm.length > 0) {
        baseEntry.warnings.push(
          `Disassemblato/firma output assente per VS abbinati: ${baseEntry.missingPairedVsDisasm.join(", ")}.`,
        );
      }
      if (vsDisasms.length > 0 && baseEntry.missingPairedVsDisasm.length === 0) {
        vsOutputDisasmPath = vsDisasms[0].path;
      }
    }

    try {
      const converted = await converter({
        inputPath: item.filePath,
        disasmPath: item.disasmPath,
        vsOutputDisasmPath,
        bindingMapPath: options.bindingMapPath ? path.resolve(options.bindingMapPath) : undefined,
        bufferMode: "raw",
      });
      baseEntry.registerMap = converted.post.registerMap;

      const localBindings = converted.post.warnings.filter((w) => w.includes("assegnato localmente"));
      if (localBindings.length) {
        unmappedRegisterSpaces.push({
          hash: item.hash,
          stage: item.stage,
          bindings: converted.post.registerMap.map((r) => `${r.from} -> ${r.to}`),
        });
        entries.push({
          ...baseEntry,
          status: "blocked",
          includedInManifest: false,
          warnings: [...baseEntry.warnings, ...converted.post.warnings],
          message: `Register space ≠ 0 senza mappa binding condivisa col proxy: ${localBindings.join(" | ")}`,
        });
        continue;
      }
      if (!converted.post.entryPoint) {
        entries.push({
          ...baseEntry,
          status: "blocked",
          includedInManifest: false,
          warnings: [...baseEntry.warnings, ...converted.post.warnings],
          message: "Entry point HLSL non identificato dopo SPIRV-Cross.",
        });
        continue;
      }

      const hlslPath = path.join(hlslDir, `${item.hash}_${item.stage}.hlsl`);
      fs.writeFileSync(hlslPath, converted.hlsl, "utf8");
      const tempCso = path.join(os.tmpdir(), `hela-stage-${process.pid}-${item.hash}.cso`);
      try {
        const fxcRes = await runner(getFxc(), [
          "/nologo",
          "/T",
          profile,
          "/E",
          converted.post.entryPoint,
          "/Fo",
          tempCso,
          hlslPath,
        ]);
        if (fxcRes.missing) throw new Error(`FXC non disponibile: ${fxcRes.stderr}`);
        if (fxcRes.code !== 0 || !fs.existsSync(tempCso)) {
          throw new Error(`FXC (${profile}) fallito: ${fxcRes.stderr || fxcRes.stdout}`);
        }
        const compiledBytes = fs.readFileSync(tempCso);
        const compiledContainer = dxilAnalyzer.parseContainer(compiledBytes);
        if (!compiledContainer?.hasLegacy || compiledContainer.hasDxil) {
          throw new Error("Output FXC non è un container DXBC legacy SM5 valido.");
        }
        const compiledSha256 = sha256Buffer(compiledBytes);

        // Protezione baseline: non sostituire silenziosamente un override già fissato nel baseline con un hash diverso
        const csoFileName = `${item.hash}.cso`;
        if (
          baselineManifest?.overrides[csoFileName] &&
          baselineManifest.overrides[csoFileName].toLowerCase() !== compiledSha256
        ) {
          const rejectedPath = path.join(rejectedDir, csoFileName);
          fs.copyFileSync(tempCso, rejectedPath);
          entries.push({
            ...baseEntry,
            status: "blocked",
            includedInManifest: false,
            csoPath: rejectedPath,
            csoSha256: compiledSha256,
            warnings: [...baseEntry.warnings, ...converted.post.warnings],
            message: `Conflitto col baseline: ${csoFileName} è già fissato nel baseline con SHA-256 diverso; baseline preservato.`,
          });
          continue;
        }

        // Controllo [TARGET_INPUT_LAYOUT] SOLO per il VS diagnostico 20e0826b236597a1
        if (
          item.stage === "vs" &&
          item.hash === TARGET_INPUT_LAYOUT_DIAGNOSTIC_VS &&
          logReport &&
          logReport.targetInputLayoutCoverage.elements.length > 0
        ) {
          const vsDump = await runner(getFxc(), ["/dumpbin", tempCso]);
          if (vsDump.code === 0) {
            const vsInSig = parseInputSignature(`${vsDump.stdout}\n${vsDump.stderr}`);
            const ilCheck = checkVsAgainstDiagnosticInputLayout(
              vsInSig,
              logReport.targetInputLayoutCoverage.elements,
            );
            if (!ilCheck.ok) {
              const rejectedPath = path.join(rejectedDir, csoFileName);
              fs.copyFileSync(tempCso, rejectedPath);
              entries.push({
                ...baseEntry,
                status: "input-layout-failed",
                includedInManifest: false,
                csoPath: rejectedPath,
                csoSha256: compiledSha256,
                inputLayoutCheck: "diagnostic-vs-failed",
                warnings: [...baseEntry.warnings, ...converted.post.warnings],
                message: `InputLayout mismatch sul VS diagnostico: ${ilCheck.mismatches.join(" | ")}`,
              });
              continue;
            }
            baseEntry.inputLayoutCheck = "diagnostic-vs-passed";
          }
        }

        let status: ShaderStageOutcome = "compiled-candidate";
        let includeInManifest = true;
        let detailMessage = "Compilato SM5 con FXC (candidato; equivalenza e rendering non verificati).";
        const validatedAgainstVs: string[] = [];

        if (item.stage === "ps") {
          const pairMismatches: string[] = [];
          const psDump = await runner(getFxc(), ["/dumpbin", tempCso]);
          const psInSig = psDump.code === 0 ? parseInputSignature(`${psDump.stdout}\n${psDump.stderr}`) : [];

          for (const vsHash of pairedVsHashes) {
            const vsCsoPath = findVsCsoPath(vsHash);
            if (!vsCsoPath) {
              baseEntry.missingPairedVsCso.push(vsHash);
              continue;
            }
            const vsDump = await runner(getFxc(), ["/dumpbin", vsCsoPath]);
            if (vsDump.code !== 0 || psDump.code !== 0) {
              pairMismatches.push(`fxc /dumpbin fallito per coppia VS ${vsHash} -> PS ${item.hash}`);
              continue;
            }
            const vsOutSig = parseOutputSignature(`${vsDump.stdout}\n${vsDump.stderr}`);
            if (!vsOutSig.length || !psInSig.length) {
              pairMismatches.push(`Firma mancante in fxc /dumpbin per coppia VS ${vsHash} -> PS ${item.hash}`);
              continue;
            }
            const cmp = compareShaderSignatures(vsOutSig, psInSig);
            if (!cmp.compatible) {
              pairMismatches.push(`VS ${vsHash} -> PS ${item.hash}: ${cmp.mismatches.join("; ")}`);
            } else {
              validatedAgainstVs.push(vsHash);
            }
          }

          if (pairMismatches.length > 0) {
            const rejectedPath = path.join(rejectedDir, csoFileName);
            fs.copyFileSync(tempCso, rejectedPath);
            entries.push({
              ...baseEntry,
              status: "pair-failed",
              includedInManifest: false,
              csoPath: rejectedPath,
              csoSha256: compiledSha256,
              validatedAgainstVs,
              warnings: [...baseEntry.warnings, ...converted.post.warnings],
              message: `Validazione coppia VS/PS fallita: ${pairMismatches.join(" | ")}`,
            });
            continue;
          }

          if (pairedVsHashes.length === 0) {
            status = "compiled-unpaired";
            includeInManifest = !requirePairValidationForPs;
            detailMessage = requirePairValidationForPs
              ? "PS compilato ma escluso dal manifest: nessun VS abbinato noto nel log."
              : "PS compilato senza coppia VS nota (validazione firma non eseguita).";
          } else if (
            baseEntry.missingPairedVsDisasm.length > 0 ||
            baseEntry.missingPairedVsCso.length > 0 ||
            validatedAgainstVs.length < pairedVsHashes.length
          ) {
            // Regola rigorosa: se manca firma o bytecode di QUALUNQUE VS abbinato, NON dichiarare la coppia validata!
            status = "pair-incomplete";
            includeInManifest = !requirePairValidationForPs;
            detailMessage =
              `Coppia PS incompleta (condiviso=${baseEntry.sharedByMultipleVs}): validati ${validatedAgainstVs.length}/${pairedVsHashes.length} VS` +
              (baseEntry.missingPairedVsDisasm.length ? `; disasm mancanti: ${baseEntry.missingPairedVsDisasm.join(", ")}` : "") +
              (baseEntry.missingPairedVsCso.length ? `; .cso mancanti: ${baseEntry.missingPairedVsCso.join(", ")}` : "") +
              ". Non dichiarato pair-validated.";
          } else {
            status = "pair-validated";
            includeInManifest = true;
            detailMessage = baseEntry.sharedByMultipleVs
              ? `Compilato SM5 e validato contro tutti i ${validatedAgainstVs.length} VS abbinati (${validatedAgainstVs.join(", ")}).`
              : `Compilato SM5 e validato contro VS ${validatedAgainstVs[0]}.`;
          }
        }

        const destDir = includeInManifest ? overridesDir : rejectedDir;
        const finalCsoPath = path.join(destDir, csoFileName);
        fs.copyFileSync(tempCso, finalCsoPath);
        if (includeInManifest) {
          compiledCsoByHash.set(item.hash, finalCsoPath);
        }

        entries.push({
          ...baseEntry,
          status,
          includedInManifest: includeInManifest,
          csoPath: finalCsoPath,
          csoSha256: compiledSha256,
          validatedAgainstVs,
          warnings: [...baseEntry.warnings, ...converted.post.warnings],
          message: detailMessage,
        });
      } finally {
        if (fs.existsSync(tempCso)) fs.unlinkSync(tempCso);
      }
    } catch (err) {
      entries.push({
        ...baseEntry,
        status: "failed",
        includedInManifest: false,
        message: messageOf(err),
      });
    }
  }

  // Genera run-manifest.candidate.json preservando 100% degli hash e requiredOverrides del baseline
  let manifestPath: string | undefined;
  let baselineOverridesPreserved = 0;
  let newCandidatesIncluded = 0;
  let packageGateReport: HelaPackageGateReport | undefined;

  if (baselineManifest) {
    const manifestOverrides: Record<string, string> = {};
    const requiredSet = new Set<string>(baselineManifest.requiredOverrides);

    for (const [k, v] of Object.entries(baselineManifest.overrides)) {
      manifestOverrides[k] = v.toLowerCase();
      baselineOverridesPreserved++;
    }

    if (options.baselineOverridesDir && fs.existsSync(path.resolve(options.baselineOverridesDir))) {
      for (const name of Object.keys(baselineManifest.overrides)) {
        const src = path.join(path.resolve(options.baselineOverridesDir), name);
        const dst = path.join(overridesDir, name);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
        }
      }
    }

    for (const e of entries) {
      if (e.includedInManifest && e.csoSha256) {
        const name = `${e.hash}.cso`;
        if (!manifestOverrides[name]) {
          manifestOverrides[name] = e.csoSha256;
          newCandidatesIncluded++;
          if (options.addNewCandidatesToRequiredOverrides) {
            requiredSet.add(name);
          }
        }
      }
    }

    const sortedOverrides: Record<string, string> = {};
    for (const k of Object.keys(manifestOverrides).sort()) {
      sortedOverrides[k] = manifestOverrides[k];
    }

    let launchProfile = baselineManifest.launchProfile
      ? {
          ...baselineManifest.launchProfile,
          environment: { ...baselineManifest.launchProfile.environment },
          arguments: [...baselineManifest.launchProfile.arguments],
          attestation: { ...baselineManifest.launchProfile.attestation },
        }
      : undefined;

    if (launchProfile && options.enableDumpInCandidateManifest) {
      launchProfile.environment.D3D12ON11_DUMP_SHADERS = "1";
      launchProfile.sha256 = computeLaunchEnvironmentSha256(launchProfile.environment);
    }

    const candidateManifest: HelaRunManifestV1 = {
      schema: "hela-run-manifest/v1",
      runtimeAttestation: "module-and-shader-sha256",
      testVersion: options.testVersion ?? `${baselineManifest.testVersion}-staged`,
      runtime: { ...baselineManifest.runtime },
      overrides: sortedOverrides,
      requiredOverrides: [...requiredSet].sort(),
      ...(launchProfile ? { launchProfile } : {}),
    };

    const runtimeEntries: Array<{ path: string; sha256: string; bytes: number }> = [];
    if (options.runtimeDir) {
      const runtimeDir = path.resolve(options.runtimeDir);
      assertNotProtectedGamePath(runtimeDir, "runtimeDir");
      if (!fs.existsSync(runtimeDir) || !fs.statSync(runtimeDir).isDirectory()) {
        throw new Error(`runtimeDir non valida: ${runtimeDir}`);
      }

      const runtimeOutputDir = path.join(stagingDir, "runtime");
      fs.mkdirSync(runtimeOutputDir, { recursive: true });
      for (const name of ["d3d12.dll", "dxgi.dll"]) {
        const source = path.join(runtimeDir, name);
        if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
          throw new Error(`Runtime DLL mancante in runtimeDir: ${source}`);
        }
        const bytes = fs.readFileSync(source);
        const digest = sha256Buffer(bytes);
        const manifestRole = name === "d3d12.dll" ? "d3d12" : "dxgi";
        candidateManifest.runtime[manifestRole] = digest;
        fs.copyFileSync(source, path.join(runtimeOutputDir, name));
        runtimeEntries.push({ path: `runtime/${name}`, sha256: digest, bytes: bytes.length });
      }
    }

    manifestPath = path.join(stagingDir, "run-manifest.candidate.json");
    fs.writeFileSync(manifestPath, JSON.stringify(candidateManifest, null, 2) + "\n", "utf8");

    if (options.runtimeDir) {
      const overrideEntries = Object.entries(sortedOverrides).map(([name, digest], index) => ({
        id: `override-${index}-${name.replace(/\.cso$/i, "")}`,
        path: `overrides/${name}`,
        sha256: digest,
      }));
      const candidatePackage = {
        schemaVersion: 1,
        packageId: candidateManifest.testVersion,
        runtime: runtimeEntries,
        overrides: overrideEntries,
      };
      fs.writeFileSync(
        path.join(stagingDir, "candidate-package.json"),
        JSON.stringify(candidatePackage, null, 2) + "\n",
        "utf8",
      );

      const packageGate = deps.packageGate ?? defaultHelaPackageGate;
      packageGateReport = await packageGate(stagingDir, { mode: "build" });
    }
  } else {
    newCandidatesIncluded = entries.filter((e) => e.includedInManifest).length;
  }

  const counts: Record<ShaderStageOutcome, number> = {
    "pair-validated": 0,
    "compiled-candidate": 0,
    "compiled-unpaired": 0,
    "pair-incomplete": 0,
    "pair-conflict": 0,
    "pair-failed": 0,
    "input-layout-failed": 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
  };
  for (const e of entries) counts[e.status]++;

  const reportJsonPath = path.join(stagingDir, "hela-pipeline-report.json");
  const reportMarkdownPath = path.join(stagingDir, "hela-pipeline-report.md");

  const result: BuildHelaStageReport = {
    stagingDir,
    overridesDir,
    manifestPath,
    reportJsonPath,
    reportMarkdownPath,
    logAnalyzed: Boolean(logReport),
    counts,
    baselineOverridesPreserved,
    newCandidatesIncluded,
    unmappedRegisterSpaces,
    entries,
    ...(packageGateReport ? { packageGate: packageGateReport } : {}),
    disclaimer: CANDIDATE_DISCLAIMER,
  };

  fs.writeFileSync(reportJsonPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  fs.writeFileSync(reportMarkdownPath, formatStageMarkdown(result), "utf8");
  if (packageGateReport && !packageGateReport.ok) {
    throw new Error(
      `Package gate Hela fallito (staged-only): ${packageGateReport.issues
        .map((issue) => issue.code)
        .join(", ")}`,
    );
  }
  return result;
}

/**
 * Produce un nuovo manifest candidato in un percorso separato preservando 100% di
 * `overrides` e `requiredOverrides` del baseline. Rifiuta qualsiasi percorso che possa
 * sovrascrivere il baseline, file esistenti o directory del gioco/staging input.
 */
export function planHelaManifestPatch(options: PlanManifestPatchOptions): PlanManifestPatchResult {
  const baselinePath = path.resolve(options.baselineManifestPath);
  const stagingOverridesDir = path.resolve(options.stagingOverridesDir);
  const outPath = path.resolve(options.outManifestPath);

  assertNotProtectedGamePath(outPath, "outManifestPath");
  if (!outPath.toLowerCase().endsWith(".json")) {
    throw new Error(`outManifestPath deve terminare in .json: ${outPath}`);
  }
  if (outPath.toLowerCase() === baselinePath.toLowerCase()) {
    throw new Error("Rifiutato: outManifestPath coincide con baselineManifestPath (non sovrascrivere il manifest originale).");
  }
  if (isWithin(path.dirname(baselinePath), outPath)) {
    throw new Error("Rifiutato: outManifestPath non può essere scritto nella stessa cartella del manifest baseline/storico.");
  }
  if (isWithin(stagingOverridesDir, outPath)) {
    throw new Error("Rifiutato: outManifestPath non può risiedere dentro stagingOverridesDir.");
  }
  if (fs.existsSync(outPath)) {
    throw new Error(`Rifiutato: outManifestPath esiste già (${outPath}); specificare un nuovo percorso candidato.`);
  }
  if (!fs.existsSync(stagingOverridesDir) || !fs.statSync(stagingOverridesDir).isDirectory()) {
    throw new Error(`stagingOverridesDir non valida: ${stagingOverridesDir}`);
  }

  const baseline = readAndValidateManifest(baselinePath);
  const mergedOverrides: Record<string, string> = {};
  for (const [name, hash] of Object.entries(baseline.overrides)) {
    mergedOverrides[name] = hash.toLowerCase();
  }
  const requiredSet = new Set<string>(baseline.requiredOverrides);

  const files = fs
    .readdirSync(stagingOverridesDir)
    .filter((f) => f.toLowerCase().endsWith(".cso"))
    .sort();

  const addedOverrides: string[] = [];
  for (const file of files) {
    if (!CSO_NAME.test(file)) {
      throw new Error(`Nome file .cso non valido in staging: ${file}`);
    }
    const bytes = fs.readFileSync(path.join(stagingOverridesDir, file));
    const container = dxilAnalyzer.parseContainer(bytes);
    if (!container?.hasLegacy || container.hasDxil) {
      throw new Error(`File in staging non è un container DXBC SM5 valido: ${file}`);
    }
    const digest = sha256Buffer(bytes);
    const baselineDigest = mergedOverrides[file];
    if (baselineDigest) {
      if (baselineDigest !== digest) {
        throw new Error(
          `Conflitto hash sul file baseline '${file}': baseline=${baselineDigest}, staging=${digest}. ` +
          "Rifiutato per preservare l'integrità del baseline.",
        );
      }
      continue;
    }
    mergedOverrides[file] = digest;
    addedOverrides.push(file);
    if (options.addNewCandidatesToRequiredOverrides) {
      requiredSet.add(file);
    }
  }

  const sortedOverrides: Record<string, string> = {};
  for (const key of Object.keys(mergedOverrides).sort()) {
    sortedOverrides[key] = mergedOverrides[key];
  }

  let launchProfile = baseline.launchProfile
    ? {
        ...baseline.launchProfile,
        environment: { ...baseline.launchProfile.environment },
        arguments: [...baseline.launchProfile.arguments],
        attestation: { ...baseline.launchProfile.attestation },
      }
    : undefined;
  if (launchProfile && options.dumpShaders !== undefined) {
    launchProfile.environment.D3D12ON11_DUMP_SHADERS = options.dumpShaders ? "1" : "0";
    launchProfile.sha256 = computeLaunchEnvironmentSha256(launchProfile.environment);
  }

  const candidateManifest: HelaRunManifestV1 = {
    schema: "hela-run-manifest/v1",
    runtimeAttestation: "module-and-shader-sha256",
    testVersion: options.testVersion,
    runtime: { ...baseline.runtime },
    overrides: sortedOverrides,
    requiredOverrides: [...requiredSet].sort(),
    ...(launchProfile ? { launchProfile } : {}),
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(candidateManifest, null, 2) + "\n", "utf8");

  return {
    written: outPath,
    testVersion: options.testVersion,
    baselineOverrideCount: Object.keys(baseline.overrides).length,
    totalOverrides: Object.keys(sortedOverrides).length,
    addedOverrides,
    unchangedBaselineOverrides: Object.keys(baseline.overrides).length,
    requiredOverridesCount: candidateManifest.requiredOverrides.length,
    launchProfileSha256: launchProfile?.sha256,
    disclaimer: CANDIDATE_DISCLAIMER,
  };
}

function formatStageMarkdown(report: BuildHelaStageReport): string {
  const lines: string[] = [
    "# Shader Lab — Hela Staging Pipeline Report (v2)",
    "",
    `> **Limite di validazione**: ${report.disclaimer}`,
    "",
    `- **Staging dir**: \`${report.stagingDir}\``,
    `- **Overrides dir**: \`${report.overridesDir}\``,
    `- **Manifest candidato**: ${report.manifestPath ? `\`${report.manifestPath}\`` : "(non generato)"}`,
    `- **Package gate**: ${report.packageGate ? (report.packageGate.ok ? "PASS (staged-only)" : "FAIL (staged-only)") : "non richiesto"}`,
    `- **Override baseline preservati**: ${report.baselineOverridesPreserved}`,
    `- **Nuovi candidati inclusi**: ${report.newCandidatesIncluded}`,
    "",
    "## Riepilogo stati",
    "",
    "| Stato | Conteggio |",
    "|---|---|",
    ...Object.entries(report.counts).map(([k, v]) => `| \`${k}\` | ${v} |`),
    "",
    "## Dettaglio shader",
    "",
    "| Hash FNV-1a64 | Stage | Multi-VS | Stato | In manifest | Dettagli |",
    "|---|---|---|---|---|---|",
    ...report.entries.map(
      (e) =>
        `| \`${e.hash}\` | \`${e.stage}\` | ${e.sharedByMultipleVs ? "sì" : "no"} | \`${e.status}\` | ${e.includedInManifest ? "sì" : "no"} | ${e.message.replace(/\|/g, "/")} |`,
    ),
  ];
  return lines.join("\n") + "\n";
}

/**
 * Verifica post-run read-only di una cartella prodotta da `ProxyManager.ps1`.
 * Distingue esplicitamente:
 * 1. Attestazione moduli/profilo/override
 * 2. Present raggiunto (`maxObservedPresent > 0`, eventuale `targetPresent`)
 * 3. Stato BMP readback (`missing` | `invalid` | `black-readback` | `nonzero-pixels-observed`)
 * 4. `menuValidated: false` (pixel non neri osservati NON equivalgono a menu validato).
 */
export function verifyHelaRun(options: VerifyHelaRunOptions): VerifyHelaRunReport {
  const runDir = path.resolve(options.runDir);
  const logPath = path.resolve(options.logPath ?? path.join(runDir, "d3d12on11.log"));
  const manifestPath = path.resolve(options.manifestPath ?? path.join(runDir, "run-manifest.json"));

  const logReport = parseHelaProxyLogFile(logPath);
  const manifest = readAndValidateManifest(manifestPath);

  const attestationFailures: string[] = [];
  const missingRequiredOverrides: string[] = [];

  const expectedD3d12 = manifest.runtime.d3d12.toLowerCase();
  const expectedDxgi = manifest.runtime.dxgi.toLowerCase();
  if (logReport.attestation.modules.d3d12 !== expectedD3d12) {
    attestationFailures.push(
      `d3d12.dll fingerprint mismatch: atteso ${expectedD3d12}, loggato ${logReport.attestation.modules.d3d12 ?? "assente"}`,
    );
  }
  if (logReport.attestation.modules.dxgi_proxy !== expectedDxgi) {
    attestationFailures.push(
      `dxgi.dll fingerprint mismatch: atteso ${expectedDxgi}, loggato ${logReport.attestation.modules.dxgi_proxy ?? "assente"}`,
    );
  }

  if (manifest.launchProfile?.attestation) {
    const att = manifest.launchProfile.attestation;
    if (att.maskedNvidiaAdapter === true && !logReport.attestation.maskedNvidiaAdapter) {
      attestationFailures.push(
        `Adapter NVIDIA mascherato/proxy-unwrap non attestato (vendor=${logReport.attestation.exposedVendor ?? "n/d"}, source=${logReport.attestation.adapterSource ?? "n/d"}).`,
      );
    }
    if (att.tiledResourcesTier !== undefined && logReport.attestation.tiledResourcesTier !== att.tiledResourcesTier) {
      attestationFailures.push(
        `Tiled-resource tier atteso ${att.tiledResourcesTier}, loggato ${logReport.attestation.tiledResourcesTier ?? "assente"}.`,
      );
    }
    if (att.callerTrace !== undefined && logReport.attestation.callerTrace !== att.callerTrace) {
      attestationFailures.push(
        `caller-trace atteso ${att.callerTrace ? "1" : "0"}, loggato ${logReport.attestation.callerTrace === undefined ? "assente" : logReport.attestation.callerTrace ? "1" : "0"}.`,
      );
    }
  }

  for (const name of manifest.requiredOverrides) {
    const hash = name.replace(/\.cso$/i, "").toLowerCase();
    const expectedSha = manifest.overrides[name]?.toLowerCase();
    const obs = logReport.shaders[hash];
    if (!obs || obs.status !== "override-ready" || obs.overrideSha256 !== expectedSha) {
      missingRequiredOverrides.push(name);
      attestationFailures.push(
        `Override richiesto '${name}' non attestato in SHADER READY con sha256=${expectedSha ?? "?"}.`,
      );
    }
  }

  const maxObservedPresent = logReport.presentProgress.maxObservedPresent;
  const presentReached = maxObservedPresent > 0;
  const targetPresentReached =
    options.targetPresent !== undefined
      ? logReport.presentProgress.maxReadbackPresent >= options.targetPresent
      : undefined;

  let allBmpPaths: string[] = [];
  if (options.bmpPaths?.length) {
    allBmpPaths = options.bmpPaths.map((p) => path.resolve(p));
  } else {
    const readbackDir = path.join(runDir, "readbacks");
    if (fs.existsSync(readbackDir) && fs.statSync(readbackDir).isDirectory()) {
      allBmpPaths = fs
        .readdirSync(readbackDir)
        .filter((f) => f.toLowerCase().endsWith(".bmp"))
        .sort()
        .map((f) => path.join(readbackDir, f));
    }
  }

  const bmpPathsNotMatchingTarget: string[] = [];
  let bmpPaths = allBmpPaths;
  if (options.targetPresent !== undefined) {
    bmpPaths = allBmpPaths.filter((bmpPath) => {
      const match = path.basename(bmpPath).match(/^HelaReadback_Present(\d+)_(?:source|backbuffer)\.bmp$/i);
      const matchesTarget = match !== null && Number(match[1]) === options.targetPresent;
      if (!matchesTarget) bmpPathsNotMatchingTarget.push(bmpPath);
      return matchesTarget;
    });
  }

  const bmps = bmpPaths.map((p) => analyzeBmpFile(p));
  const validBmps = bmps.filter((b) => b.valid);
  const anyNonBlackPixel = validBmps.some((b) => b.nonBlackPixels > 0);

  let bmpReadbackStatus: VerifyHelaRunReport["bmpReadbackStatus"];
  if (bmps.length === 0) {
    bmpReadbackStatus = "missing";
  } else if (validBmps.length === 0) {
    bmpReadbackStatus = "invalid";
  } else if (!anyNonBlackPixel) {
    bmpReadbackStatus = "black-readback";
  } else {
    bmpReadbackStatus = "nonzero-pixels-observed";
  }

  const attestationPassed = attestationFailures.length === 0;
  let verdict: HelaRunVerdict;
  let explanation: string;

  if (!attestationPassed) {
    verdict = "attestation-failed";
    explanation = `Attestazione fallita (${attestationFailures.length} errori): non trattare questa run come prova valida.`;
  } else if (!presentReached || targetPresentReached === false) {
    verdict = "present-not-reached";
    explanation =
      options.targetPresent !== undefined
        ? `Attestazione superata, ma readback Present target #${options.targetPresent} non raggiunto (max readback: #${logReport.presentProgress.maxReadbackPresent}; heartbeat: #${logReport.presentProgress.maxHeartbeatPresent}).`
        : "Attestazione superata, ma nessun Present osservato nel log (swap/present rimasti a 0).";
  } else if (bmpReadbackStatus === "missing" || bmpReadbackStatus === "invalid") {
    verdict = "present-reached-readback-missing";
    explanation =
      `Present #${maxObservedPresent} osservato, ma nessun BMP readback valido per il target${options.targetPresent !== undefined ? ` #${options.targetPresent}` : ""} ` +
      `(${bmpReadbackStatus}${bmpPathsNotMatchingTarget.length ? `; ignorati ${bmpPathsNotMatchingTarget.length} BMP di altri target o con nome non riconosciuto` : ""}).`;
  } else if (bmpReadbackStatus === "black-readback") {
    verdict = "present-reached-black-readback";
    explanation =
      `Present #${maxObservedPresent} raggiunto con attestazione valida, ma tutti i ${validBmps.length} readback BMP ` +
      "risultano completamente neri (0 pixel non neri). Il raggiungimento di Present NON dimostra rendering del menu.";
  } else {
    verdict = "present-reached-nonzero-pixels-observed";
    explanation =
      `Present #${maxObservedPresent} raggiunto e pixel non neri osservati nei BMP readback. ` +
      "ATTENZIONE: pixel non neri NON equivalgono a menu validato; occorrono correlazione causale draw/risorsa e ispezione visiva.";
  }

  return {
    runDir,
    verdict,
    testVersion: manifest.testVersion,
    attestationPassed,
    attestationFailures,
    missingRequiredOverrides,
    presentStatus: {
      reached: presentReached,
      maxObservedPresent,
      maxHeartbeatPresent: logReport.presentProgress.maxHeartbeatPresent,
      maxReadbackPresent: logReport.presentProgress.maxReadbackPresent,
      ...(options.targetPresent !== undefined
        ? { targetPresent: options.targetPresent, targetPresentReached }
        : {}),
    },
    bmpReadbackStatus,
    bmpPathsNotMatchingTarget,
    bmps,
    sampledReadbacksFromLog: logReport.sampledReadbacks,
    menuValidated: false,
    menuValidationBoundary: MENU_VALIDATION_BOUNDARY,
    logSummary: logReport.summary,
    executedGraphicsPairs: logReport.executedGraphicsPairs,
    readbackCorrelations: logReport.readbackCorrelations,
    placeholdersPreview: logReport.placeholdersRanked.slice(0, 25),
    explanation,
  };
}

export { formatReport };
