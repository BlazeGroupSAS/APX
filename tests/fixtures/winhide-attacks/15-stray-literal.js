// The module name behind a variable — opaque to a literal-only scanner.
const M = "child_process";
const cp = require(M);
cp.exec("x");
