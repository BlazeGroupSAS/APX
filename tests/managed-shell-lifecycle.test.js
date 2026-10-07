// Managed background work may alternate between agents and commands without
// waking the original caller until the whole orchestration is terminal.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "apx-managed-shell-"));
process.env.HOME = TMP_HOME;
process.env.APX_HOME = path.join(TMP_HOME, ".apx");

const { test } = await import("node:test");
const { default: assert } = await import("node:assert/strict");
const { makeTempProject } = await import("./_helpers.js");
const {
  cancelJob, MAX_BACKGROUND_DEPTH, sendInBackground,
} = await import("#core/agent/a2a/background.js");
const sendToAgent = (await import("#core/agent/tools/handlers/send-to-agent.js")).default;
const { runShellInBackground } = await import("#core/agent/shell/background.js");
const {
  BACKGROUND_JOBS_DIR, closeJob, readJob, wakeClaimed,
} = await import("#core/stores/background-jobs.js");
const { settleManagedDependency } = await import("#core/agent/managed-background.js");
const { startShellJobWake, wakeShellJob } = await import("#host/daemon/shell-job-wake.js");

const ROOT = makeTempProject({
  name: "acme-managed",
  agents: [
    { slug: "charly", role: "Coordinator", model: "openai:test-model" },
    { slug: "napoleon", role: "Manager", model: "openai:test-model" },
    { slug: "devincci", role: "Implementer", model: "openai:test-model" },
    { slug: "claupernico", role: "Auditor", model: "openai:test-model" },
  ],
});
const PROJECT = {
  id: 91,
  name: "acme-managed",
  path: ROOT,
  storagePath: path.join(TMP_HOME, "store"),
  config: {},
};
fs.mkdirSync(PROJECT.storagePath, { recursive: true });
const PROJECTS = { get: () => PROJECT, list: () => [PROJECT], rebuild: () => {} };

let nextPid = 8100;

function fresh() {
  try { fs.rmSync(BACKGROUND_JOBS_DIR, { recursive: true, force: true }); } catch { /* absent */ }
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = nextPid++;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  return child;
}

function launchShell({
  from,
  command = "echo managed",
  wake = true,
  depth = 0,
  origin = { channel: "web", conversation_id: `${from}-chat` },
}) {
  const child = fakeChild();
  const launched = runShellInBackground({
    project: PROJECT,
    from,
    command,
    cwd: ROOT,
    wake,
    depth,
    origin,
    spawnFn: () => child,
    shellCommandFn: (text) => ({ file: "test-shell", args: [text], options: {} }),
  });
  return { child, launched };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function until(check, what, tries = 300) {
  for (let i = 0; i < tries; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function parentWakeCalls(calls, parentId) {
  return calls.filter((call) =>
    call.from === "napoleon" &&
    call.to === "charly" &&
    call.wakeFor === parentId);
}

test("managed A2A waits for a fast shell, resumes its manager, then wakes its caller once", async () => {
  fresh();
  const calls = [];
  let shell = null;
  const messagePeerFn = async (args) => {
    calls.push(args);
    if (args.from === "charly" && args.to === "napoleon" && !args.wakeFor) {
      shell = launchShell({ from: "napoleon", command: "echo fast" });
      shell.child.emit("close", 0, null);
      return { text: "Shell launched; waiting for its managed wake.", thread: "charly~napoleon" };
    }
    return { text: "DONE: shell result verified", thread: "charly~napoleon" };
  };

  const parent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "finish the task",
    wake: true, messagePeerFn,
  });
  await until(() => shell && readJob(shell.launched.job_id)?.status === "done", "fast shell to finish");

  const suspended = readJob(parent.job_id);
  assert.equal(suspended.status, "running", "the initiating turn cannot close over a finished-but-unwoken shell");
  assert.deepEqual(suspended.managed_dependency_ids, [shell.launched.job_id]);
  assert.equal(readJob(shell.launched.job_id).parent_job_id, parent.job_id);
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 0);

  const wake = await wakeShellJob(readJob(shell.launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async () => ({ conversation_id: "napoleon-chat", text: "DONE: shell result verified" }),
    messagePeerFn,
  });
  assert.equal(wake.woken, true);
  assert.equal(readJob(parent.job_id).status, "done");
  assert.match(readJob(parent.job_id).result, /shell result verified/);
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 1);
});

