# Publishing Guide

This guide explains how to publish the `knowns` package to npm using GitHub Actions.

## Setup

### 1. Create NPM Access Token

1. Go to [npmjs.com](https://www.npmjs.com/) and log in
2. Click your profile icon → **Access Tokens**
3. Click **Generate New Token** → **Classic Token**
4. Select **Automation** type (for CI/CD)
5. Copy the token (starts with `npm_...`)

### 2. Add Token to GitHub Secrets

1. Go to your repository on GitHub
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `NPM_TOKEN`
5. Value: Paste your npm token
6. Click **Add secret**

## Publishing Process

### Option 1: Publish with Git Tag (Recommended)

This is the automated way to publish when you're ready for a release:

```bash
# 1. Update version in package.json
npm version patch  # or minor, or major
# This creates a git tag like v0.1.1

# 2. Push the tag to GitHub
git push origin main --tags

# 3. GitHub Actions will automatically:
#    - Run tests and linting
#    - Build the project
#    - Publish to npm
#    - Create a GitHub release
```

### Option 2: Manual Publish (workflow_dispatch)

You can also trigger the publish workflow manually:

1. Go to **Actions** tab in your GitHub repository
2. Select **Publish to npm** workflow
3. Click **Run workflow**
4. (Optional) Enter version number
5. Click **Run workflow**

## Version Numbering

We follow [Semantic Versioning](https://semver.org/):

- **Patch** (0.1.0 → 0.1.1): Bug fixes, small changes
- **Minor** (0.1.0 → 0.2.0): New features, backwards compatible
- **Major** (0.1.0 → 1.0.0): Breaking changes

```bash
# Update version and create tag
npm version patch   # 0.1.0 → 0.1.1
npm version minor   # 0.1.0 → 0.2.0
npm version major   # 0.1.0 → 1.0.0

# Then push
git push origin main --tags
```

## Pre-release Versions

For beta or RC releases:

```bash
# Create a pre-release version
npm version prerelease --preid=beta  # 0.1.0 → 0.1.1-beta.0
npm version prerelease --preid=rc    # 0.1.0 → 0.1.1-rc.0

# Push the tag
git push origin main --tags
```

## Workflow Details

### CI Workflow (ci.yml)

Runs on every push and pull request to `main` or `develop`:

- ✅ Lint code with Biome
- ✅ Run tests
- ✅ Build project
- ✅ Verify build output

### Publish Workflow (publish.yml)

Triggers on version tags (v*.*.*):

1. **Checkout** code
2. **Setup** Bun environment
3. **Install** dependencies
4. **Lint** code
5. **Test** code
6. **Build** project
7. **Verify** build output exists
8. **Publish** to npm with provenance
9. **Create** GitHub release

## Troubleshooting

### Build Fails

Check that all files are committed:
```bash
git status
```

### Publish Fails with "Unauthorized"

- Verify `NPM_TOKEN` secret is set correctly
- Check token hasn't expired
- Ensure token has "Automation" permission

### Wrong Version Published

- Delete the tag: `git tag -d v0.1.0`
- Delete remote tag: `git push origin :refs/tags/v0.1.0`
- Unpublish from npm (within 72 hours): `npm unpublish knowns@0.1.0`
- Fix version and try again

### Package Already Published

You cannot republish the same version. Update the version:

```bash
npm version patch
git push origin main --tags
```

## Testing Locally

Before publishing, test the build locally:

```bash
# Clean install
rm -rf node_modules bun.lockb
bun install

# Run full CI checks
bun run lint
bun test
bun run build

# Test the built CLI
node dist/index.js --help

# Test installation from local build
npm pack
npm install -g knowns-0.1.0.tgz
knowns --help
```

## NPM Package Settings

After first publish, configure your package on npm:

1. Go to [npmjs.com/package/knowns](https://npmjs.com/package/knowns)
2. Add description, keywords, README
3. Enable 2FA for publishing (highly recommended)
4. Consider setting up npm provenance (already configured in workflow)

## Checklist Before Publishing

- [ ] All tests pass locally
- [ ] Build succeeds locally
- [ ] CHANGELOG.md updated
- [ ] README.md updated if needed
- [ ] Version number follows semver
- [ ] Git tag matches package.json version
- [ ] NPM_TOKEN secret is configured

## Links

- [NPM Package](https://www.npmjs.com/package/knowns)
- [GitHub Repository](https://github.com/knowns-dev/knowns)
- [GitHub Actions](https://github.com/knowns-dev/knowns/actions)
