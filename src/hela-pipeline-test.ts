import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fnv1a64 } from "./dxil-precompile.js";
import { analyzeBmpBuffer } from "./hela-bmp.js";
import {
  parseHelaProxyLog,
  TARGET_INPUT_LAYOUT_DIAGNOSTIC_VS,
} from "./hela-log-parser.js";
import { registerHelaPipelineTools } from "./hela-mcp-tools.js";
import {
  buildHelaOverrideStage,
  computeLaunchEnvironmentSha256,
  planHelaManifestPatch,
  readAndValidateManifest,
  sha256Buffer,
  verifyHelaRun,
  type HelaRunManifestV1,
} from "./hela-pipeline.js";

/** Costruisce un container DXBC minimo con chunk DXIL o SHEX per test offline. */
function makeFakeContainer(kind: "dxil" | "legacy", progTypeCode: number, seed: number): Buffer {
  const fourcc = kind === "dxil" ? "DXIL" : "SHEX";
  const payload = Buffer.alloc(16);
  const ver = ((progTypeCode & 0xffff) << 16) | (kind === "dxil" ? 0x67 : 0x50);
  payload.writeUInt32LE(ver >>> 0, 0);
  payload.writeUInt32LE(seed >>> 0, 4);

  const headerSize = 32 + 4;
  const buf = Buffer.alloc(headerSize + 8 + payload.length);
  buf.write("DXBC", 0, 4, "ascii");
  buf.writeUInt32LE(1, 28);
  buf.writeUInt32LE(headerSize, 32);
  buf.write(fourcc, headerSize, 4, "ascii");
  buf.writeUInt32LE(payload.length, headerSize + 4);
  payload.copy(buf, headerSize + 8);
  return buf;
}

