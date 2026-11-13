#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze, formatFindings } from "./analyzer.js";
import { convert } from "./converter.js";
import { run, findFxc, dxilSpirvPath, spirvCrossPath } from "./external.js";
import { analyzeFiles, formatReport, parseInputSignature, SigElement } from "./dxil-analyzer.js";
import { postprocessHlsl } from "./hlsl-post.js";
import { registerPixTool } from "./pix-tool.js";

const server = new McpServer({ name: "sm6-to-sm5", version: "0.1.0" });
const ok = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ isError: true, content: [{ type: "text" as const, text: t }] });

const PROFILE = /^(vs|ps|gs|hs|ds|cs)_5_[01]$/;
const DEFAULT_EXT = [".hlsl", ".hlsli", ".fx"];

function load(p?: string, source?: string): string {
  if (source !== undefined) return source;
  if (!p) throw new Error("Specificare 'path' oppure 'source'.");
  return fs.readFileSync(p, "utf8");
}

function walk(dir: string, exts: string[], recursive: boolean): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && recursive && e.name !== "node_modules" && e.name !== ".git") out.push(...walk(full, exts, recursive));
    else if (e.isFile() && exts.includes(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

const fmtMap = (m: { from: string; to: string }[]) =>
  m.length ? "\nMappa binding (da riportare nel codice C++ D3D11):\n" + m.map((x) => `  ${x.from}  ->  ${x.to}`).join("\n") : "";

// ---------------------------------------------------------------- analyze_shader
server.registerTool("analyze_shader", {
  title: "Analizza shader SM6",
  description: "Analizza un file HLSL (o testo) e elenca le feature SM6 incompatibili con SM5/D3D11, distinguendo bloccanti, avvisi e correzioni automatiche.",
  inputSchema: { path: z.string().optional().describe("Percorso del file HLSL"), source: z.string().optional().describe("Codice HLSL inline") },
}, async ({ path: p, source }) => {
  try { return ok(formatFindings(analyze(load(p, source)))); } catch (e) { return fail(String(e)); }
});

// ---------------------------------------------------------------- analyze_directory
server.registerTool("analyze_directory", {
  title: "Analizza cartella di shader",
  description: "Scansiona una cartella di shader HLSL e produce un report di convertibilità per ogni file.",
  inputSchema: {
    dir: z.string(), recursive: z.boolean().default(true),
    extensions: z.array(z.string()).optional().describe("Default: .hlsl .hlsli .fx"),
  },
}, async ({ dir, recursive, extensions }) => {
  try {
    const files = walk(dir, extensions ?? DEFAULT_EXT, recursive);
    let clean = 0, fixable = 0, blocked = 0;
    const lines: string[] = [];
    for (const f of files) {
      const fs_ = analyze(fs.readFileSync(f, "utf8"));
      const b = fs_.filter((x) => x.severity === "blocker");
      if (b.length) { blocked++; lines.push(`✖ ${path.relative(dir, f)}  bloccanti: ${[...new Set(b.map((x) => x.code))].join(",")}`); }
      else if (fs_.some((x) => x.severity !== "info")) { fixable++; lines.push(`⚠ ${path.relative(dir, f)}  convertibile con avvisi`); }
      else clean++;
    }
    return ok(`File analizzati: ${files.length}\nGià compatibili: ${clean} | Auto-convertibili: ${fixable} | Con bloccanti: ${blocked}\n\n${lines.join("\n")}`);
  } catch (e) { return fail(String(e)); }
});

// ---------------------------------------------------------------- convert_shader
server.registerTool("convert_shader", {
  title: "Converti shader HLSL SM6 -> SM5",
  description: "Riscrive un HLSL SM6 in HLSL compatibile SM5.0 (FXC). Applica solo trasformazioni sicure e segnala ciò che resta incompatibile. Se si passa outPath scrive il file.",
  inputSchema: { path: z.string().optional(), source: z.string().optional(), outPath: z.string().optional() },
}, async ({ path: p, source, outPath }) => {
  try {
    const r = convert(load(p, source));
    if (outPath) { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, r.output, "utf8"); }
    const rep =
      `Modifiche applicate:\n${r.changes.length ? r.changes.map((c) => "  - " + c).join("\n") : "  (nessuna)"}` +
      fmtMap(r.registerMap) +
      `\n\nProblemi residui:\n${formatFindings(r.remaining)}` +
      (outPath ? `\n\nFile scritto: ${outPath}` : `\n\n---- HLSL convertito ----\n${r.output}`);
    return ok(rep);
  } catch (e) { return fail(String(e)); }
});

// ---------------------------------------------------------------- convert_directory
server.registerTool("convert_directory", {
  title: "Converti cartella di shader",
  description: "Converte in batch tutti gli shader di una cartella in outDir, mantenendo la struttura. Genera anche binding_map.json con le rimappature dei register.",
  inputSchema: { dir: z.string(), outDir: z.string(), recursive: z.boolean().default(true), extensions: z.array(z.string()).optional() },
}, async ({ dir, outDir, recursive, extensions }) => {
  try {
    const files = walk(dir, extensions ?? DEFAULT_EXT, recursive);
    const maps: Record<string, unknown> = {};
    const lines: string[] = [];
    let done = 0, withIssues = 0;
    for (const f of files) {
      const rel = path.relative(dir, f);
      const r = convert(fs.readFileSync(f, "utf8"));
      const dest = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, r.output, "utf8");
      if (r.registerMap.length) maps[rel] = r.registerMap;
      done++;
      const blockers = r.remaining.filter((x) => x.severity === "blocker");
      if (blockers.length) { withIssues++; lines.push(`✖ ${rel}: ${[...new Set(blockers.map((x) => x.code))].join(",")}`); }
    }
    fs.writeFileSync(path.join(outDir, "binding_map.json"), JSON.stringify(maps, null, 2));
    return ok(`Convertiti ${done} file in ${outDir}\nCon bloccanti residui: ${withIssues}\n${lines.join("\n")}\nMappa binding: ${path.join(outDir, "binding_map.json")}`);
  } catch (e) { return fail(String(e)); }
});

