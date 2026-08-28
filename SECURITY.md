# Security Policy

## Reporting a vulnerability

Use **GitHub's private vulnerability reporting**, which is enabled on this
repository: **Security tab → "Report a vulnerability"**. Reports go privately
to the maintainer.

Please do **not** open public issues or PRs for security problems — that
discloses them before a fix exists.

You can expect an acknowledgement within **72 hours** and an honest assessment
of impact and timeline. Good-faith research is welcome; credit is given in the
fix's release notes unless you prefer otherwise.

## What counts as security-relevant here

txwhy is read-only tooling over public RPC data. It holds **no funds, no
wallets, no signing keys**, and never asks anyone to connect a wallet. Even so,
several things matter:

- **Wrong diagnoses presented confidently.** A debugger that misleads is an
  attack surface — "support" scammers thrive on confused developers. Any input
  that makes the decoder mis-attribute a failure to the wrong program (rather
  than refuse honestly) is treated as a security-relevant bug, not a cosmetic
  one.
- **Log-content injection.** Program logs are attacker-controlled text (any
  program can emit `Program log:` lines that mimic the runtime's grammar or a
  fake `AnchorError`). Parsers here must never let crafted log content forge
  the failure location or escape into rendered output.
- **Secrets hygiene.** RPC URLs with embedded API keys are secrets: they belong
  in `.env` (see `.env.example`), never in code, fixtures, or logs.
- **Supply chain.** The runtime dependency count is deliberately **zero**;
  anything that changes that, or tampers with CI, deserves scrutiny.

## Supported versions

Pre-1.0: only the latest `main` is supported. There are no backported fixes.
