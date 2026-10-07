// Shared ownership for work launched during a managed background turn.
// The async context identifies the owning A2A job; the job record is the
// durable source of truth for every child that still keeps it open.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  closeJob, readJob, updateJob, TERMINAL_STATUSES,
} from "#core/stores/background-jobs.js";

const managedBackgroundContext = new AsyncLocalStorage();

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

/**
 * Release one child after its resumed turn ends. The parent settles only when
 * no dependency remains; a failed wake is retained and makes that settlement
 * failed instead of manufacturing DONE.
 */
export function settleManagedDependency({
  parentJobId,
  childJobId,
  result = "",
  failure = null,
} = {}) {
  if (!parentJobId || !childJobId) return { parent: null, settled: null };
  const parent = readJob(parentJobId);
  if (!parent || TERMINAL_STATUSES.includes(parent.status)) {
    return { parent, settled: null };
  }

  const childId = String(childJobId);
  const remaining = managedDependencyIds(parent).filter((id) => id !== childId);
  const failures = Array.isArray(parent.managed_dependency_failures)
    ? [...parent.managed_dependency_failures]
    : [];
  if (failure && !failures.some((entry) => entry?.job_id === childId)) {
    failures.push({ job_id: childId, reason: String(failure).slice(0, 2000) });
  }

  const updated = updateJob(parent.id, {
    managed_dependency_ids: remaining,
    managed_dependency_failures: failures,
    waiting_on_job_id: remaining.at(-1) || null,
  });
  if (!updated || remaining.length > 0) return { parent: updated, settled: null };

  const failed = failures.length > 0;
  const failureText = failures
    .map((entry) => `${entry.job_id}: ${entry.reason}`)
    .join("; ");
  const settled = closeJob(parent.id, {
    status: failed ? "failed" : "done",
    result: failed ? `Managed wake failed: ${failureText}` : result,
  });
  return { parent: settled, settled };
}
