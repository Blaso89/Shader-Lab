import * as fs from "node:fs";

export type ShaderStage = "VS" | "PS" | "GS" | "HS" | "DS" | "CS";

/** Hash diagnostico hardcoded in `pipeline.cpp:178` per `[TARGET_INPUT_LAYOUT]`. */
export const TARGET_INPUT_LAYOUT_DIAGNOSTIC_VS = "20e0826b236597a1";

/** Coppie diagnostiche hardcoded in `commands.cpp:45-47` per `[TARGET_DRAW_COPY]`. */
export const TARGET_DRAW_COPY_DIAGNOSTIC_PAIRS: ReadonlyArray<{ vs: string; ps: string }> = [
  { vs: "20e0826b236597a1", ps: "44b0a992c2304254" },
  { vs: "20e0826b236597a1", ps: "d77600bde0076c33" },
];

export interface LaunchAttestationSummary {
  modules: Record<string, string>;
  maskedNvidiaAdapter: boolean;
  exposedVendor?: string;
  adapterSource?: string;
  tiledResourcesTier?: number;
  callerTrace?: boolean;
}

export interface ShaderObservation {
  hash: string;
  stage: ShaderStage;
  bytes?: number;
  isDxbc?: boolean;
  hasDxil?: boolean;
  hasLegacy?: boolean;
  shaderModel?: string;
  hasRts0?: boolean;
  status: "native-sm5" | "override-ready" | "placeholder" | "blocked" | "create-failed" | "seen";
  overridePath?: string;
  overrideSha256?: string;
  dumpPath?: string;
  dumpSkipped?: boolean;
  reason?: string;
  createFailedHr?: string;
  firstLine: number;
}

export interface GraphicsPsoRecord {
  index: number;
  status: "ready" | "placeholder-missing-sm5-override" | string;
  psoPtr: string;
  missingMask: number;
  vs?: { hash: string; bytes: number };
  ps?: { hash: string; bytes: number };
  gs?: { hash: string; bytes: number };
  hs?: { hash: string; bytes: number };
  ds?: { hash: string; bytes: number };
  d11Vs: boolean;
  d11Ps: boolean;
  d11Il: boolean;
  line: number;
}

export interface ComputePsoRecord {
  index: number;
  status: "ready" | "placeholder-missing-sm5-override" | string;
  psoPtr: string;
  missingMask: number;
  cs: { hash: string; bytes: number };
  d11Cs: boolean;
  line: number;
}

export interface TargetInputLayoutElement {
  element: number;
  semantic: string;
  semanticIndex: number;
  slot: number;
  format: number;
  offset: number;
  classification: number;
  stepRate: number;
}

export interface InputLayoutFailure {
  elements: number;
  hresult: string;
  line: number;
}

/** Record reale emesso da `util.cpp` (`[DRAW_SHADER_USE]` / `[COMPUTE_SHADER_USE]`). */
export interface DrawShaderUseRecord {
  outcome: "executed" | "skipped" | string;
  vsHash?: string;
  psHash?: string;
  gsHash?: string;
  hsHash?: string;
  dsHash?: string;
  missingMask: number;
  graphicsPsoBound: boolean;
  rtvIsBackbuffer: boolean;
  drawCommands: number;
  firstObservedPresentCountProcessWide: number;
  lastObservedPresentCountProcessWide: number;
  line: number;
}

export interface ComputeShaderUseRecord {
  outcome: "executed" | "skipped" | string;
  csHash?: string;
  missingMask: number;
  dispatchCommands: number;
  firstObservedPresentCountProcessWide: number;
  lastObservedPresentCountProcessWide: number;
  line: number;
}

export interface ShaderUseEventRecord {
  ordinal: number;
  observedPresentCallsReturned: number;
  kind: "draw" | "dispatch";
  outcome: "executed" | "skipped" | string;
  executionCount: number;
  vsHash?: string;
  psHash?: string;
  gsHash?: string;
  hsHash?: string;
  dsHash?: string;
  csHash?: string;
  missingMask: number;
  graphicsPsoBound?: boolean;
  rtvIsBackbuffer?: boolean;
  line: number;
}

/** Record reale emesso da `dxgi_proxy.cpp:342` (`[READBACK_IDENTITY]`). */
export interface ReadbackIdentityRecord {
  readbackPresentCount: number;
  bufferIndex: number;
  nativeBackbuffer: string;
  width: number;
  height: number;
  format: number;
  copySequence: number;
  copySource: string;
  line: number;
}

/** Record reale emesso da `dxgi_proxy.cpp:240-260` (`[READBACK_SRC]` / `[READBACK]`). */
export interface SampledReadbackRecord {
  kind: "source" | "backbuffer";
  presentCount: number;
  nonBlackSamples: number;
  totalSamples: number;
  line: number;
}

/** Record reale emesso da `commands.cpp:821` (`[TARGET_DRAW_COPY]`). */
export interface TargetDrawCopyRecord {
  drawIndex: number;
  api: string;
  rtvSlot: number;
  trackedRtvResource: string;
  vsHash?: string;
  psHash?: string;
  latestCopySequenceAtDraw: number;
  latestCopySourceAtDraw: string;
  line: number;
}

/** Record reale emesso da `commands.cpp:2202` (`[COPY_TO_BB]`). */
export interface CopyToBackbufferRecord {
  sourceResource?: string;
  sourceTexture?: string;
  dimension?: number;
  width?: number;
  height?: number;
  format?: number;
  sequence: number;
  line: number;
}

/** Snapshot reale emesso da `commands.cpp:913-938` (`[BB_SOURCE_HISTORY_SNAPSHOT]` / `[BB_SOURCE_HISTORY]`). */
export interface BackbufferSourceHistorySnapshot {
  present: number;
  declaredResources: number;
  resources: Array<{
    resource: string;
    operations: number;
    draws: number;
    skipped: number;
    clears: number;
    entries: string[];
  }>;
  line: number;
}

