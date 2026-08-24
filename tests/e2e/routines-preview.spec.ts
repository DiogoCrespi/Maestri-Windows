import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  openPreviewProject,
  openRecentProject,
  PREVIEW_PROJECT_DIRECTORY,
  PREVIEW_WORKSPACE_PATH,
} from "./previewProject";

const WORKSPACE_B_DIRECTORY = "C:\\Maestri-E2E-B";
const WORKSPACE_B_PATH = `${WORKSPACE_B_DIRECTORY}\\workspace.json`;

async function openPreview(page: Page): Promise<void> {
  await openPreviewProject(page);
  await expect(page.getByRole("button", { name: "Novo espaço" })).toBeVisible();
}

async function createWorkspaceWithTerminal(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Criar novo terminal" }).click();
  await page.getByRole("button", { name: "Criar novo terminal" }).click();
  await expect(page.locator(".terminal-node-container")).toHaveCount(2);
}

async function saveAsWorkspace(page: Page, path: string): Promise<void> {
  const pathInput = page.getByLabel("Caminho do workspace");
  await pathInput.fill(path);
  await page.getByRole("button", { name: /^Salvar(?: \*)?$/ }).click();
  await expect(page.getByRole("status")).toContainText(path);
}

async function openRoutines(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Rotinas" }).click();
  const panel = page.getByRole("dialog", { name: /Scheduled Routines/ });
  await expect(panel).toBeVisible();
  return panel;
}

function formGroup(panel: Locator, index: number): Locator {
  return panel.locator(".form-group").nth(index);
}

