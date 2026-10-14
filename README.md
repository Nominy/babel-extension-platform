# Babel Extension Platform

## Install

Requires Node.js 22.14+. From this directory:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run publish:dry-run
```

Packages are ESM source; there is no separate compile step. Consumers install the local `file:` dependencies from their own directories after this workspace is installed.

## Selected native audio contract

`@nominy/babel-babel-runtime` exports native audio state/capture protocol **v2**. State is published through `data-babel-audio-enhancement` and `babel-audio-enhancement-state`, scoped by review action. `strength` is the committed integer Enhanced percentage0..100; `desiredStrength` is the requested commit, not a held UI preview. Strength0 retains exact Original bytes and an empty `variantKey`; strength100 retains full Enhanced bytes and its model/source hash; intermediate strengths use SHA256 of `['zip-linear-pcm16-v1', fullPairVariantKey, strength]`. Nonzero recognition/draft identities remain separate; Original identity is unchanged. Obsolete mode/desiredMode/selectMode APIs are removed.

Helper's MAIN-world `page.audio-enhancement` service exposes `selectStrength`, owns both native players and retained endpoint bytes, and commits linear PCM blends after sequential paired loads. Active capture is unavailable during mix preparation, pending desired selection, paired switching, or native-buffer mismatch; settled rollback errors expose only the previous committed pair. `selection: 'original'` always returns retained Originals, even during a pending mix. Gold owns the packaged model and caches only the full enhanced pair; no mixed-history cache or inference rerun is added.

Optional `pairedVariantKey` binds the full Enhanced model/source identity to a bridge-verified same-clock pair at every strength. Both source hashes, sample rates, frame counts, WAV headers and byte digests must validate before it is published; reset removes it. Playback timing may use pins from another strength of that exact pair, but strict ASR/timing lookup and active capture remain committed-strength-specific. Playback projection does not publish fake recognition results.

Optional `AudioEnhancementState.progress` carries validated queue/cache-lookup/cache-hit/model/inference/encoding/transfer stages, a nonempty track identity, and exact completed/total window counts. Cache stages require zero inference counts. Progress is not a source revision: timing and waveform caches remain keyed by the selected audio variant. Completion counts certify inference work, not native-player commit. Optional result `cacheStatus`/`cacheMessage` distinguish a validated hit, stored pair, or readable storage warning without changing source identity.

Enhancement no longer depends on Review Grader or its version/identity; the obsolete access protocol and provider are removed. New native pairs start at 90% Enhanced / 10% Original. Helper confirms each user transition to 100% before publishing a selection, preserving the current audio until approval. Shared `confirmDialog` accepts an optional abort signal so navigation, superseding choices and teardown remove stale dialogs; modal keyboard events are isolated from page hotkeys.


## Native playback and session reads

`readBabelSessionState` reads the committed workbench, panel and transcript
permissions without serializing pending Slate text or native undo state.
Native binding readers retain only component locations: each call follows the
current root's child/sibling links and reads current props, including same-task
readonly changes and remounts. Missing components fail closed. Playback retains
unchanged WaveSurfer membership, not clock samples; in-place source replacement
and track removal are observed on the next read. Native seek/play/speed callbacks
remain responsible for synchronized transport.
`readBabelTurnIdentity` likewise reads only current row metadata and permissions.
Its per-array ID index validates the requested ID at its current array position;
replacement rows are read directly and moved/deleted/renamed IDs trigger index
rediscovery. Timing, selection, track labels and readonly state are never cached.
Missing IDs are not cached, so later in-place insertion is immediately visible.

The native-only `shared session and playback hot-path measurement` browser test
attaches per-read full-transcript/session/turn-identity/playback timings and live two-track
clock samples; it checks filter identity and avoids enumerating annotation DOM
nodes during polling. Run it without paid providers or extra models:

```sh
npm run e2e -- native.spec.mjs --project=chromium-native --grep="shared session and playback hot-path measurement"
```

## Browser checks

Install dependencies in Helper, Gold Drafting, and Review Helper before running:

```sh
npm --prefix ../../babel-helper-extension-repo ci --ignore-scripts
npm --prefix ../../drafting/gold-drafting-extension ci --ignore-scripts
npm --prefix ../../reviewer/review-interceptor-extension ci --ignore-scripts
npm run e2e:install:browser
npm run e2e:install:recreation
npm run e2e -- --list
npm run e2e
# Focused/headed run:
npm run e2e -- appearance.spec.mjs --headed
```

For Review Grader, also run `npm --prefix ../../reviewer/babel-review-grader-extension ci --ignore-scripts`, then `npm run e2e -- --grader`.

`npm run e2e -- --help` lists options without builds, services, or a browser. Runs use temporary builds/profiles and muted Chromium, never a user Chrome profile. Native extension permission-dialog checks are headless-only. Failure screenshots, scenario state and browser/network diagnostics are retained under `packages/babel-extension-e2e/node_modules/.cache/babel-e2e`; the output prints the directory.

Detailed tracing is off by default to avoid recording full DOM/network snapshots
for every passing test. Opt in with standard Playwright `--trace=on` to retain
traces for passing and failing tests, or `--trace=retain-on-failure` to record
every test but keep traces only on failure. Playwright owns trace startup,
shutdown and attachments for the isolated persistent contexts; no second
fixture recorder runs. Explicitly retained passing artifacts are kept in the
same cache. Functional assertions, uncaught-error checks and independent
5000ms teardown diagnostic deadlines apply in either mode.

Parallelize with separate runner invocations, each selecting disjoint projects or
test files, rather than increasing `--workers` inside one runner. Each invocation
gets its own scenario backend, frontend, temporary builds and browser profiles;
tests within an invocation share mutable scenario state. Start with two concurrent
invocations, for example `--project=chromium-gold` alongside
`--grader --project=chromium-native --project=chromium-review`. Keep real GPU
inference runs separate from this concurrency to avoid resource contention.
Each browser context also owns its proxy's upstream connection pool: canceled
responses and context teardown release only that context's traffic. External
origins, TLS tunnels and browser access to scenario control/reset endpoints
remain denied; allowed backend error statuses pass through unchanged.

Normal runs use pinned recreation data, not a local capture checkout. After intentionally updating the recovered source, run `npm run snapshot:refresh --workspace @nominy/babel-extension-e2e`, then `npm run e2e:install:recreation`.

The active fixture is the 2026-10-13 captured editor, module `36978`, with
annotation sections and Slate text editing. All four browser projects use it;
`--grader` adds the Review Grader cases. Submission checks use genuine local
audio playback to satisfy the new listening gate. No old-editor fallback exists.
The previous rebuild and pre-migration tests are privately archived at
`tools/babel-editor-rebuild/exports/2026-09-05-rebuild-archive.tar.gz` in the
development checkout. Production adapters use current native turn/Slate bindings;
the suites retain persistence, undo, readonly and stale-task assertions.
The native-only draft-first hydration regression remains visible; Helper and
Review independently acquire the shared hydration gate to protect their users.

## Real inference checks

Defaults use placeholder inference and require no paid provider. Real modes require explicit flags and provisioned models; unavailable prerequisites fail rather than falling back.

```sh
# Requires OPENROUTER_API_KEY; may incur charges.
npm run e2e -- --ai=openrouter --openrouter-model=PROVIDER/MODEL --speech-fixtures=/path/to/speech

