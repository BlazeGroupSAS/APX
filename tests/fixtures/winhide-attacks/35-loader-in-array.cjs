const loaders = [module.require];
loaders[0]("child_process").exec("x");
