import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../aiApi.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    ai: {
      search: vi.fn(),
      searchFacets: vi.fn(),
      searchSuggestions: vi.fn(),
      searchHealth: vi.fn(),
      savedSearches: vi.fn(),
      createSavedSearch: vi.fn(),
      deleteSavedSearch: vi.fn(),
      duplicates: vi.fn(),
      scanDuplicates: vi.fn(),
      reviewDuplicate: vi.fn(),
    },
  };
});

vi.mock("../api.js", () => ({
  search: { global: vi.fn() },
}));

import { ai } from "../aiApi.js";
import { search as helixSearch } from "../api.js";
import AiSearchPage from "./AiSearchPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AiSearchPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ai.searchHealth.mockResolvedValue({
    status: "ok",
    tenant_id: 1,
    search_backend: "postgres",
    hybrid_search: true,
    documents: { total: 3, indexed: 3, pending: 0, stale: 0, missing: 0, failed: 0 },
    chunks_total: 6,
    embeddings_total: 6,
    jobs: {},
    last_indexed_at: null,
  });
  ai.savedSearches.mockResolvedValue({ items: [] });
  ai.duplicates.mockResolvedValue({ items: [] });
  ai.searchSuggestions.mockResolvedValue({ suggestions: [] });
  ai.searchFacets.mockResolvedValue({ facets: [] });
  helixSearch.global.mockResolvedValue({ total: 0, items: [] });
});

describe("AiSearchPage", () => {
  it("shows index health and the two independent result groups", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(
      screen.getByRole("heading", { name: "AI search & knowledge intelligence" })
    ).toBeInTheDocument();
    expect(await screen.findByText("Index health")).toBeInTheDocument();
    expect(screen.getByText("AI knowledge")).toBeInTheDocument();
    expect(screen.getByText("Helix enterprise search")).toBeInTheDocument();
    expect(screen.getByText(/scores are not comparable/i)).toBeInTheDocument();

    ai.search.mockResolvedValue({
      query: "pump",
      count: 1,
      total: 1,
      mode: "hybrid",
      requested_mode: "hybrid",
      fallback: false,
      page: 1,
      limit: 10,
      sort: "relevance",
      filters: [],
      results: [
        {
          chunk_id: 1,
          document_id: 10,
          source_id: 2,
          source_code: "MANUAL",
          chunk_index: 0,
          score: 0.5,
          classification: "internal",
          content: "Lubricate the pump.",
          title: "Pump maintenance",
          external_id: "DOC-1",
          document_status: "indexed",
          document_updated_at: "2026-10-01T00:00:00+00:00",
          hit_count: 1,
        },
      ],
    });
    helixSearch.global.mockResolvedValue({
      total: 1,
      items: [
        {
          object_type: "content",
          object_id: "c1",
          code: "CT-1",
          title: "Pump record",
          status: "released",
          classification: "internal",
          score: 9,
          summary: "Enterprise record",
        },
      ],
    });

    await user.type(screen.getByLabelText("Search query"), "pump");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Pump maintenance")).toBeInTheDocument();
    expect(screen.getByText("Pump record")).toBeInTheDocument();
    expect(screen.getByText("AI score 0.500")).toBeInTheDocument();
    expect(screen.getByText("Helix score 9.0")).toBeInTheDocument();
  });
});