/** Costruisce un BMP 24-bit BI_RGB (top-down se topDown=true, come SaveMappedTextureAsBmp in dxgi_proxy.cpp). */
function makeBmp24(width: number, height: number, setNonBlackPixel = false, topDown = true): Buffer {
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const buf = Buffer.alloc(54 + pixelBytes);
  buf.write("BM", 0, 2, "ascii");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(topDown ? -height : height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  if (setNonBlackPixel) {
    buf[54] = 0x10; // B
    buf[55] = 0x80; // G
    buf[56] = 0xf0; // R
  }
  return buf;
}

export async function runHelaPipelineTests(): Promise<void> {
  // 1. Verifica bit-a-bit dello SHA-256 del launchProfile v1.1.2 (ProxyManager.ps1)
  const v112Env: Record<string, string> = {
    D3D12ON11_DIAGNOSTIC_MASK_NVIDIA: "1",
    D3D12ON11_MASK_VENDOR_ID: "ffff",
    D3D12ON11_DIAGNOSTIC_CAPABILITIES: "1",
    D3D12ON11_TILED_RESOURCES_TIER: "3",
    D3D12ON11_SHADER_MODEL: "6_7",
    D3D12ON11_TRACE_CALLERS: "0",
    D3D12ON11_DIAGNOSTIC_RENDER_TRACE: "1",
    D3D12ON11_DUMP_SHADERS: "0",
    D3D12ON11_OVERRIDES: "@RUN_OVERRIDES@",
    D3D12ON11_DUMP: "@RUN_DUMP@",
  };
  assert.equal(
    computeLaunchEnvironmentSha256(v112Env),
    "02dd14ff52bdd38b68589091c4eaa07908d22d488e6a43499ba1a95738499e1d",
    "computeLaunchEnvironmentSha256 deve coincidere con ProxyManager.ps1 su v1.1.2",
  );

  // 2. Verifica BMP top-down (biHeight negativo come dxgi_proxy.cpp) e bottom-up
  const blackTopDown = analyzeBmpBuffer(makeBmp24(16, 8, false, true), "topdown-black.bmp");
  assert.equal(blackTopDown.valid, true);
  assert.equal(blackTopDown.orientation, "top-down");
  assert.equal(blackTopDown.totalPixels, 128);
  assert.equal(blackTopDown.nonBlackPixels, 0);

  const litBottomUp = analyzeBmpBuffer(makeBmp24(16, 8, true, false), "bottomup-lit.bmp");
  assert.equal(litBottomUp.valid, true);
  assert.equal(litBottomUp.orientation, "bottom-up");
  assert.equal(litBottomUp.nonBlackPixels, 1);
  assert.equal(litBottomUp.maxChannelValue, 0xf0);
  const bitfieldsBmp = makeBmp24(16, 8);
  bitfieldsBmp.writeUInt32LE(3, 30);
  assert.equal(analyzeBmpBuffer(bitfieldsBmp).valid, false, "non interpretare maschere BI_BITFIELDS come BGR");

  // 3. Verifica registrazione pulita dei 4 tool MCP su McpServer
  const mcpServer = new McpServer({ name: "test-hela-bridge", version: "0.1.0" });
  registerHelaPipelineTools(mcpServer);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shader-lab-hela-v2-test-"));
  try {
    // 4. Parser allineato ai formati reali C++ (pipeline.cpp, util.cpp, commands.cpp, dxgi_proxy.cpp)
    const vsA = makeFakeContainer("dxil", 1, 101);
    const vsB = makeFakeContainer("dxil", 1, 102);
    const vsBadOut = makeFakeContainer("dxil", 1, 104);
    const vsMissing = makeFakeContainer("dxil", 1, 103);
    const psSharedCompat = makeFakeContainer("dxil", 0, 201);
    const psSharedIncomplete = makeFakeContainer("dxil", 0, 202);
    const psSharedConflict = makeFakeContainer("dxil", 0, 203);
    const csWave = makeFakeContainer("dxil", 5, 301);

    const vsAHash = fnv1a64(vsA);
    const vsBHash = fnv1a64(vsB);
    const vsBadOutHash = fnv1a64(vsBadOut);
    const vsMissingHash = fnv1a64(vsMissing);
    const psCompatHash = fnv1a64(psSharedCompat);
    const psIncompleteHash = fnv1a64(psSharedIncomplete);
    const psConflictHash = fnv1a64(psSharedConflict);
    const csWaveHash = fnv1a64(csWave);

    const realisticLog = [
      "[12:00:00.001] [tid=100] MODULE_FINGERPRINT role=d3d12 path=C:\\Hela\\d3d12.dll bytes=500000 sha256=14dfba07e9a37b1c8adbc7fe11de6ba14ee0ab3968e953b85a097d32dbf69e98",
      "[12:00:00.002] [tid=100] MODULE_FINGERPRINT role=dxgi_proxy path=C:\\Hela\\dxgi.dll bytes=200000 sha256=09d13c05bf198c74b4190a9cb1be1c96966a0ece7641d8621c08a00465e0f857",
      "[12:00:00.010] [tid=100] DIAGNOSTIC_MASK_NVIDIA: native-vendor=0x10de device=0x1c8c exposed-vendor=0xffff luid=00000000:00010000",
      "[12:00:00.011] [tid=100] D3D12CreateDevice adapter source=proxy-unwrap",
      "[12:00:00.012] [tid=100] CheckFeatureSupport end feature=D3D12_OPTIONS tiled-tier=3",
      "[12:00:00.013] [tid=100] Config caller-trace=0",
      `[12:00:01.000] [tid=100] SHADER BEGIN stage=VS hash=${TARGET_INPUT_LAYOUT_DIAGNOSTIC_VS} bytes=1024 DXBC=1 DXIL=1 legacy=0 model=6_7 RTS0=1`,
      `[12:00:01.001] [tid=100] [TARGET_INPUT_LAYOUT] element=0 semantic=ATTRIBUTE semantic_index=0 slot=0 format=2 offset=0 classification=0 step_rate=0`,
      `[12:00:01.100] [tid=100] SHADER BEGIN stage=VS hash=${vsAHash} bytes=${vsA.length} DXBC=1 DXIL=1 legacy=0 model=6_7 RTS0=1`,
      `[12:00:01.101] [tid=100] SHADER PLACEHOLDER stage=VS hash=${vsAHash} reason=no-usable-SM5-bytecode DXBC=1 DXIL=1 action=provide-sm5-override overrides=o\\${vsAHash}.cso`,
      `[12:00:01.102] [tid=100] SHADER BEGIN stage=VS hash=${vsBHash} bytes=${vsB.length} DXBC=1 DXIL=1 legacy=0 model=6_7 RTS0=1`,
      `[12:00:01.103] [tid=100] SHADER PLACEHOLDER stage=VS hash=${vsBHash} reason=no-usable-SM5-bytecode DXBC=1 DXIL=1 action=provide-sm5-override overrides=o\\${vsBHash}.cso`,
      `[12:00:01.103] [tid=100] SHADER BEGIN stage=VS hash=${vsBadOutHash} bytes=${vsBadOut.length} DXBC=1 DXIL=1 legacy=0 model=6_7 RTS0=1`,
      `[12:00:01.103] [tid=100] SHADER PLACEHOLDER stage=VS hash=${vsBadOutHash} reason=no-usable-SM5-bytecode DXBC=1 DXIL=1 action=provide-sm5-override overrides=o\\${vsBadOutHash}.cso`,
      `[12:00:01.104] [tid=100] SHADER BEGIN stage=PS hash=${psCompatHash} bytes=${psSharedCompat.length} DXBC=1 DXIL=1 legacy=0 model=6_7 RTS0=1`,
      `[12:00:01.105] [tid=100] SHADER PLACEHOLDER stage=PS hash=${psCompatHash} reason=no-usable-SM5-bytecode DXBC=1 DXIL=1 action=provide-sm5-override overrides=o\\${psCompatHash}.cso`,
      `[12:00:01.106] [tid=100] SHADER BEGIN stage=PS hash=${psIncompleteHash} bytes=${psSharedIncomplete.length} DXBC=1 DXIL=1 legacy=0 model=6_7 RTS0=1`,
      `[12:00:01.107] [tid=100] SHADER PLACEHOLDER stage=PS hash=${psIncompleteHash} reason=no-usable-SM5-bytecode DXBC=1 DXIL=1 action=provide-sm5-override overrides=o\\${psIncompleteHash}.cso`,
      `[12:00:01.108] [tid=100] SHADER BEGIN stage=PS hash=${psConflictHash} bytes=${psSharedConflict.length} DXBC=1 DXIL=1 legacy=0 model=6_7 RTS0=1`,
      `[12:00:01.109] [tid=100] SHADER PLACEHOLDER stage=PS hash=${psConflictHash} reason=no-usable-SM5-bytecode DXBC=1 DXIL=1 action=provide-sm5-override overrides=o\\${psConflictHash}.cso`,
      `[12:00:01.110] [tid=100] SHADER BEGIN stage=CS hash=${csWaveHash} bytes=${csWave.length} DXBC=1 DXIL=1 legacy=0 model=6_7 RTS0=1`,
      `[12:00:01.111] [tid=100] SHADER PLACEHOLDER stage=CS hash=${csWaveHash} reason=no-usable-SM5-bytecode DXBC=1 DXIL=1 action=provide-sm5-override overrides=o\\${csWaveHash}.cso`,
      // PSO GRAPHICS: psCompatHash condiviso da vsA + vsB (firme compatibili)
      `[12:00:02.001] [tid=100] PSO GRAPHICS #1 READY status=placeholder-missing-sm5-override pso=00000100 missing_mask=0x03 VS=${vsAHash}/${vsA.length} PS=${psCompatHash}/${psSharedCompat.length} GS=0000000000000000/0 HS=0000000000000000/0 DS=0000000000000000/0 d11_vs=0 d11_ps=0 d11_il=0`,
      `[12:00:02.002] [tid=100] PSO GRAPHICS #2 READY status=placeholder-missing-sm5-override pso=00000200 missing_mask=0x03 VS=${vsBHash}/${vsB.length} PS=${psCompatHash}/${psSharedCompat.length} GS=0000000000000000/0 HS=0000000000000000/0 DS=0000000000000000/0 d11_vs=0 d11_ps=0 d11_il=0`,
      // psIncompleteHash condiviso da vsA (presente) + vsMissingHash (assente nel dump!)
      `[12:00:02.003] [tid=100] PSO GRAPHICS #3 READY status=placeholder-missing-sm5-override pso=00000300 missing_mask=0x03 VS=${vsAHash}/${vsA.length} PS=${psIncompleteHash}/${psSharedIncomplete.length} GS=0000000000000000/0 HS=0000000000000000/0 DS=0000000000000000/0 d11_vs=0 d11_ps=0 d11_il=0`,
      `[12:00:02.004] [tid=100] PSO GRAPHICS #4 READY status=placeholder-missing-sm5-override pso=00000400 missing_mask=0x03 VS=${vsMissingHash}/${vsMissing.length} PS=${psIncompleteHash}/${psSharedIncomplete.length} GS=0000000000000000/0 HS=0000000000000000/0 DS=0000000000000000/0 d11_vs=0 d11_ps=0 d11_il=0`,
      // psConflictHash condiviso da vsA (COLOR0) + vsBadOut (TEXCOORD0) -> conflitto firme multi-VS!
      `[12:00:02.005] [tid=100] PSO GRAPHICS #5 READY status=placeholder-missing-sm5-override pso=00000500 missing_mask=0x03 VS=${vsAHash}/${vsA.length} PS=${psConflictHash}/${psSharedConflict.length} GS=0000000000000000/0 HS=0000000000000000/0 DS=0000000000000000/0 d11_vs=0 d11_ps=0 d11_il=0`,
      `[12:00:02.006] [tid=100] PSO GRAPHICS #6 READY status=placeholder-missing-sm5-override pso=00000600 missing_mask=0x03 VS=${vsBadOutHash}/${vsBadOut.length} PS=${psConflictHash}/${psSharedConflict.length} GS=0000000000000000/0 HS=0000000000000000/0 DS=0000000000000000/0 d11_vs=0 d11_ps=0 d11_il=0`,
      // Campi REALI di util.cpp: draw_commands, rtv_is_backbuffer, dispatch_commands
      `[12:00:03.000] [tid=101] [RENDER_TRACE] [HEARTBEAT] tid=101 up=3000ms last-api=Present(tid=100,ago=5ms) exec=50 sig=50 wait=50 wctx=10(fail=0,max-spin=0) swap=1 present=1400 pso(G=4,C=1,last=0000000000000000) draw(ok=12,rtv=12,bb=0,nullrtv=0,skip-pso=0,skip-vs=0,skip-other=0,skip-vb=0,skip-ib=0,skip-map=0,missing-vb=0,missing-ib=0) disp(ok=0,skip-pso=0,skip-cs=15) placed(ok=0,ovl=0,rel=0,live=0)`,
      `[12:00:03.001] [tid=101] [SHADER_USE_SUMMARY] window=since_previous_heartbeat present_calls_process_wide=1400 draw_commands=52 dispatch_commands=15 groups=2 omitted_groups=0 omitted_draw_commands=0 omitted_dispatch_commands=0 overflow_draw_commands=0 overflow_dispatch_commands=0`,
      `[12:00:03.002] [tid=101] [DRAW_SHADER_USE] outcome=executed vs=20e0826b236597a1 ps=44b0a992c2304254 gs=0000000000000000 hs=0000000000000000 ds=0000000000000000 missing_mask=0x00 graphics_pso_bound=1 rtv_is_backbuffer=1 draw_commands=40 first_observed_present_count_process_wide=100 last_observed_present_count_process_wide=1400`,
      `[12:00:03.003] [tid=101] [DRAW_SHADER_USE] outcome=skipped vs=${vsAHash} ps=${psCompatHash} gs=0000000000000000 hs=0000000000000000 ds=0000000000000000 missing_mask=0x03 graphics_pso_bound=1 rtv_is_backbuffer=0 draw_commands=12 first_observed_present_count_process_wide=1200 last_observed_present_count_process_wide=1400`,
      `[12:00:03.004] [tid=101] [COMPUTE_SHADER_USE] outcome=skipped cs=${csWaveHash} missing_mask=0x20 dispatch_commands=15 first_observed_present_count_process_wide=10 last_observed_present_count_process_wide=1400`,
      // Campi REALI di commands.cpp e dxgi_proxy.cpp
      `[12:00:03.100] [tid=100] [TARGET_DRAW_COPY] draw_index=88 api=DrawIndexedInstanced rtv_slot=0 tracked_rtv_resource=000001A000002000 vs=20e0826b236597a1 ps=44b0a992c2304254 latest_copy_sequence_at_draw=6 latest_copy_source_at_draw=000001A000002000`,
      `[12:00:03.110] [tid=100] [COPY_TO_BB] CopyResource source=000001A000009000 source_texture=000001A000002000 dimension=3 width=1280 height=720 format=87 sequence=7`,
      `[12:00:03.120] [tid=100] [BB_SOURCE_HISTORY_SNAPSHOT] present=1400 resources=1`,
      `[12:00:03.121] [tid=100] [BB_SOURCE_HISTORY] Resource 000001A000002000 operations=1 draws=1 skipped=0 clears=0`,
      `[12:00:03.122] [tid=100] [BB_SOURCE_HISTORY]   Draw #88 api=DrawIndexedInstanced indexed=1 rtv_slot=0 pso=00000500 vs_hash=20e0826b236597a1 ps_hash=44b0a992c2304254 elements=6 instances=1 viewport=0,0,1280x720`,
      `[12:00:03.130] [tid=100] [READBACK_IDENTITY] readback_present_count=1400 buffer_index=0 native_backbuffer=000001A000001000 width=1280 height=720 format=87 copy_sequence=7 copy_source=000001A000002000`,
      `[12:00:03.131] [tid=100] [READBACK_SRC] Present #1400 size=1280x720 format=87 buffer=0`,
      `[12:00:03.132] [tid=100] [READBACK_SRC]   Non-black pixels: 0/100 (0.0%)`,
    ].join("\n");

    const parsed = parseHelaProxyLog(realisticLog);
    assert.equal(parsed.attestation.maskedNvidiaAdapter, true);
    assert.equal(parsed.attestation.tiledResourcesTier, 3);
    assert.equal(parsed.attestation.callerTrace, false);
    assert.equal(parsed.presentProgress.maxObservedPresent, 1400);
    assert.equal(parsed.drawShaderUse.length, 2);
    assert.equal(parsed.drawShaderUse[0].drawCommands, 40);
    assert.equal(parsed.drawShaderUse[0].rtvIsBackbuffer, true);
    assert.equal(parsed.computeShaderUse.length, 1);
    assert.equal(parsed.computeShaderUse[0].dispatchCommands, 15);
    assert.equal(parsed.executedGraphicsPairs.length, 1);
    assert.equal(parsed.executedGraphicsPairs[0].vsHash, "20e0826b236597a1");
    assert.equal(parsed.targetInputLayoutCoverage.scope, "diagnostic-vs-20e0826b236597a1-only");
    assert.equal(parsed.targetInputLayoutCoverage.elements.length, 1);
    assert.equal(parsed.readbackIdentities.length, 1);
    assert.equal(parsed.readbackIdentities[0].readbackPresentCount, 1400);
    assert.equal(parsed.readbackIdentities[0].copySequence, 7);
    assert.equal(parsed.readbackIdentities[0].copySource, "0x000001a000002000");
    assert.equal(parsed.targetDrawCopies.length, 1);
    assert.equal(parsed.targetDrawCopies[0].latestCopySequenceAtDraw, 6);
    assert.equal(parsed.readbackCorrelations.length, 1);
    assert.equal(parsed.readbackCorrelations[0].status, "candidate-only-not-proven");
    assert.equal(parsed.readbackCorrelations[0].causalProofEstablished, false, "non simulare prova causale non dimostrata");
    assert.deepEqual(parsed.readbackCorrelations[0].candidateDrawIndices, [88]);
    assert.equal(parsed.readbackCorrelations[0].matchedCopyToBbSequence, true);
    assert.equal(parsed.sampledReadbacks.length, 1);
    assert.equal(parsed.sampledReadbacks[0].nonBlackSamples, 0);

    // 5. Pipeline PSO-aware: distingue PS condiviso compatibile vs PS con VS mancante (pair-incomplete!) vs Wave blocked
    const dumpDir = path.join(tmp, "dump");
    const baselineDir = path.join(tmp, "baseline-profile");
    const baselineOverridesDir = path.join(baselineDir, "overrides");
    const stagingDir = path.join(tmp, "staging-v2");
    fs.mkdirSync(dumpDir, { recursive: true });
    fs.mkdirSync(baselineOverridesDir, { recursive: true });

    // Nel dump mettiamo vsA, vsB, vsBadOut, psSharedCompat, psSharedIncomplete, psSharedConflict, csWave — MA NON vsMissing!
    fs.writeFileSync(path.join(dumpDir, `${vsAHash}.dxil`), vsA);
    fs.writeFileSync(path.join(dumpDir, `${vsBHash}.dxil`), vsB);
    fs.writeFileSync(path.join(dumpDir, `${vsBadOutHash}.dxil`), vsBadOut);
    fs.writeFileSync(path.join(dumpDir, `${psCompatHash}.dxil`), psSharedCompat);
    fs.writeFileSync(path.join(dumpDir, `${psIncompleteHash}.dxil`), psSharedIncomplete);
    fs.writeFileSync(path.join(dumpDir, `${psConflictHash}.dxil`), psSharedConflict);
    fs.writeFileSync(path.join(dumpDir, `${csWaveHash}.dxil`), csWave);

    const logPath = path.join(tmp, "d3d12on11.log");
    fs.writeFileSync(logPath, realisticLog, "utf8");

    // Baseline manifest con 1 override esistente che DEVE essere preservato intatto
    const baselineCsoBytes = makeFakeContainer("legacy", 1, 777);
    const baselineCsoName = "20e0826b236597a1.cso";
    const baselineCsoSha = sha256Buffer(baselineCsoBytes);
    fs.writeFileSync(path.join(baselineOverridesDir, baselineCsoName), baselineCsoBytes);

    const baselineManifest: HelaRunManifestV1 = {
      schema: "hela-run-manifest/v1",
      runtimeAttestation: "module-and-shader-sha256",
      testVersion: "1050ti-pre-menu-v1.1.2-historical-env",
      runtime: {
        d3d12: "14dfba07e9a37b1c8adbc7fe11de6ba14ee0ab3968e953b85a097d32dbf69e98",
        dxgi: "09d13c05bf198c74b4190a9cb1be1c96966a0ece7641d8621c08a00465e0f857",
      },
      overrides: { [baselineCsoName]: baselineCsoSha },
      requiredOverrides: [baselineCsoName],
      launchProfile: {
        name: "1050ti-pre-menu-historical-20261117-v1",
        sha256: "02dd14ff52bdd38b68589091c4eaa07908d22d488e6a43499ba1a95738499e1d",
        environment: { ...v112Env },
        arguments: ["-graphicsadapter=0", "-windowed", "-ResX=1280", "-ResY=720"],
        attestation: { maskedNvidiaAdapter: true, tiledResourcesTier: 3, callerTrace: false },
      },
    };
    const baselineManifestPath = path.join(baselineDir, "run-manifest.json");
    fs.writeFileSync(
      baselineManifestPath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(JSON.stringify(baselineManifest, null, 2), "utf8"),
      ]),
    );
    assert.equal(
      readAndValidateManifest(baselineManifestPath).testVersion,
      baselineManifest.testVersion,
      "i manifest UTF-8 con BOM generati da PowerShell devono essere leggibili",
    );
    const invalidProfileManifestPath = path.join(tmp, "invalid-profile-manifest.json");
    fs.writeFileSync(
      invalidProfileManifestPath,
      JSON.stringify({
        ...baselineManifest,
        launchProfile: { ...baselineManifest.launchProfile, sha256: "0".repeat(64) },
      }),
    );
    assert.throws(
      () => readAndValidateManifest(invalidProfileManifestPath),
      /launchProfile fingerprint mismatch/,
    );

    await assert.rejects(
      () =>
        buildHelaOverrideStage(
          {
            dumpDir,
            stagingDir: path.join(tmp, "missing-baseline-overrides-stage"),
            baselineManifestPath,
            autoDisassemble: false,
          },
          { fxcPath: () => "unused", dxcPath: () => "unused" },
        ),
      /baselineOverridesDir è obbligatoria/,
    );

    const vsCompatDisasm = [
      "; Input signature:",
      "; Name                 Index   Mask Register SysValue  Format   Used",
      "; -------------------- ----- ------ -------- -------- ------- ------",
      "; ATTRIBUTE                0   xyzw        0     NONE   float   xyzw",
      "; Output signature:",
      "; Name                 Index   Mask Register SysValue  Format   Used",
      "; -------------------- ----- ------ -------- -------- ------- ------",
      "; SV_Position              0   xyzw        0      POS   float   xyzw",
      "; COLOR                    0   xyzw        1     NONE   float   xyzw",
      "; EntryFunctionName: MainVS",
      '!0 = !{!"vs", i32 6, i32 7}',
    ].join("\n");

    const psCompatDisasm = [
      "; Input signature:",
      "; Name                 Index   Mask Register SysValue  Format   Used",
      "; -------------------- ----- ------ -------- -------- ------- ------",
      "; SV_Position              0   xyzw        0      POS   float   xyzw",
      "; COLOR                    0   xyzw        1     NONE   float   xyzw",
      "; EntryFunctionName: MainPS",
      '!0 = !{!"ps", i32 6, i32 7}',
    ].join("\n");

    const csWaveDisasm = [
      "; Note: shader requires additional functionality:",
      ";       Wave level operations",
      "; NumThreads=(64,1,1)",
      "; EntryFunctionName: MainCS",
      '!0 = !{!"cs", i32 6, i32 7}',
      "  %1 = call i32 @dx.op.waveActiveOp.i32(i32 119, i32 %x, i8 0, i8 0)",
    ].join("\n");

    const vsBadOutDisasm = [
      "; Input signature:",
      "; Name                 Index   Mask Register SysValue  Format   Used",
      "; -------------------- ----- ------ -------- -------- ------- ------",
      "; ATTRIBUTE                0   xyzw        0     NONE   float   xyzw",
      "; Output signature:",
      "; Name                 Index   Mask Register SysValue  Format   Used",
      "; -------------------- ----- ------ -------- -------- ------- ------",
      "; SV_Position              0   xyzw        0      POS   float   xyzw",
      "; TEXCOORD                 0   xy          1     NONE   float   xy  ",
      "; EntryFunctionName: MainVSBad",
      '!0 = !{!"vs", i32 6, i32 7}',
    ].join("\n");

    const legacyVsA = makeFakeContainer("legacy", 1, 901);
    const legacyVsB = makeFakeContainer("legacy", 1, 902);
    const legacyVsBadOut = makeFakeContainer("legacy", 1, 905);
    const legacyPsCompat = makeFakeContainer("legacy", 0, 903);
    const legacyPsIncomplete = makeFakeContainer("legacy", 0, 904);
    const legacyPsConflict = makeFakeContainer("legacy", 0, 906);
    const dumpByFile = new Map<string, string>();

    const stageRes = await buildHelaOverrideStage(
      {
        dumpDir,
        stagingDir,
        logPath,
        baselineManifestPath,
        baselineOverridesDir,
        testVersion: "1050ti-menu-v1.2.0-candidate",
        autoDisassemble: true,
        requirePairValidationForPs: true,
      },
      {
        dxcPath: () => "mock-dxc",
        fxcPath: () => "mock-fxc",
        converter: async () => ({
          hlsl: "void main() {}\n",
          post: { hlsl: "", changes: [], registerMap: [], warnings: [], entryPoint: "main" },
          notes: [],
        }),
        runner: async (cmd, args) => {
          if (cmd === "mock-dxc" && args[0] === "-dumpbin") {
            const n = path.basename(args[1], ".dxil");
            if (n === vsAHash || n === vsBHash) return { code: 0, stdout: vsCompatDisasm, stderr: "" };
            if (n === vsBadOutHash) return { code: 0, stdout: vsBadOutDisasm, stderr: "" };
            if (n === psCompatHash || n === psIncompleteHash || n === psConflictHash) return { code: 0, stdout: psCompatDisasm, stderr: "" };
            if (n === csWaveHash) return { code: 0, stdout: csWaveDisasm, stderr: "" };
            return { code: 1, stdout: "", stderr: "unknown dxil" };
          }
          if (cmd === "mock-fxc" && args[0] === "/dumpbin") {
            const d = dumpByFile.get(args[1]) ?? dumpByFile.get(path.basename(args[1]));
            return d ? { code: 0, stdout: d, stderr: "" } : { code: 1, stdout: "", stderr: "missing mock dump" };
          }
          if (cmd === "mock-fxc") {
            const outCso = args[args.indexOf("/Fo") + 1];
            const src = args[args.length - 1];
            if (src.includes(vsAHash)) {
              fs.writeFileSync(outCso, legacyVsA);
              dumpByFile.set(outCso, vsCompatDisasm);
              dumpByFile.set(`${vsAHash}.cso`, vsCompatDisasm);
            } else if (src.includes(vsBHash)) {
              fs.writeFileSync(outCso, legacyVsB);
              dumpByFile.set(outCso, vsCompatDisasm);
              dumpByFile.set(`${vsBHash}.cso`, vsCompatDisasm);
            } else if (src.includes(vsBadOutHash)) {
              fs.writeFileSync(outCso, legacyVsBadOut);
              dumpByFile.set(outCso, vsBadOutDisasm);
              dumpByFile.set(`${vsBadOutHash}.cso`, vsBadOutDisasm);
            } else if (src.includes(psCompatHash)) {
              fs.writeFileSync(outCso, legacyPsCompat);
              dumpByFile.set(outCso, psCompatDisasm);
              dumpByFile.set(`${psCompatHash}.cso`, psCompatDisasm);
            } else if (src.includes(psIncompleteHash)) {
              fs.writeFileSync(outCso, legacyPsIncomplete);
              dumpByFile.set(outCso, psCompatDisasm);
              dumpByFile.set(`${psIncompleteHash}.cso`, psCompatDisasm);
            } else if (src.includes(psConflictHash)) {
              fs.writeFileSync(outCso, legacyPsConflict);
              dumpByFile.set(outCso, psCompatDisasm);
              dumpByFile.set(`${psConflictHash}.cso`, psCompatDisasm);
            }
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 1, stdout: "", stderr: "unexpected" };
        },
      },
    );

    const compatEntry = stageRes.entries.find((e) => e.hash === psCompatHash)!;
    assert.equal(compatEntry.sharedByMultipleVs, true);
    assert.equal(compatEntry.status, "pair-validated");
    assert.equal(compatEntry.validatedAgainstVs.length, 2, "tutti e 2 i VS abbinati verificati");
    assert.equal(compatEntry.includedInManifest, true);

    const incompleteEntry = stageRes.entries.find((e) => e.hash === psIncompleteHash)!;
    assert.equal(incompleteEntry.sharedByMultipleVs, true);
    assert.equal(
      incompleteEntry.status,
      "pair-incomplete",
      "se manca firma/bytecode di uno dei VS abbinati NON deve essere pair-validated",
    );
    assert.equal(incompleteEntry.includedInManifest, false);
    assert.deepEqual(incompleteEntry.missingPairedVsDisasm, [vsMissingHash]);
    assert.deepEqual(incompleteEntry.missingPairedVsCso, [vsMissingHash]);

    const conflictEntry = stageRes.entries.find((e) => e.hash === psConflictHash)!;
    assert.equal(conflictEntry.sharedByMultipleVs, true);
    assert.equal(
      conflictEntry.status,
      "pair-conflict",
      "PS condiviso da 2 VS con firme incompatibili deve diventare pair-conflict",
    );
    assert.equal(conflictEntry.includedInManifest, false);
    assert.equal(conflictEntry.csoPath, undefined, "pair-conflict bloccato fail-closed prima di produrre .cso");
    assert.deepEqual(conflictEntry.validatedAgainstVs, []);
    assert.match(conflictEntry.message, new RegExp(vsAHash));
    assert.match(conflictEntry.message, new RegExp(vsBadOutHash));

    assert.equal(stageRes.counts.blocked, 1, "CS con Wave ops bloccato");
    assert.equal(stageRes.counts["pair-conflict"], 1, "1 PS in pair-conflict");
    assert.equal(stageRes.counts["pair-incomplete"], 1, "1 PS in pair-incomplete");
    assert.equal(stageRes.baselineOverridesPreserved, 1);
    assert.equal(stageRes.newCandidatesIncluded, 4, "vsA + vsB + vsBadOut + psCompat");

    // Verifica preservazione baseline nel manifest candidato generato
    const stagedManifest = JSON.parse(fs.readFileSync(stageRes.manifestPath!, "utf8")) as HelaRunManifestV1;
    assert.equal(stagedManifest.overrides[baselineCsoName], baselineCsoSha, "hash baseline preservato");
    assert.deepEqual(stagedManifest.requiredOverrides, [baselineCsoName], "requiredOverrides baseline preservati");
    assert.equal(stagedManifest.overrides[`${psIncompleteHash}.cso`], undefined, "pair-incomplete escluso");
    assert.equal(stagedManifest.overrides[`${psConflictHash}.cso`], undefined, "pair-conflict escluso");

    const candidateRuntimeDir = path.join(tmp, "candidate-runtime");
    fs.mkdirSync(candidateRuntimeDir, { recursive: true });
    const candidateRuntimeBytes = {
      d3d12: Buffer.from("candidate d3d12 proxy"),
      dxgi: Buffer.from("candidate dxgi proxy"),
    };
    fs.writeFileSync(path.join(candidateRuntimeDir, "d3d12.dll"), candidateRuntimeBytes.d3d12);
    fs.writeFileSync(path.join(candidateRuntimeDir, "dxgi.dll"), candidateRuntimeBytes.dxgi);
    const runtimeStageDir = path.join(tmp, "runtime-replacement-stage");
    const runtimeStage = await buildHelaOverrideStage(
      {
        dumpDir,
        stagingDir: runtimeStageDir,
        baselineManifestPath,
        baselineOverridesDir,
        runtimeDir: candidateRuntimeDir,
        testVersion: "1050ti-runtime-candidate",
        autoDisassemble: false,
        onlyHashes: ["ffffffffffffffff"],
      },
      { fxcPath: () => "unused", dxcPath: () => "unused" },
    );
    const runtimeCandidateManifest = JSON.parse(
      fs.readFileSync(runtimeStage.manifestPath!, "utf8"),
    ) as HelaRunManifestV1;
    const runtimePackage = JSON.parse(
      fs.readFileSync(path.join(runtimeStageDir, "candidate-package.json"), "utf8"),
    ) as { runtime: Array<{ path: string; sha256: string }> };
    assert.equal(runtimeCandidateManifest.runtime.d3d12, sha256Buffer(candidateRuntimeBytes.d3d12));
    assert.equal(runtimeCandidateManifest.runtime.dxgi, sha256Buffer(candidateRuntimeBytes.dxgi));
    assert.deepEqual(
      runtimePackage.runtime.map(({ path: runtimePath, sha256 }) => [runtimePath, sha256]),
      [
        ["runtime/d3d12.dll", sha256Buffer(candidateRuntimeBytes.d3d12)],
        ["runtime/dxgi.dll", sha256Buffer(candidateRuntimeBytes.dxgi)],
      ],
    );
    assert.equal(runtimeStage.packageGate?.ok, true);
    assert.deepEqual(
      readAndValidateManifest(baselineManifestPath).runtime,
      baselineManifest.runtime,
      "l'aggiornamento runtime del candidato non deve modificare il manifest baseline",
    );

    // 6. Test planHelaManifestPatch: preserva baseline + rifiuta percorsi pericolosi
    const deltaStagingOverrides = path.join(tmp, "delta-staging-overrides");
    fs.mkdirSync(deltaStagingOverrides, { recursive: true });
    const newOnlyCso = makeFakeContainer("legacy", 5, 955);
    const newOnlyName = "1122334455667788.cso";
    fs.writeFileSync(path.join(deltaStagingOverrides, newOnlyName), newOnlyCso);

    // Rifiuta sovrascrittura del baseline
    assert.throws(
      () =>
        planHelaManifestPatch({
          baselineManifestPath,
          stagingOverridesDir: deltaStagingOverrides,
          outManifestPath: baselineManifestPath,
          testVersion: "bad",
        }),
      /coincide con baselineManifestPath/,
    );
    // Rifiuta scrittura dentro la cartella del baseline
    assert.throws(
      () =>
        planHelaManifestPatch({
          baselineManifestPath,
          stagingOverridesDir: deltaStagingOverrides,
          outManifestPath: path.join(baselineDir, "other.json"),
          testVersion: "bad",
        }),
      /stessa cartella del manifest baseline/,
    );
    // Rifiuta scrittura dentro stagingOverridesDir
    assert.throws(
      () =>
        planHelaManifestPatch({
          baselineManifestPath,
          stagingOverridesDir: deltaStagingOverrides,
          outManifestPath: path.join(deltaStagingOverrides, "out.json"),
          testVersion: "bad",
        }),
      /dentro stagingOverridesDir/,
    );
    // Rifiuta scrittura dentro percorso protetto del gioco
    assert.throws(
      () =>
        planHelaManifestPatch({
          baselineManifestPath,
          stagingOverridesDir: deltaStagingOverrides,
          outManifestPath: path.join(tmp, "Binaries", "Win64", "run-manifest.json"),
          testVersion: "bad",
        }),
      /percorso protetto/,
    );

    const plannedPath = path.join(tmp, "planned-candidates", "run-manifest.v1.2.0.json");
    const planned = planHelaManifestPatch({
      baselineManifestPath,
      stagingOverridesDir: deltaStagingOverrides,
      outManifestPath: plannedPath,
      testVersion: "1050ti-menu-v1.2.0-planned",
      dumpShaders: true,
    });
    assert.equal(planned.baselineOverrideCount, 1);
    assert.equal(planned.totalOverrides, 2, "baseline preservato + 1 nuovo candidato aggiunto");
    assert.deepEqual(planned.addedOverrides, [newOnlyName]);
    const plannedJson = JSON.parse(fs.readFileSync(plannedPath, "utf8")) as HelaRunManifestV1;
    assert.equal(plannedJson.overrides[baselineCsoName], baselineCsoSha);
    assert.deepEqual(plannedJson.requiredOverrides, [baselineCsoName]);
    assert.equal(plannedJson.overrides[newOnlyName], sha256Buffer(newOnlyCso));
    assert.equal(plannedJson.launchProfile?.environment.D3D12ON11_DUMP_SHADERS, "1");
    assert.equal(
      plannedJson.launchProfile?.sha256,
      computeLaunchEnvironmentSha256(plannedJson.launchProfile!.environment),
    );

    // Rifiuta sovrascrittura se outManifestPath esiste già
    assert.throws(
      () =>
        planHelaManifestPatch({
          baselineManifestPath,
          stagingOverridesDir: deltaStagingOverrides,
          outManifestPath: plannedPath,
          testVersion: "bad-overwrite",
        }),
      /esiste già/,
    );

    // Rifiuta conflitto hash su file baseline
    const conflictDeltaDir = path.join(tmp, "conflict-delta-overrides");
    fs.mkdirSync(conflictDeltaDir, { recursive: true });
    fs.writeFileSync(path.join(conflictDeltaDir, baselineCsoName), makeFakeContainer("legacy", 1, 999));
    assert.throws(
      () =>
        planHelaManifestPatch({
          baselineManifestPath,
          stagingOverridesDir: conflictDeltaDir,
          outManifestPath: path.join(tmp, "planned-candidates", "conflict.json"),
          testVersion: "bad-conflict",
        }),
      /Conflitto hash sul file baseline/,
    );

    // 7. Test verifyHelaRun: distingue Present non raggiunto / Present raggiunto + BMP nero / Present raggiunto + pixel non neri
    const baseAttestLines = [
      "MODULE_FINGERPRINT role=d3d12 sha256=14dfba07e9a37b1c8adbc7fe11de6ba14ee0ab3968e953b85a097d32dbf69e98",
      "MODULE_FINGERPRINT role=dxgi_proxy sha256=09d13c05bf198c74b4190a9cb1be1c96966a0ece7641d8621c08a00465e0f857",
      "DIAGNOSTIC_MASK_NVIDIA: native-vendor=0x10de device=0x1c8c exposed-vendor=0xffff",
      "D3D12CreateDevice adapter source=proxy-unwrap",
      "CheckFeatureSupport end feature=D3D12_OPTIONS tiled-tier=3",
      "Config caller-trace=0",
      `SHADER READY stage=VS hash=20e0826b236597a1 source=SM5-override path=o\\${baselineCsoName} bytes=${baselineCsoBytes.length} sha256=${baselineCsoSha} model=5_0`,
    ];

    // 7a. Present non raggiunto (swap=0, present=0)
    const runNoPresent = path.join(tmp, "run-no-present");
    fs.mkdirSync(runNoPresent, { recursive: true });
    fs.writeFileSync(path.join(runNoPresent, "run-manifest.json"), JSON.stringify(baselineManifest));
    fs.writeFileSync(
      path.join(runNoPresent, "d3d12on11.log"),
      [...baseAttestLines, "[RENDER_TRACE] [HEARTBEAT] tid=1 up=1000ms swap=0 present=0"].join("\n"),
    );
    const noPresRes = verifyHelaRun({ runDir: runNoPresent, targetPresent: 1400 });
    assert.equal(noPresRes.attestationPassed, true);
    assert.equal(noPresRes.presentStatus.reached, false);
    assert.equal(noPresRes.verdict, "present-not-reached");
    assert.equal(noPresRes.menuValidated, false);

    // 7b. Present #1400 raggiunto ma BMP top-down neri (caso v1.1.2 / v1.1.3)
    const runBlack = path.join(tmp, "run-black");
    fs.mkdirSync(path.join(runBlack, "readbacks"), { recursive: true });
    fs.writeFileSync(path.join(runBlack, "run-manifest.json"), JSON.stringify(baselineManifest));
    fs.writeFileSync(
      path.join(runBlack, "d3d12on11.log"),
      [
        ...baseAttestLines,
        "[READBACK_IDENTITY] readback_present_count=1400 buffer_index=0 native_backbuffer=00000100 width=32 height=32 format=87 copy_sequence=7 copy_source=00000200",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(runBlack, "readbacks", "HelaReadback_Present1400_source.bmp"), makeBmp24(32, 32, false, true));
    fs.writeFileSync(path.join(runBlack, "readbacks", "HelaReadback_Present1400_backbuffer.bmp"), makeBmp24(32, 32, false, true));
    fs.writeFileSync(path.join(runBlack, "readbacks", "HelaReadback_Present100_backbuffer.bmp"), makeBmp24(32, 32, true, true));
    const blackRes = verifyHelaRun({ runDir: runBlack, targetPresent: 1400 });
    assert.equal(blackRes.attestationPassed, true);
    assert.equal(blackRes.presentStatus.reached, true);
    assert.equal(blackRes.presentStatus.targetPresentReached, true);
    assert.equal(blackRes.bmpReadbackStatus, "black-readback");
    assert.equal(blackRes.bmpPathsNotMatchingTarget.length, 1, "un BMP di un Present precedente non deve influire sul target");
    assert.equal(blackRes.verdict, "present-reached-black-readback");
    assert.equal(blackRes.menuValidated, false);

    // 7c. Present #1400 raggiunto e pixel non neri osservati -> menuValidated RESTA false!
    fs.writeFileSync(path.join(runBlack, "readbacks", "HelaReadback_Present1400_backbuffer.bmp"), makeBmp24(32, 32, true, true));
    const nonZeroRes = verifyHelaRun({ runDir: runBlack, targetPresent: 1400 });
    assert.equal(nonZeroRes.bmpReadbackStatus, "nonzero-pixels-observed");
    assert.equal(nonZeroRes.verdict, "present-reached-nonzero-pixels-observed");
    assert.equal(nonZeroRes.menuValidated, false, "pixel non neri osservati NON equivalgono a menu validato");

    // 7d. Il contatore heartbeat non sostituisce il target readback Present.
    const runReadbackTargetMissing = path.join(tmp, "run-readback-target-missing");
    fs.mkdirSync(path.join(runReadbackTargetMissing, "readbacks"), { recursive: true });
    fs.writeFileSync(path.join(runReadbackTargetMissing, "run-manifest.json"), JSON.stringify(baselineManifest));
    fs.writeFileSync(
      path.join(runReadbackTargetMissing, "d3d12on11.log"),
      [
        ...baseAttestLines,
        "[RENDER_TRACE] [HEARTBEAT] tid=1 up=1000ms swap=1 present=1400",
        "[READBACK_IDENTITY] readback_present_count=100 buffer_index=0 native_backbuffer=00000100 width=32 height=32 format=87 copy_sequence=1 copy_source=00000200",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(runReadbackTargetMissing, "readbacks", "HelaReadback_Present100_backbuffer.bmp"),
      makeBmp24(32, 32, true, true),
    );
    const targetMissingRes = verifyHelaRun({ runDir: runReadbackTargetMissing, targetPresent: 1400 });
    assert.equal(targetMissingRes.presentStatus.reached, true);
    assert.equal(targetMissingRes.presentStatus.targetPresentReached, false);
    assert.equal(targetMissingRes.bmpReadbackStatus, "missing");
    assert.equal(targetMissingRes.verdict, "present-not-reached");

    // 7e. Attestazione fallita
    const runBadAttest = path.join(tmp, "run-bad-attest");
    fs.mkdirSync(runBadAttest, { recursive: true });
    fs.writeFileSync(path.join(runBadAttest, "run-manifest.json"), JSON.stringify(baselineManifest));
    fs.writeFileSync(path.join(runBadAttest, "d3d12on11.log"), baseAttestLines.slice(0, 5).join("\n"));
    const badRes = verifyHelaRun({ runDir: runBadAttest });
    assert.equal(badRes.attestationPassed, false);
    assert.equal(badRes.verdict, "attestation-failed");
    assert.deepEqual(badRes.missingRequiredOverrides, [baselineCsoName]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
