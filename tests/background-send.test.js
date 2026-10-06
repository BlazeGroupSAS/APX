// Leaving work running, and being woken when it ends.
//
// The turn this comes from (2026-09-11): Ansel needed to tell Roby something,
// had no non-blocking way to do it, shelled out to `apx send … --deliver`, ate
// run_shell's 60 s SIGTERM over a message that HAD been delivered, reported
// "sent ✅" off that failure, and closed its turn. Roby's answer landed on the
// thread nine minutes later and nobody ever read it.
//
// Each test below is one link of that chain, asserted not to happen again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "apx-bgsend-"));
process.env.HOME = TMP_HOME;
process.env.APX_HOME = path.join(TMP_HOME, ".apx");

const { test } = await import("node:test");
const { default: assert } = await import("node:assert/strict");
const { sendInBackground, deliverWake, wakeText, MAX_BACKGROUND_DEPTH } =
  await import("#core/agent/a2a/background.js");
const {
  readJob, listJobs, openJob, closeJob,
  MAX_OPEN_A2A_JOBS_PER_AGENT, DEFAULT_A2A_JOB_TIMEOUT_S, BACKGROUND_JOBS_DIR,
} = await import("#core/stores/background-jobs.js");
const { reconcileBackgroundJobs } = await import("#host/daemon/background-jobs-reconciler.js");

function fresh() {
  try { fs.rmSync(BACKGROUND_JOBS_DIR, { recursive: true, force: true }); } catch { /* nothing there */ }
}

// A project whose roster is REAL. It used to be a path that did not exist, so
// `readAgents` returned nothing and `to: "roby"` resolved to nobody — which
// every test below silently relied on never being checked, and is exactly how
// a job opened for a peer that did not exist went unnoticed until an invented
// peer got itself a thread, a face and a message it never wrote (2026-09-13).
const { makeTempProject } = await import("./_helpers.js");
const projectRoot = makeTempProject({
  name: "northwind",
  agents: [{ slug: "roby", role: "Orchestrator" }, { slug: "ansel", role: "Engineer" }],
});
const project = { id: 7, path: projectRoot, storagePath: "/tmp/northwind-store", name: "northwind", config: {} };

/** A fake peer that answers when the test says so. Records every call, so the
 *  wake-up can be inspected as the message it really is. */
function peerStub() {
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const fn = async (args) => {
    calls.push(args);
    // The first call is the outbound send; later ones are wake-ups, which must
    // not block on the gate or a test could never observe them.
    if (calls.length === 1) return gate;
    return { text: "ack", thread: "t" };
  };
  return { fn, calls, answer: (text) => release({ text, thread: "ansel~roby" }), fail: (e) => release(Promise.reject(e)) };
}

/** A peer that answers at once and records every call. For the paths that do
 *  not need to observe the middle of a run. */
function recorder() {
  const calls = [];
  return { calls, fn: async (args) => { calls.push(args); return { text: "ack", thread: "t" }; } };
}

/** Wait until `check()` returns truthy, or fail loudly. Beats a fixed sleep:
 *  the promise chain settles in microtasks, not on a clock. */
