import assert from "node:assert/strict";
import test from "node:test";

import { installResponse } from "../src/install.js";

const env = { CONTROL_HOST: "relay.example.com" };
const SCRIPT = "#!/bin/sh\necho hi\n";
const get = (url, method = "GET") => new Request(url, { method });

test("serves the install script at /install on the control host", async () => {
  const res = installResponse(get("https://relay.example.com/install"), env, SCRIPT);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/plain/);
  assert.equal(await res.text(), SCRIPT);
});

test("HEAD gets headers only", async () => {
  const res = installResponse(get("https://relay.example.com/install", "HEAD"), env, SCRIPT);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});

test("leaves every other request alone", () => {
  assert.equal(installResponse(get("https://relay.example.com/other"), env, SCRIPT), null);
  assert.equal(installResponse(get("https://demo.example.com/install"), env, SCRIPT), null, "a tunnel's own /install");
  assert.equal(installResponse(get("https://relay.example.com/install", "POST"), env, SCRIPT), null);
});
