import { createRequire } from "node:module";
function wrap(f) { return f; }
const req = wrap(createRequire);
req("child_process").execFile("x");
