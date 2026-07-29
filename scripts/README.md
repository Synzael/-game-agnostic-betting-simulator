# CI security check: new install-script dependencies

`check_new_install_scripts.py` runs on every pull request (see
[.github/workflows/pr-checks.yml](../.github/workflows/pr-checks.yml)) and
fails the build when a `package-lock.json` gains a dependency that did not
exist in the PR's base commit **and** declares `"hasInstallScript": true`.

## What it detects and why

npm runs a package's `install`/`postinstall` scripts with full user
privileges during `npm install`. A compromised or malicious package can use
that hook to exfiltrate secrets or backdoor the build — this is the classic
supply-chain attack pattern (`event-stream`, `ua-parser-js`, ...). The
riskiest moment is when such a package **first enters** the dependency tree,
so this check flags exactly that, while leaving long-standing install-script
dependencies (`esbuild`, `sharp`, `fsevents`, `unrs-resolver`) alone.

The check:

- compares every tracked `package-lock.json` in the PR head against the same
  file at the PR base commit, parsing both as JSON (never by diffing text);
- supports npm lockfileVersion 2/3 (the top-level `"packages"` object);
- treats a lockfile that is new in the PR as having an empty baseline, so
  every entry in it is screened;
- ignores the root project entry (`packages[""]`);
- **identity rule:** a package is identified by its exact key in the
  `"packages"` object — its installation path, e.g. `node_modules/foo` or
  `node_modules/a/node_modules/foo`. An entry is "new" only when that exact
  key is absent from the base lockfile. Version or metadata changes to an
  existing key are therefore never flagged, but a new *nested* copy of an
  already-present package is flagged (a nested copy can resolve to a
  different, malicious release);
- fails closed: malformed JSON, an unsupported lockfile shape (e.g.
  lockfileVersion 1), or an unreadable base revision aborts with exit code 2
  instead of passing silently.

It never runs `npm install`, never executes dependency lifecycle scripts,
and never executes JavaScript from the branch under review — analysis is
pure JSON parsing with the Python standard library.

## Running locally

```bash
python3 scripts/check_new_install_scripts.py --base origin/main
```

Exit codes: `0` clean, `1` suspicious dependency found, `2` analysis error.

## Reviewing a flagged dependency

There is deliberately **no allowlist** — every newly introduced
install-script dependency needs a human decision:

1. **Do not install the package locally.** Inspect its `package.json`
   `scripts` block and the referenced install files on
   <https://www.npmjs.com> or the package's source repository.
2. Verify the publisher, repository link, download counts, and release
   history look consistent (typosquats and freshly published versions are
   red flags).
3. Confirm the dependency is genuinely needed, and check whether a
   script-free alternative or an explicit `--ignore-scripts` install would
   work instead.
4. If the dependency is legitimate, approve the PR with a review comment
   documenting the assessment. The check only fires when the package is
   newly introduced, so it will not flag that package again on later PRs
   (unless it appears at a new path in the tree).

## Intentional limitations

- Only npm `package-lock.json` files are inspected (the only lockfile type
  in this repository). Other package managers' lockfiles are not covered.
- A package already in the lockfile that *adds* an install script in a new
  version is not flagged — the check targets newly introduced packages, not
  metadata changes to existing ones.
- The check trusts the lockfile's `hasInstallScript` metadata as npm
  records it; it does not fetch tarballs to verify scripts independently.
- lockfileVersion 1 files fail the check outright rather than being
  analyzed; regenerate them with a modern npm if one ever appears.
