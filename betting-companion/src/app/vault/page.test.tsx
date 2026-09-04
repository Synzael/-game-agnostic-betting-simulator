import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useHistoryStore, useVaultStore } from "@/store";
import VaultPage from "./page";

describe("VaultPage", () => {
  beforeEach(() => {
    useHistoryStore.setState({ sessions: [] });
    useVaultStore.setState({
      initialized: true,
      sessionsById: {},
      slots: {},
      evaluatedSessionIds: [],
      pendingRevealsBySessionId: {},
      legacyScanCompleted: true,
      persistenceError: null,
    });
  });

  it("renders all three empty trophy slots", () => {
    render(<VaultPage />);

    expect(screen.getByText("Biggest Comeback")).toBeInTheDocument();
    expect(screen.getByText("Longest Survival")).toBeInTheDocument();
    expect(screen.getByText("Perfect Run")).toBeInTheDocument();
    expect(screen.getAllByText("Awaiting a record")).toHaveLength(3);
  });

  it("shows the non-blocking device persistence error", () => {
    useVaultStore.setState({
      persistenceError:
        "Trophy could not be preserved on this device. Your session history is unchanged.",
    });

    render(<VaultPage />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Trophy could not be preserved on this device"
    );
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  });
});
