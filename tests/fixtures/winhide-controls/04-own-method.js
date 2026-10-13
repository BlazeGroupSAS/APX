// A method CALLED spawn on our own class — not child_process.
class Pool {
  spawn(n) { return n; }
}
export const pool = new Pool();
pool.spawn(3);