async function until(check, what, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

// ── The turn is not held ────────────────────────────────────────────────────
test("the sender gets its turn back immediately, while the peer is still working", async () => {
  fresh();
  const peer = peerStub();

  const out = sendInBackground({
    project, from: "ansel", to: "roby", body: "orbit status", wake: true,
    messagePeerFn: peer.fn,
  });

  // Returned NOW — this is the whole feature. The peer has not answered.
  assert.equal(out.ok, true);
  assert.match(out.job_id, /^bgjob_/);
  assert.equal(out.status, "running");
  assert.equal(out.thread, "ansel~roby");
  assert.match(out.note, /do NOT wait for it/i);

  await until(() => peer.calls.length === 1, "the peer to be called");
  assert.equal(readJob(out.job_id).timeout_s, DEFAULT_A2A_JOB_TIMEOUT_S);
  assert.equal(peer.calls[0].timeoutMs, DEFAULT_A2A_JOB_TIMEOUT_S * 1000);
  assert.equal(readJob(out.job_id).status, "running", "still running while the peer works");

  peer.answer("the MCP is not registered");
  await until(() => readJob(out.job_id).status === "done", "the job to close");
});

// ── The wake-up ─────────────────────────────────────────────────────────────
test("when the peer answers, the waiter is woken with the result — on the same thread, in reverse", async () => {
  fresh();
  const peer = peerStub();
  sendInBackground({
    project, from: "ansel", to: "roby", body: "orbit status", wake: true,
    messagePeerFn: peer.fn,
  });

  await until(() => peer.calls.length === 1, "the outbound send");
  peer.answer("the MCP is not registered");
  const wake = await until(() => peer.calls[1], "the wake-up");

  // Reversed: the one who WORKED writes back to the one who WAITED, so the
  // wake-up lands in the thread the request already lives in.
  assert.equal(wake.from, "roby");
  assert.equal(wake.to, "ansel");
  assert.match(wake.body, /has finished/);
  assert.match(wake.body, /the MCP is not registered/, "it carries the actual answer");
  assert.match(wake.body, /orbit status/, "and recaps what was asked, for a fresh context");
  assert.match(wake.body, /not waiting on anything any more/i);
});

test("a job that does not ask to be woken is not woken", async () => {
  fresh();
  const peer = peerStub();
  const out = sendInBackground({
    project, from: "ansel", to: "roby", body: "fyi", wake: false,
    messagePeerFn: peer.fn,
  });
  assert.match(out.note, /will NOT be woken/);

  await until(() => peer.calls.length === 1, "the outbound send");
  peer.answer("noted");
  await until(() => readJob(out.job_id).status === "done", "the job to close");

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(peer.calls.length, 1, "no wake-up was sent");
});

test("a peer that fails wakes the waiter with the failure, never dressed up as an answer", async () => {
  fresh();
  const peer = peerStub();
  const out = sendInBackground({
    project, from: "ansel", to: "roby", body: "orbit status", wake: true,
    messagePeerFn: peer.fn,
  });

  await until(() => peer.calls.length === 1, "the outbound send");
  peer.fail(new Error("roby never answered"));

  const wake = await until(() => peer.calls[1], "the wake-up");
  assert.equal(readJob(out.job_id).status, "failed");
  // This is the assertion the incident is actually about: an agent reported
  // success off a failure. The wake-up must make that impossible to misread.
  assert.match(wake.body, /did NOT produce an answer/);
  assert.match(wake.body, /roby never answered/);
  assert.match(wake.body, /Do NOT report this as done/);
});

// ── Idempotency ─────────────────────────────────────────────────────────────
test("a job already claimed is never delivered twice, however many callers arrive", async () => {
  fresh();
  const job = openJob({ project_id: 7, from: "ansel", to: "roby", body: "x", wake: true });
  const done = closeJob(job.id, { status: "done", result: "answer" });
  const peer = recorder();

  const first = await deliverWake(done, { project, messagePeerFn: peer.fn });
  const second = await deliverWake(done, { project, messagePeerFn: peer.fn });
  const third = await deliverWake(done, { project, messagePeerFn: peer.fn });

  assert.equal(first.delivered, true);
  assert.deepEqual([second.delivered, third.delivered], [false, false]);
  assert.equal(second.reason, "already delivered");
  assert.equal(peer.calls.length, 1, "the waiter was messaged exactly once");
});

test("a wake-up that cannot be sent reports why instead of throwing into the daemon", async () => {
  fresh();
  const job = closeJob(openJob({ from: "ansel", to: "roby", wake: true }).id, { status: "done", result: "r" });
  const out = await deliverWake(job, {
    project,
    messagePeerFn: async () => { throw new Error("engine down"); },
  });
  assert.deepEqual(out, { delivered: false, reason: "engine down" });
});

// ── The fan-out walls ───────────────────────────────────────────────────────
test("an agent cannot leave more than its share of work running", () => {
  fresh();
  const peer = peerStub();
  const args = { project, from: "ansel", to: "roby", body: "x", messagePeerFn: peer.fn };

  for (let i = 0; i < MAX_OPEN_A2A_JOBS_PER_AGENT; i++) {
    assert.equal(sendInBackground(args).ok, true);
  }
  const refused = sendInBackground(args);
  assert.equal(refused.ok, undefined);
  // Returned, not thrown: the model has to be able to read this and change plan.
  assert.match(refused.error, new RegExp(`already have ${MAX_OPEN_A2A_JOBS_PER_AGENT} jobs running`));
  assert.match(refused.error, new RegExp(`limit ${MAX_OPEN_A2A_JOBS_PER_AGENT}`));
});

test("a chain of hand-offs stops at the depth wall", () => {
  fresh();
  const peer = peerStub();
  const refused = sendInBackground({
    project, from: "ansel", to: "roby", body: "x", depth: MAX_BACKGROUND_DEPTH + 1,
    messagePeerFn: peer.fn,
  });
  assert.match(refused.error, new RegExp(`depth limit \\(${MAX_BACKGROUND_DEPTH}\\) reached`));
  assert.equal(listJobs().length, 0, "a refused hand-off opens no job");
});

test("a send with nowhere to go is refused rather than opening a job nobody can close", () => {
  fresh();
  assert.match(sendInBackground({ project, from: "ansel" }).error, /from and to are required/);
  assert.match(sendInBackground({ from: "ansel", to: "roby" }).error, /no project/);
  assert.equal(listJobs().length, 0);
});

// THE PHANTOM PEER, 2026-09-13. An agent invented a colleague called Bridget
// mid-turn and handed her a job. Nothing resolved that name, and the code fell
// back to the raw string and opened the job anyway — after which the rest was
// fixed: `messagePeer` threw, the job closed `failed`, and `deliverWake` filed
// the failure notice back into the thread AS BRIDGET, because a wake-up is an
// a2a in reverse and writes `from: job.to`.
//
// What the owner was left with is the thing these assertions are about: an
// inbox row for an agent that never existed, wearing a letter for a face,
// holding one message that reads exactly as if she had written it. "no sé si
// falló o qué."
test("a peer nobody can place is refused before anything durable exists", async () => {
  fresh();
  const peer = recorder();
  const out = sendInBackground({
    project, from: "ansel", to: "Bridget", body: "deploy globex", wake: true,
    messagePeerFn: peer.fn,
  });

  assert.match(out.error, /no peer named "Bridget"/);
  assert.match(out.error, /list_agents/, "the refusal has to say where the real names are");
  assert.equal(out.job_id, undefined, "a doomed job must not get an id");
  assert.equal(listJobs().length, 0, "nothing durable may survive a refused send");

  // The whole point: no job means no close, which means no wake-up, which means
  // no message filed under a name that belongs to nobody.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(peer.calls.length, 0, "a peer that does not exist was written to anyway");
});

test("the refusal reaches the model through the tool, not as an exception", async () => {
  fresh();
  const out = await handlerFor({ agentSlug: "ansel" })({
    to: "Bridget", message: "deploy globex", background: true,
  });
  // Returned, not thrown: the model reads this and picks somebody real. The
  // blocking half of the same tool has always refused an unknown peer — the two
  // halves disagreeing is what let the background one through.
  assert.match(out.error, /no peer named "Bridget"/);
  assert.equal(listJobs().length, 0);
});

// ── Recovery ────────────────────────────────────────────────────────────────
test("a job whose daemon died is closed as lost and its waiter woken once", async () => {
  fresh();
  const job = openJob({ project_id: 7, from: "ansel", to: "roby", body: "orbit status", wake: true });
  // Re-home it on a process that is not running: this is exactly the state a
  // job from a previous daemon is in at the next boot.
  fs.writeFileSync(
    path.join(BACKGROUND_JOBS_DIR, `${job.id}.json`),
    JSON.stringify({ ...job, daemon_pid: 2147483646 }),
  );

  const woke = [];
  const deliverWakeFn = async (settled) => { woke.push(settled); return { delivered: true }; };
  const projects = { get: () => project };

  const out = await reconcileBackgroundJobs({ projects, config: {}, log: () => {}, deliverWakeFn });
  assert.equal(out.closed, 1);
  assert.equal(out.woken, 1);
  assert.equal(readJob(job.id).status, "lost");
  assert.equal(woke.length, 1);
  assert.equal(woke[0].status, "lost");
  assert.match(woke[0].result, /daemon holding it exited/);

  // A second boot must not wake anybody again: the job is terminal now.
  const again = await reconcileBackgroundJobs({ projects, config: {}, log: () => {}, deliverWakeFn });
  assert.equal(again.closed, 0);
  assert.equal(woke.length, 1, "a recovered job is recovered exactly once");
});

test("the reconciler leaves live work alone", async () => {
  fresh();
  const mine = openJob({ project_id: 7, from: "ansel", to: "roby", timeout_s: 3600 });
  const out = await reconcileBackgroundJobs({ projects: { get: () => project }, log: () => {} });
  assert.equal(out.closed, 0);
  assert.equal(readJob(mine.id).status, "running", "a job this process still owns is not harvested");
});

test("a job past its deadline is cut off even though its owner is alive", async () => {
  fresh();
  const job = openJob({ project_id: 7, from: "ansel", to: "roby", wake: false, timeout_s: 1 });
  fs.writeFileSync(
    path.join(BACKGROUND_JOBS_DIR, `${job.id}.json`),
    JSON.stringify({ ...job, deadline_at: new Date(Date.now() - 1000).toISOString() }),
  );

  const out = await reconcileBackgroundJobs({ projects: { get: () => project }, log: () => {} });
  assert.equal(out.closed, 1);
  assert.equal(readJob(job.id).status, "timed_out");
  assert.match(readJob(job.id).result, /past its 1s budget/);
});

test("a job whose project is gone is still closed, so nothing waits on it forever", async () => {
  fresh();
  const job = openJob({ project_id: 999, from: "ansel", to: "roby", wake: true });
  fs.writeFileSync(
    path.join(BACKGROUND_JOBS_DIR, `${job.id}.json`),
    JSON.stringify({ ...job, daemon_pid: 2147483646 }),
  );

  const out = await reconcileBackgroundJobs({ projects: { get: () => null }, log: () => {} });
  assert.equal(out.closed, 1);
  assert.equal(out.woken, 0);
  assert.equal(readJob(job.id).status, "lost");
});

// ── The words the waiter reads ──────────────────────────────────────────────
test("a lost job says the work is unrecoverable, not that it is still coming", () => {
  const job = { id: "bgjob_x", to: "roby", body: "orbit status", status: "lost", timeout_s: 3600 };
  const text = wakeText(job);
  assert.match(text, /daemon restarted/);
  assert.match(text, /cannot be recovered/);
  assert.match(text, /Do NOT report this as done/);
});

test("a timed-out job names the budget it blew", () => {
  const text = wakeText({ id: "bgjob_x", to: "roby", body: "b", status: "timed_out", timeout_s: 300 });
  assert.match(text, /past its 300s budget/);
});

// ── The tool surface ────────────────────────────────────────────────────────
// `send_to_agent` is where an agent actually reaches this. The parameters are
// the whole interface a model sees, so they are asserted as an interface.
const { default: sendToAgent } = await import("#core/agent/tools/handlers/send-to-agent.js");

function handlerFor(channelMeta = {}) {
  return sendToAgent.makeHandler({
    projects: { get: () => project, resolve: () => project, list: () => [project] },
    globalConfig: {},
    channelMeta,
  });
}

test("background is opt-in, and waking is the default once you opt in", () => {
  const props = sendToAgent.schema.function.parameters.properties;
  assert.ok(props.background, "there must be a way to not wait");
  assert.ok(props.wake_me);
  // Still optional: the blocking call every existing caller makes keeps working.
  assert.deepEqual(sendToAgent.schema.function.parameters.required.sort(), ["message", "to"]);
  assert.match(props.wake_me.description, /Default TRUE/);
  // The description is the only thing that makes a model choose this, so it has
  // to say when — not merely that the option exists.
  assert.match(props.background.description, /do not need their answer/i);
  assert.match(props.wake_me.description, /context is NOT kept/i);
});

test("a background call hands the turn straight back instead of an answer", async () => {
  fresh();
  const out = await handlerFor({ agentSlug: "ansel" })({
    to: "roby", message: "orbit status", background: true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, "running");
  assert.equal(out.wake, true);
  assert.match(out.note, /do NOT wait/i);
  assert.equal(listJobs({ from: "ansel", open_only: true }).length, 1);
});

test("wake_me: false files the message and promises nothing", async () => {
  fresh();
  const out = await handlerFor({ agentSlug: "ansel" })({
    to: "roby", message: "fyi", background: true, wake_me: false,
  });
  assert.equal(out.wake, false);
  assert.match(out.note, /will NOT be woken/);
});

test("the chain is counted across turns, not restarted on every hop", async () => {
  fresh();
  // An agent already at the maximum active depth may not open another child.
  const deep = await handlerFor({ agentSlug: "ansel", a2aDepth: MAX_BACKGROUND_DEPTH })({
    to: "roby", message: "and you do it", background: true,
  });
  assert.match(deep.error, /depth limit/);

  // …and the blocking path is walled too. It had no limit at all before: a
  // synchronous chain is no less a chain for being synchronous.
  const deepSync = await handlerFor({ agentSlug: "ansel", a2aDepth: MAX_BACKGROUND_DEPTH })({
    to: "roby", message: "and you do it",
  });
  assert.match(deepSync.error, /depth limit/);
  assert.equal(listJobs().length, 0);
});

test("an agent still cannot send to itself, background or not", async () => {
  fresh();
  await assert.rejects(
    handlerFor({ agentSlug: "ansel" })({ to: "ansel", message: "hi", background: true }),
    /that is you/,
  );
  assert.equal(listJobs().length, 0);
});

test("the peer's own turn knows how deep the chain is, not just the job record", async () => {
  fresh();
  const peer = recorder();
  sendInBackground({
    project, from: "ansel", to: "roby", body: "x", wake: true, depth: 2,
    messagePeerFn: peer.fn,
  });

  const sent = await until(() => peer.calls[0], "the outbound send");
  // Without this the peer ran at depth 0 and could hand the work straight on
  // again — the job record knew the depth and the turn doing the work did not.
  assert.equal(sent.depth, 2);

  const wake = await until(() => peer.calls[1], "the wake-up");
  assert.equal(wake.depth, 1, "the completed child returns to its parent depth");
});

// ── The acknowledgement ping-pong (2026-09-23) ──────────────────────────────
// A status report woke the super-agent; it answered "Recibido…", which was
// filed as a reply INTO the peer's inbox; the peer's next turn answered
// "Confirmado…"; and one report became four full tool loops. ~230 a2a messages
// in fifty minutes, most of them acknowledgements, until the ChatGPT account
// ran out. The answer still wakes the waiter — what it says back does not.
test("a wake-up is delivered as a wake, and says the waiter's words go nowhere", async () => {
  fresh();
  const peer = recorder();
  sendInBackground({ project, from: "ansel", to: "roby", body: "estado?", wake: true, messagePeerFn: peer.fn });
  const wake = await until(() => peer.calls[1], "the wake-up");
  assert.ok(wake.wakeFor, "messagePeer is told this is a wake-up, not a new message");
  assert.match(wake.body, /NOT sent to roby/);
  assert.match(wake.body, /Do not acknowledge/);
});

test("the woken turn's answer is its own note, never put in the peer's inbox", async () => {
  const { messagePeer } = await import("#core/agent/a2a/delegate.js");
  const { appendMessageToFs, readProjectMessages } = await import("#core/stores/messages.js");
  const storagePath = fs.mkdtempSync(path.join(TMP_HOME, "wake-store-"));
  const p = { ...project, storagePath, logMessage: (m) => appendMessageToFs({ projectRoot: storagePath, ...m }) };
  let seen = null;
  await messagePeer({
    project: p, from: "roby", to: "ansel", body: "[background job bg_x] …", config: {},
    wakeFor: "bg_x",
    replyFn: async (args) => { seen = args; return { text: "Recibido, gracias.", model: "test:model" }; },
  });
  const rows = readProjectMessages(storagePath, { channel: "a2a", limit: 50 });
  const intoRoby = rows.filter((r) => r.agent_slug === "roby" && r.direction === "in");
  assert.equal(intoRoby.length, 0, "roby's inbox gets nothing — roby is waiting on nothing");
  const note = rows.find((r) => r.agent_slug === "ansel" && r.direction === "out");
  assert.equal(note.body, "Recibido, gracias.");
  assert.equal(note.meta.not_sent, true);
  assert.equal(note.meta.wake_for, "bg_x");
  // And the woken turn is told the same thing its prompt used to contradict.
  assert.equal(seen.wake, true);
});

test("the a2a etiquette of a woken turn does not claim its output goes back", async () => {
  const { buildA2AReplySystem } = await import("#core/agent/a2a/reply.js");
  const base = { toAgent: { slug: "ansel", fields: {} }, fromAgent: { slug: "roby" }, config: {} };
  assert.match(buildA2AReplySystem(base), /Your output IS the reply/);
  const woken = buildA2AReplySystem({ ...base, wake: true });
  assert.doesNotMatch(woken, /Your output IS the reply/);
  assert.match(woken, /NOT sent to roby/);
});

test("a blocking send hits the same depth wall as a background one", async () => {
  fresh();
  // A turn already at the maximum active depth may not create child depth 13.
  // Blocking and managed-background paths must enforce the same wall.
  const out = await handlerFor({ agentSlug: "ansel", a2aDepth: MAX_BACKGROUND_DEPTH })({ to: "roby", message: "¿confirmás?" });
  assert.match(out.error, new RegExp(`depth limit \\(${MAX_BACKGROUND_DEPTH}\\) reached`));
  const bg = await handlerFor({ agentSlug: "ansel", a2aDepth: MAX_BACKGROUND_DEPTH })({ to: "roby", message: "x", background: true });
  assert.match(bg.error, new RegExp(`depth limit \\(${MAX_BACKGROUND_DEPTH}\\) reached`));
});


test("nested managed background keeps the outer job open until the manager's resumed turn is terminal", async () => {
  fresh();

  const chainRoot = makeTempProject({
    name: "nested-managed-wake",
    agents: [
      { slug: "charly", role: "Super Agent" },
      { slug: "napoleon", role: "Manager" },
      { slug: "devincci", role: "Implementer" },
    ],
  });

  const chainProject = {
    id: 77,
    path: chainRoot,
    storagePath: "/tmp/nested-managed-wake-store",
    name: "nested-managed-wake",
    config: {},
  };

  const calls = [];

  let childJobId = null;
  let releaseChild;

  const childGate = new Promise((resolve) => {
    releaseChild = resolve;
  });

  const messagePeerFn = async (args) => {
    calls.push(args);

    // Charly starts the outer background job against Napoleon.
    // Napoleon delegates once, then deliberately ends its turn waiting for
    // Devincci's managed wake.
    if (
      args.from === "charly" &&
      args.to === "napoleon" &&
      !args.wakeFor
    ) {
      const child = sendInBackground({
        project: chainProject,
        from: "napoleon",
        to: "devincci",
        body: "implement the fix",
        wake: true,
        depth: 1,
        messagePeerFn,
      });

      assert.equal(child.ok, true);
      childJobId = child.job_id;

      return {
        text: "Delegated to Devincci; waiting for managed wake.",
        thread: "charly~napoleon",
        trace: [
          {
            tool: "send_to_agent",
            result: {
              ok: true,
              job_id: child.job_id,
              status: "running",
              wake: true,
            },
          },
        ],
      };
    }

    // Devincci is still working.
    if (
      args.from === "napoleon" &&
      args.to === "devincci" &&
      !args.wakeFor
    ) {
      return childGate;
    }

    // Devincci finished: this managed wake resumes Napoleon.
    // Napoleon now returns a genuinely terminal orchestration result.
    if (
      args.from === "devincci" &&
      args.to === "napoleon" &&
      args.wakeFor === childJobId
    ) {
      return {
        text: "DONE: implementation verified",
        thread: "napoleon~devincci",
        trace: [],
      };
    }

    // Only after Napoleon's resumed turn is terminal may the OUTER job wake
    // Charly.
    if (
      args.from === "napoleon" &&
      args.to === "charly" &&
      args.wakeFor
    ) {
      return {
        text: "ack",
        thread: "charly~napoleon",
        trace: [],
      };
    }

    return {
      text: "ack",
      thread: "t",
      trace: [],
    };
  };

  const parent = sendInBackground({
    project: chainProject,
    from: "charly",
    to: "napoleon",
    body: "own this task through implementation and verification",
    wake: true,
    depth: 0,
    messagePeerFn,
  });

  assert.equal(parent.ok, true);

  await until(
    () => childJobId && readJob(childJobId),
    "Napoleon to create the managed child job",
  );

  await until(
    () => calls.some(
      (c) =>
        c.from === "napoleon" &&
        c.to === "devincci" &&
        !c.wakeFor
    ),
    "Devincci to start working",
  );

  // THIS is the regression:
  // Napoleon's first A2A turn returned, but the orchestration is not terminal.
  // The Charly -> Napoleon job must remain open.
  const suspendedParent = readJob(parent.job_id);

  assert.equal(
    suspendedParent.status,
    "running",
    "outer job must stay running while Napoleon waits on a managed child wake",
  );

  assert.equal(
    suspendedParent.waiting_on_job_id,
    childJobId,
    "outer job must durably record which managed child currently owns progress",
  );

  assert.equal(
    calls.filter(
      (c) =>
        c.from === "napoleon" &&
        c.to === "charly" &&
        c.wakeFor === parent.job_id
    ).length,
    0,
    "Charly must not be woken by Napoleon's intermediate waiting turn",
  );

  // Devincci finishes.
  releaseChild({
    text: "IMPLEMENTED",
    thread: "napoleon~devincci",
    trace: [],
  });

  await until(
    () => readJob(childJobId)?.status === "done",
    "the Devincci child job to finish",
  );

  // Its managed wake resumes Napoleon. Napoleon returns terminal DONE, so only
  // NOW may the outer job settle.
  await until(
    () => readJob(parent.job_id)?.status === "done",
    "the outer Charly to Napoleon job to finish after Napoleon resumes",
  );

  const finalParent = readJob(parent.job_id);

  assert.match(
    finalParent.result,
    /DONE: implementation verified/,
    "the outer job result must be Napoleon's resumed terminal result",
  );

  const parentWakes = calls.filter(
    (c) =>
      c.from === "napoleon" &&
      c.to === "charly" &&
      c.wakeFor === parent.job_id
  );

  assert.equal(
    parentWakes.length,
    1,
    "Charly must receive exactly one final managed wake",
  );
});


test("nested managed background can hand off implementer to auditor before waking the outer caller", async () => {
  fresh();

  const chainRoot = makeTempProject({
    name: "nested-managed-two-stage",
    agents: [
      { slug: "charly", role: "Super Agent" },
      { slug: "napoleon", role: "Manager" },
      { slug: "devincci", role: "Implementer" },
      { slug: "claupernico", role: "Auditor" },
    ],
  });

  const chainProject = {
    id: 78,
    path: chainRoot,
    storagePath: "/tmp/nested-managed-two-stage-store",
    name: "nested-managed-two-stage",
    config: {},
  };

  const calls = [];

  let implementerJobId = null;
  let auditorJobId = null;

  let releaseImplementer;
  let releaseAuditor;

  const implementerGate = new Promise((resolve) => {
    releaseImplementer = resolve;
  });

  const auditorGate = new Promise((resolve) => {
    releaseAuditor = resolve;
  });

  const messagePeerFn = async (args) => {
    calls.push(args);

    // Charly gives Napoleon ownership of the whole orchestration.
    if (
      args.from === "charly" &&
      args.to === "napoleon" &&
      !args.wakeFor
    ) {
      const child = sendInBackground({
        project: chainProject,
        from: "napoleon",
        to: "devincci",
        body: "implement the requested change",
        wake: true,
        depth: 1,
        messagePeerFn,
      });

      assert.equal(child.ok, true);
      implementerJobId = child.job_id;

      return {
        text: "Implementation delegated; waiting for managed wake.",
        thread: "charly~napoleon",
        trace: [],
      };
    }

    // Devincci remains working until the test releases it.
    if (
      args.from === "napoleon" &&
      args.to === "devincci" &&
      !args.wakeFor
    ) {
      return implementerGate;
    }

    // First wake: implementation completed. Napoleon now delegates audit.
    if (
      args.from === "devincci" &&
      args.to === "napoleon" &&
      args.wakeFor === implementerJobId
    ) {
      const audit = sendInBackground({
        project: chainProject,
        from: "napoleon",
        to: "claupernico",
        body: "audit the implementation independently",
        wake: true,
        depth: 1,
        messagePeerFn,
      });

      assert.equal(audit.ok, true);
      auditorJobId = audit.job_id;

      return {
        text: "Implementation received; audit delegated.",
        thread: "napoleon~devincci",
        trace: [],
      };
    }

    // Claupernico remains working until released.
    if (
      args.from === "napoleon" &&
      args.to === "claupernico" &&
      !args.wakeFor
    ) {
      return auditorGate;
    }

    // Second wake: audit completed. Napoleon is now genuinely terminal.
    if (
      args.from === "claupernico" &&
      args.to === "napoleon" &&
      args.wakeFor === auditorJobId
    ) {
      return {
        text: "DONE: implementation verified independently",
        thread: "napoleon~claupernico",
        trace: [],
      };
    }

    // Only this final outer wake may reach Charly.
    if (
      args.from === "napoleon" &&
      args.to === "charly" &&
      args.wakeFor
    ) {
      return {
        text: "ack",
        thread: "charly~napoleon",
        trace: [],
      };
    }

    return {
      text: "ack",
      thread: "t",
      trace: [],
    };
  };

  const parent = sendInBackground({
    project: chainProject,
    from: "charly",
    to: "napoleon",
    body: "implement, audit, and return only the final result",
    wake: true,
    depth: 0,
    messagePeerFn,
  });

  assert.equal(parent.ok, true);

  await until(
    () => implementerJobId && readJob(implementerJobId),
    "Napoleon to create the implementer job",
  );

  let parentState = readJob(parent.job_id);

  assert.equal(parentState.status, "running");
  assert.equal(parentState.waiting_on_job_id, implementerJobId);

  assert.equal(
    calls.filter(
      (c) =>
        c.from === "napoleon" &&
        c.to === "charly" &&
        c.wakeFor === parent.job_id
    ).length,
    0,
    "Charly must not wake while implementation is pending",
  );

  // Stage 1 completes.
  releaseImplementer({
    text: "IMPLEMENTED",
    thread: "napoleon~devincci",
    trace: [],
  });

  await until(
    () => auditorJobId && readJob(auditorJobId),
    "Napoleon to create the auditor job after implementer wake",
  );

  await until(
    () => readJob(implementerJobId)?.status === "done",
    "implementer job to finish",
  );

  parentState = readJob(parent.job_id);

  assert.equal(
    parentState.status,
    "running",
    "outer job must remain running while audit is pending",
  );

  assert.equal(
    parentState.waiting_on_job_id,
    auditorJobId,
    "outer ownership must move from implementer job to auditor job",
  );

  assert.notEqual(
    parentState.waiting_on_job_id,
    implementerJobId,
    "the completed implementer must no longer own progress",
  );

  assert.equal(
    calls.filter(
      (c) =>
        c.from === "napoleon" &&
        c.to === "charly" &&
        c.wakeFor === parent.job_id
    ).length,
    0,
    "Charly must still not wake between implementation and audit",
  );

  // Stage 2 completes.
  releaseAuditor({
    text: "PASS",
    thread: "napoleon~claupernico",
    trace: [],
  });

  await until(
    () => readJob(auditorJobId)?.status === "done",
    "auditor job to finish",
  );

  await until(
    () => readJob(parent.job_id)?.status === "done",
    "outer orchestration to finish after audit wake",
  );

  const finalParent = readJob(parent.job_id);

  assert.match(
    finalParent.result,
    /DONE: implementation verified independently/,
  );

  const parentWakes = calls.filter(
    (c) =>
      c.from === "napoleon" &&
      c.to === "charly" &&
      c.wakeFor === parent.job_id
  );

  assert.equal(
    parentWakes.length,
    1,
    "Charly must receive exactly one wake after the whole orchestration",
  );
});
