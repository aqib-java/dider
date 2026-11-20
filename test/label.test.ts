import { describe, expect, test } from "bun:test";
import { unlinkSync } from "fs";
import { LabelModel } from "../src/models/label.model";
import { ProjectModel } from "../src/models/project.model";
import { slugify } from "../src/lib/slug";
import {
  createTestApp,
  createTestDb,
  cookieFrom,
  formHeaders,
  formPostHeaders,
  registerUser,
} from "./helpers";

const PDF_BODY = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF";
type App = ReturnType<typeof createTestApp>;

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
  const row = rows.find((r) => r.includes(nama))!;
  return row.slice(0, row.indexOf('"'));
}

const post = (app: App, path: string, cookie: string, body?: Record<string, string>) =>
  app.request(path, {
    method: "POST",
    headers: { cookie, ...formPostHeaders },
    body: new URLSearchParams(body ?? {}).toString(),
  });

/** Id label dari halaman /studio/label (lihat penanda data-label-id). */
async function labelId(app: App, cookie: string, nama: string): Promise<string> {
  const html = await (await app.request("/studio/label", { headers: { cookie } })).text();
  const potongan = html.split('data-label-id="').slice(1);
  const cocok = potongan.find((p) => p.includes(`data-label-nama="${nama}"`));
  expect(cocok).toBeTruthy();
  return cocok!.slice(0, cocok!.indexOf('"'));
}

function cleanup(...ids: string[]) {
  for (const id of ids) {
    try {
      unlinkSync(`uploads/${id}.pdf`);
    } catch {
      // sudah tidak ada
    }
  }
}

describe("Label — model", () => {
  test("create: slug dari nama, duplikat (case-insensitive) ditolak", () => {
    const db = createTestDb();
    const labels = new LabelModel(db);

    const a = labels.create("Profil Prodi");
    expect(a?.slug).toBe("profil-prodi");

    expect(labels.create("profil prodi")).toBeNull();
    expect(labels.create("  PROFIL PRODI ")).toBeNull();
    expect(labels.create("   ")).toBeNull();

    expect(labels.listWithCount().length).toBe(1);
  });

  test("setFor mengganti seluruh label dokumen, delete melepas relasi", () => {
    const db = createTestDb();
    const labels = new LabelModel(db);
    const projects = new ProjectModel(db);

    const l1 = labels.create("Kegiatan Mahasiswa")!;
    const l2 = labels.create("Alumni")!;
    const id = projects.create("Majalah Label", "uploads/x.pdf");

    labels.setFor(id, [l1.id, l2.id]);
    expect([...labels.idsForMany([id]).get(id)!].sort()).toEqual([l1.id, l2.id].sort());

    // Ganti dengan satu label saja
    labels.setFor(id, [l2.id]);
    expect([...labels.idsFor(id)]).toEqual([l2.id]);

    labels.delete(l2.id);
    expect(labels.idsFor(id)).toEqual([]);
    expect(projects.findById(id)).not.toBeNull(); // dokumen tetap utuh
  });
});

