import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKING_DIRECTORY,
  resolveWorkspaceWorkingDirectory,
  workspaceFallbackDirectory,
} from "./workingDirectory";

describe("workspace working-directory rule", () => {
  it("preserves an explicit absolute custom directory", () => {
    expect(resolveWorkspaceWorkingDirectory(
      "D:\\repos\\custom",
      "C:\\projects\\demo",
      "C:\\projects\\demo\\workspace.json",
    )).toBe("D:\\repos\\custom");
  });

  it("uses the workspace payload for empty, default and invalid terminal directories", () => {
    for (const requested of ["", "C:\\", "C:/", "relative\\path", "not-a-path", "/Users/legacy/project"]) {
      expect(resolveWorkspaceWorkingDirectory(
        requested,
        "C:\\projects\\demo",
        "C:\\projects\\demo\\workspace.json",
      )).toBe("C:\\projects\\demo");
    }
  });

  it("derives the project folder when the payload still contains the legacy C root", () => {
    expect(workspaceFallbackDirectory("C:\\", "D:\\workspaces\\demo\\workspace.json"))
      .toBe("D:\\workspaces\\demo");
  });

  it("has a safe fallback when neither workspace source is usable", () => {
    expect(resolveWorkspaceWorkingDirectory("", "invalid", "workspace.json"))
      .toBe(DEFAULT_WORKING_DIRECTORY);
  });
});
