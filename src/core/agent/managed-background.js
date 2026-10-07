// Shared ownership for work launched during a managed background turn.
// Durable job fields decide settlement; these in-process latches only prevent
// a completed child from starting a second turn while its owner is still live.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  closeJob, readJob, updateJob, wakeClaimed, TERMINAL_STATUSES,
} from "#core/stores/background-jobs.js";

const managedBackgroundContext = new AsyncLocalStorage();
const activeTurns = new Map();
const continuationLocks = new Map();
// Child job ids whose wake was claimed and is still delivering. A dependency
// on one of those is live bookkeeping; only a claimed child with NO delivery
// in flight can be an orphan left by a failed release write.
const pendingManagedWakes = new Set();

function newLatch(jobId) {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  const latch = { promise, resolve };
  activeTurns.set(String(jobId), latch);
  return latch;
}

function releaseLatch(jobId) {
  const key = String(jobId);
  const latch = activeTurns.get(key);
  if (!latch) return;
  activeTurns.delete(key);
  latch.resolve();
}

/** Release only in-memory ownership; durable lifecycle state is persisted separately. */
export function releaseManagedTurnOwnership(jobId) {
  if (jobId) releaseLatch(jobId);
}

/** Any in-memory owner for this job — a live turn latch or a queued continuation. */
export function hasManagedOwner(jobId) {
  const key = String(jobId);
  return activeTurns.has(key) || continuationLocks.has(key);
}

/** Mark/clear the in-flight delivery of a child's claimed wake. */
export function markPendingManagedWake(childJobId) {
  if (childJobId) pendingManagedWakes.add(String(childJobId));
}

export function clearPendingManagedWake(childJobId) {
  pendingManagedWakes.delete(String(childJobId));
}

/**
 * A dependency is stale when its child can no longer release it: the record
 * is gone, or the child ended with its wake claimed and no delivery still in
 * flight. A claimed child mid-wake — queued behind the parent's latch — is
 * deliberately NOT stale: pruning it would close the parent before its result
 * is consumed.
 */
function staleDependencyId(childId, child = readJob(childId)) {
  if (!child) return true;
  if (!TERMINAL_STATUSES.includes(child.status)) return false;
  if (!wakeClaimed(childId)) return false;
  return !pendingManagedWakes.has(String(childId));
}

async function withContinuationLock(jobId, fn) {
  const key = String(jobId);
  const previous = continuationLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((done) => { release = done; });
  continuationLocks.set(key, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (continuationLocks.get(key) === current) continuationLocks.delete(key);
  }
}

/** Register the already-open initial owner turn before detached work starts. */
export function registerManagedTurn(jobId) {
  if (!jobId) return null;
  return activeTurns.get(String(jobId)) || newLatch(jobId);
}

/** Run a turn as part of one durable managed A2A job. */
export function runInManagedBackground(parentJobId, fn) {
  return managedBackgroundContext.run(parentJobId || null, fn);
}

/** The managed owner of the current turn, when this child expects a wake. */
export function managedParentJobId(wake = true) {
  return wake ? (managedBackgroundContext.getStore() || null) : null;
}

/** All pending children, including records written by the r2 singular field. */
export function managedDependencyIds(job) {
  const ids = Array.isArray(job?.managed_dependency_ids)
    ? job.managed_dependency_ids.map(String)
    : [];
  if (job?.waiting_on_job_id != null) ids.push(String(job.waiting_on_job_id));
  return [...new Set(ids)];
}

/** Attach before starting work so even an immediate completion is managed. */
export function attachManagedDependency(parentJobId, childJobId) {
  if (!parentJobId || !childJobId) return null;
  const parent = readJob(parentJobId);
  if (!parent || TERMINAL_STATUSES.includes(parent.status)) return null;
  const ids = managedDependencyIds(parent);
  if (!ids.includes(String(childJobId))) ids.push(String(childJobId));
  return updateJob(parent.id, {
    managed_dependency_ids: ids,
    // Compatibility for r2 readers only. Lifecycle decisions use the array.
    waiting_on_job_id: ids.at(-1) || null,
  });
}

/** Whether returning from this turn is allowed to settle its owning job. */
export function hasManagedDependencies(job) {
  return managedDependencyIds(job).length > 0;
}

function settleIfReady(job) {
  if (!job || TERMINAL_STATUSES.includes(job.status)) return null;
  if (job.managed_turn_active || hasManagedDependencies(job)) return null;
  const outcome = job.managed_turn_outcome;
  if (!outcome) return null;
  const failures = Array.isArray(job.managed_dependency_failures)
    ? job.managed_dependency_failures
    : [];
  const ownerFailed = outcome.status !== "done";
  const dependencyFailed = failures.length > 0;
  const failureText = failures.map((entry) => `${entry.job_id}: ${entry.reason}`).join("; ");
  return closeJob(job.id, {
    status: ownerFailed || dependencyFailed ? "failed" : "done",
    result: ownerFailed
      ? outcome.result
      : dependencyFailed
        ? `Managed wake failed: ${failureText}`
        : outcome.result,
  });
}

