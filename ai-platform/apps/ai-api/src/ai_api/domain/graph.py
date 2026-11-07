"""Knowledge graph type catalog (Stage 7).

The catalog is data, not behaviour: entity and relationship types are declared
once here and consumed by the ingestion, validation and traversal services. A
tenant can extend or override entries through the registry API; the built-in
entries below are the platform defaults used to seed a tenant on demand.

Keeping the catalog out of the API routes is deliberate — routes only adapt HTTP
to the services, so a new entity/relationship type never requires touching a
handler.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class EntityTypeSpec:
    code: str
    name: str
    category: str
    description: str = ""
    property_schema: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RelationshipTypeSpec:
    code: str
    name: str
    description: str
    # Empty tuples mean "any entity type".
    source_types: tuple[str, ...] = ()
    target_types: tuple[str, ...] = ()
    directed: bool = True
    property_schema: dict[str, Any] = field(default_factory=dict)


# --- Built-in entity types ------------------------------------------------
ENTITY_TYPES: tuple[EntityTypeSpec, ...] = (
    EntityTypeSpec("product", "Product", "commercial", "A saleable product or platform."),
    EntityTypeSpec("part", "Part / Item / Material", "engineering", "A design or purchased item."),
    EntityTypeSpec("document", "Document", "content", "A controlled document or specification."),
    EntityTypeSpec("cad_model", "CAD Model", "engineering", "A 3D model or drawing artifact."),
    EntityTypeSpec("ebom", "Engineering BOM", "bom", "The engineering bill of materials."),
    EntityTypeSpec("mbom", "Manufacturing BOM", "bom", "The manufacturing bill of materials."),
    EntityTypeSpec("bom_line", "BOM Line", "bom", "A single line within a BOM structure."),
    EntityTypeSpec(
        "engineering_change", "Engineering Change", "change", "An approved change record."
    ),
    EntityTypeSpec("change_request", "Change Request", "change", "A request to change an item."),
    EntityTypeSpec("release", "Release", "lifecycle", "A released configuration or revision."),
    EntityTypeSpec("requirement", "Requirement", "requirements", "A stated requirement."),
    EntityTypeSpec("specification", "Specification", "requirements", "A specification document."),
    EntityTypeSpec(
        "design_decision", "Design Decision", "engineering", "A recorded design rationale."
    ),
    EntityTypeSpec(
        "manufacturing_process", "Manufacturing Process", "manufacturing", "A production process."
    ),
    EntityTypeSpec("operation", "Operation", "manufacturing", "A step within a process."),
    EntityTypeSpec(
        "work_instruction", "Work Instruction", "manufacturing", "Instructions for an operation."
    ),
    EntityTypeSpec("plant", "Plant", "manufacturing", "A manufacturing site."),
    EntityTypeSpec("work_center", "Work Center", "manufacturing", "A production resource."),
    EntityTypeSpec("supplier", "Supplier", "supply", "An external supplier."),
    EntityTypeSpec("quality_issue", "Quality Issue", "quality", "A quality problem."),
    EntityTypeSpec("nonconformance", "Nonconformance", "quality", "A nonconforming item."),
    EntityTypeSpec(
        "corrective_action", "Corrective Action", "quality", "A corrective action record."
    ),
    EntityTypeSpec(
        "prediction",
        "Prediction",
        "predictive",
        "An explainable risk prediction produced by a versioned strategy.",
    ),
    EntityTypeSpec(
        "recommendation",
        "Recommendation",
        "predictive",
        "A suggested action derived from a prediction and its evidence.",
    ),
)

ENTITY_TYPE_CODES: frozenset[str] = frozenset(spec.code for spec in ENTITY_TYPES)
ENTITY_TYPE_BY_CODE: dict[str, EntityTypeSpec] = {spec.code: spec for spec in ENTITY_TYPES}


# --- Built-in relationship types -----------------------------------------
RELATIONSHIP_TYPES: tuple[RelationshipTypeSpec, ...] = (
    RelationshipTypeSpec(
        "contains", "CONTAINS", "A product contains a part.", ("product",), ("part",)
    ),
    RelationshipTypeSpec(
        "has_cad_model", "HAS_CAD_MODEL", "A part has a CAD model.", ("part",), ("cad_model",)
    ),
    RelationshipTypeSpec(
        "has_bom", "HAS_BOM", "A product has an engineering BOM.", ("product",), ("ebom", "mbom")
    ),
    RelationshipTypeSpec(
        "has_line", "HAS_LINE", "A BOM has a line.", ("ebom", "mbom"), ("bom_line",)
    ),
    RelationshipTypeSpec(
        "maps_to", "MAPS_TO", "An EBOM line maps to an MBOM line.", ("bom_line",), ("bom_line",)
    ),
    RelationshipTypeSpec(
        "describes",
        "DESCRIBES",
        "A document describes an entity.",
        ("document", "specification"),
        ("part", "product", "cad_model"),
    ),
    RelationshipTypeSpec(
        "affects",
        "AFFECTS",
        "A change affects an entity.",
        ("engineering_change", "change_request"),
        ("part", "product", "ebom", "mbom", "bom_line", "document"),
    ),
    RelationshipTypeSpec(
        "results_in",
        "RESULTS_IN",
        "A change results in a release.",
        ("engineering_change", "change_request"),
        ("release",),
    ),
    RelationshipTypeSpec(
        "satisfied_by",
        "SATISFIED_BY",
        "A requirement is satisfied by a part.",
        ("requirement",),
        ("part",),
    ),
    RelationshipTypeSpec(
        "verified_by",
        "VERIFIED_BY",
        "A requirement is verified by a document.",
        ("requirement",),
        ("document",),
    ),
    RelationshipTypeSpec(
        "process_contains",
        "CONTAINS",
        "A manufacturing process contains an operation.",
        ("manufacturing_process",),
        ("operation",),
    ),
    RelationshipTypeSpec(
        "uses_instruction",
        "USES",
        "An operation uses a work instruction.",
        ("operation",),
        ("work_instruction",),
    ),
    RelationshipTypeSpec(
        "manufactured_at",
        "MANUFACTURED_AT",
        "A part is manufactured at a plant.",
        ("part",),
        ("plant",),
    ),
    RelationshipTypeSpec(
        "quality_affects",
        "AFFECTS",
        "A quality issue affects a part.",
        ("quality_issue",),
        ("part",),
    ),
    RelationshipTypeSpec(
        "resolves",
        "RESOLVES",
        "A corrective action resolves a quality issue.",
        ("corrective_action",),
        ("quality_issue",),
    ),
    RelationshipTypeSpec(
        "supplied_by",
        "SUPPLIED_BY",
        "A part is supplied by a supplier.",
        ("part",),
        ("supplier",),
    ),
    RelationshipTypeSpec(
        "derived_from",
        "DERIVED_FROM",
        "A requirement is derived from another.",
        ("requirement",),
        ("requirement",),
    ),
    RelationshipTypeSpec(
        "predicts",
        "PREDICTS",
        "A prediction concerns an assessed entity.",
        ("prediction",),
        (),
    ),
    RelationshipTypeSpec(
        "recommends_for",
        "RECOMMENDS_FOR",
        "A recommendation addresses an affected entity.",
        ("recommendation",),
        (),
    ),
    RelationshipTypeSpec(
        "derived_from_prediction",
        "DERIVED_FROM",
        "A recommendation is derived from a prediction.",
        ("recommendation",),
        ("prediction",),
    ),
    RelationshipTypeSpec(
        "references", "REFERENCES", "A generic, explicit cross-reference.", (), ()
    ),
)

RELATIONSHIP_TYPE_CODES: frozenset[str] = frozenset(
    spec.code for spec in RELATIONSHIP_TYPES
)
RELATIONSHIP_TYPE_BY_CODE: dict[str, RelationshipTypeSpec] = {
    spec.code: spec for spec in RELATIONSHIP_TYPES
}

# Entity types whose records are considered "confirmed facts" from a source
# system; traversal results still report confidence so inferred links are never
# presented as authoritative.
UNDIRECTED_CODES: frozenset[str] = frozenset(
    spec.code for spec in RELATIONSHIP_TYPES if not spec.directed
)
