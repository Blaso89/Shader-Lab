import { analyze, formatFindings } from "./analyzer.js";
import { convert } from "./converter.js";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const sample = `
// WaveActiveSum in un commento non deve contare
struct Params { float4 tint; float16_t gain; };
ConstantBuffer<Params> g_params : register(b0, space1);
cbuffer Main : register(b0) { float4x4 vp; }
Texture2D<float4> tex : register(t0, space0);
Texture2D<float4> tex2 : register(t0, space2);
SamplerState smp : register(s0);

[shader("pixel")]
float4 main(float2 uv : TEXCOORD0) : SV_Target
{
    uint idx = NonUniformResourceIndex(uv.x > 0.5 ? 1 : 0);
    float16_t2 h = float16_t2(uv);
    float a = select(uv.x > 0.5, select(uv.y > 0.5, 1.0, 2.0), 3.0);
    uint d = dot4add_u8packed(0x01020304, 0x01010101, 0);
    return tex.Sample(smp, uv) * g_params.tint * a + d + h.x;
}
`;
const r = convert(sample);
console.log(r.output); console.log(r.changes); console.log(r.registerMap);
assert(!/space/.test(r.output.replace(/\/\/.*$/gm, "")), "space residuo");
assert(r.output.includes("cbuffer g_params_cb : register(b1)"), "cbuffer atteso su b1");
assert(r.output.includes("register(t1)"), "tex2 -> t1");
assert(r.output.includes("((uv.x > 0.5) ? (((uv.y > 0.5) ? (1.0) : (2.0))) : (3.0))"), "select annidato");
assert(r.output.includes("min16float2 h = min16float2(uv)"), "tipi 16-bit");
assert(!r.output.includes("NonUniformResourceIndex") && !r.output.includes("[shader"), "attributi");
assert.equal(r.remaining.length, 0, "nessun residuo");

const bad = analyze(`float x = WaveActiveSum(1); RaytracingAccelerationStructure s; uint64_t v; t.SampleCmpLevel(a,b,c,d);
[WaveSize(32)] void f(){} // WaveReadLaneAt`);
console.log(formatFindings(bad));
const codes = new Set(bad.map((f) => f.code));
for (const c of ["W001", "R001", "I001", "X003", "A002"]) assert(codes.has(c), c);
assert.equal(bad.filter((f) => f.code === "W001").length, 1, "WaveSize/commenti non devono contare come wave");

