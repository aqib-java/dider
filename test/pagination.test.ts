import { describe, expect, test } from "bun:test";
import { buildPagination, parsePer, buildUrl } from "../src/lib/pagination";
import {
  createTestApp,
  formHeaders,
  formPostHeaders,
  registerUser,
} from "./helpers";

type App = ReturnType<typeof createTestApp>;

describe("Pagination — helper", () => {
  test("default 10 per halaman, hanya 10 atau 15 yang diterima", () => {
    expect(parsePer(undefined)).toBe(10);
    expect(parsePer("15")).toBe(15);
    expect(parsePer("10")).toBe(10);
    // Nilai liar tidak boleh memaksa tampil 1000 baris
    expect(parsePer("1000")).toBe(10);
    expect(parsePer("-5")).toBe(10);
    expect(parsePer("abc")).toBe(10);
  });

  test("halaman di-clamp ke rentang 1..pages", () => {
    const p = buildPagination({ total: 25, baseUrl: "/x", pageRaw: "99" });
    expect(p.pages).toBe(3);
    expect(p.page).toBe(3);
    expect(p.from).toBe(21);
    expect(p.to).toBe(25);

    const rendah = buildPagination({ total: 25, baseUrl: "/x", pageRaw: "0" });
    expect(rendah.page).toBe(1);
    expect(rendah.hasPrev).toBe(false);
  });

  test("filter dipertahankan di URL dan parameter kosong dibuang", () => {
    const p = buildPagination({
      total: 30,
      baseUrl: "/studio/postingan",
      pageRaw: "2",
      perRaw: "10",
      params: { q: "majalah", status: "archived", label: "" },
    });
    expect(p.prevUrl).toBe("/studio/postingan?q=majalah&status=archived");
    expect(p.nextUrl).toBe("/studio/postingan?q=majalah&status=archived&page=3");
    expect(buildUrl("/x", { a: "", b: 2 })).toBe("/x?b=2");
  });

  test("total nol tidak menghasilkan halaman aneh", () => {
    const p = buildPagination({ total: 0, baseUrl: "/x" });
    expect(p.pages).toBe(1);
    expect(p.page).toBe(1);
    expect(p.from).toBe(0);
    expect(p.to).toBe(0);
    expect(p.hasPrev).toBe(false);
    expect(p.hasNext).toBe(false);
  });
});

const PDF = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF";

const post = (app: App, path: string, cookie: string, body?: Record<string, string>) =>
  app.request(path, {
    method: "POST",
    headers: { cookie, ...formPostHeaders },
    body: new URLSearchParams(body ?? {}).toString(),
  });

const jumlah = (html: string, penanda: string) => html.split(penanda).length - 1;

async function upload(app: App, cookie: string, nama: string) {
  const form = new FormData();
  form.append("nama", nama);
  form.append("pdf", new File([PDF], "x.pdf", { type: "application/pdf" }));
  await app.request("/studio/dokumen", {
    method: "POST",
    headers: { cookie, ...formHeaders },
    body: form,
  });
}

