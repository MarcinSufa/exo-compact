"use strict";

const fs = require("fs");
const path = require("path");

const [action, directory = process.cwd()] = process.argv.slice(2);
const flagPath = path.join(path.resolve(directory), ".exovault", "s4-compact-active");
// 3.11.1: a project under an enabled directory opts out with this file (host/capture-flag.ts).
const optOutPath = path.join(path.resolve(directory), ".exovault", "s4-compact-off");

// 4.8.0: an installed plugin is enabled with no flag file (host/capture-flag.ts), so
//   enable  writes the flag (pins the capture root here) and removes an opt-out in the same directory;
//   disable/optout  remove the flag and write the opt-out file (deleting the flag alone would leave it on, and a flag
//                   left beside the opt-out file wins over it, host/capture-flag.ts);
//   optin  removes the opt-out file only.
// Each action prints one line on success, so a silent exit 0 is not mistaken for nothing done.
const target = path.resolve(directory);
// 4.8.1: the same file host/capture-path.ts writes (CAPTURE_GITIGNORE), so the flag and the captures stay out of git.
const gitignorePath = path.join(target, ".exovault", ".gitignore");
const ensureGitignore = () => {
  if (!fs.existsSync(gitignorePath)) fs.writeFileSync(gitignorePath, "# Written by exo-compact: session captures stay out of git.\n*\n", { mode: 0o600 });
};
const say = (line) => process.stdout.write(`exo-compact: ${line}\n`);
if (action === "enable") {
  // 4.9.2: owner-only, like the captures that land next to the flag (harden.mjs).
  fs.mkdirSync(path.dirname(flagPath), { recursive: true, mode: 0o700 });
  fs.rmSync(optOutPath, { force: true });
  fs.writeFileSync(flagPath, "1", { mode: 0o600 });
  ensureGitignore();
  say(`on for ${target} and below (flag written)`);
} else if (action === "disable" || action === "optout") {
  const hadFlag = fs.existsSync(flagPath);
  fs.rmSync(flagPath, { force: true });
  fs.mkdirSync(path.dirname(optOutPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(optOutPath, "1", { mode: 0o600 });
  ensureGitignore();
  say(`off for ${target} and below (opt-out file written${hadFlag ? ", flag removed" : ""})`);
} else if (action === "optin") {
  fs.rmSync(optOutPath, { force: true });
  say(`opt-out file removed in ${target}`);
} else if (action === "cleanup") {
  const { spawnSync } = require("child_process");
  const result = spawnSync(process.execPath, [path.join(__dirname, "recall", "cleanup.mjs"), ...process.argv.slice(3)], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else if (action === "doctor") {
  const { spawnSync } = require("child_process");
  const doctor = path.join(__dirname, "doctor.mjs");
  const result = spawnSync(process.execPath, [doctor, ...process.argv.slice(3)], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else {
  process.stderr.write("Usage: node setup.cjs enable|disable|optout|optin [dir] | doctor [--jev] [--json] [--preflight] | cleanup [--apply] [--days N] [--capture-root DIR]\n");
  process.exitCode = 2;
}
