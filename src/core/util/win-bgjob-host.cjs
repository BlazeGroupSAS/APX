"use strict";
// The detached half of the Windows background-job bridge.
//
// The daemon spawns this node process DETACHED — outside its job object — so
// it survives daemon restarts. It has no console itself; it spawns the job's
// shell with windowsHide, which gives the shell ONE auto-allocated hidden
// console the whole process tree shares (detached children get NO console,
// and their grandchildren would allocate a visible one — the bug this file
// exists to avoid).
//
// argv[2] is a JSON spec: { pipe, file, args, options, cwd }. stdout, stderr
// and the exit status are bridged to the daemon as newline-delimited JSON on
// the named pipe. If the daemon is gone the connect fails and the job still
// runs to completion — output is simply dropped; the reconciler closes the
// record when the pid dies, same as any orphaned job.
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");

const specPath = process.argv[2];
let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
} catch {
  process.exit(2);
}
// The spec is consumed; the daemon does not need it after this.
try { fs.unlinkSync(specPath); } catch { /* best-effort */ }

const child = spawn(spec.file, spec.args, {
  cwd: spec.cwd || undefined,
  env: process.env,
  ...(spec.options || {}),
  // Pinned AFTER the spread — the hidden console is this file's whole job; a
  // spec must never be able to turn it off.
  windowsHide: true,
});

let conn = null;
const send = (o) => {
  try { conn?.write(JSON.stringify(o) + "\n"); } catch { conn = null; }
};
try {
  conn = net.connect(spec.pipe);
  conn.on("error", () => { conn = null; });
} catch {
  conn = null;
}

child.stdout?.on("data", (d) => send({ t: "out", d: d.toString("base64") }));
child.stderr?.on("data", (d) => send({ t: "err", d: d.toString("base64") }));

const done = (o) => {
  send(o);
  try { conn?.end(); } catch { /* daemon may already be gone */ }
};
child.on("close", (code, signal) => done({ t: "exit", code, signal: signal || null }));
child.on("error", (e) => done({ t: "exit", code: null, error: String(e?.message || e) }));
