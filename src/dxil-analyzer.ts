import * as fs from "node:fs";
import { createHash } from "node:crypto";

export type Sev = "blocker" | "warning" | "info";
export interface DxilFinding { sev: Sev; code: string; message: string; count?: number; detail?: string }
export interface Binding { cls: "b" | "t" | "s" | "u"; type: string; format: string; dim: string; id: string; slot: number; space: number; count: number; raw: string }
export interface ContainerInfo { size: number; sha256: string; parts: { fourcc: string; size: number }[]; hasDxil: boolean; hasLegacy: boolean; program?: { type: string; major: number; minor: number } }
export interface DxilReport {
  stage?: string; shaderModel?: string; entry?: string; numThreads?: string;
  requires: string[]; bindings: Binding[]; opCounts: Record<string, number>;
  findings: DxilFinding[]; limits: string[]; verdict: "convertible" | "convertible-with-work" | "not-convertible";
  container?: ContainerInfo;
}

const PROGRAM_TYPES = ["ps", "vs", "gs", "hs", "ds", "cs", "lib", "mesh", "amp"];

/** Legge il container DXBC e l'header del programma DXIL (senza decodificare il bitcode). */
export function parseContainer(buf: Buffer): ContainerInfo | undefined {
  if (buf.length < 32 || buf.toString("ascii", 0, 4) !== "DXBC") return undefined;
  const chunks = buf.readUInt32LE(28);
  const parts: { fourcc: string; size: number }[] = [];
  let program: ContainerInfo["program"];
  for (let i = 0; i < chunks && i < 64; i++) {
    const off = buf.readUInt32LE(32 + i * 4);
    if (off + 8 > buf.length) continue;
    const fourcc = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    parts.push({ fourcc, size });
    if (fourcc === "DXIL" && off + 16 <= buf.length) {
      const ver = buf.readUInt32LE(off + 8);
      program = { type: PROGRAM_TYPES[ver >>> 16] ?? `type${ver >>> 16}`, major: (ver >>> 4) & 0xf, minor: ver & 0xf };
    }
  }
  return {
    size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), parts,
    hasDxil: parts.some((p) => p.fourcc === "DXIL" || p.fourcc === "ILDB"),
    hasLegacy: parts.some((p) => p.fourcc === "SHDR" || p.fourcc === "SHEX"), program,
  };
}

function parseBinding(line: string): Binding | null {
  const m = line.match(/^;(.*?)\s*(cbuffer|sampler|texture|UAV)\s+(\S+)\s+(\S+)\s+(\w+)\s+(\S+)\s+(\d+)\s*$/);
  if (!m) return null;
  const b = m[6].match(/^(cb|[stu])(\d+)(?:,space(\d+))?$/);   // i cbuffer sono "cbN", gli altri "tN/sN/uN"
  if (!b) return null;
  return { cls: (b[1] === "cb" ? "b" : b[1]) as Binding["cls"], type: m[2], format: m[3], dim: m[4], id: m[5], slot: +b[2], space: b[3] ? +b[3] : 0, count: +m[7], raw: m[6] };
}

// base-name dell'operazione dx.op  ->  regola
const OP_RULES: { re: RegExp; sev: Sev; code: string; msg: string }[] = [
  { re: /^(wave\w+|quadReadLaneAt|quadOp|quadVote)$/, sev: "blocker", code: "W001",
    msg: "Wave/Quad operations (SM6.0): nessun equivalente in SM5." },
  { re: /^(traceRay|rayQuery_\w+|dispatchRays\w*|reportHit|callShader|acceptHitAndEndSearch|ignoreHit|allocateRayQuery)$/, sev: "blocker", code: "R001",
    msg: "Ray tracing (DXR): impossibile in D3D11." },
  { re: /^(dispatchMesh|setMeshOutputCounts|emitIndices|storeVertexOutput|storePrimitiveOutput|getMeshPayload)$/, sev: "blocker", code: "M001",
    msg: "Mesh/Amplification shader: non esistono in D3D11." },
  { re: /^createHandleFromHeap$/, sev: "blocker", code: "D001",
    msg: "ResourceDescriptorHeap/SamplerDescriptorHeap (SM6.6 bindless): D3D11 usa slot espliciti." },
  { re: /^attributeAtVertex$/, sev: "blocker", code: "X001", msg: "GetAttributeAtVertex (SM6.1): nessun equivalente in SM5." },
  { re: /^(pack4x8|unpack4x8)$/, sev: "blocker", code: "X002", msg: "pack/unpack 8-bit (SM6.6): non emulati automaticamente." },
  { re: /^sampleCmp(Level|Bias|Grad)$/, sev: "blocker", code: "X003", msg: "SampleCmpLevel/Bias/Grad (SM6.7/6.8): in SM5 solo SampleCmp/SampleCmpLevelZero." },
  { re: /^viewID$/, sev: "blocker", code: "S001", msg: "SV_ViewID (SM6.1): non disponibile in SM5." },
  { re: /^(dot4AddPacked|dot2AddHalf)$/, sev: "warning", code: "X004", msg: "dot4add/dot2add (SM6.4): emulabili con funzioni helper." },
];

