param([ValidateSet('claude','codex','gemini')][string]$Provider)
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = "YES or NO - $Provider"
Get-ChildItem Env: | Where-Object { $_.Name -match 'API_KEY$|^ELECTRON_|^NODE_OPTIONS$|^CLAUDECODE$' } | Remove-Item

function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Find-Cli([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    $local = Join-Path $env:USERPROFILE ".local\bin\$Name.exe"
    if (Test-Path $local) { return $local }
    return $null
}

try {
    $cli = Find-Cli $Provider
    if (-not $cli) {
        Write-Host "1단계: $Provider CLI가 없어 공식 설치를 시작합니다..." -ForegroundColor Cyan
        switch ($Provider) {
            'claude' { Invoke-RestMethod 'https://claude.ai/install.ps1' | Invoke-Expression }
            default {
                $package = @{ codex = '@openai/codex'; gemini = '@google/gemini-cli' }[$Provider]
                if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
                    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Node.js가 필요합니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 시도하세요.' }
                    Write-Host 'Node.js(npm)가 없어 먼저 설치합니다...' -ForegroundColor Cyan
                    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
                    Update-SessionPath
                }
                npm install -g $package
            }
        }
        Update-SessionPath
        $cli = Find-Cli $Provider
        if (-not $cli) { throw '설치는 끝났지만 CLI를 찾지 못했습니다. 이 창을 닫고 앱에서 다시 시도하세요.' }
        Write-Host '설치를 마쳤습니다.' -ForegroundColor Green
    }
    Write-Host "2단계: $Provider 로그인을 시작합니다..." -ForegroundColor Cyan
    switch ($Provider) {
        'claude' { & $cli auth login }
        'codex' { & $cli login }
        'gemini' { & $cli }
    }
    if ($LASTEXITCODE -ne 0) { Write-Host "CLI가 코드 $LASTEXITCODE 로 끝났습니다. 위의 메시지를 확인하세요." -ForegroundColor Yellow }
} catch {
    Write-Host "실행하지 못했습니다: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host '로그인을 마쳤으면 이 창을 닫고 YES or NO로 돌아가세요. 상태가 자동으로 다시 확인됩니다.'
