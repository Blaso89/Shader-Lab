import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findPixTool } from "./pix-capture.js";
import { run, type RunResult } from "./external.js";

export interface PixEventRow {
  globalId: number | null;
  queueId: number | null;
  name: string;
  psoId: number | null;
}

export interface PixEventList {
  path: string;
  eventRows: number;
  rows: PixEventRow[];
  psoIds: number[];
  queueIds: number[];
}

export interface PixEventQuery {
  pixPath: string;
  queueId: number;
  queueLabel?: string;
  contains?: string;
  offset?: number;
  limit?: number;
  eventListPath?: string;
  pixToolPath?: string;
}

export interface PixDrawResourceExport extends PixEventQuery {
  globalId: number;
  outputDir: string;
  rtvIndex?: number;
}

type PixRunner = (command: string, args: string[], timeoutMs?: number) => Promise<RunResult>;

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("Event list non valida: virgolette CSV non bilanciate.");
  cells.push(cell.trim());
  return cells;
}

function parseId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parsePixEventListText(contents: string, filePath = "<memory>"): PixEventList {
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) throw new Error("Event list vuota o priva di righe evento.");

  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const header = parseDelimitedLine(lines[0], delimiter).map((value) => value.toLowerCase());
  const nameIndex = header.findIndex((value) => value === "name");
  if (nameIndex < 0) throw new Error("Event list non riconosciuta: colonna Name mancante.");
  const globalIdIndex = header.findIndex((value) => value === "global id" || value === "global event id");
  const queueIdIndex = header.findIndex((value) => value === "queue id");

  const rows: PixEventRow[] = [];
  const psoIds = new Set<number>();
  const queueIds = new Set<number>();
  for (const line of lines.slice(1)) {
    const columns = parseDelimitedLine(line, delimiter);
    const name = columns[nameIndex] ?? "";
    const psoMatch = name.match(/SetPipelineState.*?obj#(\d+)/i);
    const psoId = psoMatch ? parseId(psoMatch[1]) : null;
    const queueId = queueIdIndex >= 0 ? parseId(columns[queueIdIndex]) : null;
    rows.push({
      globalId: globalIdIndex >= 0 ? parseId(columns[globalIdIndex]) : null,
      queueId,
      name,
      psoId,
    });
    if (queueId !== null) queueIds.add(queueId);
    if (psoId !== null) psoIds.add(psoId);
  }

  return {
    path: filePath,
    eventRows: rows.length,
    rows,
    psoIds: [...psoIds].sort((a, b) => a - b),
    queueIds: [...queueIds].sort((a, b) => a - b),
  };
}

export function readPixEventList(eventListPath: string): PixEventList {
  if (!fs.existsSync(eventListPath) || !fs.statSync(eventListPath).isFile()) {
    throw new Error(`Event list non trovato: ${eventListPath}`);
  }
  return parsePixEventListText(fs.readFileSync(eventListPath, "utf8"), eventListPath);
}

function resolvePixTool(configured?: string): string {
  if (configured) {
    if (!fs.existsSync(configured) || !fs.statSync(configured).isFile()) {
      throw new Error(`pixtool.exe configurato non trovato: ${configured}`);
    }
    return configured;
  }
  const detected = findPixTool();
  if (!detected) throw new Error("pixtool.exe non trovato. Imposta PIXTOOL_PATH o selezionalo in Shader Lab.");
  return detected;
}

function assertCapturePath(pixPath: string): string {
  const resolved = path.resolve(pixPath);
  if (!resolved.toLowerCase().endsWith(".wpix")) throw new Error("pixPath deve indicare un file .wpix.");
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Cattura PIX non trovata: ${resolved}`);
  return resolved;
}

async function exportEventListFile(
  pixPath: string,
  eventListPath: string,
  pixToolPath: string,
  runner: PixRunner,
): Promise<void> {
  const result = await runner(pixToolPath, [
    "--output=verbose",
    "--log=off",
    "open-capture",
    pixPath,
    "save-event-list",
    eventListPath,
  ], 10 * 60 * 1000);
  if (result.code !== 0 || !fs.existsSync(eventListPath)) {
    throw new Error(`Export event list PIX non riuscito (codice ${result.code}): ${(result.stderr || result.stdout).slice(-3000)}`);
  }
}

function filterEvents(events: PixEventList, options: PixEventQuery) {
  if (!events.queueIds.includes(options.queueId)) {
    throw new Error(`Queue ID ${options.queueId} non trovato nella colonna Queue ID dell'event list.`);
  }
  const queueEvents = events.rows.filter((event) => event.queueId === options.queueId);
  const contains = options.contains?.trim().toLowerCase();
  const matches = contains
    ? queueEvents.filter((event) => event.name.toLowerCase().includes(contains))
    : queueEvents;
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  return {
    queueId: options.queueId,
    queueLabel: options.queueLabel ?? null,
    queueLabelSource: options.queueLabel ? "user_supplied" : null,
    queueIdSource: "event_list_queue_id_column",
    eventListSource: options.eventListPath ? "user_exported_event_list" : "pixtool_unfiltered_event_list",
    eventListCaptureBinding: options.eventListPath ? "not_verified" : "exported_from_requested_capture",
    eventListRows: events.eventRows,
    totalMatches: matches.length,
    events: matches.slice(offset, offset + limit).map(({ globalId, queueId, name, psoId }) => ({
      globalId,
      queueId,
      name,
      psoId,
    })),
    offset,
    limit,
  };
}