describe("Pagination — Semua Postingan", () => {
  test("10 baris per halaman, halaman 2 berisi sisanya, + search & filter status", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app, "adminccit");

    for (let i = 1; i <= 12; i++) await upload(app, cookie, `Dokumen ${String(i).padStart(2, "0")}`);

    const page1 = await (await app.request("/studio/postingan", { headers: { cookie } })).text();
    expect(jumlah(page1, "data-doc-id=")).toBe(10);
    expect(page1).toContain("Menampilkan");
    expect(page1).toContain("dari");
    expect(page1).toContain("12");
    expect(page1).toContain("page=2");

    const page2 = await (await app.request("/studio/postingan?page=2", { headers: { cookie } })).text();
    expect(jumlah(page2, "data-doc-id=")).toBe(2);

    // per=15 → semua 12 masuk satu halaman
    const page15 = await (
      await app.request("/studio/postingan?per=15", { headers: { cookie } })
    ).text();
    expect(jumlah(page15, "data-doc-id=")).toBe(12);

    // per di luar daftar diabaikan (tetap 10)
    const pageLiar = await (
      await app.request("/studio/postingan?per=1000", { headers: { cookie } })
    ).text();
    expect(jumlah(pageLiar, "data-doc-id=")).toBe(10);

    // Search mempersempit hasil dan total ikut menyesuaikan
    const cari = await (
      await app.request("/studio/postingan?q=Dokumen%2001", { headers: { cookie } })
    ).text();
    expect(jumlah(cari, "data-doc-id=")).toBe(1);
    expect(cari).toContain("Dokumen 01");

    // Filter status: semua diarsipkan → tab terbit kosong
    const list = await (await app.request("/studio/postingan?per=15", { headers: { cookie } })).text();
    const ids = list.split('data-doc-id="').slice(1).map((r) => r.slice(0, r.indexOf('"')));
    for (const id of ids) await post(app, `/studio/dokumen/${id}/archive`, cookie);

    const terbit = await (await app.request("/studio/postingan", { headers: { cookie } })).text();
    expect(jumlah(terbit, "data-doc-id=")).toBe(0);

    const arsip = await (
      await app.request("/studio/postingan?status=archived&per=15", { headers: { cookie } })
    ).text();
    expect(jumlah(arsip, "data-doc-id=")).toBe(12);

    // Bersih-bersih (file PDF ikut dihapus lewat hard delete)
    for (const id of ids) await post(app, `/studio/dokumen/${id}/trash-and-delete`, cookie);
  }, 60000);
});

describe("Pagination — Akun", () => {
  test("search, filter peran, dan 10 baris per halaman", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    for (let i = 1; i <= 11; i++) {
      await registerUser(app, `anggota${String(i).padStart(2, "0")}`);
    }

    const page1 = await (await app.request("/studio/akun", { headers: { cookie: adminCookie } })).text();
    // admin + 9 lainnya (total 12 akun, 10 per halaman)
    expect(jumlah(page1, "data-user-id=")).toBe(10);
    expect(page1).toContain("page=2");

    const page2 = await (
      await app.request("/studio/akun?page=2", { headers: { cookie: adminCookie } })
    ).text();
    expect(jumlah(page2, "data-user-id=")).toBe(2);

    // Filter peran
    const adminSaja = await (
      await app.request("/studio/akun?peran=admin", { headers: { cookie: adminCookie } })
    ).text();
    expect(jumlah(adminSaja, "data-user-id=")).toBe(1);

    // 11 kontributor → halaman pertama tetap 10 baris, sisa 1 di halaman 2
    const kontributor = await (
      await app.request("/studio/akun?peran=kontributor", { headers: { cookie: adminCookie } })
    ).text();
    expect(jumlah(kontributor, "data-user-id=")).toBe(10);
    expect(kontributor).toContain("page=2");

    const kontributor15 = await (
      await app.request("/studio/akun?peran=kontributor&per=15", { headers: { cookie: adminCookie } })
    ).text();
    expect(jumlah(kontributor15, "data-user-id=")).toBe(11);

    // Search
    const cari = await (
      await app.request("/studio/akun?q=anggota01", { headers: { cookie: adminCookie } })
    ).text();
    expect(jumlah(cari, "data-user-id=")).toBe(1);
    expect(cari).toContain("anggota01");

    // Search + filter peran sekaligus (admin tidak cocok dengan q)
    const kosong = await (
      await app.request("/studio/akun?q=anggota01&peran=admin", { headers: { cookie: adminCookie } })
    ).text();
    expect(jumlah(kosong, "data-user-id=")).toBe(0);
  }, 60000);
});

describe("Pagination — Label", () => {
  test("search dan 10 baris per halaman", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app, "adminccit");

    for (let i = 1; i <= 12; i++) {
      await post(app, "/studio/label", cookie, { nama: `Label ${String(i).padStart(2, "0")}` });
    }

    const page1 = await (await app.request("/studio/label", { headers: { cookie } })).text();
    expect(jumlah(page1, "data-label-id=")).toBe(10);
    expect(page1).toContain("page=2");

    const page2 = await (await app.request("/studio/label?page=2", { headers: { cookie } })).text();
    expect(jumlah(page2, "data-label-id=")).toBe(2);

    const cari = await (await app.request("/studio/label?q=Label%2012", { headers: { cookie } })).text();
    expect(jumlah(cari, "data-label-id=")).toBe(1);
    expect(cari).toContain("Label 12");
  }, 60000);
});
