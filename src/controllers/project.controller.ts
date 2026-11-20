import { Hono } from "hono";
import type { Context } from "hono";
import { randomUUID } from "crypto";
import { unlinkSync, existsSync } from "fs";
import type { Db } from "../db";
import { ProjectModel, type Status } from "../models/project.model";
import { LabelModel } from "../models/label.model";
import type { PublicUser } from "../models/user.model";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware";
import { view, redirect, flashSuccess, flashError } from "../view";

const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50MB
const UPLOAD_DIR = "uploads"; // harus sinkron dengan serveStatic /uploads/* di app.ts

/** User yang sedang login (di-inject middleware locals). */
function currentUser(c: Context): PublicUser | null {
  return (c.get("user" as never) as PublicUser | null) ?? null;
}

function isAdmin(user: PublicUser | null): boolean {
  return user?.role === "admin";
}

/**
 * Admin boleh mengelola semua dokumen; kontributor hanya miliknya sendiri.
 * Ini yang mencegah mahasiswa melihat/menghapus dokumen internal.
 */
function canManage(user: PublicUser | null, uploaderId: string | null): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  return uploaderId === user.id;
}

/** Controller web: /studio/dokumen — upload PDF, daftar, trash, hapus, restore. */
export function projectController(db: Db) {
  const app = new Hono();

  if (!db.sqlite) {
    app.all("*", (c) => c.text("mode supabase belum diimplementasikan", 501));
    return app;
  }

  const projects = new ProjectModel(db.sqlite);
  const labels = new LabelModel(db.sqlite);

  /**
   * Render daftar dokumen. Dipakai dua halaman berbeda:
   * - /studio/dokumen   → dokumen MILIK SENDIRI (semua peran, termasuk admin)
   * - /studio/postingan → SEMUA dokumen (khusus admin)
   */
  const renderDaftar = (c: Context, mode: "own" | "all") => {
    const user = currentUser(c);
    const semua = mode === "all";
    const scope = semua ? null : (user?.id ?? "__none__");
    const raw = c.req.query("status");
    const status: Status =
      raw === "archived" ? "archived" : raw === "trashed" ? "trashed" : "published";
    const labelSlug = c.req.query("label") || undefined;

    const dokumen = projects
      .search({ status, uploaderId: scope, labelSlug })
      .map((d) => ({ ...d, missing: !existsSync(d.pdf_path) }));

    return view(c, "studio/dokumen/index", {
      mode,
      basePath: semua ? "/studio/postingan" : "/studio/dokumen",
      dokumen,
      status,
      stats: projects.stats(scope),
      isAdmin: isAdmin(user),
      semuaLabel: labels.listWithCount(),
      // Peta label per dokumen untuk dialog "atur label".
      labelMap: labels.idsForMany(dokumen.map((d) => d.id)),
      labelAktif: labelSlug ?? "",
    });
  };

  // GET /studio/dokumen — dokumen milik sendiri + tab status
  app.get("/dokumen", requireAuth(db), (c) => renderDaftar(c, "own"));

  // GET /studio/postingan — semua dokumen dari semua akun (khusus admin)
  app.get("/postingan", requireAdmin(db), (c) => renderDaftar(c, "all"));

  // POST /studio/dokumen — upload PDF
  app.post("/dokumen", requireAuth(db), async (c) => {
    const body = await c.req.parseBody();
    const nama = String(body.nama ?? "").trim() || "Tanpa judul";
    const file = body.pdf;
    const uploaderId = (c.get("userId" as never) as string | undefined) ?? null;

    if (!(file instanceof File)) {
      flashError(c, "Pilih file PDF untuk di-upload.");
      return redirect(c, "/studio/dokumen");
    }
    const isPdf =
      file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      flashError(c, "Hanya file PDF yang diizinkan.");
      return redirect(c, "/studio/dokumen");
    }
    if (file.size > MAX_PDF_SIZE) {
      flashError(c, "Ukuran PDF maksimal 50MB.");
      return redirect(c, "/studio/dokumen");
    }

    const id = randomUUID();
    const pdfPath = `${UPLOAD_DIR}/${id}.pdf`;
    await Bun.write(pdfPath, file);
    if (!existsSync(pdfPath)) {
      flashError(c, "Gagal menyimpan file PDF di server. Coba lagi.");
      return redirect(c, "/studio/dokumen");
    }
    try {
      projects.create(nama, pdfPath, id, uploaderId);
    } catch {
      // Jangan tinggalkan file orphan kalau insert DB gagal.
      try {
        unlinkSync(pdfPath);
      } catch {}
      flashError(c, "Gagal menyimpan data dokumen. Coba lagi.");
      return redirect(c, "/studio/dokumen");
    }
    flashSuccess(c, `Dokumen "${nama}" berhasil di-upload.`);
    return redirect(c, "/studio/dokumen");
  });

  // GET /studio/dokumen/trash — daftar dokumen di trash
  app.get("/dokumen/trash", requireAuth(db), (c) => {
    const user = currentUser(c);
    const scope = isAdmin(user) ? null : (user?.id ?? "__none__");
    const dokumen = projects
      .listTrashed(scope)
      .map((d) => ({ ...d, missing: !existsSync(d.pdf_path) }));
    return view(c, "studio/dokumen/trash", {
      dokumen,
      stats: projects.stats(scope),
    });
  });

  // POST /studio/dokumen/:id/archive — arsipkan (sembunyi dari publik, bukan hapus)
  app.post("/dokumen/:id/archive", requireAuth(db), (c) => {
    const user = currentUser(c);
    const doc = projects.findById(c.req.param("id"));
    if (!doc) {
      flashError(c, "Dokumen tidak ditemukan.");
      return redirect(c, "/studio/dokumen");
    }
    if (!canManage(user, doc.uploader_id)) {
      flashError(c, "Kamu tidak berhak mengubah dokumen ini.");
      return redirect(c, "/studio/dokumen");
    }
    if (doc.status !== "published") {
      flashError(c, "Hanya dokumen terbit yang bisa diarsipkan.");
      return redirect(c, "/studio/dokumen");
    }
    projects.archive(doc.id);
    flashSuccess(c, `Dokumen "${doc.nama}" diarsipkan.`);
    return redirect(c, "/studio/dokumen");
  });

  // POST /studio/dokumen/:id/publish — terbitkan lagi dari arsip
  app.post("/dokumen/:id/publish", requireAuth(db), (c) => {
    const user = currentUser(c);
    const doc = projects.findById(c.req.param("id"));
    if (!doc) {
      flashError(c, "Dokumen tidak ditemukan.");
      return redirect(c, "/studio/dokumen?status=archived");
    }
    if (!canManage(user, doc.uploader_id)) {
      flashError(c, "Kamu tidak berhak mengubah dokumen ini.");
      return redirect(c, "/studio/dokumen?status=archived");
    }
    if (doc.status !== "archived") {
      flashError(c, "Dokumen ini tidak sedang diarsipkan.");
      return redirect(c, "/studio/dokumen?status=archived");
    }
    projects.publish(doc.id);
    flashSuccess(c, `Dokumen "${doc.nama}" kembali terbit.`);
    return redirect(c, "/studio/dokumen?status=archived");
  });

  // POST /studio/dokumen/:id/delete — soft delete (masuk trash). Hard delete
  // TIDAK lewat sini — wajib lewat /hard-delete eksplisit.
  app.post("/dokumen/:id/delete", requireAuth(db), (c) =>
    softDelete(c, projects, currentUser(c))
  );

  // POST /studio/dokumen/:id/hard-delete — hard delete permanen (dari trash)
  app.post("/dokumen/:id/hard-delete", requireAuth(db), (c) =>
    hardDelete(c, projects, currentUser(c))
  );

  // POST /studio/dokumen/:id/trash-and-delete — dari popup halaman utama:
  // pindahkan ke trash lalu hapus permanen dalam satu aksi eksplisit.
  app.post("/dokumen/:id/trash-and-delete", requireAuth(db), (c) =>
    hardDelete(c, projects, currentUser(c), { allowActive: true })
  );

  // POST /studio/dokumen/:id/restore — restore dari trash
  app.post("/dokumen/:id/restore", requireAuth(db), (c) => {
    const id = c.req.param("id");
    const doc = projects.findById(id);
    if (!doc || doc.status !== "trashed") {
      flashError(c, "Dokumen tidak ditemukan di trash.");
      return redirect(c, "/studio/dokumen/trash");
    }
    if (!canManage(currentUser(c), doc.uploader_id)) {
      flashError(c, "Kamu tidak berhak memulihkan dokumen ini.");
      return redirect(c, "/studio/dokumen/trash");
    }
    projects.restore(id);
    if (existsSync(doc.pdf_path)) {
      flashSuccess(c, `Dokumen "${doc.nama}" dipulihkan.`);
    } else {
      flashError(
        c,
        `Dokumen "${doc.nama}" dipulihkan, tetapi file PDF-nya tidak ditemukan di server.`
      );
    }
    return redirect(c, "/studio/dokumen/trash");
  });

  return app;
}

