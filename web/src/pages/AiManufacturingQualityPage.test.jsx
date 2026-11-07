import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../aiApi.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    ai: {
      manufacturingStats: vi.fn(),
      manufacturingPlants: vi.fn(),
      manufacturingProcesses: vi.fn(),
      manufacturingProcessStructure: vi.fn(),
      manufacturingProcessValidate: vi.fn(),
      manufacturingOperations: vi.fn(),
      qualityStats: vi.fn(),
      qualityIssues: vi.fn(),
      qualityIssueTraceability: vi.fn(),
      qualityInspections: vi.fn(),
      qualityActions: vi.fn(),
      qualitySupplierQuality: vi.fn(),
      qualityRepeatIssues: vi.fn(),
      qualityAnalytics: vi.fn(),
      qualityImpact: vi.fn(),
    },
  };
});

import { ai } from "../aiApi.js";
import AiManufacturingQualityPage from "./AiManufacturingQualityPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AiManufacturingQualityPage />
    </MemoryRouter>,
  );
}

const PLANT = {
  id: 5,
  plant_key: "plant-1",
  name: "Main plant",
  site_code: "SITE-1",
  country: "US",
  lifecycle_status: "active",
};

const PROCESS = {
  id: 7,
  process_type: "manufacturing",
  process_key: "proc-1",
  name: "Assembly",
  lifecycle_status: "released",
  plant_id: 5,
  graph_entity_id: 71,
};

const ISSUE = {
  id: 9,
  issue_key: "qi-1",
  issue_type: "nonconformance",
  severity: "high",
  status: "open",
};

