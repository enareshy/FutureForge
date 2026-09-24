# PDM Domain - HTTP API

Base paths: `/api/pdm` and `/api/v1/pdm`. All endpoints require authentication
(Bearer token). Errors use the standardized shape
`{ "error": string, "code"?: string, "details"?: object }`. List endpoints return
`{ items, total, page, page_size }`. Unauthenticated calls return `401`; calls
without the required permission return `403`.

Permission resources:
`iam.pdm.{overview,items,revisions,parts,products,datasets,representations,design-data,cad,revision-rules,configuration-rules,baselines,whereused,wherereferenced,structure,validation,search,audit,metrics,admin}`
with actions `read`, `create`, `update`, `delete`, `execute`.

## Meta, health, metrics and configuration

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/meta` | Vocabularies, capabilities, security actions and resources |
| GET | `/health` | Foundation counts and health status |
| GET | `/metrics` | Adoption snapshot and quality signals |
| GET | `/rule-usage` | Validation/revision/configuration rule usage statistics |
| GET | `/config` | Effective tenant configuration |
| PUT/PATCH | `/config/:key` | Set a single configuration key (bounds-enforced) |

## Items, parts and products

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/items` | List / create items |
| GET | `/items/:ref` | Read an item (id, `item_ref` or `item_number`) |
| PUT/PATCH | `/items/:ref` | Update |
| POST | `/items/:ref/status` | Transition item status (`DRAFT`/`IN_WORK`/`RELEASED`/`OBSOLETE`) |
| DELETE | `/items/:ref` | Delete an item with no revisions |
| GET | `/items/:ref/audit` | Change history for the item |
| GET/POST | `/items/:ref/revisions` | List / create revisions |
| GET | `/items/:ref/structure` | Resolve the item's product structure |
| GET | `/items/:ref/where-used` | Where-used for the item |
| GET | `/items/:ref/datasets` | Datasets for the item |
| GET/POST | `/parts` | List / create parts (items with `item_type=PART`) |
| GET/POST | `/products` | List / create products (items with `item_type=PRODUCT`) |

## Revisions & attached content

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/revisions` | List revisions (`item_id`/`item_ref`, `status`, `variant_code`, `q`) |
| GET | `/revisions/:ref` | Read a revision |
| PUT/PATCH | `/revisions/:ref` | Update a draft revision |
| POST | `/revisions/:ref/status` | Transition revision status (`DRAFT`/`IN_WORK`/`IN_REVIEW`/`RELEASED`/`OBSOLETE`) |
| POST | `/revisions/:ref/revise` | Create a successor draft |
| DELETE | `/revisions/:ref` | Delete a revision |
| POST | `/revisions/:ref/validate` | Run validation rules over the revision |
| GET | `/revisions/:ref/validation-results` | Validation results for the revision |
| GET/POST | `/revisions/:ref/datasets` | List / create datasets |
| GET/POST | `/revisions/:ref/representations` | List / create representations |
| GET/POST | `/revisions/:ref/design-data` | List / create design data |
| GET/POST | `/revisions/:ref/cad` | List / create CAD associations |

## Datasets, representations, design data and CAD

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/datasets` | List / create datasets |
| GET | `/datasets/:ref` | Read a dataset (id, `dataset_ref` or `dataset_number`) |
| PUT/PATCH | `/datasets/:ref` | Update |
| POST | `/datasets/:ref/status` | Transition dataset status |
| POST | `/datasets/:ref/content` | Link dataset content (`content_id`, type, reference) |
| DELETE | `/datasets/:ref` | Delete a dataset |
| GET/POST | `/representations` | List / create representations |
| GET | `/representations/:ref` | Read |
| PUT/PATCH | `/representations/:ref` | Update |
| DELETE | `/representations/:ref` | Delete |
| GET/POST | `/design-data` | List / create design data |
| GET | `/design-data/:ref` | Read |
| PUT/PATCH | `/design-data/:ref` | Update |
| DELETE | `/design-data/:ref` | Delete |
| GET/POST | `/cad-associations` | List / create CAD associations |
| GET | `/cad-associations/:ref` | Read |
| PUT/PATCH | `/cad-associations/:ref` | Update |
| DELETE | `/cad-associations/:ref` | Delete |

