import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../db";
import { LabelModel } from "../models/label.model";
import { ProjectModel } from "../models/project.model";
import type { PublicUser } from "../models/user.model";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware";
import { view, redirect, flashSuccess, flashError } from "../view";
import { buildPagination, pageOffset } from "../lib/pagination";

function currentUser(c: Context): PublicUser | null {
  return (c.get("user" as never) as PublicUser | null) ?? null;
}

/** Controller: /studio/label — kelola daftar label (admin) + tempel label ke dokumen. */
export function labelController(db: Db) {
  const app = new Hono();

  if (!db.sqlite) {
    app.all("*", (c) => c.text("mode supabase belum diimplementasikan", 501));
    return app;
  }

  const labels = new LabelModel(db.sqlite);
  const projects = new ProjectModel(db.sqlite);

  // GET /studio/label — daftar label + form tambah (khusus admin, dengan pagination)
  app.get("/label", requireAdmin(db), (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const pagination = buildPagination({
      pageRaw: c.req.query("page"),
      perRaw: c.req.query("per"),
      total: labels.count({ q }),
      baseUrl: "/studio/label",
      params: { q },
    });

    return view(c, "studio/label/index", {
      daftar: labels.listWithCount({
        q,
        limit: pagination.per,
        offset: pageOffset(pagination),
      }),
      pagination,
      q,
    });
  });

  // POST /studio/label — tambah label
  app.post("/label", requireAdmin(db), async (c) => {
    const body = await c.req.parseBody();
    const nama = String(body.nama ?? "").trim();

    if (!nama) {
      flashError(c, "Nama label wajib diisi.");
      return redirect(c, "/studio/label");
    }
    if (nama.length > 30) {
      flashError(c, "Nama label maksimal 30 karakter.");
      return redirect(c, "/studio/label");
    }
    const dibuat = labels.create(nama);
    if (!dibuat) {
      flashError(c, `Label "${nama}" sudah ada.`);
      return redirect(c, "/studio/label");
    }
    flashSuccess(c, `Label "${dibuat.nama}" ditambahkan.`);
    return redirect(c, "/studio/label");
  });

  // POST /studio/label/:id/delete — hapus label (relasi dokumen ikut dibersihkan)
  app.post("/label/:id/delete", requireAdmin(db), (c) => {
    const id = c.req.param("id");
    const label = labels.listWithCount().find((l) => l.id === id);
    if (!label) {
      flashError(c, "Label tidak ditemukan.");
      return redirect(c, "/studio/label");
    }
    labels.delete(id);
    flashSuccess(c, `Label "${label.nama}" dihapus.`);
    return redirect(c, "/studio/label");
  });

  // POST /studio/dokumen/:id/label — simpan label sebuah dokumen.
  // Admin boleh semua dokumen; kontributor hanya miliknya.
  app.post("/dokumen/:id/label", requireAuth(db), async (c) => {
    const user = currentUser(c);
    const doc = projects.findById(c.req.param("id"));
    if (!doc) {
      flashError(c, "Dokumen tidak ditemukan.");
      return redirect(c, "/studio/dokumen");
    }
    const boleh = user?.role === "admin" || doc.uploader_id === user?.id;
    if (!boleh) {
      flashError(c, "Kamu tidak berhak memberi label dokumen ini.");
      return redirect(c, "/studio/dokumen");
    }

    const body = await c.req.parseBody({ all: true });
    const mentah = body["label"];
    const dipilih = (Array.isArray(mentah) ? mentah : mentah ? [mentah] : [])
      .map((v) => String(v))
      .filter(Boolean);

    // Hanya simpan id yang benar-benar ada (jaga dari input liar).
    const valid = new Set(labels.listWithCount().map((l) => l.id));
    const ids = dipilih.filter((id) => valid.has(id));

    labels.setFor(doc.id, ids);
    flashSuccess(
      c,
      ids.length === 0
        ? `Label dokumen "${doc.nama}" dikosongkan.`
        : `Label dokumen "${doc.nama}" diperbarui (${ids.length}).`
    );

    const balik = c.req.query("status") === "archived" ? "?status=archived" : "";
    return redirect(c, `/studio/dokumen${balik}`);
  });

  return app;
}
