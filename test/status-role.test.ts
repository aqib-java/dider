import { describe, expect, test } from "bun:test";
import { unlinkSync } from "fs";
import {
  createTestApp,
  cookieFrom,
  formHeaders,
  formPostHeaders,
  registerUser,
} from "./helpers";

const PDF_BODY = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF";

type App = ReturnType<typeof createTestApp>;

/** Upload PDF sebagai user tertentu → id dokumen. */
async function upload(app: App, cookie: string, nama: string): Promise<string> {
  const form = new FormData();
  form.append("nama", nama);
  form.append("pdf", new File([PDF_BODY], "x.pdf", { type: "application/pdf" }));
  await app.request("/studio/dokumen", {
    method: "POST",
    headers: { cookie, ...formHeaders },
    body: form,
  });
  const list = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
  const rows = list.split('data-doc-id="').slice(1);
  const row = rows.find((r) => r.includes(nama));
  expect(row).toBeTruthy();
  return row!.slice(0, row!.indexOf('"'));
}

const post = (app: App, path: string, cookie: string, body?: Record<string, string>) =>
  app.request(path, {
    method: "POST",
    headers: { cookie, ...formPostHeaders },
    body: new URLSearchParams(body ?? {}).toString(),
  });

/** Bersihkan file upload hasil test. */
function cleanup(...ids: string[]) {
  for (const id of ids) {
    try {
      unlinkSync(`uploads/${id}.pdf`);
    } catch {
      // sudah tidak ada
    }
  }
}

describe("Peran & kepemilikan dokumen", () => {
  test("user pertama jadi admin, pendaftar berikutnya kontributor", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    const mhsCookie = await registerUser(app, "mahasiswa");

    const adminHtml = await (await app.request("/studio", { headers: { cookie: adminCookie } })).text();
    expect(adminHtml).toContain("Admin CCIT");

    const mhsHtml = await (await app.request("/studio", { headers: { cookie: mhsCookie } })).text();
    expect(mhsHtml).toContain("Kontributor");
  });

  test("Dokumen Saya berisi milik sendiri; Semua Postingan (admin) berisi semua", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    const mhsCookie = await registerUser(app, "mahasiswa");

    const idInternal = await upload(app, adminCookie, "Dokumen Internal");
    const idMhs = await upload(app, mhsCookie, "Tugas Mahasiswa");

    const mhsList = await (await app.request("/studio/dokumen", { headers: { cookie: mhsCookie } })).text();
    expect(mhsList).toContain("Tugas Mahasiswa");
    expect(mhsList).not.toContain("Dokumen Internal");
    expect(mhsList).toContain("Dokumen Saya");

    // Admin: "Dokumen Saya" tetap hanya miliknya
    const adminOwn = await (await app.request("/studio/dokumen", { headers: { cookie: adminCookie } })).text();
    expect(adminOwn).toContain("Dokumen Internal");
    expect(adminOwn).not.toContain("Tugas Mahasiswa");
    expect(adminOwn).not.toContain('href="/studio/postingan" aria-current');

    // Admin: semua dokumen ada di halaman Semua Postingan
    const postingan = await app.request("/studio/postingan", { headers: { cookie: adminCookie } });
    expect(postingan.status).toBe(200);
    const postinganHtml = await postingan.text();
    expect(postinganHtml).toContain("Dokumen Internal");
    expect(postinganHtml).toContain("Tugas Mahasiswa");
    expect(postinganHtml).toContain("Semua Postingan");

    // Kontributor tidak boleh mengakses Semua Postingan
    const ditolak = await app.request("/studio/postingan", { headers: { cookie: mhsCookie } });
    expect(ditolak.status).toBe(302);
    expect(ditolak.headers.get("location")).toBe("/studio");

    cleanup(idInternal, idMhs);
  });

  test("kontributor tidak bisa menghapus / mengarsipkan dokumen milik orang lain", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    const mhsCookie = await registerUser(app, "mahasiswa");
    const id = await upload(app, adminCookie, "Dokumen Internal");

    const del = await post(app, `/studio/dokumen/${id}/delete`, mhsCookie, { mode: "soft" });
    expect(del.status).toBe(302);

    const archived = await post(app, `/studio/dokumen/${id}/archive`, mhsCookie);
    expect(archived.status).toBe(302);

    // Masih terbit & tidak masuk trash
    const adminList = await (await app.request("/studio/dokumen", { headers: { cookie: adminCookie } })).text();
    expect(adminList).toContain("Dokumen Internal");
    const trash = await (await app.request("/studio/dokumen/trash", { headers: { cookie: adminCookie } })).text();
    expect(trash).not.toContain("Dokumen Internal");

    // Flash error disampaikan ke user tersebut
    const page = await app.request("/studio/dokumen", {
      headers: { cookie: `${mhsCookie.split(";")[0]}; ${cookieFrom(del)}` },
    });
    expect(await page.text()).toContain("tidak berhak");

    await post(app, `/studio/dokumen/${id}/trash-and-delete`, adminCookie);
    cleanup(id);
  });
});

