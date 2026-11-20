import { Hono } from "hono";
import type { Db } from "../db";
import { injectLocals } from "../middleware/locals.middleware";
import { authController } from "../controllers/auth.controller";
import { dashboardController } from "../controllers/dashboard.controller";
import { labelController } from "../controllers/label.controller";
import { accountController } from "../controllers/account.controller";
import { pageController } from "../controllers/page.controller";
import { projectController } from "../controllers/project.controller";

/** Router web: semua halaman browser (server-rendered, form POST). */
export function web(db: Db) {
  const app = new Hono();

  // Locals: user login + flash message untuk semua halaman
  app.use("*", injectLocals(db));

  app.route("/", pageController(db)); // homepage
  app.route("/studio", authController(db)); // /studio/login, /studio/register, /studio/logout
  app.route("/studio", dashboardController(db)); // /studio (dashboard)
  app.route("/studio", projectController(db)); // /studio/dokumen, /studio/dokumen/trash
  app.route("/studio", labelController(db)); // /studio/label (admin) + tempel label dokumen
  app.route("/studio", accountController(db)); // /studio/akun (admin)

  return app;
}
