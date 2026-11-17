import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as dxilAnalyzer from "./dxil-analyzer.js";
import { analyzeDisasm, analyzeFiles, formatReport, parseInputSignature, parseOutputSignature, type SigElement } from "./dxil-analyzer.js";
import { dxilSpirvPath, findFxc, run, spirvCrossPath, type RunResult } from "./external.js";
import { postprocessHlsl, type PostResult } from "./hlsl-post.js";

export interface DxilConversionOptions {
  inputPath: string;
  disasmPath?: string;
  vsOutputDisasmPath?: string;
  bindingMapPath?: string;
  bufferMode?: "raw" | "typed";
  force?: boolean;
  shouldCancel?: () => boolean;
}

export interface DxilConversionResult {
  hlsl: string;
  post: PostResult;
  notes: string[];
}

export interface PrecompileFileResult {
  file: string;
  status: "compiled" | "blocked" | "failed" | "skipped" | "cancelled";
  message: string;
  outputPath?: string;
}

export interface PrecompileProgress {
  total: number;
  settled: number;
  currentFile?: string;
  currentStatus?: "converting" | PrecompileFileResult["status"];
  latestResult?: PrecompileFileResult;
  counts: Omit<PrecompileReport, "inputDir" | "outputDir" | "total" | "results">;
}

export interface PrecompileReport {
  inputDir: string;
  outputDir: string;
  total: number;
  compiled: number;
  blocked: number;
  failed: number;
  skipped: number;
  cancelled: number;
  results: PrecompileFileResult[];
}

export interface PrecompileOptions {
  inputDir: string;
  outputDir: string;
  bindingMapPath?: string;
  shouldCancel?: () => boolean;
  onProgress?: (progress: PrecompileProgress) => void;
  onSnapshotProgress?: (phase: "enumerating" | "hashing", scanned: number, total?: number) => void;
}

export interface PrecompileDependencies {
  converter?: typeof convertDxilToHlsl;
  runner?: typeof run;
  fxcPath?: () => string;
}

export class PrecompileCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrecompileCancelledError";
  }
}

