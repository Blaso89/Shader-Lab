/**
 * PIX capture inspector (.wpix) — SOLA LETTURA, a blocchi, con limiti espliciti.
 *
 * COSA FA (fatti verificabili sui byte):
 *  - dimensione file (stat) e dump dei primi N byte (default 64);
 *  - ricerca dei marker ASCII osservati nell'header (GFXA / GFXB / GFXC) nell'header;
 *  - scansione a blocchi dei primi `maxScanBytes` byte alla ricerca dei pattern byte
 *    GFXA/GFXB/GFXC e "DXBC" (conteggio + primi offset), con overlap tra blocchi;
 *  - entropia di Shannon del primo blocco (indicatore numerico, interpretazione = ipotesi).
 *
 * COSA NON FA:
 *  - NON decodifica il formato .wpix (non è documentato: nessuna struttura è assunta);
 *  - NON estrae PSO, shader, eventi o risorse; i pattern trovati NON sono chunk verificati;
 *  - NON esegue pixtool.exe (ne rileva solo la presenza);
 *  - NON legge mai il file intero: vietato readFile / readFileSync / createReadStream.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const KNOWN_MARKERS = ["GFXA", "GFXB", "GFXC"] as const;
/** Pattern DXBC: magic del container documentato D3D; qui è solo un pattern byte NON validato. */
export const DXBC_MAGIC = "DXBC";

const MiB = 1024 * 1024;

export const DEFAULT_LIMITS = {
  headerBytes: 64,
  blockBytes: 1 * MiB,
  maxScanBytes: 64 * MiB,
  maxOffsetsPerPattern: 16,
} as const;

export const HARD_LIMITS = {
  minHeaderBytes: 16,
  maxHeaderBytes: 4096,
  minBlockBytes: 16,
  maxBlockBytes: 16 * MiB,
  maxScanBytes: 256 * MiB,
} as const;

/** Sorgente di byte astratta: permette di simulare file enormi nei test senza allocarli. */
export interface ByteSource {
  readonly size: number;
  read(position: number, length: number): Promise<Buffer>;
}

export interface PixScanOptions {
  headerBytes?: number;
  blockBytes?: number;
  maxScanBytes?: number;
  /** undefined = autodetect pixtool; null = non cercare (test). */
  pixtoolPath?: string | null;
}

export interface PatternHits {
  pattern: string;
  kind: "marker" | "dxbc-pattern";
  count: number;
  offsets: number[];
  offsetsTruncated: boolean;
}

export type PixStatus = "empty" | "truncated_header" | "unrecognized_header" | "known_markers_in_header";

export interface PixCaptureReport {
  file: string;
  extensionOk: boolean;
  sizeBytes: number;
  status: PixStatus;
  /** Sempre false: questo tool non decodifica .wpix. */
  decoded: false;
  limits: { headerBytes: number; blockBytes: number; maxScanBytes: number };
  header: {
    bytesRead: number;
    hexDump: string;
    asciiPreview: string;
    leadingTag: string | null;
    knownMarkers: { marker: string; offset: number }[];
  };
  scan: {
    bytesScanned: number;
    blocksRead: number;
    complete: boolean;
    firstBlockEntropyBitsPerByte: number | null;
    hits: PatternHits[];
  };
  pixtool: { found: boolean; path: string | null };
  warnings: string[];
  nextInputs: string[];
}

