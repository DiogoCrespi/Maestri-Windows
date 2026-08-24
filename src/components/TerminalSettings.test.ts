import { describe, expect, it } from "vitest";
import { formatEnvString, parseArgsString, parseEnvString } from "./TerminalSettings";

describe("TerminalSettings env parser and formatter", () => {
  it("parses raw key=value env string correctly", () => {
    const raw = `
# Comment line
FOO=bar
BAR = baz 
EMPTY=
BROKEN
BAD-NAME=value
MAESTRI_TOKEN=spoof
Path=spoof
TERM=vt100
    `;
    const parsed = parseEnvString(raw);
    expect(parsed).toEqual({
      FOO: "bar",
      BAR: "baz",
    });
  });

  it("formats env record to string correctly", () => {
    const env = {
      NODE_ENV: "test",
      PORT: "3000",
    };
    const formatted = formatEnvString(env);
    expect(formatted).toBe("NODE_ENV=test\nPORT=3000");
  });

  it("keeps equals in values and rejects protected environment variables", () => {
    expect(parseEnvString("URL=https://host.test?a=1=b\nCOLORTERM=x\n_OK=1")).toEqual({
      URL: "https://host.test?a=1=b",
      _OK: "1",
    });
  });

  it("does not format protected environment variables", () => {
    expect(formatEnvString({ PATH: "bad", TERM: "bad", FOO: "ok" })).toBe("FOO=ok");
  });

  it("parses quoted shell args into one argument", () => {
    expect(parseArgsString('-NoLogo -Command "Get-Location -ErrorAction Stop"')).toEqual([
      "-NoLogo",
      "-Command",
      "Get-Location -ErrorAction Stop",
    ]);
    expect(parseArgsString('-File "C:\\Program Files\\script.ps1"')).toEqual([
      "-File",
      "C:\\Program Files\\script.ps1",
    ]);
    expect(() => parseArgsString('"unterminated')).toThrow("aspas não fechadas");
  });
});
