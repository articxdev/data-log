# deploy.ps1 — One-command deploy for Production Log Bot
# Run: .\deploy.ps1

$ErrorActionPreference = "Stop"

# 1. Check if KV namespace exists, create if not
$kvId = & npx wrangler kv:namespace list | ConvertFrom-Json | Where-Object { $_.title -eq "KV" } | Select-Object -ExpandProperty id

if (-not $kvId) {
  Write-Host "Creating KV namespace..." -ForegroundColor Yellow
  $result = & npx wrangler kv:namespace create "KV" 2>&1
  $kvId = ($result | Select-String -Pattern '"id":\s*"([^"]+)"').Matches.Groups[1].Value
  Write-Host "KV namespace created: $kvId" -ForegroundColor Green
} else {
  Write-Host "KV namespace exists: $kvId" -ForegroundColor Green
}

# 2. Update wrangler.toml with the KV id
$toml = Get-Content "wrangler.toml" -Raw
$toml = $toml -replace 'id = ""', "id = `"$kvId`""
Set-Content "wrangler.toml" -Value $toml

# 3. Prompt for secrets if not set
$missingSecrets = @()
$envVars = & npx wrangler secret list 2>&1
if ($envVars -notmatch "BOT_TOKEN") { $missingSecrets += "BOT_TOKEN" }
if ($envVars -notmatch "ALLOWED_USERS") { $missingSecrets += "ALLOWED_USERS" }

foreach ($secret in $missingSecrets) {
  $value = Read-Host "Enter value for $secret"
  & npx wrangler secret put $secret <<< "$value" 2>$null
}

# 4. Deploy
Write-Host "Deploying..." -ForegroundColor Yellow
& npx wrangler deploy

# 5. Print webhook setup instructions
Write-Host "`n=== Set webhook ===" -ForegroundColor Cyan
Write-Host "curl -X POST https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook -d ""url=https://production-log-bot.<YOUR_SUBDOMAIN>.workers.dev""" -ForegroundColor White
