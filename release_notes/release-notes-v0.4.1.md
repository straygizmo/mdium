# Release Notes — v0.4.1

## Highlights

This release adds **FTP/FTPS folders**: connect to a server from the new FTP panel, open a remote folder as a synced local mirror, and let agents, RAG, converters and the editor work on it as on any local folder. The **VBA macro chat** gains a **run-and-verify loop**: `vba_run` executes macros on a disposable copy of the workbook through Excel, with an approval dialog for side effects and a run budget, and `xlsx_read` lets the agent read the result. **Built-in flow templates** now follow the UI language, so a Japanese setting creates Japanese flows.

---

## New Features

### FTP/FTPS Folders

- FTP panel in the activity bar: recent connections on top, the server tree of the selected connection below, loaded lazily; a lettered activity icon and an FTP badge on mirror folder tabs
- Open FTP and explicit FTPS folders and edit files in place; passwords are kept in the OS credential store, connection profiles per server
- Local mirrors: a remote folder is mirrored under the app's local data folder and opened as a working folder, so agents, RAG, Office conversion, attachments and copy all work on it
- Sync engine: local changes are uploaded by a file watcher, server changes are pulled on open, on demand and on a configurable interval (General settings, default 5 minutes); local deletions wait for approval, server deletions move local files to the recycle bin, conflicts are never auto-resolved
- Opening a file in a mirror first checks that file on the server: newer on the server is downloaded, changed on both sides is kept as a conflict, deleted on the server is moved to the bin
- Sync badge in the explorer header with a dialog for conflicts, pending deletions, per-file errors and "sync now"; the toolbar shows the server URI
- Closing a mirror tab pushes pending changes and offers to delete the local copy when everything is on the server
- Full path of the selected FTP item with a copy button; wait cursor and a downloading message while a folder is mirrored
- Shift_JIS file names are decoded per server and listing lines the strict parsers reject are still shown

### VBA Run and Verify

- `vba_run` runs macros on a disposable copy of the workbook through Excel COM, hidden, with a Win32 dialog watch, a timeout and a run budget that resets on every user message, question reply and new chat
- Approval dialog before macros with side effects (file writes, shell, `Workbooks.Open`, `SendKeys`, ...), listing one side effect per row
- `xlsx_read` tool backed by calamine, so the agent can read cells after a run
- Generated `MdiumShim` test harness module; pushes are linted for `On Error Resume Next` and duplicate procedures
- `vba-mdium-flow` skill v4 teaches the run-and-verify loop
- Macro chat placeholder explains the automatic write-back with a `.bak` backup; icon-only new chat button

### Flows

- Built-in templates (`dev-workflow`, `improve-app`) carry a Japanese translation and follow the UI language: copies and `mdium:` references use the translated names, descriptions, approval messages and comments

---

## Bug Fixes

- FTP: connect dialog stays open on outside clicks; failed syncs while offline are reported and mirrors reopen offline; calls to an unreachable server fail fast; FTP paths are kept out of local-only code paths
- VBA: the Excel process handle is held until the run ends; budgets and approvals are keyed on the canonical workbook path; the stall watchdog's automatic reply no longer resets the run budget; Windows paths are split correctly in the approval dialog
- Settings: the Flows description now says the view shows, edits and runs flows

---

## Chores & Docs

- README and README.ja describe the VBA macro chat, AGENT CHAT, WORKFLOWS, Flows, video generation, FTP mirrors and the current project structure
- winuse-gate configuration for verifying UI changes, including locale files
- Design documents and smoke results for the VBA run-and-verify loop
