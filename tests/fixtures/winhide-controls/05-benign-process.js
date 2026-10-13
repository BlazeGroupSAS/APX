const { cwd } = process;
const here = cwd();
process.on("exit", () => {});
export { here };
