// Devin Cloud runtime adapter for APX.
//
// Availability is probed through the locally installed `devin --version`,
// but actual work runs through Devin Cloud API v3.
//
// Persistent APX runtime sessions map directly to Devin Cloud session_id.
// First turn creates a resumable session; later turns send a message to the
// same session and wait for Devin's next terminal response.

import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const API_HOST = "api.devin.ai";
const POLL_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One persistent Devin conversation must process only one APX turn at a time.
// Different APX callers may address the same project agent concurrently, but
// their messages must never overlap inside the same external Devin session.
const sessionRunQueues = new Map();

async function acquireSessionLock(key) {
  const normalizedKey = String(key || "devin-cloud");

  const previous = sessionRunQueues.get(normalizedKey) || Promise.resolve();

  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  const current = previous
    .catch(() => {})
    .then(() => gate);

  sessionRunQueues.set(normalizedKey, current);

  // Wait until every earlier turn for this same agent/session has released.
  await previous.catch(() => {});

  let released = false;

  return () => {
    if (released) return;
    released = true;

    releaseGate();

    current.finally(() => {
      if (sessionRunQueues.get(normalizedKey) === current) {
        sessionRunQueues.delete(normalizedKey);
      }
    });
  };
}

async function readCredentials() {
  const script = `
$ErrorActionPreference = "Stop"

$secretFile = Join-Path $env:USERPROFILE ".apx\\secrets\\devin-api-token.dpapi"

if (-not (Test-Path -LiteralPath $secretFile)) {
    throw "Devin PAT DPAPI file not found"
}

$secure = (Get-Content -Raw -LiteralPath $secretFile).Trim() | ConvertTo-SecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)

    $org = [Environment]::GetEnvironmentVariable("DEVIN_ORG_ID", "User")
    if (-not $org) {
        $org = $env:DEVIN_ORG_ID
    }

    if (-not $org) {
        throw "DEVIN_ORG_ID is not configured"
    }

    [Console]::Out.Write(
        (@{
            token = $token
            org   = $org
        } | ConvertTo-Json -Compress)
    )
}
finally {
    if ($ptr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}
`;

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    },
  );

  const parsed = JSON.parse(String(stdout || "").trim());

  if (!parsed?.token || !parsed?.org) {
    throw new Error("Devin Cloud credentials could not be loaded");
  }

  return parsed;
}

function apiRequest({ method, path, token, body = undefined, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);

    const req = https.request(
      {
        hostname: API_HOST,
        port: 443,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");

        res.on("data", (chunk) => {
          raw += chunk;
        });

        res.on("end", () => {
          let parsed = null;

          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
          }

          const status = Number(res.statusCode || 0);

          if (status < 200 || status >= 300) {
            const detail =
              parsed?.detail ||
              parsed?.title ||
              (typeof parsed === "string" ? parsed : raw) ||
              "unknown error";

            reject(new Error(`Devin API ${status}: ${detail}`));
            return;
          }

          resolve(parsed);
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Devin API request timed out"));
    });

    req.on("error", reject);

    if (payload) req.write(payload);
    req.end();
  });
}

function sessionBase(org, sessionId) {
  return `/v3/organizations/${encodeURIComponent(org)}/sessions/${encodeURIComponent(sessionId)}`;
}

async function getSession({ token, org, sessionId }) {
  return apiRequest({
    method: "GET",
    path: sessionBase(org, sessionId),
    token,
  });
}

async function listMessages({ token, org, sessionId, after = null }) {
  let path = `${sessionBase(org, sessionId)}/messages?first=200`;

  if (after) {
    path += `&after=${encodeURIComponent(after)}`;
  }

  return apiRequest({
    method: "GET",
    path,
    token,
  });
}

async function listAllMessages({ token, org, sessionId }) {
  const items = [];
  let after = null;

  while (true) {
    const page = await listMessages({
      token,
      org,
      sessionId,
      after,
    });

    if (Array.isArray(page?.items)) {
      items.push(...page.items);
    }

    if (!page?.has_next_page || !page?.end_cursor) {
      break;
    }

    after = page.end_cursor;
  }

  return items;
}

function messageIdentity(item) {
  if (item?.event_id) {
    return `event:${item.event_id}`;
  }

  return [
    "fallback",
    item?.source || "",
    item?.created_at ?? "",
    item?.message || "",
  ].join(":");
}

function latestDevinMessage(items = []) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.source === "devin") return items[i];
  }
  return null;
}

function statusIsTerminal(state) {
  if (!state) return false;

  if (state.status === "exit" || state.status === "error") {
    return true;
  }

  if (state.status === "suspended") {
    return true;
  }

  return [
    "finished",
    "waiting_for_user",
    "waiting_for_approval",
  ].includes(state.status_detail);
}

function statusIsFailure(state) {
  if (!state) return false;

  if (state.status === "error") return true;

  if (state.status === "suspended") {
    return state.status_detail !== "inactivity";
  }

  return false;
}

