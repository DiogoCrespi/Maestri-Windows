import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LocationBadge } from "./LocationBadge";

describe("LocationBadge Component", () => {
  it("renders default LOCAL badge when locationType is omitted or 'local'", () => {
    render(<LocationBadge />);
    const badge = screen.getByRole("status");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("LOCAL");
    expect(badge).toHaveAttribute("aria-label", "Ambiente de Execução: Local");
  });

  it("renders SSH badge with accessible label when locationType is 'ssh'", () => {
    render(<LocationBadge locationType="ssh" host="192.168.1.100" />);
    const badge = screen.getByRole("status");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("SSH (192.168.1.100)");
    expect(badge).toHaveAttribute("aria-label", "Ambiente de Execução: SSH Remote");
    expect(badge).toHaveAttribute(
      "title",
      "Execução remota via SSH (192.168.1.100)",
    );
  });

  it("handles case-insensitive locationType string gracefully", () => {
    render(<LocationBadge locationType="SSH" />);
    const badge = screen.getByRole("status");
    expect(badge).toHaveTextContent("SSH");
    expect(badge).toHaveAttribute("aria-label", "Ambiente de Execução: SSH Remote");
  });
});