// ---------------------------------------------------------------- compile_sm5
server.registerTool("compile_sm5", {
  title: "Verifica compilazione con FXC (SM5)",
  description: "Compila un HLSL con fxc.exe (Windows SDK) per validare che il risultato sia davvero valido in SM5.0. Restituisce errori/avvisi del compilatore.",
  inputSchema: {
    path: z.string(), profile: z.string().default("ps_5_0").describe("vs_5_0, ps_5_0, cs_5_0, ..."),
    entry: z.string().default("main"), includeDirs: z.array(z.string()).optional(),
    defines: z.array(z.string()).optional().describe("Es. [\"USE_FOO=1\"]"),
    outPath: z.string().optional().describe("Se indicato salva il bytecode DXBC (.cso)"),
  },
}, async ({ path: p, profile, entry, includeDirs, defines, outPath }) => {
  if (!PROFILE.test(profile)) return fail("Profilo non valido. Per D3D11 usare *_5_0 (o *_5_1 solo se necessario).");
  const args = ["/nologo", "/T", profile, "/E", entry];
  includeDirs?.forEach((d) => args.push("/I", d));
  defines?.forEach((d) => args.push("/D", d));
  args.push("/Fo", outPath ?? path.join(os.tmpdir(), `sm5_${Date.now()}.cso`), p);
  const r = await run(findFxc(), args);
  if (r.missing) return fail(`${r.stderr}\nImposta FXC_PATH in .vscode/mcp.json (fxc.exe è nel Windows SDK).`);
  return r.code === 0
    ? ok(`✔ Compilazione riuscita (${profile}).\n${r.stderr || r.stdout}`.trim())
    : fail(`✖ Compilazione fallita:\n${r.stderr || r.stdout}`);
});

