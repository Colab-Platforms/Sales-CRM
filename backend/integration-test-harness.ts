import { createHmac } from "node:crypto";

const TEST_META_APP_SECRET = "test-app-secret-local-only-0123456789";
const SALES_CRM_URL = "http://localhost:5099/api/webhooks/whatsapp-cloud";
const TEST_PROVIDER_MESSAGE_ID = "wamid.TESTFANOUT0001";
const TEST_INBOUND_FROM = "910000000001"; // matches seeded OMS contact

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", TEST_META_APP_SECRET).update(body).digest("hex");
}

async function post(bodyObj: unknown): Promise<{ status: number; text: string }> {
  const body = JSON.stringify(bodyObj);
  const res = await fetch(SALES_CRM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body) },
    body,
  });
  return { status: res.status, text: await res.text() };
}

function statusPayload(status: string, nonce: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "888888888888888",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "10000000000", phone_number_id: "999999999999999" },
              statuses: [
                {
                  id: TEST_PROVIDER_MESSAGE_ID,
                  status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: TEST_INBOUND_FROM,
                },
              ],
            },
          },
        ],
      },
    ],
    _nonce: nonce, // changes the digest between otherwise-identical test calls
  };
}

function inboundMessagePayload(nonce: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "888888888888888",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "10000000000", phone_number_id: "999999999999999" },
              messages: [
                {
                  id: "wamid.INBOUND" + nonce,
                  from: TEST_INBOUND_FROM,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "hello from integration test" },
                },
              ],
            },
          },
        ],
      },
    ],
    _nonce: nonce,
  };
}

async function main() {
  const scenario = process.argv[2];

  if (scenario === "status") {
    const status = process.argv[3] ?? "delivered";
    const nonce = process.argv[4] ?? String(Date.now());
    const r = await post(statusPayload(status, nonce));
    console.log("POST status:", r.status, r.text);
  } else if (scenario === "status-repeat") {
    // Exact same body twice -- tests duplicate delivery digest dedup.
    const nonce = process.argv[3] ?? "fixed-nonce-dup-test";
    const body = statusPayload("delivered", nonce);
    const r1 = await post(body);
    console.log("first POST:", r1.status, r1.text);
    const r2 = await post(body);
    console.log("second POST (exact duplicate):", r2.status, r2.text);
  } else if (scenario === "inbound") {
    const nonce = process.argv[3] ?? String(Date.now());
    const r = await post(inboundMessagePayload(nonce));
    console.log("POST inbound:", r.status, r.text);
  } else if (scenario === "bad-signature") {
    const body = JSON.stringify(statusPayload("delivered", "bad-sig-test"));
    const res = await fetch(SALES_CRM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=deadbeef" },
      body,
    });
    console.log("bad signature POST:", res.status, await res.text());
  } else {
    console.log("usage: tsx integration-test-harness.ts <status|status-repeat|inbound|bad-signature> [args]");
  }
}

main();
