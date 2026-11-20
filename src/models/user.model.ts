import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";

/** Peran user: 'admin' = internal CCIT, 'kontributor' = pengunggah biasa. */
export type Role = "admin" | "kontributor";

/** Opsi daftar akun (pencarian, filter peran, pagination). */
export type UserListOptions = {
  q?: string;
  role?: Role | "all";
  limit?: number;
  offset?: number;
};

export type PublicUser = {
  id: string;
  username: string;
  full_name: string | null;
  role: Role;
  created_at: string;
};

/** Model: tabel users — auth aplikasi. */
export class UserModel {
  constructor(private db: Database) {}

  /** Cari user lengkap (termasuk password_hash) by username — untuk login. */
  findByUsername(username: string) {
    return this.db
      .query("SELECT id, username, password_hash FROM users WHERE username = ?")
      .get(username) as { id: string; username: string; password_hash: string } | null;
  }

  /** Ambil data publik user by id (tanpa password). */
  findPublic(id: string): PublicUser | null {
    return this.db
      .query("SELECT id, username, full_name, role, created_at FROM users WHERE id = ?")
      .get(id) as PublicUser | null;
  }

  /** Register: hash password (argon2), simpan user, return id. */
  async create(
    username: string,
    password: string,
    fullName?: string
  ): Promise<string> {
    const id = randomUUID();
    const hash = await Bun.password.hash(password);
    // User pertama otomatis admin supaya selalu ada yang bisa mengelola.
    const { c } = this.db.query("SELECT COUNT(*) AS c FROM users").get() as { c: number };
    const role: Role = c === 0 ? "admin" : "kontributor";
    this.db
      .query(
        "INSERT INTO users (id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, username, fullName ?? null, hash, role);
    return id;
  }

  /** Verifikasi login: return userId kalau password benar, null kalau salah. */
  async verifyPassword(
    username: string,
    password: string
  ): Promise<string | null> {
    const row = this.findByUsername(username);
    if (!row) return null;
    const ok = await Bun.password.verify(password, row.password_hash);
    return ok ? row.id : null;
  }

  /** WHERE + parameter bersama untuk list() dan count(). */
  private filter(opts: UserListOptions): { where: string; params: string[] } {
    const q = (opts.q ?? "").trim();
    const parts = ["1=1"];
    const params: string[] = [];
    if (q) {
      parts.push("(u.username LIKE ? OR u.full_name LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }
    if (opts.role === "admin" || opts.role === "kontributor") {
      parts.push("u.role = ?");
      params.push(opts.role);
    }
    return { where: parts.join(" AND "), params };
  }

  /** Daftar akun + jumlah dokumennya (khusus admin), dengan pencarian & pagination. */
  list(opts: UserListOptions = {}): (PublicUser & { jumlah_dokumen: number })[] {
    const { where, params } = this.filter(opts);
    let sql = `SELECT u.id, u.username, u.full_name, u.role, u.created_at,
                      (SELECT COUNT(*) FROM projects p
                        WHERE p.uploader_id = u.id AND p.status != 'trashed') AS jumlah_dokumen
                 FROM users u
                WHERE ${where}
                ORDER BY u.role = 'admin' DESC, u.username COLLATE NOCASE ASC`;
    if (opts.limit && opts.limit > 0) {
      sql += " LIMIT ? OFFSET ?";
      params.push(String(opts.limit), String(opts.offset ?? 0));
    }
    return this.db.query(sql).all(...params) as (PublicUser & { jumlah_dokumen: number })[];
  }

  /** Jumlah akun yang cocok filter (untuk pagination). */
  count(opts: UserListOptions = {}): number {
    const { where, params } = this.filter(opts);
    const row = this.db
      .query(`SELECT COUNT(*) AS c FROM users u WHERE ${where}`)
      .get(...params) as { c: number };
    return row.c;
  }

  /** Jumlah akun per peran (tanpa filter), untuk ringkasan di halaman akun. */
  countByRole(): { admin: number; kontributor: number } {
    const rows = this.db
      .query("SELECT role, COUNT(*) AS c FROM users GROUP BY role")
      .all() as { role: Role; c: number }[];
    const hasil = { admin: 0, kontributor: 0 };
    for (const r of rows) hasil[r.role] = r.c;
    return hasil;
  }

  countAdmins(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'")
      .get() as { c: number };
    return row.c;
  }

  /** Ubah peran user. Return false kalau user tidak ada. */
  setRole(id: string, role: Role): boolean {
    const res = this.db.query("UPDATE users SET role = ? WHERE id = ?").run(role, id);
    return res.changes > 0;
  }

  /** Reset password oleh admin (hash argon2). Return false kalau user tidak ada. */
  async setPassword(id: string, password: string): Promise<boolean> {
    const hash = await Bun.password.hash(password);
    const res = this.db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);
    return res.changes > 0;
  }
}
