import { spawn } from "node:child_process";
export const f = (c) => (c ? spawn : spawn)("x");