test.describe("workspace-scoped routines in the web preview", () => {
  test("marks a non-empty target orphan when the workspace has no terminals", async ({ page }) => {
    await openPreview(page);
    await saveAsWorkspace(page, "C:\\Maestri-E2E-Empty\\workspace.json");

    const panel = await openRoutines(page);
    await panel.getByLabel("Name:").fill("No Terminal Routine");
    await panel.getByLabel("Target Terminal").fill("missing-terminal");
    await formGroup(panel, 0).locator("textarea").fill("Write-Output no-terminal");
    await panel.getByRole("button", { name: "Create Routine" }).click();

    const routine = panel.locator(".routine-item").filter({ hasText: "No Terminal Routine" });
    await expect(routine).toContainText("Target: missing-terminal");
    await expect(routine).toContainText("(Orphan)");
    await expect(routine.getByRole("button", { name: /Run/ })).toBeDisabled();
  });

  test("activates workspace automatically, persists once/until, dispatches manually and marks orphan targets", async ({ page }) => {
    await openPreview(page);
    await createWorkspaceWithTerminal(page);
    await saveAsWorkspace(page, PREVIEW_WORKSPACE_PATH);

    const panel = await openRoutines(page);
    const target = panel.getByLabel("Target Terminal");
    await expect(target.locator("option")).toHaveCount(2);
    const terminalOneOption = target.locator("option").filter({ hasText: "Terminal 1" });
    await expect(terminalOneOption).toHaveCount(1);
    const terminalId = await terminalOneOption.getAttribute("value");
    expect(terminalId).toBeTruthy();
    expect(terminalId).toMatch(/^[0-9a-f-]{36}$/i);

    const actionGroup = formGroup(panel, 0);
    const scheduleGroup = formGroup(panel, 1);
    const limitGroup = formGroup(panel, 2);
    const onceValue = "2030-01-02T03:04";
    const untilValue = "2030-01-03T03:04";

    await panel.getByLabel("Name:").fill("Workspace Routine");
    await target.selectOption(terminalId!);
    await actionGroup.locator("textarea").fill("Write-Output routine-preview");
    await scheduleGroup.locator("select").selectOption("once");
    await scheduleGroup.locator("input[type=datetime-local]").fill(onceValue);
    await limitGroup.locator("select").selectOption("untilTimestamp");
    await limitGroup.locator("input[type=datetime-local]").fill(untilValue);
    await panel.getByRole("button", { name: "Create Routine" }).click();

    const routine = panel.locator(".routine-item").filter({ hasText: "Workspace Routine" });
    await expect(routine).toBeVisible();
    await expect(routine).toContainText(`Target: ${terminalId}`);
    await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key)?.includes("Workspace Routine") ?? false, `maestri-routines-workspace:${PREVIEW_WORKSPACE_PATH}`)).toBe(true);

    // Web preview exposes only adapter dispatch/status; it does not claim a native PTY ran.
    await routine.getByRole("button", { name: /Run/ }).click();
    await expect(panel.getByRole("status")).toContainText("status: dispatched");
    await expect(panel.getByRole("status")).not.toContainText("completed");

    await routine.getByRole("button", { name: "Disable" }).click();
    await expect(routine.getByText("OFF", { exact: true })).toBeVisible();
    await routine.getByRole("button", { name: "Enable" }).click();
    await expect(routine.getByText("ON", { exact: true })).toBeVisible();

    await routine.getByText("Workspace Routine", { exact: true }).click();
    await expect(panel.getByLabel("Name:")).toHaveValue("Workspace Routine");
    await expect(target).toHaveValue(terminalId);
    await expect(scheduleGroup.locator("select")).toHaveValue("once");
    await expect(scheduleGroup.locator("input[type=datetime-local]")).toHaveValue(onceValue);
    await expect(limitGroup.locator("select")).toHaveValue("untilTimestamp");
    await expect(limitGroup.locator("input[type=datetime-local]")).toHaveValue(untilValue);

    await panel.getByLabel("Name:").fill("Workspace Routine Edited");
    await panel.getByRole("button", { name: "Update Routine" }).click();
    const editedRoutine = panel.locator(".routine-item").filter({ hasText: "Workspace Routine Edited" });
    await expect(editedRoutine).toBeVisible();

    // Changing the confirmed path while the panel is closed must switch the adapter scope.
    await panel.getByRole("button", { name: "Close panel" }).click();
    await saveAsWorkspace(page, WORKSPACE_B_PATH);
    const workspaceBPanel = await openRoutines(page);
    await expect(workspaceBPanel.getByText("No routines configured")).toBeVisible();
    await workspaceBPanel.getByRole("button", { name: "Close panel" }).click();

    await saveAsWorkspace(page, PREVIEW_WORKSPACE_PATH);
    await page.reload({ waitUntil: "domcontentloaded" });
    await openRecentProject(page, PREVIEW_PROJECT_DIRECTORY);
    await expect(page.getByLabel("Caminho do workspace")).toHaveValue(PREVIEW_WORKSPACE_PATH);
    await expect(page.locator(".terminal-node-container")).toHaveCount(2);
    const reloadedPanel = await openRoutines(page);
    const reloadedRoutine = reloadedPanel.locator(".routine-item").filter({ hasText: "Workspace Routine Edited" });
    await expect(reloadedRoutine).toBeVisible();
    await expect(reloadedRoutine).toContainText(`Target: ${terminalId}`);

    await reloadedRoutine.getByText("Workspace Routine Edited", { exact: true }).click();
    await expect(reloadedPanel.locator(".form-group").nth(1).locator("select")).toHaveValue("once");
    await expect(reloadedPanel.locator(".form-group").nth(1).locator("input[type=datetime-local]")).toHaveValue(onceValue);
    await expect(reloadedPanel.locator(".form-group").nth(2).locator("select")).toHaveValue("untilTimestamp");
    await expect(reloadedPanel.locator(".form-group").nth(2).locator("input[type=datetime-local]")).toHaveValue(untilValue);

    await reloadedPanel.getByRole("button", { name: "Close panel" }).click();
    // Keep the real terminals intact and simulate a stale persisted target,
    // which is the web-preview equivalent of a removed native terminal.
    const orphanId = await page.evaluate(() => crypto.randomUUID());
    await page.evaluate(({ key, orphanId }) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) throw new Error(`Missing routine storage: ${key}`);
      const routines = JSON.parse(raw) as Array<{ targetTerminalId: string }>;
      if (!Array.isArray(routines) || routines.length === 0) throw new Error("Routine storage is empty");
      routines[0].targetTerminalId = orphanId;
      window.localStorage.setItem(key, JSON.stringify(routines));
    }, { key: `maestri-routines-workspace:${PREVIEW_WORKSPACE_PATH}`, orphanId });
    await page.reload({ waitUntil: "domcontentloaded" });
    await openRecentProject(page, PREVIEW_PROJECT_DIRECTORY);
    await expect(page.locator(".terminal-node-container")).toHaveCount(2);
    const orphanPanel = await openRoutines(page);
    const orphanRoutine = orphanPanel.locator(".routine-item").filter({ hasText: "Workspace Routine Edited" });
    await expect(orphanRoutine).toContainText(`Target: ${orphanId}`);
    await expect(orphanRoutine).toContainText("(Orphan)");
    await expect(orphanRoutine.getByRole("button", { name: /Run/ })).toBeDisabled();
  });
});
