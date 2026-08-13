# Security Policy

## Supported Versions

Security updates are provided for the latest released version of Knowns.

| Version | Supported |
| ------- | --------- |
| Latest release | Yes |
| Older releases | Best effort |
| Unreleased code on `main` | Best effort |

## Reporting a Vulnerability

If you discover a security vulnerability, please do not open a public GitHub issue.

Report it privately using GitHub Private Vulnerability Reporting:

- Go to the repository's **Security** tab
- Open **Advisories**
- Select **Report a vulnerability**

You can also use this direct link when available:

<https://github.com/knowns-dev/knowns/security/advisories/new>

If private vulnerability reporting is not available, contact the maintainers through a private channel. Do not include vulnerability details in a public issue, discussion, pull request, or comment.

Please include as much detail as possible:

- A clear description of the vulnerability
- Steps to reproduce the issue
- The affected version, release, or commit
- Potential impact
- Any proof of concept, logs, screenshots, or related context
- Whether you would like public credit if the issue is confirmed

## Vulnerability Handling Process

Maintainers will make a best-effort attempt to:

1. Acknowledge the report within a reasonable time.
2. Validate and reproduce the issue.
3. Determine the affected versions and severity.
4. Develop and test a fix privately when appropriate.
5. Release a patched version or mitigation.
6. Publish a security advisory with impact, affected versions, patched versions, and available mitigations when appropriate.

Please give maintainers reasonable time to investigate and fix the vulnerability before publicly disclosing details.

## Dependency Vulnerabilities

Reports about vulnerable dependencies are welcome.

Please include:

- The CVE identifier, if one exists
- The affected package and version
- Whether the vulnerable code path is used by this project
- Any available mitigation or patched version

Maintainers will assess whether the vulnerability affects Knowns in practice and update, patch, or document mitigations as appropriate.

## Disclosure and Credits

After a fix is available, maintainers may publish a GitHub Security Advisory, release notes, or changelog entry describing the issue and mitigation.

Reporter credit will be given only with the reporter's consent.

## Scope

Security reports are welcome for vulnerabilities in this project's source code, releases, or documented usage.

The following are generally out of scope:

- Vulnerabilities in unsupported old versions
- Issues caused by insecure local configuration
- Social engineering
- Spam or abuse reports unrelated to project security
- Dependency vulnerabilities that do not affect this project in practice
