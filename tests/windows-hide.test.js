// On Windows every process APX launches can flash a console window — and the
// naive fixes are worse: `detached: true` leaves the shell console-less so its
// grandchildren allocate VISIBLE consoles, and a non-detached child dies with
// the daemon (Node owns it through a job object). r4 splits the problem into
// three shapes and gives each its own mechanism:
//
//   CONSOLE INCIDENTAL   — windowsHide: true on the spawn (foreground shells,
//                          runtimes, probes — the huge majority).
//   BACKGROUND PERSISTENT — daemon → detached win-bgjob-host → cmd with
//                          windowsHide (one hidden console for the tree) →
//                          stdio/exit bridged back over a named pipe.
//   GUI FUNCTIONAL        — no console at all (wscript COM picker) or an
//                          explicitly visible process (image viewer, $VISUAL).
//
// The last test is the ratchet. It is a REVIEW GATE, not a proof about
// arbitrary JavaScript: its contract is that no maintained APX file can add a
// new route to process creation without explicit classification. Two controls:
//
//   INVENTORY   — every acquisition of a process-creating API goes through a
//                 declared, analysable channel: import / require() /
//                 import() / `import =` / createRequire of child_process or
//                 cluster, or member access (cp.spawn, cp["spawn"]) on those
//                 results. Out-of-band loaders — process.getBuiltinModule,
//                 module.require, an aliased require, a computed import(),
//                 require("child_process") stored in containers — are flagged
//                 as violations even before any call is found.
//   CALL-SITES  — every resolved invocation of spawn/execFile/exec/fork
//                 (including cluster.fork) must land in exactly one bucket:
//
//   hidden       windowsHide: true (guaranteed — no later spread or computed
//                key may override)
//   posix        a platform guard makes it unreachable on Windows
//   interactive  it shares the user's existing console (stdio:"inherit")
//   gui          showing a window IS the point
//   central      options arrive hidden through a shared abstraction
//
//   a use the analyzer detects but cannot resolve → FAIL, message names the
//   file and the unclassifiable form. Nothing is silently ignored.
//
// Explicitly out of scope: eval(), new Function(), and code generated or
// fetched at runtime. The ratchet gates what is WRITTEN in this repo — a
// string that becomes code at run time never passed through this source tree.
//
// tests/fixtures/winhide-attacks/ holds the adversarial corpus: every file
// there is a shape the audit must reject — unrecognised imports, member and
// computed calls, `.call`, ternary callees, re-export wrappers, spread-after
// and computed-key overrides, getBuiltinModule, module.require, require
// aliases, object/array storage, cluster.fork. A scanner that silently
// ignores one of those is a scanner that approves the next unprotected
// call-site.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "apx-winhide-"));
process.env.HOME = TMP_HOME;
process.env.APX_HOME = path.join(TMP_HOME, ".apx");

const { test } = await import("node:test");
const { default: assert } = await import("node:assert/strict");
const { default: ts } = await import("typescript");
const { shellCommand } = await import("#core/util/shell.js");
const { runProcess } = await import("#core/runtimes/_spawn.js");
const { runShellInBackground, killShellJob } = await import("#core/agent/shell/background.js");
const { readJob, BACKGROUND_JOBS_DIR } = await import("#core/stores/background-jobs.js");
const { onBackgroundJobEvent } = await import("#core/events/bus.js");
const { spawn } = await import("node:child_process");
const {
  ensureHiddenRunner, ensurePickDirScript, hiddenRunnerPath,
  wscriptPath, wscriptArgv, wscriptRunValue, jobHostPath,
  normalizePickedPath,
} = await import("#core/util/win-hidden-run.js");

const PROJECT = { id: 7, name: "acme", path: TMP_HOME, storagePath: TMP_HOME, config: {} };
fs.mkdirSync(path.join(TMP_HOME, ".apc", "agents"), { recursive: true });
fs.writeFileSync(path.join(TMP_HOME, ".apc", "agents", "reels.md"), "---\nrole: Worker\n---\n");

function fresh() {
  try { fs.rmSync(BACKGROUND_JOBS_DIR, { recursive: true, force: true }); } catch { /* nothing */ }
}

function ended(jobId, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`job ${jobId} never ended`)); }, timeoutMs);
    const off = onBackgroundJobEvent((ev) => {
      if (ev?.phase !== "end" || ev.job?.id !== jobId) return;
      clearTimeout(timer);
      off();
      resolve(ev.job);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// propagation, proven with injected spawns rather than real processes
// ---------------------------------------------------------------------------

test("shellCommand() adds windowsHide on Windows and nothing on POSIX", () => {
  const win = shellCommand("echo hi", { platform: "win32", env: { ComSpec: "cmd.exe" } });
  assert.equal(win.options.windowsHide, true);
  assert.equal(win.options.windowsVerbatimArguments, true, "the r3 quoting contract is untouched");

  assert.deepEqual(shellCommand("echo hi", { platform: "darwin" }).options, {});
  assert.deepEqual(shellCommand("echo hi", { platform: "linux" }).options, {});
});

test("a background job launched through an injected spawn stays hidden, not detached", async () => {
  fresh();

  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};

  const calls = [];
  const out = runShellInBackground({
    project: PROJECT,
    from: "reels",
    command: "echo hi",
    cwd: TMP_HOME,
    wake: false,
    platform: "win32",
    shellCommandFn: (command, opts) => shellCommand(command, { ...opts, platform: "win32" }),
    spawnFn: (file, args, options) => {
      calls.push(options);
      setTimeout(() => child.emit("close", 0, null), 10);
      return child;
    },
  });

  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].windowsHide, true);
  assert.equal(calls[0].detached, false,
    "a detached cmd has NO console — its grandchildren allocate VISIBLE ones");

  await ended(out.job_id);
});

test("POSIX background jobs stay detached — process-group kill needs it", async () => {
  fresh();
  const child = new EventEmitter();
  child.pid = 4243;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};

  let options;
  runShellInBackground({
    project: PROJECT,
    from: "reels",
    command: "echo hi",
    cwd: TMP_HOME,
    wake: false,
    platform: "linux",
    shellCommandFn: (command, opts) => shellCommand(command, { ...opts, platform: "linux" }),
    spawnFn: (f, a, o) => {
      options = o;
      setTimeout(() => child.emit("close", 0, null), 10);
      return child;
    },
  });
  assert.equal(options.detached, true);
  assert.equal(options.windowsHide, undefined, "POSIX never asked for it");
});

