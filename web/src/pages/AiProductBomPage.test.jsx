import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../aiApi.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    ai: {
      productStats: vi.fn(),
      productItems: vi.fn(),
      productItem: vi.fn(),
      productRevisions: vi.fn(),
      boms: vi.fn(),
      bomStructure: vi.fn(),
      bomCompare: vi.fn(),
      bomQuality: vi.fn(),
      productReuse: vi.fn(),
      productDuplicates: vi.fn(),
      bomWhereUsed: vi.fn(),
      bomChangeImpact: vi.fn(),
    },
  };
});

import { ai } from "../aiApi.js";
import AiProductBomPage from "./AiProductBomPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AiProductBomPage />
    </MemoryRouter>,
  );
}

const ITEM = {
  id: 11,
  item_type: "part",
  item_key: "pn-100",
  name: "Bracket",
  unit_of_measure: "EA",
  lifecycle_status: "active",
  classification: "internal",
  graph_entity_id: 41,
};

const BOM = {
  id: 21,
  bom_type: "EBOM",
  bom_key: "ebom-1",
  name: "Engineering BOM",
  root_item_id: 11,
  root_revision_id: 31,
  lifecycle_status: "draft",
  graph_entity_id: 51,
};

beforeEach(() => {
  vi.clearAllMocks();
  ai.productStats.mockResolvedValue({
    items: 3,
    products: 1,
    parts: 2,
    assemblies: 0,
    revisions: 2,
    eboms: 1,
    mboms: 0,
    bom_lines: 4,
    orphan_parts: 0,
    obsolete_items: 0,
    status: "ok",
  });
  ai.productItems.mockResolvedValue({ items: [ITEM], total: 1, limit: 25, offset: 0 });
  ai.productItem.mockResolvedValue(ITEM);
  ai.productRevisions.mockResolvedValue([
    { id: 31, item_id: 11, revision: "A", lifecycle_status: "draft", version: 1 },
  ]);
  ai.boms.mockResolvedValue({ items: [BOM], total: 1, limit: 25, offset: 0 });
  ai.bomStructure.mockResolvedValue({
    header: BOM,
    root_item: ITEM,
    rows: [
      {
        line_id: 1,
        line_key: "l1",
        child_item_id: 12,
        child_item_key: "pn-200",
        child_name: "Screw",
        quantity: 2,
        cumulative_quantity: 2,
        depth: 1,
        find_number: "10",
        is_reference: false,
      },
    ],
    total: 1,
    max_depth_reached: 1,
    truncated: false,
    cycle_detected: false,
    cycles: [],
  });
  ai.bomCompare.mockResolvedValue({
    left_header_id: 21,
    right_header_id: 22,
    scope: "line",
    summary: { added: 1, removed: 0, modified: 0, moved: 0, unchanged: 2, total: 3 },
    diffs: [
      {
        change_type: "added",
        line_key: "l2",
        child_item_id: 13,
        changes: [],
      },
    ],
    truncated: false,
  });
  ai.bomQuality.mockResolvedValue({
    header_id: 21,
    status: "warning",
    score: 0.95,
    issues: [
      { rule: "missing_uom", severity: "warning", message: "Missing unit of measure" },
    ],
    summary: { errors: 0, warnings: 1, total: 1 },
    truncated: false,
  });
  ai.productReuse.mockResolvedValue({
    kind: "reuse",
    rows: [
      { item_id: 12, item_key: "pn-200", name: "Screw", kind: "reuse", occurrences: 5, score: 5, reason: "used in 2 BOM(s)" },
    ],
    total: 1,
    truncated: false,
    summary: { items: 1 },
  });
  ai.productDuplicates.mockResolvedValue({
    kind: "duplicates",
    rows: [
      { item_id: 12, item_key: "pn-200", name: "Screw", kind: "similar", occurrences: 0, score: 0.4, reason: "same description" },
    ],
    total: 1,
    truncated: false,
    summary: { exact: 0, similar: 1 },
  });
  ai.bomWhereUsed.mockResolvedValue({
    kind: "where_used",
    rows: [
      { item_id: 11, item_key: "pn-100", name: "Bracket", kind: "where_used", occurrences: 1, score: 0, reason: "direct BOM line" },
    ],
    total: 1,
    truncated: false,
    summary: { item_id: 11 },
  });
  ai.bomChangeImpact.mockResolvedValue({
    change_entity_id: 50,
    affected_items: [
      { item_id: 11, item_key: "pn-100", name: "Bracket", kind: "direct", score: 0.8, reason: "direct impact via graph", occurrences: 0 },
    ],
    affected_boms: [],
    inferred: false,
    paths: [],
    truncated: false,
  });
});

describe("AiProductBomPage", () => {
  it("renders stats and the item catalog", async () => {
    renderPage();
    expect(
      screen.getByRole("heading", { name: "Product & BOM intelligence" })
    ).toBeInTheDocument();
    expect(await screen.findByText("pn-100")).toBeInTheDocument();
    expect(screen.getByText("Items (1)")).toBeInTheDocument();
    expect(ai.productStats).toHaveBeenCalled();
  });

  it("opens an item and shows revisions", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "pn-100" }));
    expect(await screen.findByText("Revisions")).toBeInTheDocument();
    expect(ai.productRevisions).toHaveBeenCalledWith({ item_id: 11, limit: 50 });
  });

  it("expands BOM structure", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "BOMs" }));
    await user.click(await screen.findByRole("button", { name: "ebom-1" }));
    await user.click(screen.getByRole("button", { name: "Structure" }));
    await user.click(screen.getByRole("button", { name: "Expand" }));
    expect(await screen.findByText("pn-200")).toBeInTheDocument();
    expect(ai.bomStructure).toHaveBeenCalledWith(21, {
      max_depth: 5,
      limit: 500,
      direction: "down",
    });
  });

  it("compares two BOMs", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Compare" }));
    await user.type(screen.getByPlaceholderText("Left BOM id"), "21");
    await user.type(screen.getByPlaceholderText("Right BOM id"), "22");
    await user.click(screen.getByRole("button", { name: "Run comparison" }));
    expect(await screen.findByText("l2")).toBeInTheDocument();
    expect(ai.bomCompare).toHaveBeenCalledWith({
      left_header_id: 21,
      right_header_id: 22,
    });
  });

  it("loads reuse and duplicates", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Intelligence" }));
    const [reuseBtn] = screen.getAllByRole("button", { name: "Load" });
    await user.click(reuseBtn);
    expect(await screen.findByText("used in 2 BOM(s)")).toBeInTheDocument();
    const dupBtn = screen.getAllByRole("button", { name: "Load" })[1];
    await user.click(dupBtn);
    expect(await screen.findByText("same description")).toBeInTheDocument();
    expect(ai.productReuse).toHaveBeenCalled();
    expect(ai.productDuplicates).toHaveBeenCalled();
  });

  it("runs a quality check and change impact", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "BOMs" }));
    await user.click(await screen.findByRole("button", { name: "ebom-1" }));
    await user.click(screen.getByRole("button", { name: "Quality" }));
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Missing unit of measure")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change impact" }));
    await user.type(screen.getByPlaceholderText("Change entity id"), "50");
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(ai.bomChangeImpact).toHaveBeenCalledWith({
      change_entity_id: 50,
      max_depth: 3,
    });
  });
});
