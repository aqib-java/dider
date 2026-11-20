import { describe, expect, test } from "bun:test";
import { unlinkSync, existsSync } from "fs";
import { slugify } from "../src/lib/slug";
import {
  createTestApp,
  cookieFrom,
  mergeCookies,
  formHeaders,
  formPostHeaders,
  registerUser,
} from "./helpers";

/** Upload PDF dan kembalikan id dokumen (untuk endpoint admin). */
async function uploadDoc(
  app: ReturnType<typeof createTestApp>,
  cookie: string,
  nama: string
): Promise<string> {
  const pdfBody = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF";
  const form = new FormData();
  form.append("nama", nama);
  form.append("pdf", new File([pdfBody], "x.pdf", { type: "application/pdf" }));
  await app.request("/studio/dokumen", {
    method: "POST",
    headers: { cookie, ...formHeaders },
    body: form,
  });
  const list = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
  return list.match(/data-doc-id="([0-9a-f-]+)"/)![1];
}

describe("Web — homepage", () => {
  test("GET / → 200, landing ter-render", async () => {
    const app = createTestApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("dokumen & majalah");
    expect(html).toContain("/studio/login");
  });

  test("GET / → rak buku tampil tanpa chip filter (filter pindah ke /jelajah)", async () => {
    const app = createTestApp();
    const html = await (await app.request("/")).text();
    expect(html).toContain("Rak Buku");
    expect(html).not.toContain("Dokumen Terbaru");
    expect(html).not.toContain("?rak=popular");
    expect(html).toContain('href="/jelajah"');
  });

  test("kartu rak menampilkan uploader & tanggal upload", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app, "hudya", "rahasia123");

    const form = new FormData();
    form.append("nama", "Majalah Sumber");
    form.append("pdf", new File(["%PDF-1.4\n%%EOF"], "m.pdf", { type: "application/pdf" }));
    await app.request("/studio/dokumen", {
      method: "POST",
      headers: { cookie, ...formHeaders },
      body: form,
    });

    const html = await (await app.request("/")).text();
    expect(html).toContain("oleh hudya");
    expect(html).toMatch(/oleh hudya · \d{1,2} [A-Z][a-z]+ \d{4}/);

    const list = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    const id = list.match(/data-doc-id="([0-9a-f-]+)"/)![1];
    await app.request(`/studio/dokumen/${id}/trash-and-delete`, {
      method: "POST",
      headers: { cookie, ...formPostHeaders },
    });
  });

  test("GET /health → driver sqlite", async () => {
    const app = createTestApp();
    const res = await app.request("/health");
    expect((await res.json()).driver).toBe("sqlite");
  });

  test("navbar homepage tamu → tampil Login & Register", async () => {
    const app = createTestApp();
    const html = await (await app.request("/")).text();
    const nav = html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
    expect(nav).toContain('href="/studio/login"');
    expect(nav).toContain('href="/studio/register"');
    expect(nav).not.toContain("Logout");
  });

  test("navbar homepage user login → tampil Studio & Logout, tanpa tombol Register", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const html = await (await app.request("/", { headers: { cookie } })).text();
    const nav = html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
    expect(nav).toContain('href="/studio"');
    expect(nav).toContain('action="/studio/logout"');
    expect(nav).not.toContain('href="/studio/register"');
    expect(nav).toContain("Halo, admin");
  });
});

