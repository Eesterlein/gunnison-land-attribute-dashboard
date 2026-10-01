<#
.SYNOPSIS
  One-time install of the Land Attribute Dashboard on this Windows/IIS server.

.DESCRIPTION
  Run in PowerShell as Administrator. The script:
    1. checks the prerequisites (IIS, Application Initialization, ASP.NET Core Hosting Bundle);
    2. downloads the latest release and unpacks it into the site folder;
    3. creates the IIS app pool (No Managed Code, AlwaysRunning, no idle time-out) and site (preload on);
    4. asks for the RealWare API address, username and password, and saves them in
       appsettings.Production.json, readable only by Administrators, SYSTEM and the app pool;
    5. lets the app pool write its data folder;
    6. starts the site and waits for the first data refresh to finish.

  Safe to run again: existing settings are kept unless -ResetSettings is given.

.EXAMPLE
  .\install.ps1                       # site on port 8080
.EXAMPLE
  .\install.ps1 -Port 80 -HostName landattributes.county.local
#>
param(
    [int]$Port = 8080,
    [string]$HostName = "",
    [string]$SiteName = "LandAttributeDashboard",
    [string]$AppPool = "LandAttributeDashboard",
    [string]$SiteDir = "C:\inetpub\LandAttributeDashboard",
    [string]$Version = "latest",
    [string]$Repo = "Eesterlein/gunnison-land-attribute-dashboard",
    [switch]$ResetSettings
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Step($n, $text) { Write-Host ""; Write-Host "[$n/6] $text" -ForegroundColor Cyan }

# ---------------------------------------------------------------- 1. prerequisites
Step 1 "Checking prerequisites"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Please run PowerShell as Administrator." }
if (-not (Get-Service W3SVC -ErrorAction SilentlyContinue)) { throw "IIS is not installed. Install the Web Server (IIS) role first (see docs/HOSTING.md, Step 1)." }
Import-Module WebAdministration
if (-not (Test-Path "$env:windir\System32\inetsrv\aspnetcorev2.dll")) {
    throw "The ASP.NET Core Hosting Bundle for .NET 10 is not installed. Download it from https://dotnet.microsoft.com/download/dotnet/10.0 (Hosting Bundle), install it, run 'iisreset', then run this script again."
}
if (Get-Command Get-WindowsFeature -ErrorAction SilentlyContinue) {
    if (-not (Get-WindowsFeature Web-AppInit).Installed) {
        Write-Host "   Installing IIS Application Initialization (keeps the weekly refresh running)..."
        Install-WindowsFeature Web-AppInit | Out-Null
    }
} else {
    Write-Host "   Note: make sure the IIS 'Application Initialization' feature is turned on." -ForegroundColor Yellow
}
Write-Host "   OK"

# ---------------------------------------------------------------- 2. program files
Step 2 "Downloading the dashboard ($Version) into $SiteDir"
if ($Version -eq "latest") { $url = "https://github.com/$Repo/releases/latest/download/LandAttributeDashboard.zip" }
else { $url = "https://github.com/$Repo/releases/download/$Version/LandAttributeDashboard.zip" }
$work = Join-Path $env:TEMP ("lad-install-" + (Get-Date -Format "yyyyMMddHHmmss"))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    Invoke-WebRequest -Uri $url -OutFile "$work\lad.zip" -UseBasicParsing
    Expand-Archive -Path "$work\lad.zip" -DestinationPath "$work\pkg"
    if (-not (Test-Path "$work\pkg\LadServer.dll")) { throw "The download doesn't look like a dashboard package (no LadServer.dll)." }
    Remove-Item "$work\pkg\appsettings.Production.json" -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $SiteDir -Force | Out-Null
    if (Test-Path "IIS:\AppPools\$AppPool") {
        if ((Get-WebAppPoolState -Name $AppPool).Value -ne "Stopped") { Stop-WebAppPool -Name $AppPool; Start-Sleep -Seconds 5 }
    }
    Copy-Item -Path "$work\pkg\*" -Destination $SiteDir -Recurse -Force
}
finally { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path "$SiteDir\wwwroot\data\raw" -Force | Out-Null
Write-Host "   OK"

# ---------------------------------------------------------------- 3. app pool
Step 3 "Setting up IIS app pool '$AppPool'"
if (-not (Test-Path "IIS:\AppPools\$AppPool")) { New-WebAppPool -Name $AppPool | Out-Null }
Set-ItemProperty "IIS:\AppPools\$AppPool" -Name managedRuntimeVersion -Value ""
Set-ItemProperty "IIS:\AppPools\$AppPool" -Name startMode -Value "AlwaysRunning"
Set-ItemProperty "IIS:\AppPools\$AppPool" -Name processModel.idleTimeout -Value ([TimeSpan]::Zero)
Write-Host "   OK (No Managed Code, AlwaysRunning, no idle time-out)"

# ---------------------------------------------------------------- 4. RealWare connection
Step 4 "RealWare connection settings"
$settingsPath = Join-Path $SiteDir "appsettings.Production.json"
if ((Test-Path $settingsPath) -and -not $ResetSettings) {
    Write-Host "   Keeping existing settings in $settingsPath (use -ResetSettings to enter them again)."
} else {
    Write-Host "   These come from the Assessor's Office."
    $baseUrl = (Read-Host "   RealWare API address (EncompassApiServiceURL)").Trim().TrimEnd("/")
    $user = (Read-Host "   RealWare username").Trim()
    $secure = Read-Host "   RealWare password" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $pass = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $settings = @{ Realware = @{ BaseUrl = $baseUrl; Username = $user; Password = $pass; GrantType = "password" } }
    $settings | ConvertTo-Json -Depth 3 | Set-Content -Path $settingsPath -Encoding UTF8
    $pass = $null

    # Only Administrators, SYSTEM and the app pool can read the file.
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("BUILTIN\Administrators", "FullControl", "Allow")))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("NT AUTHORITY\SYSTEM", "FullControl", "Allow")))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("IIS AppPool\$AppPool", "Read", "Allow")))
    Set-Acl -Path $settingsPath -AclObject $acl
    Write-Host "   Saved and locked down: $settingsPath"
}