test("a shell wake can delegate A2A and keep the original parent open", async () => {
  fresh();
  const calls = [];
  let shell = null;
  let auditId = null;
  let releaseAudit;
  const auditGate = new Promise((resolve) => { releaseAudit = resolve; });
  const messagePeerFn = async (args) => {
    calls.push(args);
    if (args.from === "charly" && args.to === "napoleon" && !args.wakeFor) {
      shell = launchShell({ from: "napoleon" });
      return { text: "Waiting for shell.", thread: "charly~napoleon" };
    }
    if (args.from === "napoleon" && args.to === "claupernico" && !args.wakeFor) return auditGate;
    if (args.from === "claupernico" && args.to === "napoleon" && args.wakeFor === auditId) {
      return { text: "DONE: audited", thread: "napoleon~claupernico" };
    }
    return { text: "ack", thread: "t" };
  };

  const parent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "manage and audit",
    wake: true, messagePeerFn,
  });
  await until(() => shell, "managed shell to launch");
  shell.child.emit("close", 0, null);
  await until(() => readJob(shell.launched.job_id)?.status === "done", "shell to finish");

  await wakeShellJob(readJob(shell.launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async () => {
      const audit = sendInBackground({
        project: PROJECT, from: "napoleon", to: "claupernico", body: "audit it",
        wake: true, depth: 1, messagePeerFn,
      });
      auditId = audit.job_id;
      return { conversation_id: "napoleon-chat", text: "Audit delegated." };
    },
    messagePeerFn,
  });

  assert.equal(readJob(parent.job_id).status, "running");
  assert.deepEqual(readJob(parent.job_id).managed_dependency_ids, [auditId]);
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 0);

  releaseAudit({ text: "AUDIT OK", thread: "napoleon~claupernico" });
  await until(() => readJob(parent.job_id)?.status === "done", "auditor wake to close original parent");
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 1);
});

test("a nested A2A child may wait on shell before the whole chain closes", async () => {
  fresh();
  const calls = [];
  let shell = null;
  let childId = null;
  const messagePeerFn = async (args) => {
    calls.push(args);
    if (args.from === "charly" && args.to === "napoleon" && !args.wakeFor) {
      const child = sendInBackground({
        project: PROJECT, from: "napoleon", to: "devincci", body: "implement",
        wake: true, depth: 1, messagePeerFn,
      });
      childId = child.job_id;
      return { text: "Implementation delegated.", thread: "charly~napoleon" };
    }
    if (args.from === "napoleon" && args.to === "devincci" && !args.wakeFor) {
      shell = launchShell({ from: "devincci", command: "echo build" });
      return { text: "Build running.", thread: "napoleon~devincci" };
    }
    if (args.from === "devincci" && args.to === "napoleon" && args.wakeFor === childId) {
      return { text: "DONE: implementation complete", thread: "napoleon~devincci" };
    }
    return { text: "ack", thread: "t" };
  };

  const parent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "own the chain",
    wake: true, messagePeerFn,
  });
  await until(() => shell, "nested shell to launch");
  assert.equal(readJob(shell.launched.job_id).parent_job_id, childId);
  assert.equal(readJob(childId).status, "running");
  assert.equal(readJob(parent.job_id).status, "running");

  shell.child.emit("close", 0, null);
  await until(() => readJob(shell.launched.job_id)?.status === "done", "nested shell to finish");
  await wakeShellJob(readJob(shell.launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async () => ({ conversation_id: "devincci-chat", text: "DONE: build verified" }),
    messagePeerFn,
  });

  await until(() => readJob(parent.job_id)?.status === "done", "the complete chain to close");
  assert.equal(readJob(childId).status, "done");
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 1);
});