// ---------------------------------------------------------------- dxil_to_sm5_hlsl
server.registerTool("dxil_to_sm5_hlsl", {
  title: "DXIL (binario) -> HLSL SM5 (candidato)",
  description: "Per shader senza sorgente: DXIL -> SPIR-V (dxil-spirv) -> HLSL 5.0 (spirv-cross) + post-processing (registri duplicati, register space, base instance, semantiche dei vertex input). Il risultato è codice decompilato: va validato con fxc e rivisto. Esegue prima l'analisi e si ferma se trova feature SM6 senza equivalente (a meno di force=true).",
  inputSchema: {
    inputPath: z.string().describe("File .dxil / .cso con payload DXIL"),
    outPath: z.string(),
    disasmPath: z.string().optional().describe("Disassemblato DXC: abilita analisi preliminare e semantiche dei vertex input"),
    bindingMapPath: z.string().optional().describe("JSON {\"t:1:0\": 5, ...} prodotto dal wrapper per i register space"),
    bufferMode: z.enum(["raw", "typed"]).default("raw").describe("raw = ByteAddressBuffer (--ssbo-srv/--ssbo-uav); typed = Buffer<uint4> in stile Vulkan"),
    force: z.boolean().default(false),
    validateProfile: z.string().optional(), entry: z.string().optional().describe("Entry point HLSL, se diverso da quello generato automaticamente dal traduttore"),
  },
}, async ({ inputPath, outPath, disasmPath, bindingMapPath, bufferMode, force, validateProfile, entry }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dxil2sm5-"));
  const spv = path.join(tmp, "shader.spv");
  const notes: string[] = [];
  let sig: SigElement[] = [];
  let metadata: { stage?: string; numThreads?: string } = {};
  if (disasmPath) {
    const rep = analyzeFiles(inputPath, disasmPath);
    metadata = { stage: rep.stage, numThreads: rep.numThreads };
    sig = parseInputSignature(fs.readFileSync(disasmPath, "utf8"));
    const blockers = rep.findings.filter((f) => f.sev === "blocker");
    if (blockers.length && !force)
      return fail(`Conversione NON tentata: feature SM6 senza equivalente SM5.\n${formatReport(rep, path.basename(inputPath))}\n(force=true per provare comunque; il risultato non sarà valido in D3D11.)`);
    if (blockers.length) notes.push("ATTENZIONE: force=true con bloccanti presenti: l'output non è utilizzabile così com'è.");
  }
  const dxArgs = [inputPath, "--output", spv, ...(bufferMode === "raw" ? ["--ssbo-srv", "--ssbo-uav"] : [])];
  const r1 = await run(dxilSpirvPath(), dxArgs);
  if (r1.missing) return fail(`${r1.stderr}\nInstalla dxil-spirv (github.com/HansKristian-Work/dxil-spirv) e imposta DXIL_SPIRV_PATH.`);
  if (r1.code !== 0) return fail(`dxil-spirv fallito:\n${r1.stderr || r1.stdout}`);
  const rawHlsl = path.join(tmp, "raw.hlsl");
  const scArgs = [spv, "--hlsl", "--shader-model", "50", "--output", rawHlsl];
  for (const e of sig) if (e.sysValue === "NONE" && e.register !== null) scArgs.push("--set-hlsl-vertex-input-semantic", String(e.register), `${e.name}${e.index}`);
  const r2 = await run(spirvCrossPath(), scArgs);
  if (r2.missing) return fail(`${r2.stderr}\nInstalla SPIRV-Cross e imposta SPIRV_CROSS_PATH.`);
  if (r2.code !== 0 || !fs.existsSync(rawHlsl)) return fail(`spirv-cross fallito (tipico per feature non rappresentabili in HLSL SM5, es. immagini 64-bit):\n${r2.stderr || r2.stdout}`);
  const bmap = bindingMapPath ? (JSON.parse(fs.readFileSync(bindingMapPath, "utf8")) as Record<string, number>) : undefined;
  const post = postprocessHlsl(fs.readFileSync(rawHlsl, "utf8"), fs.readFileSync(spv), bmap, metadata);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, post.hlsl, "utf8");
  let msg = `HLSL SM5 (candidato) scritto: ${outPath}\nPost-processing:\n${post.changes.map((c) => "  - " + c).join("\n") || "  (nessuna modifica)"}`;
  if (post.registerMap.length) msg += "\nMappa binding:\n" + post.registerMap.map((x) => `  ${x.from} -> ${x.to}`).join("\n");
  if (post.entryPoint) msg += `\nEntry point HLSL: ${post.entryPoint}`;
  if (post.warnings.length) msg += "\nAvvisi:\n" + post.warnings.map((w) => "  - " + w).join("\n");
  if (notes.length) msg += "\n" + notes.join("\n");
  let validationFailed = false;
  if (validateProfile) {
    if (!PROFILE.test(validateProfile)) return fail("validateProfile non valido.");
    const validationEntry = entry ?? post.entryPoint ?? "main";
    const r3 = await run(findFxc(), ["/nologo", "/T", validateProfile, "/E", validationEntry, "/Fo", path.join(tmp, "o.cso"), outPath]);
    if (r3.missing) {
      validationFailed = true;
      msg += `\n✖ fxc non disponibile: ${r3.stderr}`;
    } else if (r3.code === 0) {
      msg += `\n✔ Validazione FXC riuscita (${validateProfile}, entry ${validationEntry}). Equivalenza e runtime non verificati.`;
      const diagnostics = (r3.stderr || r3.stdout).trim();
      if (diagnostics) msg += `\nDiagnostica FXC:\n${diagnostics}`;
    } else {
      validationFailed = true;
      msg += `\n✖ Validazione FXC fallita:\n${r3.stderr || r3.stdout}`;
    }
  } else msg += "\nNON validato come SM5 finché non passa fxc (usa validateProfile o compile_sm5).";
  return validationFailed ? fail(msg) : ok(msg);
});

