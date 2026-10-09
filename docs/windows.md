# Using the kit on Windows

The kit works in Windows PowerShell 5.1, but we recommend:

- **PowerShell 7** (`winget install Microsoft.PowerShell`) — it passes quotes to programs correctly.
- **Windows Terminal** (built into Windows 11) — it shows the ✅ / ❌ icons in `tossana-agents doctor`.
  In the old console window you see `[ OK ]` / `[FAIL]` instead. Both work.

## Quotes in comment text (PowerShell 5.1)

Windows PowerShell 5.1 **drops double quotes inside arguments** when it starts another program. This
command posts `He said ship it`, without the quotes:

```powershell
tossana-agents clickup comment 86abc123 'He said "ship it"'   # quotes are lost in PowerShell 5.1
```

Use a file or stdin instead. Both keep every character, including Khmer text:

```powershell
tossana-agents clickup comment 86abc123 --file note.md
'He said "ship it"' | tossana-agents clickup comment 86abc123 -
```

The agents always use `--file` (they write the text to `.agents/tmp/<taskId>-<agent>.md` first), so this
problem never affects the pipeline. It only matters when you type a comment by hand.

## Exit codes

After a command, `$LASTEXITCODE` is:

| Code | Meaning                                                |
| ---- | ------------------------------------------------------ |
| 0    | OK                                                     |
| 1    | Error (the message says what to fix)                   |
| 2    | `BLOCKED` by the Done guard: agents may never set Done |
