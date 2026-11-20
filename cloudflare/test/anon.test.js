import assert from "node:assert/strict";
import test from "node:test";

import { anonName } from "../src/anon.js";

test("anonName matches the shared vector", async () => {
  assert.equal(await anonName("0".repeat(64)), "tunnel-60e05bd1b195");
});

test("anonName rejects malformed keys", async () => {
  for (const key of ["", "0".repeat(63), "A".repeat(64), "g".repeat(64), undefined]) {
    assert.equal(await anonName(key), null, `key ${key}`);
  }
});
