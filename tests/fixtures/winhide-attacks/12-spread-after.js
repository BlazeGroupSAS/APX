import { spawn } from "node:child_process";
spawn("x", [], { windowsHide: true, ...process.env.__opts });
