import { Hono } from "hono";
import { existsSync } from "fs";
import type { Db } from "../db";
import { ProjectModel } from "../models/project.model";
import type { PublicUser } from "../models/user.model";
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

  // GET /studio — dashboard (wajib login). Kontributor hanya melihat datanya sendiri.
  app.get("/", requireAuth(db), (c) => {
    const user = (c.get("user" as never) as PublicUser | null) ?? null;
    const admin = user?.role === "admin";
    const scope = admin ? null : (user?.id ?? "__none__");
    const stats = projects.stats(scope);
    const terbaru = projects
      .recent(5, scope)
      .map((d) => ({ ...d, missing: !existsSync(d.pdf_path) }));
    return view(c, "studio/dashboard", { stats, terbaru, isAdmin: admin });
  });

  return app;
}
