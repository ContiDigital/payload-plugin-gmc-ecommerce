# Contributing

Thanks for your interest in contributing to `payload-plugin-gmc-ecommerce`.

## Development Setup

```bash
# Clone the repository
git clone <repo-url>
cd payload-plugin-gmc-ecommerce
pnpm install

# Copy the example env and fill in your credentials
cp dev/.env.example dev/.env

# Start the dev server
pnpm dev

# Run tests
pnpm test:int

# Lint
pnpm lint

# Build
pnpm build
```

## Project Structure

- `src/` — Plugin source code (TypeScript)
- `dev/` — Development Payload app for manual testing
- `dist/` — Build output (git-ignored)
- `.github/workflows/` — CI/CD pipelines

## Quality Gates

All PRs must pass the CI quality gates before merging:

1. **Lint** — `pnpm lint` (zero warnings)
2. **Type check** — `tsc --noEmit`
3. **Tests** — `pnpm test:int` (all passing)
4. **Build** — `pnpm build` (clean build)
5. **Pack smoke** — `pnpm pack:smoke` (published package imports correctly)

## Submitting Changes

1. Fork the repository and create a branch from `main`
2. Make your changes with clear, focused commits
3. Add tests for new functionality
4. Ensure all quality gates pass locally
5. Open a pull request with a clear description of the change

## Releases

Releases are managed via git tags. When a tag matching `v*.*.*` is pushed to `main`, the release workflow automatically publishes to npm and creates a GitHub Release.

## Code Style

This project uses the Payload CMS ESLint config. Run `pnpm lint:fix` to auto-fix issues.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
