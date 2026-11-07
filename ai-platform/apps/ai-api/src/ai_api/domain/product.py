"""Product & BOM domain vocabulary (Stage 8 / Step 6).

Pure data, no behaviour. The vocabulary mirrors the existing enterprise BOM
engine so the AI platform speaks the same language as the system of record, and
the services never hardcode values that an administrator could tune.

The knowledge graph (Stage 7) is the relationship/traceability foundation. These
product-domain records are separate rows that *link* to graph entities through
`graph_entity_id`; the services create/update the graph entity alongside, but
never duplicate the graph model.
"""

from __future__ import annotations

from dataclasses import dataclass

# --- Item types -----------------------------------------------------------
ITEM_TYPES: tuple[str, ...] = ("product", "part", "assembly", "component", "material")

# Types that can act as a BOM parent (have their own structure).
ASSEMBLY_ITEM_TYPES: frozenset[str] = frozenset({"product", "assembly"})

# --- Lifecycle ------------------------------------------------------------
ITEM_LIFECYCLE_STATES: tuple[str, ...] = (
    "draft",
    "active",
    "released",
    "obsolete",
    "archived",
)

# Allowed forward/backward lifecycle transitions for a product/part/revision.
ITEM_LIFECYCLE_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "draft": ("active", "obsolete"),
    "active": ("released", "obsolete"),
    "released": ("obsolete",),
    "obsolete": ("archived",),
    "archived": (),
}

BOM_LIFECYCLE_STATES: tuple[str, ...] = (
    "draft",
    "in_review",
    "released",
    "superseded",
    "obsolete",
    "archived",
)

BOM_LIFECYCLE_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "draft": ("in_review", "obsolete"),
    "in_review": ("draft", "released", "obsolete"),
    "released": ("superseded", "obsolete"),
    "superseded": ("obsolete",),
    "obsolete": ("archived",),
    "archived": (),
}

# Revisions in these states are immutable: services reject in-place edits.
IMMUTABLE_BOM_STATES: frozenset[str] = frozenset({"superseded", "obsolete", "archived"})

# --- BOM types ------------------------------------------------------------
BOM_TYPES: tuple[str, ...] = ("EBOM", "MBOM", "BOP", "OTHER")
EBOM = "EBOM"
MBOM = "MBOM"

LINE_USAGES: tuple[str, ...] = ("DESIGN", "MANUFACTURING", "SERVICE", "SPARE", "REFERENCE")
LINE_STATUSES: tuple[str, ...] = ("draft", "active", "inactive", "obsolete")

# --- Comparison -----------------------------------------------------------
CHANGE_ADDED = "added"
CHANGE_REMOVED = "removed"
CHANGE_MODIFIED = "modified"
CHANGE_UNCHANGED = "unchanged"
CHANGE_MOVED = "moved"

CHANGE_TYPES: tuple[str, ...] = (
    CHANGE_ADDED,
    CHANGE_REMOVED,
    CHANGE_MODIFIED,
    CHANGE_UNCHANGED,
    CHANGE_MOVED,
)

COMPARISON_SCOPES: tuple[str, ...] = ("line", "recursive")
COMPARISON_KINDS: tuple[str, ...] = ("revision", "ebom_mbom", "structure")

# Attributes that, when different between two matched lines, mark a MODIFIED.
COMPARED_LINE_ATTRIBUTES: tuple[str, ...] = (
    "quantity",
    "unit_of_measure",
    "child_revision_id",
    "find_number",
    "reference_designators",
    "usage",
    "is_phantom",
    "is_reference",
)

# --- Transformation / reconciliation -------------------------------------
MAPPING_ONE_TO_ONE = "ONE_TO_ONE"
MAPPING_ONE_TO_MANY = "ONE_TO_MANY"
MAPPING_MANY_TO_ONE = "MANY_TO_ONE"
MAPPING_UNMATCHED = "UNMATCHED"
MAPPING_CONSTANT = "CONSTANT"

MAPPING_TYPES: tuple[str, ...] = (
    MAPPING_ONE_TO_ONE,
    MAPPING_ONE_TO_MANY,
    MAPPING_MANY_TO_ONE,
    MAPPING_UNMATCHED,
    MAPPING_CONSTANT,
)

TRANSFORMATION_MODES: tuple[str, ...] = ("DRY_RUN", "EXECUTE")

RECONCILIATION_OPEN = "open"
RECONCILIATION_MATCHED = "matched"
RECONCILIATION_EXCEPTIONS = "exceptions"
RECONCILIATION_RESOLVED = "resolved"

RECONCILIATION_STATUSES: tuple[str, ...] = (
    RECONCILIATION_OPEN,
    RECONCILIATION_MATCHED,
    RECONCILIATION_EXCEPTIONS,
    RECONCILIATION_RESOLVED,
)

EXCEPTION_MISSING_IN_MBOM = "missing_in_mbom"
EXCEPTION_UNEXPECTED_IN_MBOM = "unexpected_in_mbom"
EXCEPTION_QUANTITY_MISMATCH = "quantity_mismatch"
EXCEPTION_UNIT_MISMATCH = "unit_mismatch"
EXCEPTION_MULTIPLE_MAPPINGS = "multiple_mappings"
EXCEPTION_REVISION_MISMATCH = "revision_mismatch"

EXCEPTION_TYPES: tuple[str, ...] = (
    EXCEPTION_MISSING_IN_MBOM,
    EXCEPTION_UNEXPECTED_IN_MBOM,
    EXCEPTION_QUANTITY_MISMATCH,
    EXCEPTION_UNIT_MISMATCH,
    EXCEPTION_MULTIPLE_MAPPINGS,
    EXCEPTION_REVISION_MISMATCH,
)

# --- Intelligence ---------------------------------------------------------
# Similarity is advisory only. Exact identity (same normalised key) is an
# exact duplicate; everything else is a heuristic candidate with a reason.
DUPLICATE_EXACT = "exact"
DUPLICATE_SIMILAR = "similar"

DEFAULT_UNIT_OF_MEASURE = "EA"

# Safe recursion limits for multi-level expansion and comparison.
MAX_BOM_DEPTH = 20
MAX_BOM_LINES = 5_000
MAX_COMPARE_LINES = 10_000
MAX_INTELLIGENCE_ROWS = 2_000

# Attribute keys used by the heuristic duplicate/similarity scan.
SIMILARITY_ATTRIBUTE_KEYS: tuple[str, ...] = (
    "description",
    "material",
    "manufacturer_part_number",
)


def normalise_key(value: str) -> str:
    """Stable, case/space-insensitive identity key for product-domain records."""

    return " ".join(str(value or "").split()).strip().lower()


def normalise_item_key(value: str) -> str:
    """Item numbers are compared without surrounding/interior whitespace."""

    return " ".join(str(value or "").split()).strip().upper()


def normalise_revision(value: str) -> str:
    return str(value or "").strip().upper()


def is_transition_allowed(
    transitions: dict[str, tuple[str, ...]], current: str, target: str
) -> bool:
    if current == target:
        return True
    return target in transitions.get(current, ())


@dataclass(frozen=True, slots=True)
class BomLineIdentity:
    """Stable identity of a BOM line across reorderings.

    A line is identified by the component it references plus its position in
    the *conceptual* structure (parent + find number/line key), never by its
    array index. Comparison therefore treats reordered lines as the same line.
    """

    parent_revision_id: int
    child_item_id: int
    line_key: str
