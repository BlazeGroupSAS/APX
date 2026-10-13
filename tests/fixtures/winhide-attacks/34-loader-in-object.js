function use(f) { return f; }
const box = { loader: process.getBuiltinModule };
use(box.loader)("node:child_process");
