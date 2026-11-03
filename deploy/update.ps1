<#
.SYNOPSIS
  Installs or updates the Land Attribute Dashboard on this IIS server from a GitHub release.

.DESCRIPTION
  Downloads LandAttributeDashboard.zip for the requested version from the county GitHub repository,
  checks it against the release's SHA256SUMS.txt, stops the app pool, copies the new program and
  website files into the site folder, and starts the app pool again.

  The county repository is private, so the download uses a read-only GitHub token saved on this
  server in C:\ProgramData\LandAttributeDashboard\github-token.txt. Save or replace it with -SetToken.

  Never touched: appsettings.Production.json (RealWare connection + login) and wwwroot\data\raw\
  (the saved RealWare data). The dashboard comes back already connected.
  Kept if already present: web.config and appsettings.json, so the server's own changes survive.
  If this version's copy differs, it is saved alongside as web.config.new / appsettings.json.new.

.EXAMPLE
  .\update.ps1                      # latest release
.EXAMPLE
  .\update.ps1 -Version v1.5        # a specific version (also how to roll back)
.EXAMPLE
  .\update.ps1 -SetToken            # save or replace the GitHub token, then test it
.EXAMPLE
  .\update.ps1 -ZipPath C:\Downloads\LandAttributeDashboard.zip   # install a zip downloaded by hand
#>
param(
    [string]$Version = "latest",
    [string]$SiteDir = "C:\inetpub\LandAttributeDashboard",
    [string]$AppPool = "LandAttributeDashboard",
    [string]$Repo = "Gunnison-County/GC-Assessor-RealWareDashboard",
    [string]$TokenFile = "$env:ProgramData\LandAttributeDashboard\github-token.txt",
    [string]$ZipPath = "",           # install this zip instead of downloading
    [switch]$SetToken,               # save the GitHub token, test it, and stop
    [string]$StatusUrl = ""          # optional, e.g. http://localhost/api/status
)

$ErrorActionPreference = "Stop"
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

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($SetToken) { Set-LadToken $TokenFile $Repo; return }
Import-Module WebAdministration

if (-not (Test-Path $SiteDir)) { throw "Site folder $SiteDir not found. Pass -SiteDir if it is somewhere else." }
if (-not (Test-Path "IIS:\AppPools\$AppPool")) { throw "App pool '$AppPool' not found. Pass -AppPool with the right name." }

$work = Join-Path $env:TEMP ("lad-update-" + (Get-Date -Format "yyyyMMddHHmmss"))
New-Item -ItemType Directory -Path $work | Out-Null

try {
    Write-Host "1/4 Getting the package ($Version)"
    $zip = Get-LadPackage -Repo $Repo -Version $Version -TokenFile $TokenFile -ZipPath $ZipPath -Work $work
    Expand-Archive -Path $zip -DestinationPath "$work\pkg"
    if (-not (Test-Path "$work\pkg\LadServer.dll")) { throw "The download doesn't look like a dashboard package (no LadServer.dll)." }
    # Belt and braces: never overwrite server-specific settings or saved data.
    Remove-Item "$work\pkg\appsettings.Production.json" -ErrorAction SilentlyContinue
    if (Test-Path "$work\pkg\wwwroot\data\raw") { Remove-Item "$work\pkg\wwwroot\data\raw" -Recurse -Force }
    Keep-ServerFiles "$work\pkg" $SiteDir

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
        # From v1.2, searches.json lives in config\ next to the program, not under wwwroot\. Remove the old copy.
        if ((Test-Path "$SiteDir\config\searches.json") -and (Test-Path "$SiteDir\wwwroot\config")) {
            Remove-Item "$SiteDir\wwwroot\config" -Recurse -Force
        }
    }
    finally {
        Write-Host "4/4 Starting app pool '$AppPool'"
        Start-WebAppPool -Name $AppPool
    }

    # From v1.2, an http:// RealWare address is refused unless Realware:AllowInsecureHttp is true.
    $prod = "$SiteDir\appsettings.Production.json"
    if (Test-Path $prod) {
        $rw = (Get-Content $prod -Raw | ConvertFrom-Json).Realware
        if ($rw -and "$($rw.BaseUrl)" -match '^http://' -and -not $rw.AllowInsecureHttp) {
            Write-Host "WARNING: the RealWare address in appsettings.Production.json is http://, and this version refuses that by default." -ForegroundColor Yellow
            Write-Host "         Refreshes will fail until you either switch it to https:// or add  ""AllowInsecureHttp"": true  under ""Realware"", then recycle the app pool." -ForegroundColor Yellow
        }
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
