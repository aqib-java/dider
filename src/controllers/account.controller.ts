import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../db";
import { UserModel, type PublicUser, type Role } from "../models/user.model";
import { requireAdmin } from "../middleware/auth.middleware";
import { view, redirect, flashSuccess, flashError } from "../view";
import { buildPagination, pageOffset } from "../lib/pagination";

function currentUser(c: Context): PublicUser | null {
  return (c.get("user" as never) as PublicUser | null) ?? null;
}

/** Controller: /studio/akun — manajemen akun (khusus admin CCIT). */
export function accountController(db: Db) {
  const app = new Hono();

  if (!db.sqlite) {
    app.all("*", (c) => c.text("mode supabase belum diimplementasikan", 501));
    return app;
  }

  const users = new UserModel(db.sqlite);

  // GET /studio/akun — daftar akun + jumlah dokumen (search, filter peran, pagination)
  app.get("/akun", requireAdmin(db), (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const rawPeran = c.req.query("peran");
    const role: Role | "all" =
      rawPeran === "admin" || rawPeran === "kontributor" ? rawPeran : "all";

    const filter = { q, role };
    const pagination = buildPagination({
      pageRaw: c.req.query("page"),
      perRaw: c.req.query("per"),
      total: users.count(filter),
      baseUrl: "/studio/akun",
      params: { q, peran: role === "all" ? undefined : role },
    });

    return view(c, "studio/akun/index", {
      daftar: users.list({ ...filter, limit: pagination.per, offset: pageOffset(pagination) }),
      diriSendiri: currentUser(c)?.id ?? null,
      pagination,
      q,
      role,
      ringkasan: users.countByRole(),
    });
  });

  // POST /studio/akun/:id/role — ubah peran
  app.post("/akun/:id/role", requireAdmin(db), async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const role = String(body.role ?? "") as Role;

    if (role !== "admin" && role !== "kontributor") {
      flashError(c, "Peran tidak dikenal.");
      return redirect(c, "/studio/akun");
    }

    const target = users.findPublic(id);
    if (!target) {
      flashError(c, "Akun tidak ditemukan.");
      return redirect(c, "/studio/akun");
    }

    // Jangan sampai admin terakhir hilang (tidak ada yang bisa mengelola lagi).
    if (target.role === "admin" && role === "kontributor" && users.countAdmins() <= 1) {
      flashError(c, "Tidak bisa menurunkan admin terakhir. Angkat admin lain dulu.");
      return redirect(c, "/studio/akun");
    }
    // Cegah menurunkan diri sendiri agar tidak terkunci di luar halaman admin.
    if (target.id === currentUser(c)?.id && role === "kontributor") {
      flashError(c, "Kamu tidak bisa menurunkan peranmu sendiri.");
      return redirect(c, "/studio/akun");
    }
    if (target.role === role) {
      flashError(c, `${target.username} sudah berperan ${role}.`);
      return redirect(c, "/studio/akun");
    }

    users.setRole(id, role);
    flashSuccess(c, `Peran ${target.username} diubah menjadi ${role}.`);
    return redirect(c, "/studio/akun");
  });

  // POST /studio/akun/:id/password — reset password oleh admin (wajib konfirmasi)
  app.post("/akun/:id/password", requireAdmin(db), async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const password = String(body.password ?? "");
    const konfirmasi = String(body.password_confirm ?? "");

    const target = users.findPublic(id);
    if (!target) {
      flashError(c, "Akun tidak ditemukan.");
      return redirect(c, "/studio/akun");
    }
    // Minimal 6 karakter — dicek juga di klien, tapi server tetap penentu.
    if (password.length < 6) {
      flashError(c, "Password baru minimal 6 karakter.");
      return redirect(c, "/studio/akun");
    }
    if (password !== konfirmasi) {
      flashError(c, "Konfirmasi password tidak sama. Password tidak diubah.");
      return redirect(c, "/studio/akun");
    }

    await users.setPassword(id, password);
    flashSuccess(c, `Password ${target.username} direset.`);
    return redirect(c, "/studio/akun");
  });

  return app;
}
