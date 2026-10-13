import cp from "child_process";
const bag = { go: cp.spawn, alt: cp.execFile };
bag.go("x");