// ---- analizzatore DXIL (regressione sul parsing dei binding del disassemblato DXC)
import { analyzeDisasm, compareShaderSignatures, parseInputSignature, parseOutputSignature } from "./dxil-analyzer.js";
import { postprocessHlsl } from "./hlsl-post.js";
import { analyzeSource, DEFAULT_LIMITS, findPixTool, resolveLimits, type ByteSource } from "./pix-capture.js";
import { exportPixDrawResource, listPixEvents, parsePixEventListText } from "./pix-events.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildPixPrompt, buildPixEventListPrompt, buildPixResourcePrompt } = require("../vscode-extension/pix.cjs") as {
  buildPixPrompt: (file: string, options?: Record<string, unknown>) => string;
  buildPixEventListPrompt: (options: Record<string, unknown>) => string;
  buildPixResourcePrompt: (options: Record<string, unknown>) => string;
};
type McpConnectionState = "unknown" | "starting" | "connected" | "disconnected";
const {
  createMcpServerLogMonitor,
  findWindowLogDirectory,
  parseMcpConnectionState,
  parseMcpServerLogFileName,
} = require("../vscode-extension/mcp-log-monitor.cjs") as {
  createMcpServerLogMonitor: (
    logPath: string,
    serverName: string,
    onState: (state: McpConnectionState, definitionId: string | undefined) => void,
    onError?: (error: Error) => void,
  ) => { dispose: () => void };
  findWindowLogDirectory: (logPath: string) => string | undefined;
  parseMcpConnectionState: (contents: string) => McpConnectionState | undefined;
  parseMcpServerLogFileName: (fileName: string, serverName: string) => string | undefined;
};
assert.equal(
  parseMcpServerLogFileName("mcpServer.mcp.config.ws14.sm6-to-sm5.log", "sm6-to-sm5"),
  "mcp.config.ws14.sm6-to-sm5",
  "il log rivela l'ID MCP completo usato da VS Code",
);
assert.equal(parseMcpServerLogFileName("mcpServer.other.log", "sm6-to-sm5"), undefined);
assert.equal(parseMcpConnectionState("Stato connessione: Arrestato\n"), "disconnected");
assert.equal(parseMcpConnectionState("Stato connessione: Avvio\n"), "starting");
assert.equal(parseMcpConnectionState("Stato connessione: In esecuzione\n"), "connected");
assert.equal(parseMcpConnectionState("Connection state: Stopped\n"), "disconnected");
assert.equal(parseMcpConnectionState("Discovered 11 tools\n"), "connected");
const monitorRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shader-lab-mcp-log-"));
const windowLogDirectory = path.join(monitorRoot, "window2");
const extensionLogPath = path.join(windowLogDirectory, "exthost", "local-tools.shader-lab");
const serverLogPath = path.join(windowLogDirectory, "mcpServer.mcp.config.ws14.sm6-to-sm5.log");
fs.mkdirSync(extensionLogPath, { recursive: true });
fs.writeFileSync(serverLogPath, "Stato connessione: Arrestato\n");
assert.equal(findWindowLogDirectory(extensionLogPath), windowLogDirectory);
let resolveRunning!: () => void;
let rejectRunning!: (error: Error) => void;
const runningObserved = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("timeout monitor stato MCP")), 1500);
  resolveRunning = () => {
    clearTimeout(timeout);
    resolve();
  };
  rejectRunning = (error) => {
    clearTimeout(timeout);
    reject(error);
  };
});
let observedDefinitionId: string | undefined;
const logMonitor = createMcpServerLogMonitor(
  extensionLogPath,
  "sm6-to-sm5",
  (state, definitionId) => {
    observedDefinitionId = definitionId;
    if (state === "connected") resolveRunning();
  },
  rejectRunning,
);
try {
  assert.equal(observedDefinitionId, "mcp.config.ws14.sm6-to-sm5");
  fs.appendFileSync(serverLogPath, "Stato connessione: In esecuzione\n");
  await runningObserved;
  assert.equal(observedDefinitionId, "mcp.config.ws14.sm6-to-sm5");
} finally {
  logMonitor.dispose();
  fs.rmSync(monitorRoot, { recursive: true, force: true });
}
const fake = [
  '; Note: shader requires additional functionality:',
  ';       64-bit Atomics on Typed Resources',
  '; Resource Bindings:',
  '; Name                                 Type  Format         Dim      ID      HLSL Bind  Count',
  '; ------------------------------ ---------- ------- ----------- ------- -------------- ------',
  ';                                   cbuffer      NA          NA     CB0            cb0     1',
  ';                                   cbuffer      NA          NA     CB5     cb0,space3     1',
  ';                                   texture  struct         r/o      T0             t0     1',
  ';                                       UAV     u32          2d      U0             u0     1',
  '; ViewId state:',
  '; NumThreads=(64,1,1)',
  '; EntryFunctionName: MainCS',
  '!3 = !{!"cs", i32 6, i32 6}',
  '  %1 = call i64 @dx.op.atomicBinOp.i64(i32 78, %dx.types.Handle %h, i32 7, i32 %a, i32 %b, i32 undef, i64 %c)',
  '  %2 = call i32 @dx.op.quadOp.i32(i32 123, i32 %v, i8 0)',
].join("\n");
const rep = analyzeDisasm(fake);
assert.equal(rep.bindings.length, 4, "binding (incl. cbuffer)");
assert(rep.bindings.some((b) => b.cls === "b" && b.slot === 0 && b.space === 3), "cb0,space3");
assert(rep.findings.some((f) => f.code === "I002") && rep.findings.some((f) => f.code === "W001"), "atomic64 + quad");
assert.equal(rep.verdict, "not-convertible");
assert.equal(rep.numThreads, "(64,1,1)", "numthreads letto dal disassemblato");
assert.equal(rep.entry, "MainCS", "entry originale letto dal disassemblato");

