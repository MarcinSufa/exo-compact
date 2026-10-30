# exo-compact installer for Windows (Windows PowerShell 5.1 and PowerShell 7):
#   irm https://raw.githubusercontent.com/MarcinSufa/exo-compact/main/install.ps1 | iex
# It clones the repository (or updates the clone) and registers it with Claude Code as a plugin.
# This is the alternative to the native install (`/plugin marketplace add MarcinSufa/exo-compact`,
# `/plugin install exo-compact@exo-compact`): the plugin is on for every project once it is installed
# and its defaults (session recall on, interactive sessions only) come from the manifest, so this script
# only adds what the native install cannot: the clone, the plugin directory and Node options, and two
# questions about Claude Code's auto-compact (the window, 200000 tokens by default, and whether auto-compact
# is on), which it applies to your Claude Code settings right away (CONTRACT S5x).
# Running it again updates the install and keeps the options you changed; it asks the questions only once.
#   EXO_COMPACT_HOME        where the clone lives (default: ~\.exo-compact)
#   EXO_COMPACT_ENABLE_DIR  optional: turn exo-compact on for this directory with a flag file (it is
#                           already on everywhere by default); "none" keeps it off everywhere, use
#                           `setup.cjs enable <dir>` later
#   EXO_COMPACT_REPO, EXO_COMPACT_REF  the repository, and the tag or branch to install from (default:
#                           the tag of this release; main for unreleased changes)
#   EXO_COMPACT_WINDOW      answers the first question: the auto-compact window in tokens, 100000 to
#                           1000000, or 0 to leave your setting alone (default without a terminal: 200000)
#   EXO_COMPACT_AUTO        answers the second question: 1 turns auto-compact on, 0 leaves your setting
#                           alone (default without a terminal: 1)
# The stderr of git, node and claude is never redirected: Windows PowerShell 5.1 would turn it into errors.
# 0, or a whole number of tokens Claude Code accepts as an auto-compact window; $null for anything else.
function Get-ExoCompactWindow([string] $text) {
    if ($text -notmatch '^[0-9]{1,9}$') { return $null }
    $tokens = [int] $text
    if ($tokens -eq 0 -or ($tokens -ge 100000 -and $tokens -le 1000000)) { return $tokens }
    return $null
}