/** Wait for the current owner without polling. */
export async function waitForManagedTurn(parentJobId) {
  if (!parentJobId) return { parent: null, orphaned: false };
  let parent = readJob(parentJobId);
  if (!parent || TERMINAL_STATUSES.includes(parent.status) || !parent.managed_turn_active) {
    return { parent, orphaned: false };
  }
  const latch = activeTurns.get(String(parentJobId));
  if (!latch) return { parent, orphaned: true };
  await latch.promise;
  parent = readJob(parentJobId);
  return { parent, orphaned: !!parent?.managed_turn_active };
}

/** Acquire the next serialized continuation, unless the prior owner failed. */
export async function beginManagedContinuation(parentJobId) {
  if (!parentJobId) return { acquired: false, parent: null, reason: "no managed parent" };
  return withContinuationLock(parentJobId, async () => {
    const waited = await waitForManagedTurn(parentJobId);
    let parent = waited.parent;
    if (!parent || TERMINAL_STATUSES.includes(parent.status)) {
      return { acquired: false, parent, reason: parent ? `parent already ${parent.status}` : "parent missing" };
    }
    if (waited.orphaned) {
      const failed = completeManagedTurn({
        parentJobId,
        status: "failed",
        result: "managed owner turn was lost before its dependency wake could resume",
      });
      return { acquired: false, parent: failed.parent, settled: failed.settled, reason: "managed owner turn lost" };
    }
    const outcome = parent.managed_turn_outcome;
    if (outcome?.status && outcome.status !== "done") {
      return { acquired: false, parent, reason: outcome.result || `owner ended ${outcome.status}` };
    }
    parent = updateJob(parent.id, {
      managed_turn_active: true,
      managed_turn_outcome: null,
    });
    registerManagedTurn(parentJobId);
    return { acquired: true, parent };
  });
}

/** Persist an owner result, release waiters, and settle only when children are gone. */
export function completeManagedTurn({ parentJobId, status = "done", result = "" } = {}) {
  if (!parentJobId) return { parent: null, settled: null };
  const current = readJob(parentJobId);
  if (!current || TERMINAL_STATUSES.includes(current.status)) {
    releaseLatch(parentJobId);
    return { parent: current, settled: null };
  }
  let parent;
  try {
    parent = updateJob(parentJobId, {
      managed_turn_active: false,
      managed_turn_outcome: { status, result },
    });
  } finally {
    releaseLatch(parentJobId);
  }
  const settled = settleIfReady(parent);
  return { parent: settled || parent, settled };
}

/** Release one child; an empty dependency set alone never closes its parent. */
export function settleManagedDependency({
  parentJobId,
  childJobId,
  failure = null,
} = {}) {
  if (!parentJobId || !childJobId) return { parent: null, settled: null };
  const parent = readJob(parentJobId);
  if (!parent || TERMINAL_STATUSES.includes(parent.status)) {
    return { parent, settled: null };
  }

  const childId = String(childJobId);
  const failures = Array.isArray(parent.managed_dependency_failures)
    ? [...parent.managed_dependency_failures]
    : [];
  const recordFailure = (id, reason) => {
    if (!failures.some((entry) => entry?.job_id === id)) {
      failures.push({ job_id: id, reason: String(reason).slice(0, 2000) });
    }
  };
  if (failure) recordFailure(childId, failure);

  // Rewriting the list is also the first chance to drop rows a failed release
  // write left behind: children that already ended with their wake spent.
  // Keeping them would park the parent on finished work until its deadline.
  const remaining = managedDependencyIds(parent).filter((id) => {
    if (id === childId) return false;
    const child = readJob(id);
    if (!staleDependencyId(id, child)) return true;
    if (!child) recordFailure(id, "dependency record is gone");
    else if (child.status !== "done") {
      recordFailure(id, `ended ${child.status} before its dependency could be released`);
    }
    return false;
  });

  const updated = updateJob(parent.id, {
    managed_dependency_ids: remaining,
    managed_dependency_failures: failures,
    waiting_on_job_id: remaining.at(-1) || null,
  });
  const settled = settleIfReady(updated);
  return { parent: settled || updated, settled };
}

/**
 * Drop dependencies whose release write never landed — the reconcile sweep's
 * hook for a parent with no continuation left to retry the settle itself.
 */
export function reconcileManagedDependencies(parentJobId) {
  const parent = readJob(parentJobId);
  if (!parent || TERMINAL_STATUSES.includes(parent.status)) {
    return { parent, settled: null };
  }
  const stale = managedDependencyIds(parent).find((id) => staleDependencyId(id));
  if (!stale) return { parent, settled: null };
  // Any stale id settles them all: the release recomputes the whole list.
  return settleManagedDependency({ parentJobId, childJobId: stale });
}
