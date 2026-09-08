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

`npm run e2e -- --help` lists options without builds, services, or a browser. Runs use temporary builds/profiles and muted Chromium, never a user Chrome profile. Native extension permission-dialog checks are headless-only. Failure artifacts are retained under `packages/babel-extension-e2e/node_modules/.cache/babel-e2e`; the failure output prints the directory.

Normal runs use pinned recreation data, not a local capture checkout. After intentionally updating the recovered source, run `npm run snapshot:refresh --workspace @nominy/babel-extension-e2e`, then `npm run e2e:install:recreation`.

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

The browser model directory needs a `babel-browser-model-bundle-v1` `manifest.json`, matching weights/checksums, and `sample-russian-15s.wav` (mono PCM16, at most 15 seconds). Nano requires explicitly supplied speech; it does not download a model or reuse a user profile.

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
