// process/module value surface that creates nothing.
const env = process.env;
const cwd = process.cwd();
const isMain = require.main === module;
export { env, cwd, isMain };