test("multiple managed shells keep the parent open until the final dependency completes", async () => {
  fresh();
  const calls = [];
  const shells = [];
  const messagePeerFn = async (args) => {
    calls.push(args);
    if (args.from === "charly" && args.to === "napoleon" && !args.wakeFor) {
      shells.push(launchShell({ from: "napoleon", command: "echo one" }));
      shells.push(launchShell({ from: "napoleon", command: "echo two" }));
      return { text: "Two commands running.", thread: "charly~napoleon" };
    }
    return { text: "DONE: all commands verified", thread: "charly~napoleon" };
  };

  const parent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "run both",
    wake: true, messagePeerFn,
  });
  await until(() => shells.length === 2, "both shells to launch");
  assert.equal(readJob(parent.job_id).managed_dependency_ids.length, 2);

  shells[0].child.emit("close", 0, null);
  await until(() => readJob(shells[0].launched.job_id)?.status === "done", "first shell to finish");
  await wakeShellJob(readJob(shells[0].launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async () => ({ conversation_id: "napoleon-chat", text: "First result received." }),
    messagePeerFn,
  });
  assert.equal(readJob(parent.job_id).status, "running");
  assert.deepEqual(readJob(parent.job_id).managed_dependency_ids, [shells[1].launched.job_id]);
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 0);

  shells[1].child.emit("close", 0, null);
  await until(() => readJob(shells[1].launched.job_id)?.status === "done", "second shell to finish");
  await wakeShellJob(readJob(shells[1].launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async () => ({ conversation_id: "napoleon-chat", text: "DONE: all commands verified" }),
    messagePeerFn,
  });
  assert.equal(readJob(parent.job_id).status, "done");
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 1);
});

test("simultaneous managed shell wakes take parent ownership one at a time", async () => {
  fresh();
  const calls = [];
  const shells = [];
  const gates = [deferred(), deferred()];
  const started = [deferred(), deferred()];
  let activeTurns = 0;
  let maxActiveTurns = 0;
  const messagePeerFn = async (args) => {
    calls.push(args);
    if (!args.wakeFor) {
      shells.push(launchShell({ from: "napoleon", command: "echo first" }));
      shells.push(launchShell({ from: "napoleon", command: "echo second" }));
      return { text: "Two commands running.", thread: "t" };
    }
    return { text: "caller received final result", thread: "t" };
  };
  const parent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "run concurrently",
    wake: true, messagePeerFn,
  });
  await until(() => shells.length === 2, "both shells to launch");
  await until(() => readJob(parent.job_id)?.managed_turn_active === false, "owner turn to end");
  for (const shell of shells) shell.child.emit("close", 0, null);
  await until(() => shells.every((shell) => readJob(shell.launched.job_id)?.status === "done"), "both shells to finish");

  let wakeIndex = 0;
  const runChatTurnFn = async () => {
    const index = wakeIndex++;
    activeTurns++;
    maxActiveTurns = Math.max(maxActiveTurns, activeTurns);
    started[index].resolve();
    await gates[index].promise;
    activeTurns--;
    return { text: index === 0 ? "First handled." : "DONE: both handled" };
  };
  const wakes = shells.map((shell) => wakeShellJob(readJob(shell.launched.job_id), {
    projects: PROJECTS, runChatTurnFn, messagePeerFn,
  }));
  await started[0].promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wakeIndex, 1, "the second wake waits for ownership");
  gates[0].resolve();
  await started[1].promise;
  assert.equal(readJob(parent.job_id).status, "running");
  gates[1].resolve();
  await Promise.all(wakes);

  assert.equal(maxActiveTurns, 1);
  assert.equal(readJob(parent.job_id).status, "done");
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 1);
});

test("independent and wake-false shell jobs never become managed dependencies", async () => {
  fresh();
  const independent = launchShell({ from: "napoleon" });
  assert.equal(readJob(independent.launched.job_id).parent_job_id, null);
  independent.child.emit("close", 0, null);

  let quiet = null;
  const parent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "launch telemetry",
    wake: true,
    messagePeerFn: async (args) => {
      if (!args.wakeFor) quiet = launchShell({ from: "napoleon", command: "echo telemetry", wake: false });
      return { text: "DONE: fire and forget", thread: "charly~napoleon" };
    },
  });
  await until(() => quiet, "wake-false shell to launch");
  await until(() => readJob(parent.job_id)?.status === "done", "parent to close without quiet shell");
  assert.equal(readJob(quiet.launched.job_id).parent_job_id, null);
  quiet.child.emit("close", 0, null);
});

