// Token-based local-only admission for the already installed Qwen model. No generation,
// model load, configuration writes, credentials or provider selection occurs here.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import translation from "./localBudgetTranslation.cjs";

const DIR = "/opt/homebrew/lib/node_modules/omniroute/open-sse/services";
const PYTHON = "/Users/atescivitci/.local/share/uv/tools/headroom-ai/bin/python";
const MODEL_DIGEST = "07d35212591fc27746f0a317c975a6d68754fb38e9053d82e25f06057af28522";
const GGUF =
  "/Users/atescivitci/.ollama/models/blobs/sha256-f5ee307a2982106a6eb82b62b2c00b575c9072145a759ae4660378acda8dcf2d";
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const cleanEnv = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", PYTHONDONTWRITEBYTECODE: "1" };
const RESOURCE_ADMISSION_REASONS = new Set([
  "runtime_owner_unverified",
  "resource_metadata_invalid",
  "allocation_inspection_unavailable",
  "allocation_runner_unverified",
  "allocation_slots_unverified",
  "allocation_growth_unverified",
  "resource_memory_headroom",
  "resource_rss_limit",
  "resource_memory_pressure",
]);
function unavailable(reason = "local_identity_unverified") {
  const message = RESOURCE_ADMISSION_REASONS.has(reason)
    ? `Local runtime/resource admission could not be verified (${reason}). No inference was dispatched by this admission check.`
    : "Exact local tokenizer/model/template identity could not be verified. No inference was dispatched by this admission check.";
  const e = new Error(message);
  e.code = "local_context_unavailable";
  e.status = 503;
  e.details = { reason, failure_phase: "admission", execution_outcome: "not_dispatched" };
  throw e;
}
function curl(url, body, execute) {
  const args = ["--noproxy", "*", "--silent", "--show-error", "--fail", "--max-time", "12"];
  if (body !== undefined)
    args.push("--header", "Content-Type: application/json", "--data-binary", "@-");
  args.push(url);
  return JSON.parse(
    execute("/usr/bin/curl", args, {
      encoding: "utf8",
      env: cleanEnv,
      timeout: 15000,
      maxBuffer: 64 * 1024 * 1024,
      ...(body === undefined ? {} : { input: JSON.stringify(body) }),
    })
  );
}
export function createNativeTokenCounter(
  capacity,
  { execute = execFileSync, directory = DIR } = {}
) {
  try {
    if (
      capacity.model !== "qwen3.6:35b-a3b" ||
      capacity.digest !== MODEL_DIGEST ||
      capacity.origin !== "http://127.0.0.1:11434"
    )
      unavailable();
    const resolveEndpoint = () => {
      const listener = execute("/usr/sbin/lsof", ["-nP", "-iTCP:11434", "-sTCP:LISTEN", "-t"], {
        encoding: "utf8",
        env: cleanEnv,
        timeout: 3000,
      })
        .trim()
        .split(/\s+/);
      if (listener.length !== 1 || !/^\d+$/.test(listener[0])) unavailable();
      const processes = execute("/bin/ps", ["-axo", "uid=,pid=,ppid=,command="], {
        encoding: "utf8",
        env: cleanEnv,
        timeout: 3000,
      });
      const matches = processes
        .split("\n")
        .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
        .filter(
          (m) =>
            m &&
            Number(m[1]) === process.getuid() &&
            m[3] === listener[0] &&
            m[4].includes("--model " + GGUF + " ") &&
            m[4].includes("--host 127.0.0.1")
        );
      if (matches.length !== 1) unavailable();
      const port = matches[0][4].match(/(?:^|\s)--port (\d+)(?:\s|$)/)?.[1];
      if (!port || Number(port) < 1024 || Number(port) > 65535) unavailable();
      const endpoint = "http://127.0.0.1:" + port;
      const props = curl(endpoint + "/props", undefined, execute);
      if (props.model_path !== GGUF) unavailable();
      return endpoint;
    };
    resolveEndpoint();
    const renderer = path.join(directory, "render-model-template.py"),
      template = path.join(directory, "model-chat-template.jinja");
    const identity =
      "70397429afd98f231547b28083595077931a17317ee0689d79f21d94681d9479e84f32a23fdda27689f868aa4a1a5621f41133e51a48d7f3efcbea2839574259";
    if (identity !== sha(fs.readFileSync(renderer)) + sha(fs.readFileSync(template))) unavailable();
    const cache = new Map();
    return (request) => {
      try {
        if (
          request.model !== "qwen3.6:35b-a3b" ||
          request.options?.num_ctx !== capacity.context ||
          request.think !== false ||
          request.messages.some((m) => m.images?.length)
        )
          unavailable();
        if (identity !== sha(fs.readFileSync(renderer)) + sha(fs.readFileSync(template)))
          unavailable();
        const key = sha(JSON.stringify(request));
        if (cache.has(key)) return cache.get(key);
        const messages = request.messages.map((m) => ({
          ...m,
          ...(m.thinking ? { reasoning_content: m.thinking } : {}),
        }));
        const rendered = JSON.parse(
          execute(PYTHON, [renderer], {
            input: JSON.stringify({ messages, tools: request.tools ?? [] }),
            encoding: "utf8",
            env: cleanEnv,
            timeout: 10000,
            maxBuffer: 40 * 1024 * 1024,
          })
        );
        if (typeof rendered.prompt !== "string") unavailable();
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            response = curl(
              resolveEndpoint() + "/tokenize",
              { content: rendered.prompt, add_special: false, parse_special: true },
              execute
            );
            break;
          } catch (error) {
            if (attempt) throw error;
          }
        }
        if (
          !Array.isArray(response.tokens) ||
          response.tokens.length > 2_000_000 ||
          !response.tokens.every(Number.isSafeInteger)
        )
          unavailable();
        const count = response.tokens.length;
        cache.set(key, count);
        return count;
      } catch {
        unavailable();
      }
    };
  } catch {
    unavailable();
  }
}
export function createBodyTokenCounter(capacity, buildNativeRequest, options) {
  const measure = createNativeTokenCounter(capacity, options);
  return (body) => {
    if (!Array.isArray(body.messages)) unavailable();
    const anthropic = body.system !== undefined || (body.tools ?? []).some((t) => t.input_schema);
    const translated = anthropic
      ? translation.claudeToOpenAIRequest("qwen3.6:35b-a3b", structuredClone(body), false)
      : structuredClone(body);
    const request = buildNativeRequest(
      { stream: false },
      {
        ...translated,
        max_tokens: Math.min(Number(body.max_tokens ?? 8192), 8192),
        reasoning_effort: "none",
      },
      capacity
    );
    request.think = false;
    return measure(request);
  };
}
export function assertTokenCapacity(request, capacity, counter, retrieval = 0) {
  const input = counter(request),
    output = request.options?.num_predict;
  if (
    !Number.isSafeInteger(output) ||
    output < 1 ||
    !Number.isSafeInteger(retrieval) ||
    retrieval < 0
  )
    unavailable();
  if (input + output + 8192 + retrieval > capacity.context) {
    const e = new Error(
      "The complete local prompt plus output, framing and retrieval reserves exceeds the verified model context. No required instructions or tool schemas were removed."
    );
    e.code = "local_archive_context_exceeded";
    e.status = 422;
    e.details = {
      input_tokens: input,
      context_limit: capacity.context,
      output_reserve: output,
      framing_reserve: 8192,
      retrieval_reserve: retrieval,
      measurement: "exact installed GGUF template and owned resident tokenizer",
    };
    throw e;
  }
  return input;
}

