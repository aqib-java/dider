import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { slugify } from "../lib/slug";

export type Project = {
  id: string;
  nama: string;
  slug: string;
  pdf_path: string;
  kategori: string;
  views: number;
  uploader_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ProjectSummary = Pick<
  Project,
  "id" | "nama" | "slug" | "pdf_path" | "kategori" | "views" | "uploader_id" | "created_at" | "updated_at" | "deleted_at"
> & {
  /** Nama tampilan uploader (full_name atau username). NULL kalau data lama. */
  uploader: string | null;
};

/** Urutan rak buku: 'latest' = terbaru, 'popular' = paling banyak dibaca. */
export type ShelfSort = "latest" | "popular";

const SHELF_SELECT = `
  SELECT p.id, p.nama, p.slug, p.pdf_path, p.kategori, p.views, p.uploader_id,
         p.created_at, p.updated_at, p.deleted_at,
         COALESCE(u.full_name, u.username) AS uploader
  FROM projects p
  LEFT JOIN users u ON u.id = p.uploader_id
`;

/** Model: tabel projects — dokumen PDF yang di-upload. */
export class ProjectModel {
  constructor(private db: Database) {}

  /** List dokumen aktif (belum di-trash), terbaru dulu. */
  list(): ProjectSummary[] {
    return this.db
      .query(`${SHELF_SELECT} WHERE p.deleted_at IS NULL ORDER BY p.updated_at DESC`)
      .all() as ProjectSummary[];
  }

  /** Ringkasan untuk dashboard studio: total aktif, total views, isi trash. */
  stats(): { total: number; views: number; trash: number } {
    const aktif = this.db
      .query(
        "SELECT COUNT(*) AS total, COALESCE(SUM(views), 0) AS views FROM projects WHERE deleted_at IS NULL"
      )
      .get() as { total: number; views: number };
    const trash = this.db
      .query("SELECT COUNT(*) AS c FROM projects WHERE deleted_at IS NOT NULL")
      .get() as { c: number };
    return { total: aktif.total, views: aktif.views, trash: trash.c };
  }

  /** Dokumen aktif terbaru, dibatasi limit (untuk dashboard). */
  recent(limit = 5): ProjectSummary[] {
    return this.db
      .query(`${SHELF_SELECT} WHERE p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT ?`)
      .all(limit) as ProjectSummary[];
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
    opts: { sort?: ShelfSort | "oldest"; q?: string; limit?: number } = {}
  ): ProjectSummary[] {
    const sort = opts.sort ?? "latest";
    const q = (opts.q ?? "").trim();

    let orderBy = "p.updated_at DESC";
    if (sort === "popular") orderBy = "p.views DESC, p.updated_at DESC";
    else if (sort === "oldest") orderBy = "p.created_at ASC";

    let where = "p.deleted_at IS NULL";
    const params: (string | number)[] = [];
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

  /** List dokumen di trash (deleted_at terisi), terbaru di-trash dulu. */
  listTrashed(): ProjectSummary[] {
    return this.db
      .query(
        `${SHELF_SELECT} WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC`
      )
      .all() as ProjectSummary[];
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

  /** Soft delete: tandai deleted_at, file tetap di disk. */
  softDelete(id: string) {
    this.db
      .query(
        "UPDATE projects SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
      )
      .run(id);
  }

  /** Restore dari trash: kosongkan deleted_at. */
  restore(id: string) {
    this.db
      .query(
        "UPDATE projects SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NOT NULL"
      )
      .run(id);
  }

  /** Hard delete: hapus baris permanen (file dihapus oleh controller). */
  delete(id: string) {
    this.db.query("DELETE FROM projects WHERE id = ?").run(id);
  }
}
