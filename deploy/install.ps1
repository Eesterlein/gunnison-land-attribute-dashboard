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
.EXAMPLE
  .\install.ps1 -SetToken             # first: save the GitHub token for the private county repository

  The county repository is private, so downloads use a read-only GitHub token saved in
  C:\ProgramData\LandAttributeDashboard\github-token.txt. Or use -ZipPath with a zip downloaded by hand.
#>
param(
    [int]$Port = 8080,
    [string]$HostName = "",
    [string]$SiteName = "LandAttributeDashboard",
    [string]$AppPool = "LandAttributeDashboard",
    [string]$SiteDir = "C:\inetpub\LandAttributeDashboard",
    [string]$Version = "latest",
    [string]$Repo = "Gunnison-County/GC-Assessor-RealWareDashboard",
    [string]$TokenFile = "$env:ProgramData\LandAttributeDashboard\github-token.txt",
    [string]$ZipPath = "",
    [switch]$SetToken,
    [switch]$ResetSettings
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# web.config and appsettings.json may hold the server's own changes (IIS rules, headers, logging,
# AllowedHosts). If the site already has them, keep them; if the package's copy differs, save it
# next to the server's copy as <name>.new for comparison instead of overwriting.
function Keep-ServerFiles($pkg, $site) {
    foreach ($f in "web.config", "appsettings.json") {
        $new = Join-Path $pkg $f; $cur = Join-Path $site $f
        if (-not (Test-Path $new) -or -not (Test-Path $cur)) { continue }
        if ((Get-FileHash $new).Hash -ne (Get-FileHash $cur).Hash) {
            Copy-Item $new "$cur.new" -Force
            Write-Host "   Kept the server's $f. This version's copy is saved as $f.new if you want to compare." -ForegroundColor Yellow
        }
        Remove-Item $new
    }
}

# ---- Downloading a release (kept the same in install.ps1 and update.ps1) ----------------------
# The county repository is private, so releases are fetched through the GitHub API with a read-only
# token saved on this server (see -SetToken). Without a token, the public download link is tried,
# which works only for a public repository. The token is only ever sent to api.github.com over
# HTTPS, never to the download host GitHub redirects to. Every package is checked against the
# release's SHA256SUMS.txt before anything is installed.

function Save-LadUrl([string]$Url, [string]$OutFile, [string]$Token, [string]$Accept) {
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(10)
    try {
        for ($hop = 0; $hop -lt 5; $hop++) {
            $uri = [Uri]$Url
            $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $uri)
            $req.Headers.UserAgent.ParseAdd("LandAttributeDashboard-updater")
            if ($Accept) { $req.Headers.Accept.ParseAdd($Accept) }
            if ($Token -and $uri.Scheme -eq "https" -and $uri.Host -eq "api.github.com") {
                $req.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", $Token)
                $req.Headers.Add("X-GitHub-Api-Version", "2022-11-28")
            }
            $resp = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            try {
                $code = [int]$resp.StatusCode
                if ($code -ge 300 -and $code -lt 400 -and $resp.Headers.Location) {
                    $Url = (New-Object System.Uri($uri, $resp.Headers.Location)).AbsoluteUri
                    continue
                }
                if ($code -eq 200) {
                    $fs = [IO.File]::Create($OutFile)
                    try { $null = $resp.Content.CopyToAsync($fs).GetAwaiter().GetResult() } finally { $fs.Dispose() }
                }
                return $code
            }
            finally { $resp.Dispose() }
        }
        throw "Too many redirects while downloading from GitHub."
    }
    finally { $client.Dispose() }
}

function Get-LadToken([string]$TokenFile) {
    if (-not $TokenFile -or -not (Test-Path $TokenFile)) { return $null }
    $t = "$(Get-Content $TokenFile -Raw)".Trim()
    if ($t) { return $t } else { return $null }
}

