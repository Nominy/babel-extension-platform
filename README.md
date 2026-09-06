# Babel Extension Platform

Shared packages for the Babel extension family:

- `@nominy/babel-extension-build`
- `@nominy/babel-extension-frontend`
- `@nominy/babel-babel-runtime`
- `@nominy/babel-extension-e2e` (private browser test infrastructure)

The packages are authored as plain ESM so the extension repos can consume them
from both Node build scripts and browser bundles without an extra compile step.

Settings persistence is provided by `createSettingsStore(config)` from
`@nominy/babel-extension-frontend`. Call `loadSettings()` and `saveSettings(value)`
on the returned store; there are no standalone settings load/save exports.

## Native editor and extension browser E2E

The private E2E package runs the recovered native editor snapshot and the real
Helper, Gold and Review extensions in isolated persistent Chromium profiles.
Product compilers run from disposable source copies using their existing
configuration: no version bump, publication, shipping-manifest edit or user
Chrome profile is involved. Review dev and release builds have separate test
lanes. Only staged content-script/resource matches are narrowed to loopback; CSP,
isolated/main worlds, service workers and offscreen documents remain enabled.
The pinned recreation is built and served in production mode, matching the
captured production React runtime rather than development-only frozen props.

### Explicit prerequisites

Use Node 22.14 or newer. From this directory:

```sh
npm ci --ignore-scripts
npm run e2e:install:browser
npm run e2e:install:recreation
```

Run `npm ci --ignore-scripts` in each owning repository too:
`../../babel-helper-extension-repo`, `../../drafting/gold-drafting-extension`
and `../../reviewer/review-interceptor-extension`. The runner uses their installed
compiler dependencies but writes builds only under a temporary directory.

Playwright is pinned to `1.63.0`; its explicit browser installation selects the
matching full Chromium build. A missing browser/dependency fails with the
installation command; the runner never downloads one implicitly. The recreation
install uses the pinned snapshot's `fixtures/recreation/app/package-lock.json`,
not a dependency on the development app under `tools/`.

After deliberately updating the recovered development source, regenerate the
sanitized fixture with
`npm run snapshot:refresh --workspace @nominy/babel-extension-e2e`, then rerun
`npm run e2e:install:recreation`. Normal E2E verifies and materializes the pinned
snapshot without consulting the local capture/development tree.

### Running

```sh
npm run e2e -- --help
npm run e2e -- --list
npm run e2e
npm run e2e -- native.spec.mjs
npm run e2e -- appearance.spec.mjs --headed
```

Discovery spans native specs in the private package and
`tests/e2e/*.spec.mjs` in all three extension repositories. `--help` and `--list`
start no builds, services or browser. Execution is deterministic single-worker,
without retries. Each test receives a new temporary profile and actual staged
extension IDs. The server records real requests and persistent scenario changes;
unknown endpoints/procedures fail rather than silently succeeding.

The canonical fixture export is `@nominy/babel-extension-e2e/test`
(`{ test, expect }`). Product repositories may import the same `src/test.mjs`
relatively. Options are `scenario` (default `baseline`), `extensions` (default
Helper/Gold/Review), `reviewFlavor` (`dev` or `release`) and the opt-in,
headless-only `nativePermissionDialogs`. The `babel` fixture exposes
`baseURL`, `apiURL`, `extensionIds`, mode metadata, `state()`, `control(payload)`,
`reset(name = 'baseline', overrides = {})`, `setExtensionSettings(name, settings)`,
`options(name)`, `cancelExtensionPermission(name)` and `installUserscript()`
(which loads the actual built Helper SDK).
Reset returns server state and fully navigates to the selected native route.
Settings are merged through real extension-context `chrome.storage.local`.
`babel.control(payload)` sends scenario overrides from the Node-side fixture and
returns server state, throwing with the HTTP status/body on rejection. Do not use
`page.request` for test control endpoints: its browser-associated proxy transport
is intentionally fenced; controls do not need browser-network permission.

