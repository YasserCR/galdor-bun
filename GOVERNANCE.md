# Governance

This document describes how decisions are made in the galdor project.

## Roles

### Maintainer

Maintainers are responsible for the overall direction of the project: reviewing
and merging pull requests, triaging issues, cutting releases, and upholding the
[Code of Conduct](CODE_OF_CONDUCT.md).

The current maintainer is:

- **Yasser Rosas** &lt;yassros16@gmail.com&gt;

### Contributor

Anyone who submits an issue or a pull request is a contributor. Contributions of
all kinds — code, tests, documentation, examples, bug reports, and reviews — are
welcome.

## Decision making

Most decisions are made through the normal pull-request and issue review
process, by consensus among the people taking part in the discussion. When a
decision needs a tie-breaker, the maintainers decide.

Changes to public API, the on-disk store format, or the wire compatibility of
the observability data are treated as significant and require explicit
maintainer approval and a note in [`CHANGELOG.md`](CHANGELOG.md).

## Releases

Releases follow [Semantic Versioning](https://semver.org/). Versions are kept in
lockstep across the workspace packages. The release process and the changelog
are owned by the maintainers.

## Adding maintainers

A contributor with a sustained track record of high-quality contributions and
reviews may be invited to become a maintainer by the existing maintainers.
