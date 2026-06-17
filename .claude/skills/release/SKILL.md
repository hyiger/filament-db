---
name: release
description: Cut a versioned release of Filament DB — bump the version via the release-bump workflow, tag and push, watch the build matrix, apply release notes, and verify the macOS auto-update metadata carries both arches. Use when asked to "cut a release", "ship vX.Y.Z", or "do a release". Optionally runs a docs-drift check first.
disable-model-invocation: true
---

> Manual-invoke only (`/release`). This skill tags and PUBLISHES a release —
> side effects that must never auto-fire from release-related conversation,
> especially in auto/bypass-permission sessions.

# Cut a release

End-to-end release for this repo. The version lives in **three** files but the bump workflow handles all of them, so never hand-edit unless the workflow is unavailable.

## Pre-flight
1. Be on a clean `main` that's up to date (`git checkout main && git pull --ff-only`).
2. Confirm `main` CI is green (`gh run list --branch main --workflow=test.yml --limit 1`).
3. **Optional drift check:** run the `docs-audit` skill (or at least skim CLAUDE.md's last version section vs. what shipped) so the release doesn't go out with stale docs. Land any doc fixes via a normal PR — taken through Codex review (push → `@codex review` → iterate until the review of HEAD is clean) — BEFORE tagging.
4. Decide the semver `X.Y.Z`.

## Bump → merge
5. Dispatch the bump workflow (bumps `package.json`, `package-lock.json` ×2, and `public/openapi.json`, opens an auto-merging bump PR — keeps the version commit behind the same PR+CI gate):
   ```
   gh workflow run release-bump.yml -f version=X.Y.Z
   ```
6. Wait for the bump PR to merge — poll until `main`'s version flips:
   ```
   gh api /repos/<owner/repo>/contents/package.json --jq '.content' | base64 -d \
     | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])"
   ```
   (Requires the `RELEASE_BUMP_TOKEN` secret; the workflow fails fast if it's missing.)

## Tag → build
7. Pull main, tag, push the tag (this triggers `release.yml`):
   ```
   git checkout main && git pull --ff-only
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
8. Draft the user-facing notes to `.release-notes-X.Y.Z.md` (What's new / Notes; end with the Claude Code attribution line). These can be applied any time after the draft release is created — CI doesn't overwrite the body — so a single edit suffices:
   ```
   gh release edit vX.Y.Z --notes-file .release-notes-X.Y.Z.md
   ```
9. The `v*` tag triggers **TWO** workflows — wait for **both** to finish `completed/success`. **Assets/release appearing ≠ release done** — wait for the runs.
   - **`release.yml`** — the desktop installers (6 build jobs + `merge-mac-metadata`).
   - **`docker.yml`** — the multi-arch GHCR image (incl. the `latest` tag). If this fails or lags, Docker users stay on the old image even though the desktop release is live.
   ```
   gh run list --workflow=release.yml --limit 1   # poll until completed/success
   gh run list --workflow=docker.yml  --limit 1   # poll until completed/success
   ```

## Verify (don't skip)
10. **Confirm `latest-mac.yml` lists BOTH mac arches** — the one residual failure mode CI does NOT assert (a skipped `merge-mac-metadata` leaves no/half metadata → broken, noisy macOS auto-update):
    ```
    gh release download vX.Y.Z -p latest-mac.yml -D /tmp/relchk --clobber
    grep -E '\.zip' /tmp/relchk/latest-mac.yml   # must show -mac-x64.zip AND -mac-arm64.zip
    ```
11. **Confirm the GHCR image published** for this version (so Docker users get it):
    ```
    gh run list --workflow=docker.yml --limit 1   # completed/success
    # optionally: docker manifest inspect ghcr.io/hyiger/filament-db:<X.Y.Z>
    ```
12. Report: version live, notes applied, both mac arches present, Docker image published.

## Gotchas
- The bump goes through a PR (branch protection forbids direct pushes to `main`); don't try to `git push` the version commit directly.
- `latest.yml` (Windows) is x64-only by design; `latest-mac.yml` must be multi-arch — that's the check in step 10. `latest-linux-arm64.yml` is arch-suffixed.
- macOS notarization on the FIRST build is slow (~40 min) — not a hang.
