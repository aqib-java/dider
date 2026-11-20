import { describe, expect, test } from "bun:test";
import {
  createTestApp,
  cookieFrom,
  formPostHeaders,
  registerUser,
} from "./helpers";

type App = ReturnType<typeof createTestApp>;

const post = (app: App, path: string, cookie: string, body?: Record<string, string>) =>
  app.request(path, {
    method: "POST",
    headers: { cookie, ...formPostHeaders },
    body: new URLSearchParams(body ?? {}).toString(),
  });

/** Ambil id user dari halaman /studio/akun berdasarkan username. */
async function userId(app: App, cookie: string, username: string): Promise<string> {
  const html = await (await app.request("/studio/akun", { headers: { cookie } })).text();
  const potongan = html.split('data-user-id="').slice(1);
  const cocok = potongan.find((p) => p.includes(`@${username} `));
  expect(cocok).toBeTruthy();
  return cocok!.slice(0, cocok!.indexOf('"'));
}

describe("Akun — manajemen user (admin)", () => {
  test("admin melihat daftar akun; kontributor ditolak", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    const mhsCookie = await registerUser(app, "mahasiswa");

    const ok = await app.request("/studio/akun", { headers: { cookie: adminCookie } });
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("@adminccit");
    expect(html).toContain("@mahasiswa");
    expect(html).toContain("Admin CCIT");
    expect(html).toContain("Kontributor");

    const denied = await app.request("/studio/akun", { headers: { cookie: mhsCookie } });
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toBe("/studio");
  });

  test("sidebar: grup ADMIN hanya muncul untuk admin", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    const mhsCookie = await registerUser(app, "mahasiswa");

    const adminHtml = await (await app.request("/studio", { headers: { cookie: adminCookie } })).text();
    expect(adminHtml).toContain("KONTEN SAYA");
    expect(adminHtml).toContain("ADMIN");
    expect(adminHtml).toContain('href="/studio/postingan"');
    expect(adminHtml).toContain('href="/studio/akun"');
    expect(adminHtml).toContain('href="/studio/label"');

    const mhsHtml = await (await app.request("/studio", { headers: { cookie: mhsCookie } })).text();
    expect(mhsHtml).toContain("KONTEN SAYA");
    expect(mhsHtml).not.toContain('href="/studio/postingan"');
    expect(mhsHtml).not.toContain('href="/studio/akun"');
    expect(mhsHtml).not.toContain('href="/studio/label"');
  });

  test("admin bisa menaikkan peran kontributor menjadi admin", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    await registerUser(app, "mahasiswa");

    const id = await userId(app, adminCookie, "mahasiswa");
    const res = await post(app, `/studio/akun/${id}/role`, adminCookie, { role: "admin" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/studio/akun");

    const html = await (await app.request("/studio/akun", { headers: { cookie: adminCookie } })).text();
    const baris = html.split('data-user-id="').find((p) => p.includes("@mahasiswa "))!;
    expect(baris).toContain("Admin CCIT");
  });

  test("tidak bisa menurunkan admin terakhir", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");

    const id = await userId(app, adminCookie, "adminccit");
    // Coba turunkan diri sendiri (satu-satunya admin)
    const res = await post(app, `/studio/akun/${id}/role`, adminCookie, { role: "kontributor" });
    expect(res.status).toBe(302);

    const page = await app.request("/studio/akun", {
      headers: { cookie: `${adminCookie.split(";")[0]}; ${cookieFrom(res)}` },
    });
    const html = await page.text();
    expect(html).toContain("Tidak bisa menurunkan admin terakhir");

    // Masih admin
    const masih = await app.request("/studio/akun", { headers: { cookie: adminCookie } });
    expect(masih.status).toBe(200);
  });

  test("admin lain tidak bisa menurunkan diri sendiri (hindari terkunci)", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    await registerUser(app, "adminkedua");
    const idKedua = await userId(app, adminCookie, "adminkedua");
    await post(app, `/studio/akun/${idKedua}/role`, adminCookie, { role: "admin" });

    // Login sebagai admin kedua untuk mendapat cookie-nya
    const login = await app.request("/studio/login", {
      method: "POST",
      headers: formPostHeaders,
      body: new URLSearchParams({ username: "adminkedua", password: "rahasia123" }).toString(),
    });
    const cookie2 = cookieFrom(login);
    expect(cookie2).toContain("sid=");

    const res = await post(app, `/studio/akun/${idKedua}/role`, cookie2, { role: "kontributor" });
    expect(res.status).toBe(302);
    const page = await app.request("/studio/akun", {
      headers: { cookie: `${cookie2.split(";")[0]}; ${cookieFrom(res)}` },
    });
    expect(await page.text()).toContain("peranmu sendiri");

    // admin pertama tetap ada → jumlah admin minimal 1
    const html = await (await app.request("/studio/akun", { headers: { cookie: adminCookie } })).text();
    const baris = html.split('data-user-id="').find((p) => p.includes("@adminkedua "))!;
    expect(baris).toContain("Admin CCIT");
  });

  test("reset password: password lama gagal, password baru berhasil", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    await registerUser(app, "mahasiswa");
    const id = await userId(app, adminCookie, "mahasiswa");

    // Password terlalu pendek ditolak
    await post(app, `/studio/akun/${id}/password`, adminCookie, { password: "123" });

    const res = await post(app, `/studio/akun/${id}/password`, adminCookie, { password: "barubaru123" });
    expect(res.status).toBe(302);

    // Login dengan password baru
    const loginBaru = await app.request("/studio/login", {
      method: "POST",
      headers: formPostHeaders,
      body: new URLSearchParams({ username: "mahasiswa", password: "barubaru123" }).toString(),
    });
    expect(loginBaru.status).toBe(302);
    expect(loginBaru.headers.get("location")).toBe("/studio");

    // Password lama tidak berlaku lagi
    const loginLama = await app.request("/studio/login", {
      method: "POST",
      headers: formPostHeaders,
      body: new URLSearchParams({ username: "mahasiswa", password: "rahasia123" }).toString(),
    });
    expect(loginLama.status).toBe(200);
    expect(await loginLama.text()).toContain("Username atau password salah");
  });

  test("kontributor tidak bisa mengubah peran atau mereset password", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    const mhsCookie = await registerUser(app, "mahasiswa");
    const idAdmin = await userId(app, adminCookie, "adminccit");

    const r1 = await post(app, `/studio/akun/${idAdmin}/role`, mhsCookie, { role: "kontributor" });
    expect(r1.status).toBe(302);
    expect(r1.headers.get("location")).toBe("/studio");

    const r2 = await post(app, `/studio/akun/${idAdmin}/password`, mhsCookie, { password: "diambilalih" });
    expect(r2.status).toBe(302);
    expect(r2.headers.get("location")).toBe("/studio");

    // Password admin tidak berubah
    const login = await app.request("/studio/login", {
      method: "POST",
      headers: formPostHeaders,
      body: new URLSearchParams({ username: "adminccit", password: "rahasia123" }).toString(),
    });
    expect(login.headers.get("location")).toBe("/studio");
  });

  test("Semua Postingan bisa difilter berdasarkan status", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    await registerUser(app, "mahasiswa");

    const form = new FormData();
    form.append("nama", "Dokumen Arsip Uji");
    form.append("pdf", new File(["%PDF-1.4\n%%EOF"], "a.pdf", { type: "application/pdf" }));
    await app.request("/studio/dokumen", {
      method: "POST",
      headers: { cookie: adminCookie, origin: "http://localhost:3000" },
      body: form,
    });

    const list = await (await app.request("/studio/postingan", { headers: { cookie: adminCookie } })).text();
    const id = list.split('data-doc-id="')[1].split('"')[0];

    await post(app, `/studio/dokumen/${id}/archive`, adminCookie);

    const terbit = await (await app.request("/studio/postingan", { headers: { cookie: adminCookie } })).text();
    expect(terbit).not.toContain("Dokumen Arsip Uji");

    const arsip = await (
      await app.request("/studio/postingan?status=archived", { headers: { cookie: adminCookie } })
    ).text();
    expect(arsip).toContain("Dokumen Arsip Uji");
    // Filter tetap di halaman admin, bukan pindah ke /studio/dokumen
    expect(arsip).toContain('href="/studio/postingan?status=archived"');

    await post(app, `/studio/dokumen/${id}/trash-and-delete`, adminCookie);
    try {
      (await import("fs")).unlinkSync(`uploads/${id}.pdf`);
    } catch {
      // sudah tidak ada
    }
  });

  test("topbar ramping: breadcrumb, tanpa tombol Upload & Lihat situs", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app, "adminccit");

    const html = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    const topbar = html.slice(html.indexOf("<header"), html.indexOf("</header>"));

    expect(topbar).toContain('aria-label="Breadcrumb"');
    expect(topbar).toContain('href="/studio"'); // breadcrumb kembali ke dashboard
    expect(topbar).toContain("Dokumen Saya");
    expect(topbar).not.toContain("upload-modal"); // Upload tidak lagi di topbar
    expect(topbar).not.toContain("Lihat situs");

    // Aksi tetap tersedia di tempat yang tepat
    expect(html).toContain('id="upload-modal"'); // modal masih ada
    expect(html).toContain("bx bx-upload"); // tombol upload di halaman dokumen
    expect(html).toContain("Lihat Situs"); // tautan situs tetap ada di sidebar

    // Dashboard: breadcrumb tidak mengulang kata "Studio"
    const dash = await (await app.request("/studio", { headers: { cookie } })).text();
    const topbarDash = dash.slice(dash.indexOf("<header"), dash.indexOf("</header>"));
    expect(topbarDash).toContain("Dashboard");
    expect(topbarDash).not.toContain('href="/studio"');

    // Kartu "Buka Halaman Publik" di dashboard dihapus (tidak berulang)
    expect(dash).not.toContain("Buka Halaman Publik");
    expect(dash).toContain("Ringkasan");
  });
});
