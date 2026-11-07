import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../aiApi.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    ai: {
      sources: vi.fn(),
      createSource: vi.fn(),
      deleteSource: vi.fn(),
      documents: vi.fn(),
      ingest: vi.fn(),
      uploadDocument: vi.fn(),
      reindexSource: vi.fn(),
      reindexDocument: vi.fn(),
      document: vi.fn(),
      updateDocument: vi.fn(),
      documentVersions: vi.fn(),
      deleteDocument: vi.fn(),
      downloadDocument: vi.fn(),
    },
    downloadDocument: vi.fn(),
  };
});

import { ai } from "../aiApi.js";
import AiKnowledgePage from "./AiKnowledgePage.jsx";

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AiKnowledgePage />
    </MemoryRouter>,
  );
}

const source = {
  id: 3,
  code: "ops",
  name: "Operations",
  kind: "manual",
  classification: "internal",
  status: "ready",
};

const documentRow = {
  id: 11,
  source_id: 3,
  external_id: "pump",
  title: "Pump Manual",
  status: "indexed",
  classification: "internal",
  size_bytes: 120,
  version: 2,
  metadata: { product: "P-100" },
  search_indexed_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  ai.sources.mockResolvedValue({ items: [source], meta: { total: 1 } });
  ai.documents.mockResolvedValue({ items: [documentRow], meta: { total: 1 } });
  ai.documentVersions.mockResolvedValue({ items: [], meta: { total: 0 } });
});

describe("AiKnowledgePage document management", () => {
  it("shows document version and lets an admin save metadata", async () => {
    const user = userEvent.setup();
    ai.updateDocument.mockResolvedValue({
      ...documentRow,
      version: 3,
      metadata: { product: "P-200" },
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "ops" }));
    const row = await screen.findByText("Pump Manual");
    expect(row).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage" }));
    const titleInput = await screen.findByDisplayValue("Pump Manual");
    await user.clear(titleInput);
    await user.type(titleInput, "Pump Manual Rev B");
    const metadataBox = screen.getByDisplayValue(/"product": "P-100"/);
    await user.clear(metadataBox);
    await user.type(metadataBox, '{{"product": "P-200"}');
    await user.click(screen.getByRole("button", { name: "Save metadata" }));

    expect(ai.updateDocument).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        title: "Pump Manual Rev B",
        metadata: { product: "P-200" },
        expected_version: 2,
      }),
    );
    expect(await screen.findByText(/version 3/i)).toBeInTheDocument();
  });

  it("rejects invalid metadata JSON before calling the API", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "ops" }));
    await user.click(await screen.findByRole("button", { name: "Manage" }));
    const metadataBox = await screen.findByDisplayValue(/"product": "P-100"/);
    await user.clear(metadataBox);
    await user.type(metadataBox, "not-json");
    await user.click(screen.getByRole("button", { name: "Save metadata" }));

    expect(ai.updateDocument).not.toHaveBeenCalled();
    expect(screen.getByText(/Invalid metadata JSON/i)).toBeInTheDocument();
  });

  it("renders version history for the selected document", async () => {
    const user = userEvent.setup();
    ai.documentVersions.mockResolvedValue({
      items: [
        {
          document_id: 11,
          source_id: 3,
          external_id: "pump",
          version: 1,
          title: "Pump Manual",
          classification: "internal",
          status: "indexed",
          reason: "superseded",
          superseded_at: "2026-01-02T00:00:00Z",
        },
      ],
      meta: { total: 1 },
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "ops" }));
    await user.click(await screen.findByRole("button", { name: "Manage" }));

    const heading = await screen.findByRole("heading", { name: "Version history" });
    const section = heading.closest(".panel");
    expect(within(section).getByText("v1")).toBeInTheDocument();
    expect(within(section).getByText("superseded")).toBeInTheDocument();
  });

  it("reindexes a single document from the row action", async () => {
    const user = userEvent.setup();
    ai.reindexDocument.mockResolvedValue({ document_id: 11, documents: 1 });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "ops" }));
    await user.click(await screen.findByRole("button", { name: "Reindex" }));

    expect(ai.reindexDocument).toHaveBeenCalledWith(11);
    expect(await screen.findByText(/Reindexed "Pump Manual"/i)).toBeInTheDocument();
  });
});