async function withEventList<T>(
  options: PixEventQuery,
  runner: PixRunner,
  operation: (events: PixEventList) => Promise<T>,
): Promise<T> {
  const pixPath = assertCapturePath(options.pixPath);
  if (options.eventListPath) return operation(readPixEventList(path.resolve(options.eventListPath)));

  const pixToolPath = resolvePixTool(options.pixToolPath);
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "shaderlab-pix-events-"));
  const eventListPath = path.join(workDirectory, "events.csv");
  try {
    await exportEventListFile(pixPath, eventListPath, pixToolPath, runner);
    return await operation(readPixEventList(eventListPath));
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

export async function listPixEvents(options: PixEventQuery, runner: PixRunner = run) {
  if (!Number.isSafeInteger(options.queueId) || options.queueId < 0) {
    throw new Error("queueId deve essere un intero non negativo tratto dalla colonna Queue ID di PIX.");
  }
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset deve essere un intero non negativo.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("limit deve essere compreso tra 1 e 200.");
  return withEventList(options, runner, async (events) => filterEvents(events, options));
}

export async function exportPixDrawResource(options: PixDrawResourceExport, runner: PixRunner = run) {
  if (!Number.isSafeInteger(options.queueId) || options.queueId < 0) {
    throw new Error("queueId deve essere un intero non negativo tratto dalla colonna Queue ID di PIX.");
  }
  if (!Number.isSafeInteger(options.globalId) || options.globalId < 0) {
    throw new Error("globalId deve essere un Global ID intero non negativo.");
  }
  const rtvIndex = options.rtvIndex ?? 0;
  if (!Number.isSafeInteger(rtvIndex) || rtvIndex < 0 || rtvIndex > 7) {
    throw new Error("rtvIndex deve essere compreso tra 0 e 7.");
  }

  return withEventList(options, runner, async (eventList) => {
    const matches = eventList.rows.filter((event) => event.globalId === options.globalId);
    if (matches.length !== 1) {
      throw new Error(`Global ID ${options.globalId}: attesa una sola riga event list, trovate ${matches.length}.`);
    }
    const event = matches[0];
    if (event.queueId === null) {
      throw new Error(`Global ID ${options.globalId}: la colonna Queue ID manca o non è numerica; export annullato.`);
    }
    if (event.queueId !== options.queueId) {
      throw new Error(`Global ID ${options.globalId} ha Queue ID ${event.queueId} (atteso ${options.queueId}); export annullato.`);
    }
    if (!/\bDraw(?:IndexedInstanced|Instanced)?\s*\(/i.test(event.name)) {
      throw new Error(`Global ID ${options.globalId} non è un evento Draw riconosciuto: ${event.name}; export annullato.`);
    }

    const pixPath = assertCapturePath(options.pixPath);
    const pixToolPath = resolvePixTool(options.pixToolPath);
    const outputDir = path.resolve(options.outputDir);
    if (outputDir === pixPath) throw new Error("La cartella output non può essere il file .wpix.");
    const outputPath = path.join(outputDir, `pix-global-${options.globalId}-queue-${options.queueId}-rtv-${rtvIndex}.png`);
    if (fs.existsSync(outputPath)) throw new Error(`Rifiuto di sovrascrivere l'output esistente: ${outputPath}`);
    fs.mkdirSync(outputDir, { recursive: true });

    const result = await runner(pixToolPath, [
      "--output=verbose",
      "--log=off",
      "open-capture",
      pixPath,
      "save-resource",
      outputPath,
      `--global-id=${options.globalId}`,
      `--rtv=${rtvIndex}`,
    ], 10 * 60 * 1000);
    if (result.code !== 0 || !fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error(`Export risorsa PIX non riuscito (codice ${result.code}): ${(result.stderr || result.stdout).slice(-3000)}`);
    }

    return {
      capturePath: pixPath,
      eventListSource: options.eventListPath ? "user_exported_event_list" : "pixtool_unfiltered_event_list",
      eventListCaptureBinding: options.eventListPath ? "not_verified" : "exported_from_requested_capture",
      globalId: options.globalId,
      queueId: event.queueId,
      queueLabel: options.queueLabel ?? null,
      queueLabelSource: options.queueLabel ? "user_pix_ui_attestation" : null,
      eventName: event.name,
      rtvIndex,
      outputPath,
      outputBytes: fs.statSync(outputPath).size,
      eventRowVerified: true,
      queueLabelVerifiedByEventList: false,
      correlationWithExternalRun: "unverified_candidate",
    };
  });
}
