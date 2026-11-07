import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DashboardPage from "./DashboardPage";

function mockFetchOk(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => payload,
    })),
  );
}

describe("DashboardPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders platform status returned by the API", async () => {
    mockFetchOk({
      status: "ok",
      service: "ai-api",
      version: "0.1.0",
      environment: "test",
      components: { api: "ok", database: "ok" },
    });

    render(<DashboardPage />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(await screen.findByText("ai-api")).toBeInTheDocument();
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
  });

  it("shows an error when the API is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    render(<DashboardPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("AI API unavailable");
  });
});
