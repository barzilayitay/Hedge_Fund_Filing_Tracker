/**
 * GET /api/export?fund=<slug>&quarter=<YYYY-MM-DD>&format=csv|tsv
 *
 * Returns the full holdings set for a fund-quarter as CSV (default) or TSV, with
 * headers matching the UI column names. Thin wrapper over buildHoldingsExport
 * (lib/export.ts, unit-tested); this handler only parses the query, opens a
 * production Sql, and shapes the HTTP response.
 *
 * NOTE: the body is built fully in memory (buildHoldingsExport pages the RPC and
 * concatenates), not streamed. Fine for 13F-sized holdings sets; unbounded-size
 * streaming and rate limiting are Phase 6 hardening (there is no auth here yet).
 *
 * `parseExportParams` is exported so the query-parsing/validation contract is
 * unit-testable without opening a database.
 */
import { buildHoldingsExport, type ExportFormat } from "@/lib/export";
import { makeProductionSql } from "@/scripts/prod-sql";

export const dynamic = "force-dynamic";

/** Fund slugs are slugify() output: lowercase alnum groups joined by hyphens. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const QUARTER_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ParsedExportParams =
  | { ok: true; fund: string; quarter: string; format: ExportFormat }
  | { ok: false; error: string };

export function parseExportParams(url: URL): ParsedExportParams {
  const fund = url.searchParams.get("fund");
  const quarter = url.searchParams.get("quarter");
  const formatParam = url.searchParams.get("format");

  if (!fund) return { ok: false, error: "missing required query param: fund" };
  if (!SLUG_RE.test(fund)) {
    return { ok: false, error: "malformed query param: fund (expected a slug)" };
  }
  if (!quarter || !QUARTER_RE.test(quarter)) {
    return {
      ok: false,
      error: "missing or malformed query param: quarter (YYYY-MM-DD)",
    };
  }
  if (formatParam && formatParam !== "csv" && formatParam !== "tsv") {
    return { ok: false, error: "format must be csv or tsv" };
  }
  const format: ExportFormat = formatParam === "tsv" ? "tsv" : "csv";
  return { ok: true, fund, quarter, format };
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

export async function GET(request: Request): Promise<Response> {
  const parsed = parseExportParams(new URL(request.url));
  if (!parsed.ok) return badRequest(parsed.error);
  const { fund, quarter, format } = parsed;

  const { sql, close } = await makeProductionSql();
  try {
    const out = await buildHoldingsExport(sql, {
      fundSlug: fund,
      quarter,
      format,
    });
    return new Response(out.content, {
      status: 200,
      headers: {
        "content-type": `${out.contentType}; charset=utf-8`,
        "content-disposition": `attachment; filename="${out.filename}"`,
      },
    });
  } finally {
    await close();
  }
}
