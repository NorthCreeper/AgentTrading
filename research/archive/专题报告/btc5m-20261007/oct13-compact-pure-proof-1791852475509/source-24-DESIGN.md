# Compact intermediate forward checkpoints

Only duplicate settled trade arrays in intermediate snapshots are represented by count and digest. Preserve full initial, final and failure account arrays, the entire actual intent/ack/cancel/payment journal, original initial capital and carry history, strategy parameters, current source quotes and fees, actual delays, source receipts and output caps. Intermediate snapshots explicitly cannot initialize cash carry or recovery. No financial event is omitted; internal ledger and financial invariants are unchanged.
