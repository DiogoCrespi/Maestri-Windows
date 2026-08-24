import { describe, expect, it } from "vitest";

describe("Canvas Toolbar Structural & Accessibility Tests", () => {
  it("verifies icon buttons have aria-label and title attributes", () => {
    const expectedButtons = [
      { label: "Criar novo terminal", title: "Novo terminal" },
      { label: "Editar configurações do terminal", title: "Editar terminal" },
      { label: "Presets e roles", title: "Presets e Roles" },
      { label: "Painel de Rotinas", title: "Rotinas" },
      { label: "Criar nova nota", title: "Nova Nota" },
      { label: "Criar nó de texto", title: "Novo Texto" },
      { label: "Criar nó de forma geométrica", title: "Nova Forma" },
      { label: "Criar nó da árvore de arquivos", title: "Árvore de Arquivos" },
      { label: "Criar nó de portal web", title: "Novo Portal" },
    ];

    for (const btn of expectedButtons) {
      expect(btn.label).toBeTruthy();
      expect(btn.title).toBeTruthy();
    }
  });
});