// ---- firme FXC/DXC e validazione delle coppie VS/PS
const fxcSignatures = [
  "// Input signature:",
  "// Name                 Index   Mask Register SysValue  Format   Used",
  "// -------------------- ----- ------ -------- -------- ------- ------",
  "// TEXCOORD                 1   xyzw        1     NONE   float   xyzw",
  "// SV_Position              0   xyzw        0      POS   float   xyzw",
  "// Output signature:",
  "// Name                 Index   Mask Register SysValue  Format   Used",
  "// -------------------- ----- ------ -------- -------- ------- ------",
  "// SV_Position              0   xyzw        0      POS   float   xyzw",
].join("\n");
assert.deepEqual(parseInputSignature(fxcSignatures), [
  { name: "TEXCOORD", index: 1, register: 1, sysValue: "NONE", mask: "xyzw", format: "float" },
  { name: "SV_Position", index: 0, register: 0, sysValue: "POS", mask: "xyzw", format: "float" },
], "la firma input FXC viene letta con maschera e tipo");
assert.deepEqual(parseOutputSignature(fxcSignatures), [
  { name: "SV_Position", index: 0, register: 0, sysValue: "POS", mask: "xyzw", format: "float" },
], "la firma output FXC viene letta separatamente");
const dxcSignatures = [
  "; Input signature:",
  "; Name                 Index   Mask Register SysValue  Format   Used",
  "; -------------------- ----- ------ -------- -------- ------- ------",
  ";    TEXCOORD                 1   xy          0     NONE   float     xy",
  "; Output signature:",
  "; SV_Position              0   xyzw        0      POS   float   xyzw",
].join("\n");
assert.equal(parseInputSignature(dxcSignatures)[0].mask, "xy", "il formato DXC precedente resta supportato");
assert.equal(parseOutputSignature(dxcSignatures)[0].sysValue, "POS", "output DXC letto correttamente");
const compatiblePair = compareShaderSignatures(
  [{ name: "TEXCOORD", index: 1, register: 1, sysValue: "NONE", mask: "xyzw", format: "float" }],
  [{ name: "TEXCOORD", index: 1, register: 0, sysValue: "NONE", mask: "xy", format: "float" }],
);
assert.equal(compatiblePair.compatible, true, "maschera output più ampia è compatibile");
const incompatiblePair = compareShaderSignatures(
  [{ name: "TEXCOORD", index: 1, register: 1, sysValue: "NONE", mask: "xy", format: "float" }],
  [
    { name: "TEXCOORD", index: 1, register: 0, sysValue: "NONE", mask: "xyzw", format: "float" },
    { name: "TEXCOORD", index: 2, register: 1, sysValue: "NONE", mask: "xyzw", format: "float" },
  ],
);
assert.equal(incompatiblePair.compatible, false, "maschere input eccedenti e semantiche mancanti falliscono");
assert(incompatiblePair.mismatches.some((mismatch) => mismatch.includes("TEXCOORD1") && mismatch.includes("PS richiede")));
assert(incompatiblePair.mismatches.some((mismatch) => mismatch.includes("TEXCOORD2") && mismatch.includes("Manca")));
const typeMismatch = compareShaderSignatures(
  [{ name: "COLOR", index: 0, register: 0, sysValue: "NONE", mask: "xyzw", format: "uint" }],
  [{ name: "COLOR", index: 0, register: 0, sysValue: "NONE", mask: "xyzw", format: "float" }],
);
assert.equal(typeMismatch.compatible, false, "tipi di componente differenti falliscono");