function clampInt(v: number | undefined, min: number, max: number, def: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export function resolveLimits(o: PixScanOptions = {}) {
  return {
    headerBytes: clampInt(o.headerBytes, HARD_LIMITS.minHeaderBytes, HARD_LIMITS.maxHeaderBytes, DEFAULT_LIMITS.headerBytes),
    blockBytes: clampInt(o.blockBytes, HARD_LIMITS.minBlockBytes, HARD_LIMITS.maxBlockBytes, DEFAULT_LIMITS.blockBytes),
    maxScanBytes: clampInt(o.maxScanBytes, 1, HARD_LIMITS.maxScanBytes, DEFAULT_LIMITS.maxScanBytes),
  };
}

export function shannonEntropy(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (const b of buf) counts[b]++;
  let h = 0;
  for (const c of counts) {
    if (!c) continue;
    const p = c / buf.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function hexDump(buf: Buffer): string {
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const row = buf.subarray(i, i + 16);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, "0")).join(" ");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex}`);
  }
  return lines.join("\n");
}

function asciiPreview(buf: Buffer): string {
  return Array.from(buf, (b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
}

/** Rileva pixtool.exe; l'esecuzione è demandata alla modalità completa PIX. */
export function findPixTool(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.PIXTOOL_PATH;
  if (explicit && fs.existsSync(explicit) && fs.statSync(explicit).isFile()) return explicit;

  for (const programFiles of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    if (!programFiles) continue;
    const root = path.join(programFiles, "Microsoft PIX");
    try {
      const dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const dir of dirs) {
        const candidate = path.join(root, dir, "pixtool.exe");
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
    } catch { /* PIX non installato in questa directory */ }
  }

  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "pixtool.exe");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Apre un file in sola lettura. Nessuna lettura integrale. */
export async function openFileSource(filePath: string): Promise<ByteSource & { close(): Promise<void> }> {
  const st = await fs.promises.stat(filePath);
  if (!st.isFile()) throw new Error(`Non è un file: ${filePath}`);
  const handle = await fs.promises.open(filePath, "r");
  return {
    size: st.size,
    async read(position: number, length: number) {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, position);
      return bytesRead === length ? buf : buf.subarray(0, bytesRead);
    },
    close: () => handle.close(),
  };
}

function nextInputs(file: string): string[] {
  return [
    "Con PIX installato, esporta l'event list in CSV usando il flusso documentato dalla versione PIX in uso; questo tool non avvia PIX né pixtool.",
    "Per immagini o risorse, usa manualmente le funzioni documentate della versione PIX in uso; questo tool non avvia export e non modifica la cattura.",
    "In alternativa, fornisci un event-list CSV esportato dalla UI di PIX.",
    "Per gli shader: fornisci singoli .dxil e/o i disassemblati DXC (.txt) e usa il tool `analyze_dxil` (dxilPath / disasmPath / dir).",
    `Nota: un CSV event list di un'altra cattura non conteneva descrizioni PSO/bytecode; non assumere lo stesso contenuto per "${file}" senza verificarlo.`,
  ];
}