describe("Web — auth", () => {
  test("GET /studio/login → form ter-render", async () => {
    const app = createTestApp();
    const res = await app.request("/studio/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/studio/login"');
    expect(html).toContain('name="username"');
  });

  test("GET /studio/register → form ter-render", async () => {
    const app = createTestApp();
    const res = await app.request("/studio/register");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('action="/studio/register"');
  });

  test("POST /studio/register → 302 /studio/dokumen + cookie session", async () => {
    const app = createTestApp();
    const res = await app.request("/studio/register", {
      method: "POST",
      headers: formPostHeaders,
      body: new URLSearchParams({
        username: "admin",
        password: "rahasia123",
        full_name: "Admin Dider",
      }).toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/studio");
    expect(cookieFrom(res)).toContain("sid=");
  });

  test("POST /studio/register username duplikat → re-render dengan error", async () => {
    const app = createTestApp();
    const body = new URLSearchParams({ username: "admin", password: "rahasia123" }).toString();
    await app.request("/studio/register", { method: "POST", headers: formPostHeaders, body });

    const res = await app.request("/studio/register", {
      method: "POST",
      headers: formPostHeaders,
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("sudah dipakai");
  });

  test("POST /studio/register password pendek → error, tidak redirect", async () => {
    const app = createTestApp();
    const res = await app.request("/studio/register", {
      method: "POST",
      headers: formPostHeaders,
      body: new URLSearchParams({ username: "admin", password: "123" }).toString(),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("minimal 6 karakter");
  });

  test("POST /studio/login salah → re-render dengan error", async () => {
    const app = createTestApp();
    await registerUser(app);

    const res = await app.request("/studio/login", {
      method: "POST",
      headers: formPostHeaders,
      body: new URLSearchParams({ username: "admin", password: "salah" }).toString(),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Username atau password salah");
  });

  test("POST /studio/login benar → 302 + cookie session", async () => {
    const app = createTestApp();
    await registerUser(app);

    const res = await app.request("/studio/login", {
      method: "POST",
      headers: formPostHeaders,
      body: new URLSearchParams({ username: "admin", password: "rahasia123" }).toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/studio");
    expect(cookieFrom(res)).toContain("sid=");
  });

  test("sudah login → GET /studio/login redirect ke /studio", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);

    const res = await app.request("/studio/login", { headers: { cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/studio");
  });

  test("POST /studio/logout → 302 ke /, session terhapus", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);

    const logout = await app.request("/studio/logout", {
      method: "POST",
      headers: { cookie, ...formHeaders },
    });
    expect(logout.status).toBe(302);
    expect(logout.headers.get("location")).toBe("/");

    const dokumen = await app.request("/studio/dokumen", { headers: { cookie } });
    expect(dokumen.status).toBe(302);
    expect(dokumen.headers.get("location")).toBe("/studio/login");
  });
});

describe("Web — dokumen (upload PDF, wajib login)", () => {
  const pdfBody = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF";

  test("GET /studio/dokumen tanpa login → 302 ke /studio/login", async () => {
    const app = createTestApp();
    const res = await app.request("/studio/dokumen");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/studio/login");
  });

  test("flow lengkap: upload PDF → tampil di list → halaman baca → hapus", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);

    // GET /studio/dokumen — kosong
    const awal = await app.request("/studio/dokumen", { headers: { cookie } });
    expect(await awal.text()).toContain("Belum ada dokumen");

    // POST /studio/dokumen — upload PDF
    const form = new FormData();
    form.append("nama", "Majalah Angkatan");
    form.append("pdf", new File([pdfBody], "majalah.pdf", { type: "application/pdf" }));
    const up = await app.request("/studio/dokumen", {
      method: "POST",
      headers: { cookie, ...formHeaders },
      body: form,
    });
    expect(up.status).toBe(302);
    expect(up.headers.get("location")).toBe("/studio/dokumen");

    // List menampilkan dokumen
    const list = await app.request("/studio/dokumen", { headers: { cookie } });
    const listHtml = await list.text();
    expect(listHtml).toContain("Majalah Angkatan");
    const match = listHtml.match(/data-doc-id="([0-9a-f-]+)"/);
    expect(match).not.toBeNull();
    const id = match![1];
    const slug = listHtml.match(/\/majalah\/([a-z0-9-]+)/)![1];

    // Halaman baca (reader) publik
    const baca = await app.request(`/majalah/${slug}`);
    expect(baca.status).toBe(200);
    const bacaHtml = await baca.text();
    expect(bacaHtml).toContain("Majalah Angkatan");
    expect(bacaHtml).toContain("/uploads/");
    expect(bacaHtml).not.toContain("/uploads/uploads/");
    expect(bacaHtml).toContain("page-flip");
    expect(bacaHtml).toContain("pdf.min.mjs");
    expect(bacaHtml).toContain("getDocument({ url:");

    // Reader menaikkan views (untuk rak 'popular')
    const listAfter = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    expect(listAfter).toContain("Majalah Angkatan");

    // POST /studio/dokumen/:id/trash-and-delete — hapus permanen dari list
    const del = await app.request(`/studio/dokumen/${id}/trash-and-delete`, {
      method: "POST",
      headers: { cookie, ...formPostHeaders },
    });
    expect(del.status).toBe(302);
    expect(del.headers.get("location")).toBe("/studio/dokumen");

    const list2 = await app.request("/studio/dokumen", { headers: { cookie } });
    expect(await list2.text()).toContain("Belum ada dokumen");
  });

  test("upload file non-PDF → flash error", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);

    const form = new FormData();
    form.append("nama", "Bukan PDF");
    form.append("pdf", new File(["hello"], "catatan.txt", { type: "text/plain" }));
    const res = await app.request("/studio/dokumen", {
      method: "POST",
      headers: { cookie, ...formHeaders },
      body: form,
    });
    expect(res.status).toBe(302);

    const sidCookie = cookie.split(";")[0];
    const page = await app.request("/studio/dokumen", {
      headers: { cookie: `${sidCookie}; ${cookieFrom(res)}` },
    });
    expect(await page.text()).toContain("Hanya file PDF");
  });

  test("upload tanpa file → flash error", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);

    const form = new FormData();
    form.append("nama", "Tanpa File");
    const res = await app.request("/studio/dokumen", {
      method: "POST",
      headers: { cookie, ...formHeaders },
      body: form,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/studio/dokumen");
  });

  test("GET /majalah/:slug tidak ada → redirect ke /", async () => {
    const app = createTestApp();
    const res = await app.request("/majalah/tidak-ada");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  test("URL lama /baca/:id → 301 ke /majalah/:slug (bookmark tetap hidup)", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await uploadDoc(app, cookie, "Majalah Lama");

    const res = await app.request(`/baca/${id}`);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/majalah/majalah-lama");

    // /majalah/:uuid juga dialihkan ke slug kanonik
    const byId = await app.request(`/majalah/${id}`);
    expect(byId.status).toBe(301);
    expect(byId.headers.get("location")).toBe("/majalah/majalah-lama");

    await app.request(`/studio/dokumen/${id}/trash-and-delete`, {
      method: "POST",
      headers: { cookie, ...formPostHeaders },
    });
  });

  test("file PDF hilang → list admin menandai & reader redirect ramah", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);

    // Upload dulu
    const form = new FormData();
    form.append("nama", "Majalah Hilang");
    form.append("pdf", new File([pdfBody], "hilang.pdf", { type: "application/pdf" }));
    await app.request("/studio/dokumen", {
      method: "POST",
      headers: { cookie, ...formHeaders },
      body: form,
    });

    const list = await app.request("/studio/dokumen", { headers: { cookie } });
    const listHtml = await list.text();
    const id = listHtml.match(/data-doc-id="([0-9a-f-]+)"/)![1];
    expect(listHtml).not.toContain("File hilang");

    // Simulasikan file terhapus dari disk
    unlinkSync(`uploads/${id}.pdf`);

    // List admin menandai file hilang
    const list2 = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    expect(list2).toContain("File hilang — upload ulang");

    // Reader tidak 404 mentah: redirect ke / + flash error
    const baca = await app.request(`/majalah/${slugify("Majalah Hilang")}`);
    expect(baca.status).toBe(302);
    expect(baca.headers.get("location")).toBe("/");

    const page = await app.request("/", { headers: { cookie: cookieFrom(baca) } });
    expect(await page.text()).toContain("File PDF tidak ditemukan");

    // Bersihkan record via trash-and-delete (unlink file gagal di-swallow)
    await app.request(`/studio/dokumen/${id}/trash-and-delete`, {
      method: "POST",
      headers: { cookie, ...formPostHeaders },
    });
  });
});

describe("Web — soft delete & trash", () => {
  const pdfBody = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF";

  async function upload(app: ReturnType<typeof createTestApp>, cookie: string) {
    const form = new FormData();
    form.append("nama", "Dokumen Trash");
    form.append("pdf", new File([pdfBody], "trash.pdf", { type: "application/pdf" }));
    await app.request("/studio/dokumen", {
      method: "POST",
      headers: { cookie, ...formHeaders },
      body: form,
    });
    const list = await app.request("/studio/dokumen", { headers: { cookie } });
    return (await list.text()).match(/data-doc-id="([0-9a-f-]+)"/)![1];
  }

  const post = (app: ReturnType<typeof createTestApp>, path: string, cookie: string, mode?: string) =>
    app.request(path, {
      method: "POST",
      headers: { cookie, ...formPostHeaders },
      body: new URLSearchParams(mode ? { mode } : {}).toString(),
    });

  test("soft delete → hilang dari list, muncul di trash, file tetap ada", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie);

    const del = await post(app, `/studio/dokumen/${id}/delete`, cookie, "soft");
    expect(del.status).toBe(302);
    expect(del.headers.get("location")).toBe("/studio/dokumen");

    const list = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    expect(list).not.toContain("Dokumen Trash");

    const trash = await (await app.request("/studio/dokumen/trash", { headers: { cookie } })).text();
    expect(trash).toContain("Dokumen Trash");
    expect(trash).toContain(`/studio/dokumen/${id}/restore`);

    expect(existsSync(`uploads/${id}.pdf`)).toBe(true);

    // Reader publik menolak dokumen di trash
    const baca = await app.request(`/majalah/${slugify("Dokumen Trash")}`);
    expect(baca.status).toBe(302);
    expect(baca.headers.get("location")).toBe("/");

    await post(app, `/studio/dokumen/${id}/hard-delete`, cookie);
  });

  test("restore → kembali ke list, hilang dari trash", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie);
    await post(app, `/studio/dokumen/${id}/delete`, cookie, "soft");

    const res = await post(app, `/studio/dokumen/${id}/restore`, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/studio/dokumen/trash");

    const list = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    expect(list).toContain("Dokumen Trash");

    const trash = await (await app.request("/studio/dokumen/trash", { headers: { cookie } })).text();
    expect(trash).not.toContain(`/studio/dokumen/${id}/restore`);

    const baca = await app.request(`/majalah/${slugify("Dokumen Trash")}`);
    expect(baca.status).toBe(200);

    await post(app, `/studio/dokumen/${id}/trash-and-delete`, cookie);
  });

  test("hard delete dari trash → baris & file hilang permanen", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie);
    await post(app, `/studio/dokumen/${id}/delete`, cookie, "soft");

    const res = await post(app, `/studio/dokumen/${id}/hard-delete`, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/studio/dokumen/trash");

    const trash = await (await app.request("/studio/dokumen/trash", { headers: { cookie } })).text();
    expect(trash).not.toContain(`/studio/dokumen/${id}/restore`);
    expect(existsSync(`uploads/${id}.pdf`)).toBe(false);
  });

  test("restore dokumen yang tidak di-trash → flash error, tidak crash", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie);

    const res = await post(app, `/studio/dokumen/${id}/restore`, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/studio/dokumen/trash");

    await post(app, `/studio/dokumen/${id}/trash-and-delete`, cookie);
  });

  test("POST /delete abaikan mode=hard → tetap soft delete (tidak bisa bypass trash)", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie);

    const del = await post(app, `/studio/dokumen/${id}/delete`, cookie, "hard");
    expect(del.status).toBe(302);
    expect(del.headers.get("location")).toBe("/studio/dokumen");

    // Masih ada (soft) — file tetap & muncul di trash
    expect(existsSync(`uploads/${id}.pdf`)).toBe(true);
    const trash = await (await app.request("/studio/dokumen/trash", { headers: { cookie } })).text();
    expect(trash).toContain(`/studio/dokumen/${id}/restore`);

    await post(app, `/studio/dokumen/${id}/hard-delete`, cookie);
  });

  test("hard-delete dokumen aktif → ditolak, tidak dihapus", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie);

    const res = await post(app, `/studio/dokumen/${id}/hard-delete`, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/studio/dokumen");

    // Masih ada di list aktif
    const list = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    expect(list).toContain("Dokumen Trash");
    expect(existsSync(`uploads/${id}.pdf`)).toBe(true);

    await post(app, `/studio/dokumen/${id}/trash-and-delete`, cookie);
  });

  test("trash-and-delete dari list → baris & file hilang, redirect ke list", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie);

    const res = await post(app, `/studio/dokumen/${id}/trash-and-delete`, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/studio/dokumen");

    expect(existsSync(`uploads/${id}.pdf`)).toBe(false);
    const list = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    expect(list).not.toContain(`data-doc-id="${id}"`);
  });

  test("popup hapus menawarkan soft delete & hard delete (wiring form benar)", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie);

    const html = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    expect(html).toContain(`action="/studio/dokumen/${id}/delete"`);
    expect(html).toContain(`formaction="/studio/dokumen/${id}/trash-and-delete"`);
    expect(html).toContain('name="mode" value="soft"');
    expect(html).toContain(`id="delete-${id}"`);

    await post(app, `/studio/dokumen/${id}/trash-and-delete`, cookie);
  });

  test("restore dokumen yang file PDF-nya hilang → tetap dipulihkan, beri peringatan", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie);

    await post(app, `/studio/dokumen/${id}/delete`, cookie, "soft");
    unlinkSync(`uploads/${id}.pdf`);

    const res = await post(app, `/studio/dokumen/${id}/restore`, cookie);
    expect(res.status).toBe(302);

    const page = await app.request("/studio/dokumen", {
      headers: { cookie: mergeCookies(cookie, cookieFrom(res)) },
    });
    expect(await page.text()).toContain("file PDF-nya tidak ditemukan");
  });
});

