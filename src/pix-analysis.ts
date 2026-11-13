import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeFiles, type DxilReport } from "./dxil-analyzer.js";
import { run } from "./external.js";
import { analyzePixCapture, formatPixReport, findPixTool, type PixCaptureReport } from "./pix-capture.js";

export interface PixDeepAnalysisOptions {
  pixPath: string;
  outputDir: string;
  eventListPath?: string;
  pixExportDir?: string;
  queueName?: string;
  pixToolPath?: string;
  dxcPath?: string;
  powerShellPath?: string;
}
interface ShaderStage {
  stage: string;
  byteLength: number;
}

interface PsoRead {
  psoId: number;
  offset: number;
  compressedSize: number;
  decodedSize: number;
  shaders: ShaderStage[];
}

interface ExtractedShader {
  psoId: number;
  stage: string;
  byteLength: number;
  sha256: string;
  fileName: string;
  shaderModel?: string;
  report: DxilReport;
  psoRefs: number[];
}

interface EventListInfo {
  path: string;
  eventRows: number;
  psoIds: number[];
}

export interface PixDeepAnalysisReport {
  pixPath: string;
  outputDir: string;
  queueName: string | null;
  queueNameVerifiedByFile: false;
  staticScan: PixCaptureReport;
  eventList: EventListInfo | null;
  eventExportWarning: string | null;
  psoCount: number;
  shaderPayloadCount: number;
  uniqueShaderCount: number;
  disassembledCount: number;
  disassemblyFailures: string[];
  unmatchedEventPsoIds: number[];
  verdicts: Record<string, number>;
  stages: Record<string, number>;
  shaderModels: Record<string, number>;
  findings: Record<string, { severity: string; shaders: number; occurrences: number; message: string }>;
  artifacts: {
    reportJson: string;
    reportMarkdown: string;
    shaderMapCsv: string;
    eventList: string | null;
    shadersDirectory: string;
  };
}

