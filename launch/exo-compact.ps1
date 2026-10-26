# Start Claude Code with the exo-compact (S4) plugin + session recall in the current directory.
# -Window <tokens> sets the auto-compact window; -Jev enables selector J (sends span text to
# TypeSafe, needs TYPESAFE_API_KEY); -SkipDoctor skips the preflight check.
# No param block: PowerShell would treat -p as an abbreviation of -PluginDir and swallow claude's own
# flags. Only the exact (case-insensitive) -PluginDir <dir>, -Window <n>, -Jev and -SkipDoctor are
# ours; everything else goes to claude unchanged and in order.
$PluginDir = Join-Path $PSScriptRoot '..\plugin\compact'
$Window = $null
$Jev = $false
$SkipDoctor = $false
$claudeArgs = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = [string]$args[$i]
    if ($arg -ieq '-PluginDir' -or $arg -ieq '-Window') {
        if ($i + 1 -ge $args.Count) { [Console]::Error.WriteLine("exo-compact: $arg needs a value"); exit 2 }
        $i++
        if ($arg -ieq '-PluginDir') { $PluginDir = [string]$args[$i] } else { $Window = [string]$args[$i] }
    } elseif ($arg -ieq '-Jev') { $Jev = $true }
    elseif ($arg -ieq '-SkipDoctor') { $SkipDoctor = $true }
    else { $claudeArgs.Add($arg) }
}

$ErrorActionPreference = 'Stop'
$resolvedPluginDir = (Resolve-Path -LiteralPath $PluginDir).Path
$projectDir = (Get-Location).Path
$setupPath = Join-Path $resolvedPluginDir 'setup.cjs'

& node $setupPath enable $projectDir | ForEach-Object { [Console]::Error.WriteLine($_) }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$jevEnabled = $Jev
if (-not $SkipDoctor) {
    $doctorArgs = @()
    if ($jevEnabled) { $doctorArgs += '--jev' }
    & node (Join-Path $resolvedPluginDir 'doctor.mjs') @doctorArgs | ForEach-Object { [Console]::Error.WriteLine($_) }
    $doctorExit = $LASTEXITCODE
    if ($doctorExit -eq 3) {
        if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
            $answer = Read-Host 'Jev is not working. Start without Jev? [y/N]'
            if ($answer -notmatch '^[yY]') { exit 3 }
        } else {
            [Console]::Error.WriteLine('exo-compact: Jev is not working, starting without it')
        }
        $jevEnabled = $false
    } elseif ($doctorExit -ne 0) {
        exit $doctorExit
    }
}

# A global install (claude plugin install ...@exo-compact) already loads the plugin; adding
# --plugin-dir would load a second copy, so only its options are passed.
$configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$installed = Join-Path $configDir 'plugins\installed_plugins.json'
# 4.0.0 renamed the plugin; the old id would load a second copy next to --plugin-dir.
if ((Test-Path -LiteralPath $installed) -and ((Get-Content -Raw -LiteralPath $installed) -match '"exovault-s4-compact@exo-compact"')) {
    [Console]::Error.WriteLine('exo-compact: the plugin was renamed in 4.0.0; replace the old install first:')
    [Console]::Error.WriteLine('  claude plugin uninstall exovault-s4-compact@exo-compact; claude plugin install exo-compact@exo-compact ...')
    exit 1
}
$global = (Test-Path -LiteralPath $installed) -and ((Get-Content -Raw -LiteralPath $installed) -match '"exo-compact@exo-compact"')

# 4.9.2 (CONTRACT S5w): the hook starts its Node scripts with this binary, not with whatever node a project's env block
# puts first on PATH. Empty when node is missing; the hook then falls back to node.
$nodeBin = try { (& node -p process.execPath 2>$null | Out-String).Trim() } catch { '' }
$options = @{ recallEnabled = $true; recallPluginRoot = $resolvedPluginDir; nodePath = $nodeBin; jevEnabled = $jevEnabled }
if ($global) {
    $options.interactiveOnly = $true
    $configs = @{ 'exo-compact@exo-compact' = @{ options = $options } }
} else {
    $configs = @{
        'exo-compact' = @{ options = $options }
        'exo-compact@inline' = @{ options = $options }
    }
}
$settings = @{ pluginConfigs = $configs } | ConvertTo-Json -Depth 8 -Compress
# Windows PowerShell 5.1 drops embedded double quotes when passing JSON to a native exe, so the
# settings go through a temp file (claude --settings accepts a file path).
$settingsFile = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-s4-settings-" + [guid]::NewGuid().ToString() + ".json")
[System.IO.File]::WriteAllText($settingsFile, $settings)

$previousHooks = $env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
$previousWindow = $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW
try {
    $env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '1'
    if ($null -ne $Window) {
        $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = $Window
    }
    if ($global) { & claude --settings $settingsFile @claudeArgs }
    else { & claude --plugin-dir $resolvedPluginDir --settings $settingsFile @claudeArgs }
    $claudeExit = $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $settingsFile -ErrorAction SilentlyContinue
    if ($null -eq $previousHooks) { Remove-Item Env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS -ErrorAction SilentlyContinue }
    else { $env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = $previousHooks }
    if ($null -eq $previousWindow) { Remove-Item Env:CLAUDE_CODE_AUTO_COMPACT_WINDOW -ErrorAction SilentlyContinue }
    else { $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = $previousWindow }
}
exit $claudeExit