const PROFILE_BY_STAGE: Record<string, string> = {
  vs: "vs_5_0",
  ps: "ps_5_0",
  gs: "gs_5_0",
  hs: "hs_5_0",
  ds: "ds_5_0",
  cs: "cs_5_0",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function disassemblyPathFor(inputPath: string): string | undefined {
  const parsed = path.parse(inputPath);
  const candidates = [
    path.join(parsed.dir, `${parsed.name}_dxil.txt`),
    `${inputPath}.txt`,
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export async function convertDxilToHlsl(options: DxilConversionOptions): Promise<DxilConversionResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dxil2sm5-"));
  try {
    const spv = path.join(tmp, "shader.spv");
    const notes: string[] = [];
    let sig: SigElement[] = [];
    let vsOutputSig: SigElement[] | undefined;
    let metadata: { stage?: string; numThreads?: string } = {};
    if (options.disasmPath) {
      const report = analyzeFiles(options.inputPath, options.disasmPath);
      metadata = { stage: report.stage, numThreads: report.numThreads };
      sig = parseInputSignature(fs.readFileSync(options.disasmPath, "utf8"));
      const blockers = report.findings.filter((finding) => finding.sev === "blocker");
      if (blockers.length && !options.force)
        throw new Error(`Conversione NON tentata: feature SM6 senza equivalente SM5.\n${formatReport(report, path.basename(options.inputPath))}\n(force=true per provare comunque; il risultato non sarà valido in D3D11.)`);
      if (blockers.length) notes.push("ATTENZIONE: force=true con bloccanti presenti: l'output non è utilizzabile così com'è.");
    }

    if (options.vsOutputDisasmPath) {
      if (!options.disasmPath)
        throw new Error("vsOutputDisasmPath richiede disasmPath per verificare che lo shader convertito sia un pixel shader.");
      if (metadata.stage !== "ps")
        throw new Error("vsOutputDisasmPath è valido solo convertendo un pixel shader (stadio PS).");
      const vsText = fs.readFileSync(options.vsOutputDisasmPath, "utf8");
      if (analyzeDisasm(vsText).stage !== "vs")
        throw new Error("vsOutputDisasmPath non contiene un disassemblato di vertex shader.");
      vsOutputSig = parseOutputSignature(vsText);
      if (!vsOutputSig.length) throw new Error("Nessuna Output signature trovata nel disassemblato VS.");
    }

    const dxArgs = [options.inputPath, "--output", spv, ...((options.bufferMode ?? "raw") === "raw" ? ["--ssbo-srv", "--ssbo-uav"] : [])];
    const dxResult = await run(dxilSpirvPath(), dxArgs);
    if (dxResult.missing)
      throw new Error(`${dxResult.stderr}\nInstalla dxil-spirv e imposta DXIL_SPIRV_PATH.`);
    if (dxResult.code !== 0) throw new Error(`dxil-spirv fallito:\n${dxResult.stderr || dxResult.stdout}`);
    if (options.shouldCancel?.()) throw new PrecompileCancelledError("Annullato dopo dxil-spirv.");

    const rawHlsl = path.join(tmp, "raw.hlsl");
    const scArgs = [spv, "--hlsl", "--shader-model", "50", "--output", rawHlsl];
    if (metadata.stage === "vs")
      for (const element of sig)
        if (element.sysValue.toUpperCase() === "NONE" && element.register !== null)
          scArgs.push("--set-hlsl-vertex-input-semantic", String(element.register), `${element.name}${element.index}`);
    if (options.shouldCancel?.()) throw new PrecompileCancelledError("Annullato prima di SPIRV-Cross.");
    const crossResult = await run(spirvCrossPath(), scArgs);
    if (crossResult.missing)
      throw new Error(`${crossResult.stderr}\nInstalla SPIRV-Cross e imposta SPIRV_CROSS_PATH.`);
    if (crossResult.code !== 0 || !fs.existsSync(rawHlsl))
      throw new Error(`spirv-cross fallito (tipico per feature non rappresentabili in HLSL SM5, es. immagini 64-bit):\n${crossResult.stderr || crossResult.stdout}`);

    const bindingMap = options.bindingMapPath
      ? JSON.parse(fs.readFileSync(options.bindingMapPath, "utf8")) as Record<string, number>
      : undefined;
    const post = postprocessHlsl(fs.readFileSync(rawHlsl, "utf8"), fs.readFileSync(spv), bindingMap, metadata, vsOutputSig);
    return { hlsl: post.hlsl, post, notes };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function enumerateInputs(
  inputDir: string,
  shouldCancel?: () => boolean,
  onProgress?: PrecompileOptions["onSnapshotProgress"],
): Promise<Array<{ file: string; sha256: string; hasDxil: boolean; malformed: boolean }>> {
  const files: string[] = [];
  const pendingDirs = [inputDir];
  let scanned = 0;
  while (pendingDirs.length) {
    if (shouldCancel?.()) throw new PrecompileCancelledError("Annullato durante l'enumerazione; snapshot non completato.");
    const dir = pendingDirs.pop();
    if (!dir) continue;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldCancel?.()) throw new PrecompileCancelledError("Annullato durante l'enumerazione; snapshot non completato.");
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git")
        pendingDirs.push(fullPath);
      else if (entry.isFile() && [".dxil", ".cso"].includes(path.extname(entry.name).toLowerCase()))
        files.push(fullPath);
      scanned++;
      if (scanned % 64 === 0) {
        onProgress?.("enumerating", scanned);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
  onProgress?.("enumerating", scanned);
  files.sort((a, b) => a.localeCompare(b));
  const snapshot: Array<{ file: string; sha256: string; hasDxil: boolean; malformed: boolean }> = [];
  for (let index = 0; index < files.length; index++) {
    if (shouldCancel?.()) throw new PrecompileCancelledError("Annullato durante la snapshot dei file; nessuno shader è stato convertito.");
    const file = files[index];
    const bytes = await fs.promises.readFile(file);
    let hasDxil = false;
    let malformed = false;
    try {
      hasDxil = dxilAnalyzer.parseContainer(bytes)?.hasDxil === true;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      malformed = true;
    }
    snapshot.push({ file, sha256: createHash("sha256").update(bytes).digest("hex"), hasDxil, malformed });
    onProgress?.("hashing", index + 1, files.length);
  }
  return snapshot;
}

function emitProgress(
  options: PrecompileOptions,
  total: number,
  results: PrecompileFileResult[],
  counts: Omit<PrecompileReport, "inputDir" | "outputDir" | "total" | "results">,
  currentFile?: string,
  currentStatus?: PrecompileProgress["currentStatus"],
): void {
  options.onProgress?.({
    total,
    settled: results.length,
    currentFile,
    currentStatus,
    latestResult: results[results.length - 1],
    counts: { ...counts },
  });
}

export async function precompileDxilDirectory(
  options: PrecompileOptions,
  dependencies: PrecompileDependencies = {},
): Promise<PrecompileReport> {
  const inputDir = path.resolve(options.inputDir);
  const outputDir = path.resolve(options.outputDir);
  if (!fs.statSync(inputDir).isDirectory()) throw new Error(`La cartella di input non è valida: ${inputDir}`);
  if (isWithin(inputDir, outputDir) || isWithin(outputDir, inputDir))
    throw new Error("La cartella staging deve essere separata dalla cartella degli shader di input.");
  if (fs.existsSync(outputDir)) throw new Error(`La cartella staging esiste già: ${outputDir}`);
  fs.mkdirSync(outputDir);

  const snapshot = await enumerateInputs(inputDir, options.shouldCancel, options.onSnapshotProgress);
  const results: PrecompileFileResult[] = [];
  const compiledInputs = new Map<string, string>();
  const outputHashes = new Map<string, string>();
  const converter = dependencies.converter ?? convertDxilToHlsl;
  const runner = dependencies.runner ?? run;
  const fxcPath = dependencies.fxcPath ?? findFxc;
  const counts = { compiled: 0, blocked: 0, failed: 0, skipped: 0, cancelled: 0 };
  const settle = (result: PrecompileFileResult, currentStatus: PrecompileProgress["currentStatus"] = result.status) => {
    results.push(result);
    counts[result.status]++;
    emitProgress(options, snapshot.length, results, counts, result.file, currentStatus);
  };
  emitProgress(options, snapshot.length, results, counts);

  for (const entry of snapshot) {
    const relativeFile = path.relative(inputDir, entry.file);
    if (options.shouldCancel?.()) {
      settle({ file: relativeFile, status: "cancelled", message: "Annullato prima dell'avvio." });
      continue;
    }
    if (!entry.hasDxil) {
      const status = entry.malformed || path.extname(entry.file).toLowerCase() === ".dxil" ? "failed" : "skipped";
      const message = status === "failed" ? "Container DXIL non valido o privo di payload DXIL."
        : "Container privo di payload DXIL.";
      settle({ file: relativeFile, status, message });
      continue;
    }

    emitProgress(options, snapshot.length, results, counts, relativeFile, "converting");
    try {
      const currentBytes = await fs.promises.readFile(entry.file);
      if (createHash("sha256").update(currentBytes).digest("hex") !== entry.sha256)
        throw new Error("Il file è cambiato dopo lo snapshot iniziale; non convertito.");

      const disasmPath = disassemblyPathFor(entry.file);
      if (!disasmPath)
        throw new BlockedPrecompileError("Disassemblato DXC assente; stage e feature non sono verificabili.");
      const report = analyzeFiles(entry.file, disasmPath);
      if (report.container?.program && report.stage && report.container.program.type !== report.stage)
        throw new BlockedPrecompileError(`Stage del disassemblato (${report.stage}) diverso da quello del container (${report.container.program.type}).`);
      const blockers = report.findings.filter((finding) => finding.sev === "blocker");
      if (blockers.length)
        throw new BlockedPrecompileError(`Feature non supportate per SM5:\n${formatReport(report, path.basename(entry.file))}`);
      const profile = PROFILE_BY_STAGE[report.stage ?? ""];
      if (!profile)
        throw new BlockedPrecompileError(`Stage DXIL non disponibile o non supportato: ${report.stage ?? "sconosciuto"}.`);
      const outputHash = fnv1a64(currentBytes);
      const priorOutput = compiledInputs.get(entry.sha256);
      if (priorOutput) {
        settle({
          file: relativeFile,
          status: "compiled",
          message: "Bytecode identico a uno shader già compilato in questo job; output riutilizzato.",
          outputPath: priorOutput,
        });
        continue;
      }
      if (outputHashes.has(outputHash) && outputHashes.get(outputHash) !== entry.sha256)
        throw new Error(`Collisione FNV-1a64 per il nome output ${outputHash}; file non scritto.`);

      const converted = await converter({
        inputPath: entry.file,
        disasmPath,
        bindingMapPath: options.bindingMapPath,
        bufferMode: "raw",
        shouldCancel: options.shouldCancel,
      });
      if (options.shouldCancel?.()) throw new PrecompileCancelledError("Annullato dopo la conversione HLSL.");
      const localBindings = converted.post.warnings.filter((warning) => warning.includes("assegnato localmente"));
      if (localBindings.length)
        throw new BlockedPrecompileError(`Mappa binding necessaria per i register space:\n${localBindings.join("\n")}`);
      if (!converted.post.entryPoint)
        throw new BlockedPrecompileError("Entry point HLSL generato non riconosciuto; compilazione non tentata.");

      const hlslPath = path.join(os.tmpdir(), `shader-lab-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.hlsl`);
      const temporaryCso = path.join(outputDir, `.${path.basename(entry.file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp.cso`);
      const finalCso = path.join(outputDir, `${outputHash}.cso`);
      try {
        await fs.promises.writeFile(hlslPath, converted.hlsl, "utf8");
        const args = ["/nologo", "/T", profile, "/E", converted.post.entryPoint, "/Fo", temporaryCso, hlslPath];
        const compile: RunResult = await runner(fxcPath(), args);
        if (compile.missing) throw new Error(`${compile.stderr}\nInstallare il Windows SDK o impostare FXC_PATH.`);
        if (compile.code !== 0) throw new Error(`FXC (${profile}) fallito:\n${compile.stderr || compile.stdout}`);
        if (options.shouldCancel?.()) throw new PrecompileCancelledError("Annullato al termine della compilazione FXC.");
        if (!fs.existsSync(temporaryCso)) throw new Error("FXC ha restituito successo ma non ha prodotto il file .cso.");
        const compiledBytes = await fs.promises.readFile(temporaryCso);
        const compiledContainer = dxilAnalyzer.parseContainer(compiledBytes);
        if (!compiledContainer?.hasLegacy || compiledContainer.hasDxil)
          throw new Error("FXC non ha prodotto un container DXBC legacy utilizzabile come candidato SM5.");
        fs.linkSync(temporaryCso, finalCso);
        fs.unlinkSync(temporaryCso);
      } finally {
        if (fs.existsSync(hlslPath)) fs.unlinkSync(hlslPath);
        if (fs.existsSync(temporaryCso)) fs.unlinkSync(temporaryCso);
      }

      const warnings = converted.post.warnings.filter((warning) => !warning.includes("assegnato localmente"));
      if (report.stage === "ps")
        warnings.push("Compatibilità della firma con il VS abbinato non verificata.");
      compiledInputs.set(entry.sha256, finalCso);
      outputHashes.set(outputHash, entry.sha256);
      settle({
        file: relativeFile,
        status: "compiled",
        message: warnings.length ? `Compilato con avvisi: ${warnings.join(" ")}` : "Compilazione FXC riuscita; equivalenza e rendering non verificati.",
        outputPath: finalCso,
      });
    } catch (error) {
      const status = error instanceof BlockedPrecompileError ? "blocked"
        : error instanceof PrecompileCancelledError ? "cancelled" : "failed";
      settle({ file: relativeFile, status, message: messageOf(error) });
    }
  }

  return { inputDir, outputDir, total: snapshot.length, ...counts, results };
}

export function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

class BlockedPrecompileError extends Error {}