test("the shared runtime spawn carries windowsHide and keeps its stdio", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = { write() {}, end() {} };
  child.kill = () => {};

  let seen;
  const result = await runProcess({
    command: "anything",
    spawnFn: (cmd, args, options) => {
      seen = options;
      setTimeout(() => child.emit("close", 0, null), 5);
      return child;
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(seen.windowsHide, true);
  assert.deepEqual(seen.stdio, ["pipe", "pipe", "pipe"]);
});

// ---------------------------------------------------------------------------
// the Windows background bridge — real processes, Windows-only
// ---------------------------------------------------------------------------

// The host exists and is the middle of the chain: daemon → host → cmd.
test("the windows job path goes through a detached host, not a direct cmd", () => {
  assert.ok(fs.existsSync(jobHostPath()), "win-bgjob-host.cjs must ship with the package");
  const hostSrc = fs.readFileSync(jobHostPath(), "utf8");
  assert.match(hostSrc, /net\.connect|createConnection/, "the host bridges over the named pipe");
  assert.match(hostSrc, /spawn\(/, "the host spawns the job shell");
});

test("a real background job runs hidden and reports through the pipe", async (t) => {
  if (process.platform !== "win32") return;
  fresh();

  const out = runShellInBackground({
    project: PROJECT,
    from: "reels",
    command: "echo PIPE-BRIDGE-OK",
    cwd: TMP_HOME,
    wake: false,
  });
  assert.equal(out.ok, true, out.error);
  assert.ok(out.pid > 0, "a live host pid is reported — the tree root");

  const job = await ended(out.job_id, 30_000);
  assert.equal(job.status, "done");
  assert.match(String(job.tail || ""), /PIPE-BRIDGE-OK/, "stdout crossed the named pipe");
});

// THE test for H7: a parent process launches a real multi-step job through the
// real runShellInBackground, then DIES mid-job. The job must still finish.
test("a background job survives the daemon dying mid-run", async (t) => {
  if (process.platform !== "win32") return;
  fresh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apx-h7-"));

  // A console-app grandchild that reports whether its console is visible.
  const probe = path.join(dir, "console-probe.ps1");
  const verdict = path.join(dir, "verdict.txt");
  const marker = path.join(dir, "marker.txt");
  fs.writeFileSync(probe, [
    `Add-Type -Name W -Namespace P -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);' -PassThru | Out-Null`,
    `$h=[P.W]::GetConsoleWindow()`,
    `$r = if ($h -eq 0) { 'NOCONSOLE' } elseif ([P.W]::IsWindowVisible($h)) { 'VISIBLE' } else { 'HIDDEN' }`,
    `Set-Content -Path '${verdict.replace(/'/g, "''")}' -Value $r`,
  ].join("\n"));

  // The fake daemon: run the real runShellInBackground, print the job id,
  // then die at ~1.2 s — long before ping finishes.
  const sim = path.join(dir, "daemon-sim.mjs");
  const bgUrl = pathToFileURL(path.join(SRC, "core", "agent", "shell", "background.js")).href;
  fs.writeFileSync(sim, [
    `import { runShellInBackground } from ${JSON.stringify(bgUrl)};`,
    `const out = runShellInBackground({`,
    `  project: ${JSON.stringify({ id: 7, name: "acme", path: TMP_HOME, storagePath: TMP_HOME, config: {} })},`,
    `  from: "reels", wake: false, cwd: ${JSON.stringify(dir)},`,
    `  command: ${JSON.stringify(`ping -n 6 127.0.0.1 >nul & powershell -NoProfile -File "${probe}" & echo second>"${marker}"`)},`,
    `});`,
    `console.log("JOB", JSON.stringify(out));`,
    `setTimeout(() => process.exit(0), 1200);`,
  ].join("\n"));

  const daemon = spawn(process.execPath, [sim], {
    env: { ...process.env, APX_HOME: process.env.APX_HOME, HOME: TMP_HOME },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let simOut = "";
  daemon.stdout.on("data", (d) => { simOut += d; });
  await new Promise((res) => daemon.on("exit", res));

  const jobLine = simOut.split("\n").find((l) => l.startsWith("JOB "));
  assert.ok(jobLine, `the sim must report the job\n${simOut}`);
  const launch = JSON.parse(jobLine.slice(4));
  assert.equal(launch.ok, true, launch.error);

  // The daemon is dead. The job must still run to completion (~5 s of ping).
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await sleep(300);
  assert.ok(fs.existsSync(marker), "the second step ran after the daemon died — the job survived");
  assert.match(fs.readFileSync(marker, "utf8"), /second/);

  const v = fs.readFileSync(verdict, "utf8").trim();
  assert.notEqual(v, "VISIBLE", "the grandchild's console must never be visible");
  assert.match(v, /HIDDEN|NOCONSOLE/);
});

test("cancelling a real job still kills the whole tree", async (t) => {
  if (process.platform !== "win32") return;
  fresh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apx-h7kill-"));
  const marker = path.join(dir, "should-never-exist.txt");

  const out = runShellInBackground({
    project: PROJECT,
    from: "reels",
    // ~30 s of ping, THEN the marker — if the tree survives cancel, it appears.
    command: `ping -n 30 127.0.0.1 >nul & echo survived>"${marker}"`,
    cwd: dir,
    wake: false,
  });
  assert.equal(out.ok, true, out.error);

  await sleep(1500); // let the tree come up
  const job = readJob(out.job_id);
  assert.equal(killShellJob(job), true, "the job must be live and cancellable");

  await ended(out.job_id, 15_000);
  await sleep(1000); // would the second step still have run?
  assert.ok(!fs.existsSync(marker), "taskkill /T took the whole tree — nothing survived to run step two");
});

// ---------------------------------------------------------------------------
// the wscript hidden runner (H5/H9) — Unicode-safe by construction
// ---------------------------------------------------------------------------

test("the hidden runner is ASCII-only and driven by a payload file", () => {
  const p = ensureHiddenRunner();
  assert.equal(p, hiddenRunnerPath());
  const src = fs.readFileSync(p, "utf8");
  assert.ok(!/[^\x00-\x7F]/.test(src), "the launcher stays ASCII");
  // The only WSH input is the payload PATH — a value WSH cannot parse as a
  // switch because it never starts with '//'. The real argv is JSON in the
  // payload, read by node — nothing is ever spliced into a command line.
  assert.match(src, /WScript\.Arguments\(0\)/);
  assert.match(src, /ShellExecute/, "the hop is ShellExecute — never .Run/.Exec on a target cmdline");
  // The JScript's args string carries only APX-owned paths — never cmd[].
  assert.doesNotMatch(src, /spec\.cmd/, "the target argv stays inside JSON — WSH never sees it");
});

test("the Run-key value is wscript + //B + runner + payload path", () => {
  const value = wscriptRunValue("daemon",
    ["C:\\Program Files\\nodejs\\node.exe", "C:\\apx\\daemon.js"], { SystemRoot: "D:\\WIN" });
  assert.ok(value.startsWith('"D:\\WIN\\System32\\wscript.exe"'));
  assert.match(value, /"\/\/B".*"\/\/Nologo"/, "//B keeps a missing/corrupt script silent at logon");
  assert.match(value, /hidden-run\.js/);
  // The argv itself must NOT appear in the value — only the payload path does.
  assert.doesNotMatch(value, /apx\\daemon/, "the target argv lives in the payload file, not the Run value");
  assert.match(value, /daemon\.json/);
});

test("empty target argv is rejected — the payload contract requires argv", () => {
  assert.throws(() => wscriptArgv("x", []), /argv/i);
  assert.throws(() => wscriptArgv("x", null), /argv/i);
});

// Real launch through wscript with a Unicode + shell-metachar path. The target
// proves it ran by writing a marker — exit 0 alone is not enough. The target
// is a .js so the Unicode travels via argv/__dirname, never through file bytes
// (a .ps1 would reintroduce the encoding bug inside the test itself).
test("the hidden runner launches a target under a Unicode path", async (t) => {
  if (process.platform !== "win32") return;
  const dir = path.join(TMP_HOME, "José Peña & 100%");
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, "ran.txt");
  const target = path.join(dir, "fake-target.js");
  fs.writeFileSync(target,
    'require("fs").writeFileSync(require("path").join(__dirname, "ran.txt"), "RAN-UNICODE");\n');

  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(wscriptPath(), wscriptArgv("uni", [process.execPath, target]),
    { timeout: 15_000 });
  assert.equal(r.status, 0, String(r.error || ""));

  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await sleep(200);
  assert.equal(fs.readFileSync(marker, "utf8"), "RAN-UNICODE");
});

// The argv-fidelity contract: every class of argument the old launcher
// silently mangles now arrives EXACTLY — the payload is JSON read by node,
// never a reconstructed command line.
test("the payload runner delivers argv verbatim — no transforms", async () => {
  if (process.platform !== "win32") return;
  const dump = path.join(TMP_HOME, "argv-dump.js");
  const out = path.join(TMP_HOME, "argv-out.json");
  fs.writeFileSync(dump,
    'require("fs").writeFileSync(process.env.DUMP_OUT, JSON.stringify(process.argv.slice(2)));\n');
  const args = [
    "José Peña",
    "spaces  and\ttabs",
    "R&D 100% done",
    "%TEMP% do not expand me",
    "",
    "//T:1 looks like a WSH switch but must not be one",
    'embedded "quotes" stay',
    "trailing\\",
    'mix "q" % & ünïcödé',
  ];
  const argv = [process.execPath, dump, ...args];
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(wscriptPath(), wscriptArgv("fidelity", argv),
    { timeout: 15_000, env: { ...process.env, DUMP_OUT: out } });
  assert.equal(r.status, 0, String(r.error || ""));
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(out) && Date.now() < deadline) await sleep(200);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), args);
});

// Dynamic proof for H16: an autostart pointing at a node.exe that no longer
// exists must die in silence. Without the FileExists guard, ShellExecute
// raises a "file not found" modal that //B cannot suppress and wscript
// BLOCKS on it — so a prompt, clean exit IS the proof there was no dialog.
test("a stale autostart (missing node.exe) fails silently — wscript exits, no modal", async () => {
  if (process.platform !== "win32") return;
  const { spawnSync } = await import("node:child_process");
  const { autostartLauncherPath, autostartPayloadPath } =
    await import("#core/util/win-hidden-run.js");
  const marker = path.join(TMP_HOME, "stale-ran.txt");
  const probe = path.join(TMP_HOME, "stale-probe.js");
  fs.writeFileSync(probe, `require("fs").writeFileSync(${JSON.stringify(marker)}, "RAN");\n`);

  for (const [name, spec] of [
    // node.exe vanished after install
    ["stale-node", { node: "C:\\definitely\\not\\there\\node.exe", launcher: autostartLauncherPath(), cmd: [process.execPath, probe] }],
    // the launcher script vanished
    ["stale-launch", { node: process.execPath, launcher: "C:\\definitely\\not\\there\\launch.cjs", cmd: [process.execPath, probe] }],
    // payload's target exe vanished — launch.cjs must exit quietly too
    ["stale-target", { node: process.execPath, launcher: autostartLauncherPath(), cmd: ["C:\\definitely\\not\\there\\tool.exe", "x"] }],
  ]) {
    const payload = autostartPayloadPath(name);
    fs.writeFileSync(payload, JSON.stringify(spec), "utf16le");
    const r = spawnSync(wscriptPath(),
      ["//B", "//Nologo", ensureHiddenRunner(), payload],
      { timeout: 20_000 });
    // A modal would hold wscript past the timeout; spawnSync returning at all
    // proves the chain exited on its own.
    assert.ok(!r.error, `${name}: wscript must exit on its own — a modal would time out (${r.error})`);
    assert.equal(r.status, 0, `${name}: stale autostart exits cleanly`);
  }
  await sleep(2000); // give any phantom launch time to betray itself
  assert.ok(!fs.existsSync(marker), "no target ran for a stale autostart");
});

// The console question the Run key exists to answer. The intermediary node
// launcher spawns the target DETACHED — a detached Windows child is created
// with DETACHED_PROCESS, so it owns NO console whatsoever (empirically: a
// console app launched detached cannot even initialize one). "No console"
// is strictly stronger than "hidden console". The marker test above proves
// the target runs; this asserts the flags that make it console-free.
test("the launch intermediary spawns detached — the target owns no console", () => {
  const src = fs.readFileSync(
    path.join(SRC, "core", "util", "win-autostart-launch.cjs"), "utf8");
  assert.match(src, /detached:\s*true/, "detached → DETACHED_PROCESS → no console is allocated at all");
  assert.match(src, /windowsHide:\s*true/, "belt and suspenders if a console were ever inherited");
  assert.match(src, /stdio:\s*"ignore"/, "no pipes back to the wscript/host side");
  assert.match(src, /\.unref\(\)/, "the intermediary does not keep itself alive for the target");
});

// ---------------------------------------------------------------------------
// the picker (H8): the dialog is the point, and NO console may exist
// ---------------------------------------------------------------------------

test("the folder picker runs inside wscript — no powershell, no terminal", () => {
  const src = fs.readFileSync(path.join(SRC, "host", "daemon", "api", "admin.js"), "utf8");
  const branch = src.match(/platform === "win32"\) \{([\s\S]*?)\} else \{/);
  assert.ok(branch, "the win32 picker branch must exist");
  // Strip comments — the prose explains WHY powershell is gone; the code must
  // not reference it either way. Full-line comments only: "//B" in the argv
  // array is a string, not a comment.
  const code = branch[1].replace(/^\s*\/\/[^\r\n]*/gm, "");
  assert.match(code, /wscriptPath\(\)/, "the picker is wscript — a GUI host with no console");
  assert.match(code, /ensurePickDirScript\(\)/);
  assert.doesNotMatch(code, /windowsHide/, "wscript is a GUI app — the flag would hide the dialog");
  assert.doesNotMatch(code, /powershell/i, "no powershell — its console is what Windows Terminal hosted");

  // The prompt must NOT be a wscript argument — WSH eats any argv starting
  // with '//' as its own switch, even after the script name. It goes through
  // the environment (the shared APX_PICK_PROMPT env built above the branch);
  // only the result-path argv remains.
  assert.match(src, /APX_PICK_PROMPT:\s*prompt/, "the prompt rides the environment, not argv");
  assert.match(code, /env\b/, "the win32 execFile receives that env");
  assert.doesNotMatch(code, /,\s*prompt\s*\]/, "prompt must never enter the wscript argv array");

  const picker = fs.readFileSync(ensurePickDirScript(), "utf8");
  assert.match(picker, /BrowseForFolder/, "the same COM dialog as before — visible");
  assert.match(picker, /APX_PICK_PROMPT/, "the script reads the prompt from the environment");
  assert.match(picker, /WScript\.Arguments\(0\)/, "argv[0] is the result path only");
});

