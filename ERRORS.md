# ERRORS.md - Automatic Error Tracking & Learning Log

## [2026-11-18 15:56] - Circular CommonJS Require TDZ Crash Between settingsService and logBuffer

- **Type**: Runtime
- **Severity**: Critical
- **File**: `addon/lib/settingsService.ts:4`, `addon/lib/logBuffer.ts:91`
- **Agent**: p0-2-stall
- **Root Cause**: Top-level `import { refreshSecrets } from './logBuffer'` in `settingsService.ts` compiled to an early CommonJS `require('./logBuffer')` before `let initialized = false` ran, while `logBuffer.ts` checked `Boolean(require.cache[resolvedPath])` (which is already truthy with `loaded: false` mid-require) and invoked hoisted `getSetting()` during module evaluation, triggering a V8 Temporal Dead Zone (`ReferenceError`) on `initialized`.
- **Error Message**: 
  ```
  ReferenceError: Cannot access 'initialized' before initialization
      at getSetting (dist/server/lib/settingsService.js:108:5)
      at refreshSecrets (dist/server/lib/logBuffer.js:94:32)
      at Object.<anonymous> (dist/server/lib/logBuffer.js:101:1)
  ```
- **Fix Applied**: Removed the top-level `./logBuffer` import from `addon/lib/settingsService.ts` in favor of a lazy `require('./logBuffer').refreshSecrets?.()` helper called inside `initializeSettings`, `setSetting`, and `resetSetting`; updated `refreshSecrets()` in `addon/lib/logBuffer.ts` to verify `require.cache[resolvedPath]?.loaded === true` and wrap `readSetting(k)` in `try/catch`.
- **Prevention**: Never rely on `Boolean(require.cache[id])` alone to detect whether a CommonJS module has finished evaluating (`module.loaded === true` is required), and avoid top-level bidirectional imports between core bootstrap modules (`settingsService`, `logBuffer`, `database`).
- **Status**: Fixed

---