describe("Label — halaman admin & penempelan", () => {
  test("GET /studio/label: admin boleh, kontributor ditolak", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    const mhsCookie = await registerUser(app, "mahasiswa");

    const ok = await app.request("/studio/label", { headers: { cookie: adminCookie } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Daftar Label");

    const denied = await app.request("/studio/label", { headers: { cookie: mhsCookie } });
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toBe("/studio");
  });

  test("hanya admin yang bisa menambah & menghapus label", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    const mhsCookie = await registerUser(app, "mahasiswa");

    // Kontributor ditolak (redirect), label tidak dibuat
    await post(app, "/studio/label", mhsCookie, { nama: "Dari Mahasiswa" });
    const adminHtml = await (await app.request("/studio/label", { headers: { cookie: adminCookie } })).text();
    expect(adminHtml).not.toContain("Dari Mahasiswa");

    // Admin bisa membuat
    await post(app, "/studio/label", adminCookie, { nama: "Profil Prodi" });
    const html = await (await app.request("/studio/label", { headers: { cookie: adminCookie } })).text();
    expect(html).toContain("Profil Prodi");
    expect(html).toContain("?label=profil-prodi");

    // Duplikat ditolak
    const dup = await post(app, "/studio/label", adminCookie, { nama: "profil prodi" });
    const page = await app.request("/studio/label", {
      headers: { cookie: `${adminCookie.split(";")[0]}; ${cookieFrom(dup)}` },
    });
    expect(await page.text()).toContain("sudah ada");

    // Hapus
    const id = await labelId(app, adminCookie, "Profil Prodi");
    await post(app, `/studio/label/${id}/delete`, adminCookie);
    const after = await (await app.request("/studio/label", { headers: { cookie: adminCookie } })).text();
    expect(after).not.toContain("Profil Prodi");
  });

  test("menempelkan label ke dokumen lalu difilter di studio dan /jelajah", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const idA = await upload(app, cookie, "Majalah DM");
    const idB = await upload(app, cookie, "Majalah Internal");

    await post(app, "/studio/label", cookie, { nama: "Profil Prodi" });
    await post(app, "/studio/label", cookie, { nama: "Kegiatan Mahasiswa" });
    const lDm = await labelId(app, cookie, "Profil Prodi");
    const lInt = await labelId(app, cookie, "Kegiatan Mahasiswa");

    await post(app, `/studio/dokumen/${idA}/label`, cookie, { label: lDm });
    await post(app, `/studio/dokumen/${idB}/label`, cookie, { label: lInt });

    // Label tampil di daftar studio
    const list = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();
    expect(list).toContain("Profil Prodi");
    expect(list).toContain("Kegiatan Mahasiswa");

    // Filter di studio
    const filtered = await (
      await app.request("/studio/dokumen?label=profil-prodi", { headers: { cookie } })
    ).text();
    expect(filtered).toContain(`data-doc-id="${idA}"`);
    expect(filtered).not.toContain(`data-doc-id="${idB}"`);

    // Filter di /jelajah (publik)
    const publik = await (await app.request("/jelajah?label=kegiatan-mahasiswa")).text();
    expect(publik).toContain("Majalah Internal");
    expect(publik).not.toContain("Majalah DM");
    expect(publik).toContain("Profil Prodi"); // chip filter tetap tampil

    // Label tak dikenal tidak menyaring apa pun
    const asal = await (await app.request("/jelajah?label=tidak-ada")).text();
    expect(asal).toContain("Majalah DM");
    expect(asal).toContain("Majalah Internal");

    // Bersih-bersih
    for (const id of [idA, idB]) {
      await post(app, `/studio/dokumen/${id}/trash-and-delete`, cookie);
    }
    cleanup(idA, idB);
  });

  test("label dokumen diarsip tidak ikut ditampilkan di publik", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie, "Majalah Arsip Label");

    await post(app, "/studio/label", cookie, { nama: "Arsip Lama" });
    const l = await labelId(app, cookie, "Arsip Lama");
    await post(app, `/studio/dokumen/${id}/label`, cookie, { label: l });
    await post(app, `/studio/dokumen/${id}/archive`, cookie);

    const publik = await (await app.request("/jelajah")).text();
    expect(publik).not.toContain("Majalah Arsip Label");
    // Chip label hanya muncul kalau ada dokumen terbit yang memakainya
    expect(publik).not.toContain("Arsip Lama");

    const studio = await (
      await app.request("/studio/dokumen?status=archived", { headers: { cookie } })
    ).text();
    expect(studio).toContain("Majalah Arsip Label");

    await post(app, `/studio/dokumen/${id}/trash-and-delete`, cookie);
    cleanup(id);
  });

  test("kontributor tidak bisa memberi label dokumen milik orang lain", async () => {
    const app = createTestApp();
    const adminCookie = await registerUser(app, "adminccit");
    const mhsCookie = await registerUser(app, "mahasiswa");

    const id = await upload(app, adminCookie, "Dokumen Internal");
    await post(app, "/studio/label", adminCookie, { nama: "Kegiatan Mahasiswa" });
    const l = await labelId(app, adminCookie, "Kegiatan Mahasiswa");

    const res = await post(app, `/studio/dokumen/${id}/label`, mhsCookie, { label: l });
    expect(res.status).toBe(302);

    const page = await app.request("/studio/dokumen", {
      headers: { cookie: `${mhsCookie.split(";")[0]}; ${cookieFrom(res)}` },
    });
    expect(await page.text()).toContain("tidak berhak");

    await post(app, `/studio/dokumen/${id}/trash-and-delete`, adminCookie);
    cleanup(id);
  });

  test("dialog label memakai multi-pilih yang bisa dicari (bukan combobox)", async () => {
    const app = createTestApp();
    const cookie = await registerUser(app);
    const id = await upload(app, cookie, "Majalah Picker");
    for (const nama of ["Profil Prodi", "Digital Marketing"]) {
      await post(app, "/studio/label", cookie, { nama });
    }

    const html = await (await app.request("/studio/dokumen", { headers: { cookie } })).text();

    // Kolom pencarian label di dalam dialog
    expect(html).toContain("data-label-picker");
    expect(html).toContain("data-label-search");
    expect(html).toContain('placeholder="Cari label…"');

    // Daftar label bisa difilter (item membawa nama untuk pencarian klien)
    expect(html).toContain('data-label-item data-nama="profil prodi"');
    expect(html).toContain('data-label-item data-nama="digital marketing"');

    // Label terpilih tampil sebagai chip
    expect(html).toContain("data-label-chips");
    expect(html).toContain("data-label-empty");

    // Kontrak ke server tidak berubah: checkbox name="label" (multi nilai)
    expect(html).toContain('type="checkbox" name="label"');

    // Pencarian tetap menyaring di klien, bukan reload
    expect(html).toContain("applyFilter");
    expect(html).toContain("renderChips");

    await post(app, `/studio/dokumen/${id}/trash-and-delete`, cookie);
    cleanup(id);
  });

  test("slug label dipakai di URL filter", async () => {
    expect(slugify("Profil Prodi")).toBe("profil-prodi");
    expect(slugify("Profil Prodi")).toBe("profil-prodi");
  });
});