// ---- ripristino metadati compute persi nel passaggio DXIL -> SPIR-V -> HLSL
const computePost = postprocessHlsl(
  "uint _1 = 2u;\nuint _2 = (-_1) & 31u;\nvoid comp_main()\n{\n    return;\n}\n",
  undefined,
  undefined,
  { stage: "cs", numThreads: "(64,1,1)" },
);
assert.equal(computePost.entryPoint, "comp_main", "entry point compute SPIRV-Cross");
assert(computePost.hlsl.includes("[numthreads(64,1,1)]\nvoid comp_main()"), "attributo numthreads ripristinato");
assert(computePost.changes.some((change) => change.toLowerCase().includes("numthreads")), "ripristino riportato tra le modifiche");
assert(computePost.hlsl.includes("(0u - _1) & 31u"), "negazione uint resa esplicita senza cambiare l'aritmetica unsigned");
const invalidComputePost = postprocessHlsl(
  "void comp_main() {}",
  undefined,
  undefined,
  { stage: "cs", numThreads: "(0,1,1)" },
);
assert(!invalidComputePost.hlsl.includes("[numthreads"), "metadati compute invalidi non applicati");
assert(invalidComputePost.warnings.length > 0, "metadati compute invalidi segnalati");
const oversizedComputePost = postprocessHlsl(
  "void comp_main() {}",
  undefined,
  undefined,
  { stage: "cs", numThreads: "(1024,2,1)" },
);
assert(!oversizedComputePost.hlsl.includes("[numthreads"), "gruppi compute oltre i limiti D3D11 non applicati");
const vertexWrapperPost = postprocessHlsl(
  "struct SPIRV_Cross_Input { float4 position : ATTRIBUTE0; };\n" +
  "struct SPIRV_Cross_Output { float4 position : SV_Position; };\n" +
  "void vert_main() {}\n" +
  "SPIRV_Cross_Output main(SPIRV_Cross_Input stage_input) { vert_main(); return (SPIRV_Cross_Output)0; }\n",
  undefined,
  undefined,
  { stage: "vs" },
);
assert.equal(vertexWrapperPost.entryPoint, "main", "lo shader deve essere compilato tramite il wrapper che trasferisce gli input");
const pixelSemanticPost = postprocessHlsl(
  "struct SPIRV_Cross_Input { float4 color : TEXCOORD0; float2 uv : TEXCOORD1; float4 missing : TEXCOORD2; };",
  undefined,
  undefined,
  { stage: "ps" },
  [
    { name: "COLOR", index: 0, register: 0, sysValue: "NONE" },
    { name: "TEXCOORD", index: 3, register: 1, sysValue: "NONE" },
  ],
);
assert(pixelSemanticPost.hlsl.includes("color : COLOR0"), "semantic PS rinominata secondo l'output VS");
assert(pixelSemanticPost.hlsl.includes("uv : TEXCOORD3"), "indice semantic VS ripristinato");
assert(pixelSemanticPost.hlsl.includes("missing : TEXCOORD2"), "semantica senza output VS lasciata invariata");
assert(pixelSemanticPost.warnings.some((warning) => warning.includes("registri 2")), "semantic PS senza output VS segnalata");
const computeWrapperPost = postprocessHlsl(
  "void comp_main() {}\nvoid main() { comp_main(); }\n",
  undefined,
  undefined,
  { stage: "cs", numThreads: "(8,8,1)" },
);
assert.equal(computeWrapperPost.entryPoint, "main", "numthreads va applicato al wrapper compilabile");
assert(computeWrapperPost.hlsl.includes("[numthreads(8,8,1)]\nvoid main()"), "numthreads sul wrapper entry point");

// ---- ispezione PIX read-only con limiti di lettura verificabili
const noPixTool = { pixtoolPath: null } as const;
const knownHeader = Buffer.alloc(64);
knownHeader.write("GFXA", 0, "latin1");
knownHeader.write("GFXB", 16, "latin1");
knownHeader.write("GFXC", 32, "latin1");
const knownPix = await analyzeSource(
  { size: knownHeader.length, async read(position, length) { return knownHeader.subarray(position, position + length); } },
  "GPU 1.wpix",
  noPixTool,
);
assert.equal(knownPix.status, "known_markers_in_header");
assert.equal(knownPix.decoded, false);
assert.deepEqual(knownPix.header.knownMarkers.map(({ marker }) => marker), ["GFXA", "GFXB", "GFXC"]);
assert.equal(resolveLimits().maxScanBytes, DEFAULT_LIMITS.maxScanBytes, "default scan limit matches documented default");

const unknownPix = await analyzeSource(
  { size: 64, async read(position, length) { return Buffer.from("ABCD".padEnd(64, "\0"), "latin1").subarray(position, position + length); } },
  "unknown.wpix",
  noPixTool,
);
assert.equal(unknownPix.status, "unrecognized_header");
assert.equal(unknownPix.decoded, false);

const truncatedPix = await analyzeSource(
  { size: 8, async read(position, length) { return Buffer.from("GFXA1234", "latin1").subarray(position, position + length); } },
  "truncated.wpix",
  noPixTool,
);
assert.equal(truncatedPix.status, "truncated_header");

