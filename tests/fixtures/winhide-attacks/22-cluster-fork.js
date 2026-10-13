import cluster from "node:cluster";
cluster.fork({ SOME_ENV: "1" });
