$ErrorActionPreference = "Stop"

if ($args.Count -ne 1) {
    throw "Usage: extract-pix-shaders.ps1 <plan.json>"
}

$plan = Get-Content -LiteralPath $args[0] -Raw | ConvertFrom-Json
$resourcesPath = [System.IO.Path]::GetFullPath([string]$plan.resourcesPath)
$outputDirectory = [System.IO.Path]::GetFullPath([string]$plan.outputDirectory)
$resultPath = [System.IO.Path]::GetFullPath([string]$plan.resultPath)

if (-not (Test-Path -LiteralPath $resourcesPath -PathType Leaf)) {
    throw "PIX resources.bin non trovato: $resourcesPath"
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class PixXpress
{
    [DllImport("cabinet.dll", ExactSpelling = true, SetLastError = true)]
    public static extern bool CreateDecompressor(uint algorithm, IntPtr parameters, out IntPtr decompressor);

    [DllImport("cabinet.dll", ExactSpelling = true, SetLastError = true)]
    public static extern bool Decompress(
        IntPtr decompressor,
        byte[] compressedData,
        UIntPtr compressedDataSize,
        byte[] uncompressedBuffer,
        UIntPtr uncompressedBufferSize,
        out UIntPtr uncompressedDataSize);

    [DllImport("cabinet.dll", ExactSpelling = true, SetLastError = true)]
    public static extern bool CloseDecompressor(IntPtr decompressor);

    public static UIntPtr Size(ulong value)
    {
        return new UIntPtr(value);
    }
}
"@

[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$stream = [System.IO.File]::OpenRead($resourcesPath)
$decompressor = [IntPtr]::Zero
$results = New-Object System.Collections.Generic.List[object]
$unique = @{}
$buffer = New-Object byte[] (16 * 1024 * 1024)

try {
    if (-not [PixXpress]::CreateDecompressor(3, [IntPtr]::Zero, [ref]$decompressor)) {
        throw "CreateDecompressor(XPRESS) fallito: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }

    foreach ($entry in $plan.entries) {
        $offset = [long]$entry.offset
        $compressedSize = [int]$entry.compressedSize
        $decodedSize = [int]$entry.decodedSize
        if ($offset -lt 0 -or $compressedSize -le 0 -or $decodedSize -le 0 -or
            $offset + $compressedSize -gt $stream.Length -or $decodedSize -gt $buffer.Length) {
            throw "Intervallo risorsa non valido per PSO $($entry.psoId)."
        }

        $stream.Position = $offset
        $compressed = New-Object byte[] $compressedSize
        $read = 0
        while ($read -lt $compressedSize) {
            $count = $stream.Read($compressed, $read, $compressedSize - $read)
            if ($count -eq 0) { throw "Lettura incompleta di resources.bin per PSO $($entry.psoId)." }
            $read += $count
        }

        $actualSize = [UIntPtr]::Zero
        $ok = [PixXpress]::Decompress(
            $decompressor,
            $compressed,
            [PixXpress]::Size([uint64]$compressedSize),
            $buffer,
            [PixXpress]::Size([uint64]$decodedSize),
            [ref]$actualSize)
        if (-not $ok) {
            throw "Decompressione XPRESS fallita per PSO $($entry.psoId): $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
        }
        if ($actualSize.ToUInt64() -ne [uint64]$decodedSize) {
            throw "Dimensione decompressa inattesa per PSO $($entry.psoId): $($actualSize.ToUInt64()) invece di $decodedSize."
        }

        $stageOffset = 0
        foreach ($shader in $entry.shaders) {
            $length = [int]$shader.byteLength
            if ($length -le 0 -or $stageOffset + $length -gt $decodedSize) {
                throw "Intervallo shader non valido per PSO $($entry.psoId), stage $($shader.stage)."
            }

            if ([System.Text.Encoding]::ASCII.GetString($buffer, $stageOffset, 4) -ne "DXBC") {
                throw "Container DXBC non valido per PSO $($entry.psoId), stage $($shader.stage)."
            }

            $bytes = New-Object byte[] $length
            [Array]::Copy($buffer, $stageOffset, $bytes, 0, $length)
            $stageOffset += $length

            $sha = [System.Security.Cryptography.SHA256]::Create()
            try {
                $hash = (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "")
            } finally {
                $sha.Dispose()
            }

            $fileName = "$hash.dxil"
            $filePath = Join-Path $outputDirectory $fileName
            if (-not $unique.ContainsKey($hash)) {
                [System.IO.File]::WriteAllBytes($filePath, $bytes)
                $unique[$hash] = $fileName
            }
            $results.Add([pscustomobject]@{
                psoId = [int]$entry.psoId
                stage = [string]$shader.stage
                byteLength = $length
                sha256 = $hash
                fileName = $fileName
            })
        }

        if ($stageOffset -ne $decodedSize) {
            throw "Bytecode PSO non interamente attribuito: PSO $($entry.psoId), $stageOffset/$decodedSize byte."
        }
    }

    [pscustomobject]@{
        payloadCount = $results.Count
        uniqueShaderCount = $unique.Count
        shaders = @($results)
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultPath -Encoding UTF8
    Write-Output "Estratti $($results.Count) payload shader; container unici: $($unique.Count)."
} finally {
    if ($decompressor -ne [IntPtr]::Zero) {
        [void][PixXpress]::CloseDecompressor($decompressor)
    }
    $stream.Dispose()
}
