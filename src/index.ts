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
import {
  analyzeDisasm, analyzeFiles, compareShaderSignatures, formatReport,
  parseInputSignature, parseOutputSignature,
} from "./dxil-analyzer.js";
import { convertDxilToHlsl } from "./dxil-precompile.js";
import { registerPixTool } from "./pix-tool.js";
import { registerHelaPipelineTools } from "./hela-mcp-tools.js";

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

// ---------------------------------------------------------------- validate_pair
server.registerTool("validate_pair", {
  title: "Valida una coppia VS/PS",
  description: "Confronta le firme output del vertex shader e input del pixel shader da due file .cso tramite fxc /dumpbin. Verifica semantiche, maschere e tipi.",
  inputSchema: {
    vsCso: z.string().min(1).describe("Percorso del bytecode .cso del vertex shader"),
    psCso: z.string().min(1).describe("Percorso del bytecode .cso del pixel shader"),
  },
}, async ({ vsCso, psCso }) => {
  const [vsDump, psDump] = await Promise.all([
    run(findFxc(), ["/dumpbin", vsCso]),
    run(findFxc(), ["/dumpbin", psCso]),
  ]);
  if (vsDump.missing || psDump.missing)
    return fail(`${vsDump.missing ? vsDump.stderr : psDump.stderr}\nImposta FXC_PATH o installa il Windows SDK.`);
  if (vsDump.code !== 0 || psDump.code !== 0)
    return fail(`fxc /dumpbin fallito:\n${vsDump.code !== 0 ? `${vsCso}:\n${vsDump.stderr || vsDump.stdout}\n` : ""}${psDump.code !== 0 ? `${psCso}:\n${psDump.stderr || psDump.stdout}` : ""}`);

  const vsOutput = parseOutputSignature(`${vsDump.stdout}\n${vsDump.stderr}`);
  const psInput = parseInputSignature(`${psDump.stdout}\n${psDump.stderr}`);
  if (!vsOutput.length || !psInput.length)
    return fail(`Firma ${!vsOutput.length ? "output VS" : "input PS"} non trovata nell'output FXC. Verificare che i file contengano shader compilati validi.`);
  const incomplete = [
    ...vsOutput.filter((element) => element.sysValue.toUpperCase() === "NONE" && (!element.mask || !element.format)).map((element) => `VS ${element.name}${element.index}`),
    ...psInput.filter((element) => element.sysValue.toUpperCase() === "NONE" && (!element.mask || !element.format)).map((element) => `PS ${element.name}${element.index}`),
  ];
  if (incomplete.length)
    return fail(`FXC non ha fornito maschera o tipo per: ${incomplete.join(", ")}.`);

  const comparison = compareShaderSignatures(vsOutput, psInput);
  const verdict = comparison.compatible ? "PASS" : "FAIL";
  const details = comparison.mismatches.length
    ? comparison.mismatches.map((mismatch) => `  - ${mismatch}`).join("\n")
    : "  Tutte le semantiche PS richieste sono presenti e compatibili negli output VS.";
  return ok(`${verdict} — VS ${path.basename(vsCso)} -> PS ${path.basename(psCso)}\nInterfacce verificate: ${comparison.checked}\n${details}`);
});

// ---------------------------------------------------------------- dxil_to_sm5_hlsl
server.registerTool("dxil_to_sm5_hlsl", {
  title: "DXIL (binario) -> HLSL SM5 (candidato)",
  description: "Per shader senza sorgente: DXIL -> SPIR-V (dxil-spirv) -> HLSL 5.0 (spirv-cross) + post-processing (registri duplicati, register space, base instance, semantiche dei vertex input e, se fornita, firma output del VS abbinato per un PS). Il risultato è codice decompilato: va validato con fxc e rivisto. Esegue prima l'analisi e si ferma se trova feature SM6 senza equivalente (a meno di force=true).",
  inputSchema: {
    inputPath: z.string().describe("File .dxil / .cso con payload DXIL"),
    outPath: z.string(),
    disasmPath: z.string().optional().describe("Disassemblato DXC: abilita analisi preliminare e semantiche dei vertex input"),
    vsOutputDisasmPath: z.string().optional().describe("Disassemblato DXC del VS abbinato: per rinominare le semantiche input generate durante la conversione di un PS"),
    bindingMapPath: z.string().optional().describe("JSON {\"t:1:0\": 5, ...} prodotto dal wrapper per i register space"),
    bufferMode: z.enum(["raw", "typed"]).default("raw").describe("raw = ByteAddressBuffer (--ssbo-srv/--ssbo-uav); typed = Buffer<uint4> in stile Vulkan"),
    force: z.boolean().default(false),
    validateProfile: z.string().optional(), entry: z.string().optional().describe("Entry point HLSL, se diverso da quello generato automaticamente dal traduttore"),
  },
}, async ({ inputPath, outPath, disasmPath, vsOutputDisasmPath, bindingMapPath, bufferMode, force, validateProfile, entry }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dxil2sm5-"));
  try {
    const converted = await convertDxilToHlsl({
      inputPath, disasmPath, vsOutputDisasmPath, bindingMapPath, bufferMode, force,
    });
    const { post } = converted;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, converted.hlsl, "utf8");
    let msg = `HLSL SM5 (candidato) scritto: ${outPath}\nPost-processing:\n${post.changes.map((change) => "  - " + change).join("\n") || "  (nessuna modifica)"}`;
    if (post.registerMap.length) msg += "\nMappa binding:\n" + post.registerMap.map((item) => `  ${item.from} -> ${item.to}`).join("\n");
    if (post.entryPoint) msg += `\nEntry point HLSL: ${post.entryPoint}`;
    if (post.warnings.length) msg += "\nAvvisi:\n" + post.warnings.map((warning) => "  - " + warning).join("\n");
    if (converted.notes.length) msg += "\n" + converted.notes.join("\n");
    let validationFailed = false;
    if (validateProfile) {
      if (!PROFILE.test(validateProfile)) return fail("validateProfile non valido.");
      const validationEntry = entry ?? post.entryPoint ?? "main";
      const result = await run(findFxc(), ["/nologo", "/T", validateProfile, "/E", validationEntry, "/Fo", path.join(tmp, "o.cso"), outPath]);
      if (result.missing) {
        validationFailed = true;
        msg += `\n✖ fxc non disponibile: ${result.stderr}`;
      } else if (result.code === 0) {
        msg += `\n✔ Validazione FXC riuscita (${validateProfile}, entry ${validationEntry}). Equivalenza e runtime non verificati.`;
        const diagnostics = (result.stderr || result.stdout).trim();
        if (diagnostics) msg += `\nDiagnostica FXC:\n${diagnostics}`;
      } else {
        validationFailed = true;
        msg += `\n✖ Validazione FXC fallita:\n${result.stderr || result.stdout}`;
      }
    } else msg += "\nNON validato come SM5 finché non passa fxc (usa validateProfile o compile_sm5).";
    return validationFailed ? fail(msg) : ok(msg);
  } catch (error) {
    return fail(String(error));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
registerHelaPipelineTools(server);

await server.connect(new StdioServerTransport());
