# packages

Shared, versioned building blocks consumed by the AI applications.

These are placeholders in Phase 2. They are populated once the contracts stabilize
(they are intentionally empty until then to avoid speculative abstractions):

| Package | Purpose | Populated in |
| --- | --- | --- |
| `shared-types` | Cross-cutting TypeScript types shared by console apps | Phase 5+ |
| `api-contracts` | Generated/checked OpenAPI clients and schema types | Phase 5+ |
| `frontend-components` | Reusable, accessible UI primitives for AI surfaces | Phase 6+ |

Until a package is implemented, apps must not import from it.
