import { spawn, execFile } from "child_process";
const fns = [spawn, execFile];
fns[0]("x");
