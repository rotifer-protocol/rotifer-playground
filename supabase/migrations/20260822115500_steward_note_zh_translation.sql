-- ============================================================
-- ADR-323 D3 — the Chinese reading of rotifer-protocol's disclosure
--
-- Migration 20260822101500 gave `profiles` somewhere to keep translations.
-- This puts the first one there, and retires the copy the website has been
-- carrying since the developer page started rendering translated notes: the
-- disclosure is a stored record, so its translations belong next to it rather
-- than in the template that happens to display them.
--
-- Two things are deliberate about the statement below.
--
-- The pin is read out of the column (`'source', steward_note`) rather than
-- written out again here. A pin retyped by hand can disagree with the value it
-- claims to pin, and a pin that disagrees is worse than none — it makes a
-- stale translation look current.
--
-- The WHERE clause then requires the stored note to be the exact English this
-- Chinese translates. If someone has edited the disclosure since the
-- translation was written, this updates nothing and says so by leaving the
-- column null, rather than attaching a translation of text that no longer
-- exists. That also makes it a no-op on any database that is not production —
-- CI replays it against an empty `profiles` and nothing happens.
--
-- Idempotent: re-running it writes the same document.
-- ============================================================

UPDATE profiles
   SET steward_note_i18n = jsonb_build_object(
         'zh', jsonb_build_object(
           'text',   $zh$由一个人运营，也就是本协议的创始人。这个身份用来发布参考基因，它不是一家有员工的机构。它的前身是一个 GitLab 账号，该账号已于 2026-08-19 被 GitLab 封禁，导致 59 个已发布的基因无人能够更新——这些基因被迁到这里，好让它们重新有人维护。基因的作者归属没有发生任何变化。$zh$,
           'source', steward_note))
 WHERE username = 'rotifer-protocol'
   AND steward_note = $en$Operated by one person, the protocol's founder. This identity publishes the reference genes; it is not an organisation with staff. Its predecessor was a GitLab account that GitLab banned on 2026-08-19, which left 59 published genes with no one able to update them — the genes were moved here so they can be maintained again. Nothing about their authorship changed.$en$;