// Dynamic proof for H12: a prompt that IS a WSH switch ("//T:1" — WSH's own
// timeout option) must reach the script as DATA, untouched by the option
// parser. If wscript had eaten it, APX_PICK_PROMPT would be empty or the
// process would exit instantly.
test("a '//T:1' picker prompt is data, not a WSH switch", async () => {
  if (process.platform !== "win32") return;
  const out = path.join(TMP_HOME, "pick-prompt.json");
  const envProbe = path.join(TMP_HOME, "env-probe.js");
  fs.writeFileSync(envProbe,
    'var env = new ActiveXObject("WScript.Shell").Environment("PROCESS");\n' +
    'var f = new ActiveXObject("Scripting.FileSystemObject")\n' +
    '  .CreateTextFile(WScript.Arguments(0), true, true);\n' +
    'f.Write(env("APX_PICK_PROMPT"));\nf.Close();\n');
  const { execFile: ef } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(ef);
  const prompt = "//T:1";
  await execFileAsync(wscriptPath(), ["//B", "//Nologo", envProbe, out],
    { env: { ...process.env, APX_PICK_PROMPT: prompt }, timeout: 15_000 });
  assert.equal(fs.readFileSync(out, "utf16le").replace(/^\uFEFF/, ""), prompt,
    "the prompt survived verbatim — WSH never parsed it as //T:<seconds>");
});

test("normalizePickedPath keeps drive roots and Unicode intact", () => {
  assert.equal(normalizePickedPath("C:\\"), "C:\\", "a drive root is not stripped to C:");
  assert.equal(normalizePickedPath("D:\\"), "D:\\");
  assert.equal(normalizePickedPath("C:\\\\"), "C:\\");
  assert.equal(normalizePickedPath("C:\\Users\\me\\"), "C:\\Users\\me");
  assert.equal(normalizePickedPath("C:\\Users\\me\\\\\\"), "C:\\Users\\me");
  assert.equal(normalizePickedPath("\\\\server\\share\\"), "\\\\server\\share\\",
    "a UNC root keeps its closing separator");
  assert.equal(normalizePickedPath("\\\\server\\share\\dir\\"), "\\\\server\\share\\dir");
  assert.equal(normalizePickedPath("C:\\José Peña\\"), "C:\\José Peña");
  assert.equal(normalizePickedPath(""), "");
});