An HTTP proxy fence denies external browser egress, including requests escaping
page routing from workers/offscreen contexts. Known production backend URLs are
fulfilled by the loopback scenario server, preserving the actual extension
transport. The runner does not disable browser security or service workers.
Every Chromium launch passes `--mute-audio`, including headed and real-model
lanes. This mutes the output sink without disabling WebAudio decoding, playback
state or DSP; tests never intentionally emit sound through system speakers.
Before any test navigation, the runner queries its newly launched browser's
actual command line and requires both muting and the exact allocated temporary
profile. A mismatch or unavailable verification closes that owned browser and
fails startup; no user-browser attachment is used for this check.
Native extension permission tests opt into `nativePermissionDialogs` and invoke
`babel.cancelExtensionPermission(name)` after the real options-page request.
The runner reads the native UI DevTools port only from that attested temporary
profile, connects on loopback, requires a unique native extension dialog matching
the staged extension's display name, and activates its actual Cancel control.
The operation has a bounded deadline and closes its socket on exit. It does not
attach to user Chrome, dispatch OS-global input, change policy, or mock
`chrome.permissions`. This fixture is headless-only; use a focused selection such
as the appearance example above for headed runs, not the full permission matrix.
Traces, screenshots, scenario state and page/worker diagnostics are retained only
on failure under `packages/babel-extension-e2e/node_modules/.cache/babel-e2e`;
the failure output prints the exact directory. Temporary servers, staged builds
and browser profiles are removed after execution.

### Heavy inference modes

Defaults are `--ai=placeholder --browser-models=placeholder --nano=placeholder`.
Only heavyweight inference boundaries are replaced: deterministic responses are
marked `e2e-placeholder-v1` / `[E2E placeholder]`. Native editing, audio decoding,
DSP, extension messaging, HTTP, model installation/cache and offscreen lifecycle
are exercised, not replaced by successful handler mocks.
Explicit negative-artifact controls can corrupt transported model bytes or select
a labelled hash-valid but unusable model artifact to exercise rejection and
recovery. These are deliberate failure inputs, not successful inference mocks or
fallbacks from a requested real model.

Explicit real lanes:

```sh
# Requires OPENROUTER_API_KEY; a suitable audio-capable model may incur charges.
npm run e2e -- --ai=openrouter --openrouter-model=PROVIDER/MODEL --speech-fixtures=/path/to/test-speech

# Requires an already provisioned real /v1 ASR engine; selects its capability lane.
npm run e2e -- --ai=local --local-engine-url=http://127.0.0.1:8765 --speech-fixtures=/path/to/test-speech

# Requires BABEL_E2E_BROWSER_MODEL_DIR with real weights, manifest and sample WAV.
npm run e2e -- --browser-models=real --speech-fixtures=/path/to/test-speech

# Requires the actual audio/text LanguageModel capability in a fresh isolated profile.
npm run e2e -- --nano=real --browser-executable=/path/to/provisioned/chromium --speech-fixtures=/path/to/test-speech
```

The OpenRouter key is read only with the explicit OpenRouter flag and is not
forwarded to test/browser subprocesses or stored in extension settings. Server
gateway dispatch handles authorized real upstream calls; the browser remains
loopback-fenced. No paid/model path runs merely because credentials are present.
`--ai=local` is an ASR-only contract, not a replacement for an LLM provider. It
automatically selects journeys tagged `@local-engine`; when combined with
`--browser-models=real` or `--nano=real`, the selected scope is the union with
`@browser-models` or `@nano`, respectively. The runner prints that exact scope,
and user file/grep filters intersect it. Empty selections fail rather than
reporting success, and `--list` reflects the same scope without starting services
or checking real-provider prerequisites. No unsupported LLM operation silently
falls back to another provider or a placeholder.

