import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

test("Windows PowerShell launcher keeps its UTF-8 BOM for Windows PowerShell 5.1", async () => {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const launcher = await readFile(join(projectRoot, "start-windows.ps1"));
  assert.deepEqual([...launcher.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});