function buildPrompt({ system, prompt, mode }) {
  const parts = [];

  if (system) {
    parts.push(`APX AGENT IDENTITY AND RULES:\n${system}`);
  }

  if (mode === "chat") {
    parts.push(
      "APX MODE: CHAT / READ-ONLY. " +
      "Do not modify files, do not commit, do not push, do not open pull requests, " +
      "and do not make external changes. Analyze and reply only.",
    );
  } else {
    parts.push(
      "APX MODE: CODE. This is an implementation task. " +
      "You are authorized to modify the working repository, run verification, " +
      "commit or prepare the requested implementation when the task requires it.",
    );
  }

  parts.push(prompt || "");

  return parts.filter(Boolean).join("\n\n---\n\n");
}

export default {
  id: "devin-cloud",

  // Used only by APX runtimeAvailability().
  binary: "devin",
  versionFlag: "--version",

  sessions: "capture",

  async run({
    system,
    prompt,
    timeoutMs = 5 * 60 * 1000,
    sessionKey = null,
    resumeSessionId = null,
    mode = "code",
  }) {
    // For runtime-backed project agents APX passes a stable sessionKey per
    // project + agent. That is deliberately shared across callers such as
    // Eclipse and Charly, so it is also the correct serialization key.
    const lockKey = sessionKey || resumeSessionId || "devin-cloud";
    const releaseSessionLock = await acquireSessionLock(lockKey);

    try {
      const { token, org } = await readCredentials();

    const effectiveTimeout = Math.max(
      30000,
      Number(timeoutMs) || 5 * 60 * 1000,
    );

    const deadline = Date.now() + effectiveTimeout;

    const message = buildPrompt({
      system: resumeSessionId ? null : system,
      prompt,
      mode,
    });

    let sessionId = resumeSessionId || null;
    let baselineMessageIds = new Set();
    let state = null;
    let sessionUrl = null;

    if (!sessionId) {
      const body = {
        prompt: message,
        resumable: true,
        title: `APX ${String(sessionKey || "devin-cloud")}`.slice(0, 120),
      };

      // Coding work must not stop waiting for Devin's normal approval gate.
      // Chat/read-only turns deliberately do NOT bypass it.
      if (mode === "code") {
        body.bypass_approval = true;
      }

      state = await apiRequest({
        method: "POST",
        path: `/v3/organizations/${encodeURIComponent(org)}/sessions`,
        token,
        body,
      });

      sessionId = state?.session_id || null;
      sessionUrl = state?.url || null;

      if (!sessionId) {
        throw new Error("Devin Cloud did not return a session_id");
      }
    } else {
      // Snapshot every message that existed BEFORE this APX turn.
      // Devin's end_cursor is only a pagination cursor; on the last page
      // it is null, so it cannot be used as a "messages after now" marker.
      const before = await listAllMessages({
        token,
        org,
        sessionId,
      });

      baselineMessageIds = new Set(before.map(messageIdentity));

      state = await apiRequest({
        method: "POST",
        path: `${sessionBase(org, sessionId)}/messages`,
        token,
        body: {
          message,
        },
      });
    }

    let lastDevin = null;

    while (Date.now() < deadline) {
      const [currentState, messages] = await Promise.all([
        getSession({
          token,
          org,
          sessionId,
        }),
        listAllMessages({
          token,
          org,
          sessionId,
        }),
      ]);

      state = currentState;
      sessionUrl = state?.url || sessionUrl;

      const newMessages = messages.filter(
        (item) => !baselineMessageIds.has(messageIdentity(item)),
      );

      const candidate = latestDevinMessage(newMessages);
      if (candidate) {
        lastDevin = candidate;
      }

      // A terminal status may briefly be the terminal status of the
      // PREVIOUS turn. Never return success until this APX turn has
      // produced a genuinely new Devin message.
      if (statusIsTerminal(state) && (lastDevin || statusIsFailure(state))) {
        const output =
          lastDevin?.message ||
          `Devin Cloud session ${sessionId} ended with status ` +
            `${state?.status || "unknown"}/${state?.status_detail || "unknown"}.`;

        const failed = statusIsFailure(state);

        return {
          exitCode: failed ? 1 : 0,
          output,
          stderr: failed
            ? `Devin Cloud: ${state?.status || "unknown"}/${state?.status_detail || "unknown"}`
            : "",
          killed: false,
          sessionId,
          externalSessionPath: sessionUrl,
          raw: {
            state,
            message: lastDevin,
          },
        };
      }

      await sleep(POLL_MS);
    }

    // The cloud session itself is NOT killed. Only this APX wait expired.
    // sessionId is preserved so a later turn can continue/recover it.
      return {
        exitCode: 124,
        output:
          lastDevin?.message ||
          `Devin Cloud session ${sessionId} is still running after the APX wait timeout.`,
        stderr:
          `APX stopped waiting for Devin Cloud session ${sessionId}; ` +
          "the cloud session may still be running.",
        killed: true,
        sessionId,
        externalSessionPath: sessionUrl,
        raw: {
          state,
          message: lastDevin,
          timedOut: true,
        },
      };
    } finally {
      releaseSessionLock();
    }
  },
};
