# Error codes

Every error response has the same JSON body (ADR-021):

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "details": [{ "path": "email", "message": "Invalid email address" }]
  }
}
```

- `code` is one of the nine codes below. Switch on `code`, never on `message`: messages are for people and may change.
- `message` is safe to show; it never contains a stack trace or a rejected value.
- `details` is present only on `VALIDATION_FAILED` (422).

The OpenAPI document at `/docs/openapi.json` describes the same envelope as the `ErrorEnvelope` component.

## Codes

| Code                | HTTP | Meaning                                                   | Typical triggers                                                                                                                                                                                                                                                                      | `details`              |
| ------------------- | ---- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `BAD_REQUEST`       | 400  | The request is malformed or unsupported.                  | Malformed JSON; an undecodable `%` escape in the path; an operator object in a filter value; an unknown search collection; a missing or non-image upload. Other HTTP-layer 4xx errors keep their status but use this code (for example body-parser's 415 for an unsupported charset). | —                      |
| `UNAUTHORIZED`      | 401  | Not authenticated.                                        | No token; a malformed `Authorization` header; an invalid, expired or revoked token; a deactivated account; wrong login credentials (the same 401 for an unknown email and a wrong password).                                                                                          | —                      |
| `FORBIDDEN`         | 403  | Signed in, but not allowed.                               | A role that the route does not admit; editing someone else's product; an administrator changing their own role or active state; deleting your own account.                                                                                                                            | —                      |
| `NOT_FOUND`         | 404  | The route or the resource does not exist, or is inactive. | An unknown route (`Route not found`); a missing or soft-deleted record; an inactive category on a product write; a record without an image.                                                                                                                                           | —                      |
| `CONFLICT`          | 409  | The resource already exists.                              | An email already registered; an active category or product with the same name (case-insensitive).                                                                                                                                                                                     | —                      |
| `PAYLOAD_TOO_LARGE` | 413  | The body is over its size limit.                          | A JSON body over 100 kB; an upload over 5 MB.                                                                                                                                                                                                                                         | —                      |
| `VALIDATION_FAILED` | 422  | The input failed validation.                              | A body, query or path parameter that breaks its schema: a missing field, a value out of range, a malformed id or email, a password outside 8 characters to 72 bytes.                                                                                                                  | Every issue, see below |
| `RATE_LIMITED`      | 429  | Too many requests.                                        | More than the allowed login or Google sign-in attempts per IP or per account in the window.                                                                                                                                                                                           | —                      |
| `INTERNAL`          | 500  | An unexpected server error.                               | Anything not listed above. The cause is logged with the request's `x-request-id`, never sent.                                                                                                                                                                                         | —                      |

## How raw errors map (`toAppError`)

Every failure that reaches the error handler becomes one of the codes above:

| Raw error                                                            | Becomes                                                  |
| -------------------------------------------------------------------- | -------------------------------------------------------- |
| An application error (`AppError` and its subclasses)                 | Itself                                                   |
| body-parser's 413 (body too large)                                   | 413 `PAYLOAD_TOO_LARGE`                                  |
| Any other exposed HTTP-layer 4xx, or a `URIError` from path decoding | That status, code `BAD_REQUEST`                          |
| A MongoDB duplicate key (`code` 11000)                               | 409 `CONFLICT`                                           |
| A Mongoose `ValidationError` or `CastError`                          | 400 `BAD_REQUEST`                                        |
| Anything else                                                        | 500 `INTERNAL` (the cause is logged with the request id) |

## `details` (422 only)

`details` lists every issue found, not only the first. Each issue is `{ path, message }`:

- `path` names the field, dot-separated for nested fields (`email`, `id`).
- `message` says what is wrong with it.

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "details": [
      { "path": "name", "message": "Too small: expected string to have >=1 characters" },
      { "path": "category", "message": "must be a Mongo id" }
    ]
  }
}
```
