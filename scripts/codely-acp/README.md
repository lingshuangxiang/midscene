# Codely ACP vision probe

[中文](./README.zh.md)

The early standalone probes check whether a locally authenticated Codely CLI
can act as a visual model transport. It does not register a Midscene provider
or execute browser/device actions. It needs Node.js and Codely on `PATH`, with
an existing Codely login; no Midscene API key or workspace dependencies are
required. Inference uses the Codely account's remote model and quota.

## Integrated provider

Core now provides the production `codely://acp` route. It does not depend on
these standalone probes. Configure:

```bash
export MIDSCENE_MODEL_BASE_URL="codely://acp"
export MIDSCENE_MODEL_NAME="codely-vl"
export MIDSCENE_MODEL_FAMILY="codely-vl"
```

`provider-smoke.mjs` exercises the built core entry points and normal environment
configuration, including streaming `callAI` and `AiLocateElement`:

```bash
pnpm exec nx build @midscene/core
pnpm exec node scripts/codely-acp/provider-smoke.mjs --image screenshot.png
```

This script never operates a device. On 2026-10-16 it passed text streaming
(1922 ms) and located TapTap in the earlier 1200×2670 Android screenshot
(13509 ms), returning center `(459, 1618)` through the real Midscene workflow.
Evidence: `midscene_run/codely-acp/provider-integration-20261016/summary.json`.
See the bilingual model configuration docs for runtime and token-usage limits.

```bash
# Protocol-only check; no inference request.
pnpm exec node scripts/codely-acp/probe.mjs --handshake-only

# Two inference requests, each in a fresh session.
pnpm exec node scripts/codely-acp/probe.mjs --model codely-vl --timeout-ms 90000

# Model-free transport/validation regression checks.
pnpm exec node --test scripts/codely-acp/probe.node-test.mjs
```

`--model` selects Codely's main model, which must accept images. The probe
requests direct vision with `CODELY_ENABLE_VLM=1`; it does not call
`analyze_multimedia`. CLI-advertised image support alone does not prove the
selected model accepts images. The CLI may still need permission to write its
normal login/session cache and access the network.

The probe creates a temporary workspace and a reproducible 800×600 PNG. A
minimal system prompt replaces Codely's coding instructions for the child
process. Built-in tools, agents, skills, UPM, hooks, telemetry, and automatic
continuation are disabled. Server requests are denied, and an observed tool
call fails the probe. Existing user settings and credentials are not edited by
the probe; Codely manages its own normal login/session state.

Checks:

1. ACP v1 handshake advertises image input.
2. The model locates a red rectangle and returns strict JSON in original image
   pixels. Ground truth is not included in the prompt. Each bbox edge must be
   within 20 pixels of `[500, 360, 700, 480]`; the center must be within 15
   pixels of `[600, 420]` and inside the returned bbox.
3. The model reports an absent purple triangle as `found: false`, with null
   bbox and center. A new session avoids inheriting the first answer.

Both inference checks require `stopReason: end_turn`. Invalid JSON, Markdown
fences, incorrect coordinate scales, timeouts, and failed checks exit nonzero.
`--timeout-ms` applies separately to session creation and inference; handshake
is capped at 15 seconds. The first failure stops the run without auto-retries.

Evidence is saved under ignored `midscene_run/codely-acp/<timestamp>-<pid>/`:

- `fixture.png`: exact image sent to both sessions.
- `*-request.json`: prompt and image hash, without base64 image content.
- `*-response.txt`: model text, including partial output on failure.
- `protocol.jsonl`: methods, text chunks, and update types; no credentials,
  raw stderr, or reasoning text.
- `summary.json`: capabilities, checks, durations, and failure status. CLI
  stderr is classified without saving its raw contents.

Use `--output DIR` to select an evidence directory. A successful run establishes
this synthetic-image contract only. It does not establish realistic UI
grounding quality, repeated-run reliability, Midscene model-family coordinate
compatibility, token cost, or a completed provider integration.

## Recorded first run

On 2026-10-16, Codely `1.0.0-rc.60` with `--model codely-vl` passed all
three checks: handshake 407 ms, red-rectangle inference 2299 ms, absent-target
inference 3739 ms. The returned bbox and center matched the fixture exactly;
the absent target returned null coordinates. Both turns ended with `end_turn`,
and no tool calls were observed. Total process time was 6616 ms.

Local evidence: `midscene_run/codely-acp/2026-10-16T06-59-52-947Z-13525/`.
An earlier sandboxed attempt failed during session creation with a filesystem
permission diagnostic; it did not reach inference. The successful run had
normal access to Codely's session cache and network. These timings describe
this single run only.

## Real screenshots with Midscene's original locate prompt

Requires Node.js 22.13+ for `stripTypeScriptTypes`. This command locates only;
it never clicks or controls a device:

```bash
pnpm exec node scripts/codely-acp/locate.mjs --image screenshot.png \
  --target 'TapTap app icon' --output midscene_run/codely-acp/real-screen

pnpm exec node --test scripts/codely-acp/midscene-locate.node-test.mjs
```

`midscene-locate.mjs` executes the current repository's TypeScript prompt
builders, JSON parser, and coordinate codec after stripping types and module
syntax. This is a bounded experimental loader, not the built Agent runtime.
Preferred language is explicitly supplied as Chinese; external JSON repair
is disabled, so malformed JSON fails. Prompt text and coordinate algorithms
are not copied. PNG bytes are sent unchanged, image first. The selected
contract is Midscene's default bbox normalized to 0–1000; it does not identify
the model family behind `codely-vl`.

The output records the original system/user prompts, source-file hashes,
input PNG, model response, normalized bbox, and the original Midscene codec's
pixel center and rectangle. Invalid or not-found results fail without action.

On 2026-10-16 a connected Android launcher's 1200×2670 screenshot returned
`bbox: [308, 572, 458, 644]` for the TapTap icon. The Midscene codec mapped its
center to `(460, 1623)`. Inference took 7023 ms. After checking the launcher
and screen dimensions, the operator executed one ADB tap at that point;
`com.taptap` became foreground and the after screenshot showed its home page.
This action was explicitly requested by the user, not performed by `locate.mjs`.
Evidence: `midscene_run/codely-acp/android-taptap-20261016/`.
