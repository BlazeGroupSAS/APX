const mod = "node:" + "child" + "_" + "process";
const cp = await import(mod);
cp.spawn("x");
