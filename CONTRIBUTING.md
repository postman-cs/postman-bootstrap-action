# Contributing to postman-bootstrap-action

This repository is one independently released component of the Postman Enterprise Automation Suite. `AGENTS.md` is the single source of truth for its structure, exact gate commands, credential rules, and release contract; this page covers only the contribution workflow.

## Setup

```bash
npm ci   # install from the committed lockfile
```

Most repos wire `.githooks/` through the `prepare` script during `npm ci`; where `AGENTS.md` names `npm run setup:hooks` instead, run it once. Do not replace the lockfile or the package manager.

## Before you open a pull request

Run the gate set named in `AGENTS.md` from the repository root. At minimum every repo declares `npm test`, `npm run typecheck`, and `npm run lint`; repos that ship a bundle also declare a dist gate that must pass with the rebuilt `dist/` staged in the same commit.

- Keep each pull request to one concern.
- New behavior ships with deterministic tests in `tests/`.
- Never commit Postman API keys, access tokens, cloud credentials, or captured request bodies. Mask credentials before logging.
- Do not add Newman, token-authenticated npm publishing, or cross-action TypeScript imports; shared code lives in `@postman-cs/automation-core`.

## Pull requests and merges

Every change lands through a pull request against `main`; direct pushes to `main` are blocked by branch protection. CI runs one bounded `gate` job (plus a Windows job where the repo has one). Merge only after the required checks pass.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) and are validated by commitlint on every pull request:

```
<type>(<optional scope>): <description>
```

`feat` cuts a minor release, `fix` / `perf` / `refactor` / `docs` cut a patch, and `chore` / `ci` / `build` / `test` / `style` cut nothing. Releases are tagged automatically from `main`; never push a release tag by hand.

## Reporting problems

Open a GitHub issue for bugs, usage questions, or documentation gaps (see `SUPPORT.md`). Report vulnerabilities privately per `SECURITY.md`.

## License

Contributions are licensed under the repository's MIT License.
