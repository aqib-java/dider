import { Hono } from "hono";
import type { Context } from "hono";
import { existsSync } from "fs";
import type { Db } from "../db";
import { ProjectModel, type Project } from "../models/project.model";
import { LabelModel } from "../models/label.model";
import { view, redirect, flashError } from "../view";

/** Controller web: halaman publik — homepage + reader flipbook (/baca/:id). */
export function pageController(db: Db) {
  const app = new Hono();

  app.get("/", (c) => {
    const projects = db.sqlite ? new ProjectModel(db.sqlite) : null;
    const rak = c.req.query("rak") === "popular" ? "popular" : "latest";
    const semua = projects ? projects.listShelf(rak) : [];
    // Homepage = etalase: satu edisi unggulan + 10 teratas di rak.
    const dokumen = semua.slice(0, 10);
    return view(c, "homepage/index", {
      dokumen,
      rak,
      total: semua.length,
      populer: projects ? projects.listShelf("popular").slice(0, 3).map((d) => d.id) : [],
    });
  });

  // GET /jelajah — halaman list publik: search + filter urutan.
  app.get("/jelajah", (c) => {
    const projects = db.sqlite ? new ProjectModel(db.sqlite) : null;
    const rawSort = c.req.query("urut") ?? "";
    const urut =
      rawSort === "popular" || rawSort === "oldest" ? rawSort : ("latest" as const);
    const q = (c.req.query("q") ?? "").trim();
    const labelSlug = (c.req.query("label") ?? "").trim();

    const labels = db.sqlite ? new LabelModel(db.sqlite) : null;
    const labelDipakai = labels ? labels.listWithCount().filter((l) => l.jumlah > 0) : [];
    // Abaikan label yang tidak dikenal supaya URL asal-asalan tidak menyaring kosong.
    const labelAktif = labelDipakai.some((l) => l.slug === labelSlug) ? labelSlug : "";

    const dokumen = projects
      ? projects.search({ sort: urut, q, labelSlug: labelAktif || undefined })
      : [];
    const total = projects ? projects.list().length : 0;
    // Penanda "POPULER" di kartu: 3 besar views (konsisten dengan homepage).
    const populer = projects ? projects.listShelf("popular").slice(0, 3).map((d) => d.id) : [];
    return view(c, "homepage/jelajah", {
      dokumen,
      urut,
      q,
      total,
      populer,
      labelDipakai,
      labelAktif,
    });
  });

  // GET /majalah/:slug — reader flipbook (URL publik yang enak dibaca).
  // Terima juga UUID lama /majalah/:id → dialihkan permanen ke slug kanonik.
  app.get("/majalah/:slug", (c) => {
    if (!db.sqlite) return c.text("mode supabase belum diimplementasikan", 501);
    const projects = new ProjectModel(db.sqlite);
    const param = c.req.param("slug");

    const bySlug = projects.findBySlug(param);
    if (!bySlug) {
      const byId = projects.findById(param);
      if (byId) return redirect(c, `/majalah/${byId.slug}`, 301);
      flashError(c, "Dokumen tidak ditemukan.");
      return redirect(c, "/");
    }

    return renderReader(c, projects, bySlug);
  });

  // URL lama /baca/:id → 301 ke /majalah/:slug (bookmark & link lama tetap hidup).
  app.get("/baca/:id", (c) => {
    if (!db.sqlite) return c.text("mode supabase belum diimplementasikan", 501);
    const projects = new ProjectModel(db.sqlite);
    const doc = projects.findById(c.req.param("id"));
    if (!doc) {
      flashError(c, "Dokumen tidak ditemukan.");
      return redirect(c, "/");
    }
    return redirect(c, `/majalah/${doc.slug}`, 301);
  });

  return app;
}

/** Render halaman reader untuk dokumen yang sudah ditemukan. */
function renderReader(
  c: Context,
  projects: ProjectModel,
  doc: Project & { uploader: string | null }
) {
  // Hanya dokumen terbit yang boleh dibaca publik (arsip & trash tersembunyi).
  if (doc.status !== "published") {
    flashError(c, "Dokumen tidak ditemukan.");
    return redirect(c, "/");
  }
  if (!existsSync(doc.pdf_path)) {
    flashError(c, "File PDF tidak ditemukan di server. Upload ulang dokumen ini.");
    return redirect(c, "/");
  }
  projects.incrementViews(doc.id);
  // pdf_path di DB = "uploads/x.pdf"; view butuh nama file saja untuk URL /uploads/...
  const dokumen = { ...doc, pdf_path: doc.pdf_path.replace(/^uploads\//, "") };
  return view(c, "homepage/baca", { dokumen });
}