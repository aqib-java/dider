import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";

/** Peran user: 'admin' = internal CCIT, 'kontributor' = pengunggah biasa. */
export type Role = "admin" | "kontributor";

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
}
