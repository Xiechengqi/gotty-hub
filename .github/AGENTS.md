# GitHub Actions policy

- Do not add or run UI tests in GitHub Actions, including frontend component/DOM tests, browser automation, screenshots, or end-to-end UI tests.
- Do not invoke `npm test`, Vitest, Playwright, or browser regression scripts from workflows, including through reusable workflows or build scripts.
- Keep dependency installation, type checking, frontend builds, Rust checks/tests, backend process/protocol tests, and release builds in CI.
- UI regression tests may remain in the repository for use in an explicitly authorized isolated test environment outside GitHub Actions. Do not run them against live GoTTY or Hub services.
