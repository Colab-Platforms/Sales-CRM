# Starts the CRM backend as an isolated Cashfree SANDBOX test process.
#   - reads ONLY backend\.env.sandbox.local (never backend\.env), prints variable NAMES only, never values
#   - puts the values and CRM_SANDBOX_MODE=true into THIS process's environment and points dotenv at the sandbox file, so the production .env is not loaded
#   - the app's own guard (cashfree.sandbox-guard.ts) then refuses to start if anything could reach production
# Usage (from backend\):   .\sandbox\start-sandbox.ps1            (add -CheckOnly to validate the configuration and stop WITHOUT starting the server)
param([switch]$CheckOnly)
$ErrorActionPreference = "Stop"
$backend = Split-Path -Parent $PSScriptRoot
$file = Join-Path $backend ".env.sandbox.local"
if (-not (Test-Path $file)) { throw "Missing $file. Copy .env.sandbox.example to .env.sandbox.local and fill it in. (The production .env is never used.)" }

# a clean slate: nothing inherited from the shell that could point at production
foreach ($n in @("DATABASE_URL","QUEUE_DATABASE_URL","CASHFREE_ENABLED","CASHFREE_ENV","CASHFREE_CLIENT_ID","CASHFREE_CLIENT_SECRET","CASHFREE_API_URL","CASHFREE_BASE_URL","CASHFREE_UPI_QR_ENABLED","CASHFREE_UPI_QR_ALLOW_PRODUCTION","WHATSAPP_PROVIDER","SHOPIFY_SYNC_ENABLED","PUBLIC_BACKEND_URL","RENDER_EXTERNAL_URL")) { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }

$names = @()
$seen = @{}
foreach ($line in Get-Content $file) {
  if ($line -match '^\s*#' -or $line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { continue }
  $name = $Matches[1]; $value = $Matches[2].Trim()
  if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) { $value = $value.Substring(1, $value.Length - 2) }
  $seen[$name] = $value
  Set-Item -Path "Env:$name" -Value $value
  $names += $name
}
# which required settings are still empty or still the template placeholder (names only - values are never printed). A trailing "# comment" on a value line is part of the value, so it is not allowed.
foreach ($n in @("DATABASE_URL","CASHFREE_CLIENT_ID","CASHFREE_CLIENT_SECRET","PUBLIC_BACKEND_URL","JWT_SECRET")) {
  $v = $seen[$n]
  if ([string]::IsNullOrWhiteSpace($v)) { "UNCONFIGURED (empty): $n" } elseif ($v -match '<[^>]*>') { "UNCONFIGURED (still the template placeholder): $n" }
}
if ($seen["CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED"] -ne "true") { "NOT CONFIRMED: CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED is '" + $(if ($seen.ContainsKey("CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED")) { $seen["CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED"] } else { "<missing>" }) + "' (it must be exactly: true)" }
$env:CRM_SANDBOX_MODE = "true"
$env:DOTENV_CONFIG_PATH = $file
$env:DOTENV_PATH = $file
"Sandbox process environment loaded from .env.sandbox.local: " + (($names | Sort-Object -Unique) -join ", ")

Set-Location $backend
# validate first (no server, no network): the same guard the server runs at boot
& npx tsx -e "import { assertSandboxProcess } from './src/modules/cashfree/cashfree.sandbox-guard.ts'; assertSandboxProcess(); console.log('Sandbox guard: OK (sandbox Cashfree environment, non-production database, WhatsApp and Shopify sync off).');"
if ($LASTEXITCODE -ne 0) { throw "Sandbox guard refused this configuration (see the message above). Nothing was started." }
if ($CheckOnly) { "CheckOnly: stopping before the server starts. No request was made."; return }
& npx tsx src/server.ts
