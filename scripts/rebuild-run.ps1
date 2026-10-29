$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$appExe = Join-Path $projectRoot 'out\YESORNOT-win32-x64\YESORNOT.exe'
$devExe = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
$legacyExe = Join-Path $projectRoot 'out\YES or NOT-win32-x64\YES or NOT.exe'

function Get-ProjectAppProcesses {
    Get-Process -Name 'YESORNOT','YES or NOT','electron' -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and ($_.Path.Equals($appExe, [StringComparison]::OrdinalIgnoreCase) -or $_.Path.Equals($devExe, [StringComparison]::OrdinalIgnoreCase) -or $_.Path.Equals($legacyExe, [StringComparison]::OrdinalIgnoreCase))
    }
}

try {
    Set-Location -LiteralPath $projectRoot
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Write-Host '[1/4] Checking source files...'
    & node scripts/check.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Source check failed. The existing app has been kept running.' }

    Write-Host '[2/4] Closing the existing app...'
    foreach ($runningApp in @(Get-ProjectAppProcesses)) {
        # A normal window close lets main.cjs cancel requests and save the record.
        try { [void]$runningApp.CloseMainWindow() } catch { }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (@(Get-ProjectAppProcesses).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 150
    }
    foreach ($remainingApp in @(Get-ProjectAppProcesses)) {
        # Match the exact executable path again before forcing a hung process tree.
        $target = Get-Process -Id $remainingApp.Id -ErrorAction SilentlyContinue
        if ($target -and ($target.Path -eq $appExe -or $target.Path -eq $devExe -or $target.Path -eq $legacyExe)) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $target.Id /T /F 2>&1 | Out-Null
        }
    }
    if (@(Get-ProjectAppProcesses).Count -gt 0) { throw 'Could not close the existing app. Build stopped.' }

    Write-Host '[3/4] Building the latest application...'
    & npm.cmd run package
    if ($LASTEXITCODE -ne 0) { throw 'Build failed. The old package will not be launched.' }
    if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) { throw 'The packaged executable was not created.' }

    Write-Host '[4/4] Opening YESORNOT...'
    $env:YESORNOT_ENV_FILE = Join-Path $projectRoot '.env'
    Start-Process -FilePath $appExe -WorkingDirectory (Split-Path -Parent $appExe) -WindowStyle Normal
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