export async function analyzeSource(source: ByteSource, fileLabel: string, options: PixScanOptions = {}): Promise<PixCaptureReport> {
  const limits = resolveLimits(options);
  const warnings: string[] = [];
  const extensionOk = fileLabel.toLowerCase().endsWith(".wpix");
  if (!extensionOk) warnings.push("L'estensione non è .wpix.");

  const pixtoolPath = options.pixtoolPath === undefined ? findPixTool() : options.pixtoolPath;

  // ---- header (una sola lettura, al massimo headerBytes)
  const headerLen = Math.min(limits.headerBytes, source.size);
  const head = headerLen > 0 ? await source.read(0, headerLen) : Buffer.alloc(0);
  const leading = head.length >= 4 ? head.subarray(0, 4) : null;
  const leadingTag = leading && leading.every((b) => b >= 0x20 && b <= 0x7e) ? leading.toString("latin1") : null;

  const knownMarkers: { marker: string; offset: number }[] = [];
  for (const m of KNOWN_MARKERS) {
    const needle = Buffer.from(m, "latin1");
    let i = head.indexOf(needle);
    while (i !== -1) {
      knownMarkers.push({ marker: m, offset: i });
      i = head.indexOf(needle, i + 1);
    }
  }
  knownMarkers.sort((a, b) => a.offset - b.offset);

  // ---- scansione a blocchi con overlap
  const patterns: { name: string; kind: PatternHits["kind"]; buf: Buffer }[] = [
    ...KNOWN_MARKERS.map((m) => ({ name: m, kind: "marker" as const, buf: Buffer.from(m, "latin1") })),
    { name: DXBC_MAGIC, kind: "dxbc-pattern" as const, buf: Buffer.from(DXBC_MAGIC, "latin1") },
  ];
  const hits: PatternHits[] = patterns.map((p) => ({ pattern: p.name, kind: p.kind, count: 0, offsets: [], offsetsTruncated: false }));
  const overlap = Math.max(...patterns.map((p) => p.buf.length)) - 1;

  const scanLimit = Math.min(source.size, limits.maxScanBytes);
  let pos = 0;
  let blocks = 0;
  let tail: Buffer = Buffer.alloc(0);
  let entropy: number | null = null;

  while (pos < scanLimit) {
    const want = Math.min(limits.blockBytes, scanLimit - pos);
    const chunk = await source.read(pos, want);
    if (chunk.length === 0) {
      warnings.push(`Lettura vuota all'offset ${pos}: file più corto di quanto riportato da stat o letture interrotte.`);
      break;
    }
    if (blocks === 0) entropy = shannonEntropy(chunk);
    const buf = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    const base = pos - tail.length;
    patterns.forEach((p, idx) => {
      let i = buf.indexOf(p.buf);
      while (i !== -1) {
        // conta solo i match che terminano nei dati nuovi (evita doppi conteggi nell'overlap)
        if (i + p.buf.length > tail.length) {
          const h = hits[idx];
          h.count++;
          if (h.offsets.length < DEFAULT_LIMITS.maxOffsetsPerPattern) h.offsets.push(base + i);
          else h.offsetsTruncated = true;
        }
        i = buf.indexOf(p.buf, i + 1);
      }
    });
    tail = Buffer.from(buf.subarray(Math.max(0, buf.length - overlap)));
    pos += chunk.length;
    blocks++;
  }

  const complete = pos >= source.size;
  if (!complete) {
    warnings.push(
      `Scansione parziale: analizzati ${pos} byte su ${source.size} (limite maxScanBytes=${limits.maxScanBytes}). I conteggi dei pattern riguardano solo questa parte.`,
    );
  }

  let status: PixStatus;
  if (source.size === 0) status = "empty";
  else if (source.size < limits.headerBytes) status = "truncated_header";
  else if (knownMarkers.length > 0) status = "known_markers_in_header";
  else status = "unrecognized_header";

  if (status === "truncated_header") {
    warnings.push(`File più corto dell'header analizzato (${source.size} < ${limits.headerBytes} byte): possibile file troncato o non .wpix.`);
  }
  if (status === "unrecognized_header") {
    warnings.push("Nessun marker noto (GFXA/GFXB/GFXC) nell'header: formato non riconosciuto da questo tool.");
  }
  warnings.push("Il formato .wpix non è documentato e non esiste un decoder verificato in questo tool: nessuna integrità o struttura è stata verificata.");

  return {
    file: fileLabel,
    extensionOk,
    sizeBytes: source.size,
    status,
    decoded: false,
    limits,
    header: {
      bytesRead: head.length,
      hexDump: hexDump(head),
      asciiPreview: asciiPreview(head),
      leadingTag,
      knownMarkers,
    },
    scan: { bytesScanned: pos, blocksRead: blocks, complete, firstBlockEntropyBitsPerByte: entropy, hits },
    pixtool: { found: !!pixtoolPath, path: pixtoolPath ?? null },
    warnings,
    nextInputs: nextInputs(fileLabel),
  };
}

/** Analizza un file su disco: solo header + scansione a blocchi, mai lettura integrale. */
export async function analyzePixCapture(filePath: string, options: PixScanOptions = {}): Promise<PixCaptureReport> {
  const src = await openFileSource(filePath);
  try {
    return await analyzeSource(src, filePath, options);
  } finally {
    await src.close();
  }
}

