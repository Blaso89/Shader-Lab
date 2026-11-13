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

function buildPixEventListPrompt(options) {
  return (
    `Chiama il tool MCP \`list_pix_events\` con ${JSON.stringify(options)}. ` +
    "Il valore queueId è il numero nella colonna Queue ID, non Global ID. " +
    "Separa l'etichetta UI dichiarata dall'utente dai dati verificati nella event list; non attribuire all'intera cattura una queue."
  );
}

function buildPixResourcePrompt(options) {
  return (
    `Chiama il tool MCP \`export_pix_draw_resource\` con ${JSON.stringify(options)}. ` +
    "Non eseguire un export se il tool non verifica nella stessa riga che Global ID e Queue ID coincidano e che l'evento sia una draw. " +
    "Distingui la queue label attestata dall'utente e non considerare una corrispondenza di draw signature prova di equivalenza tra GPU o catture."
  );
}

module.exports = { choosePixCapture, buildPixPrompt, buildPixEventListPrompt, buildPixResourcePrompt };