describe("Status dokumen: arsip vs trash", () => {
  test("arsip menyembunyikan dokumen dari publik tapi tidak menghapus file", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie, "Majalah Diarsipkan");

    // Sebelum diarsipkan: tampil di publik
    expect(await (await app.request("/jelajah")).text()).toContain("Majalah Diarsipkan");
    const baca = await app.request("/majalah/majalah-diarsipkan");
    expect(baca.status).toBe(200);

    const res = await post(app, `/studio/dokumen/${id}/archive`, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/studio/dokumen");

    // Hilang dari daftar terbit & dari publik, tapi muncul di tab arsip
    const list = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    expect(list).not.toContain("Majalah Diarsipkan");

    const arsip = await (await app.request("/studio/dokumen?status=archived", { headers: { cookie } })).text();
    expect(arsip).toContain("Majalah Diarsipkan");
    expect(arsip).toContain("Diarsipkan");

    expect(await (await app.request("/jelajah")).text()).not.toContain("Majalah Diarsipkan");
    expect(await (await app.request("/")).text()).not.toContain("Majalah Diarsipkan");

    const bacaArsip = await app.request("/majalah/majalah-diarsipkan");
    expect(bacaArsip.status).toBe(302);
    expect(bacaArsip.headers.get("location")).toBe("/");

    // File tetap ada di disk (tidak dihapus seperti trash)
    expect(await Bun.file(`uploads/${id}.pdf`).exists()).toBe(true);

    // Terbitkan lagi → kembali tampil
    const pub = await post(app, `/studio/dokumen/${id}/publish`, cookie);
    expect(pub.status).toBe(302);
    expect(pub.headers.get("location")).toBe("/studio/dokumen?status=archived");
    expect(await (await app.request("/jelajah")).text()).toContain("Majalah Diarsipkan");

    await post(app, `/studio/dokumen/${id}/trash-and-delete`, cookie);
    cleanup(id);
  });

  test("trash dari arsip → restore kembali ke arsip (bukan terbit)", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie, "Majalah Arsip Trash");

    await post(app, `/studio/dokumen/${id}/archive`, cookie);
    await post(app, `/studio/dokumen/${id}/delete`, cookie, { mode: "soft" });

    // Trash berisi dokumen
    const trash = await (await app.request("/studio/dokumen/trash", { headers: { cookie } })).text();
    expect(trash).toContain("Majalah Arsip Trash");

    const restore = await post(app, `/studio/dokumen/${id}/restore`, cookie);
    expect(restore.status).toBe(302);

    // Kembali ke ARSIP, bukan terbit
    const arsip = await (await app.request("/studio/dokumen?status=archived", { headers: { cookie } })).text();
    expect(arsip).toContain("Majalah Arsip Trash");

    const terbit = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    expect(terbit).not.toContain("Majalah Arsip Trash");
    expect(await (await app.request("/jelajah")).text()).not.toContain("Majalah Arsip Trash");

    await post(app, `/studio/dokumen/${id}/trash-and-delete`, cookie);
    cleanup(id);
  });

  test("terbitkan hanya berlaku untuk dokumen arsip", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie, "Masih Terbit");

    const res = await post(app, `/studio/dokumen/${id}/publish`, cookie);
    expect(res.status).toBe(302);

    // Tetap terbit (tidak berubah status)
    const list = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    expect(list).toContain("Masih Terbit");

    await post(app, `/studio/dokumen/${id}/trash-and-delete`, cookie);
    cleanup(id);
  });

  test("statistik dashboard menghitung per status", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const idTerbit = await upload(app, cookie, "Satu Terbit");
    const idArsip = await upload(app, cookie, "Dua Arsip");
    const idTrash = await upload(app, cookie, "Tiga Trash");

    await post(app, `/studio/dokumen/${idArsip}/archive`, cookie);
    await post(app, `/studio/dokumen/${idTrash}/delete`, cookie, { mode: "soft" });

    const html = await (await app.request("/studio", { headers: { cookie } })).text();
    expect(html).toContain(">Terbit<");
    expect(html).toContain(">Arsip<");
    expect(html).toContain(">Trash<");
    expect(html).toContain("Dokumen terbit");

    // Trash tidak ikut dihitung sebagai terbit/arsip
    const strip = html.replace(/<[^>]*>/g, " ");
    expect(strip).toContain("Satu Terbit");

    await post(app, `/studio/dokumen/${idTerbit}/trash-and-delete`, cookie);
    await post(app, `/studio/dokumen/${idArsip}/trash-and-delete`, cookie);
    await post(app, `/studio/dokumen/${idTrash}/hard-delete`, cookie);
    cleanup(idTerbit, idArsip, idTrash);
  });
});
