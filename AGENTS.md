This repository has a zero tolerance policy for flaky tests.

## Branch & release policy

- **`artifylab-v2` is the only maintained branch.** All work lands there; do not maintain `main`.
- **CI release pipeline is intentionally unmaintained.** `build-release.yml` fails at the secrets precheck (`TODESKTOP_EMAIL` / `TODESKTOP_ACCESS_TOKEN` are not configured in repo secrets). Tag-push release failures are expected noise — do not investigate or report them as problems. Local verification is `pnpm run typecheck:node` + `pnpm run typecheck:web` (note: `ci.yml` only triggers on PR / main push, so direct pushes to `artifylab-v2` run no CI).
- **Upstream Sync routine**: `git fetch upstream` → merge `upstream/main` into `artifylab-v2` → on conflict, keep fork branding in `package.json` (`name: artify-desktop`, version, description) and keep `scripts/dev.mjs` as the `dev` entry; release-config files (`todesktop.json`, starter-template scripts) take the upstream side → push to origin.

## Runtime logs

- **Desktop app + ComfyUI server runtime log** (includes Python tracebacks from nodes): `C:\Users\Administrator\AppData\Roaming\artify-desktop\logs\app.log` (current run), rotated backups as `app.log_<timestamp>.log` in the same dir.
- **Dev run output** (vite/electron stdout when run via `pnpm dev`): `D:\artifyfun\comfy-desktop-dev.log`.
- When debugging a runtime error, read the tail of `app.log` first; per-install ComfyUI logs also land in `<installPath>/logs/comfyui.log` (see `src/main/lib/logRotation.ts`).

## Pull request descriptions

Every PR description must include a change breakdown that separates product code from test code. For each category, report its file count and paths, added lines, deleted lines, and share of total changed lines. Calculate total changed lines as added lines plus deleted lines. List documentation, configuration, generated files, lockfiles, and vendored code separately when present; do not count merge-only changes.

Use this breakdown to make the implementation size clear when tests account for most of the diff. Summarize the feature behavior separately from the test coverage.

## ComfyUI-Manager is v4 (not the legacy v3 layout)

Installs launched by this app run **Manager v4**: the `comfyui_manager` Python package inside the standalone env, enabled through ComfyUI's `--enable-manager` flag. Do not reason about Manager from the v3 codebase.

- **Source of truth: the `manager-v4` branch** of Comfy-Org/ComfyUI-Manager. The `main` branch (legacy `glob/manager_server.py` layout) does NOT describe what desktop ships - reading it gives wrong answers about security gates, endpoints, and config. A workspace checkout of ComfyUI-Manager is typically on `main`; use `git show origin/manager-v4:<path>` or check out the branch.
- **Per-install config** lives at `<install>/ComfyUI/user/__manager/config.ini`, `[default]` section. The launcher reconciles per-install settings into it on launch (see `src/main/lib/managerConfig.ts`).
- **v4 security model** (differs from v3):
  - Risk levels are subdivided: `block` / `high+` / `high` / `middle+` / `middle`.
  - `network_mode` accepts `public | private | offline | personal_cloud`.
  - With a non-loopback `--listen`, `middle+` actions (e.g. installing node packs) are denied at EVERY `security_level` unless `network_mode = personal_cloud`; `high+` additionally requires `security_level = weak`.
  - `allow_git_url_install` / `allow_pip_install` are independent config flags, gated by the same network-position rule.
- **API is v2**: endpoints live under `/api/v2/...` (e.g. the lifecycle test probes `POST /api/v2/snapshot/remove`).

## Dependency upgrades (learned 2026-09, two upgrade rounds)

- **Audit command**: `pnpm audit --prod --registry=https://registry.npmjs.org` — the default registry (npmmirror) has no audit endpoint and errors out.
- **`pnpm.overrides` in `package.json` is silently ignored by pnpm 10.** Transitive-dependency overrides live in `pnpm-workspace.yaml` under a top-level `overrides:` key. This is where the security pinning (fast-uri/js-yaml/postcss/qs/ws/lodash/…) actually takes effect.
- **Do NOT globally override `brace-expansion`.** Advisory ranges only cover the 2.x line; `minimatch@10` requires the 5.x line and force-downgrading breaks ESLint at startup (`expand is not a function`, caught by the pre-commit hook). The 2.x chain auto-resolves to the patched 2.1.7 on its own.
- **`vue` ≥3.5.42 + `@vue/test-utils` 2.4.6 breaks**: test-utils' optional `require('@vue/server-renderer')` fails to resolve under pnpm isolation (3 component test files fail to load). Fix: upgrade test-utils to ^2.5.0 AND add `@vue/server-renderer` as an explicit devDependency in both root and `packages/frontend`.
- **`xlsx` new versions are npm-absent**: SheetJS publishes ≥0.20.x only via its CDN (`pnpm add xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`); npm stays at 0.18.5 with known advisories.
- **Upstream test noise, not regressions**: `src/main/lib/updater.test.ts` (66) and `paths.test.ts` (5) fail on macOS both before and after any dependency change (Windows-path semantics / built-in module resolution in vitest env). Baseline-verify with `git stash` before attributing failures to an upgrade; CI never runs them (`ci.yml` = PR/main only).
- **Major versions are intentionally NOT upgraded** (electron 40→44, vite 7→8, vitest 4→5, express 4→5, pinia 3→4, vue-router 4→5, electron-store 8→11): cost far exceeds benefit under the unmaintained-CI policy; do them as dedicated projects if ever needed.
- **Verification recipe per upgrade batch**: `pnpm run typecheck` (all 4) → `npx eslint .` (expect 0 errors / ~42 pre-existing `no-explicit-any` warnings) → `pnpm audit --prod --registry=https://registry.npmjs.org` → `npx vitest run src/main/artifylab --root .` (805+) → `cd packages/frontend && npx vitest run . --root .` (382+) → for runtime deps, an in-browser smoke via vite dev server on canvas + workbench pages (`embed=1` query bypasses the `/about` redirect when no Electron bridge is present).