test("the TUI $VISUAL editor opts out of hiding", () => {
  const src = fs.readFileSync(path.join(SRC, "interfaces", "tui", "util", "editor.ts"), "utf8");
  const call = src.match(/Process\.spawn\(\[[\s\S]*?\}\s*\)/);
  assert.ok(call && call[0].includes("windowsHide: false"),
    "a GUI editor spawned hidden is invisible forever and the caller waits on it");
  // H11: the shim must NOT honour shell — base semantics, args stay an array.
  const shim = fs.readFileSync(path.join(SRC, "interfaces", "tui", "_shims", "util-process.ts"), "utf8");
  assert.doesNotMatch(shim, /shell:\s*opts\.shell/, "shell:true would split paths with spaces — not r4's business");
});

// ---------------------------------------------------------------------------
// the ratchet — fail closed on anything the analyzer cannot classify
// ---------------------------------------------------------------------------

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const SOURCE_EXT = new Set([".js", ".cjs", ".mjs", ".ts", ".tsx", ".mts", ".cts"]);
const PROCS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);
const CP_MODULES = new Set(["child_process", "node:child_process"]);
const NS = "@namespace";
const REQFN = "@reqfn";

// kind: "posix" | "interactive" | "gui" | "central" — what justifies no flag.
const EXCLUSIONS = [
  { file: "core/agent/tools/handlers/run-shell.js", kind: "central", count: 1,
    match: /\.\.\.\s*options/,
    why: "options come from shellCommand() — windowsHide arrives via the spread" },
  { file: "core/routines/runner.js", kind: "central", count: 2,
    match: /\.\.\.\s*options/,
    why: "options come from shellCommand() — windowsHide arrives via the spread" },
  { file: "core/agent/shell/background.js", kind: "central", count: 1,
    match: /\.\.\.\s*shell\.options/,
    why: "the direct-spawn fallback (injected spawnFn) inherits shell.options; " +
         "the real Windows path is spawnWindowsJob in win-hidden-run.js" },
  { file: "core/daemon/service.js", kind: "posix", count: 7,
    match: /launchctl|systemctl/,
    why: "launchctl (darwin) / systemctl (linux) branches never run on Windows" },
  { file: "core/desktop/autostart.js", kind: "posix", count: 3,
    match: /launchctl/,
    why: "launchctl only runs in the platform === 'darwin' branch" },
  { file: "host/daemon/deck-exec.js", kind: "posix", count: 1,
    match: /osascript/,
    why: "osascript is a darwin-only open_app action" },
  { file: "host/daemon/api/admin.js", kind: "gui", count: 1,
    match: /wscriptPath\(\)/,
    why: "the BrowseForFolder dialog IS the point — wscript is a GUI host so " +
         "the dialog shows with zero console anywhere in the tree" },
  { file: "host/daemon/api/admin.js", kind: "posix", count: 1,
    match: /\(err, stdout\)/,
    why: "the zenity/kdialog/osascript picker below the win32 branch — this " +
         "execFile only serves darwin and linux" },
  { file: "interfaces/cli/commands/update.js", kind: "interactive", count: 5,
    match: /stdio:\s*"inherit"/,
    why: "install/daemon steps stream to the user's own console" },
  { file: "interfaces/cli/commands/session.js", kind: "interactive", count: 1,
    match: /stdio:\s*"inherit"/,
    why: "interactive runtime CLI hand-off — the human types into it" },
  { file: "interfaces/cli/commands/project-config.js", kind: "interactive", count: 1,
    match: /stdio:\s*"inherit"/,
    why: "$VISUAL/$EDITOR takes over the user's terminal by design" },
  { file: "interfaces/cli/commands/code.js", kind: "interactive", count: 1,
    match: /stdio:\s*"inherit"/,
    why: "the TUI is the product — its terminal is the point" },
  { file: "interfaces/cli/commands/artifact.js", kind: "interactive", count: 1,
    match: /stdio:\s*"inherit"/,
    why: "a run script streams to the user's terminal by design" },
  { file: "interfaces/cli/commands/image.js", kind: "gui", count: 1,
    match: /detached:\s*true/,
    why: "openFile() exists to open the OS viewer — visible is the feature" },
];

function* sources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* sources(p);
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      yield p;
    }
  }
}

const isCpModule = (t) => CP_MODULES.has(t);
const MODULE_MODULES = new Set(["module", "node:module"]);
// Other process-creating surfaces the inventory must own: cluster.fork makes
// workers; process/module globals reach loaders like getBuiltinModule and
// module.require. These markers make every such acquisition auditable.
const CLUSTER_MODULES = new Set(["cluster", "node:cluster"]);
const PROCESS_MODULES = new Set(["process", "node:process"]);
const GLOBAL_MARKERS = {
  require: "@require-global",
  process: "@process-global",
  module: "@module-global",
};
// Members that ARE process-creation loaders — reading them as a value
// (const f = process.getBuiltinModule) propagates the loader outside any
// declared import channel, so the marker itself is audit-visible.
const LOADER_MEMBERS = new Set(["getBuiltinModule", "require", "createRequire"]);
// Globals whose VALUE uses are benign — only flagged member accesses matter.
// `process` is ubiquitous; everything else touching it is either a flagged
// member (.getBuiltinModule) or a flagged call (r("child_process")).
const BENIGN_GLOBALS = new Set(["@process-global", "@module-global", "@require-global", "@module-ns"]);

/**
 * Audit a set of files. Returns { hidden, excluded, violations[] }.
 * Every resolved child_process reference MUST be either a classifiable
 * invocation or a recognised binding position — anything else is a violation.
 */
