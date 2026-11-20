import { Hono } from "hono";
import { existsSync } from "fs";
import type { Db } from "../db";
import { ProjectModel } from "../models/project.model";
import { requireAuth } from "../middleware/auth.middleware";
import { view } from "../view";

/** Controller web: GET /studio — dashboard ringkasan. */
export function dashboardController(db: Db) {
  const app = new Hono();

  if (!db.sqlite) {
    app.all("*", (c) => c.text("mode supabase belum diimplementasikan", 501));
    return app;
  }

  const projects = new ProjectModel(db.sqlite);

  // GET /studio — dashboard (wajib login, guard sama seperti /studio/dokumen)
  app.get("/", requireAuth(db), (c) => {
    const stats = projects.stats();
    const terbaru = projects
      .recent(5)
      .map((d) => ({ ...d, missing: !existsSync(d.pdf_path) }));
    return view(c, "studio/dashboard", { stats, terbaru });
  });

  return app;
}
