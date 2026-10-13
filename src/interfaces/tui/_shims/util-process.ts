import { exec, spawn as nodeSpawn } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

export const Process = {
  // windowsHide defaults to true because every consumer here is an incidental
  // console utility (clipboard, audio players, probes). A caller whose process
  // EXISTS to show UI — a $VISUAL GUI editor — opts out per call with
  // windowsHide: false; see util/editor.ts.
  async run(args: string[], opts: { nothrow?: boolean; windowsHide?: boolean } = {}) {
    try {
      const [cmd, ...rest] = args
      const { stdout, stderr } = await execAsync(
        [cmd, ...rest.map((a) => (a.includes(" ") ? JSON.stringify(a) : a))].join(" "),
        { windowsHide: opts.windowsHide ?? true },
      )
      return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode: 0 }
    } catch (e: any) {
      if (opts.nothrow) {
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 1 }
      }
      throw e
    }
  },

  async text(args: string[], opts: { nothrow?: boolean } = {}) {
    const result = await Process.run(args, opts)
    return { text: result.stdout.toString("utf8"), exitCode: result.exitCode }
  },

  spawn(
    args: string[],
    opts: { stdin?: string; stdout?: string; stderr?: string; shell?: boolean; windowsHide?: boolean } = {},
  ) {
    const [cmd, ...rest] = args
    const child = nodeSpawn(cmd, rest, {
      stdio: [(opts.stdin ?? "inherit") as any, (opts.stdout ?? "inherit") as any, (opts.stderr ?? "inherit") as any],
      // `shell` is accepted for call-shape compatibility and ignored: this
      // shim has no shell support — honouring it would split arguments on
      // spaces. windowsHide is hidden by default with a per-call opt-out for
      // callers whose process exists to show UI.
      windowsHide: opts.windowsHide ?? true,
    })
    const exited = new Promise<number>((resolve, reject) => {
      child.on("exit", (code) => resolve(code ?? 0))
      child.on("error", reject)
    })
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited }
  },
}
