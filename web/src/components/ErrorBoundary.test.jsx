import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ErrorBoundary from "./ErrorBoundary.jsx";

let shouldThrow = true;

function MaybeBomb() {
  if (shouldThrow) throw new Error("kaboom");
  return <div>view recovered</div>;
}

beforeEach(() => {
  shouldThrow = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("shows a readable fallback when a view throws", () => {
    render(
      <ErrorBoundary>
        <MaybeBomb />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/Something went wrong rendering this view/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("re-renders the children after a successful retry", async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <MaybeBomb />
      </ErrorBoundary>,
    );

    shouldThrow = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByText("view recovered")).toBeInTheDocument();
  });
});
