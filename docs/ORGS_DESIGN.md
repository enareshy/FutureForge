# Helix IAM — Organization & Site Structure

Directory fabric for every future platform module. Identity, RBAC, and site operations consume the same tree through APIs rather than joining tables.

## Hierarchy (Super Admin property)

Default seed (changeable by Super Admin, role `platform.admin` / resource `iam.platform`):

```
Tenant → Enterprise → Company → Business Unit → Plant → Site → Department
```

`tenant` is both the top level of the tree and the data-isolation boundary (see `docs/ORGANIZATION_ADMIN_DESIGN.md`). `Plant` stays distinct from `Site`: a plant is a manufacturing facility, a site is a campus/location within it.

Levels, labels, sort order, root permission, and allowed parents live in `hierarchy_levels` + `hierarchy_parent_rules`. Create/move validation reads that definition — it is not compiled into application code.

One table (`organizations`) holds every node. `kind` is a level code from the Super Admin definition.

| Kind | Code in API | Typical parent | Root allowed |
|------|-------------|----------------|--------------|
| Tenant | `tenant` | none | yes |
| Enterprise | `enterprise` | tenant | no |
| Company | `company` | enterprise | no |
| Business unit | `business_unit` | company | no |
| Plant | `plant` | business unit | no |
| Site | `site` | plant | no |
| Department | `department` | site | no |

Legacy kind `organization` remains in the default definition so existing rows keep working. Super Admin may add levels (for example `region`), rename labels, reorder, deactivate unused levels, or replace parent rules. A level still used by nodes cannot be removed or deactivated.

## Parent and move rules

Create and move (`parent_id` change) both run the same checks:

1. Parent must exist when `parent_id` is set.
2. A node cannot be its own parent.
3. A node cannot move under one of its descendants (cycle).
4. Parent kind must be allowed for the child kind (table below). Sibling sites never become ancestors of each other.
5. Changing `kind` is rejected when any existing child would become an invalid placement.

Allowed parents (including legacy `organization`):

| Child | Allowed parents |
|-------|-----------------|
| `tenant` | none |
| `enterprise` | `tenant`, none |
| `company` | `enterprise`, `tenant`, `organization` |
| `business_unit` | `company`, `organization` |
| `plant` | `business_unit`, `company`, `organization` |
| `site` | `plant`, `business_unit`, `company`, `organization` |
| `department` | `site`, `plant`, `organization` |
| `organization` | none, `enterprise`, `organization`, `company`, `business_unit`, `plant` |

Status is `active` or `inactive`. Deactivate does not cascade; callers must treat inactive nodes as out of directory scope. Hard delete is refused when the node still has children, home users, groups, or membership rows.

## Users and sites

`users.organization_id` is the **home** organization (unchanged).

`organization_members` is the many-to-many assignment so a person can belong to several sites (or any node):

```
organization_members (organization_id, user_id, is_primary)
```

- Home org is also recorded as `is_primary = 1`.
- Authorization still uses the existing ancestor rule: a grant on an ancestor applies to descendants; a site grant does not apply to sibling sites (`docs/AUTHORIZATION_DESIGN.md`).
- Other modules should pass `context.organizationId` from the node the user is acting in, not assume a single site.

## Org context for other modules

In-process (`server/platform.js`):

- `ancestorOrganizationIds(db, id)` — grant matching (0 + self + parents)
- `descendantOrganizationIds(db, id)` — subtree
- `organizationContext(db, id)` — node, ancestors, children, path, members

HTTP:

- `GET /api/organizations/:id/context`

## REST

Guarded by `iam.organizations` CRUD (same fail-safe `requirePermission` as the rest of IAM). Hierarchy **definition** mutations require Super Admin (`iam.platform` update).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/hierarchy` | Active levels + parent rules (org operators) |
| GET | `/api/platform/hierarchy` | Full definition including inactive |
| PUT | `/api/platform/hierarchy` | Super Admin replace levels and parent rules |
| GET/PUT | `/api/platform/settings` | Super Admin feature properties |

Generic tree:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/organizations` | List (`kind`, `status`, `parentId`, `q`) |
| GET | `/api/organizations/tree` | Nested tree for navigation |
| POST | `/api/organizations` | Create any kind |
| GET | `/api/organizations/:id` | Detail + children + ancestors + members |
| PUT | `/api/organizations/:id` | Update including safe move via `parent_id` |
| DELETE | `/api/organizations/:id` | Delete with guards |
| POST | `/api/organizations/:id/activate` | Activate |
| POST | `/api/organizations/:id/deactivate` | Deactivate |
| POST | `/api/organizations/:id/move` | `{ parent_id }` — same validation as PUT |
| GET/POST | `/api/organizations/:id/sites` | Legacy nested sites |
| GET/POST | `/api/organizations/:id/members` | Assign users to this node |
| DELETE | `/api/organizations/:id/members/:userId` | Remove assignment |
| GET | `/api/organizations/:id/context` | Consume-side snapshot |

Typed collections (filter/create with a fixed kind). Item GET checks kind.

- `/api/companies`
- `/api/business-units`
- `/api/plants`
- `/api/sites`
- `/api/departments`

User-side membership: `GET/POST /api/users/:id/organizations`, `DELETE /api/users/:id/organizations/:orgId`.

## Seed (demo)

```
Helix (tenant, helix)
  Helix Corporate HQ (enterprise, corp-hq)
    Helix EMEA (company, emea)
      EMEA Operations (business_unit, emea-ops)
        London Plant (plant, emea-london-plant)
          London Campus (site, emea-london)
            London Finance / London Production (departments)
    Helix APAC (company, apac)
      APAC Operations (business_unit, apac-ops)
        Singapore Plant (plant, apac-singapore-plant)
          Singapore Hub (site, apac-singapore)
            Singapore Logistics (department)
```

Existing codes `corp-hq`, `emea`, `apac`, `emea-london`, `apac-singapore` are preserved. Users may be assigned to more than one site.

## UI

Organizations console: searchable/filterable hierarchy, create with valid parent, drill-in detail, breadcrumb, child management, user assignment, activate/deactivate, guarded delete, safe move. Levels and parents come from `/api/hierarchy`.

Super Admin console (`/platform`): edit Organization & Site Structure levels and parent matrix; other feature properties (`org.allow_multi_site`, session hours).
