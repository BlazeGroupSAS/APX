function factory() {
  return require("child_process");
}
const cp = factory();
cp.spawn("x");