beforeEach(() => {
  vi.clearAllMocks();
  ai.manufacturingStats.mockResolvedValue({
    plants: 2,
    production_lines: 3,
    work_centres: 4,
    processes: 5,
    operations: 6,
    work_instructions: 7,
    resources: 8,
    production_versions: 9,
    operations_without_instructions: 1,
  });
  ai.qualityStats.mockResolvedValue({
    issues: 4,
    open_issues: 2,
    critical_issues: 1,
    inspections: 3,
    failed_inspections: 1,
    actions: 5,
    overdue_actions: 1,
    effective_actions: 2,
    supplier_issues: 1,
  });
  ai.manufacturingPlants.mockResolvedValue({
    items: [PLANT],
    total: 1,
    limit: 50,
    offset: 0,
  });
  ai.manufacturingProcesses.mockResolvedValue({
    items: [PROCESS],
    total: 1,
    limit: 50,
    offset: 0,
  });
  ai.manufacturingProcessStructure.mockResolvedValue({
    process: PROCESS,
    operations: [
      {
        operation_id: 31,
        operation_key: "op-10",
        name: "Bolt",
        operation_type: "value_add",
        sequence: 10,
        work_centre_id: 4,
        plant_id: 5,
        depth: 0,
        path: [31],
        instruction_count: 1,
        consumption_count: 2,
        depends_on: [],
        has_instruction: true,
      },
    ],
    total: 1,
    truncated: false,
    cycle_detected: false,
  });
  ai.manufacturingProcessValidate.mockResolvedValue({
    process_id: 7,
    status: "warning",
    score: 0.9,
    checks: [
      {
        rule: "missing_instruction",
        severity: "warning",
        operation_id: 31,
        message: "Operation has no work instruction",
        detail: {},
      },
    ],
    summary: { errors: 0, warnings: 1 },
  });
  ai.manufacturingOperations.mockResolvedValue({
    items: [
      {
        id: 31,
        process_id: 7,
        operation_key: "op-10",
        name: "Bolt",
        operation_type: "value_add",
        sequence: 10,
        work_centre_id: 4,
        plant_id: 5,
        lifecycle_status: "released",
      },
    ],
    total: 1,
    limit: 100,
    offset: 0,
  });
  ai.qualityIssues.mockResolvedValue({
    items: [ISSUE],
    total: 1,
    limit: 50,
    offset: 0,
  });
  ai.qualityIssueTraceability.mockResolvedValue({
    issue: ISSUE,
    product: { key: "pn-100" },
    component: null,
    process: { key: "proc-1" },
    operation: null,
    plant: { key: "plant-1" },
    work_centre: null,
    work_instructions: [],
    root_causes: [],
    actions: [],
    inspections: [],
    status: "ok",
  });
  ai.qualityInspections.mockResolvedValue({
    items: [
      {
        id: 41,
        inspection_key: "insp-1",
        inspection_type: "incoming",
        status: "passed",
        sample_size: 10,
        passed_count: 10,
        failed_count: 0,
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  });
  ai.qualityActions.mockResolvedValue({
    items: [
      {
        id: 51,
        quality_issue_id: 9,
        action_key: "capa-1",
        action_type: "corrective",
        status: "open",
        effectiveness: "pending",
        owner_user: "alice",
        due_at: null,
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  });
  ai.qualitySupplierQuality.mockResolvedValue({
    rows: [
      {
        supplier_ref: "acme",
        supplier_name: "Acme",
        issue_count: 2,
        defect_count: 3,
        affected_components: 1,
        open_issues: 1,
      },
    ],
    total: 1,
    truncated: false,
  });
  ai.qualityAnalytics.mockResolvedValue({
    kind: "issues_by_product",
    rows: [
      { key: "pn-100", label: "Bracket", count: 3, severity: "high" },
    ],
    total: 1,
    truncated: false,
    summary: {},
    unavailable: [],
  });
  ai.qualityRepeatIssues.mockResolvedValue({
    groups: [
      {
        signature: "pn-100|surface",
        occurrences: 3,
        issue_ids: [1, 2, 3],
        issue_keys: ["qi-1", "qi-2", "qi-3"],
        component_item_id: 11,
        failure_code: "surface",
        reason: "repeated failure",
      },
    ],
    total: 1,
    truncated: false,
    window_days: 90,
  });
  ai.qualityImpact.mockResolvedValue({
    entity_id: 71,
    subject: {},
    affected: [
      {
        entity_id: 88,
        entity_type: "quality_issue",
        stable_key: "QI:qi-1",
        name: "qi-1",
        impact: "affected",
        confidence: 0.8,
        reason: "linked operation",
        source_ref: null,
        detail: {},
      },
    ],
    paths: [],
    inferred: false,
    truncated: false,
  });
});

describe("AiManufacturingQualityPage", () => {
  it("renders overview stats across manufacturing and quality", async () => {
    renderPage();
    expect(
      screen.getByRole("heading", { name: "Manufacturing & quality intelligence" }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Plants: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Issues: 4/)).toBeInTheDocument();
    expect(ai.manufacturingStats).toHaveBeenCalled();
    expect(ai.qualityStats).toHaveBeenCalled();
  });

  it("lists plants", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Plants" }));
    expect(await screen.findByText("plant-1")).toBeInTheDocument();
    expect(ai.manufacturingPlants).toHaveBeenCalledWith({ limit: 50 });
  });

  it("expands and validates a process", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Processes" }));
    await user.click(await screen.findByRole("button", { name: "proc-1" }));
    await user.click(screen.getByRole("button", { name: "Expand" }));
    expect(await screen.findByText("op-10")).toBeInTheDocument();
    expect(ai.manufacturingProcessStructure).toHaveBeenCalledWith(7, {
      max_depth: 5,
      limit: 500,
    });
    await user.click(screen.getByRole("button", { name: "Validate" }));
    expect(
      await screen.findByText("Operation has no work instruction"),
    ).toBeInTheDocument();
    expect(ai.manufacturingProcessValidate).toHaveBeenCalledWith(7);
  });

  it("traces a quality issue", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Quality issues" }));
    await user.click(await screen.findByRole("button", { name: "qi-1" }));
    await user.click(screen.getByRole("button", { name: "Trace" }));
    expect(await screen.findByText(/Product: pn-100/)).toBeInTheDocument();
    expect(ai.qualityIssueTraceability).toHaveBeenCalledWith(9);
  });

  it("loads inspections, actions and supplier quality", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Inspections" }));
    expect(await screen.findByText("insp-1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(await screen.findByText("capa-1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Suppliers" }));
    expect(await screen.findByText("Acme")).toBeInTheDocument();
  });

  it("loads analytics and repeat nonconformances", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Analytics" }));
    await user.click(screen.getByRole("button", { name: "Load" }));
    expect(await screen.findByText("Bracket")).toBeInTheDocument();
    expect(await screen.findByText("pn-100|surface")).toBeInTheDocument();
    expect(ai.qualityAnalytics).toHaveBeenCalledWith("issues_by_product");
    expect(ai.qualityRepeatIssues).toHaveBeenCalledWith({ window_days: 90 });
  });

  it("runs quality impact analysis", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Impact" }));
    await user.type(screen.getByPlaceholderText("Graph entity id"), "71");
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(await screen.findByText("QI:qi-1")).toBeInTheDocument();
    expect(ai.qualityImpact).toHaveBeenCalledWith({ entity_id: 71, max_depth: 3 });
  });

  it("surfaces API errors", async () => {
    ai.manufacturingPlants.mockRejectedValueOnce(
      new Error("nope"),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Plants" }));
    expect(await screen.findByText("nope")).toBeInTheDocument();
  });
});
