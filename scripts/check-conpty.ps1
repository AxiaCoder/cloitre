<#
.SYNOPSIS
Checks that the bundled ConPTY files are the expected, Microsoft-signed release.

.DESCRIPTION
For each file under the ConPTY folder, fails with a non-zero exit code when the
Authenticode signature is not Valid, the signer is not Microsoft Corporation,
the file version differs from $ExpectedVersion, or the SHA-256 differs from the
value listed in $ExpectedFiles. Updating ConPTY means updating both values below.

.PARAMETER Root
Folder holding conpty.dll and x64/OpenConsole.exe. Defaults to vendor/conpty.
#>
param(
    [string]$Root = (Join-Path $PSScriptRoot '..\vendor\conpty')
)

# NuGet Microsoft.Windows.Console.ConPTY 1.25.260930003
$ExpectedVersion = '1.25.2609.30003'
$ExpectedFiles = [ordered]@{
    'conpty.dll'          = 'feeef341d891643c62d30b6b07800bc70f0bc148f44cb8c3bee84aa557ae805a'
    'x64/OpenConsole.exe' = '3d66b23d0a71bb8eed2b77edc8b9df9bf54ce6c8fb74c863a30e760997f80586'
}
$ExpectedSignerOrganization = 'O=Microsoft Corporation'

$ErrorActionPreference = 'Stop'
$failures = @()

foreach ($name in $ExpectedFiles.Keys) {
    $path = Join-Path $Root $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $failures += "${name}: file not found"
        continue
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne 'Valid') {
        $failures += "${name}: Authenticode signature is $($signature.Status), expected Valid"
    }
    $subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
    if (($subject -split ',\s*') -notcontains $ExpectedSignerOrganization) {
        $failures += "${name}: signer is '$subject', expected $ExpectedSignerOrganization"
    }

    $version = (Get-Item -LiteralPath $path).VersionInfo.FileVersionRaw
    if ("$version" -ne $ExpectedVersion) {
        $failures += "${name}: file version is '$version', expected $ExpectedVersion"
    }

    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $ExpectedFiles[$name]) {
        $failures += "${name}: SHA-256 is $hash, expected $($ExpectedFiles[$name])"
    }
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Host "conpty check failed: $_" }
    exit 1
}
Write-Host "conpty check passed: $($ExpectedFiles.Count) files, version $ExpectedVersion, signed by Microsoft Corporation"