const largePixReads: { position: number; length: number }[] = [];
const largePixSize = 932_490_260;
const pixBlockBytes = 64 * 1024;
const pixMaxScanBytes = pixBlockBytes * 2;
const largePixSource: ByteSource = {
  size: largePixSize,
  async read(position, length) {
    largePixReads.push({ position, length });
    const block = Buffer.alloc(length);
    if (position === 0) knownHeader.copy(block, 0);
    return block;
  },
};
const largePix = await analyzeSource(largePixSource, "large.wpix", {
  ...noPixTool,
  headerBytes: 64,
  blockBytes: pixBlockBytes,
  maxScanBytes: pixMaxScanBytes,
});
assert.equal(largePix.sizeBytes, largePixSize);
assert.equal(largePix.decoded, false);
assert.equal(largePix.scan.complete, false);
assert.equal(largePix.scan.bytesScanned, pixMaxScanBytes);
assert.ok(largePixReads.every(({ length }) => length <= pixBlockBytes), "large capture is read in bounded blocks");
assert.ok(largePixReads.every(({ position, length }) => position + length <= pixMaxScanBytes), "scan stops at configured limit");
assert.ok(largePixReads.reduce((total, { length }) => total + length, 0) <= pixMaxScanBytes + 64, "total reads remain bounded");

const pixToolPathDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shaderlab-pixtool-path-"));
try {
  const pixToolPath = path.join(pixToolPathDirectory, "pixtool.exe");
  fs.writeFileSync(pixToolPath, "");
  assert.equal(
    findPixTool({ PATH: pixToolPathDirectory, ProgramFiles: "", "ProgramFiles(x86)": "" }),
    pixToolPath,
    "pixtool can be discovered on PATH on another Windows installation",
  );
} finally {
  fs.rmSync(pixToolPathDirectory, { recursive: true, force: true });
}

