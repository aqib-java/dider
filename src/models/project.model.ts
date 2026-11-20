import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { slugify } from "../lib/slug";

/** Status dokumen — satu-satunya penentu tampil/tidaknya dokumen. */
export type Status = "published" | "archived" | "trashed";

export type Project = {
  id: string;
  nama: string;
  slug: string;
  pdf_path: string;
  kategori: string;
  status: Status;
  views: number;
  uploader_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  deleted_at: string | null;
};

export type ProjectSummary = Pick<
  Project,
  | "id" | "nama" | "slug" | "pdf_path" | "kategori" | "status" | "views" | "uploader_id"
  | "created_at" | "updated_at" | "archived_at" | "deleted_at"
> & {
  /** Nama tampilan uploader (full_name atau username). NULL kalau data lama. */
  uploader: string | null;
};

/** Urutan rak buku: 'latest' = terbaru, 'popular' = paling banyak dibaca. */
export type ShelfSort = "latest" | "popular";

/** Urutan di studio: tambah 'oldest' & 'trashed'. */
export type SortKey = ShelfSort | "oldest" | "trashed";

const SHELF_SELECT = `
  SELECT p.id, p.nama, p.slug, p.pdf_path, p.kategori, p.status, p.views, p.uploader_id,
         p.created_at, p.updated_at, p.archived_at, p.deleted_at,
         COALESCE(u.full_name, u.username) AS uploader
  FROM projects p
  LEFT JOIN users u ON u.id = p.uploader_id
`;

/** Model: tabel projects — dokumen PDF yang di-upload. */
export class ProjectModel {
  constructor(private db: Database) {}

  /** List dokumen terbit (default), terbaru dulu. */
  list(): ProjectSummary[] {
    return this.search({ status: "published" });
  }

  /** List dokumen terbit milik satu user (dipakai kontributor). */
  listByUploader(uploaderId: string): ProjectSummary[] {
    return this.search({ status: "published", uploaderId });
  }

  /**
   * Ringkasan untuk dashboard studio, dihitung per status.
   * uploaderId opsional — kontributor hanya melihat angkanya sendiri.
   */
  stats(uploaderId?: string | null): {
    published: number;
    archived: number;
    trashed: number;
    views: number;
  } {
    const scope = uploaderId ? " AND uploader_id = ?" : "";
    const params = uploaderId ? [uploaderId] : [];
    const rows = this.db
      .query(`SELECT status, COUNT(*) AS c FROM projects WHERE 1=1${scope} GROUP BY status`)
      .all(...params) as { status: Status; c: number }[];
    const byStatus = { published: 0, archived: 0, trashed: 0 } as Record<Status, number>;
    for (const r of rows) byStatus[r.status] = r.c;
    const views = this.db
      .query(
        `SELECT COALESCE(SUM(views), 0) AS v FROM projects WHERE status = 'published'${scope}`
      )
      .get(...params) as { v: number };
    return {
      published: byStatus.published ?? 0,
      archived: byStatus.archived ?? 0,
      trashed: byStatus.trashed ?? 0,
      views: views.v,
    };
  }

  /** Dokumen terbaru, dibatasi limit (untuk dashboard). */
  recent(limit = 5, uploaderId?: string | null): ProjectSummary[] {
    return this.search({ status: "published", uploaderId, limit });
  }

  /** List dokumen untuk rak: sort 'latest' (terbaru) atau 'popular' (paling dibaca). */
  listShelf(sort: ShelfSort = "latest"): ProjectSummary[] {
    return this.search({ sort });
  }

