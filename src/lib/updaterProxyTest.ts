/**
 * Updater proxy connectivity test.
 *
 * quick-260711-jpq
 *
 * Purpose: verify the auto-updater's first-party `check({ proxy, timeout })`
 * API can reach GitHub THROUGH the configured local proxy (e.g. a Clash
 * mixed-port at localhost:7897). This is a *connectivity-only* test — it
 * never installs an available update. The single most important correctness
 * constraint is that the test goes through the updater plugin's `check`,
 * NOT a JS `fetch`: the proxy is applied at the Rust reqwest layer inside
 * the updater plugin; a JS fetch would ignore the proxy and only test
 * direct connectivity (the wrong test for a GFW user).
 *
 * Two exports:
 *   - classifyProxyError(errorLike): pure error → user-facing message.
 *       Side-effect-free, deterministic. Coerces to string via
 *       String(errorLike) and matches on substrings (case-insensitive),
 *       checking the refused family before the timeout family (refused =
 *       the proxy's own port is not listening; timeout = the proxy is up
 *       but GitHub never came back).
 *   - runProxyConnectionTest({ proxyUrl, timeout }): drives a single
 *       `check({ proxy, timeout })` call and maps the outcome to a
 *       ProxyTestResult (null → ok, Update → ok+note, throw → classified).
 *
 * No React, no DOM, no network code of its own — the updater plugin owns
 * all network IO.
 */

import { check } from "@tauri-apps/plugin-updater";

export type ProxyTestResult =
  | { kind: "ok"; note?: string }
  | { kind: "refused" }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

// Refused = the proxy's own TCP port is not listening (Clash down, wrong port,
// or ECONNRESET on a localhost port). The "connect error" + "refused" +
// ECONNRESET substrings cover reqwest/hyper's surface for "the proxy itself
// refused the connection."
const REFUSED_RE = /refused|ECONNREFUSED|connection refused|connect error|ECONNRESET/i;

// Timeout = TCP connected to the proxy but the upstream GitHub request never
// came back (Clash is up but the github.com rule isn't firing / can't egress).
const TIMEOUT_RE = /timed out|timeout|deadline exceeded|ETIMEDOUT/i;

const MAX_MESSAGE_LEN = 140;

/** Coerce any thrown value to a string the way the updater plugin surfaces it. */
function coerceMessage(errorLike: unknown): string {
  if (typeof errorLike === "string") return errorLike;
  if (errorLike instanceof Error) return errorLike.message;
  return String(errorLike);
}

/** Trim, then cap at MAX_MESSAGE_LEN. Pure. */
function truncate(s: string): string {
  const trimmed = s.trim();
  return trimmed.length <= MAX_MESSAGE_LEN
    ? trimmed
    : trimmed.slice(0, MAX_MESSAGE_LEN);
}

/**
 * Classify an errorLike into a {@link ProxyTestResult}.
 *
 * Refused is checked before timeout: when both substrings appear in the same
 * message (rare), refused wins because "the proxy port refused" is the more
 * specific + actionable diagnosis for a GFW user (start Clash / check port).
 *
 * Everything else surfaces as a short error message (trimmed + truncated to
 * 140 chars) so the inline status line stays readable.
 */
export function classifyProxyError(errorLike: unknown): ProxyTestResult {
  const message = coerceMessage(errorLike);

  if (REFUSED_RE.test(message)) {
    return { kind: "refused" };
  }
  if (TIMEOUT_RE.test(message)) {
    return { kind: "timeout" };
  }
  return { kind: "error", message: truncate(message) };
}

/**
 * Run a single connectivity test through the updater's first-party check.
 *
 * Resolves to:
 *   - { kind: "ok" }                   when check() resolves null (no update —
 *                                       proxy reached GitHub, that's all we care).
 *   - { kind: "ok"; note: "有新版本" }  when check() resolves a truthy Update —
 *                                       still connectivity-only, NEVER installs.
 *   - classifyProxyError(e)            when check() rejects.
 *
 * Never throws on its own — a rejected check() is the only failure source and
 * it is captured into the returned result.
 */
export async function runProxyConnectionTest(opts: {
  proxyUrl: string;
  timeout: number;
}): Promise<ProxyTestResult> {
  try {
    const update = await check({
      proxy: opts.proxyUrl,
      timeout: opts.timeout,
    });
    if (update) {
      return { kind: "ok", note: "有新版本" };
    }
    return { kind: "ok" };
  } catch (e) {
    return classifyProxyError(e);
  }
}
