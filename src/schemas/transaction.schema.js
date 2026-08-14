import { z } from "zod";

export const TransactionSchema = z.object({
  transaction_type: z.string(),
  description: z.string(),
  category: z.string(),
  quantity: z.number().int(),
  amount: z.number(),
  person: z.string().nullable(),
  transaction_date: z.string(),
  notes: z.string().nullable(),
});