test("failed, timed-out and cancelled managed shells resume their manager", async () => {
  for (const status of ["failed", "timed_out", "cancelled"]) {
    fresh();
    let shell = null;
    const calls = [];
    const messagePeerFn = async (args) => { calls.push(args); return { text: "DONE: failure handled", thread: "t" }; };
    const parent = sendInBackground({
      project: PROJECT, from: "charly", to: "napoleon", body: `handle ${status}`,
      wake: true,
      messagePeerFn: async (args) => {
        calls.push(args);
        if (!args.wakeFor) shell = launchShell({ from: "napoleon", command: `echo ${status}` });
        return { text: args.wakeFor ? "DONE: failure handled" : "Waiting.", thread: "t" };
      },
    });
    await until(() => shell, `${status} shell to launch`);
    const settled = closeJob(shell.launched.job_id, { status, result: status });
    const out = await wakeShellJob(settled, {
      projects: PROJECTS,
      runChatTurnFn: async () => ({ conversation_id: "napoleon-chat", text: "DONE: failure handled" }),
      messagePeerFn,
    });
    assert.equal(out.woken, true, status);
    assert.equal(readJob(parent.job_id).status, "done", status);
    shell.child.emit("close", 1, null);
  }
});

test("a definitive managed shell wake failure fails and releases the parent once", async () => {
  fresh();
  const calls = [];
  let shell = null;
  const messagePeerFn = async (args) => { calls.push(args); return { text: "ack", thread: "t" }; };
  const parent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "manage command",
    wake: true,
    messagePeerFn: async (args) => {
      calls.push(args);
      if (!args.wakeFor) shell = launchShell({ from: "napoleon" });
      return { text: "Waiting.", thread: "t" };
    },
  });
  await until(() => shell, "managed shell to launch");
  shell.child.emit("close", 0, null);
  await until(() => readJob(shell.launched.job_id)?.status === "done", "shell to finish");

  const out = await wakeShellJob(readJob(shell.launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async () => { throw new Error("engine unavailable"); },
    retryDelayMs: 0,
    messagePeerFn,
  });
  assert.equal(out.woken, false);
  assert.equal(readJob(parent.job_id).status, "failed");
  assert.match(readJob(parent.job_id).result, /engine unavailable/);
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 1);
  assert.equal(wakeClaimed(parent.job_id), true);

  const duplicate = await wakeShellJob(readJob(shell.launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async () => ({ conversation_id: "napoleon-chat", text: "late" }),
    messagePeerFn,
  });
  assert.equal(duplicate.woken, false);
  assert.match(duplicate.reason, /already delivered/);
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 1);
});

test("H1: a null-conversation shell wake cannot overtake its active A2A owner turn", async () => {
  fresh();
  const owner = deferred();
  const ownerStarted = deferred();
  const calls = [];
  let shell = null;
  let wakeTurns = 0;
  const messagePeerFn = async (args) => {
    calls.push(args);
    if (!args.wakeFor) {
      shell = launchShell({
        from: "napoleon",
        command: "echo immediate",
        depth: 1,
        origin: { channel: "a2a", conversation_id: null },
      });
      shell.child.emit("close", 0, null);
      ownerStarted.resolve();
      return owner.promise;
    }
    return { text: "caller acknowledged terminal result", thread: "charly~napoleon" };
  };

  const parent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "own the task",
    wake: true, depth: 1, messagePeerFn,
  });
  await ownerStarted.promise;
  await until(() => readJob(shell.launched.job_id)?.status === "done", "fast shell to finish");

  const wakePromise = wakeShellJob(readJob(shell.launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async () => {
      wakeTurns++;
      return { conversation_id: null, text: "DONE: manager final result" };
    },
    messagePeerFn,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wakeTurns, 0, "the shell cannot start a concurrent manager turn");
  assert.equal(readJob(parent.job_id).status, "running");
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 0);

  owner.resolve({ text: "Owner turn completed; process the shell result.", thread: "charly~napoleon" });
  const wake = await wakePromise;
  assert.equal(wake.woken, true);
  assert.equal(wakeTurns, 1);
  assert.equal(readJob(parent.job_id).status, "done");
  assert.equal(readJob(parent.job_id).result, "DONE: manager final result");
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 1);
});

