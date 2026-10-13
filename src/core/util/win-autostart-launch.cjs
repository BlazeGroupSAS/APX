// Autostart launch intermediary — spawned by hidden-run.js through wscript at
// logon. Its whole job: read the UTF-16 payload {cmd} and spawn cmd[0] with
// the rest as structured argv, so no target argument is ever reconstructed
// into a command line (WSH switches, %, quotes and empty strings all arrive
// verbatim). detached + windowsHide: the target outlives this process and
// gets no console. Any failure exits quietly — there is no console anyway
// and a modal at logon is worse than a missed launch.
"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");

try {
  const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf16le").replace(/^\uFEFF/, ""));
  if (!Array.isArray(spec.cmd) || spec.cmd.length === 0) process.exit(0);
  // A stale autostart must die silently — no dialog, no orphan. When the
  // target is a path, check it exists before CreateProcess ever runs; a bare
  // name is PATH-resolved and covered by the error handler below.
  const exe = spec.cmd[0];
  if ((exe.includes("\\") || exe.includes("/")) && !fs.existsSync(exe)) process.exit(0);
  const child = spawn(exe, spec.cmd.slice(1), {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.on("error", () => process.exit(0)); // ENOENT/EACCES — quiet, always
  child.unref();
} catch {
  /* corrupt payload — exit quietly */
}
