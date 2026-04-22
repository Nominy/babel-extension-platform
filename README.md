# Babel Extension Platform

Shared packages for the Babel extension family:

- `@nominy/babel-extension-build`
- `@nominy/babel-extension-frontend`
- `@nominy/babel-babel-runtime`

The packages are authored as plain ESM so the extension repos can consume them
from both Node build scripts and browser bundles without an extra compile step.