## Revision & configuration rules

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/revision-rules` | List / create revision rules |
| POST | `/revision-rules/resolve` | Resolve a revision for an item (`item_id`/`item_ref`, `rule_code`/`rule_id`, `context`) |
| GET | `/revision-rules/:ref` | Read |
| PUT/PATCH | `/revision-rules/:ref` | Update |
| POST | `/revision-rules/:ref/activate` | Activate |
| POST | `/revision-rules/:ref/status` | Set status |
| GET/POST | `/revision-rules/:ref/versions` | List / publish immutable versions |
| DELETE | `/revision-rules/:ref` | Delete |
| GET/POST | `/configuration-rules` | List / create configuration rules |
| POST | `/configuration-rules/evaluate` | Evaluate active rules against a context |
| GET | `/configuration-rules/:ref` | Read |
| PUT/PATCH | `/configuration-rules/:ref` | Update |
| POST | `/configuration-rules/:ref/activate` | Activate |
| POST | `/configuration-rules/:ref/status` | Set status |
| GET/POST | `/configuration-rules/:ref/versions` | List / publish immutable versions |
| DELETE | `/configuration-rules/:ref` | Delete |

## Baselines

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/baselines` | List / create baselines |
| GET | `/baselines/:ref` | Read (id, `baseline_ref` or `baseline_number`) |
| PUT/PATCH | `/baselines/:ref` | Update a draft baseline |
| POST | `/baselines/:ref/release` | Release (immutable) |
| POST | `/baselines/:ref/freeze` | Freeze |
| POST | `/baselines/:ref/retire` | Retire |
| GET | `/baselines/:ref/snapshot` | Snapshot metadata |
| GET/POST | `/baselines/:ref/members` | List / add members |
| DELETE | `/baselines/:ref/members/:memberId` | Remove a member |
| DELETE | `/baselines/:ref` | Delete |

## Relationships, references & analysis

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/relationships` | List / create typed PDM relationships |
| GET | `/relationships/:ref` | Read |
| PUT/PATCH | `/relationships/:ref` | Update |
| DELETE | `/relationships/:ref` | Delete |
| GET/POST | `/references` | List / record reverse references |
| GET | `/where-used` | Where-used search (`item_ref`/`item`/`item_id`) |
| GET | `/where-used/:ref` | Where-used for an item |
| GET | `/where-referenced` | Where-referenced (`target_type`, `target_id`, `category`) |
| GET | `/where-referenced/:targetType/:targetId` | Where-referenced for a target |
| GET | `/references/summary` | Reference counts by category |
| GET | `/structure/:ref` | Resolve a product structure (`rule_code`, `as_of`, context) |
| GET | `/structure/:ref/validate` | Validate a structure graph (cycle/truncation) |
| POST | `/structure/resolve` | Resolve a structure by `item_id`/`item_ref` |

## Validation, history, jobs and discovery

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/validation-rules` | List / create validation rules |
| PUT/PATCH | `/validation-rules/:ref` | Update |
| DELETE | `/validation-rules/:ref` | Delete |
| POST | `/validation/run` | Run tenant validation (`scope`) |
| GET | `/validation-results` | List validation results |
| GET | `/validation-results/:ref` | Read a result with issues |
| GET | `/history` | Change history |
| GET | `/history/:objectType/:objectId` | Object lineage |
| POST | `/jobs/structure` | Background structure resolution |
| POST | `/jobs/where-used` | Background where-used |
| POST | `/jobs/where-referenced` | Background where-referenced |
| POST | `/jobs/baseline` | Background baseline creation |
| POST | `/jobs/validate` | Background validation (supports `Idempotency-Key`) |
| POST | `/jobs/reindex` | Background search reindex |
| POST | `/jobs/maintenance` | Background maintenance |
| POST | `/foundation/ensure` | Ensure the PDM foundation |
| POST | `/seed` | Seed demonstration data |
| POST | `/search/reindex` | Register PDM search sources |
| GET | `/search-meta` | Registered search object types |

Background job endpoints return `202 Accepted` with the job record. Passing the
same `Idempotency-Key` header (or `idempotency_key` body field) returns the
original job instead of creating a duplicate.
