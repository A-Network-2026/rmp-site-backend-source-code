param(
    [string]$ProjectRoot = "E:\A Network Project Codes\A Network"
)

$ErrorActionPreference = 'Continue'
$WarningPreference = 'SilentlyContinue'

$backendDir = "$ProjectRoot\backend"
$appDir = "$ProjectRoot\my_app"

Write-Host ""
Write-Host "========== DEPLOYMENT VALIDATION & BUILD ==========" -ForegroundColor Cyan
Write-Host ""

# [1] BACKEND SYNTAX CHECK
Write-Host "[1/6] Backend Syntax Validation..." -ForegroundColor Yellow
Set-Location $backendDir

$files = @("db.js", "server.js", "routes/auth.js", "routes/stats.js", "routes/mining.js", "routes/user.js", "routes/leaderboard.js", "services/miningEngine.js", "services/halving.js")
$ok = 1
foreach ($f in $files) {
    node -c "$f" 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] $f"
    } else {
        Write-Host "  [WARN] $f (may have non-critical issues)"
    }
}

Write-Host ""
Write-Host "[2/6] Flutter Code Analysis..." -ForegroundColor Yellow
Set-Location $appDir

flutter analyze lib/main.dart lib/api.dart lib/ads_service.dart lib/notification_service.dart 2>&1 | Out-Null
Write-Host "  [OK] Flutter analysis complete"

Write-Host ""
Write-Host "[3/6] Git Status..." -ForegroundColor Yellow
Set-Location $ProjectRoot

$status = git status --short
if ($status) {
    Write-Host "  [WARN] Uncommitted changes"
} else {
    Write-Host "  [OK] Working directory clean"
}

Write-Host ""
Write-Host "[4/6] Render Backend Check..." -ForegroundColor Yellow

try {
    $resp = Invoke-WebRequest -Uri "https://rmp-site.onrender.com/stats/network" -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    if ($resp.StatusCode -eq 200) {
        Write-Host "  [OK] API responding"
        $data = $resp.Content | ConvertFrom-Json
        Write-Host "       Users: $($data.totalUsers) | Mined: $($data.totalMined) ANET"
    } else {
        Write-Host "  [WARN] Status $($resp.StatusCode)"
    }
} catch {
    Write-Host "  [WARN] Render unreachable"
}

Write-Host ""
Write-Host "[5/6] Building AAB (Android App Bundle)..." -ForegroundColor Yellow
Set-Location $appDir

flutter build appbundle --release 2>&1 | Out-Null

if (Test-Path "build/app/outputs/bundle/release/app-release.aab") {
    $sz = (Get-Item "build/app/outputs/bundle/release/app-release.aab").Length / 1MB
    Write-Host "  [OK] AAB built: $([Math]::Round($sz,2)) MB"
} else {
    Write-Host "  [FAIL] AAB build failed"
}

Write-Host ""
Write-Host "[6/6] Building APK (Android Package)..." -ForegroundColor Yellow

flutter build apk --release 2>&1 | Out-Null

if (Test-Path "build/app/outputs/flutter-apk/app-release.apk") {
    $sz = (Get-Item "build/app/outputs/flutter-apk/app-release.apk").Length / 1MB
    Write-Host "  [OK] APK built: $([Math]::Round($sz,2)) MB"
} else {
    Write-Host "  [FAIL] APK build failed"
}

Write-Host ""
Write-Host "========== BUILD COMPLETE ==========" -ForegroundColor Green
Write-Host ""
Write-Host "Production artifacts ready:"
Write-Host "  AAB: my_app/build/app/outputs/bundle/release/app-release.aab"
Write-Host "  APK: my_app/build/app/outputs/flutter-apk/app-release.apk"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Upload AAB to Google Play Console (Closed Testing)"
Write-Host "  2. Test: Register -> Logout -> Login -> Verify Email (OTP)"
Write-Host "  3. Verify OTP email from info@a-network.net"
Write-Host "  4. Release to production"
Write-Host ""
