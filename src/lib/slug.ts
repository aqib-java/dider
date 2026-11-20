/**
 * Buat slug ramah-URL dari judul dokumen.
 * "Rencana S2 PJJ" → "rencana-s2-pjj"
 */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // buang diakritik
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "dokumen";
}
