# Key Decisions Archive

> Extracted from the original ROADMAP. Archived: 2026-05-31

---

## All Decisions

| Decision | Conclusion | Date |
|----------|------------|------|
| Setup wizard simplified? | ❌ No, focus on bug-free instead | 2026-05-30 |
| Quick mode needed? | ❌ Not essential (API keys require manual entry) | 2026-05-30 |
| NLP config approach | ✅ Soul CLI injection — no code needed, just inject command reference into Agent context | 2026-05-30 |
| Bot permission scope | ✅ Only control config modification + workspace boundary, not OS-level sandbox | 2026-05-30 |
| Test strategy | ✅ bun:test + tests/ directory (excluded from npm publish) | 2026-05-30 |
| GitHub push over HTTPS | ⚠️ Local HTTPS auth to GitHub has intermittent timeout, SSH (ssh.github.com:443) more reliable | 2026-05-30 |