function Get-LadHttpMessage([int]$Code, [string]$Repo, [string]$Version) {
    $owner = ($Repo -split "/")[0]
    switch ($Code) {
        401 { return "GitHub didn't accept the saved token (HTTP 401). It has probably expired or been revoked. Create a new one and save it with:  .\update.ps1 -SetToken" }
        403 { return "GitHub refused the request (HTTP 403). The token may still be waiting for approval by the $owner organization (organization Settings > Personal access tokens), or GitHub is limiting requests; try again in an hour." }
        404 {
            if ($Version -eq "latest") { return "No release was found in $Repo, or the token can't see that repository (HTTP 404). Check that the token's repository access includes $Repo." }
            return "Version $Version wasn't found in $Repo, or the token can't see that repository (HTTP 404). Check the version name (for example v1.5) and the token's repository access."
        }
        default { return "GitHub returned HTTP $Code for $Repo." }
    }
}

function Test-LadChecksum([string]$Zip, [string]$Sums) {
    $line = Get-Content $Sums | Where-Object { $_ -match '\s\*?LandAttributeDashboard\.zip\s*$' } | Select-Object -First 1
    if (-not $line) { Write-Host "   SHA256SUMS.txt doesn't list the zip, so the checksum wasn't checked." -ForegroundColor Yellow; return }
    $expected = ($line.Trim() -split '\s+')[0].ToUpper()
    $actual = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToUpper()
    if ($actual -ne $expected) { throw "Checksum mismatch: the zip doesn't match SHA256SUMS.txt, so nothing was installed. Download it again." }
    Write-Host "   Checksum OK"
}

# Returns the path of a checked LandAttributeDashboard.zip.
function Get-LadPackage([string]$Repo, [string]$Version, [string]$TokenFile, [string]$ZipPath, [string]$Work) {
    if ($ZipPath) {
        if (-not (Test-Path $ZipPath)) { throw "Zip file $ZipPath not found." }
        $zip = (Resolve-Path $ZipPath).Path
        $sums = Join-Path (Split-Path $zip) "SHA256SUMS.txt"
        Write-Host "   Using $zip"
        if (Test-Path $sums) { Test-LadChecksum $zip $sums }
        else { Write-Host "   No SHA256SUMS.txt next to the zip, so the checksum wasn't checked. Download it from the same release to check it." -ForegroundColor Yellow }
        return $zip
    }
    $zip = Join-Path $Work "LandAttributeDashboard.zip"
    $sums = Join-Path $Work "SHA256SUMS.txt"
    $token = Get-LadToken $TokenFile
    if ($token) {
        $which = if ($Version -eq "latest") { "latest" } else { "tags/$Version" }
        $code = Save-LadUrl "https://api.github.com/repos/$Repo/releases/$which" (Join-Path $Work "release.json") $token "application/vnd.github+json"
        if ($code -ne 200) { throw (Get-LadHttpMessage $code $Repo $Version) }
        $release = Get-Content (Join-Path $Work "release.json") -Raw | ConvertFrom-Json
        Write-Host "   $Repo, release $($release.tag_name) (signed in with the saved token)"
        foreach ($name in "LandAttributeDashboard.zip", "SHA256SUMS.txt") {
            $asset = $release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
            if (-not $asset) {
                if ($name -eq "SHA256SUMS.txt") { continue }
                throw "Release $($release.tag_name) has no LandAttributeDashboard.zip."
            }
            $code = Save-LadUrl $asset.url (Join-Path $Work $name) $token "application/octet-stream"
            if ($code -ne 200) { throw "Couldn't download $name from release $($release.tag_name) (HTTP $code)." }
        }
    }
    else {
        $base = if ($Version -eq "latest") { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/$Version" }
        Write-Host "   $base (no token saved)"
        $code = Save-LadUrl "$base/LandAttributeDashboard.zip" $zip $null $null
        if ($code -eq 404) {
            throw "Couldn't download from $Repo (HTTP 404). The repository is probably private: save a GitHub token with  .\update.ps1 -SetToken  and run this again. Or download LandAttributeDashboard.zip and SHA256SUMS.txt from the release page in a browser and run with  -ZipPath <path to the zip>."
        }
        if ($code -ne 200) { throw "Couldn't download from $Repo (HTTP $code)." }
        $null = Save-LadUrl "$base/SHA256SUMS.txt" $sums $null $null
    }
    if (Test-Path $sums) { Test-LadChecksum $zip $sums }
    else { Write-Host "   This release has no SHA256SUMS.txt (versions before v1.2), so the checksum wasn't checked." -ForegroundColor Yellow }
    return $zip
}

# Asks for a GitHub token, saves it where only Administrators and SYSTEM can read it, and tests it.
function Set-LadToken([string]$TokenFile, [string]$Repo) {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) { throw "Please run PowerShell as Administrator to save the token." }
    $secure = Read-Host "Paste the GitHub token for $Repo (it isn't shown)" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $t = "$([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr))".Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if (-not $t) { throw "No token entered; nothing was saved." }

    # Lock the folder first so the file is never readable by other users, even briefly.
    $dir = Split-Path $TokenFile
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($who in "BUILTIN\Administrators", "NT AUTHORITY\SYSTEM") {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")))
    }
    Set-Acl -Path $dir -AclObject $acl
    Set-Content -Path $TokenFile -Value $t -NoNewline -Encoding ASCII
    $t = $null
    Write-Host "Saved to $TokenFile (readable only by Administrators and SYSTEM)."

    $tmp = Join-Path $env:TEMP ("lad-token-test-" + (Get-Date -Format "yyyyMMddHHmmss") + ".json")
    try {
        $code = Save-LadUrl "https://api.github.com/repos/$Repo/releases/latest" $tmp (Get-LadToken $TokenFile) "application/vnd.github+json"
        if ($code -eq 200) { Write-Host "The token works. Latest release in ${Repo}: $((Get-Content $tmp -Raw | ConvertFrom-Json).tag_name)" -ForegroundColor Green }
        else { Write-Host "The token was saved, but the test didn't work: $(Get-LadHttpMessage $code $Repo 'latest')" -ForegroundColor Yellow }
    }
    finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}
