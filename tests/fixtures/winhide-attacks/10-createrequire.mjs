import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
req("child_process").spawn("x");
