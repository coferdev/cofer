# Release notes feed

Cofer's changelog as a feed. Subscribe once in any feed reader and every release shows up there.

| Feed | Address |
|---|---|
| Atom | `https://<signer site>/v1/changelog.atom` |
| JSON Feed 1.1 | `https://<signer site>/v1/changelog.json` |

Each entry is either:

- a tech update, from its line in `CHANGELOG.md`
  (`- Update NN · YYYY-MM-DD HH:MM UTC: Title: what is new`), linking its GitHub release; or
- a released version (`## [x.y.z] - YYYY-MM-DD`), with that section's text.

Newest first, at most 100 entries. The feed is made from the `CHANGELOG.md` in the running release, so it always
matches what is live. It may be cached for 5 minutes.