/** Soft delete: pindahkan ke trash. File PDF tetap di disk. */
function softDelete(c: Context, projects: ProjectModel, user: PublicUser | null) {
  const id = c.req.param("id");
  const doc = projects.findById(id);
  if (!doc) {
    flashError(c, "Dokumen tidak ditemukan.");
    return redirect(c, "/studio/dokumen");
  }
  if (!canManage(user, doc.uploader_id)) {
    flashError(c, "Kamu tidak berhak menghapus dokumen ini.");
    return redirect(c, "/studio/dokumen");
  }
  if (doc.status === "trashed") {
    flashError(c, "Dokumen sudah ada di trash.");
    return redirect(c, "/studio/dokumen");
  }
  projects.softDelete(id);
  flashSuccess(c, `Dokumen "${doc.nama}" dipindahkan ke trash.`);
  return redirect(c, "/studio/dokumen");
}

/** Hard delete: hapus baris DB + file permanen. Default hanya dari trash. */
function hardDelete(
  c: Context,
  projects: ProjectModel,
  user: PublicUser | null,
  opts: { allowActive?: boolean } = {}
) {
  const id = c.req.param("id");
  const doc = projects.findById(id);
  if (!doc) {
    flashError(c, "Dokumen tidak ditemukan.");
    return redirect(c, "/studio/dokumen/trash");
  }
  if (!canManage(user, doc.uploader_id)) {
    flashError(c, "Kamu tidak berhak menghapus dokumen ini.");
    return redirect(c, "/studio/dokumen");
  }
  if (doc.status !== "trashed" && !opts.allowActive) {
    flashError(c, "Dokumen belum di trash. Pindahkan ke trash dulu.");
    return redirect(c, "/studio/dokumen");
  }
  const fromTrash = doc.status === "trashed";
  // Hapus baris dulu, lalu file. File orphan di-swallow (bukan kegagalan data).
  projects.delete(id);
  try {
    unlinkSync(doc.pdf_path);
  } catch {
    // file sudah tidak ada — abaikan
  }
  flashSuccess(c, `Dokumen "${doc.nama}" dihapus permanen.`);
  return redirect(c, fromTrash ? "/studio/dokumen/trash" : "/studio/dokumen");
}