# ---------------------------------------------------------------- 5. site + permissions
Step 5 "Setting up IIS site '$SiteName' and folder permissions"
if (-not (Test-Path "IIS:\Sites\$SiteName")) {
    New-Website -Name $SiteName -PhysicalPath $SiteDir -ApplicationPool $AppPool -Port $Port -HostHeader $HostName | Out-Null
}
Set-ItemProperty "IIS:\Sites\$SiteName" -Name applicationDefaults.preloadEnabled -Value $true
& icacls "$SiteDir\wwwroot\data" /grant "IIS AppPool\${AppPool}:(OI)(CI)M" | Out-Null
Write-Host "   OK (preload on; app pool can write wwwroot\data)"

# ---------------------------------------------------------------- 6. start + first refresh
Step 6 "Starting the dashboard and waiting for the first data refresh"
Start-WebAppPool -Name $AppPool -ErrorAction SilentlyContinue
Start-Website -Name $SiteName -ErrorAction SilentlyContinue
$siteHost = if ($HostName) { $HostName } else { "localhost" }
$base = "http://${siteHost}:$Port"
$status = $null
$deadline = (Get-Date).AddMinutes(5)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 10
    try { $status = Invoke-RestMethod "$base/api/status" -TimeoutSec 10 } catch { Write-Host "   waiting for the site to start..."; continue }
    if ($status.running) { Write-Host "   refreshing: $($status.step)"; continue }
    if ($status.lastRefresh -or $status.lastError) { break }
}

Write-Host ""
if ($status -and $status.lastRefresh -and -not $status.lastError) {
    Write-Host "Installed. Data refreshed at $($status.lastRefresh)." -ForegroundColor Green
    Write-Host "Open the dashboard: $base"
} elseif ($status -and $status.lastError) {
    Write-Host "Installed, but the first data refresh failed: $($status.lastError)" -ForegroundColor Yellow
    Write-Host "Fix the connection settings with:  .\install.ps1 -ResetSettings   (see docs/HOSTING.md, Troubleshooting)"
} else {
    Write-Host "Installed, but the site didn't respond at $base/api/status within 5 minutes." -ForegroundColor Yellow
    Write-Host "See docs/HOSTING.md, Troubleshooting."
}