test("H2: an owner failure remains failed after its managed shell completes", async () => {
  fresh();
  const owner = deferred();
  const ownerStarted = deferred();
  const calls = [];
  let shell = null;
  let wakeTurns = 0;
  const messagePeerFn = async (args) => {
    calls.push(args);
    if (!args.wakeFor) {
      shell = launchShell({
        from: "napoleon",
        origin: { channel: "a2a", conversation_id: null },
      });
      ownerStarted.resolve();
      return owner.promise;
    }
    return { text: "caller received failure", thread: "charly~napoleon" };
  };
  const parent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "fail after launch",
    wake: true, messagePeerFn,
  });
  await ownerStarted.promise;
  shell.child.emit("close", 0, null);
  await until(() => readJob(shell.launched.job_id)?.status === "done", "shell to finish");
  const wakePromise = wakeShellJob(readJob(shell.launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async () => { wakeTurns++; return { text: "contradictory done" }; },
    messagePeerFn,
  });
  owner.reject(new Error("manager exploded after launch"));
  const wake = await wakePromise;

  assert.equal(wakeTurns, 0, "a failed owner cannot be replaced by a success continuation");
  assert.equal(wake.woken, false);
  assert.match(wake.reason, /manager exploded after launch/);
  assert.equal(readJob(parent.job_id).status, "failed");
  assert.match(readJob(parent.job_id).result, /manager exploded after launch/);
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 1);
});

test("H3: settlement persistence failure never reruns a successful wake turn", async () => {
  fresh();
  let shell = null;
  const calls = [];
  const messagePeerFn = async (args) => {
    calls.push(args);
    if (!args.wakeFor) shell = launchShell({ from: "napoleon" });
    return { text: args.wakeFor ? "caller received failure" : "Waiting.", thread: "t" };
  };
  const parent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "persist safely",
    wake: true, messagePeerFn,
  });
  await until(() => shell, "managed shell to launch");
  shell.child.emit("close", 0, null);
  await until(() => readJob(shell.launched.job_id)?.status === "done", "shell to finish");
  let wakeTurns = 0;
  let settlements = 0;
  const out = await wakeShellJob(readJob(shell.launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async () => { wakeTurns++; return { text: "model completed once" }; },
    settleManagedFn: async () => {
      settlements++;
      throw new Error("injected parent persistence failure");
    },
    retryDelayMs: 0,
    messagePeerFn,
  });

  assert.equal(wakeTurns, 1);
  assert.equal(settlements, 1);
  assert.equal(out.woken, false);
  assert.match(out.reason, /persistence failure/);
  assert.equal(readJob(parent.job_id).status, "failed");
  assert.match(readJob(parent.job_id).result, /persistence failure/);
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 1);
});

test("H4: shell wake restores managed A2A depth and rejects the next excessive handoff", async () => {
  fresh();
  let shell = null;
  const messagePeerFn = async (args) => {
    if (!args.wakeFor) {
      shell = launchShell({ from: "napoleon", depth: MAX_BACKGROUND_DEPTH });
      return { text: "Waiting.", thread: "t" };
    }
    return { text: "caller wake", thread: "t" };
  };
  const parent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "at depth limit",
    wake: true, depth: MAX_BACKGROUND_DEPTH, messagePeerFn,
  });
  await until(() => shell, "depth shell to launch");
  assert.equal(readJob(shell.launched.job_id).depth, MAX_BACKGROUND_DEPTH);
  shell.child.emit("close", 0, null);
  await until(() => readJob(shell.launched.job_id)?.status === "done", "depth shell to finish");

  let restoredDepth = null;
  let rejection = null;
  await wakeShellJob(readJob(shell.launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async (args) => {
      restoredDepth = args.channelMeta?.a2aDepth;
      const handler = sendToAgent.makeHandler({
        projects: PROJECTS,
        channel: "a2a",
        channelMeta: { ...args.channelMeta, agentSlug: "napoleon", to: "napoleon" },
      });
      rejection = await handler({ to: "claupernico", message: "one hop too far", background: true });
      return { text: "DONE: depth checked" };
    },
    messagePeerFn,
  });

  assert.equal(restoredDepth, MAX_BACKGROUND_DEPTH);
  assert.match(rejection.error, /depth limit/);
  assert.equal(readJob(parent.job_id).status, "done");
});

