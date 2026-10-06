# API diagrams

Interactive, self-contained HTML diagrams of the API. Open any `.html` file directly in a browser: no server or network is needed. Each one has light/dark themes, pan and zoom, search, guided views and image export.

| Diagram | Shows |
|---|---|
| [api-architecture.html](api-architecture.html) | How the API is built: the HTTP pipeline, the auth guard (JWT + roles), the six feature modules, MongoDB, Google OAuth, Cloudinary, health probes, `/docs`, the error handler and the migrations CLI. |
| [api-request-sequence.html](api-request-sequence.html) | The life of an authenticated `PUT /api/product/:id`: JWT and token-version check, role policy, zod validation, the ownership-guarded write and the response envelope. |
| [api-delivery-workflow.html](api-delivery-workflow.html) | From commit to production: PR checks, the `next → master` promotion with CodeQL, the `vX.Y.Z` tag, `release.yml` (GHCR image + GitHub Release), the manual Dokploy deploy and rollback. |

The diagrams reflect the code at release 3.2.1 (`7998e5a`). Each node of the architecture diagram links to the source file it describes.

## Regenerating

The `.json` files are the sources, rendered with [Archify](https://github.com/tt-a1i/archify). After editing a source, rebuild its HTML from the Archify skill directory, for example:

```bash
node bin/archify.mjs deliver architecture <repo>/docs/diagrams/api.architecture.json <repo>/docs/diagrams/api-architecture.html \
  --quality showcase --repo-root <repo>
node bin/archify.mjs deliver sequence <repo>/docs/diagrams/api.sequence.json <repo>/docs/diagrams/api-request-sequence.html --quality showcase
node bin/archify.mjs deliver workflow <repo>/docs/diagrams/api.workflow.json <repo>/docs/diagrams/api-delivery-workflow.html --quality showcase
```

The architecture source pins `meta.repository.revision` to a commit; update it when the code it points to changes.