const STATUS_TEXT: Record<PixStatus, string> = {
  empty: "File vuoto (0 byte).",
  truncated_header: "Header incompleto: file più corto dell'header analizzato (possibile troncamento).",
  unrecognized_header: "Header non riconosciuto: nessun marker noto trovato.",
  known_markers_in_header: "Marker noti trovati nell'header (GFXA/GFXB/GFXC osservati). Significato dei marker NON verificato.",
};

export function formatPixReport(r: PixCaptureReport): string {
  const L: string[] = [];
  L.push(`# Analisi read-only cattura PIX — ${path.basename(r.file)}`);
  L.push("");
  L.push("**Stato: NON DECODIFICATO.** Nessun PSO, shader, evento o risorsa è stato estratto da questo file.");
  L.push("");
  L.push("## Fatti misurati");
  L.push(`- Percorso: ${r.file}`);
  L.push(`- Dimensione: ${r.sizeBytes} byte (${(r.sizeBytes / MiB).toFixed(2)} MiB)`);
  L.push(`- Esito header: ${STATUS_TEXT[r.status]}`);
  L.push(`- Tag ASCII iniziale (4 byte): ${r.header.leadingTag ?? "non stampabile / assente"}`);
  L.push(
    `- Marker noti nell'header (primi ${r.header.bytesRead} byte): ` +
      (r.header.knownMarkers.length ? r.header.knownMarkers.map((m) => `${m.marker}@0x${m.offset.toString(16)}`).join(", ") : "nessuno"),
  );
  L.push("");
  L.push("```");
  L.push(r.header.hexDump || "(nessun byte)");
  L.push("```");
  L.push(`ASCII: \`${r.header.asciiPreview}\``);
  L.push("");
  L.push("## Scansione a blocchi (letture limitate, file mai caricato per intero)");
  L.push(
    `- Limiti: header ${r.limits.headerBytes} B, blocco ${r.limits.blockBytes} B, scansione massima ${r.limits.maxScanBytes} B`,
  );
  L.push(`- Analizzati: ${r.scan.bytesScanned} B in ${r.scan.blocksRead} blocchi — ${r.scan.complete ? "file completo" : "SCANSIONE PARZIALE"}`);
  if (r.scan.firstBlockEntropyBitsPerByte !== null) {
    const e = r.scan.firstBlockEntropyBitsPerByte;
    L.push(
      `- Entropia primo blocco: ${e.toFixed(3)} bit/byte` +
        (e > 7.5 ? " (valore alto: ipotesi, NON verificata, di dati compressi o cifrati)" : ""),
    );
  }
  L.push("- Occorrenze di pattern byte (NON sono chunk verificati e NON sono shader estratti):");
  for (const h of r.scan.hits) {
    const label = h.kind === "dxbc-pattern" ? `${h.pattern} (magic container D3D, non validato)` : h.pattern;
    L.push(
      `  - ${label}: ${h.count}` +
        (h.offsets.length ? ` — primi offset: ${h.offsets.map((o) => "0x" + o.toString(16)).join(", ")}${h.offsetsTruncated ? ", …" : ""}` : ""),
    );
  }
  L.push("");
  L.push("## pixtool");
  L.push(
    r.pixtool.found
      ? `- Rilevato: ${r.pixtool.path} (non eseguito da questo tool).`
      : "- Non trovato (PIX non installato o PIXTOOL_PATH non impostato): nessuna estrazione possibile da qui.",
  );
  L.push("");
  L.push("## Avvisi");
  for (const w of r.warnings) L.push(`- ${w}`);
  L.push("");
  L.push("## Input successivi consigliati");
  for (const n of r.nextInputs) L.push(`- ${n}`);
  return L.join("\n");
}
