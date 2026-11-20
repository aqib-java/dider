import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { slugify } from "../lib/slug";

export type Label = {
  id: string;
  nama: string;
  slug: string;
  created_at: string;
};

export type LabelWithCount = Label & {
  /** Jumlah dokumen terbit yang memakai label ini. */
  jumlah: number;
};

/** Model: tabel labels & project_labels — label terkurasi untuk dokumen. */
export class LabelModel {
  constructor(private db: Database) {}

  /** Label beserta jumlah dokumen terbit yang memakainya (search + pagination). */
  listWithCount(opts: { q?: string; limit?: number; offset?: number } = {}): LabelWithCount[] {
    const q = (opts.q ?? "").trim();
    const params: (string | number)[] = [];
    let where = "1=1";
    if (q) {
      where = "l.nama LIKE ?";
      params.push(`%${q}%`);
    }
    let sql = `SELECT l.id, l.nama, l.slug, l.created_at,
                      (SELECT COUNT(*) FROM project_labels pl
                         JOIN projects p ON p.id = pl.project_id
                        WHERE pl.label_id = l.id AND p.status = 'published') AS jumlah
                 FROM labels l
                WHERE ${where}
                ORDER BY l.nama COLLATE NOCASE ASC`;
    if (opts.limit && opts.limit > 0) {
      sql += " LIMIT ? OFFSET ?";
      params.push(opts.limit, opts.offset ?? 0);
    }
    return this.db.query(sql).all(...params) as LabelWithCount[];
  }

  /** Jumlah label yang cocok pencarian (untuk pagination). */
  count(opts: { q?: string } = {}): number {
    const q = (opts.q ?? "").trim();
    const params: string[] = [];
    let where = "1=1";
    if (q) {
      where = "nama LIKE ?";
      params.push(`%${q}%`);
    }
    const row = this.db
      .query(`SELECT COUNT(*) AS c FROM labels WHERE ${where}`)
      .get(...params) as { c: number };
    return row.c;
  }

  findBySlug(slug: string): Label | null {
    return this.db
      .query("SELECT id, nama, slug, created_at FROM labels WHERE slug = ?")
      .get(slug) as Label | null;
  }

  /** Buat label baru. Return null kalau nama sudah dipakai (case-insensitive). */
  create(nama: string): Label | null {
    const bersih = nama.trim();
    if (!bersih) return null;

    const sudahAda = this.db
      .query("SELECT 1 FROM labels WHERE nama = ? COLLATE NOCASE OR slug = ?")
      .get(bersih, slugify(bersih));
    if (sudahAda) return null;

    const id = randomUUID();
    this.db
      .query("INSERT INTO labels (id, nama, slug) VALUES (?, ?, ?)")
      .run(id, bersih, slugify(bersih));
    return this.db
      .query("SELECT id, nama, slug, created_at FROM labels WHERE id = ?")
      .get(id) as Label;
  }

  /** Hapus label beserta relasinya ke dokumen (dokumen tetap utuh). */
  delete(id: string) {
    this.db.query("DELETE FROM project_labels WHERE label_id = ?").run(id);
    this.db.query("DELETE FROM labels WHERE id = ?").run(id);
  }

  /** Id label yang menempel pada satu dokumen. */
  idsFor(projectId: string): string[] {
    return (
      this.db
        .query("SELECT label_id FROM project_labels WHERE project_id = ?")
        .all(projectId) as { label_id: string }[]
    ).map((r) => r.label_id);
  }

  /** Peta projectId -> Set(labelId) dalam satu query (hindari N+1). */
  idsForMany(projectIds: string[]): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    if (projectIds.length === 0) return map;
    const placeholders = projectIds.map(() => "?").join(",");
    const rows = this.db
      .query(
        `SELECT project_id, label_id FROM project_labels WHERE project_id IN (${placeholders})`
      )
      .all(...projectIds) as { project_id: string; label_id: string }[];
    for (const r of rows) {
      if (!map.has(r.project_id)) map.set(r.project_id, new Set());
      map.get(r.project_id)!.add(r.label_id);
    }
    return map;
  }

  /** Ganti seluruh label sebuah dokumen dengan daftar id yang diberikan. */
  setFor(projectId: string, labelIds: string[]) {
    this.db.query("DELETE FROM project_labels WHERE project_id = ?").run(projectId);
    const insert = this.db.query(
      "INSERT OR IGNORE INTO project_labels (project_id, label_id) VALUES (?, ?)"
    );
    for (const labelId of labelIds) insert.run(projectId, labelId);
  }
}
