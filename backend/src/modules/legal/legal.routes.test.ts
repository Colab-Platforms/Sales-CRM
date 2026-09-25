import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import legalRoutes from "./legal.routes.js";
import { renderLegalPage } from "./legal.render.js";
import { PRIVACY_POLICY, TERMS_OF_SERVICE } from "./legal.content.js";

describe("public legal pages", () => {
  let server: Server;
  let base = "";

  before(async () => {
    const app = express();
    app.use(legalRoutes);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => void server.close());

  for (const [path, title, sections] of [
    ["/privacy-policy", "Privacy Policy", ["Data Collection", "Personal Identifiers", "Trainer Access", "No Third-Party Sales", "Contact Information"]],
    ["/terms-of-service", "Terms of Service", ["Intermediary Role", "Hybrid Model", "Refunds", "Taxes", "Usage License", "Complaints", "Professional Disclaimer"]],
  ] as const) {
    it(`${path} is public HTML, 200, with title, description and required sections`, async () => {
      const res = await fetch(base + path); // no Authorization header, no cookies
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      const html = await res.text();
      assert.match(html, new RegExp(`<title>${title} \\|`));
      assert.match(html, /<meta name="description" content="[^"]+"/);
      for (const heading of sections) assert.ok(html.includes(`>${heading}</h`), `missing section: ${heading}`);
    });
  }

  it("escapes HTML in content and never invents company details", () => {
    const html = renderLegalPage({ ...PRIVACY_POLICY, sections: [{ heading: "<b>x</b>", paragraphs: ["<script>alert(1)</script>"] }] });
    assert.equal(html.includes("<script>"), false);
    assert.ok(html.includes("[Company Legal Name]") && html.includes("[Support Email]"));
    assert.ok(TERMS_OF_SERVICE.sections.length > 0);
  });
});
