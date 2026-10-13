const cp = await import("node:child_process");
cp.execFile("x", ["-v"]);
