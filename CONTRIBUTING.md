# Contributing to LLM-Hub

Thank you for your interest in contributing to LLM-Hub! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When creating a bug report, include:

- **Clear title and description**
- **Steps to reproduce** the issue
- **Expected behavior** vs actual behavior
- **Environment details** (OS, Node.js version, etc.)
- **Logs and error messages**
- **Configuration** (sanitized, without API keys)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, include:

- **Clear title and description**
- **Use case** - why is this enhancement useful?
- **Proposed solution** - how should it work?
- **Alternatives considered**
- **Additional context** (mockups, examples, etc.)

### Pull Requests

1. **Fork the repository** and create your branch from `main`
2. **Make your changes** following our coding standards
3. **Add tests** if you're adding functionality
4. **Update documentation** if needed
5. **Ensure tests pass**: `npm test`
6. **Commit your changes** with clear commit messages
7. **Push to your fork** and submit a pull request

#### Pull Request Guidelines

- Follow the existing code style
- Write clear, descriptive commit messages
- Include tests for new features
- Update documentation for API changes
- Keep PRs focused - one feature/fix per PR
- Reference related issues in the PR description

## Development Setup

### Prerequisites

- Node.js 24.0.0 or higher
- npm 10.0.0 or higher
- Git

### Setup Steps

1. **Clone your fork**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/LLM-Hub.git
   cd LLM-Hub
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Set up environment**:
   ```bash
   cp docs/.env.example docs/.env
   # Edit docs/.env with your API keys
   ```

4. **Initialize database**:
   ```bash
   npm run db:init
   ```

5. **Run tests**:
   ```bash
   npm test
   ```

6. **Start the gateway**:
   ```bash
   npm start
   # Or for development:
   ./scripts/start-gateway.sh
   ```

## Project Structure

```
LLM-Hub/
├── lib/                    # Core library modules
│   ├── gateway.mjs        # Main gateway logic
│   ├── protocol.mjs       # Protocol detection and conversion
│   ├── upstream-manager.mjs # Upstream management and circuit breaker
│   ├── database.mjs       # Database adapter
│   └── ...
├── tests/                 # Test suites
│   ├── unit/             # Unit tests
│   ├── integration/      # Integration tests
│   └── ...
├── scripts/              # Utility scripts
├── config/               # Configuration files
├── docs/                 # Documentation
└── dashboard/            # Dashboard HTML
```

## Coding Standards

### JavaScript Style

- Use ES modules (`import`/`export`)
- Use `const` and `let`, avoid `var`
- Use async/await over callbacks
- Use template literals for string interpolation
- Add JSDoc comments for public APIs

### Naming Conventions

- **Files**: kebab-case (e.g., `upstream-manager.mjs`)
- **Classes**: PascalCase (e.g., `GatewayApp`)
- **Functions**: camelCase (e.g., `buildRoutePlan`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `DEFAULT_PORT`)

### Error Handling

- Always handle errors explicitly
- Use try-catch for async operations
- Log errors with context
- Return meaningful error messages

### Testing

- Write tests for new features
- Maintain test coverage above 80%
- Use descriptive test names
- Test both success and error cases

## Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types**:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples**:
```
feat(gateway): add support for custom headers

Add ability to forward custom headers to upstream servers.
This allows users to pass authentication tokens and other
metadata through the gateway.

Closes #123
```

```
fix(circuit-breaker): correct cooldown calculation

The exponential backoff was not working correctly due to
integer overflow. Changed to use Math.min to cap the value.

Fixes #456
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run specific test suite
npm run test:unit
npm run test:integration
npm run test:failover
npm run test:performance

# Run with coverage
npm run test:coverage
```

### Writing Tests

Tests are located in the `tests/` directory and use Node.js built-in test runner.

Example test:
```javascript
import { test } from 'node:test';
import assert from 'node:assert';
import { detectProtocol } from '../lib/protocol.mjs';

test('detectProtocol distinguishes responses vs chat', () => {
  assert.strictEqual(detectProtocol('/responses'), 'responses');
  assert.strictEqual(detectProtocol('/chat/completions'), 'chat_completions');
  assert.strictEqual(detectProtocol('/v1/responses'), 'responses');
});
```

## Documentation

### Updating Documentation

- Update README.md for user-facing changes
- Update ARCHITECTURE.md for design changes
- Update API documentation for endpoint changes
- Add examples for new features

### Documentation Style

- Use clear, concise language
- Include code examples
- Add screenshots for UI changes
- Keep documentation up-to-date with code

## Release Process

Releases are managed by project maintainers. The process is:

1. Update CHANGELOG.md
2. Update version in package.json
3. Create git tag
4. Push to GitHub
5. Create GitHub Release
6. Publish to npm (if applicable)

## Getting Help

- **GitHub Discussions**: For questions and discussions
- **GitHub Issues**: For bug reports and feature requests
- **Documentation**: Check docs/ directory

## Recognition

Contributors will be recognized in:
- README.md contributors section
- CHANGELOG.md for their contributions
- GitHub contributors page

Thank you for contributing to LLM-Hub! 🎉