Other modes retain the full suite by default, including standalone
`--browser-models=real` and `--nano=real`; callers may explicitly focus them with
`--grep=@browser-models` or `--grep=@nano`. The examples supply speech for the
ASR-success matrix. Text-only or explicit no-speech selections do not acquire a
global speech requirement merely from OpenRouter/local mode; individual success
journeys enforce their actual prerequisites.

Real ONNX uses `BABEL_E2E_BROWSER_MODEL_DIR/manifest.json` with the product's
`babel-browser-model-bundle-v1` schema. The runner reuses the actual Gold manifest
validator and verifies every file's declared size/SHA-256 before startup; the
server serves the verified local files for real installation/cache/inference.
ONNX and Chrome Nano are separate capabilities: neither flag implies proof of
the other, and a missing real prerequisite fails without placeholder fallback.
The model directory must also contain the real `sample-russian-15s.wav`, separate
from `--speech-fixtures`. Before launching a browser, the runner checks that this
is a contained regular RIFF WAV with mono PCM16 audio and duration at most
15 seconds. This supplied sample is used by the actual model options workflow;
tones or speech from another fixture are not silently substituted.

`--nano=real` requires explicit speech fixtures before browser startup. Its
preflight extracts the reachable Helper flow's production audio/text
transcript-review session options and checks that exact LanguageModel capability,
including its English JSON-review contract, rather than calling generic
`availability()` or testing the unused standalone transcription route. The Nano
journey then exercises actual session creation/inference and native consumption.
No model download, user-profile reuse, or placeholder fallback occurs on an
unavailable real capability.

Default WAVs contain deterministic tones/silence, not speech. Real ASR is allowed
to report no speech; successful word-timing/word-seek journeys need explicitly
supplied speech, e.g. append `--speech-fixtures=/path/to/test-speech`. This only
provisions media: a speech journey explicitly selects it with
`babel.reset(name, { audio: { fixture: 'speech' } })`. Ordinary baseline, diff,
long and timeline scenarios retain their deterministic tones even when speech
is provisioned. Selecting speech without the flag fails with HTTP 400.
The directory contains `manifest.json` with:

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

Tracks must be local mono PCM16 WAVs with matching rate/duration and valid
annotation bounds; `referenceAnnotations` is optional. Use only speech fixtures
you are authorized to test. The suite never captures live audio or reads user
Chrome data automatically.

### Known captured-native limitation

The captured native L2 feedback form has a reproducible cold-response ordering
race: when the saved draft arrives before the cold input definitions, the form
discards the restored ratings. The backend payload remains correctly persisted,
and a warm reopen restores it correctly. The captured source stays unpatched and
the recreation cache is not warmed to conceal the behavior; the suite splits the
contract into ordinary coverage, a defect characterization and a compensation:

- `packages/babel-extension-e2e/tests/e2e/native.spec.mjs` (extension-free
  profile): the warm reopen case and the cold inputs-first case are ordinary
  passing tests. The cold draft-first case, "L2 native feedback discards its
  draft on a cold reload when the draft arrives first", is an expected-failure
  characterization (`test.fail`) whose restoration assertions are unweakened:
  an unexpected pass flags a change to the captured client or the fixture.
- `babel-helper-extension-repo/tests/e2e/feedback.spec.mjs` (Helper installed):
  the Helper feature `feedbackDraftRestore` (default on) holds a resolved
  draft response until the native hook has committed the input definitions,
  then releases it untouched. With the feature enabled, the same draft-first
  cold reload restores every rating and comment and submission readiness;
  with the feature disabled through the ordinary Helper settings, the native
  loss reproduces against the unchanged persisted draft. Both response holds
  are test-controlled at the browser boundary; no payload is replaced.

The characterization establishes the behavior of the captured client under
that ordering. Its frequency on the live deployment, including any effect of
server-side rendering or preloaded queries, is unproven. The Helper feature
compensates for it; it does not remove the defect from the captured code, and
the limitation must still be reported alongside suite results.
