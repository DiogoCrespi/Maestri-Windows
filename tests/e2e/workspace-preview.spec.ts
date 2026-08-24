import { expect, test, type Page } from "@playwright/test";
import { openPreviewProject, PREVIEW_WORKSPACE_PATH } from "./previewProject";

async function openPreview(page: Page): Promise<void> {
  await openPreviewProject(page);
  await expect(page.getByRole("button", { name: "Novo espaço" })).toBeVisible();
}

async function createEmptyWorkspace(page: Page): Promise<void> {
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
}

async function providePreviewShells(page: Page): Promise<void> {
  // TerminalSettings calls the Tauri shell_list command directly. Install a
  // minimal runtime shim after the app has loaded so desktopBridge remains in
  // web-preview mode while the real form can load its shell options.
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

test.describe("web preview canvas", () => {
  test.beforeEach(async ({ page }) => {
    await openPreview(page);
  });

  test("creates a workspace, terminal, note and file node through clicks", async ({ page }) => {
    await createEmptyWorkspace(page);

    await page.getByRole("button", { name: "Criar novo terminal" }).click();
    await expect(page.locator(".react-flow__node .terminal-node-container")).toHaveCount(1);

    await page.getByRole("button", { name: "Criar nova nota" }).click();
    await expect(page.locator(".note-node-container")).toHaveCount(1);
    await expect(page.locator(".note-textarea")).toBeVisible();

    await page.getByRole("button", { name: "Criar nó da árvore de arquivos" }).click();
    await expect(page.locator(".file-tree-title")).toHaveText("Arquivos");
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
  });

  test("saves a file-backed Markdown note to localStorage in web preview", async ({ page }) => {
    // Confirm a workspace destination first. New workspaces intentionally keep
    // managed notes in memory until the user chooses where they live.
    await page.getByRole("button", { name: "Salvar como…" }).click();
    await expect(page.getByRole("status")).toContainText(`Salvo: ${PREVIEW_WORKSPACE_PATH}`);

    await page.getByRole("button", { name: "Criar nova nota" }).click();
    const note = page.locator(".note-node-container");
    await expect(note).toBeVisible();

    await note.locator(".note-textarea").fill("# E2E note\n\nPersisted in preview.");
    await expect(note.locator(".note-save-status")).toHaveText("Salvo", { timeout: 5_000 });

    const savedNotes = await page.evaluate(() =>
      Object.entries(window.localStorage)
        .filter(([key]) => key.startsWith("maestri-note:"))
        .map(([key, value]) => ({ key, value })),
    );
    expect(savedNotes).toHaveLength(1);
    expect(savedNotes[0]?.key).toMatch(/^maestri-note:C:\/Maestri-E2E\/notes\/Note-.*\.md$/);
    expect(savedNotes[0]?.value).toBe("# E2E note\n\nPersisted in preview.");
  });

  test("supports basic zoom and pan on the canvas", async ({ page }) => {
    await createEmptyWorkspace(page);
    const viewport = page.locator(".react-flow__viewport");
    const beforeZoom = await viewport.getAttribute("style");

    await page.locator(".react-flow__controls-button").first().click();
    await expect.poll(() => viewport.getAttribute("style")).not.toBe(beforeZoom);

    const beforePan = await viewport.getAttribute("style");
    const pane = page.locator(".react-flow__pane");
    await pane.hover({ position: { x: 760, y: 520 } });
    await page.mouse.down();
    await page.mouse.move(840, 580, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => viewport.getAttribute("style")).not.toBe(beforePan);
  });

  test("persists Maestro terminal settings when reopening the editor", async ({ page }) => {
    await createEmptyWorkspace(page);
    await providePreviewShells(page);

    await page.getByRole("button", { name: "Configurar terminal" }).click();
    await expect(page.locator("#terminal-settings-name")).toBeVisible();

    await page.locator("#terminal-settings-name").fill("Maestro Builder");
    await page.locator("#terminal-settings-shell").selectOption("powershell.exe");
    await page.locator("#terminal-settings-working-directory").fill("C:\\repo");
    await page.locator("#terminal-settings-command").fill("claude");
    await page.locator("#terminal-settings-args").fill("--model sonnet");
    await page.locator("#terminal-settings-env").fill("NODE_ENV=test\nMAESTRI_TOKEN=must-be-filtered");
    await page.getByRole("checkbox", { name: "Maestro / Manager" }).check();
    await page.getByRole("button", { name: "Aplicar" }).click();

    const terminal = page.locator(".terminal-node-container").filter({ hasText: "Maestro Builder" });
    await expect(terminal).toBeVisible();
    await terminal.locator(".terminal-header").click();
    await expect(terminal).toHaveClass(/selected/);

    await page.getByRole("button", { name: "Editar configurações do terminal" }).click();
    await expect(page.locator("#terminal-settings-name")).toHaveValue("Maestro Builder");
    await expect(page.locator("#terminal-settings-shell")).toHaveValue("powershell.exe");
    await expect(page.locator("#terminal-settings-working-directory")).toHaveValue("C:\\repo");
    await expect(page.locator("#terminal-settings-command")).toHaveValue("claude");
    await expect(page.locator("#terminal-settings-command")).not.toHaveValue("powershell.exe");
    await expect(page.locator("#terminal-settings-args")).toHaveValue("--model sonnet");
    await expect(page.locator("#terminal-settings-env")).toHaveValue("NODE_ENV=test");
    await expect(page.getByRole("checkbox", { name: "Maestro / Manager" })).toBeChecked();
  });
});
