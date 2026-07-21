/**
 * GET /api/export?fund=<slug>&quarter=<YYYY-MM-DD>&format=csv|tsv
 *
 * Streams the full holdings set for a fund-quarter as CSV (default) or TSV, with
 * headers matching the UI column names. Thin wrapper over buildHoldingsExport
 * (lib/export.ts, unit-tested); this handler only parses the query, opens a
 * production Sql, and shapes the HTTP response.
 */
import { buildHoldingsExport, type ExportFormat } from "@/lib/export";
import { makeProductionSql } from "@/scripts/prod-sql";

export const dynamic = "force-dynamic";

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const fund = url.searchParams.get("fund");
  const quarter = url.searchParams.get("quarter");
  const formatParam = url.searchParams.get("format");

  if (!fund) return badRequest("missing required query param: fund");
  if (!quarter || !/^\d{4}-\d{2}-\d{2}$/.test(quarter)) {
    return badRequest("missing or malformed query param: quarter (YYYY-MM-DD)");
  }
  if (formatParam && formatParam !== "csv" && formatParam !== "tsv") {
    return badRequest("format must be csv or tsv");
  }
  const format: ExportFormat = formatParam === "tsv" ? "tsv" : "csv";

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
