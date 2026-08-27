import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { LocationBadge } from "./LocationBadge";

describe("LocationBadge Component", () => {
  it("renders default LOCAL badge when locationType is omitted or 'local'", () => {
    const html = renderToStaticMarkup(<LocationBadge />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Ambiente de Execução: Local"');
    expect(html).toContain("LOCAL");
    expect(html).toContain("location-badge-local");
  });

  it("renders SSH badge with accessible label when locationType is 'ssh'", () => {
    const html = renderToStaticMarkup(<LocationBadge locationType="ssh" host="192.168.1.100" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Ambiente de Execução: SSH Remote"');
    expect(html).toContain("SSH (192.168.1.100)");
    expect(html).toContain('title="Execução remota via SSH (192.168.1.100)"');
    expect(html).toContain("location-badge-ssh");
  });

  it("handles case-insensitive locationType string gracefully", () => {
    const html = renderToStaticMarkup(<LocationBadge locationType="SSH" />);
    expect(html).toContain('aria-label="Ambiente de Execução: SSH Remote"');
    expect(html).toContain("SSH");
    expect(html).toContain("location-badge-ssh");
  });
});