// ---------------------------------------------------------------- analyze_dxil
server.registerTool("analyze_dxil", {
  title: "Analizza shader DXIL (binario / disassemblato DXC)",
  description: "Analisi statica di uno shader SM6 compilato: stadio, shader model, binding (cb/t/s/u, register space), operazioni dx.op, feature senza equivalente SM5 (wave, 64-bit, barycentrics, DXR, mesh...) e limiti D3D11. Accetta il .dxil e/o il disassemblato (.dxil.txt da dxc -dumpbin). Non converte e non prova la ricompilazione.",
  inputSchema: {
    dxilPath: z.string().optional().describe("File .dxil (container DXBC con DXIL)"),
    disasmPath: z.string().optional().describe("Disassemblato DXC (.txt)"),
    dir: z.string().optional().describe("Cartella: analizza tutte le coppie *.dxil / *_dxil.txt o *.dxil.txt"),
  },
}, async ({ dxilPath, disasmPath, dir }) => {
  try {
    if (dir) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".dxil")).sort();
      if (!files.length) return fail("Nessun .dxil in " + dir);
      const out: string[] = [];
      for (const f of files) {
        const base = f.replace(/\.dxil$/, "");
        const cand = [base + "_dxil.txt", base + ".dxil.txt"].map((c) => path.join(dir, c)).find((c) => fs.existsSync(c));
        out.push(formatReport(analyzeFiles(path.join(dir, f), cand), f));
      }
      return ok(out.join("\n\n"));
    }
    if (!dxilPath && !disasmPath) return fail("Specificare dxilPath, disasmPath o dir.");
    return ok(formatReport(analyzeFiles(dxilPath, disasmPath), path.basename(dxilPath ?? disasmPath ?? "")));
  } catch (e) { return fail(String(e)); }
});

// ---------------------------------------------------------------- check_toolchain
server.registerTool("check_toolchain", {
  title: "Verifica strumenti esterni",
  description: "Controlla se fxc, dxil-spirv e spirv-cross sono raggiungibili.",
  inputSchema: {},
}, async () => {
  const checks: [string, string, string[]][] = [
    ["fxc", findFxc(), ["/?"]], ["dxil-spirv", dxilSpirvPath(), ["--help"]], ["spirv-cross", spirvCrossPath(), ["--help"]],
  ];
  const lines: string[] = [];
  for (const [n, cmd, a] of checks) { const r = await run(cmd, a, 15_000); lines.push(`${r.missing ? "✖" : "✔"} ${n}  (${cmd})`); }
  return ok(lines.join("\n"));
});

registerPixTool(server);

await server.connect(new StdioServerTransport());