export interface ReadbackDrawCorrelationAssessment {
  readbackPresentCount: number;
  copySequence: number;
  copySource: string;
  /**
   * Stato esplicito della correlazione con i dati oggi emessi dal proxy:
   * - `no-copy-to-backbuffer`: `copy_sequence == 0` o `copy_source` nullo.
   * - `candidate-only-not-proven`: esistono `[TARGET_DRAW_COPY]` con `tracked_rtv_resource == copy_source`
   *   e `latest_copy_sequence_at_draw < copy_sequence` (o `[BB_SOURCE_HISTORY]` sulla stessa risorsa),
   *   ma i puntatori `ID3D11Resource*` non hanno ID di generazione monotonico e `[TARGET_DRAW_COPY]`
   *   copre solo 2 coppie diagnostiche hardcoded; quindi NON è prova causale generale.
   * - `uncorrelated`: nessuna voce `[TARGET_DRAW_COPY]` o `[BB_SOURCE_HISTORY]` trovata per `copy_source`.
   */
  status: "no-copy-to-backbuffer" | "candidate-only-not-proven" | "uncorrelated";
  causalProofEstablished: false;
  candidateDrawIndices: number[];
  candidatePairs: Array<{ vs?: string; ps?: string }>;
  matchedCopyToBbSequence: boolean;
  limitations: string[];
}

export interface ExecutedGraphicsPair {
  vsHash: string;
  psHash?: string;
  drawCommands: number;
  rtvIsBackbufferObserved: boolean;
  firstObservedPresent: number;
  lastObservedPresent: number;
}

export interface RankedPlaceholderShader {
  hash: string;
  stage: ShaderStage;
  dumpPath?: string;
  dumpSkipped: boolean;
  psoCount: number;
  skippedOrObservedCommands: number;
  rtvIsBackbufferObserved: boolean;
  pairedVsHashes: string[];
  pairedPsHashes: string[];
  priorityScore: number;
}

export interface HelaProxyLogReport {
  totalLines: number;
  attestation: LaunchAttestationSummary;
  presentProgress: {
    swapChainsCreated: number;
    maxHeartbeatPresent: number;
    maxSummaryPresent: number;
    maxReadbackPresent: number;
    maxObservedPresent: number;
  };
  shaders: Record<string, ShaderObservation>;
  graphicsPsos: GraphicsPsoRecord[];
  computePsos: ComputePsoRecord[];
  /**
   * Nota esplicita di copertura: `pipeline.cpp:178` emette `[TARGET_INPUT_LAYOUT]` solo
   * per il VS diagnostico `20e0826b236597a1`. Non rappresenta copertura generale degli InputLayout.
   */
  targetInputLayoutCoverage: {
    scope: "diagnostic-vs-20e0826b236597a1-only";
    diagnosticVsHash: string;
    elements: TargetInputLayoutElement[];
  };
  inputLayoutFailures: InputLayoutFailure[];
  drawShaderUse: DrawShaderUseRecord[];
  computeShaderUse: ComputeShaderUseRecord[];
  shaderUseEvents: ShaderUseEventRecord[];
  executedGraphicsPairs: ExecutedGraphicsPair[];
  readbackIdentities: ReadbackIdentityRecord[];
  sampledReadbacks: SampledReadbackRecord[];
  targetDrawCopies: TargetDrawCopyRecord[];
  copyToBackbufferRecords: CopyToBackbufferRecord[];
  bbSourceHistorySnapshots: BackbufferSourceHistorySnapshot[];
  readbackCorrelations: ReadbackDrawCorrelationAssessment[];
  /** Mappa PS hash -> lista univoca di VS hash abbinati nelle PSO GRAPHICS o nei draw osservati. */
  psToVsMap: Record<string, string[]>;
  /** Mappa VS hash -> lista univoca di PS hash abbinati nelle PSO GRAPHICS o nei draw osservati. */
  vsToPsMap: Record<string, string[]>;
  /**
   * Placeholder catalogati nel log. Come da policy `runs/20261121/README.md`, il numero
   * di placeholder non è una metrica di completamento e `rtv_is_backbuffer=1` non dimostra
   * da solo che lo shader abbia prodotto pixel visibili.
   */
  placeholdersRanked: RankedPlaceholderShader[];
  summary: {
    uniqueShaders: number;
    nativeSm5: number;
    overrideReady: number;
    placeholders: number;
    blockedOrFailed: number;
    graphicsPsosTotal: number;
    graphicsPsosPlaceholder: number;
    computePsosTotal: number;
    computePsosPlaceholder: number;
    executedGraphicsPairsCount: number;
    inputLayoutFailures: number;
  };
}

const ZERO_HASH = "0000000000000000";

function normalizeHash(raw?: string): string | undefined {
  if (!raw) return undefined;
  const clean = raw.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{16}$/.test(clean) || clean === ZERO_HASH) return undefined;
  return clean;
}

function normalizePointer(raw?: string): string {
  if (!raw) return "0x0";
  const clean = raw.trim().toLowerCase();
  if (clean === "(null)" || clean === "0" || clean === "0x0" || /^0x0+$/.test(clean) || /^0+$/.test(clean)) {
    return "0x0";
  }
  return clean.startsWith("0x") ? clean : `0x${clean}`;
}

