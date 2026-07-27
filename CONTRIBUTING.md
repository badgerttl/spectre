# Contributing to Spectre

Spectre is intended for authorised security testing. Contributions should keep
actions explicit, scoped, and observable to the operator.

## Development

1. Use Node.js 20 or later.
2. Run `npm run validate`.
3. Load the repository with **Load unpacked** at `chrome://extensions`.
4. Reload the extension after source changes and smoke-test affected workflows.

There is no build step and no runtime dependency installation.

## Pull requests

- Keep manifest permissions to the minimum required by the feature.
- Explain changes to proxy, authentication, request-header, cookie, or storage
  behaviour.
- Do not add remote code, telemetry, secrets, or production credentials.
- Add or update automated tests for behaviour that can be validated without a
  browser.
- Keep `manifest.json` and `package.json` versions aligned for releases.

Please use the pull-request checklist and include concise reproduction or
validation steps.
