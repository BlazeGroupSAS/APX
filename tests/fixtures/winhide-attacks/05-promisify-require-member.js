import { promisify } from "node:util";
const go = promisify(require("child_process").execFile);
go("x");
