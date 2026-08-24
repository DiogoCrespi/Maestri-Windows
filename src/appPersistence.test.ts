import { describe, expect, it } from "vitest";
import testWorkspaceFixture from "./model/TestWorkspace.json";
import {
  canMarkCleanAfterSave,
  readRememberedWorkspacePath,
  rememberWorkspacePath,
  shouldAutosave,
  workspaceFingerprint,
} from "./App";
import { parseWorkspaceDocument } from "./model/workspace";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

describe("App persistence guards", () => {
  it("does not expose a default path when no workspace was confirmed", () => {
    const storage = memoryStorage();
    expect(readRememberedWorkspacePath(storage)).toBe("");
    expect(shouldAutosave(true, false, "workspace.json")).toBe(true);
    expect(shouldAutosave(true, false, "")).toBe(false);
  });

  it("remembers a path only through the explicit success path", () => {
    const storage = memoryStorage();
    expect(readRememberedWorkspacePath(storage)).toBe("");

    rememberWorkspacePath(storage, "  C:\\workspaces\\confirmed.json  ");
    expect(readRememberedWorkspacePath(storage)).toBe("C:\\workspaces\\confirmed.json");
  });

  it("blocks autosave while hydrating even when the document is dirty", () => {
    expect(shouldAutosave(true, true, "C:\\workspace.json")).toBe(false);
    expect(shouldAutosave(false, false, "C:\\workspace.json")).toBe(false);
  });

  it("does not mark clean when the current document changed during save", () => {
    const saved = parseWorkspaceDocument(testWorkspaceFixture);
    const changed = parseWorkspaceDocument({
      ...testWorkspaceFixture,
      payload: { ...testWorkspaceFixture.payload, name: "Changed while saving" },
    });

    expect(canMarkCleanAfterSave({
      savedPath: "C:\\workspace.json",
      currentPath: "C:\\workspace.json",
      savedWorkspaceId: saved.payload.id,
      currentWorkspaceId: changed.payload.id,
      savedRevision: 4,
      currentRevision: 5,
      savedFingerprint: workspaceFingerprint(saved),
      currentFingerprint: workspaceFingerprint(changed),
    })).toBe(false);
  });

  it("allows markClean only for the same path, workspace and snapshot", () => {
    const document = parseWorkspaceDocument(testWorkspaceFixture);
    const fingerprint = workspaceFingerprint(document);
    const state = {
      savedPath: "C:\\workspace.json",
      currentPath: "C:\\workspace.json",
      savedWorkspaceId: document.payload.id,
      currentWorkspaceId: document.payload.id,
      savedRevision: 7,
      currentRevision: 7,
      savedFingerprint: fingerprint,
      currentFingerprint: fingerprint,
    };

    expect(canMarkCleanAfterSave(state)).toBe(true);
    expect(canMarkCleanAfterSave({ ...state, currentPath: "C:\\other.json" })).toBe(false);
    expect(canMarkCleanAfterSave({ ...state, currentRevision: 8 })).toBe(false);
  });
});