// This is request admission, not a global model/service setting. The measured
// current q4 KV cache is90MiB/16K; use twice that increment plus512MiB and retain
// 2GiB reclaimable headroom. A failed check never unloads or kills any model.
export function resourceSnapshot({ execute = execFileSync } = {}) {
  const vm = execute("/usr/bin/vm_stat", [], { encoding: "utf8", env: cleanEnv, timeout: 3000 });
  const page = Number(vm.match(/page size of (\d+) bytes/)?.[1]);
  const pages = ["Pages free", "Pages inactive", "Pages speculative"].reduce(
    (sum, key) => sum + Number(vm.match(new RegExp(key + ":\\s+(\\d+)"))?.[1] ?? NaN),
    0
  );
  const pressure = execute("/usr/bin/memory_pressure", ["-Q"], {
    encoding: "utf8",
    env: cleanEnv,
    timeout: 3000,
  });
  const freePercent = Number(pressure.match(/free percentage:\s*(\d+)%/)?.[1]);
  const swap = execute("/usr/sbin/sysctl", ["vm.swapusage"], {
    encoding: "utf8",
    env: cleanEnv,
    timeout: 3000,
  });
  const swapFree = Number(swap.match(/free = ([\d.]+)M/)?.[1]) * 1024 * 1024;
  const parent = execute("/usr/sbin/lsof", ["-nP", "-iTCP:11434", "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
    env: cleanEnv,
    timeout: 3000,
  }).trim();
  if (!/^\d+$/.test(parent)) unavailable("runtime_owner_unverified");
  const raw = execute("/bin/ps", ["-axo", "uid=,pid=,ppid=,rss=,command="], {
    encoding: "utf8",
    env: cleanEnv,
    timeout: 3000,
  });
  const rows = raw
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
    .filter(
      (m) =>
        m &&
        Number(m[1]) === process.getuid() &&
        m[3] === parent &&
        m[5].includes("--model " + GGUF + " ")
    );
  const rss = rows.reduce((n, m) => n + Number(m[4]) * 1024, 0);
  if (![page * pages, freePercent, swapFree, rss].every(Number.isFinite))
    unavailable("resource_metadata_invalid");
  return {
    available_bytes: page * pages,
    free_percent: freePercent,
    swap_free_bytes: swapFree,
    rss_bytes: rss,
    rows,
  };
}
export function inspectAllocation(capacity, target, { execute = execFileSync } = {}) {
  try {
    if (
      capacity.digest !== MODEL_DIGEST ||
      capacity.origin !== "http://127.0.0.1:11434" ||
      !Number.isSafeInteger(target) ||
      target < capacity.context ||
      target > 262144
    )
      unavailable();
    const snapshot = resourceSnapshot({ execute }),
      rows = snapshot.rows;
    if (rows.length !== 1) unavailable("allocation_runner_unverified");
    const port = rows[0][5].match(/(?:^|\s)--port (\d+)(?:\s|$)/)?.[1];
    if (!port) unavailable("allocation_runner_unverified");
    const slots = curl("http://127.0.0.1:" + port + "/slots", undefined, execute);
    if (!Array.isArray(slots) || !slots.length) unavailable("allocation_slots_unverified");
    if (
      target > capacity.context &&
      (slots.some((s) => s.is_processing !== false) ||
        !rows[0][5].includes("--cache-type-k q4_0") ||
        !rows[0][5].includes("--cache-type-v q4_0"))
    )
      unavailable("allocation_growth_unverified");
    const { available_bytes: available, rss_bytes: rss } = snapshot;
    const extra =
      ((Math.max(0, target - capacity.context) * 90 * 1024 * 1024) / 16384) * 2 + 512 * 1024 * 1024;
    if (!Number.isSafeInteger(available) || available < extra + 2 * 1024 ** 3)
      unavailable("resource_memory_headroom");
    if (rss > 30 * 1024 ** 3) unavailable("resource_rss_limit");
    if (snapshot.free_percent < 15) unavailable("resource_memory_pressure");
    return {
      available_bytes: available,
      rss_bytes: rss,
      free_percent: snapshot.free_percent,
      swap_free_bytes: snapshot.swap_free_bytes,
      increment_upper_bound_bytes: Math.ceil(extra),
      target_context: target,
      resident_context: capacity.context,
    };
  } catch (error) {
    if (
      error?.name === "AbortError" ||
      error?.name === "TimeoutError" ||
      error?.code === "local_context_unavailable"
    )
      throw error;
    unavailable("allocation_inspection_unavailable");
  }
}
export async function guardedLocalFetch(
  url,
  init,
  resident,
  planned,
  fetcher = fetch,
  {
    inspect = inspectAllocation,
    sample = resourceSnapshot,
    interval = 1000,
    schedule = setInterval,
    cancel = clearInterval,
  } = {}
) {
  init.signal?.throwIfAborted();
  const baseline = inspect(resident, Math.max(resident.context, planned.context));
  init.signal?.throwIfAborted();
  const abort = new AbortController();
  let stopReason = null,
    responseReceived = false,
    transportEntered = false;
  // Monitor only this HTTP operation. Abort never sends a kill/unload/restart.
  const timer = schedule(() => {
    if (stopReason) return;
    try {
      const state = sample();
      if (![state.available_bytes, state.free_percent, state.rss_bytes].every(Number.isFinite))
        stopReason = "runtime_resource_metadata_invalid";
      else if (state.available_bytes < 2 * 1024 ** 3) stopReason = "runtime_memory_headroom";
      else if (state.free_percent < 15) stopReason = "runtime_memory_pressure";
      else if (
        state.rss_bytes >
        Math.min(
          32 * 1024 ** 3,
          baseline.rss_bytes + baseline.increment_upper_bound_bytes + 2 * 1024 ** 3
        )
      )
        stopReason = "runtime_rss_limit";
    } catch {
      stopReason = "runtime_resource_verification_unavailable";
    }
    if (stopReason) abort.abort();
  }, interval);
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal;
    signal.throwIfAborted();
    transportEntered = true;
    const response = await fetcher(url, { ...init, signal });
    responseReceived = true;
    signal.throwIfAborted();
    if (!response.ok) return response;
    const event = await response.json();
    signal.throwIfAborted();
    return Response.json(event);
  } catch (error) {
    init.signal?.throwIfAborted();
    if (!stopReason && error?.name === "AbortError") throw error;
    const reason =
      stopReason ??
      (error?.name === "TimeoutError"
        ? "backend_timeout"
        : responseReceived
          ? "backend_response_failed"
          : "backend_connection_failed");
    const failure = new Error(
      stopReason
        ? `Local continuation was stopped by its runtime/resource monitor (${reason}). No model result was released. Upstream execution may already have occurred; cancellation does not prove the model stopped.`
        : `The local backend failed during continuation (${reason}). No model result was released. Upstream execution is uncertain; do not automatically replay this step.`
    );
    failure.code = "local_backend_unavailable";
    failure.status = 503;
    failure.cause = error;
    failure.details = {
      reason,
      failure_phase: stopReason ? "runtime_monitor" : "transport",
      execution_outcome: transportEntered ? "uncertain" : "not_dispatched",
    };
    throw failure;
  } finally {
    cancel(timer);
  }
}
