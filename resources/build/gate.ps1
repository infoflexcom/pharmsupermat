# Infoflex installer gate — password verifier.
#
# Called by installer.nsh from the NSIS temporary plugin folder:
#
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass ^
#       -File gate.ps1 -Salt <hex> -Iterations <n> -Hash <hex> [-LegacyHash <hex>]
#
# The candidate password is NOT passed on the command line (that would put it in
# the process list). The installer puts it in the INFOFLEX_GATE_PASSWORD process
# environment variable, reads it here and clears it right after.
#
# Output (stdout, no newline):
#   GATE_OK      the password matches Hash or LegacyHash
#   GATE_DENIED  it does not
#   GATE_NO_INPUT  no candidate was supplied
#   GATE_ERROR   the verifier itself could not run (installer fails closed)
#
# This file contains no secret. The salt, the iteration count and the expected
# PBKDF2 digests are compiled into the installer by scripts/make-installer-gate.ts
# from the VENDOR_MASTER_PASSWORD environment variable and are never committed.

param(
  [Parameter(Mandatory = $true)][string] $Salt,
  [Parameter(Mandatory = $true)][int] $Iterations,
  [Parameter(Mandatory = $true)][string] $Hash,
  [string] $LegacyHash = ''
)

$ErrorActionPreference = 'Stop'

function ConvertFrom-Hex([string] $hex) {
  $clean = $hex.Trim()
  if ($clean.Length % 2 -ne 0) { throw 'salt is not whole bytes' }
  $bytes = New-Object byte[] ($clean.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    $bytes[$i] = [Convert]::ToByte($clean.Substring($i * 2, 2), 16)
  }
  return $bytes
}

function ConvertTo-Hex([byte[]] $bytes) {
  $builder = New-Object System.Text.StringBuilder
  foreach ($b in $bytes) { [void]$builder.Append($b.ToString('x2')) }
  return $builder.ToString()
}

function Get-Pbkdf2([string] $password, [byte[]] $salt, [int] $iterations, [bool] $sha256) {
  # .NET Framework's 3-argument constructor is PBKDF2-HMAC-SHA1 and exists on
  # every Windows that can run the app; the 4-argument overload (chosen hash)
  # needs .NET 4.7.2+. Both are offered so an old runtime cannot lock a customer
  # out, and both digests are minted at build time by the same parameters.
  if ($sha256) {
    $derive = New-Object System.Security.Cryptography.Rfc2898DeriveBytes(
      $password, $salt, $iterations, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
  } else {
    $derive = New-Object System.Security.Cryptography.Rfc2898DeriveBytes(
      $password, $salt, $iterations)
  }
  try { return $derive.GetBytes(32) } finally { $derive.Dispose() }
}

function Test-Hex([byte[]] $actual, [string] $expected) {
  if ([string]::IsNullOrWhiteSpace($expected)) { return $false }
  return [string]::Equals((ConvertTo-Hex $actual), $expected.Trim(), [StringComparison]::OrdinalIgnoreCase)
}

try {
  $password = [Environment]::GetEnvironmentVariable('INFOFLEX_GATE_PASSWORD', 'Process')
  if ([string]::IsNullOrEmpty($password)) {
    [Console]::Out.Write('GATE_NO_INPUT')
    exit 2
  }

  $saltBytes = ConvertFrom-Hex $Salt

  $ok = $false
  try {
    if (Test-Hex (Get-Pbkdf2 $password $saltBytes $Iterations $true) $Hash) { $ok = $true }
  } catch [System.ArgumentException] {
    # The runtime predates the hash-algorithm overload; the legacy digest below
    # still runs, so only that comparison matters on such machines.
  } catch [System.Management.Automation.MethodException] {
    # Same case, surfaced differently by older PowerShell hosts.
  }
  if (-not $ok -and -not [string]::IsNullOrWhiteSpace($LegacyHash)) {
    if (Test-Hex (Get-Pbkdf2 $password $saltBytes $Iterations $false) $LegacyHash) { $ok = $true }
  }

  [Environment]::SetEnvironmentVariable('INFOFLEX_GATE_PASSWORD', $null, 'Process')
  [Console]::Out.Write($(if ($ok) { 'GATE_OK' } else { 'GATE_DENIED' }))
  exit 0
} catch {
  [Environment]::SetEnvironmentVariable('INFOFLEX_GATE_PASSWORD', $null, 'Process')
  [Console]::Out.Write('GATE_ERROR')
  exit 3
}
