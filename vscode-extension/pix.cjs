"use strict";
// Helper Shader Lab per la vista PIX. I file locali vengono solo selezionati qui;
// la lettura/esportazione è eseguita dal server MCP configurato sul PC dell'utente.

async function choosePixCapture() {
  const vscode = require("vscode"); // lazy: permette di testare buildPixPrompt fuori da VS Code
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Seleziona cattura",
    title: "Seleziona cattura PIX .wpix",
    filters: { "PIX GPU capture": ["wpix"], "Tutti i file": ["*"] },
  });
  return picked && picked[0] ? picked[0].fsPath : undefined;
}

function buildPixPrompt(file, options = {}) {
  const args = { ...options, pixPath: file };
  if (args.mode === "full") {
    return (
      `Chiama il tool MCP \`analyze_pix_capture\` con ${JSON.stringify(args)}. ` +
      "Esegui l'analisi completa localmente: non caricare la cattura o gli shader nel prompt. " +
      "Riporta i conteggi restituiti e i percorsi degli artefatti, distinguendo dati estratti da risultati di analisi statica. " +
      "Non dichiarare equivalenza visiva o compatibilità runtime D3D11; segnala eventuali export o disassemblati falliti e i limiti di verifica della queue."
    );
  }
  return (
    `Chiama il tool MCP \`analyze_pix_capture\` con ${JSON.stringify(args)}. ` +
    "Riporta solo ciò che il tool ha misurato (dimensione, header, marker, pattern byte, limiti di scansione). " +
    "Non dichiarare PSO, shader, eventi o risorse estratti se il tool dice 'NON DECODIFICATO'. " +
    "Separa fatti e ipotesi, e indica gli input successivi: CSV/event export PIX oppure singoli DXIL/disassemblati da analizzare con `analyze_dxil`."
  );
}

module.exports = { choosePixCapture, buildPixPrompt };