# Start and provision a real /v1 ASR engine first; selects ASR-compatible tests.
npm run e2e -- --ai=local --local-engine-url=http://127.0.0.1:8767 --speech-fixtures=/path/to/speech

# Set BABEL_E2E_BROWSER_MODEL_DIR to the real model bundle directory.
npm run e2e -- --browser-models=real --speech-fixtures=/path/to/speech

# Requires the production audio/text LanguageModel capability in a fresh profile.
npm run e2e -- --nano=real --browser-executable=/path/to/chromium --speech-fixtures=/path/to/speech
```

The browser model directory needs the current released `babel-browser-model-bundle-v3` `manifest.json`, matching graph hashes/provenance/numeric validation, all eleven declared files, and `sample-russian-15s.wav` (mono PCM16, at most 15 seconds). Requests use the versioned model path from Gold's `model-release.json`. Nano requires explicitly supplied speech and an already available audio/text model; it does not download a model or reuse a user profile.

For speech-dependent checks, `--speech-fixtures` points to a directory with two authorized mono PCM16 WAVs of matching rate/duration and this `manifest.json` structure (annotation bounds must fit the audio):

```json
{
  "schema": "babel-e2e-speech-v1",
  "tracks": [
    { "speaker": 1, "path": "speaker-1.wav" },
    { "speaker": 2, "path": "speaker-2.wav" }
  ],
  "annotations": [
    {
      "id": "speech-row-1",
      "processedRecordingId": "speaker-1",
      "startTimeInSeconds": 0.5,
      "endTimeInSeconds": 2.5,
      "content": "Явно предоставленная тестовая речь."
    }
  ]
}
```

Default media is tones/silence, not speech. Credentials alone never enable paid calls. The runner does not capture live audio or read user Chrome data.

Placeholder browser builds bind synthetic, explicitly marked model bytes only
inside disposable artifacts; production release hashes and model verification
are untouched. Automatic enhancement remains enabled, using the deterministic
authenticated HTTP fixture by default rather than silently running a real GPU
model. Its same-clock half-amplitude PCM exercises transport, cache, native
switching, mixing and consent, not denoising quality.

`native-audio-enhancement.spec.mjs` selects real Auto/WebGPU with
`--browser-models=real --speech-fixtures=...`, requires actual GPU progress and
rejects remote fixture fallback. Both modes compare native decoded PCM mixtures
and Original restoration. When explicitly enabled, real-model tracing retains
actions/screenshots/sources but omits snapshot/network-body recording to avoid
copying the model bundle into traces. The real C-denoise lane verifies hardware execution and application of
returned annotations; seeded integration annotations are not accuracy labels.
