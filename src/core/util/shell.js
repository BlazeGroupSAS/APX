import { spawnSync } from "node:child_process";

// How to hand a command line to the platform's shell.
//
// WHY THIS IS A FILE AND NOT THREE INLINE CALLS. `spawn("sh", ["-lc", cmd])`
// was written out in three places — the run_shell tool and both of the routine
// runner's command hooks — and on Windows there is no `sh` unless the user
// happens to have Git Bash on PATH.
//
// What that produced was not an error message. `spawn` fails asynchronously
// with ENOENT, and an unlistened `error` event on a ChildProcess is thrown from
// inside the tick that would have gone on to emit `close` — so `close` never
// arrives and a caller waiting for it waits forever. The daemon logs the
// uncaught ENOENT and keeps running by design, so nothing anywhere says the
// turn is dead. Reported from the outside on 2026-09-18 as an action that
// "hangs waiting and will not let you interrupt or cancel". See the header of
// `run_shell`'s `run()` for the measurement, including the probe that hid it.
//
// npm installs this package on Windows without complaint (there is no `os`
// field in package.json) and `core/daemon/service.js` registers a Windows
// startup entry, so Windows is a platform this ships to. One home for the
// decision, and all three callers get the fix.
//
// THE WINDOWS FORM IS NODE'S OWN. `cmd.exe /d /s /c "…"` with
// `windowsVerbatimArguments` is what `child_process.exec` itself uses: /d skips
// AutoRun commands from the registry, /s plus the wrapping quotes give cmd its
// documented "strip the outer pair and take the rest literally" rule, and
// verbatim arguments stop Node re-quoting a string cmd has already been told
// how to read. Rolling our own quoting is how a command with an inner quote in
// it — the case actually reported — ends up mangled.
//
// LOGIN SHELL OR NOT is a real distinction, not a detail to normalise away. The
// tool wants a login shell (`-lc`) because the daemon can be started by launchd
// with a bare PATH that has no ffmpeg and no npx, and the user's profile is
// what puts them back. A routine's pre/post hook wants the plain `-c` it has
// always had. cmd.exe has no equivalent, so the flag is simply ignored there.

/**
 * The shell invocation for `command` on this platform.
 *
 * @param {string} command                 the command line, as written
 * @param {object} [opts]
 * @param {boolean} [opts.login=false]     use a login shell (POSIX only)
 * @param {string} [opts.platform]         override, for tests
 * @param {object} [opts.env]              override, for tests
 * @returns {{file: string, args: string[], options: object}}
 *          spread `options` into the spawn options — it is empty off Windows.
 */
export function shellCommand(command, { login = false, platform = process.platform, env = process.env } = {}) {
  const line = String(command ?? "");
  if (platform === "win32") {
    return {
      file: env?.ComSpec || env?.comspec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  return {
    file: "sh",
    args: [login ? "-lc" : "-c", line],
    options: {},
  };
}

/** How long a POSIX child gets to die politely before SIGKILL.
 *
 *  A child that ignores SIGTERM can otherwise leave `close` pending forever.
 *  Windows process-tree stops use taskkill /T /F instead, so there is no delayed
 *  escalation on that branch. */
export const KILL_GRACE_MS = 5000;

/**
 * Kill a child, and mean it.
 *
 * When `group` is requested, stops the whole process tree: a detached process
 * group on POSIX, or taskkill /T /F on Windows. Killing only the shell wrapper
 * can otherwise leave the real work running.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {{group?: boolean, graceMs?: number, platform?: string, spawnSyncFn?: Function}} [opts]
 * @returns {() => void} cancels any pending POSIX SIGKILL escalation. The
 *          Windows tree-kill branch returns a no-op cleanup function.
 */
export function killChild(
  child,
  {
    group = false,
    graceMs = KILL_GRACE_MS,
    platform = process.platform,
    spawnSyncFn = spawnSync,
  } = {},
) {
  // Windows has no POSIX process group to signal with -pid. When the caller
  // asks for the whole detached tree, use the platform tool made for that:
  // /T includes descendants and /F makes termination deterministic.
  if (group && platform === "win32" && child?.pid) {
    try {
      const result = spawnSyncFn(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        { windowsHide: true, stdio: "ignore" },
      );

      if (!result?.error && result?.status === 0) {
        return () => {};
      }
    } catch {
      // Fall through to killing the direct child if taskkill itself failed.
    }

    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone, or never started.
    }

    return () => {};
  }

  const signal = (sig) => {
    try {
      if (group && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      // Already gone, or never started. Either way there is nothing to kill.
    }
  };

  signal("SIGTERM");

  const timer = setTimeout(() => signal("SIGKILL"), graceMs);
  timer.unref?.();

  return () => clearTimeout(timer);
}