test("H5: cancelling a managed parent prevents a live shell from resurrecting it", async () => {
  fresh();
  const calls = [];
  let shell = null;
  let wakeTurns = 0;
  const owner = deferred();
  const messagePeerFn = async (args) => {
    calls.push(args);
    if (!args.wakeFor) {
      shell = launchShell({ from: "napoleon", origin: { channel: "a2a", conversation_id: null } });
      return owner.promise;
    }
    return { text: "caller saw cancellation", thread: "t" };
  };
  const parent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "cancel parent",
    wake: true, messagePeerFn,
  });
  await until(() => shell, "managed shell to launch");
  await cancelJob(parent.job_id, { project: PROJECT, messagePeerFn });
  assert.equal(readJob(parent.job_id).status, "cancelled");
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 1);

  shell.child.emit("close", 0, null);
  await until(() => readJob(shell.launched.job_id)?.status === "done", "live shell to finish");
  const wake = await wakeShellJob(readJob(shell.launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async () => { wakeTurns++; return { text: "must not run" }; },
    messagePeerFn,
  });
  assert.equal(wake.woken, false);
  assert.match(wake.reason, /parent already cancelled/);
  assert.equal(wakeTurns, 0);
  assert.equal(readJob(parent.job_id).status, "cancelled");
  assert.equal(parentWakeCalls(calls, parent.job_id).length, 1);
  owner.resolve({ text: "late owner result", thread: "t" });
});

test("H6: a deleted project records a recoverable parent failure without running wake", async () => {
  fresh();
  let shell = null;
  let wakeTurns = 0;
  const parent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "project may disappear",
    wake: true,
    messagePeerFn: async () => {
      shell = launchShell({ from: "napoleon" });
      return { text: "Waiting.", thread: "t" };
    },
  });
  await until(() => shell, "managed shell to launch");
  await until(() => readJob(parent.job_id)?.managed_turn_active === false, "owner turn to end");
  shell.child.emit("close", 0, null);
  await until(() => readJob(shell.launched.job_id)?.status === "done", "shell to finish");
  const out = await wakeShellJob(readJob(shell.launched.job_id), {
    projects: { get: () => null },
    runChatTurnFn: async () => { wakeTurns++; return { text: "must not run" }; },
  });
  assert.equal(out.woken, false);
  assert.equal(out.reason, "project gone");
  assert.equal(wakeTurns, 0);
  assert.equal(readJob(parent.job_id).status, "failed");
  assert.match(readJob(parent.job_id).result, /project .* is gone/);
  assert.equal(wakeClaimed(parent.job_id), false, "upper wake remains visibly recoverable");
});

test("N1: a dependency persistence failure releases ownership and does not rerun the wake turn", async () => {
  fresh();
  let firstShell = null;
  let wakeTurns = 0;
  let persistenceCalls = 0;
  const messagePeerFn = async (args) => {
    if (!args.wakeFor) firstShell = launchShell({ from: "napoleon" });
    return { text: args.wakeFor ? "caller received failure" : "Waiting.", thread: "t" };
  };
  const firstParent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "persist first lifecycle",
    wake: true, messagePeerFn,
  });
  await until(() => firstShell, "first managed shell to launch");
  firstShell.child.emit("close", 0, null);
  await until(() => readJob(firstShell.launched.job_id)?.status === "done", "first shell to finish");

  const firstWake = await wakeShellJob(readJob(firstShell.launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async () => {
      wakeTurns++;
      return { text: "model completed exactly once" };
    },
    settleManagedDependencyFn: (args) => {
      persistenceCalls++;
      if (persistenceCalls === 1) throw new Error("injected dependency write failure");
      return settleManagedDependency(args);
    },
    messagePeerFn,
  });

  assert.equal(wakeTurns, 1);
  assert.equal(persistenceCalls, 1);
  assert.equal(firstWake.woken, false);
  assert.match(firstWake.reason, /dependency write failure/);
  assert.equal(readJob(firstParent.job_id).managed_turn_active, false);
  assert.equal(readJob(firstParent.job_id).status, "failed");
  assert.match(readJob(firstParent.job_id).result, /persistence failure/);

  let secondShell = null;
  const secondParent = sendInBackground({
    project: PROJECT, from: "charly", to: "napoleon", body: "second lifecycle still advances",
    wake: true,
    messagePeerFn: async (args) => {
      if (!args.wakeFor) secondShell = launchShell({ from: "napoleon" });
      return { text: args.wakeFor ? "caller received second result" : "Waiting.", thread: "t2" };
    },
  });
  await until(() => secondShell, "second managed shell to launch");
  secondShell.child.emit("close", 0, null);
  await until(() => readJob(secondShell.launched.job_id)?.status === "done", "second shell to finish");
  const secondWake = await wakeShellJob(readJob(secondShell.launched.job_id), {
    projects: PROJECTS,
    runChatTurnFn: async () => ({ text: "DONE: second lifecycle" }),
    messagePeerFn: async () => ({ text: "caller received second result", thread: "t2" }),
  });
  assert.equal(secondWake.woken, true);
  assert.equal(readJob(secondParent.job_id).status, "done");
});

