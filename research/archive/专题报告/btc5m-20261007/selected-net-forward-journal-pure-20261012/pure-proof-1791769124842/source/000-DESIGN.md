# Bounded append-only source capability probe

This stage prepares read-only capture of the existing session's frames, prices and P2 context. It cannot trade, fit a model, fund an account or write main workflow files. The session and next complete market are registered before their start, and the first observer receipt of every complete line is kept separately from original field timestamps. No late reads are rewritten as past knowledge.

Initial tails of at most 1 MiB per family are warm context only. Original source identities are pinned; replacement, truncation, mutation of the previous read boundary, malformed UTF-8/JSON and overlarge lines stop the probe. Incomplete append tails remain unknown. Every captured complete line has absolute original byte offsets, exact original bytes hash and actual observation time, with range readback while the main files may append. Successful source capture alone cannot authenticate all strategy coordinates or produce financial evidence.

The probe lasts only through one preselected future full market (at most 605 seconds). This bounds resource use and supplies concrete source release/latency evidence for the next adapter. All captured ranges must be rechecked before its report is accepted. Seven tests use isolated synthetic temporary files only.
