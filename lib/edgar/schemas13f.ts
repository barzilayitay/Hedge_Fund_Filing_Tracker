import { z } from "zod";

/**
 * Zod schemas for parsed 13F output. The parser narrows raw XML to these at
 * its boundary; everything downstream works with the inferred types.
 */

export const amendmentTypeSchema = z.enum(["RESTATEMENT", "NEW HOLDINGS"]);
export type AmendmentType = z.infer<typeof amendmentTypeSchema>;

/** EDGAR CIK, canonicalised to the 10-digit zero-padded form. */
export const cikSchema = z.string().regex(/^\d{10}$/, "cik must be 10 digits");

/** ISO date, YYYY-MM-DD. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

/** 9 characters, uppercase alphanumeric. Checksum is not enforced. */
export const cusipSchema = z
  .string()
  .regex(/^[0-9A-Z]{9}$/, "cusip must be 9 uppercase alphanumerics");

export const filerSchema = z.object({
  cik: cikSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
});

export const filingMetaSchema = z
  .object({
    accessionNo: z
      .string()
      .regex(/^\d{10}-\d{2}-\d{6}$/, "accession must be NNNNNNNNNN-NN-NNNNNN"),
    cik: cikSchema,
    formType: z.string().min(1),
    periodOfReport: isoDateSchema,
    filedAt: isoDateSchema,
    isAmendment: z.boolean(),
    /** Null on an original filing; always set on a 13F-HR/A. */
    amendmentType: amendmentTypeSchema.nullable(),
  })
  .refine((f) => f.isAmendment === (f.amendmentType !== null), {
    message: "amendmentType must be set on an amendment and only on one",
  });

export const holdingSchema = z
  .object({
    /** Position in the information table. Part of the holdings PK. */
    rowIndex: z.number().int().nonnegative(),
    nameOfIssuer: z.string().min(1),
    cusip: cusipSchema,
    shareClass: z.string().nullable(),
    putCall: z.enum(["Put", "Call"]).nullable(),
    /** Set when sshPrnamtType is SH. */
    shares: z.number().nullable(),
    /** Set when sshPrnamtType is PRN (principal amount, e.g. convertible debt). */
    principalAmt: z.number().nullable(),
    /** Always whole USD, normalized from $ thousands for pre-2023 periods. */
    valueUsd: z.number().nonnegative(),
    investmentDiscretion: z.string().nullable(),
    otherManager: z.string().nullable(),
  })
  .refine((h) => (h.shares === null) !== (h.principalAmt === null), {
    message: "exactly one of shares / principalAmt must be set",
  });

/**
 * The filer's own declared totals from the cover page's summary page. Kept so
 * tests and ingestion can check parsed rows against what the filer claimed.
 * `valueTotal` is in the filing's own units — $ thousands for pre-2023
 * periods — and is deliberately NOT normalized.
 */
export const declaredTotalsSchema = z.object({
  entryTotal: z.number().int().nonnegative().nullable(),
  valueTotal: z.number().nonnegative().nullable(),
});

export const parsed13fSchema = z.object({
  filer: filerSchema,
  filing: filingMetaSchema,
  holdings: z.array(holdingSchema),
  declared: declaredTotalsSchema,
  /** Non-fatal problems worth logging (e.g. an /A with no amendmentType). */
  warnings: z.array(z.string()),
});

export type Filer = z.infer<typeof filerSchema>;
export type FilingMeta = z.infer<typeof filingMetaSchema>;
export type Holding = z.infer<typeof holdingSchema>;
export type DeclaredTotals = z.infer<typeof declaredTotalsSchema>;
export type Parsed13F = z.infer<typeof parsed13fSchema>;
