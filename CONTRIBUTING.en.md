# Contributing

Thank you for wanting to contribute to Wan Code. This is a community project — whether you are a regular user or a developer, there is a way to contribute that fits you.

## Regular users: use and report

- Report problems in an [issue](https://github.com/ThomasWan123/wancode-NewVer/issues): include your operating system (Windows-first today), application version, and reproduction steps.
- Feature ideas and improvement suggestions are welcome as issues too.

## Developers: contribute code

### Development environment

```sh
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn check   # full headless gate: build, typecheck, tests, and smokes
corepack yarn dev     # launch the application when a graphical session is available
```

### Repository boundaries (please read before starting)

- `deepseek-harness/` is the pinned upstream submodule. **Never edit files inside it**; upstream updates land through separate pin commits.
- Desktop code lives in `dsh-plugin-desktop/`. Wan Code protocol and cloud modules live in `packages/wancode/`.
- `dsh-community-fabric/` owns the community-standard Draft and `dsh-community-market/` owns the market-shell design. Both community packages are currently documentation-only and not loadable.
- Builds, typechecks, unit tests, and smoke checks must stay headless-safe.

### Commits and pull requests

- Use conventional commit messages (for example `fix(desktop): ...`, `docs: ...`).
- Run `yarn check` and keep it green before committing.
- After changing desktop production dependencies, run `yarn workspace dsh-plugin-desktop verify:notices` to refresh the third-party notices and commit the updated `dsh-plugin-desktop/THIRD_PARTY_NOTICES.md`.
- Root README changes should stay bilingual and update the `README.i18n.yaml` hash record.
- Describe the change, its motivation, and how it was verified in the PR; merge after CI passes.

## Code of conduct

Be kind and respectful, and stick to the topic. The [Contributor Covenant](CODE_OF_CONDUCT.en.md) applies to all project spaces.