test("N2: an owner wait does not head-of-line block unrelated wakes for the same agent", async () => {
  fresh();
  const ownerA = deferred();
  const ownerAStarted = deferred();
  let shellA = null;
  let shellC = null;
  const wakeStarted = [];
  const messagePeerFn = async (args) => {
    if (args.from === "charly" && args.body === "lifecycle A") {
      shellA = launchShell({ from: "napoleon", origin: { channel: "a2a", conversation_id: null } });
      ownerAStarted.resolve();
      return ownerA.promise;
    }
    if (args.from === "charly" && args.body === "lifecycle C") {
      shellC = launchShell({ from: "napoleon", origin: { channel: "a2a", conversation_id: null } });
      return { text: "C waiting.", thread: "c" };
    }
    return { text: "caller wake", thread: "t" };
  };
  const listener = startShellJobWake({
    projects: PROJECTS,
    messagePeerFn,
    runChatTurnFn: async ({ promptMeta }) => {
      wakeStarted.push(promptMeta.job.id);
      return { text: `DONE: ${promptMeta.job.id}` };
    },
  });

  try {
    const parentA = sendInBackground({
      project: PROJECT, from: "charly", to: "napoleon", body: "lifecycle A",
      wake: true, messagePeerFn,
    });
    await ownerAStarted.promise;
    shellA.child.emit("close", 0, null);
    await until(() => readJob(shellA.launched.job_id)?.status === "done", "A shell to finish");

    const independentB = launchShell({ from: "napoleon", command: "echo independent B" });
    independentB.child.emit("close", 0, null);
    await until(() => readJob(independentB.launched.job_id)?.status === "done", "B shell to finish");
    await until(() => wakeStarted.includes(independentB.launched.job_id), "independent B wake to start");

    const parentC = sendInBackground({
      project: PROJECT, from: "charly", to: "napoleon", body: "lifecycle C",
      wake: true, messagePeerFn,
    });
    await until(() => shellC, "C shell to launch");
    shellC.child.emit("close", 0, null);
    await until(() => readJob(shellC.launched.job_id)?.status === "done", "C shell to finish");
    await until(() => wakeStarted.includes(shellC.launched.job_id), "lifecycle C wake to start");
    await until(() => readJob(parentC.job_id)?.status === "done", "lifecycle C to close");

    assert.equal(readJob(parentA.job_id).status, "running");
    assert.equal(wakeStarted.includes(shellA.launched.job_id), false, "A remains correctly owned by its live turn");
    assert.equal(wakeStarted.includes(independentB.launched.job_id), true);
    assert.equal(wakeStarted.includes(shellC.launched.job_id), true);

    ownerA.resolve({ text: "A owner finished.", thread: "a" });
    await until(() => wakeStarted.includes(shellA.launched.job_id), "A wake after owner completion");
    await until(() => readJob(parentA.job_id)?.status === "done", "lifecycle A to close");
  } finally {
    ownerA.resolve({ text: "A cleanup.", thread: "a" });
    listener.stop();
  }
});