function Install-ExoCompact {
    $repo = if ($env:EXO_COMPACT_REPO) { $env:EXO_COMPACT_REPO } else { 'https://github.com/MarcinSufa/exo-compact.git' }
    $ref = if ($env:EXO_COMPACT_REF) { $env:EXO_COMPACT_REF } else { 'v4.10.2' }
    $dir = if ($env:EXO_COMPACT_HOME) { $env:EXO_COMPACT_HOME } else { Join-Path $HOME '.exo-compact' }
    $enableDir = if ($env:EXO_COMPACT_ENABLE_DIR) { $env:EXO_COMPACT_ENABLE_DIR } else { '' }
    $plugin = Join-Path (Join-Path $dir 'plugin') 'compact'
    $setup = Join-Path $plugin 'setup.cjs'

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is not installed.' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not installed. exo-compact needs Node.js 22.15 or newer: https://nodejs.org' }
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "Claude Code is not installed (no 'claude' on PATH): https://claude.com/claude-code" }

    # 4.10.0 (CONTRACT S5x): the auto-compact answers. The environment answers first; a terminal is asked only
    # until the marker exists (auto-compact.mjs writes it once it applied the answers); without either, the
    # defaults. 'keep' on a later run passes no option, so a value changed with /plugin configure stays.
    $window = 'keep'
    $auto = 'keep'
    $configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
    $asked = ''
    if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $configDir 'exovault') 'auto-compact.json'))) {
        $asked = if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) { 'terminal' } else { 'defaults' }
    }
    if ($env:EXO_COMPACT_WINDOW) {
        $window = Get-ExoCompactWindow $env:EXO_COMPACT_WINDOW
        if ($null -eq $window) { throw "EXO_COMPACT_WINDOW must be 0 (leave the setting alone) or a number of tokens from 100000 to 1000000, not '$($env:EXO_COMPACT_WINDOW)'." }
    } elseif ($asked -eq 'terminal') {
        while ($true) {
            $reply = Read-Host 'exo-compact: Claude Code compacts only when the context window fills: on a 1M model that is 1,000,000 tokens. Set the auto-compact window to 200000 tokens (recommended)? [Y/n or a number]'
            if ($null -eq $reply -or $reply -match '^(y|yes)?$') { $window = 200000; break }
            if ($reply -match '^(n|no)$') { $window = 0; break }
            $window = Get-ExoCompactWindow $reply
            if ($null -ne $window) { break }
            Write-Host 'exo-compact: answer y, n, or a number of tokens from 100000 to 1000000.'
        }
    } elseif ($asked -eq 'defaults') {
        $window = 200000
    }
    if ($env:EXO_COMPACT_AUTO) {
        if ($env:EXO_COMPACT_AUTO -match '^(1|true)$') { $auto = 'true' }
        elseif ($env:EXO_COMPACT_AUTO -match '^(0|false)$') { $auto = 'false' }
        else { throw "EXO_COMPACT_AUTO must be 1 (turn auto-compact on) or 0 (leave the setting alone), not '$($env:EXO_COMPACT_AUTO)'." }
    } elseif ($asked -eq 'terminal') {
        while ($true) {
            $reply = Read-Host 'exo-compact: Turn auto-compact on, so exo-compact runs when the window fills? [Y/n]'
            if ($null -eq $reply -or $reply -match '^(y|yes)?$') { $auto = 'true'; break }
            if ($reply -match '^(n|no)$') { $auto = 'false'; break }
            Write-Host 'exo-compact: answer y or n.'
        }
    } elseif ($asked -eq 'defaults') {
        $auto = 'true'
    }

    if (Test-Path -LiteralPath (Join-Path $dir '.git')) {
        Write-Host "exo-compact: updating $dir to $ref"
        # Fetch and check out $ref rather than pull: a clone made from another ref (main) still moves to EXO_COMPACT_REF.
        & git -C $dir fetch --quiet --depth 1 origin $ref
        if ($LASTEXITCODE -eq 0) { & git -C $dir checkout --quiet --detach FETCH_HEAD }
        if ($LASTEXITCODE -ne 0) { throw "could not update $dir to $ref. If you changed files there, undo that or remove the folder, then run the installer again." }
    } elseif (Test-Path -LiteralPath $dir) {
        throw "$dir exists and is not an exo-compact clone. Move it away, or set EXO_COMPACT_HOME to another folder."
    } else {
        Write-Host "exo-compact: downloading to $dir"
        & git -c advice.detachedHead=false clone --quiet --depth 1 --branch $ref $repo $dir
        if ($LASTEXITCODE -ne 0) { throw "could not clone $repo." }
    }

    # The preflight check stops here on a Node.js or Claude Code that is too old.
    & node $setup doctor --preflight | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'the check above failed, so nothing was registered with Claude Code.' }

    # The same call installs and re-configures: it sets the plugin directory, the Node binary and the
    # auto-compact answers given on this run, so the other options stay at the manifest defaults, or as the
    # user left them on a later run. The hook runs its scripts with that absolute Node, not the first node on
    # a PATH a project can change (CONTRACT S5w).
    $nodeBin = (& node -p process.execPath | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $nodeBin) { throw 'could not find the path of node.' }
    $autoConfigs = @()
    if ("$window" -ne 'keep') { $autoConfigs += @('--config', "autoCompactWindow=$window") }
    if ($auto -ne 'keep') { $autoConfigs += @('--config', "autoCompact=$auto") }
    & claude plugin marketplace add $dir | Out-Null
    # EBUSY here is Windows refusing to delete the old marketplace copy while a terminal or editor has a folder in it open.
    if ($LASTEXITCODE -ne 0) { throw "claude could not add the marketplace at $dir. If it said EBUSY (resource busy or locked), close every terminal and editor open in $dir or in $(Join-Path $HOME '.claude\plugins\marketplaces\exo-compact') and run the installer again." }
    & claude plugin install exo-compact@exo-compact --config "recallPluginRoot=$plugin" --config "nodePath=$nodeBin" @autoConfigs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'claude could not install the plugin.' }
    # A Claude Code that copies the plugin instead of reading it from the clone needs these two.
    & claude plugin marketplace update exo-compact | Out-Null
    & claude plugin update exo-compact@exo-compact | Out-Null

    # The settings change now, not at the first session start, and the line saying so goes in the summary.
    $applied = ''
    if ("$window" -ne 'keep' -or $auto -ne 'keep') {
        $applied = (& node (Join-Path $plugin 'auto-compact.mjs') apply "$window" $auto | Out-String).Trim()
    }

    if ($enableDir -eq 'none') {
        & node $setup disable $HOME | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'could not keep exo-compact off.' }
    } elseif ($enableDir) {
        & node $setup enable $enableDir | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "could not turn exo-compact on for $enableDir." }
    }

    $version = (Get-Content -Raw -LiteralPath (Join-Path (Join-Path $plugin '.claude-plugin') 'plugin.json') | ConvertFrom-Json).version
    Write-Host ''
    Write-Host "exo-compact $version is installed."
    if ($applied) { Write-Host $applied }
    if ($enableDir -eq 'none') {
        Write-Host '  It is off everywhere. Turn it on for a folder and everything below it:'
        Write-Host "    node $setup enable <dir>"
    } else {
        Write-Host '  It is on for every project.'
        Write-Host "  Keep it off for one project:  node $setup optout <dir>"
    }
    Write-Host '  Start claude as usual. A session that is already running needs a restart.'
    Write-Host "  See what it did:              node $(Join-Path (Join-Path $dir 'tools') 'status.mjs')"
    Write-Host '  Update:                       run this installer again'
}

# No `exit` when the script comes through `irm | iex`: it would close the user's window.
try {
    Install-ExoCompact
} catch {
    [Console]::Error.WriteLine("exo-compact: $($_.Exception.Message)")
    if ($PSCommandPath) { exit 1 }
}
