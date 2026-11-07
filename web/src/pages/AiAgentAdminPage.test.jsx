import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../aiApi.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    ai: {
      agents: vi.fn(),
      agentTools: vi.fn(),
      agentExecutions: vi.fn(),
      agentApprovals: vi.fn(),
      agent: vi.fn(),
      agentVersions: vi.fn(),
      agentVersionTools: vi.fn(),
      agentTemplates: vi.fn(),
      agentSchedules: vi.fn(),
      agentMemory: vi.fn(),
      agentMonitoringOverview: vi.fn(),
      agentExecutionDelegations: vi.fn(),
      activateAgent: vi.fn(),
      deactivateAgent: vi.fn(),
      suspendAgent: vi.fn(),
      duplicateAgent: vi.fn(),
      deleteAgent: vi.fn(),
      instantiateAgentTemplate: vi.fn(),
      createAgentSchedule: vi.fn(),
      updateAgentSchedule: vi.fn(),
      deleteAgentSchedule: vi.fn(),
      writeAgentMemory: vi.fn(),
      deleteAgentMemory: vi.fn(),
    },
  };
});

import { ai } from "../aiApi.js";
import AiAgentAdminPage from "./AiAgentAdminPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AiAgentAdminPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ai.agents.mockResolvedValue([
    {
      id: 1,
      code: "knowledge-assistant",
      name: "Knowledge Assistant",
      lifecycle_status: "published",
      current_version_id: 4,
      owner: "platform",
    },
  ]);
  ai.agentTools.mockResolvedValue([
    {
      id: 2,
      code: "knowledge.search",
      name: "Knowledge search",
      lifecycle_status: "published",
      current_version_id: 7,
      enabled: true,
    },
  ]);
  ai.agentExecutions.mockResolvedValue({ items: [], total: 0 });
  ai.agentApprovals.mockResolvedValue({ items: [], total: 0 });
  ai.agentTemplates.mockResolvedValue([
    {
      id: 9,
      code: "research-agent",
      name: "Research agent",
      category: "research",
      use_case: "Multi-step research with citations",
    },
  ]);
  ai.agentSchedules.mockResolvedValue({ items: [], total: 0 });
  ai.agentMemory.mockResolvedValue({ items: [], total: 0 });
  ai.agentMonitoringOverview.mockResolvedValue({
    agents_total: 1,
    generated_at: "2026-01-01T00:00:00Z",
    executions: {
      total: 2,
      succeeded: 1,
      failed: 1,
      active: 0,
      waiting_approval: 0,
      avg_latency_ms: 120,
    },
    recent: [],
  });
});

describe("AiAgentAdminPage", () => {
  it("shows registry, tool registry, execution monitor and approval inbox", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(
      screen.getByRole("heading", { name: "Agent platform" })
    ).toBeInTheDocument();
    expect(await screen.findByText("knowledge-assistant")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tools" }));
    expect(await screen.findByText("knowledge.search")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Executions" }));
    expect(
      await screen.findByRole("heading", { name: "Executions" })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approvals" }));
    expect(screen.getByText("Approval inbox")).toBeInTheDocument();
    expect(
      screen.getByText(/Approvals bind the exact agent version/)
    ).toBeInTheDocument();
  });

  it("shows templates, schedules, memory and monitoring tabs", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Templates" }));
    expect(await screen.findByText("research-agent")).toBeInTheDocument();
    expect(
      screen.getByText(/Templates instantiate a normal draft agent/)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Schedules" }));
    expect(await screen.findByText("New schedule")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Memory" }));
    expect(await screen.findByText("Write memory")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Monitoring" }));
    expect(await screen.findByText("Monitoring overview")).toBeInTheDocument();
    expect(screen.getByText(/Agents: 1/)).toBeInTheDocument();
  });
});