const STAGE_BYTECODE = /(?:cpsoDesc|pssDesc)\.(VS|PS|GS|HS|DS|CS)\s*=\s*\{\s*reinterpret_cast<BYTE\*>\(&data\[offset\]\),\s*(\d+)\s*\}\s*;/g;
const RESOURCE_READ = /g_resourceReader->Read\(\s*\w+\s*,\s*(\d+)\s*\)\s*;/;
const API_FUNCTION = /void\s+([A-Za-z0-9_]+)\s*\(\s*\)\s*\{([\s\S]*?)(?=\r?\n\/\/ ApiObjectId|\r?\nvoid\s+[A-Za-z0-9_]+\s*\(\s*\)\s*\{|\s*$)/g;
const INITIALIZER_CALL = /\b((?:CreateAndInitResource|CreateComputePipelineState|CreatePipelineState)_\d+)\s*\(\s*\)\s*;/g;

function extractFunctions(source: string, functions: Map<string, string>): void {
  API_FUNCTION.lastIndex = 0;
  for (const match of source.matchAll(API_FUNCTION)) functions.set(match[1], match[2]);
}

export function buildPixPsoReads(exportDirectory: string): PsoRead[] {
  const resourcesPath = path.join(exportDirectory, "resources.bin");
  const psoPath = path.join(exportDirectory, "CreatePSOs.cpp");
  if (!fs.existsSync(resourcesPath) || !fs.existsSync(psoPath)) {
    throw new Error("Export C++ PIX incompleto: servono resources.bin e CreatePSOs.cpp.");
  }

  const frameFiles = fs.readdirSync(exportDirectory)
    .filter((name) => /^FrameResources_\d+\.cpp$/i.test(name))
    .sort();
  if (!frameFiles.length) throw new Error("Export C++ PIX incompleto: FrameResources_*.cpp non trovato.");

  const functions = new Map<string, string>();
  const orderedCalls: string[] = [];
  for (const name of frameFiles) {
    const text = fs.readFileSync(path.join(exportDirectory, name), "utf8");
    INITIALIZER_CALL.lastIndex = 0;
    for (const match of text.matchAll(INITIALIZER_CALL)) orderedCalls.push(match[1]);
  }

  for (const name of fs.readdirSync(exportDirectory)) {
    if (/^(?:CreateAndInitResources_\d+|CreatePSOs)\.cpp$/i.test(name)) {
      extractFunctions(fs.readFileSync(path.join(exportDirectory, name), "utf8"), functions);
    }
  }

  const psoReads: PsoRead[] = [];
  let resourceOffset = 0;
  for (const functionName of orderedCalls) {
    const body = functions.get(functionName);
    if (!body) throw new Error(`Funzione PIX mancante nell'export: ${functionName}.`);
    const read = body.match(RESOURCE_READ);
    if (!read) throw new Error(`Lettura risorsa non riconosciuta in ${functionName}.`);
    const compressedSize = Number(read[1]);
    if (!Number.isSafeInteger(compressedSize) || compressedSize <= 0) {
      throw new Error(`Dimensione risorsa non valida in ${functionName}.`);
    }

    const pso = functionName.match(/^(?:CreateComputePipelineState|CreatePipelineState)_(\d+)$/);
    if (pso) {
      STAGE_BYTECODE.lastIndex = 0;
      const shaders = [...body.matchAll(STAGE_BYTECODE)].map((match) => ({
        stage: match[1],
        byteLength: Number(match[2]),
      }));
      if (!shaders.length || shaders.some((shader) => !Number.isSafeInteger(shader.byteLength) || shader.byteLength <= 0)) {
        throw new Error(`Bytecode PSO non riconosciuto: ${functionName}.`);
      }
      psoReads.push({
        psoId: Number(pso[1]),
        offset: resourceOffset,
        compressedSize,
        decodedSize: shaders.reduce((sum, shader) => sum + shader.byteLength, 0),
        shaders,
      });
    }
    resourceOffset += compressedSize;
  }

  const resourcesSize = fs.statSync(resourcesPath).size;
  if (resourceOffset > resourcesSize) {
    throw new Error(`Letture generate (${resourceOffset}) oltre resources.bin (${resourcesSize} byte).`);
  }
  if (!psoReads.length) throw new Error("Nessun PSO trovato nell'export C++ PIX.");
  return psoReads;
}

function findDxc(configured?: string): string | null {
  const override = configured || process.env.DXC_PATH;
  if (override) {
    if (!fs.existsSync(override) || !fs.statSync(override).isFile()) {
      throw new Error(`dxc.exe configurato non trovato: ${override}`);
    }
    return override;
  }
  if (process.platform === "win32") {
    for (const root of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]) {
      if (!root) continue;
      const bin = path.join(root, "Windows Kits", "10", "bin");
      if (!fs.existsSync(bin)) continue;
      const versions = fs.readdirSync(bin).filter((entry) => /^10\./.test(entry)).sort().reverse();
      for (const version of versions) {
        const candidate = path.join(bin, version, "x64", "dxc.exe");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "dxc.exe");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function findPowerShell(configured?: string): string {
  const override = configured || process.env.POWERSHELL_PATH;
  if (override) {
    if (!fs.existsSync(override) || !fs.statSync(override).isFile()) {
      throw new Error(`PowerShell configurato non trovato: ${override}`);
    }
    return override;
  }
  if (process.platform !== "win32") throw new Error("PowerShell è richiesto per l'estrazione XPRESS su Windows.");
  const systemRoot = process.env.SystemRoot;
  const windowsPowerShell = systemRoot && path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (windowsPowerShell && fs.existsSync(windowsPowerShell)) return windowsPowerShell;
  return "powershell.exe";
}

function resolvePixTool(configured?: string): string | null {
  if (configured) {
    if (!fs.existsSync(configured) || !fs.statSync(configured).isFile()) {
      throw new Error(`pixtool.exe configurato non trovato: ${configured}`);
    }
    return configured;
  }
  return findPixTool();
}

async function exportCppProject(pixPath: string, exportDirectory: string, pixToolPath?: string): Promise<void> {
  const pixtool = resolvePixTool(pixToolPath);
  if (!pixtool) throw new Error("pixtool.exe non trovato. Imposta PIXTOOL_PATH o fornisci un export C++ PIX esistente.");
  const result = await run(
    pixtool,
    ["--output=verbose", "--log=off", "open-capture", pixPath, "export-to-cpp", exportDirectory],
    10 * 60 * 1000,
  );
  if (result.code !== 0) {
    throw new Error(`Export C++ PIX fallito (codice ${result.code}): ${(result.stderr || result.stdout).slice(-6000)}`);
  }
}

async function exportEventList(pixPath: string, eventPath: string, queueName?: string, pixToolPath?: string): Promise<string | null> {
  const pixtool = resolvePixTool(pixToolPath);
  if (!pixtool) return "pixtool.exe non trovato: event list non esportata.";

  const args = ["--output=verbose", "--log=off", "open-capture", pixPath, "save-event-list", eventPath];
  if (queueName) args.push(`--queue-name=${queueName}`);
  let result = await run(pixtool, args, 10 * 60 * 1000);
  if (result.code === 0 && fs.existsSync(eventPath)) return null;

  if (queueName) {
    const queueError = (result.stderr || result.stdout).slice(-3000);
    result = await run(
      pixtool,
      ["--output=verbose", "--log=off", "open-capture", pixPath, "save-event-list", eventPath],
      10 * 60 * 1000,
    );
    if (result.code === 0 && fs.existsSync(eventPath)) {
      return `pixtool non ha accettato --queue-name; event list esportata senza filtro. Dettaglio: ${queueError}`;
    }
  }
  return `Event list PIX non esportata (codice ${result.code}): ${(result.stderr || result.stdout).slice(-3000)}`;
}

async function runShaderExtraction(
  exportDirectory: string,
  shadersDirectory: string,
  powerShellPath?: string,
): Promise<ExtractedShader[]> {
  if (process.platform !== "win32") throw new Error("Estrazione XPRESS dei PSO PIX disponibile solo su Windows.");
  const reads = buildPixPsoReads(exportDirectory);
  const resourcesPath = path.join(exportDirectory, "resources.bin");
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "extract-pix-shaders.ps1");
  if (!fs.existsSync(helperPath)) throw new Error(`Helper XPRESS non trovato: ${helperPath}`);
  fs.mkdirSync(shadersDirectory, { recursive: true });

  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shaderlab-pix-plan-"));
  const planPath = path.join(workDirectory, "plan.json");
  const resultPath = path.join(workDirectory, "result.json");
  try {
    fs.writeFileSync(planPath, JSON.stringify({
      resourcesPath,
      outputDirectory: shadersDirectory,
      resultPath,
      entries: reads.map((read) => ({ ...read })),
    }), "utf8");

    const shell = findPowerShell(powerShellPath);
    const result = await run(shell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath, planPath,
    ], 10 * 60 * 1000);
    if (result.code !== 0 || !fs.existsSync(resultPath)) {
      throw new Error(`Estrazione shader XPRESS fallita (codice ${result.code}): ${(result.stderr || result.stdout).slice(-6000)}`);
    }
    const extracted = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
      shaders: Omit<ExtractedShader, "report" | "psoRefs">[];
    };
    return extracted.shaders.map((shader) => ({
      ...shader,
      report: { requires: [], bindings: [], opCounts: {}, findings: [], limits: [], verdict: "convertible" },
      psoRefs: [],
    }));
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

function readEventList(eventListPath: string): EventListInfo {
  const lines = fs.readFileSync(eventListPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("Event list vuota o priva di righe evento.");
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const header = lines[0].split(delimiter).map((value) => value.trim());
  const nameIndex = header.findIndex((value) => /^name$/i.test(value));
  if (nameIndex < 0) throw new Error("Event list non riconosciuta: colonna Name mancante.");

  const psoIds = new Set<number>();
  for (const line of lines.slice(1)) {
    const columns = line.split(delimiter);
    const match = (columns[nameIndex] ?? "").match(/SetPipelineState.*?obj#(\d+)/i);
    if (match) psoIds.add(Number(match[1]));
  }
  return { path: eventListPath, eventRows: lines.length - 1, psoIds: [...psoIds].sort((a, b) => a - b) };
}

function csvCell(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function writeShaderMap(filePath: string, shaders: ExtractedShader[], eventPsoIds: Set<number>): void {
  const lines = ["psoId,stage,byteLength,sha256,shaderModel,verdict,findings,eventReferenced"];
  for (const shader of shaders) {
    lines.push([
      shader.psoId, shader.stage, shader.byteLength, shader.sha256, shader.shaderModel,
      shader.report.verdict, shader.report.findings.map((finding) => finding.code).join(";"),
      eventPsoIds.has(shader.psoId),
    ].map(csvCell).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function summarize(shaders: ExtractedShader[]) {
  const verdicts: Record<string, number> = {};
  const stages: Record<string, number> = {};
  const shaderModels: Record<string, number> = {};
  const findings = new Map<string, { severity: string; shaders: Set<string>; occurrences: number; message: string }>();

  for (const shader of shaders) {
    const report = shader.report;
    verdicts[report.verdict] = (verdicts[report.verdict] ?? 0) + 1;
    if (report.stage) stages[report.stage] = (stages[report.stage] ?? 0) + 1;
    if (report.shaderModel) shaderModels[report.shaderModel] = (shaderModels[report.shaderModel] ?? 0) + 1;
    for (const finding of report.findings) {
      const aggregate = findings.get(finding.code) ?? {
        severity: finding.sev, shaders: new Set<string>(), occurrences: 0, message: finding.message,
      };
      aggregate.shaders.add(shader.sha256);
      aggregate.occurrences += finding.count ?? 1;
      findings.set(finding.code, aggregate);
    }
  }

  return {
    verdicts,
    stages,
    shaderModels,
    findings: Object.fromEntries([...findings.entries()].map(([code, value]) => [code, {
      severity: value.severity,
      shaders: value.shaders.size,
      occurrences: value.occurrences,
      message: value.message,
    }])),
  };
}

function markdownReport(report: PixDeepAnalysisReport): string {
  const lines = [
    `# Analisi PIX: ${path.basename(report.pixPath)}`,
    "",
    `- Cattura originale non modificata: \`${report.pixPath}\``,
    `- Queue richiesta: ${report.queueName ?? "non specificata"}`,
    `- Queue verificabile dal file event list: no (il formato non conserva il nome queue)`,
    `- Eventi: ${report.eventList?.eventRows ?? "non disponibili"}`,
    `- PSO referenziati: ${report.eventList?.psoIds.length ?? "non disponibili"}`,
    `- PSO estratti dall'export C++: ${report.psoCount}`,
    `- Payload shader: ${report.shaderPayloadCount}; container unici: ${report.uniqueShaderCount}`,
    `- Disassemblati DXC: ${report.disassembledCount}/${report.uniqueShaderCount}`,
    "",
    "## Esito statico",
    ...Object.entries(report.verdicts).map(([name, count]) => `- ${name}: ${count}`),
    "",
    "## Rilevazioni",
    ...Object.entries(report.findings).map(([code, finding]) =>
      `- ${code} (${finding.severity}): ${finding.shaders} shader; ${finding.message}`),
    "",
    "## Limiti",
    "- IPSO/shader sono stati estratti dall'export C++ PIX, non decodificando direttamente il formato .wpix.",
    "- I verdetti sono analisi statica di DXC e non provano equivalenza visiva o compatibilità runtime D3D11.",
    "- Un event list PIX non incorpora il nome della queue; l'etichetta queue è quella richiesta dall'utente.",
  ];
  if (report.eventExportWarning) lines.push("", `Avviso export eventi: ${report.eventExportWarning}`);
  if (report.disassemblyFailures.length) lines.push("", "Disassemblati non riusciti:", ...report.disassemblyFailures.map((failure) => `- ${failure}`));
  if (report.unmatchedEventPsoIds.length) lines.push("", `PSO evento non trovati nell'export: ${report.unmatchedEventPsoIds.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

export async function analyzePixDeep(options: PixDeepAnalysisOptions): Promise<PixDeepAnalysisReport> {
  const pixPath = path.resolve(options.pixPath);
  const outputDir = path.resolve(options.outputDir);
  if (!pixPath.toLowerCase().endsWith(".wpix")) throw new Error("pixPath deve indicare un file .wpix.");
  if (!fs.existsSync(pixPath) || !fs.statSync(pixPath).isFile()) throw new Error(`Cattura PIX non trovata: ${pixPath}`);
  if (path.resolve(outputDir) === pixPath) throw new Error("La cartella output non può essere il file .wpix.");
  fs.mkdirSync(outputDir, { recursive: true });

  const staticScan = await analyzePixCapture(pixPath);
  const scanPath = path.join(outputDir, "pix-scan.json");
  fs.writeFileSync(scanPath, `${JSON.stringify(staticScan, null, 2)}\n`, "utf8");

  const shadersDirectory = path.join(outputDir, "shaders");
  const ownWorkDirectory = options.pixExportDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), "shaderlab-pix-cpp-"));
  const exportDirectory = options.pixExportDir ? path.resolve(options.pixExportDir) : path.join(ownWorkDirectory!, "export");
  let eventPath = options.eventListPath ? path.resolve(options.eventListPath) : null;
  let eventExportWarning: string | null = null;
  let keepWorkDirectory = false;

  try {
    if (options.pixExportDir) {
      if (!fs.existsSync(exportDirectory) || !fs.statSync(exportDirectory).isDirectory()) {
        throw new Error(`Cartella export C++ PIX non trovata: ${exportDirectory}`);
      }
    } else {
      await exportCppProject(pixPath, exportDirectory, options.pixToolPath);
    }

    if (eventPath) {
      if (!fs.existsSync(eventPath) || !fs.statSync(eventPath).isFile()) {
        throw new Error(`Event list non trovato: ${eventPath}`);
      }
      const copiedEventPath = path.join(outputDir, path.basename(eventPath));
      if (path.resolve(eventPath) !== path.resolve(copiedEventPath)) fs.copyFileSync(eventPath, copiedEventPath);
      eventPath = copiedEventPath;
    } else {
      eventPath = path.join(outputDir, "events.csv");
      eventExportWarning = await exportEventList(pixPath, eventPath, options.queueName, options.pixToolPath);
      if (eventExportWarning && !fs.existsSync(eventPath)) eventPath = null;
    }

    const eventList = eventPath ? readEventList(eventPath) : null;
    const extracted = await runShaderExtraction(exportDirectory, shadersDirectory, options.powerShellPath);
    const psoRefsByHash = new Map<string, Set<number>>();
    for (const shader of extracted) {
      const refs = psoRefsByHash.get(shader.sha256) ?? new Set<number>();
      refs.add(shader.psoId);
      psoRefsByHash.set(shader.sha256, refs);
    }

    const disassemblyFailures: string[] = [];
    const dxc = findDxc(options.dxcPath);
    let disassembledCount = 0;
    const uniqueShaders = [...new Map(extracted.map((shader) => [shader.sha256, shader])).values()];
    if (dxc) {
      let next = 0;
      const worker = async () => {
        while (next < uniqueShaders.length) {
          const shader = uniqueShaders[next++];
          const binaryPath = path.join(shadersDirectory, shader.fileName);
          const disasmPath = path.join(shadersDirectory, `${shader.sha256}_dxil.txt`);
          const result = await run(dxc, ["-dumpbin", binaryPath], 60_000);
          if (result.code !== 0) {
            disassemblyFailures.push(`${shader.sha256}: ${(result.stderr || result.stdout).slice(-1000)}`);
            shader.report = analyzeFiles(binaryPath);
          } else {
            fs.writeFileSync(disasmPath, result.stdout, "utf8");
            shader.report = analyzeFiles(binaryPath, disasmPath);
            disassembledCount++;
          }
          shader.shaderModel = shader.report.shaderModel;
          shader.psoRefs = [...(psoRefsByHash.get(shader.sha256) ?? [])].sort((a, b) => a - b);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, uniqueShaders.length) }, () => worker()));
    } else {
      for (const shader of uniqueShaders) {
        shader.report = analyzeFiles(path.join(shadersDirectory, shader.fileName));
        shader.shaderModel = shader.report.shaderModel;
        shader.psoRefs = [...(psoRefsByHash.get(shader.sha256) ?? [])].sort((a, b) => a - b);
      }
      disassemblyFailures.push("DXC non trovato; salvati i container, senza disassemblati.");
    }

    const eventPsoIds = new Set(eventList?.psoIds ?? []);
    const unmatchedEventPsoIds = [...eventPsoIds].filter((id) => !extracted.some((shader) => shader.psoId === id));
    const stats = summarize(uniqueShaders);
    const shaderMapCsv = path.join(outputDir, "shader-map.csv");
    writeShaderMap(shaderMapCsv, extracted, eventPsoIds);

    const report: PixDeepAnalysisReport = {
      pixPath,
      outputDir,
      queueName: options.queueName ?? null,
      queueNameVerifiedByFile: false,
      staticScan,
      eventList: eventList ? { ...eventList, psoIds: eventList.psoIds } : null,
      eventExportWarning,
      psoCount: buildPixPsoReads(exportDirectory).length,
      shaderPayloadCount: extracted.length,
      uniqueShaderCount: uniqueShaders.length,
      disassembledCount,
      disassemblyFailures,
      unmatchedEventPsoIds,
      ...stats,
      artifacts: {
        reportJson: path.join(outputDir, "analysis.json"),
        reportMarkdown: path.join(outputDir, "analysis.md"),
        shaderMapCsv,
        eventList: eventList ? eventPath : null,
        shadersDirectory,
      },
    };

    const shaderReports = uniqueShaders.map((shader) => ({
      sha256: shader.sha256,
      byteLength: shader.byteLength,
      fileName: shader.fileName,
      shaderModel: shader.shaderModel,
      psoIds: shader.psoRefs,
      report: shader.report,
    }));
    fs.writeFileSync(report.artifacts.reportJson, `${JSON.stringify({ ...report, shaderReports }, null, 2)}\n`, "utf8");
    fs.writeFileSync(report.artifacts.reportMarkdown, markdownReport(report), "utf8");
    keepWorkDirectory = false;
    return report;
  } catch (error) {
    keepWorkDirectory = true;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${ownWorkDirectory ? `\nExport temporaneo conservato per diagnosi: ${ownWorkDirectory}` : ""}`,
    );
  } finally {
    if (ownWorkDirectory && !keepWorkDirectory) fs.rmSync(ownWorkDirectory, { recursive: true, force: true });
  }
}
