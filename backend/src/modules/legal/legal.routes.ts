import { Router } from "express";
import { PRIVACY_POLICY, TERMS_OF_SERVICE, type LegalPage } from "./legal.content.js";
import { renderLegalPage } from "./legal.render.js";

// Public, unauthenticated pages (no session, no API access). Mounted at the app root in server.ts,
// ahead of the "/api" router, so they are served as HTML rather than falling through to the JSON 404.
const router = Router();

const serve = (page: LegalPage) => {
  const html = renderLegalPage(page); // static content: rendered once
  router.get(page.path, (_req, res) => {
    res.status(200).type("html").set("Cache-Control", "public, max-age=300").send(html);
  });
};

serve(PRIVACY_POLICY);
serve(TERMS_OF_SERVICE);

export default router;
