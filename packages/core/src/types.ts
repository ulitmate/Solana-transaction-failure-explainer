// The subset of the getTransaction RPC response (jsonParsed encoding) the decoder consumes.
// These types are the decoder's input contract; fixtures on disk are raw RPC results in this shape.

/** Transaction-level error. Either a bare variant name, an InstructionError, or a variant with payload. */
export type TransactionErr =
  | string
  | { InstructionError: [number, InstructionErrorDetail] }
  | Record<string, unknown>;

export type InstructionErrorDetail =
  | string // e.g. "ProgramFailedToComplete", "ComputationalBudgetExceeded"
  | { Custom: number }
  | { BorshIoError: string }
  | Record<string, unknown>;

/**
 * One instruction as returned by jsonParsed encoding.
 * Known programs come back parsed (`program` + `parsed`); unknown programs come back
 * raw (`accounts` + base58 `data`). Both carry `programId` and `stackHeight`.
 */
export interface ParsedInstruction {
  programId: string;
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> } | string;
  accounts?: string[];
  data?: string;
  /** 1 = top level, 2 = first CPI level. Null on transactions predating the field. */
  stackHeight?: number | null;
}

/** Inner instructions are SPARSE: only top-level instructions that made CPIs get an entry. */
export interface InnerInstructionSet {
  /** Compiled top-level instruction index this group belongs to. Never renumber. */
  index: number;
  instructions: ParsedInstruction[];
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmountString?: string | null };
}

export interface TransactionMeta {
  err: TransactionErr | null;
  fee: number;
  computeUnitsConsumed?: number;
  logMessages?: string[] | null;
  innerInstructions?: InnerInstructionSet[] | null;
  preBalances?: number[];
  postBalances?: number[];
  preTokenBalances?: TokenBalance[] | null;
  postTokenBalances?: TokenBalance[] | null;
  loadedAddresses?: { writable: string[]; readonly: string[] };
}

export interface AccountKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
  /** jsonParsed already merges lookup-table addresses in; `source` says where each key came from. */
  source?: "transaction" | "lookupTable";
}

export interface GetTransactionResult {
  slot: number;
  blockTime?: number | null;
  version?: "legacy" | number;
  meta: TransactionMeta | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: AccountKey[];
      instructions: ParsedInstruction[];
      recentBlockhash?: string;
      addressTableLookups?: unknown[] | null;
    };
  };
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: TransactionErr | null;
  blockTime?: number | null;
  memo?: string | null;
  confirmationStatus?: string | null;
}

export interface SignatureStatus {
  slot: number;
  confirmations: number | null;
  err: TransactionErr | null;
  confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
}
