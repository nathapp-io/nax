---
title: Chat shell output
description: Following live output from Bash commands in chat
---

# Chat shell output

Chat keeps the output from its own Bash commands visible while they run. The shell view is for following progress; it is not an interactive terminal.

## Live output

While a Bash command is running, its card shows the last 5 lines of output. This is display only: the tail does not change the tool result the model receives.

## Shell view

Open a shell's live view in either of these ways:

- Click the footer strip when it shows one lone shell.
- Press Enter on a shell row in the jobs picker, opened with `ctrl+g`.

The view is output only and does not accept stdin. Press `ESC` or `ctrl+c` to return to the chat; returning hides the view without destroying the chat or its draft. Press `k` to stop a running shell. The `k` key does not close the view.

The view keeps a bounded in-memory tail: up to 2000 lines or 256 KiB per shell, and 4 MiB total across shells. Older output may be truncated to stay within those limits. When a view's output is truncated, it names the log file path; the log file is the durable record, but the view does not load older output from it.