// ---- event list PIX: parsing quotato e gate Global ID / Queue ID prima del save-resource
const pixEventsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shaderlab-pix-events-test-"));
try {
  const capturePath = path.join(pixEventsDirectory, "capture.wpix");
  const eventListPath = path.join(pixEventsDirectory, "events.csv");
  const pixToolPath = path.join(pixEventsDirectory, "pixtool.exe");
  fs.writeFileSync(capturePath, "capture");
  fs.writeFileSync(pixToolPath, "");
  fs.writeFileSync(eventListPath, [
    "Global ID,Queue ID,Name",
    '34,70,"DrawIndexedInstanced(6, 1, 0, 0, 0)"',
    '35,71,"DrawInstanced(3, 1, 0, 0)"',
    '36,70,"SetPipelineState(obj#1234)"',
  ].join("\r\n"), "utf8");

  const parsedEvents = parsePixEventListText(fs.readFileSync(eventListPath, "utf8"), eventListPath);
  assert.equal(parsedEvents.rows[0].name, "DrawIndexedInstanced(6, 1, 0, 0, 0)", "CSV quoted commas are preserved");
  assert.deepEqual(parsedEvents.queueIds, [70, 71]);

  const queueEvents = await listPixEvents({
    pixPath: capturePath,
    queueId: 70,
    queueLabel: "Graphics Queue 1",
    eventListPath,
    contains: "draw",
  });
  assert.equal(queueEvents.totalMatches, 1);
  assert.equal(queueEvents.events[0].globalId, 34);
  assert.equal(queueEvents.queueLabelSource, "user_supplied");
  assert.equal(queueEvents.queueIdFilterSource, "event_list_queue_id_column_exact_match");
  assert.equal(queueEvents.queueIdSemantics, "row_local_identifier");

  const drawEvents = await listPixEvents({
    pixPath: capturePath,
    queueLabel: "Graphics Queue 1",
    eventListPath,
    contains: "draw",
  });
  assert.equal(drawEvents.totalMatches, 2, "queue label does not implicitly filter the Queue ID column");

  let resourceExportCalls = 0;
  await assert.rejects(() => exportPixDrawResource({
    pixPath: capturePath,
    globalId: 34,
    queueId: 71,
    eventListPath,
    outputDir: path.join(pixEventsDirectory, "rejected"),
    pixToolPath,
  }, async () => {
    resourceExportCalls++;
    return { code: 0, stdout: "", stderr: "" };
  }), /ha Queue ID 70 \(atteso 71\)/);
  assert.equal(resourceExportCalls, 0, "queue mismatch blocks all pixtool calls");
  assert.equal(fs.existsSync(path.join(pixEventsDirectory, "rejected")), false, "mismatch creates no output directory");

  const acceptedOutputDir = path.join(pixEventsDirectory, "accepted");
  const resourceResult = await exportPixDrawResource({
    pixPath: capturePath,
    globalId: 34,
    queueId: 70,
    queueLabel: "Graphics Queue 1",
    eventListPath,
    outputDir: acceptedOutputDir,
    pixToolPath,
  }, async (_command, args) => {
    const exportIndex = args.indexOf("save-resource");
    assert.notEqual(exportIndex, -1, "verified event reaches save-resource");
    fs.writeFileSync(args[exportIndex + 1], "png");
    return { code: 0, stdout: "", stderr: "" };
  });
  assert.equal(resourceResult.eventRowVerified, true);
  assert.equal(resourceResult.queueLabelVerifiedByEventList, false);
  assert.equal(fs.existsSync(resourceResult.outputPath), true);

  const noQueueListPath = path.join(pixEventsDirectory, "no-queue.csv");
  fs.writeFileSync(noQueueListPath, [
    "Global ID,Name",
    '34,"DrawIndexedInstanced(6, 1, 0, 0, 0)"',
  ].join("\r\n"), "utf8");
  await assert.rejects(() => exportPixDrawResource({
    pixPath: capturePath,
    globalId: 34,
    queueId: 70,
    eventListPath: noQueueListPath,
    outputDir: path.join(pixEventsDirectory, "missing-queue"),
    pixToolPath,
  }, async () => {
    resourceExportCalls++;
    return { code: 0, stdout: "", stderr: "" };
  }), /colonna Queue ID manca/);
  assert.equal(resourceExportCalls, 0, "missing queue ID blocks resource export");

  const noGlobalListPath = path.join(pixEventsDirectory, "no-global.csv");
  fs.writeFileSync(noGlobalListPath, [
    "Queue ID,Name",
    '70,"DrawIndexedInstanced(6, 1, 0, 0, 0)"',
  ].join("\r\n"), "utf8");
  await assert.rejects(() => exportPixDrawResource({
    pixPath: capturePath,
    globalId: 34,
    queueId: 70,
    eventListPath: noGlobalListPath,
    outputDir: path.join(pixEventsDirectory, "missing-global"),
    pixToolPath,
  }, async () => {
    resourceExportCalls++;
    return { code: 0, stdout: "", stderr: "" };
  }), /trovate 0/);
  assert.equal(resourceExportCalls, 0, "missing global ID blocks resource export");

  await assert.rejects(() => exportPixDrawResource({
    pixPath: capturePath,
    globalId: 36,
    queueId: 70,
    eventListPath,
    outputDir: path.join(pixEventsDirectory, "not-draw"),
    pixToolPath,
  }, async () => {
    resourceExportCalls++;
    return { code: 0, stdout: "", stderr: "" };
  }), /non è un evento Draw/);
  assert.equal(resourceExportCalls, 0, "non-draw event blocks resource export");
} finally {
  fs.rmSync(pixEventsDirectory, { recursive: true, force: true });
}

const pixPrompt = buildPixPrompt("C:\\captures\\GPU 1.wpix");
assert.match(pixPrompt, /analyze_pix_capture/);
assert.match(pixPrompt, /NON DECODIFICATO/);
assert.match(pixPrompt, /analyze_dxil/);
const fullPixPrompt = buildPixPrompt("C:\\captures\\frame.wpix", {
  mode: "full",
  outputDir: "C:\\analysis",
  pixToolPath: "C:\\Program Files\\Microsoft PIX\\pixtool.exe",
});
assert.match(fullPixPrompt, /"mode":"full"/);
assert.ok(fullPixPrompt.includes('"pixToolPath":"C:\\\\Program Files\\\\Microsoft PIX\\\\pixtool.exe"'));
assert.match(fullPixPrompt, /non caricare la cattura/);
const eventListPrompt = buildPixEventListPrompt({ pixPath: "capture.wpix", queueId: 70 });
assert.match(eventListPrompt, /list_pix_events/);
assert.match(eventListPrompt, /non identifica la queue/);
const resourcePrompt = buildPixResourcePrompt({ pixPath: "capture.wpix", globalId: 34, queueId: 70 });
assert.match(resourcePrompt, /export_pix_draw_resource/);
assert.match(resourcePrompt, /stessa riga/);
console.log("\nTUTTI I TEST OK");
