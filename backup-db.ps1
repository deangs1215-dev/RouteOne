# Pull RouteOne backups off the test server onto the laptop, over the mapped
# Z: drive. There is no SSH to the server.
#
# This copies backups the SERVER has already taken - it cannot create one,
# because a consistent snapshot has to be made by the running app. Take a fresh
# one first in RDP:
#
#     cd C:\RouteOne
#     npm run backup
#
# Usage: .\backup-db.ps1              copy the newest backup
#        .\backup-db.ps1 -All         copy every backup not already held locally

param(
    [string]$ServerDrive = "Z:",
    [string]$LocalPath   = "C:\RouteOne_Backups",
    [switch]$All         = $false
)

$ErrorActionPreference = "Stop"

function Log {
    param([string]$Message, [string]$Color = "White")
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $Message" -ForegroundColor $Color
}

if (-not (Test-Path $ServerDrive)) {
    Log "Server drive $ServerDrive not mapped." "Red"
    Log "  net use Z: \\192.168.0.22\c`$\RouteOne /persistent:yes" "Gray"
    exit 1
}

$remoteBackups = Join-Path $ServerDrive "server\backups"
if (-not (Test-Path $remoteBackups)) {
    Log "No backups directory at $remoteBackups." "Red"
    Log "Take one in RDP first: cd C:\RouteOne; npm run backup" "Gray"
    exit 1
}

if (-not (Test-Path $LocalPath)) {
    New-Item -ItemType Directory -Path $LocalPath -Force | Out-Null
    Log "Created $LocalPath" "Cyan"
}

$available = @(Get-ChildItem $remoteBackups -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending)

if (-not $available.Count) {
    Log "No backups on the server yet." "Yellow"
    Log "Take one in RDP: cd C:\RouteOne; npm run backup" "Gray"
    exit 1
}

$toCopy = if ($All) { $available } else { @($available[0]) }

Log "Server has $($available.Count) backup(s); copying $($toCopy.Count)." "Cyan"

$copied = 0
foreach ($item in $toCopy) {
    $target = Join-Path $LocalPath $item.Name
    if (Test-Path $target) {
        Log "  skip  $($item.Name) (already held)" "DarkGray"
        continue
    }
    Log "  copy  $($item.Name)" "White"
    Copy-Item -Path $item.FullName -Destination $target -Recurse -Force
    $copied++
}

Log "`nCopied $copied backup(s) to $LocalPath" "Green"

$newest = $available[0]
$age = (New-TimeSpan -Start $newest.LastWriteTime -End (Get-Date)).TotalHours
if ($age -gt 48) {
    Log "WARN - newest server backup is $([Math]::Round($age)) hours old." "Yellow"
    Log "Check the schedule under Settings -> Backups." "Yellow"
}
