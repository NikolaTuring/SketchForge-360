#Requires -Version 5.1
<#
.SYNOPSIS
    Richtet SketchForge auf einem Windows-PC ein und startet es.

.DESCRIPTION
    Prüft Git und Node, installiert sie bei Bedarf über winget, holt das
    Projekt, installiert die Abhängigkeiten und startet den Entwicklungsserver.

    Das Skript ist mehrfach ausführbar: ein zweiter Lauf aktualisiert ein
    vorhandenes Verzeichnis, statt sich zu beschweren. Es installiert nichts,
    was schon da ist, und ändert nichts an der Maschine, was es nicht muss.

.PARAMETER Path
    Zielverzeichnis. Vorgabe: Dokumente\SketchForge-360.

.PARAMETER Branch
    Zu holender Zweig. Vorgabe: main.

.PARAMETER SkipStart
    Nur einrichten, nicht starten.

.PARAMETER RunTests
    Nach dem Einrichten die 380 Unit-Tests laufen lassen (rund 5 Sekunden).

.EXAMPLE
    .\install-windows.ps1

.EXAMPLE
    .\install-windows.ps1 -Path D:\CAD\SketchForge -RunTests
#>
[CmdletBinding()]
param(
    [string]$Path = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'SketchForge-360'),
    [string]$Branch = 'main',
    [switch]$SkipStart,
    [switch]$RunTests
)

# Ein Fehler soll das Skript anhalten, nicht stillschweigend weiterlaufen und
# später an einer unverständlichen Stelle scheitern.
$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://github.com/NikolaTuring/SketchForge-360.git'
$MinNodeMajor = 20
$Port = 3000

# --- Ausgabe ---------------------------------------------------------------

function Write-Step { param([string]$Text) Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host "   $Text" -ForegroundColor Green }
function Write-Info { param([string]$Text) Write-Host "   $Text" -ForegroundColor Gray }
function Write-Warn { param([string]$Text) Write-Host "   $Text" -ForegroundColor Yellow }

function Stop-WithReason {
    param([string]$Reason, [string]$Fix)
    Write-Host "`nAbgebrochen: $Reason" -ForegroundColor Red
    if ($Fix) { Write-Host "So geht es weiter: $Fix" -ForegroundColor Yellow }
    exit 1
}

# --- Werkzeuge -------------------------------------------------------------

<#
    Liest PATH neu aus der Registry ein.

    Nach einer winget-Installation kennt die laufende PowerShell-Sitzung den
    neuen Befehl noch nicht — ihre Umgebung wurde beim Start kopiert. Ohne das
    hier müsste man das Fenster schließen und das Skript noch einmal starten,
    und genau daran scheitern die meisten Anleitungen.
#>
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = ($machine, $user | Where-Object { $_ }) -join ';'
}

<#
    Führt ein externes Programm aus und hält an, wenn es scheitert.

    `$ErrorActionPreference = 'Stop'` greift bei externen Programmen nicht — git
    und npm melden Fehler über ihren Rückgabewert, nicht über eine Ausnahme.
    Ohne diese Prüfung liefe ein fehlgeschlagenes `git clone` stumm weiter und
    scheiterte erst zwei Schritte später an etwas Unverständlichem.