describe("Web — dashboard admin", () => {
  const pdfBody = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF";

  test("GET /studio tanpa login → 302 ke /studio/login", async () => {
    const app = createTestApp();
    const res = await app.request("/studio");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/studio/login");
  });

  test("GET /studio → 200, sidebar + kartu statistik ter-render", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);

    const html = await (await app.request("/studio", { headers: { cookie } })).text();
    expect(html).toContain("Dashboard");
    expect(html).toContain(">Terbit<");
    expect(html).toContain("Total Dibaca");
    expect(html).toContain(">Arsip<");
    expect(html).toContain(">Trash<");
    expect(html).toContain('href="/studio/dokumen"');
    expect(html).toContain('href="/studio/dokumen/trash"');
    expect(html).toContain('id="studio-sidebar"');
    expect(html).toContain('id="upload-modal"');
    expect(html).toContain("Belum ada dokumen");
  });

  test("dashboard menghitung statistik + menampilkan dokumen terbaru", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);

    const form = new FormData();
    form.append("nama", "Majalah Dash");
    form.append("pdf", new File([pdfBody], "dash.pdf", { type: "application/pdf" }));
    await app.request("/studio/dokumen", {
      method: "POST",
      headers: { cookie, ...formHeaders },
      body: form,
    });

    const html = await (await app.request("/studio", { headers: { cookie } })).text();
    expect(html).toContain("Majalah Dash");
    expect(html).toContain("/majalah/");

    const list = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    const id = list.match(/data-doc-id="([0-9a-f-]+)"/)![1];
    await app.request(`/studio/dokumen/${id}/trash-and-delete`, {
      method: "POST",
      headers: { cookie, ...formPostHeaders },
    });
  });
});
describe("Web — halaman jelajah (/jelajah)", () => {
  const pdfBody = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF";

  async function upload(
    app: ReturnType<typeof createTestApp>,
    cookie: string,
    nama: string
  ): Promise<string> {
    const form = new FormData();
    form.append("nama", nama);
    form.append("pdf", new File([pdfBody], "x.pdf", { type: "application/pdf" }));
    await app.request("/studio/dokumen", {
      method: "POST",
      headers: { cookie, ...formHeaders },
      body: form,
    });
    const list = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    const rows = list.split('data-doc-id="').slice(1);
    const row = rows.find((r) => r.includes(nama))!;
    return row.slice(0, row.indexOf('"'));
  }

  test("GET /jelajah → 200, halaman list ter-render (publik)", async () => {
    const app = createTestApp();
    const res = await app.request("/jelajah");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Jelajahi Perpustakaan");
    expect(html).toContain('name="q"');
    expect(html).toContain("?urut=latest");
    expect(html).toContain("?urut=popular");
    expect(html).toContain("Terlama");
  });

  test("search q memfilter berdasarkan judul", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const idA = await upload(app, cookie, "Majalah Fisika");
    const idB = await upload(app, cookie, "Buletin Kimia");

    const html = await (await app.request("/jelajah?q=Fisika")).text();
    expect(html).toContain("Majalah Fisika");
    expect(html).not.toContain("Buletin Kimia");
    expect(html).toContain("1 hasil");

    // Tanpa filter → keduanya muncul
    const all = await (await app.request("/jelajah")).text();
    expect(all).toContain("Majalah Fisika");
    expect(all).toContain("Buletin Kimia");

    for (const id of [idA, idB]) {
      await app.request(`/studio/dokumen/${id}/trash-and-delete`, {
        method: "POST",
        headers: { cookie, ...formPostHeaders },
      });
    }
  });

  test("search tanpa hasil → empty state ramah", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie, "Majalah Satu");

    const html = await (await app.request("/jelajah?q=tidakada")).text();
    expect(html).toContain("Tidak ada hasil");
    expect(html).toContain("tidakada");

    await app.request(`/studio/dokumen/${id}/trash-and-delete`, {
      method: "POST",
      headers: { cookie, ...formPostHeaders },
    });
  });

  test("urut=popular mengurutkan dari views terbanyak & menandai POPULER", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const idSedikit = await upload(app, cookie, "Jarang Dibaca");
    const idBanyak = await upload(app, cookie, "Sering Dibaca");

    // Naikkan views dokumen kedua
    for (let i = 0; i < 3; i++) await app.request(`/majalah/${slugify("Sering Dibaca")}`);

    const html = await (await app.request("/jelajah?urut=popular")).text();
    expect(html).toContain("POPULER");
    // Urutan: yang populer muncul lebih dulu di HTML
    expect(html.indexOf("Sering Dibaca")).toBeLessThan(html.indexOf("Jarang Dibaca"));

    for (const id of [idSedikit, idBanyak]) {
      await app.request(`/studio/dokumen/${id}/trash-and-delete`, {
        method: "POST",
        headers: { cookie, ...formPostHeaders },
      });
    }
  });

  test("dokumen di trash tidak muncul di /jelajah", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie, "Akan Dihapus");

    await app.request(`/studio/dokumen/${id}/delete`, {
      method: "POST",
      headers: { cookie, ...formPostHeaders },
      body: new URLSearchParams({ mode: "soft" }).toString(),
    });

    const html = await (await app.request("/jelajah")).text();
    expect(html).not.toContain("Akan Dihapus");

    await app.request(`/studio/dokumen/${id}/hard-delete`, {
      method: "POST",
      headers: { cookie, ...formPostHeaders },
    });
  });
});
