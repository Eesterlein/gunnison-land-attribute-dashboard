<#
.SYNOPSIS
  Installs or updates the Land Attribute Dashboard on this IIS server from a GitHub release.

.DESCRIPTION
  Downloads LandAttributeDashboard.zip for the requested version, stops the app pool, copies the
  new program and website files into the site folder, and starts the app pool again.

  Never touched: appsettings.Production.json (RealWare connection + login) and wwwroot\data\raw\
  (the saved RealWare data). The dashboard comes back already connected.

.EXAMPLE
  .\update.ps1                      # latest release
.EXAMPLE
  .\update.ps1 -Version v1.0        # a specific version (also how to roll back)
#>
param(
    [string]$Version = "latest",
    [string]$SiteDir = "C:\inetpub\LandAttributeDashboard",
    [string]$AppPool = "LandAttributeDashboard",
    [string]$Repo = "Eesterlein/gunnison-land-attribute-dashboard",
    [string]$StatusUrl = ""          # optional, e.g. http://localhost/api/status
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Import-Module WebAdministration

if (-not (Test-Path $SiteDir)) { throw "Site folder $SiteDir not found. Pass -SiteDir if it is somewhere else." }
if (-not (Test-Path "IIS:\AppPools\$AppPool")) { throw "App pool '$AppPool' not found. Pass -AppPool with the right name." }

if ($Version -eq "latest") { $url = "https://github.com/$Repo/releases/latest/download/LandAttributeDashboard.zip" }
else { $url = "https://github.com/$Repo/releases/download/$Version/LandAttributeDashboard.zip" }
$work = Join-Path $env:TEMP ("lad-update-" + (Get-Date -Format "yyyyMMddHHmmss"))
New-Item -ItemType Directory -Path $work | Out-Null

try {
    Write-Host "1/4 Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile "$work\lad.zip" -UseBasicParsing
    Expand-Archive -Path "$work\lad.zip" -DestinationPath "$work\pkg"
    if (-not (Test-Path "$work\pkg\LadServer.dll")) { throw "The download doesn't look like a dashboard package (no LadServer.dll)." }
    # Belt and braces: never overwrite server-specific settings or saved data.
    Remove-Item "$work\pkg\appsettings.Production.json" -ErrorAction SilentlyContinue
    if (Test-Path "$work\pkg\wwwroot\data\raw") { Remove-Item "$work\pkg\wwwroot\data\raw" -Recurse -Force }

    Write-Host "2/4 Stopping app pool '$AppPool'"
    if ((Get-WebAppPoolState -Name $AppPool).Value -ne "Stopped") { Stop-WebAppPool -Name $AppPool }
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-WebAppPoolState -Name $AppPool).Value -ne "Stopped" -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }

    try {
        Write-Host "3/4 Copying new files into $SiteDir (settings and saved data are kept)"
        for ($attempt = 1; ; $attempt++) {
            try { Copy-Item -Path "$work\pkg\*" -Destination $SiteDir -Recurse -Force; break }
            catch { if ($attempt -ge 5) { throw }; Write-Host "   files still in use, retrying..."; Start-Sleep -Seconds 3 }
        }
    }
    finally {
        Write-Host "4/4 Starting app pool '$AppPool'"
        Start-WebAppPool -Name $AppPool
    }

    $ver = Get-Content "$SiteDir\wwwroot\version.json" -Raw -ErrorAction SilentlyContinue
    Write-Host "Done. Installed: $ver"
    if ($StatusUrl) {
        Start-Sleep -Seconds 5
        Write-Host "Status:"; Invoke-RestMethod $StatusUrl | Format-List
    }
    Write-Host "Reload the dashboard with Ctrl+F5 to see the new version."
}
finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
