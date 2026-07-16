[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Preflight", "Validate")]
  [string] $Phase,

  [Parameter(Mandatory = $true)]
  [string] $RepositoryRoot,

  [Parameter(Mandatory = $true)]
  [string] $RunnerTemp
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

$BaselineSha = "a2d120a7916c26f029c9a8313ae758d1546ffa35"
$KitSize = "573168"
$KitSha1 = "f06ca26845113216401061faa08989c92455af88"
$KitSha256 = "e716e5f106207a696d8b0f085a62484d927ae4c38a756262c06703f37804d80f"
$KitSha512 = "339065ac19bf9639aa769fd0a3865baab7a434dc8e11e372cea4e38d341c9172bc86985d997092a8e8a4cee899d8159cfbc9c722e4e26a4307cda27ba719ec46"

function Assert-Equal([string] $Actual, [string] $Expected, [string] $Label) {
  if ($Actual -cne $Expected) {
    throw "$Label mismatch. Expected '$Expected', received '$Actual'."
  }
}

function Get-LowerHash([string] $Path, [string] $Algorithm) {
  return (Get-FileHash -LiteralPath $Path -Algorithm $Algorithm).Hash.ToLowerInvariant()
}

function Get-GitBlobHash([string] $Path, [string] $Algorithm) {
  $tempPath = Join-Path $RunnerTemp ("h04b-git-blob-" + [Guid]::NewGuid().ToString("N"))
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = "git"
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @("cat-file", "blob", ("{0}:{1}" -f $env:PR_HEAD_SHA, $Path))) { [void]$startInfo.ArgumentList.Add($argument) }
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw "Could not start git cat-file for $Path." }
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $output = [System.IO.File]::Create($tempPath)
    try { $process.StandardOutput.BaseStream.CopyTo($output) }
    finally { $output.Dispose() }
    $process.WaitForExit()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw ("git cat-file failed for {0} with exit {1}: {2}" -f $Path, $process.ExitCode, $stderr) }
    if ($stderr.Length -ne 0) { throw ("git cat-file wrote stderr for {0}: {1}" -f $Path, $stderr) }
    return Get-LowerHash $tempPath $Algorithm
  } finally {
    $process.Dispose()
    if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
  }
}

function Assert-Candidate {
  Assert-Equal $env:GITHUB_EVENT_NAME "pull_request" "event"
  Assert-Equal $env:GITHUB_BASE_REF "develop" "PR base"
  Assert-Equal $env:GITHUB_HEAD_REF "agent/h04b-windows-validation" "PR head"
  Assert-Equal $env:PR_DRAFT "true" "draft state"
  Assert-Equal $env:PR_HEAD_REPOSITORY "djkeshawa/visp-hyper-agent" "head repository"
  Assert-Equal $env:PR_BASE_SHA $BaselineSha "base SHA"

  Assert-Equal (git rev-parse HEAD).Trim() $env:PR_HEAD_SHA "checked-out head"
  Assert-Equal ([string]@(git status --porcelain --untracked-files=all).Count) "0" "checkout status before validation"

  $expectedPaths = @(
    ".github/validation/h04b-installed-mcp-validate.mjs"
    ".github/validation/h04b-windows-validate.ps1"
    ".github/validation/visp-kit-0.1.1.tgz"
    ".github/workflows/h04b-windows-validation.yml"
    "src/mcp/mcp-server.ts"
    "src/mcp/output-status.ts"
    "tests/mcp-server.test.ts"
  ) | Sort-Object
  $actualPaths = @(
    git diff --name-only $env:PR_BASE_SHA $env:PR_HEAD_SHA |
      Where-Object { $_.Trim().Length -gt 0 } |
      Sort-Object
  )
  $actualPathSet = $actualPaths -join [Environment]::NewLine
  $expectedPathSet = $expectedPaths -join [Environment]::NewLine
  Assert-Equal $actualPathSet $expectedPathSet "candidate path set"

  $codeHashes = @{
    "src/mcp/mcp-server.ts" = "358d1d3148bc6d41f83a04a07bca5f931dfb37dd582308de84aa34ee79d48c7a"
    "src/mcp/output-status.ts" = "c4ad72b89268016255b059fae6d6de3e77989f60a4d64d3f2947d10bd678ef61"
    "tests/mcp-server.test.ts" = "37b092c0e0272afb4eaaf9230bbfd874ac29acab1f1b1a181e8dee5e3ff791e9"
  }
  foreach ($entry in $codeHashes.GetEnumerator()) {
    $actual = Get-GitBlobHash $entry.Key "SHA256"
    Assert-Equal $actual $entry.Value "SHA256 for $($entry.Key)"
    Write-Host "candidate_sha256 $($entry.Key) $actual"
  }

  $kitPath = ".github/validation/visp-kit-0.1.1.tgz"
  Assert-Equal ([string](Get-Item -LiteralPath $kitPath).Length) $KitSize "Kit size"
  Assert-Equal (Get-LowerHash $kitPath "SHA1") $KitSha1 "Kit SHA1"
  Assert-Equal (Get-LowerHash $kitPath "SHA256") $KitSha256 "Kit SHA256"
  Assert-Equal (Get-LowerHash $kitPath "SHA512") $KitSha512 "Kit SHA512"

  $entries = @(tar -tf $kitPath)
  Assert-Equal ([string]$entries.Count) "39" "Kit entry count"
  $forbidden = @(
    $entries | Where-Object {
      $_ -match '^package/(?:\.git|node_modules|coverage|src|tests|\.local-plans)(?:/|$)'
    }
  )
  Assert-Equal ([string]$forbidden.Count) "0" "forbidden Kit entries"

  foreach ($path in $expectedPaths[0..3]) {
    $actual = if ($path -eq $kitPath) { Get-LowerHash $path "SHA256" } else { Get-GitBlobHash $path "SHA256" }
    Write-Host "temporary_sha256 $path $actual"
  }
  Assert-Equal ([string]@(git status --porcelain --untracked-files=all).Count) "0" "checkout status after validation"
  Write-Host "kit_artifact size=$KitSize sha1=$KitSha1 sha256=$KitSha256 entries=39"
}

