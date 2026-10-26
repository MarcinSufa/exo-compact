# exo-compact installer for Windows (Windows PowerShell 5.1 and PowerShell 7):
#   irm https://raw.githubusercontent.com/MarcinSufa/exo-compact/main/install.ps1 | iex
# It clones the repository (or updates the clone) and registers it with Claude Code as a plugin.
# This is the alternative to the native install (`/plugin marketplace add MarcinSufa/exo-compact`,
# `/plugin install exo-compact@exo-compact`): the plugin is on for every project once it is installed
# and its defaults (session recall on, interactive sessions only) come from the manifest, so this script
# only adds what the native install cannot: the clone, and the plugin directory option.
# Running it again updates the install and keeps the options you changed.
#   EXO_COMPACT_HOME        where the clone lives (default: ~\.exo-compact)
#   EXO_COMPACT_ENABLE_DIR  optional: turn exo-compact on for this directory with a flag file (it is
#                           already on everywhere by default); "none" keeps it off everywhere, use
#                           `setup.cjs enable <dir>` later
#   EXO_COMPACT_REPO, EXO_COMPACT_REF  the repository, and the tag or branch to install from (default:
#                           the tag of this release; main for unreleased changes)
# The stderr of git, node and claude is never redirected: Windows PowerShell 5.1 would turn it into errors.
function Install-ExoCompact {
    $repo = if ($env:EXO_COMPACT_REPO) { $env:EXO_COMPACT_REPO } else { 'https://github.com/MarcinSufa/exo-compact.git' }
    $ref = if ($env:EXO_COMPACT_REF) { $env:EXO_COMPACT_REF } else { 'v4.9.2' }
    $dir = if ($env:EXO_COMPACT_HOME) { $env:EXO_COMPACT_HOME } else { Join-Path $HOME '.exo-compact' }
    $enableDir = if ($env:EXO_COMPACT_ENABLE_DIR) { $env:EXO_COMPACT_ENABLE_DIR } else { '' }
    $plugin = Join-Path (Join-Path $dir 'plugin') 'compact'
    $setup = Join-Path $plugin 'setup.cjs'

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is not installed.' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is not installed. exo-compact needs Node.js 22.15 or newer: https://nodejs.org' }
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "Claude Code is not installed (no 'claude' on PATH): https://claude.com/claude-code" }

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
        & git clone --quiet --depth 1 --branch $ref $repo $dir
        if ($LASTEXITCODE -ne 0) { throw "could not clone $repo." }
    }

    # The preflight check stops here on a Node.js or Claude Code that is too old.
    & node $setup doctor --preflight | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'the check above failed, so nothing was registered with Claude Code.' }

    # The same call installs and re-configures: it sets only the plugin directory and the Node binary, so the
    # other options stay at the manifest defaults, or as the user left them on a later run. The hook runs its
    # scripts with that absolute Node, not the first node on a PATH a project can change (CONTRACT S5w).
    $nodeBin = (& node -p process.execPath | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $nodeBin) { throw 'could not find the path of node.' }
    & claude plugin marketplace add $dir | Out-Null
    # EBUSY here is Windows refusing to delete the old marketplace copy while a terminal or editor has a folder in it open.
    if ($LASTEXITCODE -ne 0) { throw "claude could not add the marketplace at $dir. If it said EBUSY (resource busy or locked), close every terminal and editor open in $dir or in $(Join-Path $HOME '.claude\plugins\marketplaces\exo-compact') and run the installer again." }
    & claude plugin install exo-compact@exo-compact --config "recallPluginRoot=$plugin" --config "nodePath=$nodeBin" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'claude could not install the plugin.' }
    # A Claude Code that copies the plugin instead of reading it from the clone needs these two.
    & claude plugin marketplace update exo-compact | Out-Null
    & claude plugin update exo-compact@exo-compact | Out-Null

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
