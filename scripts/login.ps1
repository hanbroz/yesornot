param([ValidateSet('claude','codex','gemini')][string]$Provider)
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = "YESORNOT - $Provider login"
Get-ChildItem Env: | Where-Object { $_.Name -match 'API_KEY$|^ELECTRON_|^NODE_OPTIONS$|^CLAUDECODE$' } | Remove-Item
Write-Host "Starting official $Provider CLI login..." -ForegroundColor Cyan
try {
    switch ($Provider) {
        'claude' {
            $command = Get-Command claude -ErrorAction SilentlyContinue
            if ($command) { & $command.Source auth login }
            else { & "$env:USERPROFILE\.local\bin\claude.exe" auth login }
        }
        'codex' { & (Get-Command codex -ErrorAction Stop).Source login }
        'gemini' { & (Get-Command gemini -ErrorAction Stop).Source }
    }
    if ($LASTEXITCODE -ne 0) { Write-Host "CLI exited with code $LASTEXITCODE. See its message above." -ForegroundColor Yellow }
} catch {
    Write-Host "Could not run $Provider CLI: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host 'After signing in, return to YESORNOT and refresh connections.'
Write-Host 'You can close this terminal when finished.'
