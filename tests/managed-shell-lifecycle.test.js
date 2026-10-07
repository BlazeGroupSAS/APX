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
const { sendInBackground } = await import("#core/agent/a2a/background.js");
const { runShellInBackground } = await import("#core/agent/shell/background.js");
const {
  BACKGROUND_JOBS_DIR, closeJob, readJob, wakeClaimed,
} = await import("#core/stores/background-jobs.js");
const { wakeShellJob } = await import("#host/daemon/shell-job-wake.js");

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

function launchShell({ from, command = "echo managed", wake = true }) {
  const child = fakeChild();
  const launched = runShellInBackground({
    project: PROJECT,
    from,
    command,
    cwd: ROOT,
    wake,
    origin: { channel: "web", conversation_id: `${from}-chat` },
    spawnFn: () => child,
    shellCommandFn: (text) => ({ file: "test-shell", args: [text], options: {} }),
  });
  return { child, launched };
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