export function analyzeDisasm(text: string): DxilReport {
  const lines = text.split(/\r?\n/);
  const r: DxilReport = { requires: [], bindings: [], opCounts: {}, findings: [], limits: [], verdict: "convertible" };

  // metadati
  const sm = text.match(/^!\d+ = !\{!"(vs|ps|gs|hs|ds|cs|lib|ms|as)", i32 (\d+), i32 (\d+)/m);
  if (sm) { r.stage = sm[1]; r.shaderModel = `${sm[1]}_${sm[2]}_${sm[3]}`; }
  r.entry = text.match(/^; EntryFunctionName: (.+)$/m)?.[1]?.trim();
  r.numThreads = text.match(/^; NumThreads=(\([^)]*\))/m)?.[1];

  // "Note: shader requires additional functionality"
  const ni = lines.findIndex((l) => l.startsWith("; Note: shader requires additional functionality"));
  if (ni >= 0) for (let i = ni + 1; i < lines.length && /^;\s+\S/.test(lines[i]); i++) r.requires.push(lines[i].replace(/^;\s+/, "").trim());

  // tabella dei binding
  const bi = lines.findIndex((l) => l.startsWith("; Resource Bindings:"));
  if (bi >= 0) for (let i = bi + 3; i < lines.length && lines[i].startsWith(";") && !lines[i].startsWith("; ViewId"); i++) {
    const b = parseBinding(lines[i]); if (b) r.bindings.push(b);
  }

  // operazioni dx.op nei soli call-site (non nelle declare)
  let i64Alu = 0, halfAlu = 0, i16Alu = 0;
  for (const l of lines) {
    if (l.startsWith(";") || l.startsWith("declare") || l.startsWith("!")) continue;
    const m = l.match(/@dx\.op\.([A-Za-z0-9_]+?)(?:\.(?:f16|f32|f64|i1|i8|i16|i32|i64|v\d+\w*))?\(/);
    if (m && /\bcall\b/.test(l)) {
      const key = m[1] + (l.match(/@dx\.op\.[A-Za-z0-9_]+\.(i64|f64|f16|i16)\(/)?.[0].match(/\.(i64|f64|f16|i16)\(/)?.[1] ? "." + l.match(/@dx\.op\.[A-Za-z0-9_]+\.(i64|f64|f16|i16)\(/)![1] : "");
      r.opCounts[key] = (r.opCounts[key] ?? 0) + 1;
    } else if (/^\s+%\S+ = /.test(l)) {
      if (/\bi64\b/.test(l)) i64Alu++;
      if (/\bhalf\b/.test(l)) halfAlu++;
      if (/\bi16\b/.test(l)) i16Alu++;
    }
  }

  const F = (f: DxilFinding) => r.findings.push(f);
  for (const [op, n] of Object.entries(r.opCounts)) {
    const base = op.replace(/\.(i64|f64|f16|i16)$/, "");
    for (const rule of OP_RULES) if (rule.re.test(base)) { F({ sev: rule.sev, code: rule.code, message: rule.msg, count: n, detail: `dx.op.${op}` }); break; }
  }
  const at64 = Object.entries(r.opCounts).filter(([k]) => /^atomic\w*\.i64$/.test(k));
  if (at64.length) F({ sev: "blocker", code: "I002", count: at64.reduce((s, [, n]) => s + n, 0),
    message: "Atomiche a 64 bit (SM6.6): D3D11 non ha atomiche a 64 bit. Servono un'altra strategia (es. depth test + ID) o un cambio di algoritmo.",
    detail: at64.map(([k]) => "dx.op." + k).join(", ") });
  if (i64Alu) F({ sev: "warning", code: "I001", count: i64Alu, message: "Aritmetica a 64 bit: emulabile con coppie uint2 solo per operazioni semplici (shift/or/zext), da rivedere a mano." });
  if (halfAlu || i16Alu) F({ sev: "warning", code: "T001", count: halfAlu + i16Alu, message: "Tipi 16-bit nativi: ripiego su min16*/32-bit (differenze di precisione possibili)." });
  if (r.bindings.some((b) => b.space !== 0)) F({ sev: "warning", code: "B001",
    message: "Register space ≠ 0 (SM5.0 non ha spazi): serve rimappare su slot univoci e tenere coerente il root signature.",
    detail: r.bindings.filter((b) => b.space).map((b) => b.raw).join(", ") });
  if (/BARYCEN/.test(text)) F({ sev: "blocker", code: "S002", message: "SV_Barycentrics (SM6.1): non esiste in SM5 (richiederebbe geometry shader o interpolazione manuale)." });
  if (/Wave level operations/.test(r.requires.join("\n")) && !r.findings.some((f) => f.code === "W001"))
    F({ sev: "blocker", code: "W001", message: "Il compilatore dichiara l'uso di wave-level operations." });
  if ((r.opCounts["createHandleFromBinding"] ?? 0) > 0) F({ sev: "info", code: "H001",
    message: "createHandleFromBinding/annotateHandle: handle SM6.6 ma con binding statico (nessun bindless). Non è un ostacolo." });
  if ((r.opCounts["rawBufferLoad"] ?? 0) + (r.opCounts["rawBufferStore"] ?? 0) > 0 || Object.keys(r.opCounts).some((k) => k.startsWith("rawBuffer")))
    F({ sev: "info", code: "H002", message: "rawBufferLoad/Store: ByteAddressBuffer/StructuredBuffer, supportati in SM5 (serve lo stride giusto per i structured)." });
  if (Object.keys(r.opCounts).some((k) => k.startsWith("textureStore")))
    F({ sev: "warning", code: "U001", message: "Scrittura su UAV tipizzati: in D3D11 i formati diversi da R32_* richiedono il supporto 'typed UAV store' dell'hardware (FL11.1/opzionale)." });

  // limiti D3D11
  const cnt = (c: string, t?: string) => r.bindings.filter((b) => b.cls === c && (!t || b.type === t)).length;
  const lim = (n: number, max: number, what: string) => { if (n > max) r.limits.push(`${what}: ${n} > ${max}`); };
  lim(cnt("b"), 14, "constant buffer"); lim(cnt("s"), 16, "sampler"); lim(cnt("t"), 128, "SRV");
  lim(cnt("u"), r.stage === "cs" ? 64 : 8, `UAV (${r.stage === "cs" ? "CS, FL11.1" : "graphics, FL11.0"})`);
  if (r.stage === "cs" && cnt("u") > 8) r.limits.push(`UAV: ${cnt("u")} > 8 se l'hardware è solo Feature Level 11.0`);
  if (r.stage === "ps" && cnt("u") > 0) {
    const hasRt = /^; SV_Target/m.test(text);
    F({ sev: "warning", code: "U002", message: hasRt
      ? "UAV nel pixel shader insieme a render target: in D3D11 gli slot UAV devono essere ≥ al numero di render target."
      : "UAV nel pixel shader senza render target in uscita: in D3D11 si usa OMSetRenderTargetsAndUnorderedAccessViews con 0 RTV (fattibile, ma serve un depth/viewport coerenti)." });
  }

  const sevRank = { blocker: 2, warning: 1, info: 0 } as const;
  const worst = Math.max(-1, ...r.findings.map((f) => sevRank[f.sev]));
  r.verdict = worst === 2 ? "not-convertible" : (worst === 1 || r.limits.length) ? "convertible-with-work" : "convertible";
  return r;
}

export function analyzeFiles(dxilPath?: string, disasmPath?: string): DxilReport {
  let r: DxilReport = { requires: [], bindings: [], opCounts: {}, findings: [], limits: [], verdict: "convertible" };
  if (disasmPath) r = analyzeDisasm(fs.readFileSync(disasmPath, "utf8"));
  if (dxilPath) {
    const c = parseContainer(fs.readFileSync(dxilPath));
    r.container = c;
    if (c?.program && !r.shaderModel) { r.stage = c.program.type; r.shaderModel = `${c.program.type}_${c.program.major}_${c.program.minor}`; }
    if (!disasmPath) r.findings.push({ sev: "info", code: "N000", message: "Solo container analizzato: per il rilevamento delle feature serve anche il disassemblato DXC (dxc -dumpbin / -Fc)." });
  }
  return r;
}

const ICON = { blocker: "✖ BLOCCANTE", warning: "⚠ AVVISO", info: "ℹ INFO" } as const;
const VERDICT = {
  "not-convertible": "NON convertibile a SM5 senza cambiare algoritmo/pipeline",
  "convertible-with-work": "Convertibile (candidato) con lavoro manuale / avvisi",
  convertible: "Nessun ostacolo SM6 rilevato dall'analisi statica",
};

export function formatReport(r: DxilReport, title = ""): string {
  const o: string[] = [];
  if (title) o.push(`=== ${title}`);
  o.push(`Stadio: ${r.stage ?? "?"} | Shader model: ${r.shaderModel ?? "?"} | Entry: ${r.entry ?? "?"}${r.numThreads ? " | numthreads " + r.numThreads : ""}`);
  if (r.container) o.push(`Container: ${r.container.size} B, parti ${r.container.parts.map((p) => p.fourcc).join("/")}, sha256 ${r.container.sha256.slice(0, 16)}…`);
  if (r.requires.length) o.push(`Funzionalità richieste dal compilatore: ${r.requires.join("; ")}`);
  const g = (c: string) => r.bindings.filter((b) => b.cls === c).length;
  o.push(`Binding: CBV ${g("b")} | SRV ${g("t")} | UAV ${g("u")} | Sampler ${g("s")}`);
  const sp = r.bindings.filter((b) => b.space);
  if (sp.length) o.push(`  con register space: ${sp.map((b) => b.raw).join(", ")}`);
  const ops = Object.entries(r.opCounts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}×${n}`).join(", ");
  if (ops) o.push(`Operazioni dx.op principali: ${ops}`);
  o.push("");
  for (const f of [...r.findings].sort((a, b) => ({ blocker: 0, warning: 1, info: 2 })[a.sev] - ({ blocker: 0, warning: 1, info: 2 })[b.sev]))
    o.push(`${ICON[f.sev]} [${f.code}]${f.count ? ` ×${f.count}` : ""} ${f.message}${f.detail ? `\n    ${f.detail}` : ""}`);
  if (r.limits.length) { o.push("Limiti D3D11:"); r.limits.forEach((l) => o.push("  - " + l)); }
  o.push(`\nVerdetto: ${VERDICT[r.verdict]}`);
  return o.join("\n");
}

export interface SigElement {
  name: string; index: number; register: number | null; sysValue: string;
  mask?: string; format?: string;
}

function parseSignature(text: string, kind: "Input" | "Output"): SigElement[] {
  const lines = text.split(/\r?\n/);
  const header = new RegExp(`^\\s*(?:;|//)\\s*${kind} signature:\\s*$`, "i");
  const a = lines.findIndex((l) => header.test(l));
  if (a < 0) return [];
  const out: SigElement[] = [];
  for (let i = a + 1; i < lines.length; i++) {
    if (/^\s*(?:;|\/\/)\s*(?:Input|Output) signature:/i.test(lines[i])) break;
    const row = lines[i].replace(/^\s*(?:;|\/\/)\s*/, "");
    const m = row.match(/^([A-Za-z_]\w*)\s+(\d+)\s+([xyzw]+|N\/A)\s+(\d+|special)\s+(\w+)(?:\s+(\w+))?(?:\s+([xyzw]+|N\/A))?\s*$/i);
    if (m) out.push({
      name: m[1],
      index: +m[2],
      register: /^\d+$/.test(m[4]) ? +m[4] : null,
      sysValue: m[5],
      ...(m[3].toUpperCase() !== "N/A" ? { mask: m[3] } : {}),
      ...(m[6] ? { format: m[6] } : {}),
    });
  }
  return out;
}

/** Legge la Input signature da dump DXC o FXC. */
export function parseInputSignature(text: string): SigElement[] {
  return parseSignature(text, "Input");
}

/** Legge la Output signature da dump DXC o FXC. */
export function parseOutputSignature(text: string): SigElement[] {
  return parseSignature(text, "Output");
}

export interface SignatureComparison { compatible: boolean; checked: number; mismatches: string[] }

/** Confronta gli input PS con gli output VS per semantica, maschera e tipo. */
export function compareShaderSignatures(vsOutput: SigElement[], psInput: SigElement[]): SignatureComparison {
  const mismatches: string[] = [];
  let checked = 0;
  for (const input of psInput) {
    const sysValue = input.sysValue.toUpperCase();
    if (sysValue !== "NONE") {
      if (sysValue === "POS" || sysValue === "POSITION") {
        checked++;
        if (!vsOutput.some((output) => ["POS", "POSITION"].includes(output.sysValue.toUpperCase())))
          mismatches.push("PS richiede SV_Position, ma la firma VS non emette una posizione.");
      }
      continue;
    }

    checked++;
    const key = `${input.name.toUpperCase()}${input.index}`;
    const output = vsOutput.find((candidate) =>
      candidate.sysValue.toUpperCase() === "NONE" &&
      `${candidate.name.toUpperCase()}${candidate.index}` === key,
    );
    if (!output) {
      mismatches.push(`Manca nell'output VS la semantica ${input.name}${input.index} richiesta dal PS.`);
      continue;
    }
    if (input.format && output.format && input.format.toLowerCase() !== output.format.toLowerCase()) {
      mismatches.push(`${input.name}${input.index}: tipo VS ${output.format}, tipo PS ${input.format}.`);
    }
    if (input.mask && output.mask) {
      const missing = [...input.mask.toLowerCase()].filter((component) => !output.mask!.toLowerCase().includes(component));
      if (missing.length)
        mismatches.push(`${input.name}${input.index}: PS richiede ${input.mask}, ma VS fornisce ${output.mask}.`);
    }
  }
  return { compatible: mismatches.length === 0, checked, mismatches };
}
