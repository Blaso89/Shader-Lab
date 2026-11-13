import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as path from "node:path";
import { analyzePixCapture, formatPixReport, DEFAULT_LIMITS, HARD_LIMITS } from "./pix-capture.js";
import { analyzePixDeep } from "./pix-analysis.js";

/**
 * Registra il tool MCP `analyze_pix_capture`.
 * Uso in src/index.ts (dopo gli altri registerTool, prima di server.connect):
 *   import { registerPixTool } from "./pix-tool.js";
 *   registerPixTool(server);
 */
export function registerPixTool(server: McpServer): void {
  server.registerTool("analyze_pix_capture", {
    title: "Analizza cattura PIX .wpix",
    description:
      "Unico ingresso per PIX: mode=scan fa un'ispezione statica read-only limitata del .wpix; mode=full usa pixtool per esportare " +
      "il progetto C++, estrae i container shader DXIL dai resources.bin, disassembla con DXC, correla gli ID PSO con un event list " +
      "facoltativo e salva report/manifest/shader nella cartella scelta. Il .wpix non viene modificato; mode=full può eseguire il replay " +
      "PIX e scrive file di output. Non compila né esegue il C++ generato. Event list e nome queue sono input locali, non verificabili " +
      "autonomamente se il file non contiene il nome della queue.",
    inputSchema: {
      pixPath: z.string().describe("Percorso locale del file .wpix; scan legge a blocchi, full lo passa a pixtool"),
      mode: z.enum(["scan", "full"]).default("scan")
        .describe("scan = sola lettura statica; full = export PIX locale, estrazione PSO/shader e analisi DXC"),
      outputDir: z.string().optional().describe("Cartella locale per report, manifest, event list e shader estratti (obbligatoria in mode=full)"),
      eventListPath: z.string().optional().describe("Event list CSV/TSV già esportato da PIX; per attribuire una queue, fornisci l'export relativo"),
      queueName: z.string().optional().describe("Etichetta queue scelta dall'utente; il tool non può verificarla se l'event list non la include"),
      pixExportDir: z.string().optional().describe("Cartella di un export C++ PIX già esistente; se omessa il tool prova export-to-cpp"),
      pixToolPath: z.string().optional().describe("Override locale di pixtool.exe; altrimenti autodetect o PIXTOOL_PATH"),
      dxcPath: z.string().optional().describe("Override locale di dxc.exe; altrimenti autodetect o DXC_PATH"),
      powerShellPath: z.string().optional().describe("Override locale di powershell.exe; altrimenti autodetect o POWERSHELL_PATH"),
      headerBytes: z.number().int().min(HARD_LIMITS.minHeaderBytes).max(HARD_LIMITS.maxHeaderBytes).optional()
        .describe(`Byte di header da mostrare (default ${DEFAULT_LIMITS.headerBytes})`),
      blockBytes: z.number().int().min(HARD_LIMITS.minBlockBytes).max(HARD_LIMITS.maxBlockBytes).optional()
        .describe(`Dimensione blocco di lettura (default ${DEFAULT_LIMITS.blockBytes})`),
      maxScanBytes: z.number().int().min(1).max(HARD_LIMITS.maxScanBytes).optional()
        .describe(`Byte massimi scansionati dall'inizio (default ${DEFAULT_LIMITS.maxScanBytes}, massimo ${HARD_LIMITS.maxScanBytes})`),
    },
  }, async ({ pixPath, mode, outputDir, eventListPath, queueName, pixExportDir, pixToolPath, dxcPath, powerShellPath, headerBytes, blockBytes, maxScanBytes }) => {
    try {
      if (mode === "full") {
        if (!outputDir?.trim()) return { isError: true, content: [{ type: "text" as const, text: "mode=full richiede outputDir." }] };
        const report = await analyzePixDeep({
          pixPath: path.resolve(pixPath),
          outputDir: path.resolve(outputDir),
          eventListPath: eventListPath ? path.resolve(eventListPath) : undefined,
          queueName,
          pixExportDir: pixExportDir ? path.resolve(pixExportDir) : undefined,
          pixToolPath,
          dxcPath,
          powerShellPath,
        });
        const findings = Object.entries(report.findings)
          .map(([code, value]) => `${code}: ${value.shaders} shader (${value.severity})`)
          .join(", ") || "nessun finding statico";
        const text =
          `Analisi PIX completa terminata.\n` +
          `PSO: ${report.psoCount} | payload shader: ${report.shaderPayloadCount} | container unici: ${report.uniqueShaderCount}\n` +
          `Disassemblati DXC: ${report.disassembledCount}/${report.uniqueShaderCount}\n` +
          `Eventi: ${report.eventList?.eventRows ?? "non disponibili"} | PSO citati: ${report.eventList?.psoIds.length ?? "non disponibili"}\n` +
          `Finding: ${findings}\n` +
          `Report: ${report.artifacts.reportMarkdown}\nManifest: ${report.artifacts.shaderMapCsv}\nShader: ${report.artifacts.shadersDirectory}` +
          (report.eventExportWarning ? `\nAvviso event list: ${report.eventExportWarning}` : "") +
          (report.unmatchedEventPsoIds.length ? `\nPSO evento non estratti: ${report.unmatchedEventPsoIds.join(", ")}` : "");
        return { content: [{ type: "text" as const, text }] };
      }

      const report = await analyzePixCapture(path.resolve(pixPath), { headerBytes, blockBytes, maxScanBytes });
      return {
        content: [
          { type: "text" as const, text: formatPixReport(report) },
          { type: "text" as const, text: "```json\n" + JSON.stringify(report, null, 2) + "\n```" },
        ],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: "analyze_pix_capture: " + String(e) }] };
    }
  });
}