# ------------------------------------------------------------------------------------------------

function Step($n, $text) { Write-Host ""; Write-Host "[$n/6] $text" -ForegroundColor Cyan }

if ($SetToken) { Set-LadToken $TokenFile $Repo; return }

# ---------------------------------------------------------------- 1. prerequisites
Step 1 "Checking prerequisites"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Please run PowerShell as Administrator." }
if (-not (Get-Service W3SVC -ErrorAction SilentlyContinue)) { throw "IIS is not installed. Install the Web Server (IIS) role first (see docs/HOSTING.md, Step 1)." }
Import-Module WebAdministration
$ancm = @("$env:ProgramFiles\IIS\Asp.Net Core Module\V2\aspnetcorev2.dll", "$env:windir\System32\inetsrv\aspnetcorev2.dll")
if (-not ($ancm | Where-Object { Test-Path $_ })) {
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
$work = Join-Path $env:TEMP ("lad-install-" + (Get-Date -Format "yyyyMMddHHmmss"))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $zip = Get-LadPackage -Repo $Repo -Version $Version -TokenFile $TokenFile -ZipPath $ZipPath -Work $work
    Expand-Archive -Path $zip -DestinationPath "$work\pkg"
    if (-not (Test-Path "$work\pkg\LadServer.dll")) { throw "The download doesn't look like a dashboard package (no LadServer.dll)." }
    # Never overwrite server-specific settings or saved data (same as update.ps1).
    Remove-Item "$work\pkg\appsettings.Production.json" -ErrorAction SilentlyContinue
    if (Test-Path "$work\pkg\wwwroot\data\raw") { Remove-Item "$work\pkg\wwwroot\data\raw" -Recurse -Force }
    New-Item -ItemType Directory -Path $SiteDir -Force | Out-Null
    Keep-ServerFiles "$work\pkg" $SiteDir
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
    $realware = @{ BaseUrl = $baseUrl; Username = $user; Password = $pass; GrantType = "password" }
    if ($baseUrl -notmatch '^https://') {
        Write-Host "   This address isn't https://, so the RealWare password would be sent unencrypted." -ForegroundColor Yellow
        $ok = Read-Host "   Allow http:// anyway, until RealWare has HTTPS? (y/N)"
        if ($ok -match '^(y|yes)$') { $realware.AllowInsecureHttp = $true }
        else { Write-Host "   Not allowed: refreshes will fail until the address is https:// (run with -ResetSettings to change it)." -ForegroundColor Yellow }
    }
    $settings = @{ Realware = $realware }
    # Only answer requests for this site's own host name (ASP.NET Core host filtering).
    if ($HostName) { $settings.AllowedHosts = $HostName }
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
