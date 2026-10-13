const { getBuiltinModule } = process;
getBuiltinModule("node:child_process").execFile("x");
