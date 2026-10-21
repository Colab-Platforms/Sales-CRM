import { test } from "node:test";
import assert from "node:assert/strict";
import { agentIdMatchesPlivoFrom, buildDialXml, plivoUsernameForAgent, verifyPlivoSignature } from "./plivo.client.js";

const AGENT = "123e4567-e89b-12d3-a456-426614174000";

test("endpoint username is derived from the agent id", () => {
  assert.equal(plivoUsernameForAgent(AGENT), "crm123e4567e89b12d3a456426614174000");
});

test("answer URL accepts only the agent whose Call row it is", () => {
  const from = `sip:${plivoUsernameForAgent(AGENT)}@phone.plivo.com`;
  assert.equal(agentIdMatchesPlivoFrom(AGENT, from), true);
  assert.equal(agentIdMatchesPlivoFrom("00000000-0000-0000-0000-000000000000", from), false);
  assert.equal(agentIdMatchesPlivoFrom(AGENT, undefined), false);
});

test("webhook signature check fails closed without config or headers", () => {
  const saved = { token: process.env.PLIVO_AUTH_TOKEN, url: process.env.PUBLIC_BACKEND_URL };
  delete process.env.PLIVO_AUTH_TOKEN;
  delete process.env.PUBLIC_BACKEND_URL;
  const input = { method: "POST", originalUrl: "/api/webhooks/plivo/answer", headers: {}, params: {} };
  assert.equal(verifyPlivoSignature(input), false);

  process.env.PLIVO_AUTH_TOKEN = "token";
  process.env.PUBLIC_BACKEND_URL = "https://crm.example.com";
  assert.equal(verifyPlivoSignature(input), false); // no signature headers
  assert.equal(
    verifyPlivoSignature({ ...input, headers: { "x-plivo-signature-v3": "bogus", "x-plivo-signature-v3-nonce": "n" } }),
    false,
  );

  if (saved.token === undefined) delete process.env.PLIVO_AUTH_TOKEN;
  else process.env.PLIVO_AUTH_TOKEN = saved.token;
  if (saved.url === undefined) delete process.env.PUBLIC_BACKEND_URL;
  else process.env.PUBLIC_BACKEND_URL = saved.url;
});

test("dial XML rings the stored number with recording and callbacks", () => {
  const xml = buildDialXml({
    customerNumber: "919876543210",
    callerId: "911234567890",
    dialCallbackUrl: "https://crm.example.com/api/webhooks/plivo/dial?callId=c1",
    recordingCallbackUrl: "https://crm.example.com/api/webhooks/plivo/recording?callId=c1",
  });
  assert.match(xml, /<Number>919876543210<\/Number>/);
  assert.match(xml, /callerId="911234567890"/);
  assert.match(xml, /recordSession="true"/);
});
