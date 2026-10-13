import type { ChildProcess } from "node:child_process";
export function pidOf(c: ChildProcess): number {
  return c.pid ?? -1;
}
