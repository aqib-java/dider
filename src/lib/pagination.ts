/** Ukuran halaman yang diizinkan (maksimal 15 sesuai kebijakan tampilan). */
export const PER_OPTIONS = [10, 15] as const;
export const PER_DEFAULT = PER_OPTIONS[0];
export const PER_MAX = 15;

export type PaginationItem = { n: number; url: string; active: boolean };

export type Pagination = {
  page: number;
  per: number;
  total: number;
  pages: number;
  from: number;
  to: number;
  hasPrev: boolean;
  hasNext: boolean;
  prevUrl: string | null;
  nextUrl: string | null;
  items: PaginationItem[];
  offsets: number[];
};

function toPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 'per' dibatasi ke daftar yang diizinkan supaya URL tidak bisa memaksa 1000 baris. */
export function parsePer(raw: string | undefined): number {
  const n = toPositiveInt(raw, PER_DEFAULT);
  return (PER_OPTIONS as readonly number[]).includes(n) ? n : PER_DEFAULT;
}

/** Bangun URL dengan parameter tambahan, membuang nilai kosong. */
export function buildUrl(
  baseUrl: string,
  params: Record<string, string | number | undefined | null>
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `${baseUrl}?${s}` : baseUrl;
}

/**
 * Hitung metadata pagination + URL siap pakai untuk view.
 * Parameter filter (q, status, label, role) ikut dipertahankan di setiap tautan.
 */
export function buildPagination(opts: {
  pageRaw?: string;
  perRaw?: string;
  total: number;
  baseUrl: string;
  params?: Record<string, string | number | undefined | null>;
  perOptions?: readonly number[];
}): Pagination {
  const per = parsePer(opts.perRaw);
  const total = Math.max(0, opts.total);
  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(Math.max(1, toPositiveInt(opts.pageRaw, 1)), pages);

  const base = opts.baseUrl;
  const params = opts.params ?? {};
  const urlFor = (n: number) =>
    buildUrl(base, { ...params, per: per === PER_DEFAULT ? undefined : per, page: n === 1 ? undefined : n });

  // Jendela nomor halaman: maksimal 5 nomor di sekitar halaman aktif.
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  const end = Math.min(pages, start + 4);
  const items: PaginationItem[] = [];
  for (let n = start; n <= end; n++) items.push({ n, url: urlFor(n), active: n === page });

  const from = total === 0 ? 0 : (page - 1) * per + 1;
  const to = Math.min(total, page * per);

  return {
    page,
    per,
    total,
    pages,
    from,
    to,
    hasPrev: page > 1,
    hasNext: page < pages,
    prevUrl: page > 1 ? urlFor(page - 1) : null,
    nextUrl: page < pages ? urlFor(page + 1) : null,
    items,
    offsets: (opts.perOptions ?? PER_OPTIONS).slice(),
  };
}

/** Offset SQL dari metadata pagination. */
export function pageOffset(p: Pagination): number {
  return (p.page - 1) * p.per;
}