#>
function Invoke-Checked {
    param([string]$What, [scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) {
        Stop-WithReason "$What ist fehlgeschlagen (Code $LASTEXITCODE)." `
            'Führe den Befehl von Hand aus, um die vollständige Meldung zu sehen.'
    }
}

function Test-Command {
    param([string]$Name)
    Update-SessionPath
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-WithWinget {
    param([string]$PackageId, [string]$Label)

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Stop-WithReason `
            "$Label fehlt und winget ist nicht verfügbar." `
            "Installiere 'App Installer' aus dem Microsoft Store, öffne PowerShell neu und starte das Skript erneut."
    }

    Write-Info "$Label wird installiert. Windows fragt gleich nach Administratorrechten."
    # --silent hält die Installation ohne Rückfragen durch; die Zustimmung zu
    # den Quellbedingungen ist nötig, weil winget sonst interaktiv nachfragt und
    # das Skript hängen bliebe.
    winget install --id $PackageId --exact --silent `
        --accept-package-agreements --accept-source-agreements | Out-Null

    Update-SessionPath
}

# --- Schritt 1: Ausführungsrichtlinie --------------------------------------

Write-Step 'Ausführungsrichtlinie prüfen'

$policy = Get-ExecutionPolicy -Scope CurrentUser
if ($policy -in @('Restricted', 'AllSigned', 'Undefined')) {
    # npm liegt als npm.ps1 vor, und die Standardrichtlinie von Windows
    # blockiert es. RemoteSigned erlaubt lokale Skripte und lässt
    # Heruntergeladenes weiterhin gesperrt — der übliche Kompromiss.
    Write-Info 'Lokale Skripte werden für deinen Benutzer erlaubt (RemoteSigned).'
    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force
    Write-Ok 'Gesetzt.'
} else {
    Write-Ok "Bereits in Ordnung ($policy)."
}

# --- Schritt 2: Git ---------------------------------------------------------

Write-Step 'Git prüfen'

if (Test-Command 'git') {
    Write-Ok (git --version)
} else {
    Install-WithWinget -PackageId 'Git.Git' -Label 'Git'
    if (-not (Test-Command 'git')) {
        Stop-WithReason 'Git wurde installiert, ist aber noch nicht auffindbar.' `
            'Schließe PowerShell, öffne es neu und starte das Skript noch einmal.'
    }
    Write-Ok (git --version)
}

# --- Schritt 3: Node --------------------------------------------------------

Write-Step 'Node.js prüfen'

$nodeMajor = 0
if (Test-Command 'node') {
    if ((node --version) -match 'v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
}

if ($nodeMajor -ge $MinNodeMajor) {
    Write-Ok "Node $(node --version)"
} else {
    if ($nodeMajor -gt 0) {
        Write-Warn "Node $(node --version) ist zu alt; gebraucht wird mindestens $MinNodeMajor."
    }
    Install-WithWinget -PackageId 'OpenJS.NodeJS.LTS' -Label 'Node.js LTS'

    if (-not (Test-Command 'node')) {
        Stop-WithReason 'Node wurde installiert, ist aber noch nicht auffindbar.' `
            'Schließe PowerShell, öffne es neu und starte das Skript noch einmal.'
    }
    if ((node --version) -match 'v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
    if ($nodeMajor -lt $MinNodeMajor) {
        Stop-WithReason "Es ist weiterhin Node $(node --version) aktiv." `
            'Deinstalliere alte Node-Versionen über "Apps & Features" und starte das Skript erneut.'
    }
    Write-Ok "Node $(node --version)"
}

# --- Schritt 4: Projekt holen ----------------------------------------------

Write-Step 'Projekt holen'

# Leerzeichen und Umlaute im Pfad bringen einige Node-Werkzeuge durcheinander.
# Das früh zu sagen ist billiger, als es später an einer Fehlermeldung über eine
# fehlende Datei zu erraten.
if ($Path -match '[^\u0000-\u007F]' -or $Path -match ' ') {
    Write-Warn "Der Pfad enthält Leerzeichen oder Sonderzeichen: $Path"
    Write-Warn 'Das geht meistens gut, kann aber einzelne Werkzeuge stören.'
}

if (Test-Path (Join-Path $Path '.git')) {
    Write-Info 'Verzeichnis existiert bereits; es wird aktualisiert.'
    Push-Location $Path
    try {
        # Lokale Änderungen bleiben unangetastet: ein Abbruch hier ist die
        # richtige Antwort, denn sie gehören dem Nutzer, nicht dem Skript.
        if ((git status --porcelain)) {
            Write-Warn 'Es liegen ungespeicherte Änderungen vor; sie bleiben erhalten.'
            Write-Warn 'Der Zweig wird deshalb nicht gewechselt.'
        } else {
            Invoke-Checked 'git fetch' { git fetch origin $Branch --quiet }
            Invoke-Checked 'git checkout' { git checkout $Branch --quiet }
            # --ff-only: lieber abbrechen als still einen Merge bauen, falls der
            # lokale Stand vom entfernten abgewichen ist.
            Invoke-Checked 'git pull' { git pull --ff-only origin $Branch --quiet }
            Write-Ok "Auf dem Stand von $Branch."
        }
    } finally {
        Pop-Location
    }
} elseif (Test-Path $Path) {
    Stop-WithReason "$Path existiert, ist aber kein Projektverzeichnis." `
        'Wähle mit -Path einen anderen Ort oder benenne den vorhandenen Ordner um.'
} else {
    Write-Info "Wird nach $Path geholt (rund 60 MB)."
    Invoke-Checked 'git clone' { git clone --branch $Branch $RepoUrl $Path --quiet }
    Write-Ok 'Geholt.'
}

Set-Location $Path

# --- Schritt 5: Abhängigkeiten ---------------------------------------------

Write-Step 'Abhängigkeiten installieren'
Write-Info 'Das dauert einige Minuten und lädt rund 500 MB — der CAD-Kernel ist groß.'

# `npm ci` statt `npm install`: es installiert exakt die Versionen aus der
# Sperrdatei. Damit läuft hier dieselbe Kombination wie in der Prüfung, statt
# einer, die npm heute für passend hält.
npm ci
if ($LASTEXITCODE -ne 0) {
    Stop-WithReason 'npm konnte die Abhängigkeiten nicht installieren.' `
        'Meist ist es die Internetverbindung oder ein Virenscanner. Führe "npm ci" im Projektordner aus, um die vollständige Meldung zu sehen.'
}
Write-Ok 'Fertig.'

# --- Schritt 6: Tests (optional) -------------------------------------------

if ($RunTests) {
    Write-Step 'Tests laufen lassen'
    npm test
    if ($LASTEXITCODE -ne 0) {
        Write-Warn 'Tests sind fehlgeschlagen. Das Einrichten war trotzdem erfolgreich.'
    } else {
        Write-Ok 'Alle Tests grün.'
    }
}

# --- Schritt 7: Starten -----------------------------------------------------

if ($SkipStart) {
    Write-Step 'Fertig'
    Write-Info "Zum Starten:  cd `"$Path`"  und dann  npm run dev"
    exit 0
}

Write-Step 'Server starten'

<#
    Der Browser wird erst geöffnet, wenn der Server wirklich antwortet.

    Sofort zu öffnen zeigt eine Fehlerseite, die man dann von Hand neu laden
    muss — und beim ersten Start dauert es länger, weil die Route erst
    übersetzt wird. Das läuft nebenher, damit der Server selbst im Vordergrund
    bleibt und mit Strg+C beendet werden kann.
#>
$opener = Start-Job -ArgumentList $Port -ScriptBlock {
    param($Port)
    $deadline = (Get-Date).AddMinutes(4)
    while ((Get-Date) -lt $deadline) {
        try {
            $answer = Invoke-WebRequest -Uri "http://localhost:$Port" -UseBasicParsing -TimeoutSec 3
            if ($answer.StatusCode -eq 200) {
                Start-Process "http://localhost:$Port"
                return
            }
        } catch {
            # Noch nicht bereit. Ein fehlgeschlagener Versuch ist der Normalfall,
            # solange der Server hochfährt.
        }
        Start-Sleep -Seconds 2
    }
}

Write-Info "Der Browser öffnet sich, sobald der Server bereit ist (http://localhost:$Port)."
Write-Info 'Beenden mit Strg+C.'
Write-Host ''
Write-Host '   Beim ersten Öffnen des Skizzenwerkzeugs lädt der CAD-Kernel:' -ForegroundColor Yellow
Write-Host '   rund 22 MB, einmal pro Sitzung. Das ist kein Fehler.' -ForegroundColor Yellow
Write-Host ''

try {
    npm run dev
} finally {
    Stop-Job $opener -ErrorAction SilentlyContinue
    Remove-Job $opener -Force -ErrorAction SilentlyContinue
}