function parseKvTokens(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\b([A-Za-z0-9_.-]+)=([^\s;,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

function parseStageRef(raw: string | undefined): { hash: string; bytes: number } | undefined {
  if (!raw) return undefined;
  const m = raw.match(/^([0-9a-fA-F]{16})\/(\d+)$/);
  if (!m) return undefined;
  const hash = normalizeHash(m[1]);
  if (!hash) return undefined;
  return { hash, bytes: Number(m[2]) };
}

function ensureShader(
  map: Record<string, ShaderObservation>,
  hash: string,
  stage: ShaderStage,
  lineNumber: number,
): ShaderObservation {
  const existing = map[hash];
  if (existing) return existing;
  const created: ShaderObservation = {
    hash,
    stage,
    status: "seen",
    firstLine: lineNumber,
  };
  map[hash] = created;
  return created;
}

function isStage(value: string): value is ShaderStage {
  return value === "VS" || value === "PS" || value === "GS" || value === "HS" || value === "DS" || value === "CS";
}

function parseHexMask(raw?: string): number {
  if (!raw) return 0;
  return raw.startsWith("0x") || raw.startsWith("0X") ? parseInt(raw.slice(2), 16) : Number(raw) || 0;
}

/**
 * Parser allineato ai formati reali emessi dai sorgenti C++ del proxy Hela:
 * - `pipeline.cpp` (`SHADER *`, `PSO GRAPHICS/COMPUTE`, `[TARGET_INPUT_LAYOUT]`, `INPUT_LAYOUT_FAILED`)
 * - `util.cpp` (`MODULE_FINGERPRINT`, `Config`, `[HEARTBEAT]`, `[SHADER_USE_SUMMARY]`,
 *   `[DRAW_SHADER_USE]`, `[COMPUTE_SHADER_USE]`, `[SHADER_USE_EVENT]`)
 * - `commands.cpp` (`[TARGET_DRAW_COPY]`, `[COPY_TO_BB]`, `[BB_SOURCE_HISTORY_SNAPSHOT]`, `[BB_SOURCE_HISTORY]`)
 * - `dxgi_proxy.cpp` (`DIAGNOSTIC_MASK_NVIDIA`, `[READBACK_IDENTITY]`, `[READBACK_SRC]`, `[READBACK]`)
 */
export function parseHelaProxyLog(logText: string): HelaProxyLogReport {
  const lines = logText.split(/\r?\n/);
  const attestation: LaunchAttestationSummary = {
    modules: {},
    maskedNvidiaAdapter: false,
  };
  const presentProgress = {
    swapChainsCreated: 0,
    maxHeartbeatPresent: 0,
    maxSummaryPresent: 0,
    maxReadbackPresent: 0,
    maxObservedPresent: 0,
  };

  const shaders: Record<string, ShaderObservation> = {};
  const graphicsPsos: GraphicsPsoRecord[] = [];
  const computePsos: ComputePsoRecord[] = [];
  const targetInputLayoutElements: TargetInputLayoutElement[] = [];
  const inputLayoutFailures: InputLayoutFailure[] = [];
  const drawShaderUse: DrawShaderUseRecord[] = [];
  const computeShaderUse: ComputeShaderUseRecord[] = [];
  const shaderUseEvents: ShaderUseEventRecord[] = [];
  const readbackIdentities: ReadbackIdentityRecord[] = [];
  const sampledReadbacks: SampledReadbackRecord[] = [];
  const targetDrawCopies: TargetDrawCopyRecord[] = [];
  const copyToBackbufferRecords: CopyToBackbufferRecord[] = [];
  const bbSourceHistorySnapshots: BackbufferSourceHistorySnapshot[] = [];

  let activeReadbackSampleCtx: { kind: "source" | "backbuffer"; presentCount: number } | undefined;
  let activeBbSnapshot: BackbufferSourceHistorySnapshot | undefined;
  let activeBbResource: BackbufferSourceHistorySnapshot["resources"][number] | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (!line.trim()) continue;

    // 1. Runtime & launch profile attestation markers
    const modMatch = line.match(/MODULE_FINGERPRINT\s+role=(\S+).*?\bsha256=([0-9a-fA-F]{64})(?:\s|$)/);
    if (modMatch) {
      attestation.modules[modMatch[1]] = modMatch[2].toLowerCase();
      continue;
    }

    const maskMatch = line.match(/DIAGNOSTIC_MASK_NVIDIA:.*?exposed-vendor=(0x[0-9a-fA-F]+)/);
    if (maskMatch) {
      attestation.exposedVendor = maskMatch[1].toLowerCase();
      if (attestation.exposedVendor === "0xffff" && attestation.adapterSource === "proxy-unwrap") {
        attestation.maskedNvidiaAdapter = true;
      }
      continue;
    }

    const adapterMatch = line.match(/D3D12CreateDevice\s+adapter\s+source=(\S+)/);
    if (adapterMatch) {
      attestation.adapterSource = adapterMatch[1];
      if (attestation.exposedVendor === "0xffff" && attestation.adapterSource === "proxy-unwrap") {
        attestation.maskedNvidiaAdapter = true;
      }
      continue;
    }

    const tierMatch = line.match(/CheckFeatureSupport\s+end\s+feature=D3D12_OPTIONS(?:\(0\))?.*?\btiled-tier=(\d+)/);
    if (tierMatch) {
      attestation.tiledResourcesTier = Number(tierMatch[1]);
      continue;
    }

    const traceMatch = line.match(/Config\s+caller-trace=([01])(?:\s|$)/);
    if (traceMatch) {
      attestation.callerTrace = traceMatch[1] === "1";
      continue;
    }

    // 2. Heartbeat & ShaderUseSummary Present counters (util.cpp)
    if (line.includes("[HEARTBEAT]")) {
      const swapM = line.match(/\bswap=(\d+)/);
      const presM = line.match(/\bpresent=(\d+)/);
      if (swapM) presentProgress.swapChainsCreated = Math.max(presentProgress.swapChainsCreated, Number(swapM[1]));
      if (presM) presentProgress.maxHeartbeatPresent = Math.max(presentProgress.maxHeartbeatPresent, Number(presM[1]));
      continue;
    }

    if (line.includes("[SHADER_USE_SUMMARY]")) {
      const presM = line.match(/\bpresent_calls_process_wide=(\d+)/);
      if (presM) presentProgress.maxSummaryPresent = Math.max(presentProgress.maxSummaryPresent, Number(presM[1]));
      continue;
    }

    // 3. Shader lifecycle (pipeline.cpp)
    const beginMatch = line.match(
      /SHADER BEGIN\s+stage=(VS|PS|GS|HS|DS|CS)\s+hash=([0-9a-fA-F]{16})\s+bytes=(\d+)\s+DXBC=(\d+)\s+DXIL=(\d+)\s+legacy=(\d+)\s+model=(\d+_\d+)\s+RTS0=(\d+)/,
    );
    if (beginMatch && isStage(beginMatch[1])) {
      const hash = beginMatch[2].toLowerCase();
      const entry = ensureShader(shaders, hash, beginMatch[1], lineNo);
      entry.bytes = Number(beginMatch[3]);
      entry.isDxbc = beginMatch[4] === "1";
      entry.hasDxil = beginMatch[5] === "1";
      entry.hasLegacy = beginMatch[6] === "1";
      entry.shaderModel = beginMatch[7];
      entry.hasRts0 = beginMatch[8] === "1";
      continue;
    }

    const readyOverrideMatch = line.match(
      /SHADER READY\s+stage=(VS|PS|GS|HS|DS|CS)\s+hash=([0-9a-fA-F]{16})\s+source=SM5-override\s+path=(.+?)\s+bytes=(\d+)\s+sha256=([0-9a-fA-F]{64})(?:\s+model=(\d+_\d+))?/,
    );
    if (readyOverrideMatch && isStage(readyOverrideMatch[1])) {
      const hash = readyOverrideMatch[2].toLowerCase();
      const entry = ensureShader(shaders, hash, readyOverrideMatch[1], lineNo);
      entry.status = "override-ready";
      entry.overridePath = readyOverrideMatch[3].trim();
      entry.overrideSha256 = readyOverrideMatch[5].toLowerCase();
      continue;
    }

    const readyNativeMatch = line.match(
      /SHADER READY\s+stage=(VS|PS|GS|HS|DS|CS)\s+hash=([0-9a-fA-F]{16})\s+source=native-DXBC-SM(\d+_\d+)\s+bytes=(\d+)/,
    );
    if (readyNativeMatch && isStage(readyNativeMatch[1])) {
      const hash = readyNativeMatch[2].toLowerCase();
      const entry = ensureShader(shaders, hash, readyNativeMatch[1], lineNo);
      entry.status = "native-sm5";
      entry.shaderModel = entry.shaderModel ?? readyNativeMatch[3];
      continue;
    }

    const dumpedMatch = line.match(
      /SHADER DUMPED\s+stage=(VS|PS|GS|HS|DS|CS)\s+hash=([0-9a-fA-F]{16})\s+path=(.+?)\s+bytes=(\d+)/,
    );
    if (dumpedMatch && isStage(dumpedMatch[1])) {
      const hash = dumpedMatch[2].toLowerCase();
      const entry = ensureShader(shaders, hash, dumpedMatch[1], lineNo);
      entry.dumpPath = dumpedMatch[3].trim();
      entry.dumpSkipped = false;
      continue;
    }

    const dumpSkippedMatch = line.match(
      /SHADER DUMP_SKIPPED\s+stage=(VS|PS|GS|HS|DS|CS)\s+hash=([0-9a-fA-F]{16})\s+reason=(\S+)/,
    );
    if (dumpSkippedMatch && isStage(dumpSkippedMatch[1])) {
      const hash = dumpSkippedMatch[2].toLowerCase();
      const entry = ensureShader(shaders, hash, dumpSkippedMatch[1], lineNo);
      entry.dumpSkipped = true;
      continue;
    }

    const placeholderMatch = line.match(
      /SHADER PLACEHOLDER\s+stage=(VS|PS|GS|HS|DS|CS)\s+hash=([0-9a-fA-F]{16})\s+reason=(\S+).*?overrides=(.+)$/,
    );
    if (placeholderMatch && isStage(placeholderMatch[1])) {
      const hash = placeholderMatch[2].toLowerCase();
      const entry = ensureShader(shaders, hash, placeholderMatch[1], lineNo);
      if (entry.status !== "override-ready" && entry.status !== "native-sm5") {
        entry.status = "placeholder";
      }
      entry.reason = placeholderMatch[3];
      entry.overridePath = entry.overridePath ?? placeholderMatch[4].trim();
      continue;
    }

    const blockedMatch = line.match(/SHADER BLOCKED\s+stage=(VS|PS|GS|HS|DS|CS)(?:\s+hash=([0-9a-fA-F]{16}))?\s+reason=(\S+)/);
    if (blockedMatch && isStage(blockedMatch[1]) && blockedMatch[2]) {
      const hash = blockedMatch[2].toLowerCase();
      const entry = ensureShader(shaders, hash, blockedMatch[1], lineNo);
      entry.status = "blocked";
      entry.reason = blockedMatch[3];
      continue;
    }

    const createFailMatch = line.match(/SHADER D3D11_CREATE_FAILED\s+stage=(VS|PS|GS|HS|DS|CS)\s+result=(0x[0-9a-fA-F]+)\s+bytes=(\d+)/);
    if (createFailMatch && isStage(createFailMatch[1])) {
      const lastForStage = Object.values(shaders)
        .filter((s) => s.stage === createFailMatch[1])
        .sort((a, b) => b.firstLine - a.firstLine)[0];
      if (lastForStage) {
        lastForStage.status = "create-failed";
        lastForStage.createFailedHr = createFailMatch[2].toLowerCase();
      }
      continue;
    }

    // 4. [TARGET_INPUT_LAYOUT] (hardcoded in pipeline.cpp:178 al solo VS diagnostico 20e0826b236597a1)
    const targetIlMatch = line.match(
      /\[TARGET_INPUT_LAYOUT\]\s+element=(\d+)\s+semantic=(\S+)\s+semantic_index=(\d+)\s+slot=(\d+)\s+format=(\d+)\s+offset=(\d+)\s+classification=(\d+)\s+step_rate=(\d+)/,
    );
    if (targetIlMatch) {
      targetInputLayoutElements.push({
        element: Number(targetIlMatch[1]),
        semantic: targetIlMatch[2],
        semanticIndex: Number(targetIlMatch[3]),
        slot: Number(targetIlMatch[4]),
        format: Number(targetIlMatch[5]),
        offset: Number(targetIlMatch[6]),
        classification: Number(targetIlMatch[7]),
        stepRate: Number(targetIlMatch[8]),
      });
      continue;
    }

    const ilFailMatch = line.match(/INPUT_LAYOUT_FAILED\s+elements=(\d+)\s+result=(0x[0-9a-fA-F]+)/);
    if (ilFailMatch) {
      inputLayoutFailures.push({
        elements: Number(ilFailMatch[1]),
        hresult: ilFailMatch[2].toLowerCase(),
        line: lineNo,
      });
      continue;
    }

    // 5. PSO GRAPHICS / COMPUTE READY (pipeline.cpp)
    const psoGfxMatch = line.match(
      /PSO GRAPHICS #(\d+)\s+READY\s+status=(\S+)\s+pso=(\S+)\s+missing_mask=0x([0-9a-fA-F]+)\s+VS=(\S+)\s+PS=(\S+)\s+GS=(\S+)\s+HS=(\S+)\s+DS=(\S+)\s+d11_vs=([01])\s+d11_ps=([01])\s+d11_il=([01])/,
    );
    if (psoGfxMatch) {
      const record: GraphicsPsoRecord = {
        index: Number(psoGfxMatch[1]),
        status: psoGfxMatch[2],
        psoPtr: psoGfxMatch[3],
        missingMask: parseInt(psoGfxMatch[4], 16),
        vs: parseStageRef(psoGfxMatch[5]),
        ps: parseStageRef(psoGfxMatch[6]),
        gs: parseStageRef(psoGfxMatch[7]),
        hs: parseStageRef(psoGfxMatch[8]),
        ds: parseStageRef(psoGfxMatch[9]),
        d11Vs: psoGfxMatch[10] === "1",
        d11Ps: psoGfxMatch[11] === "1",
        d11Il: psoGfxMatch[12] === "1",
        line: lineNo,
      };
      graphicsPsos.push(record);
      if (record.vs) ensureShader(shaders, record.vs.hash, "VS", lineNo);
      if (record.ps) ensureShader(shaders, record.ps.hash, "PS", lineNo);
      if (record.gs) ensureShader(shaders, record.gs.hash, "GS", lineNo);
      if (record.hs) ensureShader(shaders, record.hs.hash, "HS", lineNo);
      if (record.ds) ensureShader(shaders, record.ds.hash, "DS", lineNo);
      continue;
    }

    const psoCompMatch = line.match(
      /PSO COMPUTE #(\d+)\s+READY\s+status=(\S+)\s+pso=(\S+)\s+missing_mask=0x([0-9a-fA-F]+)\s+CS=(\S+)\s+d11_cs=([01])/,
    );
    if (psoCompMatch) {
      const csRef = parseStageRef(psoCompMatch[5]);
      if (csRef) {
        computePsos.push({
          index: Number(psoCompMatch[1]),
          status: psoCompMatch[2],
          psoPtr: psoCompMatch[3],
          missingMask: parseInt(psoCompMatch[4], 16),
          cs: csRef,
          d11Cs: psoCompMatch[6] === "1",
          line: lineNo,
        });
        ensureShader(shaders, csRef.hash, "CS", lineNo);
      }
      continue;
    }

    // 6. [DRAW_SHADER_USE] & [COMPUTE_SHADER_USE] (util.cpp:229-256 — nomi campo esatti!)
    if (line.includes("[DRAW_SHADER_USE]")) {
      const kv = parseKvTokens(line);
      if (kv.draw_commands !== undefined && kv.rtv_is_backbuffer !== undefined) {
        const rec: DrawShaderUseRecord = {
          outcome: kv.outcome ?? "unknown",
          vsHash: normalizeHash(kv.vs),
          psHash: normalizeHash(kv.ps),
          gsHash: normalizeHash(kv.gs),
          hsHash: normalizeHash(kv.hs),
          dsHash: normalizeHash(kv.ds),
          missingMask: parseHexMask(kv.missing_mask),
          graphicsPsoBound: kv.graphics_pso_bound === "1",
          rtvIsBackbuffer: kv.rtv_is_backbuffer === "1",
          drawCommands: Number(kv.draw_commands) || 0,
          firstObservedPresentCountProcessWide: Number(kv.first_observed_present_count_process_wide) || 0,
          lastObservedPresentCountProcessWide: Number(kv.last_observed_present_count_process_wide) || 0,
          line: lineNo,
        };
        drawShaderUse.push(rec);
        presentProgress.maxSummaryPresent = Math.max(
          presentProgress.maxSummaryPresent,
          rec.lastObservedPresentCountProcessWide,
        );
      }
      continue;
    }

    if (line.includes("[COMPUTE_SHADER_USE]")) {
      const kv = parseKvTokens(line);
      if (kv.dispatch_commands !== undefined) {
        const rec: ComputeShaderUseRecord = {
          outcome: kv.outcome ?? "unknown",
          csHash: normalizeHash(kv.cs),
          missingMask: parseHexMask(kv.missing_mask),
          dispatchCommands: Number(kv.dispatch_commands) || 0,
          firstObservedPresentCountProcessWide: Number(kv.first_observed_present_count_process_wide) || 0,
          lastObservedPresentCountProcessWide: Number(kv.last_observed_present_count_process_wide) || 0,
          line: lineNo,
        };
        computeShaderUse.push(rec);
        presentProgress.maxSummaryPresent = Math.max(
          presentProgress.maxSummaryPresent,
          rec.lastObservedPresentCountProcessWide,
        );
      }
      continue;
    }

    // 7. [SHADER_USE_EVENT] (util.cpp:278-299)
    if (line.includes("[SHADER_USE_EVENT]")) {
      const kv = parseKvTokens(line);
      if (kv.kind === "draw" || kv.kind === "dispatch") {
        shaderUseEvents.push({
          ordinal: Number(kv.ordinal) || 0,
          observedPresentCallsReturned: Number(kv.observed_present_calls_returned) || 0,
          kind: kv.kind,
          outcome: kv.outcome ?? "unknown",
          executionCount: Number(kv.execution_count) || 0,
          vsHash: normalizeHash(kv.vs),
          psHash: normalizeHash(kv.ps),
          gsHash: normalizeHash(kv.gs),
          hsHash: normalizeHash(kv.hs),
          dsHash: normalizeHash(kv.ds),
          csHash: normalizeHash(kv.cs),
          missingMask: parseHexMask(kv.missing_mask),
          graphicsPsoBound: kv.graphics_pso_bound !== undefined ? kv.graphics_pso_bound === "1" : undefined,
          rtvIsBackbuffer: kv.rtv_is_backbuffer !== undefined ? kv.rtv_is_backbuffer === "1" : undefined,
          line: lineNo,
        });
      }
      continue;
    }

    // 8. [READBACK_IDENTITY] (dxgi_proxy.cpp:342 — nomi campo esatti!)
    if (line.includes("[READBACK_IDENTITY]")) {
      const kv = parseKvTokens(line);
      if (kv.readback_present_count !== undefined && kv.copy_sequence !== undefined && kv.copy_source !== undefined) {
        const rec: ReadbackIdentityRecord = {
          readbackPresentCount: Number(kv.readback_present_count) || 0,
          bufferIndex: Number(kv.buffer_index) || 0,
          nativeBackbuffer: normalizePointer(kv.native_backbuffer),
          width: Number(kv.width) || 0,
          height: Number(kv.height) || 0,
          format: Number(kv.format) || 0,
          copySequence: Number(kv.copy_sequence) || 0,
          copySource: normalizePointer(kv.copy_source),
          line: lineNo,
        };
        readbackIdentities.push(rec);
        presentProgress.maxReadbackPresent = Math.max(presentProgress.maxReadbackPresent, rec.readbackPresentCount);
      }
      continue;
    }

    // 9. [READBACK_SRC] / [READBACK] sampled non-black counts (dxgi_proxy.cpp:240-260)
    const rbHeaderMatch = line.match(/\[(READBACK_SRC|READBACK)\]\s+Present #(\d+)\s+size=\d+x\d+/);
    if (rbHeaderMatch) {
      const presentCount = Number(rbHeaderMatch[2]);
      activeReadbackSampleCtx = {
        kind: rbHeaderMatch[1] === "READBACK_SRC" ? "source" : "backbuffer",
        presentCount,
      };
      presentProgress.maxReadbackPresent = Math.max(presentProgress.maxReadbackPresent, presentCount);
      continue;
    }

    const rbNonBlackMatch = line.match(/\[(READBACK_SRC|READBACK)\]\s+Non-black pixels:\s*(\d+)\/(\d+)/);
    if (rbNonBlackMatch && activeReadbackSampleCtx) {
      const kind = rbNonBlackMatch[1] === "READBACK_SRC" ? "source" : "backbuffer";
      if (activeReadbackSampleCtx.kind === kind) {
        sampledReadbacks.push({
          kind,
          presentCount: activeReadbackSampleCtx.presentCount,
          nonBlackSamples: Number(rbNonBlackMatch[2]),
          totalSamples: Number(rbNonBlackMatch[3]),
          line: lineNo,
        });
      }
      continue;
    }

    // 10. [TARGET_DRAW_COPY] (commands.cpp:821 — nomi campo esatti!)
    if (line.includes("[TARGET_DRAW_COPY]")) {
      const kv = parseKvTokens(line);
      if (
        kv.draw_index !== undefined &&
        kv.tracked_rtv_resource !== undefined &&
        kv.latest_copy_sequence_at_draw !== undefined &&
        kv.latest_copy_source_at_draw !== undefined
      ) {
        targetDrawCopies.push({
          drawIndex: Number(kv.draw_index) || 0,
          api: kv.api ?? "unknown",
          rtvSlot: Number(kv.rtv_slot) || 0,
          trackedRtvResource: normalizePointer(kv.tracked_rtv_resource),
          vsHash: normalizeHash(kv.vs),
          psHash: normalizeHash(kv.ps),
          latestCopySequenceAtDraw: Number(kv.latest_copy_sequence_at_draw) || 0,
          latestCopySourceAtDraw: normalizePointer(kv.latest_copy_source_at_draw),
          line: lineNo,
        });
      }
      continue;
    }

    // 11. [COPY_TO_BB] (commands.cpp:2202)
    if (line.includes("[COPY_TO_BB]")) {
      const kv = parseKvTokens(line);
      if (kv.sequence !== undefined) {
        copyToBackbufferRecords.push({
          sourceResource: kv.source ? normalizePointer(kv.source) : kv.resource ? normalizePointer(kv.resource) : undefined,
          sourceTexture: kv.source_texture ? normalizePointer(kv.source_texture) : undefined,
          dimension: kv.dimension !== undefined ? Number(kv.dimension) : undefined,
          width: kv.width !== undefined ? Number(kv.width) : undefined,
          height: kv.height !== undefined ? Number(kv.height) : undefined,
          format: kv.format !== undefined ? Number(kv.format) : undefined,
          sequence: Number(kv.sequence) || 0,
          line: lineNo,
        });
      }
      continue;
    }

    // 12. [BB_SOURCE_HISTORY_SNAPSHOT] & [BB_SOURCE_HISTORY] (commands.cpp:913-938)
    const bbSnapMatch = line.match(/\[BB_SOURCE_HISTORY_SNAPSHOT\]\s+present=(\d+)\s+resources=(\d+)/);
    if (bbSnapMatch) {
      const present = Number(bbSnapMatch[1]);
      activeBbSnapshot = {
        present,
        declaredResources: Number(bbSnapMatch[2]),
        resources: [],
        line: lineNo,
      };
      activeBbResource = undefined;
      bbSourceHistorySnapshots.push(activeBbSnapshot);
      presentProgress.maxReadbackPresent = Math.max(presentProgress.maxReadbackPresent, present);
      continue;
    }

    if (line.includes("[BB_SOURCE_HISTORY]") && activeBbSnapshot) {
      const resMatch = line.match(
        /\[BB_SOURCE_HISTORY\]\s+Resource\s+(\S+)\s+operations=(\d+)\s+draws=(\d+)\s+skipped=(\d+)\s+clears=(\d+)/,
      );
      if (resMatch) {
        activeBbResource = {
          resource: normalizePointer(resMatch[1]),
          operations: Number(resMatch[2]),
          draws: Number(resMatch[3]),
          skipped: Number(resMatch[4]),
          clears: Number(resMatch[5]),
          entries: [],
        };
        activeBbSnapshot.resources.push(activeBbResource);
        continue;
      }
      const noHistMatch = line.match(/\[BB_SOURCE_HISTORY\]\s+Resource\s+(\S+)\s+has NO draw\/clear history/);
      if (noHistMatch) {
        activeBbResource = {
          resource: normalizePointer(noHistMatch[1]),
          operations: 0,
          draws: 0,
          skipped: 0,
          clears: 0,
          entries: [],
        };
        activeBbSnapshot.resources.push(activeBbResource);
        continue;
      }
      const entryMatch = line.match(/\[BB_SOURCE_HISTORY\]\s{2,}(.+)$/);
      if (entryMatch && activeBbResource) {
        activeBbResource.entries.push(entryMatch[1].trim());
      }
    }
  }

  presentProgress.maxObservedPresent = Math.max(
    presentProgress.maxHeartbeatPresent,
    presentProgress.maxSummaryPresent,
    presentProgress.maxReadbackPresent,
  );

  // Build VS <-> PS pairing graph from PSOs + DRAW_SHADER_USE + SHADER_USE_EVENT
  const psToVsSet = new Map<string, Set<string>>();
  const vsToPsSet = new Map<string, Set<string>>();
  const psoCountByHash = new Map<string, number>();

  const linkPair = (vsHash?: string, psHash?: string) => {
    if (!vsHash || !psHash) return;
    if (!psToVsSet.has(psHash)) psToVsSet.set(psHash, new Set());
    if (!vsToPsSet.has(vsHash)) vsToPsSet.set(vsHash, new Set());
    psToVsSet.get(psHash)!.add(vsHash);
    vsToPsSet.get(vsHash)!.add(psHash);
  };

  for (const pso of graphicsPsos) {
    for (const ref of [pso.vs, pso.ps, pso.gs, pso.hs, pso.ds]) {
      if (ref) psoCountByHash.set(ref.hash, (psoCountByHash.get(ref.hash) ?? 0) + 1);
    }
    linkPair(pso.vs?.hash, pso.ps?.hash);
  }
  for (const pso of computePsos) {
    psoCountByHash.set(pso.cs.hash, (psoCountByHash.get(pso.cs.hash) ?? 0) + 1);
  }

  const commandsByHash = new Map<string, number>();
  const backbufferByHash = new Set<string>();
  const executedPairAgg = new Map<string, ExecutedGraphicsPair>();

  for (const d of drawShaderUse) {
    linkPair(d.vsHash, d.psHash);
    for (const h of [d.vsHash, d.psHash, d.gsHash, d.hsHash, d.dsHash]) {
      if (!h) continue;
      commandsByHash.set(h, (commandsByHash.get(h) ?? 0) + d.drawCommands);
      if (d.rtvIsBackbuffer) backbufferByHash.add(h);
    }
    if (d.outcome === "executed" && d.vsHash) {
      const key = `${d.vsHash}|${d.psHash ?? ""}`;
      const existing = executedPairAgg.get(key);
      if (!existing) {
        executedPairAgg.set(key, {
          vsHash: d.vsHash,
          psHash: d.psHash,
          drawCommands: d.drawCommands,
          rtvIsBackbufferObserved: d.rtvIsBackbuffer,
          firstObservedPresent: d.firstObservedPresentCountProcessWide,
          lastObservedPresent: d.lastObservedPresentCountProcessWide,
        });
      } else {
        existing.drawCommands += d.drawCommands;
        existing.rtvIsBackbufferObserved = existing.rtvIsBackbufferObserved || d.rtvIsBackbuffer;
        existing.firstObservedPresent = Math.min(existing.firstObservedPresent, d.firstObservedPresentCountProcessWide);
        existing.lastObservedPresent = Math.max(existing.lastObservedPresent, d.lastObservedPresentCountProcessWide);
      }
    }
  }

  for (const c of computeShaderUse) {
    if (c.csHash) {
      commandsByHash.set(c.csHash, (commandsByHash.get(c.csHash) ?? 0) + c.dispatchCommands);
    }
  }

  for (const ev of shaderUseEvents) {
    if (ev.kind === "draw") linkPair(ev.vsHash, ev.psHash);
  }

  const psToVsMap: Record<string, string[]> = {};
  for (const [ps, set] of psToVsSet) psToVsMap[ps] = [...set].sort();
  const vsToPsMap: Record<string, string[]> = {};
  for (const [vs, set] of vsToPsSet) vsToPsMap[vs] = [...set].sort();

  const placeholdersRanked: RankedPlaceholderShader[] = Object.values(shaders)
    .filter((s) => s.status === "placeholder" || s.status === "blocked" || s.status === "create-failed")
    .map((s) => {
      const psoCount = psoCountByHash.get(s.hash) ?? 0;
      const skippedOrObservedCommands = commandsByHash.get(s.hash) ?? 0;
      const rtvIsBackbufferObserved = backbufferByHash.has(s.hash);
      const priorityScore =
        (rtvIsBackbufferObserved ? 10_000 : 0) +
        skippedOrObservedCommands * 10 +
        psoCount * 5 +
        (s.dumpPath ? 100 : 0);
      return {
        hash: s.hash,
        stage: s.stage,
        dumpPath: s.dumpPath,
        dumpSkipped: s.dumpSkipped === true,
        psoCount,
        skippedOrObservedCommands,
        rtvIsBackbufferObserved,
        pairedVsHashes: psToVsMap[s.hash] ?? [],
        pairedPsHashes: vsToPsMap[s.hash] ?? [],
        priorityScore,
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore || a.hash.localeCompare(b.hash));

  // Valutazione onesta della correlazione READBACK_IDENTITY <-> TARGET_DRAW_COPY / COPY_TO_BB
  const copyToBbBySeq = new Map<number, CopyToBackbufferRecord>();
  for (const rec of copyToBackbufferRecords) copyToBbBySeq.set(rec.sequence, rec);

  const readbackCorrelations: ReadbackDrawCorrelationAssessment[] = readbackIdentities.map((rb) => {
    const limitations: string[] = [
      "[TARGET_DRAW_COPY] in commands.cpp è emesso solo per le 2 coppie diagnostiche hardcoded (20e0826b236597a1 / 44b0a992c2304254 e d77600bde0076c33).",
      "latest_copy_sequence_at_draw registra la copy_sequence precedente al draw, non la copia successiva al backbuffer.",
      "copy_source e tracked_rtv_resource sono puntatori ID3D11Resource* senza ID di generazione monotonico (possibile riuso di indirizzo).",
    ];

    if (rb.copySequence === 0 || rb.copySource === "0x0") {
      return {
        readbackPresentCount: rb.readbackPresentCount,
        copySequence: rb.copySequence,
        copySource: rb.copySource,
        status: "no-copy-to-backbuffer",
        causalProofEstablished: false,
        candidateDrawIndices: [],
        candidatePairs: [],
        matchedCopyToBbSequence: false,
        limitations,
      };
    }

    const copyRecord = copyToBbBySeq.get(rb.copySequence);
    const matchedCopyToBbSequence = Boolean(copyRecord && copyRecord.sourceTexture === rb.copySource);

    // Un draw può aver scritto nella risorsa copiata alla sequenza S solo se ha disegnato PRIMA della copia S
    // (latest_copy_sequence_at_draw < S) sulla stessa risorsa tracked_rtv_resource == copy_source.
    const candidateDraws = targetDrawCopies.filter(
      (tdc) =>
        tdc.trackedRtvResource === rb.copySource &&
        tdc.latestCopySequenceAtDraw < rb.copySequence &&
        tdc.line < rb.line,
    );

    const drawIndices = [...new Set(candidateDraws.map((d) => d.drawIndex))].sort((a, b) => a - b);
    const pairKeys = new Set<string>();
    const candidatePairs: Array<{ vs?: string; ps?: string }> = [];
    for (const d of candidateDraws) {
      const k = `${d.vsHash ?? ""}|${d.psHash ?? ""}`;
      if (!pairKeys.has(k)) {
        pairKeys.add(k);
        candidatePairs.push({ vs: d.vsHash, ps: d.psHash });
      }
    }

    const bbSnapHasResource = bbSourceHistorySnapshots.some(
      (snap) =>
        snap.present === rb.readbackPresentCount &&
        snap.resources.some((r) => r.resource === rb.copySource && r.draws > 0),
    );

    return {
      readbackPresentCount: rb.readbackPresentCount,
      copySequence: rb.copySequence,
      copySource: rb.copySource,
      status: drawIndices.length > 0 || bbSnapHasResource ? "candidate-only-not-proven" : "uncorrelated",
      causalProofEstablished: false,
      candidateDrawIndices: drawIndices,
      candidatePairs,
      matchedCopyToBbSequence,
      limitations,
    };
  });

  const executedGraphicsPairs = [...executedPairAgg.values()].sort(
    (a, b) => b.drawCommands - a.drawCommands || a.vsHash.localeCompare(b.vsHash),
  );
  const allShaders = Object.values(shaders);

  return {
    totalLines: lines.length,
    attestation,
    presentProgress,
    shaders,
    graphicsPsos,
    computePsos,
    targetInputLayoutCoverage: {
      scope: "diagnostic-vs-20e0826b236597a1-only",
      diagnosticVsHash: TARGET_INPUT_LAYOUT_DIAGNOSTIC_VS,
      elements: targetInputLayoutElements,
    },
    inputLayoutFailures,
    drawShaderUse,
    computeShaderUse,
    shaderUseEvents,
    executedGraphicsPairs,
    readbackIdentities,
    sampledReadbacks,
    targetDrawCopies,
    copyToBackbufferRecords,
    bbSourceHistorySnapshots,
    readbackCorrelations,
    psToVsMap,
    vsToPsMap,
    placeholdersRanked,
    summary: {
      uniqueShaders: allShaders.length,
      nativeSm5: allShaders.filter((s) => s.status === "native-sm5").length,
      overrideReady: allShaders.filter((s) => s.status === "override-ready").length,
      placeholders: allShaders.filter((s) => s.status === "placeholder").length,
      blockedOrFailed: allShaders.filter((s) => s.status === "blocked" || s.status === "create-failed").length,
      graphicsPsosTotal: graphicsPsos.length,
      graphicsPsosPlaceholder: graphicsPsos.filter((p) => p.missingMask !== 0).length,
      computePsosTotal: computePsos.length,
      computePsosPlaceholder: computePsos.filter((p) => p.missingMask !== 0).length,
      executedGraphicsPairsCount: executedGraphicsPairs.length,
      inputLayoutFailures: inputLayoutFailures.length,
    },
  };
}

export function parseHelaProxyLogFile(logPath: string): HelaProxyLogReport {
  return parseHelaProxyLog(fs.readFileSync(logPath, "utf8"));
}
