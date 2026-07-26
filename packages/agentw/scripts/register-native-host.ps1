param(
	[Parameter(Mandatory = $true)]
	[ValidatePattern("^[a-p]{32}$")]
	[string]$ExtensionId,

	[string]$HostPath = (Join-Path $PSScriptRoot "..\dist\agentw-host.exe")
)

$ErrorActionPreference = "Stop"
$distRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\dist"))
$resolvedHost = (Resolve-Path -LiteralPath $HostPath).Path
$distPrefix = $distRoot.TrimEnd("\") + "\"

if (-not (Test-Path -LiteralPath $resolvedHost -PathType Leaf)) {
	throw "AgentW Host is not a file: $resolvedHost"
}
if (-not $resolvedHost.StartsWith($distPrefix, [StringComparison]::OrdinalIgnoreCase)) {
	throw "AgentW Host must be inside $distRoot"
}

$agentWRoot = Join-Path $env:LOCALAPPDATA "AgentW"
New-Item -ItemType Directory -Path $agentWRoot -Force | Out-Null
$manifestPath = Join-Path $agentWRoot "com.earendil_works.agentw.json"
$templatePath = Join-Path $PSScriptRoot "..\native-host.template.json"
$manifest = Get-Content -LiteralPath $templatePath -Raw
$hostJson = $resolvedHost | ConvertTo-Json -Compress
$originJson = "chrome-extension://$ExtensionId/" | ConvertTo-Json -Compress
$manifest = $manifest.Replace('"__HOST_PATH__"', $hostJson)
$manifest = $manifest.Replace('"chrome-extension://__EDGE_EXTENSION_ID__/"', $originJson)
[IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))

$registryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.earendil_works.agentw"
New-Item -Path $registryPath -Force | Out-Null
New-ItemProperty -Path $registryPath -Name "(default)" -Value $manifestPath -PropertyType String -Force | Out-Null

Write-Output "Registered AgentW Native Host: $manifestPath"
