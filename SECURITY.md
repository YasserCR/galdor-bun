# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in galdor, please report
it privately. **Do not open a public issue or pull request for security
problems**, as that discloses the vulnerability before a fix is available.

Email **yassros16@gmail.com** with:

- a description of the issue and the impact you believe it has,
- the affected package(s) and version(s),
- steps to reproduce, or a proof of concept, if you have one.

You can expect an acknowledgement within a few days. Once the issue is
confirmed, we will work on a fix, coordinate a release, and credit you in the
release notes unless you prefer to remain anonymous.

## Supported versions

This project is in early development. Security fixes are applied to the latest
released version on the `main` branch.

## Handling secrets

galdor talks to model providers using API keys you supply via environment
variables. Keys are never written to the span store. The observability dashboard
binds to loopback (`127.0.0.1`) by default; if you expose it on another
interface, be aware that captured prompts and completions become reachable over
the network.
