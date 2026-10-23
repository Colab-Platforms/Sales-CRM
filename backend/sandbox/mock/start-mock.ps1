# Runs the CRM backend (or the harness) against the LOCAL ISOLATED database with a SIMULATED Cashfree. Never loads backend\.env, makes no Cashfree/WhatsApp/Shopify request.
#   .\sandbox\mock\start-mock.ps1 server                 starts the API on http://127.0.0.1:5100 (keep it running in its own window)
#   .\sandbox\mock\start-mock.ps1 harness seed           creates a synthetic prepaid order (see harness.mts for the other commands)
# Needs: local Postgres on 127.0.0.1:5544 with database crm_iso, and its websocket proxy on 127.0.0.1:5545 (the same setup the automated DB tests use).
param([Parameter(Position = 0)][string]$What = "server", [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = "Stop"
$backend = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$mock = $PSScriptRoot
$pg = "C:\Program Files\PostgreSQL\17\bin\psql.exe"

# blank every variable named in .env / .env.example (names only; values are never read) so nothing production-like can be inherited
$names = @()
foreach ($f in @("$backend\.env.example", "$backend\.env")) { if (Test-Path $f) { $names += (Get-Content $f | ForEach-Object { if ($_ -match '^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=') { $Matches[1] } }) } }
foreach ($n in ($names | Sort-Object -Unique)) { Set-Item -Path "Env:$n" -Value "" }

$empty = Join-Path $mock "empty.env"
if (-not (Test-Path $empty)) { Set-Content -Path $empty -Value "# intentionally empty: dotenv must not load the production .env" }
$state = Join-Path ([IO.Path]::GetTempPath()) "cf-mock-state.json"
if (-not (Test-Path $state)) { Set-Content -Path $state -Value '{"orders":{},"links":{},"control":{},"log":[],"n":0}' }

$env:DATABASE_URL = "postgresql://postgres@127.0.0.1:5544/crm_iso"
$env:QUEUE_DATABASE_URL = ""
$env:JWT_SECRET = "local-mock-test-secret"
$env:CASHFREE_ENABLED = "true"; $env:CASHFREE_ENV = "sandbox"; $env:CASHFREE_CLIENT_ID = "MOCK_ID"; $env:CASHFREE_CLIENT_SECRET = "mock-webhook-secret"
$env:CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED = "true"; $env:CASHFREE_UPI_QR_ENABLED = "true"
$env:PUBLIC_BACKEND_URL = "https://mock.sandbox.example.com"
$env:CRM_SANDBOX_MODE = "true"; $env:DISABLE_BACKGROUND_JOBS = "true"; $env:PORT = "5100"
$env:DOTENV_CONFIG_PATH = $empty; $env:DOTENV_PATH = $empty
$env:MOCK_CF_STATE = $state; $env:MOCK_NEON_PROXY = "1"
$preload = ("file:///" + ((Join-Path $mock "cashfree-mock.preload.mjs") -replace '\\', '/'))
$env:NODE_OPTIONS = "--import $preload"

if ($env:DATABASE_URL -ne "postgresql://postgres@127.0.0.1:5544/crm_iso") { throw "GUARD: DATABASE_URL is not the isolated database" }
$db = (& $pg -h 127.0.0.1 -p 5544 -U postgres -d crm_iso -tA -c "select current_database()" 2>&1 | Out-String).Trim()
if ($db -ne "crm_iso") { throw "GUARD: isolated database not reachable (got: $db)" }
"GUARD OK: isolated crm_iso; production .env not loaded; Cashfree is SIMULATED in-process (no network request to Cashfree)"

Set-Location $backend
if ($What -eq "server") { & npx tsx src/server.ts }
elseif ($What -eq "harness") { & npx tsx sandbox/mock/harness.mts @Rest }
else { throw "usage: start-mock.ps1 server | harness <command>" }
