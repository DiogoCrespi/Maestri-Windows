import { expect, test, type Locator, type Page } from "@playwright/test";
import { openPreviewProject } from "./previewProject";

async function openPreview(page: Page): Promise<void> {
  await openPreviewProject(page);
  await expect(page.getByRole("button", { name: "Novo espaço" })).toBeVisible();
}

async function providePreviewShells(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as {
      __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
    }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "shell_list") {
          return [{ id: "powershell", name: "PowerShell", path: "powershell.exe", isDefault: true }];
        }
        throw new Error(`Unexpected preview invoke: ${command}`);
      },
    };
  });
}

async function createWorkspace(page: Page): Promise<void> {
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
}

async function openPreferences(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Presets e roles" }).click();
  const dialog = page.getByRole("dialog", { name: "Presets & Roles do Terminal" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function createCustomPresetAndRole(page: Page): Promise<{ presetName: string; roleName: string }> {
  const presetName = "E2E Codex Preset";
  const roleName = "E2E Builder Role";
  const dialog = await openPreferences(page);

  await dialog.getByLabel("Nome do Preset").fill(presetName);
  await dialog.getByLabel("Tipo de Agente").selectOption("codex");
  await dialog.getByLabel("Comando Inicial").fill("node");
  await dialog.getByRole("button", { name: "Adicionar Preset" }).click();
  await expect(dialog.getByRole("status")).toContainText(`Preset "${presetName}" criado`);
  await expect(dialog.getByRole("heading", { name: presetName, exact: true })).toBeVisible();

  await dialog.getByRole("tab", { name: /Agent Roles/ }).click();
  await expect(dialog.getByRole("tabpanel", { name: /Agent Roles/ })).toBeVisible();
  await dialog.getByLabel("Nome do Role").fill(roleName);
  await dialog.getByLabel("Descrição").fill("Role criado pelo fluxo E2E");
  await dialog.getByLabel("System Prompt").fill("Build and verify the requested change.");
  await dialog.getByLabel("Preset Associado (Opcional)").selectOption({ label: presetName });
  await dialog.getByRole("button", { name: "Adicionar Role" }).click();
  await expect(dialog.getByRole("status")).toContainText(`Agent Role "${roleName}" criado`);
  await expect(dialog.getByText(roleName, { exact: true })).toBeVisible();

  return { presetName, roleName };
}

test.describe("Maestro presets and roles", () => {
  test.beforeEach(async ({ page }) => {
    await openPreview(page);
  });

  test("creates custom preset and role, applies them to a terminal, and reopens the settings", async ({ page }) => {
    await createWorkspace(page);
    const { presetName, roleName } = await createCustomPresetAndRole(page);

    const dialog = page.getByRole("dialog", { name: "Presets & Roles do Terminal" });
    await dialog.getByRole("button", { name: "Fechar painel de preferências" }).click();
    await providePreviewShells(page);

    await page.getByRole("button", { name: "Configurar terminal" }).click();
    const settings = page.locator(".terminal-settings");
    await expect(settings).toBeVisible();

    await settings.locator("#terminal-settings-name").fill("E2E Maestro Terminal");
    await settings.locator("#terminal-settings-shell").selectOption("powershell.exe");
    await settings.locator("#terminal-settings-working-directory").fill("C:\\repo");
    await settings.locator("#terminal-settings-preset").selectOption({ label: `${presetName} (codex)` });
    await expect(settings.locator("#terminal-settings-command")).toHaveValue("node");
    await settings.locator("#terminal-settings-role").selectOption({ label: roleName });
    await expect(settings.locator("#terminal-settings-role option:checked")).toHaveText(roleName);
    await expect(settings.locator("#terminal-settings-command")).toHaveValue("node");
    await settings.getByRole("button", { name: "Aplicar" }).click();

    const terminal = page.locator(".terminal-node-container").filter({ hasText: "E2E Maestro Terminal" });
    await expect(terminal).toBeVisible();
    await expect(terminal.getByText("codex", { exact: true })).toBeVisible();

    await terminal.locator(".terminal-header").click();
    await expect(terminal).toHaveClass(/selected/);
    await page.getByRole("button", { name: "Editar configurações do terminal" }).click();
    await expect(settings.locator("#terminal-settings-command")).toHaveValue("node");
    await expect(settings.locator("#terminal-settings-command")).not.toHaveValue("powershell.exe");
    await expect(settings.locator("#terminal-settings-role option:checked")).toHaveText(roleName);
    await expect(terminal.getByText("codex", { exact: true })).toBeVisible();
    await expect(settings.locator("#terminal-settings-shell")).toHaveValue("powershell.exe");
  });

  test("exports and imports the visible preset and role configuration", async ({ page }) => {
    const { presetName, roleName } = await createCustomPresetAndRole(page);
    const dialog = page.getByRole("dialog", { name: "Presets & Roles do Terminal" });
    await dialog.getByRole("tab", { name: "Importar / Exportar" }).click();

    await dialog.getByRole("button", { name: "Gerar JSON Atual" }).click();
    const jsonArea = dialog.getByLabel("Conteúdo do JSON");
    await expect(jsonArea).toHaveValue(/E2E Codex Preset/);
    await expect(jsonArea).toHaveValue(new RegExp(roleName));

    const exported = await jsonArea.inputValue();
    await jsonArea.fill(exported);
    await dialog.getByRole("button", { name: "Importar do Texto Abaixo" }).click();
    await expect(dialog.getByRole("status")).toContainText("Preferências importadas com sucesso");

    await dialog.getByRole("tab", { name: /Presets/ }).click();
    await expect(dialog.getByRole("heading", { name: presetName, exact: true })).toBeVisible();
    await dialog.getByRole("tab", { name: /Agent Roles/ }).click();
    await expect(dialog.getByText(roleName, { exact: true })).toBeVisible();
  });
});