  /**
   * Pencarian + filter untuk halaman jelajah publik.
   * sort: 'latest' (terbaru) | 'popular' (paling dibaca) | 'oldest' (terlama).
   * q: kata kunci pada nama dokumen / nama uploader.
   */
  search(
    opts: {
      sort?: SortKey;
      q?: string;
      status?: Status;
      uploaderId?: string | null;
      limit?: number;
    } = {}
  ): ProjectSummary[] {
    const sort = opts.sort ?? "latest";
    // Default 'published' (fail-closed): query publik tidak boleh bocor arsip/trash.
    const status = opts.status ?? "published";
    const q = (opts.q ?? "").trim();

    let orderBy = "p.updated_at DESC";
    if (sort === "popular") orderBy = "p.views DESC, p.updated_at DESC";
    else if (sort === "oldest") orderBy = "p.created_at ASC";
    else if (sort === "trashed") orderBy = "p.deleted_at DESC";

    let where = "p.status = ?";
    const params: (string | number)[] = [status];
    if (opts.uploaderId) {
      where += " AND p.uploader_id = ?";
      params.push(opts.uploaderId);
    }
    if (q) {
      where += " AND (p.nama LIKE ? OR COALESCE(u.full_name, u.username) LIKE ?)";
      const like = `%${q}%`;
      params.push(like, like);
    }

    let sql = `${SHELF_SELECT} WHERE ${where} ORDER BY ${orderBy}`;
    if (opts.limit && opts.limit > 0) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    return this.db.query(sql).all(...params) as ProjectSummary[];
  }

  /** List dokumen di trash, terbaru di-trash dulu. */
  listTrashed(uploaderId?: string | null): ProjectSummary[] {
    return this.search({ status: "trashed", uploaderId, sort: "trashed" });
  }

  /** Ambil satu dokumen lengkap (termasuk yang di-trash + nama uploader). */
  findById(id: string): (Project & { uploader: string | null }) | null {
    return this.db
      .query(`${SHELF_SELECT} WHERE p.id = ?`)
      .get(id) as (Project & { uploader: string | null }) | null;
  }

  /** Ambil dokumen lewat slug publik (/majalah/:slug). */
  findBySlug(slug: string): (Project & { uploader: string | null }) | null {
    return this.db
      .query(`${SHELF_SELECT} WHERE p.slug = ?`)
      .get(slug) as (Project & { uploader: string | null }) | null;
  }

  /** Slug unik untuk judul baru; tambah akhiran angka kalau sudah dipakai. */
  uniqueSlug(nama: string): string {
    const base = slugify(nama);
    const taken = (s: string) =>
      Boolean(this.db.query("SELECT 1 FROM projects WHERE slug = ?").get(s));
    let slug = base;
    let n = 2;
    while (taken(slug)) slug = `${base}-${n++}`;
    return slug;
  }

  /** Simpan dokumen baru (PDF sudah ditulis ke uploads/), return id. */
  create(
    nama: string,
    pdfPath: string,
    id: string = randomUUID(),
    uploaderId: string | null = null
  ): string {
    this.db
      .query(
        "INSERT INTO projects (id, nama, slug, pdf_path, kategori, uploader_id) VALUES (?, ?, ?, ?, 'latest', ?)"
      )
      .run(id, nama, this.uniqueSlug(nama), pdfPath, uploaderId);
    return id;
  }

  /** Tambah hitungan tampil (dipanggil saat dokumen dibuka di reader). */
  incrementViews(id: string) {
    this.db.query("UPDATE projects SET views = views + 1 WHERE id = ?").run(id);
  }

  /**
   * Arsipkan: sembunyikan dari publik tanpa menghapus.
   * archived_at disimpan sebagai jejak waktu (dipakai juga saat restore).
   */
  archive(id: string) {
    this.db
      .query(
        "UPDATE projects SET status = 'archived', archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'published'"
      )
      .run(id);
  }

  /** Terbitkan lagi dari arsip. */
  publish(id: string) {
    this.db
      .query(
        "UPDATE projects SET status = 'published', archived_at = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'archived'"
      )
      .run(id);
  }

  /** Soft delete (masuk trash). archived_at DIBIARKAN agar restore tahu tujuan. */
  softDelete(id: string) {
    this.db
      .query(
        "UPDATE projects SET status = 'trashed', deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status != 'trashed'"
      )
      .run(id);
  }

  /** Restore dari trash → kembali ke 'archived' bila sebelumnya diarsipkan. */
  restore(id: string) {
    this.db
      .query(
        "UPDATE projects SET status = CASE WHEN archived_at IS NOT NULL THEN 'archived' ELSE 'published' END, deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'trashed'"
      )
      .run(id);
  }

  /** Hard delete: hapus baris permanen (file dihapus oleh controller). */
  delete(id: string) {
    this.db.query("DELETE FROM projects WHERE id = ?").run(id);
  }
}
