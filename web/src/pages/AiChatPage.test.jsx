import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../aiApi.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    ai: {
      chat: vi.fn(),
      rag: vi.fn(),
      createFeedback: vi.fn(),
      conversations: vi.fn(),
      createConversation: vi.fn(),
      conversation: vi.fn(),
      deleteConversation: vi.fn(),
      sendAssistantMessage: vi.fn(),
      assistantFeedback: vi.fn(),
    },
    streamChat: vi.fn(),
  };
});

import { AiApiError, ai, streamChat } from "../aiApi.js";
import AiChatPage from "./AiChatPage.jsx";

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AiChatPage />
    </MemoryRouter>,
  );
}

const ragAnswer = {
  answer: "Grounded answer",
  confidence: 0.87,
  is_mock: true,
  citations: [
    {
      rank: 1,
      source_id: 1,
      source_code: "SRC-1",
      document_id: 7,
      chunk_id: 2,
      chunk_index: 0,
      score: 0.9123,
      snippet: "the relevant excerpt",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AiChatPage", () => {
  it("renders the copilot header and the empty chat state", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Enterprise Copilot" })).toBeInTheDocument();
    expect(screen.getByText(/Start a conversation/i)).toBeInTheDocument();
  });

  it("displays grounded answers with source citations", async () => {
    ai.rag.mockResolvedValue(ragAnswer);
    const user = userEvent.setup();
    const { container } = renderPage();

    await user.click(screen.getByRole("button", { name: "Knowledge (RAG)" }));
    await user.type(screen.getByPlaceholderText(/Ask about your knowledge/i), "what is X?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("Grounded answer");
    expect(screen.getByText(/SRC-1 · document 7/)).toBeInTheDocument();
    expect(container.textContent).toContain("chunk 0 · score 0.9123");
    expect(container.textContent).toContain("0.8700");
  });

  it("never fabricates citations when evidence is insufficient", async () => {
    ai.rag.mockResolvedValue({
      answer: "",
      confidence: 0.12,
      insufficient_evidence: true,
      citations: [],
    });
    const user = userEvent.setup();
    const { container } = renderPage();

    await user.click(screen.getByRole("button", { name: "Knowledge (RAG)" }));
    await user.type(screen.getByPlaceholderText(/Ask about your knowledge/i), "unknown topic");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText(/Insufficient evidence/i);
    expect(container.querySelector(".result-card")).toBeNull();
  });

  it("surfaces API errors with their request id", async () => {
    ai.rag.mockRejectedValue(new AiApiError(500, "server_error", "boom", "req-7"));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Knowledge (RAG)" }));
    await user.type(screen.getByPlaceholderText(/Ask about your knowledge/i), "q");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const banner = await screen.findByText(/server_error: boom/);
    expect(banner).toHaveTextContent("req-7");
  });

  it("shows an authentication error when the session is rejected", async () => {
    ai.rag.mockRejectedValue(new AiApiError(401, "unauthorized", "Sign in required"));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Knowledge (RAG)" }));
    await user.type(screen.getByPlaceholderText(/Ask about your knowledge/i), "q");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/unauthorized: Sign in required/)).toBeInTheDocument();
  });

  it("streams assistant tokens and clears the streaming indicator", async () => {
    streamChat.mockImplementation(async (_body, opts) => {
      opts.onEvent({ type: "delta", content: "Hello " });
      opts.onEvent({ type: "delta", content: "world" });
      return { model: "mock-chat", provider: "mock", is_mock: true, usage: { total_tokens: 3 } };
    });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByPlaceholderText(/Ask anything/i), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Hello world")).toBeInTheDocument();
    expect(screen.queryByText(/streaming…/)).toBeNull();
    expect(screen.getByText(/mock-chat · mock · mock · 3 tokens/)).toBeInTheDocument();
  });

  it("reports a cancelled stream", async () => {
    streamChat.mockRejectedValue(new AiApiError(0, "aborted", "Request was cancelled"));
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByPlaceholderText(/Ask anything/i), "hi");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Cancelled.")).toBeInTheDocument();
  });

  it("runs a grounded assistant conversation with persisted citations", async () => {
    ai.conversations.mockResolvedValue({ items: [], meta: { total: 0 } });
    ai.createConversation.mockResolvedValue({
      id: 5,
      title: "What is X?",
      status: "active",
      message_count: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    ai.sendAssistantMessage.mockResolvedValue({ id: 12 });
    ai.conversation.mockResolvedValue({
      conversation: {
        id: 5,
        title: "What is X?",
        status: "active",
        message_count: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      messages: [
        { id: 11, conversation_id: 5, role: "user", content: "What is X?", created_at: new Date().toISOString() },
        {
          id: 12,
          conversation_id: 5,
          role: "assistant",
          content: "X is grounded",
          answer_status: "answered",
          confidence: 0.9,
          is_mock: true,
          model_code: "mock-chat",
          created_at: new Date().toISOString(),
          sources: [
            {
              rank: 1,
              source_id: 1,
              document_id: 7,
              chunk_id: 2,
              source_code: "SRC-1",
              chunk_index: 0,
              page: 3,
              section: "Intro",
              score: 0.9,
              snippet: "excerpt",
            },
          ],
        },
      ],
    });

    const user = userEvent.setup();
    const { container } = renderPage();

    await user.click(screen.getByRole("button", { name: "Assistant" }));
    await user.type(screen.getByPlaceholderText(/grounded assistant/i), "What is X?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("X is grounded");
    expect(ai.createConversation).toHaveBeenCalledWith({ title: "What is X?" });
    expect(ai.sendAssistantMessage).toHaveBeenCalledWith(5, { content: "What is X?" });
    expect(screen.getByText(/SRC-1 · document 7/)).toBeInTheDocument();
    expect(container.textContent).toContain("page 3");
    expect(container.textContent).toContain("Intro");
  });
});