function auditFiles(files, { exclusions = [] } = {}) {
  const program = ts.createProgram(files, {
    allowJs: true, checkJs: false, noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.React,
  });
  const checker = program.getTypeChecker();
  const byFile = new Map();
  for (const e of exclusions) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push({ ...e, seen: 0 });
  }
  const results = { hidden: 0, excluded: 0, violations: [] };


  /** Unwrap the noise: parens, await, as/satisfies, non-null. */
  const unwrap = (n) => {
    for (;;) {
      if (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n) ||
          ts.isAsExpression(n) || ts.isNonNullExpression(n) ||
          (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n))) {
        n = n.expression; continue;
      }
      return n;
    }
  };

  /** What does this expression resolve to? proc name | NS | REQFN | null. */
  function resolveExpr(node, sf, depth = 0) {
    if (depth > 12 || !node) return null;
    node = unwrap(node);
    if (ts.isIdentifier(node)) return resolveIdent(node, sf, depth + 1);
    if (ts.isPropertyAccessExpression(node)) {
      const base = resolveExpr(node.expression, sf, depth + 1);
      if (base === NS) return PROCS.has(node.name.text) ? node.name.text : "@member";
      if (base === "@cluster") return node.name.text === "fork" ? "@cluster-fork" : "@cluster-member";
      // process.getBuiltinModule / module.require read AS A VALUE — the
      // loader itself is escaping the declared channels.
      if (LOADER_MEMBERS.has(node.name.text) &&
          (base === "@process-global" || base === "@module-global" || base === "@module-ns")) {
        return "@loader";
      }
      if (PROCS.has(base)) return "@proc-member";
      return null;
    }
    if (ts.isElementAccessExpression(node)) {
      const base = resolveExpr(node.expression, sf, depth + 1);
      const el = node.argumentExpression;
      if (el && ts.isStringLiteral(el) && LOADER_MEMBERS.has(el.text) &&
          (base === "@process-global" || base === "@module-global" || base === "@module-ns")) {
        return "@loader";
      }
      if (base === NS) {
        const a = node.argumentExpression;
        if (a && ts.isStringLiteral(a)) return PROCS.has(a.text) ? a.text : "@member";
        return "@dynamic";
      }
      if (PROCS.has(base)) return "@proc-member";
      return null;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      // require("child_process") / require(<computed>) — a non-literal target
      // is an unanalysable acquisition: the result is marked opaque so proc
      // member calls on it fail closed.
      if (ts.isIdentifier(callee) && callee.text === "require") {
        const m = node.arguments[0]?.text;
        if (isCpModule(m)) return NS;
        if (CLUSTER_MODULES.has(m)) return "@cluster";
        if (MODULE_MODULES.has(m)) return "@module-ns";
        if (PROCESS_MODULES.has(m)) return "@process-global";
        const arg = node.arguments[0];
        if (arg && !ts.isStringLiteral(arg)) return "@opaque-import";
        return null;
      }
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          if (isCpModule(arg.text)) return NS;
          if (CLUSTER_MODULES.has(arg.text)) return "@cluster";
          if (MODULE_MODULES.has(arg.text)) return "@module-ns";
          if (PROCESS_MODULES.has(arg.text)) return "@process-global";
          return null;
        }
        // import(<computed>) — an unresolvable module. It MIGHT be cp, so the
        // result is marked: member calls with process-creating names fail.
        return "@opaque-import";
      }
      // promisify(x)
      if ((ts.isIdentifier(callee) && callee.text === "promisify") ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === "promisify")) {
        return node.arguments[0] ? resolveExpr(node.arguments[0], sf, depth + 1) : null;
      }
      // req("child_process") where req came from createRequire
      if (isCpModule(node.arguments[0]?.text)) {
        const c = resolveExpr(callee, sf, depth + 1);
        return c === REQFN ? NS : null;
      }
      // createRequire(x) → the require function
      if (ts.isIdentifier(callee) && callee.text === "createRequire") {
        const d = resolveIdent(callee, sf, depth + 1);
        return d === "@createRequire" || d === REQFN ? REQFN : null;
      }
      // r("child_process") where r aliases the global require → the result
      // still binds the namespace (the acquisition itself is flagged
      // separately — see the callee checks).
      if (ts.isIdentifier(callee) && isCpModule(node.arguments[0]?.text)) {
        const c = resolveExpr(callee, sf, depth + 1);
        if (c === "@require-global" || c === REQFN) return NS;
      }
      // X.getBuiltinModule("child_process") / X.require("child_process")
      if (ts.isPropertyAccessExpression(callee) &&
          (callee.name.text === "getBuiltinModule" || callee.name.text === "require")) {
        const m = node.arguments[0]?.text;
        if (isCpModule(m)) return NS;
        if (CLUSTER_MODULES.has(m)) return "@cluster";
        return null;
      }
      return null;
    }
    // a ?? b / a || b / a && b / c ? a : b — either side may surface a cp fn;
    // "@merged" marks the result as cp-bound without claiming a specific name.
    if (ts.isConditionalExpression(node)) {
      const a = resolveExpr(node.whenTrue, sf, depth + 1);
      const b = resolveExpr(node.whenFalse, sf, depth + 1);
      return a || b ? "@merged" : null;
    }
    if (ts.isBinaryExpression(node) && (
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) {
      const a = resolveExpr(node.left, sf, depth + 1);
      const b = resolveExpr(node.right, sf, depth + 1);
      return a || b ? "@merged" : null;
    }
    // () => execFile — a thunk returning a cp fn.
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        node.body && !ts.isBlock(node.body)) {
      return resolveExpr(node.body, sf, depth + 1);
    }
    return null;
  }

  function resolveIdent(id, sf, depth) {
    let sym;
    try { sym = checker.getSymbolAtLocation(id); } catch { return GLOBAL_MARKERS[id.text] ?? null; }
    if (!sym) return GLOBAL_MARKERS[id.text] ?? null;
    let resolved = sym;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try { resolved = checker.getAliasedSymbol(sym); } catch { resolved = sym; }
    }
    for (const d of resolved.declarations || []) {
      const r = resolveDecl(d, sf, depth);
      if (r) return r;
    }
    // The alias may not have resolved through a re-export — try the alias's
    // own declarations (e.g. an ImportSpecifier whose module is a local file
    // that re-exports child_process).
    for (const d of sym.declarations || []) {
      const r = resolveDecl(d, sf, depth);
      if (r) return r;
    }
    // Undeclared globals — require/process/module in CJS, or a symbol the
    // checker couldn't resolve to a declaration.
    return GLOBAL_MARKERS[id.text] ?? null;
  }

  function moduleOf(decl, sf) {
    // ImportSpecifier → NamedImports → NamedBindings → ImportDeclaration
    // ExportSpecifier → NamedExports → ExportDeclaration
    let n = decl;
    while (n && !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n) &&
           !ts.isImportEqualsDeclaration(n)) n = n.parent;
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      return n.moduleSpecifier?.text ?? null;
    }
    if (ts.isImportEqualsDeclaration(n)) {
      const ref = n.moduleReference;
      if (ts.isExternalModuleReference(ref)) return ref.expression?.text ?? null;
    }
    return null;
  }

  function resolveDecl(decl, sf, depth) {
    if (depth > 12) return null;
    // Symbols that resolve into @types/node's declarations — the FILE name
    // identifies the module, the declaration name the export.
    const dsf = decl.getSourceFile?.().fileName.replace(/\\/g, "/") ?? "";
    if (/child_process[^/]*\.d\.ts$/.test(dsf)) {
      if (ts.isSourceFile(decl) || ts.isModuleDeclaration?.(decl) || !decl.name) return NS;
      const nm = decl.name.text ?? "";
      return PROCS.has(nm) ? nm : "@member";
    }
    if (ts.isImportSpecifier(decl)) {
      // `import type { ChildProcess }` / `import { type X }` — a type-only
      // binding never executes; it is data for the compiler, not an API.
      // `import type` marks the ImportClause (specifier.parent.parent), the
      // inline `type` marks the specifier itself.
      if (decl.isTypeOnly || decl.parent?.parent?.isTypeOnly) return null;
      const mod = moduleOf(decl, sf);
      const imported = decl.propertyName?.text ?? decl.name.text;
      if (isCpModule(mod)) return PROCS.has(imported) ? imported : "@member";
      if (CLUSTER_MODULES.has(mod)) return imported === "fork" ? "@cluster-fork" : "@cluster-member";
      if (MODULE_MODULES.has(mod) && imported === "createRequire") return REQFN;
      if (PROCESS_MODULES.has(mod)) return "@process-global";
      if (MODULE_MODULES.has(mod)) return "@module-global";
      // Re-export chain: `export { spawn } from "child_process"` in a sibling
      // file. Ask the checker for the module's exports and resolve the name —
      // it chases re-exports the alias symbol alone gives up on.
      const impDecl = decl.parent?.parent?.parent;
      const modSym = impDecl?.moduleSpecifier
        ? safeSym(impDecl.moduleSpecifier) : null;
      if (modSym) {
        for (const e of checker.getExportsOfModule(modSym)) {
          if (e.name !== imported) continue;
          let tgt = e;
          if (tgt.flags & ts.SymbolFlags.Alias) {
            try { tgt = checker.getAliasedSymbol(tgt); } catch { /* keep */ }
          }
          for (const d of [...(tgt.declarations || []), ...(e.declarations || [])]) {
            const r = resolveDecl(d, sf, depth + 1);
            if (r) return r;
          }
        }
      }
      // Re-export chain: resolve the symbol the specifier points at.
      return followSpecifier(decl.name, sf, depth);
    }
    if (ts.isExportSpecifier(decl)) {
      const mod = moduleOf(decl, sf);
      const exported = decl.propertyName?.text ?? decl.name.text;
      if (isCpModule(mod)) return PROCS.has(exported) ? exported : "@member";
      return followSpecifier(decl.name, sf, depth);
    }
    if (ts.isImportClause(decl) || ts.isNamespaceImport(decl) ||
        ts.isImportEqualsDeclaration(decl)) {
      const mod = moduleOf(decl, sf);
      if (isCpModule(mod)) return NS;
      if (CLUSTER_MODULES.has(mod)) return "@cluster";
      if (PROCESS_MODULES.has(mod)) return "@process-global";
      if (MODULE_MODULES.has(mod)) return "@module-global";
      return null;
    }
    if (ts.isBindingElement(decl)) {
      // { spawnFn = spawn } — own initializer wins…
      if (decl.initializer) return resolveExpr(decl.initializer, sf, depth + 1);
      // …then { execFile: ef } destructured from a namespace expression.
      const vd = decl.parent?.parent;
      if (vd && (ts.isVariableDeclaration(vd) || ts.isParameter(vd)) && vd.initializer) {
        const base = resolveExpr(vd.initializer, sf, depth + 1);
        if (base === NS) {
          const imported = decl.propertyName ? decl.propertyName.getText(sf) : decl.name.getText(sf);
          return PROCS.has(imported) ? imported : "@member";
        }
        if (base === "@cluster") {
          const imported = decl.propertyName ? decl.propertyName.getText(sf) : decl.name.getText(sf);
          return imported === "fork" ? "@cluster-fork" : "@cluster-member";
        }
        // const { getBuiltinModule } = process / { require: load } = module /
        // { createRequire } = require("node:module") — a loader destructured
        // as a value propagates outside the declared channels.
        if (base === "@process-global" || base === "@module-global" || base === "@module-ns") {
          const imported = decl.propertyName ? decl.propertyName.getText(sf) : decl.name.getText(sf);
          if (imported === "getBuiltinModule" || imported === "require") return "@loader";
          if (imported === "createRequire") return REQFN;
          return null;
        }
        if (base === "@opaque-import") return base;
        return base;
      }
      return null;
    }
    if ((ts.isVariableDeclaration(decl) || ts.isParameter(decl)) && decl.initializer) {
      if (ts.isIdentifier(decl.name)) {
        const init = unwrap(decl.initializer);
        // const o = { spawn } / { go: spawn } / [spawn] / {...cp} — cp fns
        // stored in a container. We cannot prove which member/element is
        // later invoked, so flag the CONTAINER: any indirect call through
        // it is an unclassifiable invocation → violation.
        if (ts.isObjectLiteralExpression(init)) {
          const hasProc = init.properties.some((p) => {
            if (ts.isShorthandPropertyAssignment(p)) {
              // `p.name`'s own symbol is the PROPERTY — chase the VALUE symbol.
              let vs = null;
              try { vs = checker.getShorthandAssignmentValueSymbol?.(p); } catch { /* older ts */ }
              for (const d of vs?.declarations || []) {
                if (resolveDecl(d, sf, depth + 1)) return true;
              }
              return false;
            }
            if (ts.isPropertyAssignment(p) && p.initializer) {
              return !!resolveExpr(p.initializer, sf, depth + 1);
            }
            if (ts.isSpreadAssignment(p)) {
              return !!resolveExpr(p.expression, sf, depth + 1);
            }
            return false;
          });
          if (hasProc) return "@objproc";
        }
        if (ts.isArrayLiteralExpression(init)) {
          const hasProc = init.elements.some((e) =>
            !ts.isOmittedExpression(e) && !!resolveExpr(e, sf, depth + 1));
          if (hasProc) return "@arrproc";
        }
        return resolveExpr(decl.initializer, sf, depth + 1);
      }
      return null;
    }
    return null;
  }

  const safeSym = (n) => {
    try { return checker.getSymbolAtLocation(n); } catch { return null; }
  };

  /** Chase `import {x as y} from "./local"` → the decl `x` names elsewhere. */
  function followSpecifier(nameNode, sf, depth) {
    if (depth > 12) return null;
    let sym;
    try { sym = checker.getSymbolAtLocation(nameNode); } catch { return null; }
    if (!sym) return null;
    let resolved = sym;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try { resolved = checker.getAliasedSymbol(sym); } catch { resolved = sym; }
    }
    if (resolved === sym) return null;
    for (const d of resolved.declarations || []) {
      const r = resolveDecl(d, sf, depth + 1);
      if (r) return r;
    }
    return null;
  }

  /** The options object is the LAST object-literal argument. */
  function classifyCall(call, fn, sf) {
    let opts = null;
    for (const a of call.arguments) if (ts.isObjectLiteralExpression(a)) opts = a;
    if (!opts) {
      const expectedIdx = { exec: 1, execSync: 1, fork: 2 }[fn] ?? 2;
      if (call.arguments[expectedIdx]) return "opaque";
      return "none";
    }
    let whIdx = -1, whInit = null, lastSpread = -1, hasComputedKey = false;
    opts.properties.forEach((p, i) => {
      if (ts.isSpreadAssignment(p)) { lastSpread = i; return; }
      if (!ts.isPropertyAssignment(p)) return;
      // ["win"+"dowsHide"]: false — a computed key could be anything,
      // including windowsHide. Unverifiable → never "hidden".
      if (ts.isComputedPropertyName?.(p.name)) { hasComputedKey = true; return; }
      const nm = (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
      if (nm === "windowsHide") { whIdx = i; whInit = p.initializer; }
    });
    if (hasComputedKey) return "computed-key";
    if (whIdx >= 0) {
      // {windowsHide:true, ...o} — a later spread can override the flag.
      if (lastSpread > whIdx) return "overridable";
      if (whInit.kind === ts.SyntaxKind.TrueKeyword) return "hidden";
      if (whInit.kind === ts.SyntaxKind.FalseKeyword) return "shown";
      if (/\?\?\s*true\s*$/.test(whInit.getText(sf))) return "hidden";
      return "opaque";
    }
    return lastSpread >= 0 ? "delegated" : "shown";
  }

  /** Is `node` inside a declaration-name position (binding, not use)? */
  function isDeclPosition(id) {
    const p = id.parent;
    if (!p) return false;
    // A shorthand `{ spawn }` is a USE — the name doubles as the value.
    if (ts.isShorthandPropertyAssignment?.(p)) return false;
    // A member NAME (`x.stdout`, `cp.execFile`) is not a reference — the
    // receiver carries the binding and the callee checks handle calls.
    if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
    if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isBindingElement(p) ||
         ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isPropertyAssignment(p) ||
         ts.isPropertySignature?.(p) || ts.isMethodSignature?.(p)) &&
        (p.name === id || p.propertyName === id)) return true;
    if (ts.isNamespaceImport(p) || ts.isImportClause(p) || ts.isImportEqualsDeclaration(p)) return true;
    return false;
  }

  /** Context rules for a resolved cp reference that is NOT a direct callee. */
  function isAllowedNonCallUse(id) {
    // A type position never executes — `c: ChildProcess`, `x is T`, qualified
    // type names are compiler data even when the symbol traces to the d.ts.
    let q = id;
    while (q.parent && ts.isQualifiedName(q.parent)) q = q.parent;
    if (q.parent && ts.isTypeReferenceNode(q.parent) && q.parent.typeName === q) return true;
    if (id.parent && ts.isTypeQueryNode(id.parent)) return true; // typeof X in a type
    // Walk up through expression nodes; the first STRUCTURAL boundary decides:
    //   const x = <…id…>  → alias declaration (tracked)        → ok
    //   promisify(<…id…>) → alias declaration (tracked)        → ok
    //   anything else     → a use we cannot reason about       → violation
    for (let p = id.parent; p && !ts.isSourceFile(p); p = p.parent) {
      if (ts.isVariableDeclaration(p) || ts.isBindingElement(p) || ts.isParameter(p)) {
        return !!(p.initializer && isWithin(id, p.initializer));
      }
      if (ts.isCallExpression(p)) {
        const callee = unwrap(p.expression);
        const isProm =
          (ts.isIdentifier(callee) && callee.text === "promisify") ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === "promisify");
        return isProm && isWithin(id, p.arguments[0]);
      }
      // `spawn === other` — an identity check invokes nothing.
      if (ts.isBinaryExpression(p) &&
          (p.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
           p.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
        return true;
      }
      // `typeof require` — a presence guard, not an acquisition.
      if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.TypeOfKeyword) {
        return true;
      }
      // A cp fn escaping through `return` can't be tracked to its caller.
      if (ts.isReturnStatement?.(p)) return false;
    }
    return false;
  }
  const isWithin = (node, root) => {
    let found = false;
    const walk = (n) => { if (n === node) found = true; ts.forEachChild(n, walk); };
    if (root) walk(root);
    return found;
  };

  /** Does this subtree contain an identifier bound to child_process? */
  const containsBoundRef = (root, sf) => {
    let found = false;
    const walk = (n) => {
      if (found) return;
      if (ts.isIdentifier(n) && !isDeclPosition(n)) {
        const r = resolveExpr(n, sf);
        if (r && !BENIGN_GLOBALS.has(r)) found = true;
      }
      ts.forEachChild(n, walk);
    };
    walk(root);
    return found;
  };

  /** Does this subtree contain ANY expression carrying a process-creation
   *  API — a namespace, a proc member, a loader, an opaque import? Container
   *  literals (objects, arrays) resolve to null themselves, so propagation
   *  rules must look INSIDE them, not just at the top-level expression. */
  const containsProcApi = (root, sf) => {
    let found = false;
    const walk = (n) => {
      if (found) return;
      if (ts.isShorthandPropertyAssignment(n)) {
        // `{ spawn }` — the name's symbol is the property; chase the VALUE.
        let vs = null;
        try { vs = checker.getShorthandAssignmentValueSymbol?.(n); } catch { /* older ts */ }
        for (const d of vs?.declarations || []) {
          if (resolveDecl(d, sf)) { found = true; return; }
        }
      }
      if (ts.isIdentifier(n) && !isDeclPosition(n)) {
        const pp = n.parent;
        // The base of `cp.spawn` is consumed by the member access — that
        // node itself is evaluated below (or by the callee skip). And a
        // direct callee `spawn(…)` is an INVOCATION the call-pass
        // classifies — its result, a ChildProcess, is not the API.
        const isMemberBase = (ts.isPropertyAccessExpression(pp) ||
                              ts.isElementAccessExpression(pp)) && pp.expression === n;
        const isCallee = ts.isCallExpression(pp) && unwrap(pp.expression) === n;
        if (!isMemberBase && !isCallee) {
          const r = resolveExpr(n, sf);
          if (r && !BENIGN_GLOBALS.has(r)) { found = true; return; }
        }
      }
      if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
        // `cp.spawn("x")` stores a RESULT — only a member read that is not an
        // invocation carries the API itself.
        const pp = n.parent;
        const isCalleePos = ts.isCallExpression(pp) && unwrap(pp.expression) === n;
        if (!isCalleePos) {
          const r = resolveExpr(n, sf);
          if (r && !BENIGN_GLOBALS.has(r)) { found = true; return; }
        }
      }
      if (ts.isCallExpression(n)) {
        const r = resolveExpr(n, sf);
        if (r && !BENIGN_GLOBALS.has(r)) { found = true; return; }
      }
      ts.forEachChild(n, walk);
    };
    walk(root);
    return found;
  };

  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) { results.violations.push(`${file}: could not be parsed`); continue; }
    const rel = path.relative(SRC, sf.fileName).split(path.sep).join("/");

    const visit = (node) => {
      // 1. A bare "child_process" STRING is data, not an acquisition — only a
      //    re-export declaration can propagate the module itself.
      if (ts.isStringLiteral(node) && isCpModule(node.text) &&
          ts.isExportDeclaration(node.parent) && node.parent.moduleSpecifier === node) {
        results.violations.push(`${rel}: re-exports child_process — downstream use escapes the audit`);
      }
      // Re-exporting a cp-bound name — `export { spawn }` — is the same hole.
      if (ts.isExportSpecifier(node)) {
        const ref = node.propertyName ?? node.name;
        if (ref && resolveExpr(ref, sf)) {
          results.violations.push(`${rel}: exports a child_process binding`);
        }
      }
      // PROPAGATION — the inventory owns where the API can flow:
      //   return require("child_process")   → escapes through the caller
      //   module.exports = require("…")     → escapes through the module
      //   x = spawn                         → rebinds outside the declaration
      // A call RESULT (spawn(...)) is a ChildProcess, not the API — fine.
      if (ts.isReturnStatement?.(node) && node.expression) {
        const r = resolveExpr(node.expression, sf);
        if ((r && !BENIGN_GLOBALS.has(r)) || containsProcApi(node.expression, sf)) {
          results.violations.push(`${rel}: returns a process-creation API — escapes the audit boundary`);
        }
      }
      if (ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const r = resolveExpr(node.right, sf);
        // `module.exports = { spawn: require("child_process").spawn }` — the
        // container itself resolves to nothing; the API inside escapes the
        // point where a later call-site could be classified.
        if ((r && !BENIGN_GLOBALS.has(r)) || containsProcApi(node.right, sf)) {
          results.violations.push(`${rel}: assigns a process-creation API — escapes the audit boundary`);
        }
      }
      // A loader member read as a VALUE — `use(process.getBuiltinModule)`,
      // `{ loader: module.require }`, `[process["getBuiltinModule"]]`. The
      // identifier pass never sees it (`process` is benign, the member name
      // is a declaration position), so the member-access node itself is
      // checked. Allowed positions: a tracked direct binding, the callee the
      // call-pass classifies, and non-executing probes (===, typeof).
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        if (resolveExpr(node, sf) === "@loader") {
          const p = node.parent;
          const isCalleePos = ts.isCallExpression(p) && unwrap(p.expression) === node;
          const isDirectInit = (ts.isVariableDeclaration(p) || ts.isBindingElement(p)) &&
                               p.initializer != null && unwrap(p.initializer) === node;
          const isIdentity = ts.isBinaryExpression(p) &&
            (p.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
             p.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken);
          const isTypeof = ts.isPrefixUnaryExpression(p) &&
            p.operator === ts.SyntaxKind.TypeOfKeyword;
          if (!isCalleePos && !isDirectInit && !isIdentity && !isTypeof) {
            results.violations.push(
              `${rel}: a process-creation loader escapes as a value — ${node.getText(sf).slice(0, 60)}`);
          }
        }
      }
      // 2. Invocations — resolve the callee expression itself. Covers member
      //    calls on non-identifier receivers: req("child_process").spawn(…),
      //    (await import("child_process")).execFile(…), o.spawn(…).
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
          const member = ts.isPropertyAccessExpression(callee) ? callee.name.text
            : (callee.argumentExpression && ts.isStringLiteral(callee.argumentExpression)
                ? callee.argumentExpression.text : null);
          // Loaders that acquire process-creating builtins outside the
          // declared import channels — flagged no matter the receiver.
          if (member === "getBuiltinModule") {
            results.violations.push(`${rel}: getBuiltinModule() acquires builtins outside declared imports`);
          } else if (member === "require" && isCpModule(node.arguments[0]?.text)) {
            results.violations.push(`${rel}: child_process acquired through .require() — use a declared import/require()`);
          }
          const recv = resolveExpr(callee.expression, sf);
          if (recv === NS) {
            if (member && PROCS.has(member)) reportCall(rel, node, member, sf);
            else if (!member) {
              results.violations.push(`${rel}: child_process invoked through an unresolvable member`);
            }
          } else if (recv === "@cluster" && member === "fork") {
            reportCall(rel, node, "fork", sf);
          } else if (recv === "@opaque-import" && member && PROCS.has(member)) {
            results.violations.push(`${rel}: ${member}() on a module the analyzer cannot resolve`);
          } else if (recv === "@objproc" || recv === "@arrproc" || recv === "@dynamic") {
            results.violations.push(`${rel}: child_process stored then invoked indirectly`);
          }
        } else if (!ts.isIdentifier(callee) && containsBoundRef(callee, sf)) {
          results.violations.push(`${rel}: child_process invoked through a compound callee`);
        }
      }
      // 3. Resolved cp references — any non-null resolution is our business.
      if (ts.isIdentifier(node) && !isDeclPosition(node)) {
        const r = resolveExpr(node, sf);
        if (r) {
          const p = node.parent;
          const isDirectCallee = ts.isCallExpression(p) && unwrap(p.expression) === node;
          const memberCallee =
            (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) &&
            p.expression === node &&
            ts.isCallExpression(p.parent) && unwrap(p.parent.expression) === p;
          if (isDirectCallee) {
            if (PROCS.has(r) || r === "@cluster-fork") reportCall(rel, p, r, sf);
            else if (r === REQFN) {
              // req("…") is a module acquisition, not a process: it is only
              // child_process if the argument names our module — tracked via
              // resolveExpr on the call itself. Other modules are not ours.
              if (isCpModule(p.arguments[0]?.text)) { /* the result binds NS — fine */ }
            } else if (r === "@loader") {
              // A stored loader invoked — load("node:child_process") where
              // load = process.getBuiltinModule / module.require / a
              // destructured loader. Calling it AT ALL is unverifiable;
              // flag when the target is our module or opaque.
              const arg = p.arguments[0];
              if (!arg || !ts.isStringLiteral(arg) || isCpModule(arg.text) ||
                  CLUSTER_MODULES.has(arg.text)) {
                results.violations.push(`${rel}: process creation acquired through a stored loader`);
              }
            } else if (r === "@require-global") {
              // The bare `require` identifier is the declared channel. An
              // ALIAS (const r = require; r("child_process")) hides the
              // acquisition — only flagged when it names our module.
              if (node.text !== "require" && isCpModule(p.arguments[0]?.text)) {
                results.violations.push(`${rel}: child_process acquired through an aliased require()`);
              }
            } else if (BENIGN_GLOBALS.has(r)) {
              // require("fs") / process() — globals that aren't invoking.
            } else {
              results.violations.push(`${rel}: ${node.text} (${r}) invoked as callee`);
            }
          } else if (memberCallee) {
            const member = ts.isPropertyAccessExpression(p) ? p.name.text : null;
            if (r === NS && member && PROCS.has(member)) reportCall(rel, p.parent, member, sf);
            else if (r === NS && ts.isElementAccessExpression(p) && p.argumentExpression &&
                     ts.isStringLiteral(p.argumentExpression) && PROCS.has(p.argumentExpression.text)) {
              reportCall(rel, p.parent, p.argumentExpression.text, sf);
            } else if (r === NS && member && !PROCS.has(member)) {
              // cp.notAProc — a value/type member, not an invocation.
            } else if (r === "@cluster" || r === "@cluster-member" ||
                       BENIGN_GLOBALS.has(r) || r === "@opaque-import") {
              // Member access on a global/opaque container: flagged members
              // (getBuiltinModule, .require("child_process"), cluster.fork,
              // cp proc names) were already pushed by the call pass; the
              // rest of the surface is not ours.
            } else {
              results.violations.push(
                `${rel}: ${node.text} (${r}) invoked through an unresolvable member`,
              );
            }
          } else if (r === REQFN || r === "@loader" || r === "@require-global") {
            // A loader used as a VALUE — wrap(createRequire), use(require),
            // storing getBuiltinModule — escapes the declared channels.
            // `require.resolve`/`require.cache` are member reads on the
            // function object, not the function escaping as a value.
            const pp = node.parent;
            const memberBase = (ts.isPropertyAccessExpression(pp) ||
                                ts.isElementAccessExpression(pp)) && pp.expression === node;
            if (!memberBase && !isAllowedNonCallUse(node)) {
              results.violations.push(
                `${rel}: ${node.text} (${r}) — a process-creation loader escapes as a value`,
              );
            }
          } else if (BENIGN_GLOBALS.has(r)) {
            // process/module/require as plain values — flagged members and
            // call forms are handled above; the rest is not ours.
          } else if (!isAllowedNonCallUse(node)) {
            results.violations.push(
              `${rel}: ${node.text} (${r}) used where the analyzer cannot prove it safe`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    const reported = new Set();
    function reportCall(rel, call, fn, sf) {
      if (reported.has(call)) return;
      reported.add(call);
      const cls = classifyCall(call, fn, sf);
      if (cls === "hidden") { results.hidden++; return; }
      const text = call.getText(sf);
      const list = byFile.get(rel) || [];
      const match = list.find((e) => e.seen < e.count && e.match.test(text));
      if (match) { match.seen++; results.excluded++; return; }
      results.violations.push(
        `${rel} — ${fn}() classified "${cls}": ${text.slice(0, 140)}`,
      );
    }

    // Every file is walked — an alias (`import {run} from "./wrap.js"`) may
    // resolve to child_process without any keyword appearing in this file.
    visit(sf);
  }

  for (const list of byFile.values()) {
    for (const e of list) {
      if (e.seen !== e.count) {
        results.violations.push(`${e.file}: stale exclusion — expected ${e.count}, matched ${e.seen}`);
      }
    }
  }
  return results;
}

test("every child_process call-site under src/ is hidden or justified", () => {
  const files = [...sources(SRC)];
  const { hidden, violations } = auditFiles(files, { exclusions: EXCLUSIONS });
  assert.ok(hidden > 30, `sanity: expected >30 hidden sites, found ${hidden}`);
  assert.deepEqual(violations, [],
    "every process creation must be hidden or carry a written exclusion:\n  " +
    violations.join("\n  "));
});

// The adversarial corpus: each fixture is a shape the audit must REJECT.
test("the ratchet fails closed on adversarial child_process shapes", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "winhide-attacks");
  const files = [...sources(dir)];
  assert.ok(files.length >= 10, "the corpus must cover the demonstrated evasions");
  const { violations } = auditFiles(files, { exclusions: [] });
  // Every attack file must produce at least one violation naming it.
  const named = new Set(violations.map((v) => v.split("—")[0].split(":")[0].trim()));
  const missed = files
    .map((f) => path.relative(dir, f).split(path.sep).join("/"))
    .filter((f) => ![...named].some((n) => n.endsWith(f) || f.endsWith(n)));
  assert.deepEqual(missed, [],
    `attack files the scanner let through:\n  ${missed.join("\n  ")}\n` +
    `violations were:\n  ${violations.join("\n  ")}`);
});

// The ratchet only owns process creation. Code that merely LOOKS adjacent —
// a type-only import, a data string, a comment, our own `spawn` method — is
// outside the contract and must pass untouched.
test("the ratchet ignores type-only imports, data strings and unrelated code", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "winhide-controls");
  const files = [...sources(dir)];
  assert.ok(files.length >= 5, "the controls corpus must cover the false-positive shapes");
  const { violations, hidden } = auditFiles(files, { exclusions: [] });
  assert.deepEqual(violations, [],
    `control code must not be flagged:\n  ${violations.join("\n  ")}`);
  assert.equal(hidden, 0, "control code holds no child_process call-sites");
});
