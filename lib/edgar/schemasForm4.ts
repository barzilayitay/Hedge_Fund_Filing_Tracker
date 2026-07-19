import { z } from "zod";

/**
 * Zod schemas for parsed Form 4 output. The parser narrows raw ownershipDocument
 * XML to these at its boundary; everything downstream works with inferred types.
 */

/** EDGAR CIK, canonicalised to the 10-digit zero-padded form. */
export const cikSchema = z.string().regex(/^\d{10}$/, "cik must be 10 digits");

/** ISO date, YYYY-MM-DD. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export const tableTypeSchema = z.enum(["nonderiv", "deriv"]);
export type TableType = z.infer<typeof tableTypeSchema>;

export const issuerSchema = z.object({
  cik: cikSchema,
  name: z.string().min(1),
  ticker: z.string().nullable(),
});

export const ownerSchema = z.object({
  cik: cikSchema,
  name: z.string().min(1),
  isOfficer: z.boolean(),
  isDirector: z.boolean(),
  isTenPct: z.boolean(),
  isOther: z.boolean(),
  officerTitle: z.string().nullable(),
  otherText: z.string().nullable(),
});

export const form4TransactionSchema = z.object({
  ownerCik: cikSchema,
  tableType: tableTypeSchema,
  /** Position of the transaction within its table_type, shared across owners. */
  rowIndex: z.number().int().nonnegative(),

  securityTitle: z.string().nullable(),
  transactionCode: z.string().min(1).nullable(),
  transactionDate: isoDateSchema.nullable(),
  /** Null when the amount is footnoted rather than given; never coerced to 0. */
  shares: z.number().nullable(),
  /** Null when omitted (gifts/awards); 0 is a real $0 award. Distinct. */
  price: z.number().nullable(),
  acquiredDisposed: z.enum(["A", "D"]).nullable(),
  sharesOwnedAfter: z.number().nullable(),
  directIndirect: z.enum(["D", "I"]).nullable(),
  natureOfOwnership: z.string().nullable(),
  is10b5One: z.boolean(),

  // Derivative-only; null on non-derivative rows.
  conversionOrExercisePrice: z.number().nullable(),
  exerciseDate: isoDateSchema.nullable(),
  expirationDate: isoDateSchema.nullable(),
  underlyingSecurityTitle: z.string().nullable(),
  underlyingShares: z.number().nullable(),

  /** Footnotes referenced by this row, resolved id -> text. */
  footnotes: z.record(z.string(), z.string()),
});

export type Form4Transaction = z.infer<typeof form4TransactionSchema>;

export const parsedForm4Schema = z.object({
  filing: z.object({
    accessionNo: z
      .string()
      .regex(/^\d{10}-\d{2}-\d{6}$/, "accession must be NNNNNNNNNN-NN-NNNNNN"),
    formType: z.string().min(1),
    periodOfReport: isoDateSchema,
    filedAt: isoDateSchema,
    isAmendment: z.boolean(),
    issuerCik: cikSchema,
  }),
  issuer: issuerSchema,
  owners: z.array(ownerSchema).min(1),
  transactions: z.array(form4TransactionSchema),
  /** Every footnote in the document, id -> text. */
  footnotes: z.record(z.string(), z.string()),
  /** Document-level Rule 10b5-1 affirmation (aff10b5One). */
  is10b5One: z.boolean(),
  stats: z.object({
    /** Emitted transaction rows (one per owner per transaction). */
    transactions: z.number().int().nonnegative(),
    /** Holdings-only rows (position statements) skipped but counted. */
    holdingsSkipped: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string()),
});

export type Issuer = z.infer<typeof issuerSchema>;
export type Owner = z.infer<typeof ownerSchema>;
export type ParsedForm4 = z.infer<typeof parsedForm4Schema>;