function New-JsonFile([string] $Path, [hashtable] $Value) {
  $Value | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Path -Encoding utf8
}

function Invoke-Validation {
  & ".\node_modules\.bin\vitest.cmd" run tests/mcp-server.test.ts
  pnpm typecheck
  pnpm build
  pnpm test
  git diff --check $env:PR_BASE_SHA $env:PR_HEAD_SHA
  git diff --check
  git diff --exit-code
  git diff --cached --exit-code

  $validationRoot = Join-Path $RunnerTemp "h04b-windows-validation"
  if (Test-Path $validationRoot) {
    Remove-Item -LiteralPath $validationRoot -Recurse -Force
  }
  $packDir = Join-Path $validationRoot "pack"
  $pairDir = Join-Path $validationRoot "pair"
  $projectDir = Join-Path $validationRoot "project"
  $noKitProject = Join-Path $validationRoot "no-kit-project"
  $noKitPath = Join-Path $validationRoot "no-kit-path"
  New-Item -ItemType Directory -Force -Path $packDir, $pairDir, $projectDir, $noKitProject, $noKitPath | Out-Null

  pnpm pack --pack-destination $packDir
  $hyperPackages = @(Get-ChildItem -LiteralPath $packDir -Filter "visp-hyper-agent-*.tgz")
  Assert-Equal ([string]$hyperPackages.Count) "1" "packed Hyper count"
  $hyperPackage = $hyperPackages[0].FullName
  $kitPackage = (Resolve-Path ".github/validation/visp-kit-0.1.1.tgz").Path

  New-JsonFile (Join-Path $pairDir "package.json") @{
    name = "visp-h04b-windows-pair"
    private = $true
    version = "0.0.0"
    packageManager = "pnpm@11.3.0"
    dependencies = @{
      "visp-hyper-agent" = "file:" + ($hyperPackage -replace '\\', '/')
      "visp-kit" = "file:" + ($kitPackage -replace '\\', '/')
    }
  }
  Push-Location $pairDir
  try {
    pnpm install --lockfile-only --ignore-scripts
    pnpm install --offline --frozen-lockfile --ignore-scripts
  } finally {
    Pop-Location
  }

  $kitManifest = Join-Path $pairDir "node_modules/visp-kit/package.json"
  $hyperManifest = Join-Path $pairDir "node_modules/visp-hyper-agent/package.json"
  Assert-Equal (Get-Content $kitManifest -Raw | ConvertFrom-Json).version "0.1.1" "Kit version"
  Assert-Equal (Get-Content $hyperManifest -Raw | ConvertFrom-Json).version "0.3.0" "Hyper version"

  $pairLock = Join-Path $pairDir "pnpm-lock.yaml"
  $kitDist = Join-Path $pairDir "node_modules/visp-kit/dist/index.js"
  $hyperDist = Join-Path $pairDir "node_modules/visp-hyper-agent/dist/index.js"
  Write-Host "hyper_package_sha256 $(Get-LowerHash $hyperPackage 'SHA256')"
  Write-Host "hyper_package_sha512 $(Get-LowerHash $hyperPackage 'SHA512')"
  Write-Host "pair_lock_sha256 $(Get-LowerHash $pairLock 'SHA256')"
  Write-Host "installed_kit_dist_sha256 $(Get-LowerHash $kitDist 'SHA256')"
  Write-Host "installed_hyper_dist_sha256 $(Get-LowerHash $hyperDist 'SHA256')"

  New-JsonFile (Join-Path $projectDir "package.json") @{
    name = "h04b-fixture"
    private = $true
    version = "0.0.0"
  }
  Set-Content (Join-Path $projectDir "README.md") "# H04B installed-pair fixture" -Encoding utf8
  git -C $projectDir init
  git -C $projectDir config user.name "Visp Validation"
  git -C $projectDir config user.email "validation@invalid.local"
  git -C $projectDir add README.md package.json
  git -C $projectDir commit -m "test fixture"

  $vispBin = Join-Path $pairDir "node_modules/.bin/visp.cmd"
  $hyperBin = Join-Path $pairDir "node_modules/.bin/visp-hyper.cmd"
  & $vispBin agent bootstrap codex $projectDir --strictness strict --json
  & $hyperBin --project $projectDir init
  Assert-Equal ([string](Test-Path (Join-Path $projectDir ".visp/policy.json"))) "True" "Kit bootstrap"
  Assert-Equal ([string](Test-Path (Join-Path $projectDir ".visp/hyper/state.json"))) "True" "Hyper init"

  git -C $noKitProject init
  git -C $noKitProject config user.name "Visp Validation"
  git -C $noKitProject config user.email "validation@invalid.local"
  git -C $noKitProject commit --allow-empty -m "test fixture"
  & $hyperBin --project $noKitProject init
  $validator = Resolve-Path ".github/validation/h04b-installed-mcp-validate.mjs"
  node $validator $hyperDist $noKitProject $noKitPath
}

$RepositoryRoot = (Resolve-Path $RepositoryRoot).Path
Set-Location $RepositoryRoot
Assert-Candidate
if ($Phase -eq "Validate") {
  Invoke-Validation
}
