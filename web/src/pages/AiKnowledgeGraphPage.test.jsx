import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../aiApi.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    ai: {
      graphTypes: vi.fn(),
      graphStats: vi.fn(),
      graphEntities: vi.fn(),
      graphEntity: vi.fn(),
      graphEntityVersions: vi.fn(),
      graphNeighborhood: vi.fn(),
      graphTraverse: vi.fn(),
      graphDigitalThread: vi.fn(),
      graphWhereUsed: vi.fn(),
      graphChangeImpact: vi.fn(),
      graphTraceability: vi.fn(),
      deleteGraphEntity: vi.fn(),
    },
  };
});

import { ai } from "../aiApi.js";
import AiKnowledgeGraphPage from "./AiKnowledgeGraphPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AiKnowledgeGraphPage />
    </MemoryRouter>,
  );
}

const ENTITY = {
  id: 41,
  entity_type: "part",
  stable_key: "pn-100",
  name: "Bracket",
  lifecycle_status: "active",
  classification: "internal",
  confidence: 0.9,
  version: 2,
  source_system: "plm",
  updated_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  ai.graphStats.mockResolvedValue({
    entities: 8,
    relationships: 7,
    stale_entities: 0,
    last_entity_update: "2026-01-01T00:00:00Z",
  });
  ai.graphTypes.mockResolvedValue({
    entity_types: [
      { code: "product", name: "Product", category: "commercial", builtin: true },
      { code: "part", name: "Part", category: "engineering", builtin: true },
    ],
    relationship_types: [
      {
        code: "contains",
        name: "CONTAINS",
        source_types: ["product"],
        target_types: ["part"],
        builtin: true,
      },
    ],
  });
  ai.graphEntities.mockResolvedValue({ items: [ENTITY], total: 1 });
  ai.graphEntity.mockResolvedValue(ENTITY);
  ai.graphEntityVersions.mockResolvedValue([
    { id: 1, version: 2, change_reason: "upsert", created_by: "tester", created_at: "2026-01-01T00:00:00Z" },
    { id: 2, version: 1, change_reason: "upsert", created_by: "tester", created_at: "2026-01-01T00:00:00Z" },
  ]);
  ai.graphNeighborhood.mockResolvedValue({
    root: ENTITY,
    neighbors: [
      {
        relationship: { id: 5, relationship_type: "contains" },
        entity: { id: 42, entity_type: "product", stable_key: "prod-1", name: "Widget" },
        direction: "incoming",
        depth: 1,
      },
    ],
    truncated: false,
  });
  ai.graphTraverse.mockResolvedValue({
    root: ENTITY,
    nodes: [],
    relationships: [],
    paths: [],
    depth_reached: 2,
    truncated: false,
  });
  ai.graphDigitalThread.mockResolvedValue({
    product: { ...ENTITY, id: 42, entity_type: "product", stable_key: "prod-1", name: "Widget" },
    sections: {
      parts: [{ id: 41, entity_type: "part", stable_key: "pn-100", name: "Bracket" }],
      boms: [],
    },
    relationships: [],
    paths: [],
    truncated: false,
  });
  ai.graphWhereUsed.mockResolvedValue({
    part: ENTITY,
    used_by: [
      {
        entity: { id: 42, entity_type: "product", stable_key: "prod-1", name: "Widget" },
        depth: 1,
      },
    ],
    products: [],
    boms: [],
    truncated: false,
  });
  ai.graphChangeImpact.mockResolvedValue({
    change: { ...ENTITY, id: 50, entity_type: "engineering_change", stable_key: "ec-1" },
    affected: [
      {
        entity: ENTITY,
        impact: "direct",
        confidence: 0.8,
        depth: 1,
      },
    ],
    direct_count: 1,
    indirect_count: 0,
    truncated: false,
    inferred: true,
  });
  ai.graphTraceability.mockResolvedValue({
    root: ENTITY,
    links: [
      {
        source: ENTITY,
        target: { id: 42, entity_type: "product", stable_key: "prod-1" },
        relationship_type: "contains",
        inferred: false,
        confidence: 1,
      },
    ],
    orphaned: [],
    truncated: false,
  });
});

describe("AiKnowledgeGraphPage", () => {
  it("renders stats and the entity catalog", async () => {
    renderPage();
    expect(
      screen.getByRole("heading", { name: "Knowledge graph & digital thread" })
    ).toBeInTheDocument();
    expect(await screen.findByText("pn-100")).toBeInTheDocument();
    expect(screen.getByText("Entities (1)")).toBeInTheDocument();
    expect(ai.graphStats).toHaveBeenCalled();
  });

  it("opens an entity and shows neighbors and versions", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "pn-100" }));
    expect(await screen.findByText("Neighbors")).toBeInTheDocument();
    expect(await screen.findByText("prod-1")).toBeInTheDocument();
    expect(screen.getByText("Versions")).toBeInTheDocument();
    expect(ai.graphNeighborhood).toHaveBeenCalledWith(41, {
      direction: "both",
      limit: 50,
    });
  });

  it("loads a digital thread", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Digital thread" }));
    await user.type(screen.getByPlaceholderText("Product entity ID"), "42");
    await user.click(screen.getByRole("button", { name: "Load thread" }));
    expect(await screen.findByText("Widget")).toBeInTheDocument();
    expect(ai.graphDigitalThread).toHaveBeenCalledWith(42);
  });

  it("runs where-used analysis", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Where-used" }));
    await user.type(screen.getByPlaceholderText("Part entity ID"), "41");
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(await screen.findByText("prod-1")).toBeInTheDocument();
    expect(ai.graphWhereUsed).toHaveBeenCalledWith(41, { max_depth: 3 });
  });

  it("shows inferred change impact", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Change impact" }));
    await user.type(screen.getByPlaceholderText("Change entity ID"), "50");
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(await screen.findByText("Includes inferred impact")).toBeInTheDocument();
    expect(ai.graphChangeImpact).toHaveBeenCalledWith(50, { max_depth: 3 });
  });

  it("renders traceability links and type catalog", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Traceability" }));
    await user.type(screen.getByPlaceholderText("Entity ID"), "41");
    await user.click(screen.getByRole("button", { name: "Trace" }));
    expect(await screen.findByText("contains")).toBeInTheDocument();
    expect(ai.graphTraceability).toHaveBeenCalledWith(41, { max_depth: 4 });

    await user.click(screen.getByRole("button", { name: "Types" }));
    expect(await screen.findByText("Entity types")).toBeInTheDocument();
    expect(screen.getByText("Relationship types")).toBeInTheDocument();
  });
});
