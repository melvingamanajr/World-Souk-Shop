[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeCheck = "const [major,minor]=process.versions.node.split('.').map(Number); process.exit((major>24 || major===24 && minor>=12) && typeof require('node:sqlite').backup==='function' ? 0 : 1)"

function Test-NodeRuntime([string]$Executable) {
    & $Executable -e $runtimeCheck 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

$previousEnvironment = @{
    ELECTRON_RUN_AS_NODE = $env:ELECTRON_RUN_AS_NODE
    WSS_HOST = $env:WSS_HOST
    WSS_PORT = $env:WSS_PORT
    WSS_DB = $env:WSS_DB
    WSS_PUBLIC_ORIGIN = $env:WSS_PUBLIC_ORIGIN
}

Push-Location -LiteralPath $projectRoot
try {
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $runtime = $null
    if ($node -and (Test-NodeRuntime $node.Source)) {
        $runtime = $node.Source
    }

    if (!$runtime) {
        $env:ELECTRON_RUN_AS_NODE = '1'
        $code = Get-Command Code.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        $candidates = @(
            $code.Source
            (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe')
            (Join-Path $env:ProgramFiles 'Microsoft VS Code\Code.exe')
        )
        foreach ($candidate in $candidates) {
            if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf) -and (Test-NodeRuntime $candidate)) {
                $runtime = $candidate
                break
            }
        }
    }

    if (!$runtime) {
        throw 'Node.js 24.12 or newer with node:sqlite is required. No compatible Node.js or VS Code runtime was found.'
    }
    $env:WSS_HOST = '127.0.0.1'
    $env:WSS_PORT = "$Port"
    $env:WSS_DB = Join-Path $projectRoot 'data\demo.sqlite'
    $env:WSS_PUBLIC_ORIGIN = $null
    & $runtime 'src\server.mjs' --demo | ForEach-Object { Write-Output $_ }
    if ($LASTEXITCODE -ne 0) { throw "World Souk & Shop exited with code $LASTEXITCODE." }
} finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
    Pop-Location
}
