# Review of original 1052 single-file wrapper

Original wrapper and proof files remain unchanged. The wrapper uses one literal path, `compact.exe /C`, no directory recursion, alternate /EXE algorithm, wildcard, forced recompression, ignore-errors flag or automatic rollback. Native process PID, observed launch timestamp, exit/signal, bounded stdout/stderr and their hashes are recorded. Launch timestamp is not represented as an independently verified Windows child birth. A read-only open handle spans full before/after logical SHA validation; path and handle dev/ino/bytes/birth/mtime are checked. Ctime and attributes are allowed to change and recorded honestly.

Independent root completion checks remain necessary:

1. After-native main PID/birth are recorded but not asserted by the wrapper. Root must assert the original main birth after the operation.
2. After-native compression attributes and physical allocation are measured before the last logical SHA pass. Root must obtain a final native/path snapshot after hashing.
3. Ordinary ancestor checks reject symbolic links/junctions but do not reject multiple hardlinks. This preparation independently confirmed nlink 1 for both the original 1052 target and second c6a target.
4. The wrapper/helper do not self-validate their source SHA; root must independently pin unchanged package source before and after execution.
5. `passed=true` indicates the specified logical invariants passed, not that physical savings are positive or C free space meets the original 4 GiB reserve. Physical savings and final resource qualification must be checked separately.

Spawn failures or capture overflow retain failure proof and cannot be reported as successful completion. The wrapper does not write false original timestamps. No claim is made that lossless semantics alone prove a successful operation on a specific file.

Primary semantics: [Microsoft compact](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact), [NTFS compression](https://learn.microsoft.com/en-us/windows/win32/fileio/file-compression-and-decompression), [GetCompressedFileSizeW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getcompressedfilesizew), [ChangeTime versus LastWriteTime](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_basic_info).
