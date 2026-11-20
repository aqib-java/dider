import { Database } from "bun:sqlite";
import { env } from "bun";
import { mkdirSync } from "fs";
import { slugify } from "./lib/slug";

export type Driver = "sqlite" | "supabase";

export interface Db {
  driver: Driver;
  sqlite: Database | null;
  supabase: any; // dari @supabase/supabase-js (opsional, null di mode sqlite)
}

/**
 * Init database berdasarkan env DB_DRIVER:
 * - "sqlite" (default)  → bun:sqlite, file di DB_FILE
 * - "supabase"          → @supabase/supabase-js (jalankan `bun add @supabase/supabase-js`)
 */
export async function initDb(): Promise<Db> {
  const driver = (env.DB_DRIVER || "sqlite") as Driver;

  if (driver === "supabase") {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!);
    return { driver, sqlite: null, supabase };
  }

  // default: SQLite
  mkdirSync("data", { recursive: true });
  mkdirSync("uploads", { recursive: true });
  const sqlite = new Database(env.DB_FILE || "data/app.db", { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  migrate(sqlite);
  return { driver, sqlite, supabase: null };
}

export function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      full_name TEXT,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migrasi skema lama → baru: projects lama (ukuran/halaman JSON) di-drop,
  // diganti skema dokumen PDF (pdf_path).
  const cols = db.query("PRAGMA table_info(projects)").all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === "pdf_path")) {
    db.exec("DROP TABLE projects;");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      nama TEXT NOT NULL,
      pdf_path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Soft delete: dokumen di-trash ditandai deleted_at (NULL = aktif).
  const projectCols = db.query("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!projectCols.some((c) => c.name === "deleted_at")) {
    db.exec("ALTER TABLE projects ADD COLUMN deleted_at TEXT;");
  }
  // Bookshelf: kategori (default 'latest') + jumlah tampil (untuk 'popular').
  if (!projectCols.some((c) => c.name === "kategori")) {
    db.exec("ALTER TABLE projects ADD COLUMN kategori TEXT NOT NULL DEFAULT 'latest';");
  }
  if (!projectCols.some((c) => c.name === "views")) {
    db.exec("ALTER TABLE projects ADD COLUMN views INTEGER NOT NULL DEFAULT 0;");
  }
  // Sumber buku: user yang meng-upload (NULL untuk data lama).
  if (!projectCols.some((c) => c.name === "uploader_id")) {
    db.exec("ALTER TABLE projects ADD COLUMN uploader_id TEXT;");
  }

  // Slug URL publik (/majalah/:slug) — dibangkitkan dari nama dokumen.
  if (!projectCols.some((c) => c.name === "slug")) {
    db.exec("ALTER TABLE projects ADD COLUMN slug TEXT;");
  }
  backfillSlugs(db);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);");
}

/** Isi slug untuk baris lama (dan yang masih NULL) supaya unik & stabil. */
function backfillSlugs(db: Database) {
  const rows = db.query("SELECT id, nama FROM projects WHERE slug IS NULL OR slug = ''").all() as {
    id: string;
    nama: string;
  }[];
  if (rows.length === 0) return;

  const used = new Set(
    (db.query("SELECT slug FROM projects WHERE slug IS NOT NULL").all() as { slug: string }[])
      .map((r) => r.slug)
  );
  const update = db.query("UPDATE projects SET slug = ? WHERE id = ?");
  for (const row of rows) {
    const base = slugify(row.nama);
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    update.run(slug, row.id);
  }
}
